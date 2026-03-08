<?php
declare(strict_types=1);

namespace SosPrescription;

final class Install
{
    public static function activate(): void
    {
        global $wpdb;
        $charset_collate = $wpdb->get_charset_collate();
        require_once(ABSPATH . 'wp-admin/includes/upgrade.php');

        // 1. Table des Jobs (Queue)
        $table_jobs = $wpdb->prefix . 'sosprescription_jobs';
        $sql_jobs = "CREATE TABLE `{$table_jobs}` (
            `job_id` CHAR(36) NOT NULL,
            `site_id` VARCHAR(64) NOT NULL,
            `req_id` VARCHAR(32) DEFAULT NULL,
            `job_type` VARCHAR(32) NOT NULL,
            `status` VARCHAR(32) NOT NULL DEFAULT 'PENDING',
            `priority` SMALLINT NOT NULL DEFAULT 50,
            `available_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            `rx_id` BIGINT UNSIGNED NOT NULL,
            `nonce` VARCHAR(64) NOT NULL,
            `kid` VARCHAR(32) DEFAULT NULL,
            `exp_ms` BIGINT UNSIGNED NOT NULL,
            `payload` JSON NOT NULL,
            `payload_sha256` BINARY(32) NOT NULL,
            `mls1_token` TEXT NOT NULL,
            `s3_key_ref` VARCHAR(1024) DEFAULT NULL,
            `artifact_sha256` BINARY(32) DEFAULT NULL,
            `artifact_size_bytes` BIGINT UNSIGNED DEFAULT NULL,
            `artifact_content_type` VARCHAR(128) DEFAULT NULL,
            `attempts` INT UNSIGNED NOT NULL DEFAULT 0,
            `max_attempts` INT UNSIGNED NOT NULL DEFAULT 5,
            `locked_at` DATETIME(3) DEFAULT NULL,
            `lock_expires_at` DATETIME(3) DEFAULT NULL,
            `locked_by` VARCHAR(128) DEFAULT NULL,
            `last_error_code` VARCHAR(64) DEFAULT NULL,
            `last_error_message_safe` VARCHAR(255) DEFAULT NULL,
            `last_error_at` DATETIME(3) DEFAULT NULL,
            `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
            `completed_at` DATETIME(3) DEFAULT NULL,
            PRIMARY KEY (`job_id`),
            UNIQUE KEY `uq_site_nonce` (`site_id`, `nonce`),
            KEY `idx_poll` (`status`, `available_at`, `priority`, `created_at`)
        ) $charset_collate;";
        dbDelta($sql_jobs);

        // 2. Table des Nonces (Anti-Replay)
        $table_nonces = $wpdb->prefix . 'sosprescription_nonces';
        $sql_nonces = "CREATE TABLE `{$table_nonces}` (
            `site_id` VARCHAR(64) NOT NULL,
            `scope` VARCHAR(64) NOT NULL,
            `nonce` VARCHAR(64) NOT NULL,
            `ts_ms` BIGINT UNSIGNED NOT NULL,
            `expires_at` DATETIME(3) NOT NULL,
            `req_id` VARCHAR(32) DEFAULT NULL,
            `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            PRIMARY KEY (`site_id`, `scope`, `nonce`),
            KEY `idx_expires_at` (`expires_at`)
        ) $charset_collate;";
        dbDelta($sql_nonces);
    }
}
