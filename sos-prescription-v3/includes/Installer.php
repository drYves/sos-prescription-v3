<?php
// includes/Installer.php

namespace SOSPrescription;

defined('ABSPATH') || exit;

final class Installer
{
    const DB_VERSION = '3.2.6';

    public static function activate()
    {
        self::install();
    }

    public static function maybe_upgrade()
    {
        $installed = (string) \get_option('sosprescription_db_version', '');
        if ($installed === '' || version_compare($installed, self::DB_VERSION, '<')) {
            self::install();
        }
    }

    public static function install()
    {
        global $wpdb;

        if (!($wpdb instanceof \wpdb)) {
            return;
        }

        self::force_schema_integrity($wpdb);
        self::ensure_jobs_columns($wpdb);
        self::ensure_jobs_indexes($wpdb);
        self::ensure_prescription_indexes($wpdb);

        \update_option('sosprescription_db_version', self::DB_VERSION, false);
        \update_option('sosprescription_plugin_version', self::DB_VERSION, false);

        \do_action('sosprescription_installed', self::DB_VERSION);
    }

    /**
     * Création brute et idempotente des tables critiques, sans dépendre uniquement de dbDelta().
     *
     * @return array<string, mixed>
     */
    public static function force_schema_integrity(?\wpdb $wpdb = null): array
    {
        if (!$wpdb instanceof \wpdb) {
            global $wpdb;
        }

        if (!($wpdb instanceof \wpdb)) {
            return [
                'ok' => false,
                'message' => 'wpdb indisponible.',
                'tables' => [],
            ];
        }

        $results = [];
        foreach (self::raw_schema_queries($wpdb) as $table => $sql) {
            $before = self::table_exists($wpdb, $table);
            $queryResult = $wpdb->query($sql);
            $after = self::table_exists($wpdb, $table);

            $results[$table] = [
                'exists_before' => $before,
                'exists_after' => $after,
                'created' => !$before && $after,
                'query_ok' => $queryResult !== false,
                'last_error' => (string) $wpdb->last_error,
            ];
        }

        $ok = true;
        foreach ($results as $result) {
            if (empty($result['exists_after'])) {
                $ok = false;
                break;
            }
        }

        if ($ok) {
            \update_option('sosprescription_db_version', self::DB_VERSION, false);
            \update_option('sosprescription_plugin_version', self::DB_VERSION, false);
        }

        return [
            'ok' => $ok,
            'message' => $ok ? 'Schema SQL verifie.' : 'Certaines tables critiques sont encore absentes.',
            'tables' => $results,
        ];
    }

    public static function jobs_table_name()
    {
        global $wpdb;

        return $wpdb->prefix . 'sosprescription_jobs';
    }

