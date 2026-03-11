<?php
declare(strict_types=1);

namespace SosPrescription\Repositories;

use SosPrescription\Db;
use SosPrescription\Services\FileStorage;
use WP_Error;

final class FileRepository
{
    /**
     * @return array<string, mixed>|null
     */
    public function get(int $id): ?array
    {
        global $wpdb;

        $table = Db::table('files');

        // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        $row = $wpdb->get_row($wpdb->prepare("SELECT * FROM {$table} WHERE id = %d", $id), ARRAY_A);
        if (!$row) {
            return null;
        }

        return [
            'id' => (int) $row['id'],
            'owner_user_id' => (int) $row['owner_user_id'],
            'prescription_id' => $row['prescription_id'] !== null ? (int) $row['prescription_id'] : null,
            'purpose' => (string) $row['purpose'],
            'mime' => (string) $row['mime'],
            'original_name' => (string) $row['original_name'],
            'storage_key' => (string) $row['storage_key'],
            'size_bytes' => (int) $row['size_bytes'],
            'created_at' => (string) $row['created_at'],
        ];
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public function list_for_prescription(int $prescription_id): array
    {
        global $wpdb;
        $table = Db::table('files');

        // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        $rows = $wpdb->get_results(
            $wpdb->prepare(
                "SELECT id, owner_user_id, prescription_id, purpose, mime, original_name, size_bytes, created_at FROM {$table} WHERE prescription_id = %d ORDER BY created_at ASC",
                $prescription_id
            ),
            ARRAY_A
        ) ?: [];

        $out = [];
        foreach ($rows as $r) {
            $id = (int) $r['id'];
            $out[] = [
                'id' => $id,
                'prescription_id' => $r['prescription_id'] !== null ? (int) $r['prescription_id'] : null,
                'purpose' => (string) $r['purpose'],
                'mime' => (string) $r['mime'],
                'original_name' => (string) $r['original_name'],
                'size_bytes' => (int) $r['size_bytes'],
                'created_at' => (string) $r['created_at'],
                'download_url' => add_query_arg('_wpnonce', wp_create_nonce('wp_rest'), rest_url('sosprescription/v1/files/' . $id . '/download')),
            ];
        }
        return $out;
    }

    /**
     * Retourne le dernier fichier d'une prescription pour un purpose donné (ex: rx_pdf).
     *
     * @return array<string, mixed>|null
     */
    public function find_latest_for_prescription_purpose(int $prescription_id, string $purpose): ?array
    {
        global $wpdb;

        $table = Db::table('files');
        $purpose = strtolower(trim($purpose));
        if ($purpose === '') {
            return null;
        }

        // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        $row = $wpdb->get_row(
            $wpdb->prepare(
                "SELECT * FROM {$table} WHERE prescription_id = %d AND purpose = %s ORDER BY created_at DESC, id DESC LIMIT 1",
                $prescription_id,
                $purpose
            ),
            ARRAY_A
        );
        if (!$row) {
            return null;
        }

