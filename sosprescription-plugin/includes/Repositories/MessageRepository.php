<?php
declare(strict_types=1);

namespace SosPrescription\Repositories;

use SosPrescription\Db;

final class MessageRepository
{
    /**
     * @return array<int, array<string, mixed>>
     */
    public function list_for_prescription(int $prescription_id, int $limit = 200, int $offset = 0): array
    {
        global $wpdb;

        if ($limit < 1) { $limit = 200; }
        if ($limit > 500) { $limit = 500; }
        if ($offset < 0) { $offset = 0; }

        $table = Db::table('prescription_messages');

        // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        $rows = $wpdb->get_results(
            $wpdb->prepare(
                "SELECT * FROM {$table} WHERE prescription_id = %d ORDER BY created_at ASC LIMIT %d OFFSET %d",
                $prescription_id,
                $limit,
                $offset
            ),
            ARRAY_A
        ) ?: [];

        $out = [];
        foreach ($rows as $r) {
            $attachments = null;
            if (!empty($r['attachments_json'])) {
                $decoded = json_decode((string) $r['attachments_json'], true);
                if (is_array($decoded)) {
                    $attachments = $decoded;
                }
            }

            $out[] = [
                'id' => (int) $r['id'],
                'prescription_id' => (int) $r['prescription_id'],
                'author_role' => (string) $r['author_role'],
                'author_user_id' => $r['author_user_id'] !== null ? (int) $r['author_user_id'] : null,
                'body' => (string) $r['body'],
                'attachments' => $attachments,
                'created_at' => (string) $r['created_at'],
            ];
        }

        return $out;
    }

    /**
     * @param array<mixed>|null $attachments
     * @return array<string, mixed>
     */
    public function create(
        int $prescription_id,
        string $author_role,
        ?int $author_user_id,
        string $body,
        ?array $attachments
    ): array {
        global $wpdb;

        $table = Db::table('prescription_messages');
        $now = current_time('mysql');

        $attachments_json = null;
        if (is_array($attachments)) {
            $attachments_json = wp_json_encode($attachments, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            if (!is_string($attachments_json)) {
                $attachments_json = null;
            }
        }

        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
        $ok = $wpdb->insert($table, [
            'prescription_id' => $prescription_id,
            'author_role' => $author_role,
            'author_user_id' => $author_user_id,
            'body' => $body,
            'attachments_json' => $attachments_json,
            'created_at' => $now,
        ]);

        if (!$ok) {
            return ['error' => 'db_insert_failed', 'message' => (string) $wpdb->last_error];
        }

        return [
            'id' => (int) $wpdb->insert_id,
            'prescription_id' => $prescription_id,
            'author_role' => $author_role,
            'author_user_id' => $author_user_id,
            'body' => $body,
            'attachments' => $attachments,
            'created_at' => $now,
        ];
    }
}
