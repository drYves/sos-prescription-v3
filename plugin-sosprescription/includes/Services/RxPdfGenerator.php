<?php
// includes/Services/RxPdfGenerator.php

namespace SOSPrescription\Services;

use SOSPrescription\Repositories\JobRepository;

defined('ABSPATH') || exit;

class RxPdfGenerator
{
    /** @var \wpdb */
    protected $wpdb;

    /** @var JobRepository */
    protected $jobs;

    /** @var string */
    protected $site_id = 'mls1';

    /** @var string */
    protected $prescriptions_table = '';

    /** @var string */
    protected $items_table = '';

    /** @var array<string, array<string, string>> */
    protected $column_cache = array();

    public function __construct($jobs = null, $wpdb = null)
    {
        if ($wpdb instanceof \wpdb) {
            $this->wpdb = $wpdb;
        } else {
            global $wpdb;
            $this->wpdb = $wpdb;
        }

        $this->jobs    = $jobs instanceof JobRepository ? $jobs : new JobRepository($this->wpdb);
        $this->site_id = $this->jobs->get_site_id();
    }

    public function generate($prescription_id, array $args = array())
    {
        $prescription_id = (int) $prescription_id;

        if ($prescription_id < 1) {
            return new \WP_Error(
                'sosprescription_invalid_prescription_id',
                'Identifiant de prescription invalide.',
                array('status' => 400)
            );
        }

        $verification = $this->ensure_verification_payload($prescription_id);
        if (\is_wp_error($verification)) {
            return $verification;
        }

        $context = $this->get_prescription_context($prescription_id);
        if (\is_wp_error($context)) {
            return $context;
        }

        $fingerprint = $this->compute_context_fingerprint($context);
        $payload     = $this->build_pdf_job_payload($context, $fingerprint, $args);
        $req_id      = !empty($args['req_id']) ? (string) $args['req_id'] : $this->generate_req_id();

        $dispatch = $this->jobs->create_or_reuse(
            $payload,
            array(
                'job_type'     => 'PDF_GEN',
                'rx_id'        => $prescription_id,
                'req_id'       => $req_id,
                'created_by'   => max(0, (int) \get_current_user_id()),
                'priority'     => isset($args['priority']) ? (int) $args['priority'] : 100,
                'max_attempts' => isset($args['max_attempts']) ? (int) $args['max_attempts'] : 6,
                'exp_ms'       => isset($args['exp_ms'])
                    ? (int) $args['exp_ms']
                    : (int) \apply_filters('sosprescription_pdf_job_expiration_ms', (time() + DAY_IN_SECONDS) * 1000, $prescription_id, $payload),
            )
        );

        if (\is_wp_error($dispatch)) {
            return $dispatch;
        }

        $job = isset($dispatch['job']) && is_array($dispatch['job']) ? $dispatch['job'] : array();
        $pdf = $this->jobs->get_public_state_for_rx_id($prescription_id);

        if ($pdf['status'] === 'absent' && !empty($job)) {
            $pdf = $this->jobs->public_projection($job);
        }

        return array(
            'ok'              => true,
            'mode'            => 'stateless',
            'site_id'         => $this->site_id,
            'req_id'          => $dispatch['req_id'],
            'prescription_id' => $prescription_id,
            'verification'    => array(
                'verify_token' => isset($verification['verify_token']) ? $verification['verify_token'] : '',
                'verify_code'  => isset($verification['verify_code']) ? $verification['verify_code'] : '',
            ),
            'dispatch'        => array(
                'action' => isset($dispatch['action']) ? $dispatch['action'] : 'created',
                'job_id' => isset($job['id']) ? (int) $job['id'] : 0,
                'status' => isset($job['status']) ? strtolower((string) $job['status']) : 'pending',
                'req_id' => isset($job['req_id']) ? (string) $job['req_id'] : $dispatch['req_id'],
            ),
            'pdf'             => $pdf,
            'job_payload'     => array(
                'schema_version' => 1,
                'payload_sha256' => isset($job['payload_sha256_hex']) ? (string) $job['payload_sha256_hex'] : '',
            ),
        );
    }