        return [
            'id' => (int) $row['id'],
            'owner_user_id' => (int) $row['owner_user_id'],
            'prescription_id' => $row['prescription_id'] !== null ? (int) $row['prescription_id'] : null,
            'purpose' => (string) $row['purpose'],
            'mime' => (string) $row['mime'],
            'original_name' => (string) $row['original_name'],
            'storage_key' => (string) $row['storage_key'],
            'size_bytes' => (int) $row['size_bytes'],
            'created_at' => (string) $row['created_at'],
        ];
    }

    /**
     * Retourne le dernier fichier (le plus récent) d'un utilisateur pour un purpose donné.
     *
     * Exemple d'usage : récupérer la dernière signature d'un médecin, même si la meta
     * n'a pas encore été renseignée (auto-réparation).
     *
     * @return array<string, mixed>|null
     */
    public function find_latest_for_owner_purpose(int $owner_user_id, string $purpose): ?array
    {
        global $wpdb;

        if ($owner_user_id < 1) {
            return null;
        }

        $table = Db::table('files');
        $purpose = strtolower(trim($purpose));
        if ($purpose === '') {
            return null;
        }

        // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        $row = $wpdb->get_row(
            $wpdb->prepare(
                "SELECT * FROM {$table} WHERE owner_user_id = %d AND purpose = %s ORDER BY created_at DESC, id DESC LIMIT 1",
                $owner_user_id,
                $purpose
            ),
            ARRAY_A
        );
        if (!$row) {
            return null;
        }

        return [
            'id' => (int) $row['id'],
            'owner_user_id' => (int) $row['owner_user_id'],
            'prescription_id' => $row['prescription_id'] !== null ? (int) $row['prescription_id'] : null,
            'purpose' => (string) $row['purpose'],
            'mime' => (string) $row['mime'],
            'original_name' => (string) $row['original_name'],
            'storage_key' => (string) $row['storage_key'],
            'size_bytes' => (int) $row['size_bytes'],
            'created_at' => (string) $row['created_at'],
        ];
    }

    /**
     * Met à jour les métadonnées d'un fichier (utile pour remplacer un PDF généré).
     *
     * @param array<string, mixed> $fields
     */
    public function update(int $id, array $fields): bool
    {
        global $wpdb;

        if ($id < 1) {
            return false;
        }

        $table = Db::table('files');

        $allowed = [
            'mime' => '%s',
            'original_name' => '%s',
            'storage_key' => '%s',
            'size_bytes' => '%d',
            'created_at' => '%s',
            'purpose' => '%s',
            'prescription_id' => '%d',
        ];

        $data = [];
        $format = [];
        foreach ($allowed as $k => $fmt) {
            if (!array_key_exists($k, $fields)) {
                continue;
            }
            $data[$k] = $fields[$k];
            $format[] = $fmt;
        }

        if (empty($data)) {
            return false;
        }

        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
        $updated = $wpdb->update(
            $table,
            $data,
            ['id' => $id],
            $format,
            ['%d']
        );

        return $updated !== false;
    }

    /**
     * @return array<string, mixed>
     */
    public function create(
        int $owner_user_id,
        ?int $prescription_id,
        string $purpose,
        string $mime,
        string $original_name,
        string $storage_key,
        int $size_bytes
    ): array {
        global $wpdb;

        $table = Db::table('files');
        $now = current_time('mysql');

        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
        $ok = $wpdb->insert($table, [
            'owner_user_id' => $owner_user_id,
            'prescription_id' => $prescription_id,
            'purpose' => $purpose,
            'mime' => $mime,
            'original_name' => $original_name,
            'storage_key' => $storage_key,
            'size_bytes' => $size_bytes,
            'created_at' => $now,
        ]);

        if (!$ok) {
            return ['error' => 'db_insert_failed', 'message' => (string) $wpdb->last_error];
        }

        return [
            'id' => (int) $wpdb->insert_id,
            'owner_user_id' => $owner_user_id,
            'prescription_id' => $prescription_id,
            'purpose' => $purpose,
            'mime' => $mime,
            'original_name' => $original_name,
            'size_bytes' => $size_bytes,
            'created_at' => $now,
        ];
    }

    /**
     * Attache des fichiers (déjà uploadés par le patient) à une prescription.
     *
     * @param array<int, int> $file_ids
     */
    public function attach_to_prescription(int $prescription_id, int $owner_user_id, array $file_ids): int
    {
        global $wpdb;

        $file_ids = array_values(array_filter(array_map('intval', $file_ids), static fn ($v) => $v > 0));
        if (count($file_ids) === 0) {
            return 0;
        }

        $table = Db::table('files');

        $placeholders = implode(',', array_fill(0, count($file_ids), '%d'));
        $params = array_merge([$prescription_id, $owner_user_id], $file_ids);

        // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        $sql = $wpdb->prepare(
            "UPDATE {$table}
             SET prescription_id = %d
             WHERE owner_user_id = %d
               AND prescription_id IS NULL
               AND id IN ({$placeholders})",
            $params
        );

        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
        $updated = $wpdb->query($sql);
        return is_int($updated) ? $updated : 0;
    }

    /**
     * Liste des fichiers orphelins (non rattachés à une prescription) plus vieux que N jours.
     *
     * @return array<int, array<string, mixed>>
     */
    public function list_orphans_older_than_days(int $days, int $limit = 200): array
    {
        global $wpdb;

        $table = Db::table('files');
        $days = max(1, (int) $days);
        $limit = max(1, min(500, (int) $limit));

        // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        $sql = $wpdb->prepare(
            "SELECT id, owner_user_id, storage_key, created_at FROM {$table} WHERE prescription_id IS NULL AND created_at < DATE_SUB(NOW(), INTERVAL %d DAY) ORDER BY created_at ASC LIMIT %d",
            $days,
            $limit
        );

        // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        $rows = $wpdb->get_results($sql, ARRAY_A) ?: [];
        return is_array($rows) ? $rows : [];
    }

    public function delete(int $id): bool
    {
        global $wpdb;
        $id = (int) $id;
        if ($id < 1) {
            return false;
        }

        $table = Db::table('files');
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
        $res = $wpdb->delete($table, ['id' => $id], ['%d']);
        return $res !== false;
    }


    /**
     * Retourne le chemin absolu (privé) vers un fichier stocké.
     * Utilisé notamment par le générateur PDF (signature).
     *
     * @return string|WP_Error
     */
    public function get_file_absolute_path(int $file_id)
    {
        $file = $this->get($file_id);
        if (!$file || empty($file['storage_key'])) {
            return new WP_Error('sosprescription_file_not_found', 'Fichier introuvable.', ['status' => 404]);
        }
        return FileStorage::safe_abs_path((string) $file['storage_key']);
    }


}
