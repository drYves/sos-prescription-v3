<?php
// includes/Repositories/JobRepository.php

namespace SOSPrescription\Repositories;

defined('ABSPATH') || exit;

class JobRepository
{
    /** @var \wpdb */
    protected $wpdb;

    /** @var string */
    protected $table = '';

    /** @var string */
    protected $site_id = 'mls1';

    /** @var array<string, array<string, string>> */
    protected $column_cache = array();

    public function __construct($wpdb = null, $site_id = null)
    {
        if ($wpdb instanceof \wpdb) {
            $this->wpdb = $wpdb;
        } else {
            global $wpdb;
            $this->wpdb = $wpdb;
        }

        $this->table   = $this->wpdb->prefix . 'sosprescription_jobs';
        $this->site_id = $site_id ? (string) $site_id : $this->resolve_site_id();
    }

    public function get_table_name()
    {
        return $this->table;
    }

    public function get_site_id()
    {
        return $this->site_id;
    }

    public function create_or_reuse(array $payload, array $options = array())
    {
        if (!$this->table_exists()) {
            return new \WP_Error(
                'sosprescription_jobs_table_missing',
                'La table wp_sosprescription_jobs est introuvable.',
                array('status' => 500)
            );
        }

        $job_type  = $this->normalize_job_type(isset($options['job_type']) ? $options['job_type'] : 'PDF_GEN');
        $canonical = $this->canonicalize_value($payload);
        $raw_json  = \wp_json_encode($canonical, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

        if (!is_string($raw_json) || $raw_json === '') {
            return new \WP_Error(
                'sosprescription_invalid_job_payload',
                'Le payload du job PDF n’a pas pu être sérialisé.',
                array('status' => 500)
            );
        }

        $payload_sha256_hex = hash('sha256', $raw_json);
        $kid                = isset($options['kid']) && $options['kid'] !== '' ? (string) $options['kid'] : $this->get_active_kid();
        $nonce              = isset($options['nonce']) && $options['nonce'] !== '' ? (string) $options['nonce'] : $this->generate_nonce();
        $exp_ms             = isset($options['exp_ms']) ? (int) $options['exp_ms'] : ($this->now_ms() + $this->default_expiration_ms());
        $priority           = isset($options['priority']) ? (int) $options['priority'] : 100;
        $max_attempts       = isset($options['max_attempts']) ? (int) $options['max_attempts'] : 6;
        $rx_id              = isset($options['rx_id']) ? max(0, (int) $options['rx_id']) : 0;
        $req_id             = isset($options['req_id']) && $options['req_id'] !== '' ? (string) $options['req_id'] : $this->generate_req_id();
        $created_by         = isset($options['created_by']) ? max(0, (int) $options['created_by']) : max(0, (int) \get_current_user_id());
        $available_at       = isset($options['available_at']) && $options['available_at'] !== ''
            ? (string) $options['available_at']
            : $this->now_mysql();

        $mls1_token = $this->build_mls1_token($raw_json, $kid);
        if (\is_wp_error($mls1_token)) {
            return $mls1_token;
        }

        for ($i = 0; $i < 3; $i++) {
            $sql = $this->wpdb->prepare(
                "INSERT INTO `{$this->table}`
                (
                    `site_id`,
                    `job_type`,
                    `payload`,
                    `payload_sha256`,
                    `mls1_token`,
                    `nonce`,
                    `kid`,
                    `exp_ms`,
                    `status`,
                    `priority`,
                    `attempts`,
                    `max_attempts`,
                    `available_at`,
                    `rx_id`,
                    `req_id`,
                    `created_by`,
                    `created_at`,
                    `updated_at`
                )
                VALUES
                (
                    %s,
                    %s,
                    %s,
                    UNHEX(%s),
                    %s,
                    %s,
                    %s,
                    %d,
                    'PENDING',
                    %d,
                    0,
                    %d,
                    %s,
                    %d,
                    %s,
                    %d,
                    UTC_TIMESTAMP(),
                    UTC_TIMESTAMP()
                )",
                $this->site_id,
                $job_type,
                $raw_json,
                $payload_sha256_hex,
                $mls1_token,
                $nonce,
                $kid,
                $exp_ms,
                $priority,
                $max_attempts,
                $available_at,
                $rx_id,
                $req_id,
                $created_by
            );

            $previous_suppress = $this->wpdb->suppress_errors(true);
            $insert_result = $this->wpdb->query($sql);
            $this->wpdb->suppress_errors($previous_suppress);

            if ($insert_result !== false) {
                $job_id = (int) $this->wpdb->insert_id;

                return array(
                    'action'             => 'created',
                    'job'                => $this->get_by_id($job_id),
                    'raw_payload'        => $raw_json,
                    'payload_sha256_hex' => $payload_sha256_hex,
                    'mls1_token'         => $mls1_token,
                    'req_id'             => $req_id,
                );
            }

            $existing = $this->find_by_payload_hash($job_type, $payload_sha256_hex);
            if (!empty($existing)) {
                return array(
                    'action'             => 'reused',
                    'job'                => $existing,
                    'raw_payload'        => $raw_json,
                    'payload_sha256_hex' => $payload_sha256_hex,
                    'mls1_token'         => $mls1_token,
                    'req_id'             => $existing['req_id'] ? $existing['req_id'] : $req_id,
                );
            }

            $last_error = (string) $this->wpdb->last_error;
            if ($last_error !== '' && (stripos($last_error, 'nonce') !== false || stripos($last_error, 'uq_site_nonce') !== false)) {
                $nonce = $this->generate_nonce();
                continue;
            }

            return new \WP_Error(
                'sosprescription_job_insert_failed',
                $last_error !== '' ? $last_error : 'Échec de création du job PDF.',
                array(
                    'status'             => 500,
                    'payload_sha256_hex' => $payload_sha256_hex,
                    'req_id'             => $req_id,
                )
            );
        }

        return new \WP_Error(
            'sosprescription_job_insert_exhausted',
            'Échec de création du job PDF après plusieurs tentatives.',
            array('status' => 500, 'req_id' => $req_id)
        );
    }

    public function get_by_id($job_id)
    {
        $job_id = (int) $job_id;
        if ($job_id < 1) {
            return null;
        }

        $sql = $this->wpdb->prepare(
            $this->base_select_sql() . " WHERE `id` = %d LIMIT 1",
            $job_id
        );

        $row = $this->wpdb->get_row($sql, ARRAY_A);

        return $row ? $this->hydrate_row($row) : null;
    }

    public function find_by_payload_hash($job_type, $payload_sha256_hex)
    {
        $job_type = $this->normalize_job_type($job_type);

        $sql = $this->wpdb->prepare(
            $this->base_select_sql() . " WHERE `site_id` = %s AND `job_type` = %s AND `payload_sha256` = UNHEX(%s) ORDER BY `id` DESC LIMIT 1",
            $this->site_id,
            $job_type,
            $payload_sha256_hex
        );

        $row = $this->wpdb->get_row($sql, ARRAY_A);

        return $row ? $this->hydrate_row($row) : null;
    }

    public function get_latest_by_rx_id($rx_id, array $statuses = array())
    {
        $rx_id = (int) $rx_id;
        if ($rx_id < 1) {
            return null;
        }

        $sql  = $this->base_select_sql() . " WHERE `site_id` = %s AND `rx_id` = %d";
        $args = array($this->site_id, $rx_id);

        if (!empty($statuses)) {
            $statuses     = array_values(array_unique(array_map(array($this, 'normalize_status_value'), $statuses)));
            $placeholders = implode(', ', array_fill(0, count($statuses), '%s'));
            $sql         .= " AND `status` IN ({$placeholders})";
            $args         = array_merge($args, $statuses);
        }

        $sql .= " ORDER BY `id` DESC LIMIT 1";

        $prepared = $this->wpdb->prepare($sql, $args);
        $row      = $this->wpdb->get_row($prepared, ARRAY_A);

        return $row ? $this->hydrate_row($row) : null;
    }

    public function get_latest_done_by_rx_id($rx_id)
    {
        $rx_id = (int) $rx_id;
        if ($rx_id < 1) {
            return null;
        }

        $sql = $this->wpdb->prepare(
            $this->base_select_sql() . " WHERE `site_id` = %s AND `rx_id` = %d AND `status` = 'DONE' AND `s3_key_ref` <> '' ORDER BY `id` DESC LIMIT 1",
            $this->site_id,
            $rx_id
        );

        $row = $this->wpdb->get_row($sql, ARRAY_A);

        return $row ? $this->hydrate_row($row) : null;
    }

    public function list_by_rx_id($rx_id, $limit = 20)
    {
        $rx_id  = (int) $rx_id;
        $limit  = max(1, min(100, (int) $limit));
        $result = array();

        if ($rx_id < 1) {
            return $result;
        }

        $sql = $this->wpdb->prepare(
            $this->base_select_sql() . " WHERE `site_id` = %s AND `rx_id` = %d ORDER BY `id` DESC LIMIT %d",
            $this->site_id,
            $rx_id,
            $limit
        );

        $rows = $this->wpdb->get_results($sql, ARRAY_A);

        foreach ((array) $rows as $row) {
            $result[] = $this->hydrate_row($row);
        }

        return $result;
    }

    public function get_public_state_for_rx_id($rx_id)
    {
        $job = $this->get_latest_by_rx_id($rx_id);

        if (empty($job)) {
            return array(
                'status'       => 'absent',
                'job_id'       => 0,
                'req_id'       => '',
                'can_download' => false,
                's3_ready'     => false,
                'created_at'   => null,
                'updated_at'   => null,
                'attempts'     => 0,
            );
        }

        return $this->public_projection($job);
    }

    public function public_projection(array $job)
    {
        $db_status    = isset($job['status']) ? (string) $job['status'] : '';
        $public       = $this->map_public_status($db_status);
        $can_download = ($db_status === 'DONE' && !empty($job['s3_key_ref']));

        if ($db_status === 'DONE' && !$can_download) {
            $public = 'processing';
        }

        return array(
            'status'             => $public,
            'job_id'             => isset($job['id']) ? (int) $job['id'] : 0,
            'req_id'             => isset($job['req_id']) ? (string) $job['req_id'] : '',
            'can_download'       => $can_download,
            's3_ready'           => $can_download,
            'created_at'         => isset($job['created_at']) ? $job['created_at'] : null,
            'updated_at'         => isset($job['updated_at']) ? $job['updated_at'] : null,
            'attempts'           => isset($job['attempts']) ? (int) $job['attempts'] : 0,
            'last_error_code'    => !empty($job['last_error_code']) ? $job['last_error_code'] : null,
            'last_error_message' => ($db_status === 'FAILED' && !empty($job['last_error_message'])) ? $job['last_error_message'] : null,
        );
    }

    public function claim_next($worker_ref = '', $lease_seconds = 120, array $job_types = array())
    {
        if (!$this->table_exists()) {
            return null;
        }

        $lease_seconds = max(30, (int) $lease_seconds);
        $worker_ref    = $worker_ref !== '' ? (string) $worker_ref : $this->default_worker_ref();

        $sql  = $this->base_select_sql() . " WHERE `site_id` = %s AND `status` IN ('PENDING', 'RETRY') AND `available_at` <= UTC_TIMESTAMP() AND (`lock_expires_at` IS NULL OR `lock_expires_at` <= UTC_TIMESTAMP())";
        $args = array($this->site_id);

        if (!empty($job_types)) {
            $job_types    = array_values(array_unique(array_map(array($this, 'normalize_job_type'), $job_types)));
            $placeholders = implode(', ', array_fill(0, count($job_types), '%s'));
            $sql         .= " AND `job_type` IN ({$placeholders})";
            $args         = array_merge($args, $job_types);
        }

        $sql .= " ORDER BY `priority` ASC, `id` ASC LIMIT 1 FOR UPDATE";

        $this->wpdb->query('START TRANSACTION');

        $row = $this->wpdb->get_row($this->wpdb->prepare($sql, $args), ARRAY_A);

        if (empty($row)) {
            $this->wpdb->query('COMMIT');
            return null;
        }

        $job_id = (int) $row['id'];

        $updated = $this->wpdb->query(
            $this->wpdb->prepare(
                "UPDATE `{$this->table}`
                 SET
                    `status` = 'CLAIMED',
                    `attempts` = `attempts` + 1,
                    `locked_by` = %s,
                    `locked_at` = UTC_TIMESTAMP(),
                    `lock_expires_at` = DATE_ADD(UTC_TIMESTAMP(), INTERVAL %d SECOND),
                    `started_at` = IF(`started_at` IS NULL, UTC_TIMESTAMP(), `started_at`),
                    `updated_at` = UTC_TIMESTAMP()
                 WHERE `id` = %d AND `status` IN ('PENDING', 'RETRY')",
                $worker_ref,
                $lease_seconds,
                $job_id
            )
        );

        if ($updated === false || $updated < 1) {
            $this->wpdb->query('ROLLBACK');
            return null;
        }

        $this->wpdb->query('COMMIT');

        return $this->get_by_id($job_id);
    }

    public function touch_running($job_id, $worker_ref = '', $lease_seconds = 120)
    {
        $job_id        = (int) $job_id;
        $lease_seconds = max(30, (int) $lease_seconds);
        $worker_ref    = $worker_ref !== '' ? (string) $worker_ref : $this->default_worker_ref();

        if ($job_id < 1) {
            return false;
        }

        $sql = $this->wpdb->prepare(
            "UPDATE `{$this->table}`
             SET
                `status` = 'RUNNING',
                `locked_by` = %s,
                `lock_expires_at` = DATE_ADD(UTC_TIMESTAMP(), INTERVAL %d SECOND),
                `updated_at` = UTC_TIMESTAMP()
             WHERE `id` = %d",
            $worker_ref,
            $lease_seconds,
            $job_id
        );

        return $this->wpdb->query($sql) !== false;
    }

    public function mark_done($job_id, array $artifact = array())
    {
        $job_id = (int) $job_id;
        if ($job_id < 1) {
            return false;
        }

        $s3_key_ref      = isset($artifact['s3_key_ref']) ? (string) $artifact['s3_key_ref'] : '';
        $s3_bucket       = isset($artifact['s3_bucket']) ? (string) $artifact['s3_bucket'] : '';
        $s3_region       = isset($artifact['s3_region']) ? (string) $artifact['s3_region'] : '';
        $artifact_sha256 = isset($artifact['artifact_sha256']) ? (string) $artifact['artifact_sha256'] : '';
        $artifact_size   = isset($artifact['artifact_size']) ? (int) $artifact['artifact_size'] : 0;
        $worker_ref      = isset($artifact['worker_ref']) ? (string) $artifact['worker_ref'] : '';

        $sql = $this->wpdb->prepare(
            "UPDATE `{$this->table}`
             SET
                `status` = 'DONE',
                `s3_key_ref` = %s,
                `s3_bucket` = %s,
                `s3_region` = %s,
                `artifact_sha256` = %s,
                `artifact_size` = %d,
                `worker_ref` = %s,
                `locked_by` = '',
                `locked_at` = NULL,
                `lock_expires_at` = NULL,
                `finished_at` = UTC_TIMESTAMP(),
                `last_error_code` = '',
                `last_error_message` = NULL,
                `updated_at` = UTC_TIMESTAMP()
             WHERE `id` = %d",
            $s3_key_ref,
            $s3_bucket,
            $s3_region,
            $artifact_sha256,
            $artifact_size,
            $worker_ref,
            $job_id
        );

        return $this->wpdb->query($sql) !== false;
    }

    public function mark_failed($job_id, $error_code, $error_message)
    {
        $job_id        = (int) $job_id;
        $error_code    = (string) $error_code;
        $error_message = (string) $error_message;

        if ($job_id < 1) {
            return false;
        }

        $sql = $this->wpdb->prepare(
            "UPDATE `{$this->table}`
             SET
                `status` = 'FAILED',
                `last_error_code` = %s,
                `last_error_message` = %s,
                `locked_by` = '',
                `locked_at` = NULL,
                `lock_expires_at` = NULL,
                `finished_at` = UTC_TIMESTAMP(),
                `updated_at` = UTC_TIMESTAMP()
             WHERE `id` = %d",
            $error_code,
            $error_message,
            $job_id
        );

        return $this->wpdb->query($sql) !== false;
    }

    public function requeue($job_id, $delay_seconds = 30, $error_code = '', $error_message = '')
    {
        $job_id        = (int) $job_id;
        $delay_seconds = max(0, (int) $delay_seconds);
        $error_code    = (string) $error_code;
        $error_message = (string) $error_message;

        if ($job_id < 1) {
            return false;
        }

        $available_at = gmdate('Y-m-d H:i:s', time() + $delay_seconds);

        $sql = $this->wpdb->prepare(
            "UPDATE `{$this->table}`
             SET
                `status` = 'RETRY',
                `available_at` = %s,
                `last_error_code` = %s,
                `last_error_message` = %s,
                `locked_by` = '',
                `locked_at` = NULL,
                `lock_expires_at` = NULL,
                `updated_at` = UTC_TIMESTAMP()
             WHERE `id` = %d",
            $available_at,
            $error_code,
            $error_message,
            $job_id
        );

        return $this->wpdb->query($sql) !== false;
    }

    protected function base_select_sql()
    {
        return "SELECT
                    `id`,
                    `site_id`,
                    `job_type`,
                    `payload`,
                    HEX(`payload_sha256`) AS `payload_sha256_hex`,
                    `mls1_token`,
                    `nonce`,
                    `kid`,
                    `exp_ms`,
                    `status`,
                    `priority`,
                    `attempts`,
                    `max_attempts`,
                    `locked_at`,
                    `lock_expires_at`,
                    `locked_by`,
                    `available_at`,
                    `started_at`,
                    `finished_at`,
                    `last_error_code`,
                    `last_error_message`,
                    `rx_id`,
                    `s3_key_ref`,
                    `s3_bucket`,
                    `s3_region`,
                    `artifact_sha256`,
                    `artifact_size`,
                    `worker_ref`,
                    `req_id`,
                    `created_by`,
                    `created_at`,
                    `updated_at`
                FROM `{$this->table}`";
    }

    protected function hydrate_row(array $row)
    {
        foreach (array('id', 'exp_ms', 'priority', 'attempts', 'max_attempts', 'rx_id', 'artifact_size', 'created_by') as $int_key) {
            if (isset($row[$int_key])) {
                $row[$int_key] = (int) $row[$int_key];
            }
        }

        if (isset($row['payload']) && is_string($row['payload']) && $row['payload'] !== '') {
            $decoded = json_decode($row['payload'], true);
            if (json_last_error() === JSON_ERROR_NONE) {
                $row['payload'] = $decoded;
            }
        }

        return $row;
    }

    protected function table_exists()
    {
        $sql = $this->wpdb->prepare('SHOW TABLES LIKE %s', $this->table);

        return (string) $this->wpdb->get_var($sql) === (string) $this->table;
    }

    protected function resolve_site_id()
    {
        $site_id = '';

        if (defined('SOSPRESCRIPTION_SITE_ID')) {
            $site_id = (string) constant('SOSPRESCRIPTION_SITE_ID');
        } elseif (defined('ML_SITE_ID')) {
            $site_id = (string) constant('ML_SITE_ID');
        } elseif (\getenv('SOSPRESCRIPTION_SITE_ID')) {
            $site_id = (string) \getenv('SOSPRESCRIPTION_SITE_ID');
        } elseif (\getenv('ML_SITE_ID')) {
            $site_id = (string) \getenv('ML_SITE_ID');
        } else {
            $site_id = 'mls1';
        }

        $site_id = trim($site_id);
        if ($site_id === '') {
            $site_id = 'mls1';
        }

        return (string) \apply_filters('sosprescription_site_id', $site_id);
    }

    protected function normalize_job_type($job_type)
    {
        $job_type = strtoupper((string) $job_type);
        $job_type = preg_replace('/[^A-Z0-9_\-]/', '_', $job_type);

        return $job_type !== '' ? $job_type : 'PDF_GEN';
    }

    protected function normalize_status_value($status)
    {
        $status = strtoupper((string) $status);
        $status = preg_replace('/[^A-Z0-9_\-]/', '', $status);

        return $status !== '' ? $status : 'PENDING';
    }

    protected function map_public_status($db_status)
    {
        $db_status = strtoupper((string) $db_status);

        if (in_array($db_status, array('PENDING', 'QUEUED', 'RETRY'), true)) {
            return 'pending';
        }

        if (in_array($db_status, array('CLAIMED', 'RUNNING'), true)) {
            return 'processing';
        }

        if ($db_status === 'DONE') {
            return 'done';
        }

        if ($db_status === 'FAILED') {
            return 'failed';
        }

        return 'pending';
    }

    protected function default_worker_ref()
    {
        $host = \gethostname();
        $host = $host ? $host : 'wordpress';

        return 'wp:' . $host;
    }

    protected function default_expiration_ms()
    {
        $default = DAY_IN_SECONDS * 1000;

        return (int) \apply_filters('sosprescription_jobs_default_expiration_ms', $default);
    }

    protected function now_mysql()
    {
        return gmdate('Y-m-d H:i:s');
    }

    protected function now_ms()
    {
        return (int) floor(microtime(true) * 1000);
    }

    protected function generate_nonce()
    {
        try {
            $random = bin2hex(random_bytes(16));
        } catch (\Exception $e) {
            $random = md5((string) wp_rand() . microtime(true));
        }

        return 'n_' . $this->site_id . '_' . $random;
    }

    protected function generate_req_id()
    {
        try {
            $random = bin2hex(random_bytes(8));
        } catch (\Exception $e) {
            $random = md5((string) wp_rand() . microtime(true));
        }

        return 'req_' . $random;
    }

    protected function build_mls1_token($raw_payload_bytes, $kid)
    {
        $secret = $this->get_secret_for_kid($kid);

        if ($secret === '') {
            return new \WP_Error(
                'sosprescription_hmac_secret_missing',
                'ML_HMAC_SECRET est manquant ou invalide.',
                array('status' => 500, 'kid' => $kid)
            );
        }

        $encoded_payload = $this->base64url_encode($raw_payload_bytes);
        $signature_hex   = hash_hmac('sha256', $raw_payload_bytes, $secret);

        return 'mls1.' . $encoded_payload . '.' . $signature_hex;
    }

    protected function get_active_kid()
    {
        $keyset = $this->resolve_hmac_keyset();

        return isset($keyset['active_kid']) && $keyset['active_kid'] !== '' ? (string) $keyset['active_kid'] : 'primary';
    }

    protected function get_secret_for_kid($kid)
    {
        $kid    = (string) $kid;
        $keyset = $this->resolve_hmac_keyset();

        if (!empty($keyset['keys'][$kid])) {
            return (string) $keyset['keys'][$kid];
        }

        $active = isset($keyset['active_kid']) ? (string) $keyset['active_kid'] : '';
        if ($active !== '' && !empty($keyset['keys'][$active])) {
            return (string) $keyset['keys'][$active];
        }

        return '';
    }

    protected function resolve_hmac_keyset()
    {
        static $resolved = null;

        if (is_array($resolved)) {
            return $resolved;
        }

        $keys       = array();
        $active_kid = 'primary';

        if (defined('ML_HMAC_KID') && constant('ML_HMAC_KID')) {
            $active_kid = (string) constant('ML_HMAC_KID');
        } elseif (\getenv('ML_HMAC_KID')) {
            $active_kid = (string) \getenv('ML_HMAC_KID');
        }

        $raw_secret = null;
        if (defined('ML_HMAC_SECRET')) {
            $raw_secret = constant('ML_HMAC_SECRET');
        } elseif (\getenv('ML_HMAC_SECRET') !== false) {
            $raw_secret = \getenv('ML_HMAC_SECRET');
        }

        if (is_array($raw_secret)) {
            foreach ($raw_secret as $k => $secret) {
                if (is_string($secret) && $secret !== '') {
                    $keys[(string) $k] = $secret;
                }
            }
        } elseif (is_string($raw_secret) && $raw_secret !== '') {
            $decoded = json_decode($raw_secret, true);

            if (json_last_error() === JSON_ERROR_NONE && is_array($decoded)) {
                if (isset($decoded['keys']) && is_array($decoded['keys'])) {
                    foreach ($decoded['keys'] as $k => $secret) {
                        if (is_string($secret) && $secret !== '') {
                            $keys[(string) $k] = $secret;
                        }
                    }

                    if (!empty($decoded['active_kid'])) {
                        $active_kid = (string) $decoded['active_kid'];
                    }
                } else {
                    foreach ($decoded as $k => $secret) {
                        if (is_string($secret) && $secret !== '') {
                            $keys[(string) $k] = $secret;
                        }
                    }
                }
            } else {
                $keys[$active_kid] = $raw_secret;
            }
        }

        $previous_secret = '';
        $previous_kid    = 'previous';

        if (defined('ML_HMAC_PREVIOUS_SECRET') && constant('ML_HMAC_PREVIOUS_SECRET')) {
            $previous_secret = (string) constant('ML_HMAC_PREVIOUS_SECRET');
        } elseif (\getenv('ML_HMAC_PREVIOUS_SECRET')) {
            $previous_secret = (string) \getenv('ML_HMAC_PREVIOUS_SECRET');
        }

        if (defined('ML_HMAC_PREVIOUS_KID') && constant('ML_HMAC_PREVIOUS_KID')) {
            $previous_kid = (string) constant('ML_HMAC_PREVIOUS_KID');
        } elseif (\getenv('ML_HMAC_PREVIOUS_KID')) {
            $previous_kid = (string) \getenv('ML_HMAC_PREVIOUS_KID');
        }

        if ($previous_secret !== '') {
            $keys[$previous_kid] = $previous_secret;
        }

        if (empty($keys) && is_string($raw_secret) && $raw_secret !== '') {
            $keys[$active_kid] = $raw_secret;
        }

        $resolved = array(
            'active_kid' => $active_kid !== '' ? $active_kid : 'primary',
            'keys'       => $keys,
        );

        return $resolved;
    }

    protected function base64url_encode($value)
    {
        return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
    }

    protected function canonicalize_value($value)
    {
        if (!is_array($value)) {
            return $value;
        }

        if ($this->is_assoc($value)) {
            ksort($value);
        }

        foreach ($value as $key => $item) {
            $value[$key] = $this->canonicalize_value($item);
        }

        return $value;
    }

    protected function is_assoc(array $value)
    {
        if ($value === array()) {
            return false;
        }

        return array_keys($value) !== range(0, count($value) - 1);
    }
}