    public function get_status($prescription_id)
    {
        return $this->jobs->get_public_state_for_rx_id((int) $prescription_id);
    }

    public function get_prescription_context($prescription_id)
    {
        $prescription_id = (int) $prescription_id;
        $prescription    = $this->fetch_prescription($prescription_id);

        if (empty($prescription)) {
            return new \WP_Error(
                'sosprescription_prescription_not_found',
                'Prescription introuvable.',
                array('status' => 404)
            );
        }

        return array(
            'prescription' => $prescription,
            'items'        => $this->fetch_items($prescription_id),
            'template'     => array(
                'path'   => $this->resolve_rx_template_path(),
                'sha256' => $this->template_checksum_sha256(),
            ),
        );
    }

    public function ensure_verification_payload($prescription_id)
    {
        $prescription_id = (int) $prescription_id;
        $row             = $this->fetch_prescription($prescription_id);

        if (empty($row)) {
            return new \WP_Error(
                'sosprescription_prescription_not_found',
                'Prescription introuvable.',
                array('status' => 404)
            );
        }

        $table   = $this->get_prescriptions_table();
        $columns = array_keys($this->get_table_columns($table));

        $token_col = $this->first_existing_column($columns, array('verify_token', 'verification_token'));
        $code_col  = $this->first_existing_column($columns, array('verify_code', 'verification_code'));

        if ($token_col === '' || $code_col === '') {
            return new \WP_Error(
                'sosprescription_verification_columns_missing',
                'Les colonnes de vérification sont introuvables sur la table des prescriptions.',
                array('status' => 500)
            );
        }

        $updates = array();
        $formats = array();

        if (empty($row[$token_col])) {
            $updates[$token_col] = $this->generate_verify_token();
            $formats[]           = '%s';
        }

        if (empty($row[$code_col])) {
            $updates[$code_col] = $this->generate_verify_code();
            $formats[]          = '%s';
        }

        if (!empty($updates)) {
            $updated_at_col = $this->first_existing_column($columns, array('updated_at'));
            if ($updated_at_col !== '') {
                $updates[$updated_at_col] = gmdate('Y-m-d H:i:s');
                $formats[]                = '%s';
            }

            $where = array('id' => $prescription_id);
            $this->wpdb->update($table, $updates, $where, $formats, array('%d'));
        }

        $fresh = $this->fetch_prescription($prescription_id);

        return array(
            'verify_token' => isset($fresh[$token_col]) ? (string) $fresh[$token_col] : '',
            'verify_code'  => isset($fresh[$code_col]) ? (string) $fresh[$code_col] : '',
            'prescription' => $fresh,
        );
    }

    public function mpdf_config_base()
    {
        return array(
            'mode'                 => 'stateless',
            'local_pdf_generation' => false,
            'engine'               => 'worker',
            'site_id'              => $this->site_id,
            'jobs_table'           => $this->jobs->get_table_name(),
            'template_path'        => $this->resolve_rx_template_path(),
            'template_sha256'      => $this->template_checksum_sha256(),
            'legacy_mpdf_disabled' => true,
        );
    }

    public function debug_get_mpdf_config()
    {
        return $this->mpdf_config_base();
    }

    public function ensure_mpdf_loaded()
    {
        return false;
    }

    public function build_pdf_bytes_mpdf()
    {
        return new \WP_Error(
            'sosprescription_stateless_pdf_generation_disabled',
            'La génération PDF locale via mPDF est désactivée en v2.2.0 Stateless.',
            array('status' => 501)
        );
    }

