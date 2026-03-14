<?php
declare(strict_types=1);

namespace SOSPrescription\Repositories;

use SOSPrescription\Db;

final class AuditRepository
{
    /**
     * @param array<string, mixed> $data
     */
    public function insert(array $data): bool
    {
        global $wpdb;

        $table = Db::table('audit');

        $row = [
            'event_at' => isset($data['event_at']) && is_string($data['event_at']) && $data['event_at'] !== ''
                ? (string) $data['event_at']
                : current_time('mysql'),
            'actor_user_id' => array_key_exists('actor_user_id', $data) ? $data['actor_user_id'] : null,
            'actor_role' => array_key_exists('actor_role', $data) ? $data['actor_role'] : null,
            'actor_ip' => array_key_exists('actor_ip', $data) ? $data['actor_ip'] : null,
            'actor_user_agent' => array_key_exists('actor_user_agent', $data) ? $data['actor_user_agent'] : null,
            'action' => (string) ($data['action'] ?? ''),
            'object_type' => (string) ($data['object_type'] ?? ''),
            'object_id' => array_key_exists('object_id', $data) ? $data['object_id'] : null,
            'prescription_id' => array_key_exists('prescription_id', $data) ? $data['prescription_id'] : null,
            'meta_json' => array_key_exists('meta_json', $data) ? $data['meta_json'] : null,
        ];

        foreach (['actor_user_id', 'object_id', 'prescription_id'] as $key) {
            if ($row[$key] === null || $row[$key] === '') {
                $row[$key] = null;
                continue;
            }
            $row[$key] = (int) $row[$key];
            if ((int) $row[$key] < 1) {
                $row[$key] = null;
            }
        }

        foreach (['actor_role', 'actor_ip', 'actor_user_agent', 'action', 'object_type'] as $key) {
            if ($row[$key] === null) {
                continue;
            }
            $row[$key] = is_string($row[$key]) ? trim((string) $row[$key]) : (string) $row[$key];
            if ($row[$key] === '') {
                $row[$key] = null;
            }
        }

        if (!isset($row['action']) || !is_string($row['action']) || trim((string) $row['action']) === '') {
            return false;
        }
        if (!isset($row['object_type']) || !is_string($row['object_type']) || trim((string) $row['object_type']) === '') {
            return false;
        }

        $formats = ['%s', '%d', '%s', '%s', '%s', '%s', '%s', '%d', '%d', '%s'];

        return (bool) $wpdb->insert($table, $row, $formats);
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public function list(array $filters, int $limit, int $offset): array
    {
        global $wpdb;

        $table = Db::table('audit');
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

        $prepared = $wpdb->prepare($sql, $params);
        $rows = $wpdb->get_results($prepared, ARRAY_A) ?: [];

        return $rows;
    }

    public function purge_older_than_days(int $days): int
    {
        global $wpdb;

        $days = max(1, (int) $days);
        $table = Db::table('audit');
        $sql = $wpdb->prepare(
            "DELETE FROM {$table} WHERE event_at < DATE_SUB(NOW(), INTERVAL %d DAY)",
            $days
        );
        $res = $wpdb->query($sql);

        return is_int($res) ? $res : 0;
    }
}
