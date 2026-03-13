<?php
// includes/Repositories/AuditRepository.php
declare(strict_types=1);

namespace SOSPrescription\Repositories;

use SOSPrescription\Services\Audit;

final class AuditRepository
{
    private static ?string $resolvedTable = null;

    /**
     * Insert an audit log row.
     *
     * @param array<string, mixed> $data
     */
    public function insert(array $data): bool
    {
        $wpdb = $this->wpdb();
        if (!$wpdb) {
            $this->failsafe('audit_insert_skipped_no_wpdb', []);
            return false;
        }

        $table = $this->resolveTable($wpdb);
        if ($table === null) {
            $this->failsafe('audit_insert_skipped_missing_table', [
                'candidates' => [
                    $wpdb->prefix . 'sosprescription_audit',
                    $wpdb->prefix . 'sosprescription_audit_log',
                ],
            ]);
            return false;
        }

        $row = [
            'event_at' => isset($data['event_at']) && is_string($data['event_at']) && $data['event_at'] !== ''
                ? (string) $data['event_at']
                : (function_exists('current_time') ? (string) current_time('mysql') : gmdate('Y-m-d H:i:s')),

            'actor_user_id' => array_key_exists('actor_user_id', $data) ? $this->nullablePositiveInt($data['actor_user_id']) : null,
            'actor_role' => array_key_exists('actor_role', $data) ? $this->nullableString($data['actor_role']) : null,
            'actor_ip' => array_key_exists('actor_ip', $data) ? $this->nullableString($data['actor_ip']) : null,
            'actor_user_agent' => array_key_exists('actor_user_agent', $data) ? $this->nullableString($data['actor_user_agent']) : null,
            'action' => trim((string) ($data['action'] ?? '')),
            'object_type' => trim((string) ($data['object_type'] ?? '')),
            'object_id' => array_key_exists('object_id', $data) ? $this->nullablePositiveInt($data['object_id']) : null,
            'prescription_id' => array_key_exists('prescription_id', $data) ? $this->nullablePositiveInt($data['prescription_id']) : null,
            'meta_json' => array_key_exists('meta_json', $data) ? $this->nullableString($data['meta_json']) : null,
        ];

        if ($row['action'] === '' || $row['object_type'] === '') {
            return false;
        }

        try {
            // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
            $ok = $wpdb->insert($table, $row);

            if ($ok === false || (string) $wpdb->last_error !== '') {
                $this->failsafe('audit_insert_failed', [
                    'table' => $table,
                    'action' => $row['action'],
                    'object_type' => $row['object_type'],
                    'last_error' => (string) $wpdb->last_error,
                ]);
                return false;
            }

            return true;
        } catch (\Throwable $e) {
            $this->failsafe('audit_insert_exception', [
                'table' => $table,
                'action' => $row['action'],
                'object_type' => $row['object_type'],
                'message' => $e->getMessage(),
                'file' => $e->getFile(),
                'line' => $e->getLine(),
            ]);
            return false;
        }
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public function list(array $filters, int $limit, int $offset): array
    {
        $wpdb = $this->wpdb();
        if (!$wpdb) {
            $this->failsafe('audit_list_skipped_no_wpdb', []);
            return [];
        }

        $table = $this->resolveTable($wpdb);
        if ($table === null) {
            $this->failsafe('audit_list_skipped_missing_table', []);
            return [];
        }

        $where = [];
        $params = [];

        if (isset($filters['prescription_id']) && is_numeric($filters['prescription_id'])) {
            $where[] = 'prescription_id = %d';
            $params[] = (int) $filters['prescription_id'];
        }

        if (isset($filters['actor_user_id']) && is_numeric($filters['actor_user_id'])) {
            $where[] = 'actor_user_id = %d';
            $params[] = (int) $filters['actor_user_id'];
        }

        if (isset($filters['action']) && is_string($filters['action']) && trim($filters['action']) !== '') {
            $where[] = 'action = %s';
            $params[] = trim((string) $filters['action']);
        }

        if (isset($filters['since']) && is_string($filters['since']) && trim($filters['since']) !== '') {
            $where[] = 'event_at >= %s';
            $params[] = trim((string) $filters['since']);
        }

        if (isset($filters['until']) && is_string($filters['until']) && trim($filters['until']) !== '') {
            $where[] = 'event_at <= %s';
            $params[] = trim((string) $filters['until']);
        }

        $whereSql = count($where) ? ('WHERE ' . implode(' AND ', $where)) : '';
        $limit = max(1, min(500, (int) $limit));
        $offset = max(0, (int) $offset);

        $sql = "SELECT id, event_at, actor_user_id, actor_role, actor_ip, actor_user_agent,
                       action, object_type, object_id, prescription_id, meta_json
                FROM {$table}
                {$whereSql}
                ORDER BY event_at DESC, id DESC
                LIMIT %d OFFSET %d";

        $params[] = $limit;
        $params[] = $offset;

        try {
            // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
            $prepared = $wpdb->prepare($sql, $params);
            // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
            $rows = $wpdb->get_results($prepared, ARRAY_A);

            if ((string) $wpdb->last_error !== '') {
                $this->failsafe('audit_list_failed', [
                    'table' => $table,
                    'last_error' => (string) $wpdb->last_error,
                ]);
                return [];
            }

            return is_array($rows) ? $rows : [];
        } catch (\Throwable $e) {
            $this->failsafe('audit_list_exception', [
                'table' => $table,
                'message' => $e->getMessage(),
                'file' => $e->getFile(),
                'line' => $e->getLine(),
            ]);
            return [];
        }
    }

    public function purge_older_than_days(int $days): int
    {
        $wpdb = $this->wpdb();
        if (!$wpdb) {
            $this->failsafe('audit_purge_skipped_no_wpdb', []);
            return 0;
        }

        $table = $this->resolveTable($wpdb);
        if ($table === null) {
            $this->failsafe('audit_purge_skipped_missing_table', []);
            return 0;
        }

        $days = max(1, (int) $days);

        try {
            // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
            $sql = $wpdb->prepare(
                "DELETE FROM {$table} WHERE event_at < DATE_SUB(NOW(), INTERVAL %d DAY)",
                $days
            );

            // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
            $res = $wpdb->query($sql);

            if ($res === false || (string) $wpdb->last_error !== '') {
                $this->failsafe('audit_purge_failed', [
                    'table' => $table,
                    'days' => $days,
                    'last_error' => (string) $wpdb->last_error,
                ]);
                return 0;
            }

            return is_int($res) ? $res : 0;
        } catch (\Throwable $e) {
            $this->failsafe('audit_purge_exception', [
                'table' => $table,
                'days' => $days,
                'message' => $e->getMessage(),
                'file' => $e->getFile(),
                'line' => $e->getLine(),
            ]);
            return 0;
        }
    }

    private function wpdb(): ?\wpdb
    {
        global $wpdb;

        return $wpdb instanceof \wpdb ? $wpdb : null;
    }

    private function resolveTable(\wpdb $wpdb): ?string
    {
        if (self::$resolvedTable !== null && $this->tableExists($wpdb, self::$resolvedTable)) {
            return self::$resolvedTable;
        }

        $candidates = [
            $wpdb->prefix . 'sosprescription_audit',
            $wpdb->prefix . 'sosprescription_audit_log',
        ];

        foreach ($candidates as $table) {
            if ($this->tableExists($wpdb, $table)) {
                self::$resolvedTable = $table;
                return $table;
            }
        }

        return null;
    }

    private function tableExists(\wpdb $wpdb, string $table): bool
    {
        static $cache = [];

        if (array_key_exists($table, $cache)) {
            return (bool) $cache[$table];
        }

        $sql = $wpdb->prepare('SHOW TABLES LIKE %s', $table);
        $exists = (string) $wpdb->get_var($sql) === $table;

        $cache[$table] = $exists;
        return $exists;
    }

    /**
     * @param mixed $value
     */
    private function nullablePositiveInt($value): ?int
    {
        if ($value === null || $value === '') {
            return null;
        }

        $int = (int) $value;
        return $int > 0 ? $int : null;
    }

    /**
     * @param mixed $value
     */
    private function nullableString($value): ?string
    {
        if ($value === null) {
            return null;
        }

        $string = trim((string) $value);
        return $string !== '' ? $string : null;
    }

    /**
     * @param array<string, mixed> $context
     */
    private function failsafe(string $message, array $context = []): void
    {
        Audit::write_failsafe_log($message, $context, 'audit_repository');
    }
}