    public function build_pdf_bytes_from_data(array $data)
    {
        return new \WP_Error(
            'sosprescription_stateless_pdf_generation_disabled',
            'La génération PDF locale via mPDF est désactivée en v2.2.0 Stateless.',
            array(
                'status' => 501,
                'mode'   => 'stateless',
                'data'   => $data,
            )
        );
    }

    public function render_rx_html_mpdf_from_file(array $context = array(), $template_path = null)
    {
        $template_path = $template_path ? (string) $template_path : $this->resolve_rx_template_path();

        if (!$template_path || !is_readable($template_path)) {
            return '';
        }

        $html = (string) file_get_contents($template_path);

        if (empty($context)) {
            return $html;
        }

        $flat = array();
        $this->flatten_context($context, '', $flat);

        foreach ($flat as $key => $value) {
            $string_value = is_scalar($value) ? (string) $value : \wp_json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            $html = str_replace('{{' . $key . '}}', $string_value, $html);
            $html = str_replace('{{ ' . $key . ' }}', $string_value, $html);
            $html = str_replace('%%' . strtoupper(str_replace('.', '_', $key)) . '%%', $string_value, $html);
        }

        if (strpos($html, '{{CONTEXT_JSON}}') !== false || strpos($html, '%%CONTEXT_JSON%%') !== false) {
            $json = \wp_json_encode($context, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            $html = str_replace('{{CONTEXT_JSON}}', (string) $json, $html);
            $html = str_replace('%%CONTEXT_JSON%%', (string) $json, $html);
        }

        return $html;
    }

    public function resolve_rx_template_path()
    {
        $plugin_root = dirname(__DIR__, 2);

        $candidates = array(
            $plugin_root . '/templates/rx-ordonnance.html',
            $plugin_root . '/templates/rx-ordonnance-mpdf.html',
            $plugin_root . '/templates/rx-ordonnance.php',
        );

        $candidates = (array) \apply_filters('sosprescription_rx_template_candidates', $candidates);

        foreach ($candidates as $candidate) {
            if (is_string($candidate) && $candidate !== '' && is_readable($candidate)) {
                return $candidate;
            }
        }

        return null;
    }

    protected function build_pdf_job_payload(array $context, $context_fingerprint_sha256, array $args = array())
    {
        $prescription = isset($context['prescription']) && is_array($context['prescription']) ? $context['prescription'] : array();

        return array(
            'schema_version' => 1,
            'site_id'        => $this->site_id,
            'op'             => 'PDF_GEN',
            'rx'             => array(
                'id'  => isset($prescription['id']) ? (int) $prescription['id'] : 0,
                'uid' => $this->extract_rx_uid($prescription),
            ),
            'artifact'       => array(
                'kind'         => 'rx_pdf',
                'content_type' => 'application/pdf',
            ),
            'render'         => array(
                'engine'                     => 'puppeteer',
                'template_family'            => 'rx-ordonnance',
                'template_revision'          => 'v3',
                'template_checksum_sha256'   => !empty($context['template']['sha256']) ? (string) $context['template']['sha256'] : '',
                'context_fingerprint_sha256' => (string) $context_fingerprint_sha256,
                'source_revision'            => $this->plugin_version(),
            ),
            'trigger'        => array(
                'source' => 'wordpress',
            ),
        );
    }

    protected function compute_context_fingerprint(array $context)
    {
        $material = array(
            'prescription'    => $this->strip_volatile_recursive(isset($context['prescription']) ? $context['prescription'] : array()),
            'items'           => $this->strip_volatile_recursive(isset($context['items']) ? $context['items'] : array()),
            'template_sha256' => !empty($context['template']['sha256']) ? (string) $context['template']['sha256'] : '',
            'render_family'   => 'rx-ordonnance',
            'render_revision' => 'v3',
            'plugin_version'  => $this->plugin_version(),
        );

        $material = $this->canonicalize_value($material);
        $json     = \wp_json_encode($material, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

        return hash('sha256', is_string($json) ? $json : '');
    }

    protected function fetch_prescription($prescription_id)
    {
        $table = $this->get_prescriptions_table();

        if ($table === '') {
            return null;
        }

        $sql = $this->wpdb->prepare(
            "SELECT * FROM `{$table}` WHERE `id` = %d LIMIT 1",
            (int) $prescription_id
        );

        $row = $this->wpdb->get_row($sql, ARRAY_A);

        return $row ? $this->decode_jsonish_row($row) : null;
    }

    protected function fetch_items($prescription_id)
    {
        $table = $this->get_items_table();

        if ($table === '') {
            return array();
        }

        $columns = array_keys($this->get_table_columns($table));
        $fk_col  = $this->first_existing_column($columns, array('prescription_id', 'rx_id'));

        if ($fk_col === '') {
            return array();
        }

        $order_col = $this->first_existing_column($columns, array('line_no', 'position', 'sort_order', 'id'));
        $order_sql = $order_col !== '' ? " ORDER BY `{$order_col}` ASC, `id` ASC" : '';

        $sql = $this->wpdb->prepare(
            "SELECT * FROM `{$table}` WHERE `{$fk_col}` = %d{$order_sql}",
            (int) $prescription_id
        );

        $rows   = $this->wpdb->get_results($sql, ARRAY_A);
        $result = array();

        foreach ((array) $rows as $row) {
            $result[] = $this->decode_jsonish_row($row);
        }

        return $result;
    }

    protected function get_prescriptions_table()
    {
        if ($this->prescriptions_table !== '') {
            return $this->prescriptions_table;
        }

        $candidates = array(
            $this->wpdb->prefix . 'sosprescription_prescriptions',
            $this->wpdb->prefix . 'sosprescription_prescription',
            $this->wpdb->prefix . 'sosprescription_rx',
        );

        foreach ($candidates as $table) {
            if ($this->table_exists($table)) {
                $this->prescriptions_table = $table;
                break;
            }
        }

        if ($this->prescriptions_table === '') {
            $this->prescriptions_table = $this->wpdb->prefix . 'sosprescription_prescriptions';
        }

        return $this->prescriptions_table;
    }

    protected function get_items_table()
    {
        if ($this->items_table !== '') {
            return $this->items_table;
        }

        $candidates = array(
            $this->wpdb->prefix . 'sosprescription_prescription_items',
            $this->wpdb->prefix . 'sosprescription_items',
            $this->wpdb->prefix . 'sosprescription_medications',
            $this->wpdb->prefix . 'sosprescription_prescription_lines',
        );

        foreach ($candidates as $table) {
            if ($this->table_exists($table)) {
                $columns = array_keys($this->get_table_columns($table));
                if ($this->first_existing_column($columns, array('prescription_id', 'rx_id')) !== '') {
                    $this->items_table = $table;
                    break;
                }
            }
        }

        return $this->items_table;
    }

    protected function table_exists($table)
    {
        $sql = $this->wpdb->prepare('SHOW TABLES LIKE %s', $table);

        return (string) $this->wpdb->get_var($sql) === (string) $table;
    }

    protected function get_table_columns($table)
    {
        if (isset($this->column_cache[$table])) {
            return $this->column_cache[$table];
        }

        $columns = array();
        $rows    = $this->wpdb->get_results("SHOW FULL COLUMNS FROM `{$table}`", ARRAY_A);

        foreach ((array) $rows as $row) {
            if (!empty($row['Field'])) {
                $columns[$row['Field']] = !empty($row['Type']) ? strtolower((string) $row['Type']) : 'text';
            }
        }

        $this->column_cache[$table] = $columns;

        return $columns;
    }

    protected function first_existing_column(array $columns, array $candidates)
    {
        foreach ($candidates as $candidate) {
            if (in_array($candidate, $columns, true)) {
                return $candidate;
            }
        }

        return '';
    }

    protected function extract_rx_uid(array $prescription)
    {
        foreach (array('rx_uid', 'uid', 'public_uid', 'public_id', 'reference', 'code') as $key) {
            if (!empty($prescription[$key])) {
                return (string) $prescription[$key];
            }
        }

        $id = isset($prescription['id']) ? (int) $prescription['id'] : 0;

        return 'RX-' . str_pad((string) $id, 6, '0', STR_PAD_LEFT);
    }

    protected function plugin_version()
    {
        if (defined('SOSPRESCRIPTION_VERSION')) {
            return (string) constant('SOSPRESCRIPTION_VERSION');
        }

        $version = (string) \get_option('sosprescription_plugin_version', '2.2.0');

        return $version !== '' ? $version : '2.2.0';
    }

    protected function template_checksum_sha256()
    {
        $path = $this->resolve_rx_template_path();

        if (!$path || !is_readable($path)) {
            return '';
        }

        $contents = @file_get_contents($path);
        if ($contents === false) {
            return '';
        }

        return hash('sha256', $contents);
    }

    protected function generate_verify_token()
    {
        try {
            return rtrim(strtr(base64_encode(random_bytes(24)), '+/', '-_'), '=');
        } catch (\Exception $e) {
            return \wp_generate_password(32, false, false);
        }
    }

    protected function generate_verify_code()
    {
        try {
            return str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
        } catch (\Exception $e) {
            return str_pad((string) \wp_rand(0, 999999), 6, '0', STR_PAD_LEFT);
        }
    }

    protected function generate_req_id()
    {
        try {
            return 'req_' . bin2hex(random_bytes(8));
        } catch (\Exception $e) {
            return 'req_' . md5((string) \wp_rand() . microtime(true));
        }
    }

    protected function decode_jsonish_row(array $row)
    {
        foreach ($row as $key => $value) {
            if (is_string($value)) {
                $trimmed = trim($value);
                if ($trimmed !== '' && (($trimmed[0] === '{' && substr($trimmed, -1) === '}') || ($trimmed[0] === '[' && substr($trimmed, -1) === ']'))) {
                    $decoded = json_decode($trimmed, true);
                    if (json_last_error() === JSON_ERROR_NONE) {
                        $row[$key] = $decoded;
                    }
                }
            }
        }

        return $row;
    }

    protected function strip_volatile_recursive($value)
    {
        if (!is_array($value)) {
            return $value;
        }

        if ($this->is_assoc($value)) {
            $clean = array();

            foreach ($value as $key => $item) {
                if ($this->is_volatile_key((string) $key)) {
                    continue;
                }

                $clean[$key] = $this->strip_volatile_recursive($item);
            }

            ksort($clean);

            return $clean;
        }

        $clean = array();
        foreach ($value as $item) {
            $clean[] = $this->strip_volatile_recursive($item);
        }

        return $clean;
    }

    protected function is_volatile_key($key)
    {
        $volatile = array(
            'created_at',
            'updated_at',
            'deleted_at',
            'req_id',
            'payload',
            'payload_sha256',
            'payload_sha256_hex',
            'mls1_token',
            'nonce',
            'kid',
            'locked_at',
            'lock_expires_at',
            'locked_by',
            'available_at',
            'started_at',
            'finished_at',
            'last_error_code',
            'last_error_message',
            's3_key_ref',
            's3_bucket',
            's3_region',
            'artifact_sha256',
            'artifact_size',
            'worker_ref',
            'pdf_status',
            'pdf_job_id',
        );

        if (in_array($key, $volatile, true)) {
            return true;
        }

        return (bool) preg_match('/^(_|tmp_|cache_)/', $key);
    }

    protected function flatten_context(array $context, $prefix, array &$flat)
    {
        foreach ($context as $key => $value) {
            $full_key = $prefix === '' ? (string) $key : $prefix . '.' . $key;

            if (is_array($value)) {
                $this->flatten_context($value, $full_key, $flat);
                continue;
            }

            $flat[$full_key] = $value;
        }
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
