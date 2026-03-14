<?php
// includes/Installer.php

namespace SOSPrescription;

defined('ABSPATH') || exit;

final class Installer
{
    const DB_VERSION = '2.2.0';

    public static function activate()
    {
        self::install();
    }

    public static function maybe_upgrade()
    {
        $installed = (string) \get_option('sosprescription_db_version', '');
        if ($installed !== self::DB_VERSION) {
            self::install();
        }
    }

    public static function install()
    {
        global $wpdb;

        if (!($wpdb instanceof \wpdb)) {
            return;
        }

        self::ensure_jobs_table($wpdb);
        self::ensure_jobs_columns($wpdb);
        self::ensure_jobs_indexes($wpdb);
        self::ensure_prescription_indexes($wpdb);

        \update_option('sosprescription_db_version', self::DB_VERSION, false);
        \update_option('sosprescription_plugin_version', self::DB_VERSION, false);

        \do_action('sosprescription_installed', self::DB_VERSION);
    }

    public static function jobs_table_name()
    {
        global $wpdb;

        return $wpdb->prefix . 'sosprescription_jobs';
    }

    protected static function ensure_jobs_table(\wpdb $wpdb)
    {
        $table = self::jobs_table_name();

        if (self::table_exists($wpdb, $table)) {
            return;
        }

        $charset_collate = $wpdb->get_charset_collate();

        $sql = "CREATE TABLE `{$table}` (
            `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
            `site_id` varchar(64) NOT NULL,
            `job_type` varchar(32) NOT NULL,
            `payload` JSON NOT NULL,
            `payload_sha256` BINARY(32) NOT NULL,
            `mls1_token` longtext NOT NULL,
            `nonce` varchar(80) NOT NULL,
            `kid` varchar(64) NOT NULL,
            `exp_ms` bigint(20) unsigned NOT NULL,
            `status` varchar(16) NOT NULL DEFAULT 'PENDING',
            `priority` smallint(5) unsigned NOT NULL DEFAULT 100,
            `attempts` smallint(5) unsigned NOT NULL DEFAULT 0,
            `max_attempts` smallint(5) unsigned NOT NULL DEFAULT 6,
            `locked_at` datetime NULL DEFAULT NULL,
            `lock_expires_at` datetime NULL DEFAULT NULL,
            `locked_by` varchar(191) NOT NULL DEFAULT '',
            `available_at` datetime NOT NULL,
            `started_at` datetime NULL DEFAULT NULL,
            `finished_at` datetime NULL DEFAULT NULL,
            `last_error_code` varchar(80) NOT NULL DEFAULT '',
            `last_error_message` longtext NULL,
            `rx_id` bigint(20) unsigned NOT NULL DEFAULT 0,
            `s3_key_ref` varchar(255) NOT NULL DEFAULT '',
            `s3_bucket` varchar(191) NOT NULL DEFAULT '',
            `s3_region` varchar(64) NOT NULL DEFAULT '',
            `artifact_sha256` char(64) NOT NULL DEFAULT '',
            `artifact_size` bigint(20) unsigned NOT NULL DEFAULT 0,
            `worker_ref` varchar(191) NOT NULL DEFAULT '',
            `req_id` varchar(64) NOT NULL DEFAULT '',
            `created_by` bigint(20) unsigned NOT NULL DEFAULT 0,
            `created_at` datetime NOT NULL,
            `updated_at` datetime NOT NULL,
            PRIMARY KEY (`id`),
            UNIQUE KEY `uq_site_nonce` (`site_id`, `nonce`),
            UNIQUE KEY `uq_site_type_payloadhash` (`site_id`, `job_type`, `payload_sha256`),
            KEY `idx_status_available_priority` (`status`, `available_at`, `priority`, `id`),
            KEY `idx_rx_status_id` (`rx_id`, `status`, `id`),
            KEY `idx_lock_expires_at` (`lock_expires_at`),
            KEY `idx_s3_key_ref` (`s3_key_ref`)
        ) ENGINE=InnoDB {$charset_collate};";

        $wpdb->query($sql);
    }

    protected static function ensure_jobs_columns(\wpdb $wpdb)
    {
        $table = self::jobs_table_name();

        if (!self::table_exists($wpdb, $table)) {
            return;
        }

        $columns = array(
            'site_id'            => "varchar(64) NOT NULL DEFAULT ''",
            'job_type'           => "varchar(32) NOT NULL DEFAULT ''",
            'payload'            => "JSON NULL",
            'payload_sha256'     => "BINARY(32) NULL",
            'mls1_token'         => "longtext NOT NULL",
            'nonce'              => "varchar(80) NOT NULL DEFAULT ''",
            'kid'                => "varchar(64) NOT NULL DEFAULT ''",
            'exp_ms'             => "bigint(20) unsigned NOT NULL DEFAULT 0",
            'status'             => "varchar(16) NOT NULL DEFAULT 'PENDING'",
            'priority'           => "smallint(5) unsigned NOT NULL DEFAULT 100",
            'attempts'           => "smallint(5) unsigned NOT NULL DEFAULT 0",
            'max_attempts'       => "smallint(5) unsigned NOT NULL DEFAULT 6",
            'locked_at'          => "datetime NULL DEFAULT NULL",
            'lock_expires_at'    => "datetime NULL DEFAULT NULL",
            'locked_by'          => "varchar(191) NOT NULL DEFAULT ''",
            'available_at'       => "datetime NOT NULL DEFAULT '1970-01-01 00:00:00'",
            'started_at'         => "datetime NULL DEFAULT NULL",
            'finished_at'        => "datetime NULL DEFAULT NULL",
            'last_error_code'    => "varchar(80) NOT NULL DEFAULT ''",
            'last_error_message' => "longtext NULL",
            'rx_id'              => "bigint(20) unsigned NOT NULL DEFAULT 0",
            's3_key_ref'         => "varchar(255) NOT NULL DEFAULT ''",
            's3_bucket'          => "varchar(191) NOT NULL DEFAULT ''",
            's3_region'          => "varchar(64) NOT NULL DEFAULT ''",
            'artifact_sha256'    => "char(64) NOT NULL DEFAULT ''",
            'artifact_size'      => "bigint(20) unsigned NOT NULL DEFAULT 0",
            'worker_ref'         => "varchar(191) NOT NULL DEFAULT ''",
            'req_id'             => "varchar(64) NOT NULL DEFAULT ''",
            'created_by'         => "bigint(20) unsigned NOT NULL DEFAULT 0",
            'created_at'         => "datetime NOT NULL DEFAULT '1970-01-01 00:00:00'",
            'updated_at'         => "datetime NOT NULL DEFAULT '1970-01-01 00:00:00'",
        );

        foreach ($columns as $column_name => $definition) {
            if (!self::column_exists($wpdb, $table, $column_name)) {
                $wpdb->query("ALTER TABLE `{$table}` ADD COLUMN `{$column_name}` {$definition}");
            }
        }
    }

    protected static function ensure_jobs_indexes(\wpdb $wpdb)
    {
        $table = self::jobs_table_name();

        if (!self::table_exists($wpdb, $table)) {
            return;
        }

        $indexes = array(
            'uq_site_nonce' => "ALTER TABLE `{$table}` ADD UNIQUE KEY `uq_site_nonce` (`site_id`, `nonce`)",
            'uq_site_type_payloadhash' => "ALTER TABLE `{$table}` ADD UNIQUE KEY `uq_site_type_payloadhash` (`site_id`, `job_type`, `payload_sha256`)",
            'idx_status_available_priority' => "ALTER TABLE `{$table}` ADD KEY `idx_status_available_priority` (`status`, `available_at`, `priority`, `id`)",
            'idx_rx_status_id' => "ALTER TABLE `{$table}` ADD KEY `idx_rx_status_id` (`rx_id`, `status`, `id`)",
            'idx_lock_expires_at' => "ALTER TABLE `{$table}` ADD KEY `idx_lock_expires_at` (`lock_expires_at`)",
            'idx_s3_key_ref' => "ALTER TABLE `{$table}` ADD KEY `idx_s3_key_ref` (`s3_key_ref`)",
        );

        foreach ($indexes as $index_name => $sql) {
            if (!self::index_exists($wpdb, $table, $index_name)) {
                $wpdb->query($sql);
            }
        }
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
