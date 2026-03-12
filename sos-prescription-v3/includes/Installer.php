<?php
// includes/Installer.php

namespace SOSPrescription;

defined('ABSPATH') || exit;

final class Installer
{
    const DB_VERSION = '3.1.8';

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
        $charset_collate = $wpdb->get_charset_collate();
        $existing_table = (string) $wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s', $table));

        if ($existing_table === $table) {
            return;
        }

        $sql = "CREATE TABLE {$table} (
  job_id char(36) NOT NULL,
  site_id varchar(64) NOT NULL,
  job_type varchar(32) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'PENDING',
  payload longtext NOT NULL,
  mls1_token longtext NOT NULL,
  created_at datetime DEFAULT '0000-00-00 00:00:00' NOT NULL,
  PRIMARY KEY  (job_id)
) ENGINE=InnoDB {$charset_collate};";

        require_once ABSPATH . 'wp-admin/includes/upgrade.php';
        \dbDelta($sql);
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