    /**
     * @return array<string, string>
     */
    protected static function raw_schema_queries(\wpdb $wpdb): array
    {
        $charset_collate = $wpdb->get_charset_collate();

        $prescriptions = $wpdb->prefix . 'sosprescription_prescriptions';
        $items = $wpdb->prefix . 'sosprescription_prescription_items';
        $messages = $wpdb->prefix . 'sosprescription_prescription_messages';
        $files = $wpdb->prefix . 'sosprescription_files';
        $audit = $wpdb->prefix . 'sosprescription_audit';
        $auditLog = $wpdb->prefix . 'sosprescription_audit_log';
        $jobs = $wpdb->prefix . 'sosprescription_jobs';
        $nonces = $wpdb->prefix . 'sosprescription_nonces';
        $cis = $wpdb->prefix . 'sosprescription_cis';
        $cip = $wpdb->prefix . 'sosprescription_cip';
        $mitm = $wpdb->prefix . 'sosprescription_mitm';
        $medications = $wpdb->prefix . 'sosprescription_medications';

        return [
            $prescriptions => "CREATE TABLE IF NOT EXISTS `{$prescriptions}` (
                `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                `uid` VARCHAR(64) NOT NULL,
                `patient_user_id` BIGINT UNSIGNED NOT NULL,
                `doctor_user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
                `status` VARCHAR(32) NOT NULL DEFAULT 'pending',
                `flow` VARCHAR(32) NOT NULL DEFAULT 'renewal',
                `priority` VARCHAR(32) NOT NULL DEFAULT 'standard',
                `client_request_id` VARCHAR(128) NULL DEFAULT NULL,
                `payload_json` LONGTEXT NULL,
                `decision_reason` TEXT NULL,
                `verify_token` VARCHAR(128) NULL DEFAULT NULL,
                `verify_code` VARCHAR(64) NULL DEFAULT NULL,
                `last_activity_at` DATETIME NULL DEFAULT NULL,
                `created_at` DATETIME NOT NULL,
                `updated_at` DATETIME NOT NULL,
                `decided_at` DATETIME NULL DEFAULT NULL,
                PRIMARY KEY (`id`),
                UNIQUE KEY `uq_uid` (`uid`),
                KEY `idx_status_updated_at` (`status`, `updated_at`),
                KEY `idx_doctor_status` (`doctor_user_id`, `status`),
                KEY `idx_verify_token` (`verify_token`)
            ) ENGINE=InnoDB {$charset_collate}",

            $items => "CREATE TABLE IF NOT EXISTS `{$items}` (
                `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                `prescription_id` BIGINT UNSIGNED NOT NULL,
                `line_no` INT UNSIGNED NOT NULL DEFAULT 1,
                `cis` BIGINT UNSIGNED NULL DEFAULT NULL,
                `cip13` VARCHAR(32) NULL DEFAULT NULL,
                `denomination` VARCHAR(255) NOT NULL,
                `posologie` TEXT NULL,
                `quantite` VARCHAR(255) NULL DEFAULT NULL,
                `item_json` LONGTEXT NULL,
                PRIMARY KEY (`id`),
                KEY `idx_prescription_line` (`prescription_id`, `line_no`),
                KEY `idx_cis` (`cis`),
                KEY `idx_cip13` (`cip13`)
            ) ENGINE=InnoDB {$charset_collate}",

            $messages => "CREATE TABLE IF NOT EXISTS `{$messages}` (
                `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                `prescription_id` BIGINT UNSIGNED NOT NULL,
                `author_role` VARCHAR(32) NOT NULL,
                `author_user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
                `body` LONGTEXT NOT NULL,
                `attachments_json` LONGTEXT NULL,
                `created_at` DATETIME NOT NULL,
                PRIMARY KEY (`id`),
                KEY `idx_prescription_created` (`prescription_id`, `created_at`)
            ) ENGINE=InnoDB {$charset_collate}",

            $files => "CREATE TABLE IF NOT EXISTS `{$files}` (
                `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                `owner_user_id` BIGINT UNSIGNED NOT NULL,
                `prescription_id` BIGINT UNSIGNED NULL DEFAULT NULL,
                `purpose` VARCHAR(64) NOT NULL,
                `mime` VARCHAR(191) NOT NULL,
                `original_name` VARCHAR(255) NOT NULL,
                `storage_key` VARCHAR(1024) NOT NULL,
                `size_bytes` BIGINT UNSIGNED NOT NULL DEFAULT 0,
                `created_at` DATETIME NOT NULL,
                PRIMARY KEY (`id`),
                KEY `idx_owner_purpose` (`owner_user_id`, `purpose`),
                KEY `idx_prescription_purpose` (`prescription_id`, `purpose`)
            ) ENGINE=InnoDB {$charset_collate}",

