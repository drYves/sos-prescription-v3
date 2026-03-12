<?php
declare(strict_types=1);

namespace SOSPrescription;

final class Install
{
    public static function activate(): void
    {
        global $wpdb;
        $charsetCollate = $wpdb->get_charset_collate();
        require_once ABSPATH . 'wp-admin/includes/upgrade.php';

        $jobsTable = $wpdb->prefix . 'sosprescription_jobs';
        $noncesTable = $wpdb->prefix . 'sosprescription_nonces';

        $sqlJobs = "CREATE TABLE {$jobsTable} (
            job_id CHAR(36) NOT NULL,
            site_id VARCHAR(64) NOT NULL,
            req_id VARCHAR(32) DEFAULT NULL,
            job_type VARCHAR(32) NOT NULL,
            status ENUM('PENDING','CLAIMED','DONE','FAILED') NOT NULL DEFAULT 'PENDING',
            priority SMALLINT NOT NULL DEFAULT 50,
            available_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            rx_id BIGINT UNSIGNED NOT NULL,
            nonce VARCHAR(64) NOT NULL,
            kid VARCHAR(32) DEFAULT NULL,
            exp_ms BIGINT UNSIGNED NOT NULL,
            payload JSON NOT NULL,
            payload_sha256 BINARY(32) NOT NULL,
            mls1_token LONGTEXT NOT NULL,
            s3_key_ref VARCHAR(1024) DEFAULT NULL,
            artifact_sha256 BINARY(32) DEFAULT NULL,
            artifact_size_bytes BIGINT UNSIGNED DEFAULT NULL,
            artifact_content_type VARCHAR(128) DEFAULT NULL,
            attempts INT UNSIGNED NOT NULL DEFAULT 0,
            max_attempts INT UNSIGNED NOT NULL DEFAULT 5,
            locked_at DATETIME(3) DEFAULT NULL,
            lock_expires_at DATETIME(3) DEFAULT NULL,
            locked_by VARCHAR(128) DEFAULT NULL,
            last_error_code VARCHAR(64) DEFAULT NULL,
            last_error_message_safe VARCHAR(255) DEFAULT NULL,
            last_error_at DATETIME(3) DEFAULT NULL,
            created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
            completed_at DATETIME(3) DEFAULT NULL,
            PRIMARY KEY  (job_id),
            UNIQUE KEY uq_site_nonce (site_id, nonce),
            UNIQUE KEY uq_site_type_payloadhash (site_id, job_type, payload_sha256),
            KEY idx_poll (status, available_at, priority, created_at),
            KEY idx_rx_status (rx_id, status, created_at),
            KEY idx_req_id (req_id),
            KEY idx_lock_exp (status, lock_expires_at),
            KEY idx_site_created (site_id, created_at)
        ) {$charsetCollate};";
        dbDelta($sqlJobs);

        $sqlNonces = "CREATE TABLE {$noncesTable} (
            site_id VARCHAR(64) NOT NULL,
            scope VARCHAR(64) NOT NULL,
            nonce VARCHAR(64) NOT NULL,
            ts_ms BIGINT UNSIGNED NOT NULL,
            expires_at DATETIME(3) NOT NULL,
            req_id VARCHAR(32) DEFAULT NULL,
            created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            PRIMARY KEY  (site_id, scope, nonce),
            KEY idx_expires_at (expires_at)
        ) {$charsetCollate};";
        dbDelta($sqlNonces);

        self::enforceJobsSchema($wpdb, $jobsTable);
    }

    private static function enforceJobsSchema(\wpdb $wpdb, string $jobsTable): void
    {
        $wpdb->query("ALTER TABLE `{$jobsTable}` MODIFY COLUMN `status` ENUM('PENDING','CLAIMED','DONE','FAILED') NOT NULL DEFAULT 'PENDING'");

        self::ensureIndex($wpdb, $jobsTable, 'uq_site_nonce', 'UNIQUE', ['site_id', 'nonce']);
        self::ensureIndex($wpdb, $jobsTable, 'uq_site_type_payloadhash', 'UNIQUE', ['site_id', 'job_type', 'payload_sha256']);
        self::ensureIndex($wpdb, $jobsTable, 'idx_poll', 'KEY', ['status', 'available_at', 'priority', 'created_at']);
        self::ensureIndex($wpdb, $jobsTable, 'idx_rx_status', 'KEY', ['rx_id', 'status', 'created_at']);
        self::ensureIndex($wpdb, $jobsTable, 'idx_req_id', 'KEY', ['req_id']);
        self::ensureIndex($wpdb, $jobsTable, 'idx_lock_exp', 'KEY', ['status', 'lock_expires_at']);
        self::ensureIndex($wpdb, $jobsTable, 'idx_site_created', 'KEY', ['site_id', 'created_at']);
    }

    private static function ensureIndex(\wpdb $wpdb, string $table, string $indexName, string $kind, array $columns): void
    {
        $exists = $wpdb->get_var($wpdb->prepare(
            "SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s AND INDEX_NAME = %s LIMIT 1",
            $table,
            $indexName
        ));

        if ($exists) {
            return;
        }

        $cols = implode(', ', array_map(static fn(string $c): string => "`{$c}`", $columns));
        if ($kind === 'UNIQUE') {
            $wpdb->query("ALTER TABLE `{$table}` ADD UNIQUE KEY `{$indexName}` ({$cols})");
            return;
        }

        $wpdb->query("ALTER TABLE `{$table}` ADD KEY `{$indexName}` ({$cols})");
    }
}