            $audit => "CREATE TABLE IF NOT EXISTS `{$audit}` (
                `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                `event_at` DATETIME NOT NULL,
                `actor_user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
                `actor_role` VARCHAR(64) NULL DEFAULT NULL,
                `actor_ip` VARCHAR(64) NULL DEFAULT NULL,
                `actor_user_agent` VARCHAR(255) NULL DEFAULT NULL,
                `action` VARCHAR(128) NOT NULL,
                `object_type` VARCHAR(64) NOT NULL,
                `object_id` BIGINT UNSIGNED NULL DEFAULT NULL,
                `prescription_id` BIGINT UNSIGNED NULL DEFAULT NULL,
                `meta_json` LONGTEXT NULL,
                PRIMARY KEY (`id`),
                KEY `idx_event_at` (`event_at`),
                KEY `idx_prescription_id` (`prescription_id`),
                KEY `idx_action` (`action`)
            ) ENGINE=InnoDB {$charset_collate}",

            $auditLog => "CREATE TABLE IF NOT EXISTS `{$auditLog}` (
                `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                `event_at` DATETIME NOT NULL,
                `actor_user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
                `actor_role` VARCHAR(64) NULL DEFAULT NULL,
                `actor_ip` VARCHAR(64) NULL DEFAULT NULL,
                `actor_user_agent` VARCHAR(255) NULL DEFAULT NULL,
                `action` VARCHAR(128) NOT NULL,
                `object_type` VARCHAR(64) NOT NULL,
                `object_id` BIGINT UNSIGNED NULL DEFAULT NULL,
                `prescription_id` BIGINT UNSIGNED NULL DEFAULT NULL,
                `meta_json` LONGTEXT NULL,
                PRIMARY KEY (`id`),
                KEY `idx_event_at` (`event_at`),
                KEY `idx_prescription_id` (`prescription_id`),
                KEY `idx_action` (`action`)
            ) ENGINE=InnoDB {$charset_collate}",

            $jobs => "CREATE TABLE IF NOT EXISTS `{$jobs}` (
                `job_id` CHAR(36) NOT NULL,
                `site_id` VARCHAR(64) NOT NULL,
                `req_id` VARCHAR(32) DEFAULT NULL,
                `job_type` VARCHAR(32) NOT NULL,
                `status` ENUM('PENDING','CLAIMED','DONE','FAILED') NOT NULL DEFAULT 'PENDING',
                `priority` SMALLINT NOT NULL DEFAULT 50,
                `available_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
                `rx_id` BIGINT UNSIGNED NOT NULL DEFAULT 0,
                `nonce` VARCHAR(64) NOT NULL,
                `kid` VARCHAR(32) DEFAULT NULL,
                `exp_ms` BIGINT UNSIGNED NOT NULL DEFAULT 0,
                `payload` LONGTEXT NOT NULL,
                `payload_sha256` BINARY(32) DEFAULT NULL,
                `mls1_token` LONGTEXT NOT NULL,
                `s3_key_ref` VARCHAR(1024) DEFAULT NULL,
                `s3_bucket` VARCHAR(255) DEFAULT NULL,
                `s3_region` VARCHAR(64) DEFAULT NULL,
                `artifact_sha256` BINARY(32) DEFAULT NULL,
                `artifact_size_bytes` BIGINT UNSIGNED DEFAULT NULL,
                `artifact_content_type` VARCHAR(128) DEFAULT NULL,
                `attempts` INT UNSIGNED NOT NULL DEFAULT 0,
                `max_attempts` INT UNSIGNED NOT NULL DEFAULT 5,
                `locked_at` DATETIME(3) DEFAULT NULL,
                `lock_expires_at` DATETIME(3) DEFAULT NULL,
                `locked_by` VARCHAR(128) DEFAULT NULL,
                `worker_ref` VARCHAR(128) DEFAULT NULL,
                `last_error_code` VARCHAR(64) DEFAULT NULL,
                `last_error_message_safe` VARCHAR(255) DEFAULT NULL,
                `last_error_at` DATETIME(3) DEFAULT NULL,
                `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
                `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
                `completed_at` DATETIME(3) DEFAULT NULL,
                PRIMARY KEY (`job_id`),
                UNIQUE KEY `uq_site_nonce` (`site_id`, `nonce`),
                KEY `idx_poll` (`status`, `available_at`, `priority`, `created_at`),
                KEY `idx_rx_status` (`rx_id`, `status`, `created_at`),
                KEY `idx_req_id` (`req_id`),
                KEY `idx_lock_exp` (`status`, `lock_expires_at`),
                KEY `idx_site_created` (`site_id`, `created_at`)
            ) ENGINE=InnoDB {$charset_collate}",

            $nonces => "CREATE TABLE IF NOT EXISTS `{$nonces}` (
                `site_id` VARCHAR(64) NOT NULL,
                `scope` VARCHAR(64) NOT NULL,
                `nonce` VARCHAR(64) NOT NULL,
                `ts_ms` BIGINT UNSIGNED NOT NULL,
                `expires_at` DATETIME(3) NOT NULL,
                `req_id` VARCHAR(32) DEFAULT NULL,
                `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
                PRIMARY KEY (`site_id`, `scope`, `nonce`),
                KEY `idx_expires_at` (`expires_at`)
            ) ENGINE=InnoDB {$charset_collate}",

            $cis => "CREATE TABLE IF NOT EXISTS `{$cis}` (
                `cis` BIGINT UNSIGNED NOT NULL,
                `denomination` VARCHAR(255) NOT NULL,
                `forme_pharmaceutique` VARCHAR(255) NULL DEFAULT NULL,
                `voie_administration` VARCHAR(255) NULL DEFAULT NULL,
                `statut_admin` VARCHAR(255) NULL DEFAULT NULL,
                `type_procedure` VARCHAR(255) NULL DEFAULT NULL,
                `etat_commercialisation` VARCHAR(255) NULL DEFAULT NULL,
                `date_amm` VARCHAR(32) NULL DEFAULT NULL,
                `statut_bdm` VARCHAR(255) NULL DEFAULT NULL,
                `num_autorisation` VARCHAR(255) NULL DEFAULT NULL,
                `titulaires` LONGTEXT NULL,
                `surveillance_renforcee` VARCHAR(16) NULL DEFAULT NULL,
                `row_hash` CHAR(64) NULL DEFAULT NULL,
                PRIMARY KEY (`cis`),
                KEY `idx_denomination` (`denomination`)
            ) ENGINE=InnoDB {$charset_collate}",

            $cip => "CREATE TABLE IF NOT EXISTS `{$cip}` (
                `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                `cis` BIGINT UNSIGNED NOT NULL,
                `cip7` VARCHAR(32) NULL DEFAULT NULL,
                `cip13` VARCHAR(32) NULL DEFAULT NULL,
                `libelle_presentation` VARCHAR(255) NULL DEFAULT NULL,
                `statut_admin` VARCHAR(255) NULL DEFAULT NULL,
                `date_declaration` VARCHAR(32) NULL DEFAULT NULL,
                `date_commercialisation` VARCHAR(32) NULL DEFAULT NULL,
                `agrement_collectivites` VARCHAR(255) NULL DEFAULT NULL,
                `taux_remboursement` VARCHAR(64) NULL DEFAULT NULL,
                `prix_ttc` VARCHAR(64) NULL DEFAULT NULL,
                `prix_honoraires` VARCHAR(64) NULL DEFAULT NULL,
                `row_hash` CHAR(64) NULL DEFAULT NULL,
                PRIMARY KEY (`id`),
                UNIQUE KEY `uq_cip13` (`cip13`),
                KEY `idx_cis` (`cis`),
                KEY `idx_cip7` (`cip7`)
            ) ENGINE=InnoDB {$charset_collate}",

            $mitm => "CREATE TABLE IF NOT EXISTS `{$mitm}` (
                `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                `cis` BIGINT UNSIGNED NOT NULL,
                `code_atc` VARCHAR(32) NOT NULL,
                `libelle_atc` VARCHAR(255) NULL DEFAULT NULL,
                `row_hash` CHAR(64) NULL DEFAULT NULL,
                PRIMARY KEY (`id`),
                UNIQUE KEY `uq_cis_atc` (`cis`, `code_atc`),
                KEY `idx_code_atc` (`code_atc`)
            ) ENGINE=InnoDB {$charset_collate}",

            $medications => "CREATE TABLE IF NOT EXISTS `{$medications}` (
                `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                `cis` BIGINT UNSIGNED NULL DEFAULT NULL,
                `cip13` VARCHAR(32) NULL DEFAULT NULL,
                `label` VARCHAR(255) NOT NULL,
                `search_text` LONGTEXT NULL,
                `created_at` DATETIME NULL DEFAULT NULL,
                PRIMARY KEY (`id`),
                KEY `idx_cis` (`cis`),
                KEY `idx_cip13` (`cip13`)
            ) ENGINE=InnoDB {$charset_collate}",
        ];
    }

    protected static function ensure_jobs_table(\wpdb $wpdb)
    {
        self::force_schema_integrity($wpdb);
    }

    protected static function ensure_jobs_columns(\wpdb $wpdb)
    {
        return;
    }

    protected static function ensure_jobs_indexes(\wpdb $wpdb)
    {
        return;
    }

    protected static function ensure_prescription_indexes(\wpdb $wpdb)
    {
        $table = $wpdb->prefix . 'sosprescription_prescriptions';

        if (!self::table_exists($wpdb, $table)) {
            return;
        }

        $verify_token_column = '';
        if (self::column_exists($wpdb, $table, 'verify_token')) {
            $verify_token_column = 'verify_token';
        } elseif (self::column_exists($wpdb, $table, 'verification_token')) {
            $verify_token_column = 'verification_token';
        }

        if ($verify_token_column && !self::index_exists($wpdb, $table, 'idx_verify_token')) {
            $wpdb->query("ALTER TABLE `{$table}` ADD KEY `idx_verify_token` (`{$verify_token_column}`)");
        }

        $has_status = self::column_exists($wpdb, $table, 'status');
        $has_updated_at = self::column_exists($wpdb, $table, 'updated_at');

        if ($has_status && $has_updated_at && !self::index_exists($wpdb, $table, 'idx_status_updated_at')) {
            $wpdb->query("ALTER TABLE `{$table}` ADD KEY `idx_status_updated_at` (`status`, `updated_at`)");
        }
    }

    protected static function table_exists(\wpdb $wpdb, $table_name)
    {
        $sql = $wpdb->prepare('SHOW TABLES LIKE %s', $table_name);

        return (string) $wpdb->get_var($sql) === (string) $table_name;
    }

    protected static function column_exists(\wpdb $wpdb, $table_name, $column_name)
    {
        $sql = $wpdb->prepare("SHOW COLUMNS FROM `{$table_name}` LIKE %s", $column_name);

        return !empty($wpdb->get_row($sql, ARRAY_A));
    }

    protected static function index_exists(\wpdb $wpdb, $table_name, $index_name)
    {
        $sql = $wpdb->prepare("SHOW INDEX FROM `{$table_name}` WHERE Key_name = %s", $index_name);

        return !empty($wpdb->get_row($sql, ARRAY_A));
    }
}
