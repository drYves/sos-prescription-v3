<?php
declare(strict_types=1);

namespace SosPrescription\Repositories;

use SosPrescription\Db;
use SosPrescription\Services\Posology;
use SosPrescription\Utils\Date;

final class PrescriptionRepository
{
    /** @var array<string, array<string, array<string, mixed>>> */
    private static array $tableColumnsCache = [];

    /**
     * @param array<string, mixed> $payload
     * @param array<int, array<string, mixed>> $items
     * @return array<string, mixed>
     */
    public function create(
        int $patient_user_id,
        string $uid,
        array $payload,
        array $items,
        ?string $flow = null,
        ?string $priority = null,
        ?string $client_request_id = null,
        ?array $evidence_file_ids = null,
        ?string $initial_status = null
    ): array
    {
        global $wpdb;

        $table = Db::table('prescriptions');
        $items_table = Db::table('prescription_items');
        $files_table = Db::table('files');

        $now = current_time('mysql');

        // Statut initial (ex: pending / payment_pending)
        $initial_status = $initial_status !== null ? strtolower(trim($initial_status)) : 'pending';
        if ($initial_status === '') {
            $initial_status = 'pending';
        }
        // MVP : on limite volontairement les statuts possibles.
        if (!in_array($initial_status, ['pending', 'payment_pending'], true)) {
            $initial_status = 'pending';
        }

        $flow = $flow !== null ? strtolower(trim($flow)) : null;
        if ($flow === '') { $flow = null; }

        $priority = $priority !== null ? strtolower(trim($priority)) : null;
        if ($priority === '') { $priority = null; }

        $client_request_id = $client_request_id !== null ? trim($client_request_id) : null;
        if ($client_request_id === '') { $client_request_id = null; }

        $payload_json = wp_json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if (!is_string($payload_json)) {
            $payload_json = '{}';
        }

        $worker_shadow_mode = $this->isWorkerPostgresShadowPayload($payload);
        $table_columns = $this->tableColumns($table);
        $insert_data = [];

        if (isset($table_columns['uid'])) {
            $insert_data['uid'] = $this->truncateNullableString($uid, 64) ?? $uid;
        }
        if (isset($table_columns['patient_user_id'])) {
            $insert_data['patient_user_id'] = $patient_user_id;
        }
        if (isset($table_columns['doctor_user_id'])) {
            $insert_data['doctor_user_id'] = null;
        }
        if (isset($table_columns['status'])) {
            $insert_data['status'] = $this->normalizeStatusForColumn($initial_status, $table_columns['status']);
        }
        if (isset($table_columns['flow'])) {
            $insert_data['flow'] = $this->normalizeShadowFlowForColumn($flow !== null ? $flow : 'renewal', $table_columns['flow']);
        }
        if (isset($table_columns['priority'])) {
            $insert_data['priority'] = $this->normalizeShadowPriorityForColumn($priority !== null ? $priority : 'standard', $table_columns['priority']);
        }
        if (isset($table_columns['client_request_id'])) {
            $insert_data['client_request_id'] = $this->truncateNullableString($client_request_id, 191);
        }
        if (isset($table_columns['last_activity_at'])) {
            $insert_data['last_activity_at'] = $now;
        }
        if (isset($table_columns['payload_json'])) {
            $insert_data['payload_json'] = $payload_json;
        }
        if (isset($table_columns['decision_reason'])) {
            $insert_data['decision_reason'] = null;
        }
        if (isset($table_columns['created_at'])) {
            $insert_data['created_at'] = $now;
        }
        if (isset($table_columns['updated_at'])) {
            $insert_data['updated_at'] = $now;
        }
        if (isset($table_columns['decided_at'])) {
            $insert_data['decided_at'] = null;
        }

        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
        $wpdb->query('START TRANSACTION');

        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
        $ok = $wpdb->insert($table, $insert_data);

        if (!$ok) {
            // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
            $wpdb->query('ROLLBACK');
            return ['error' => 'shadow_insert_main', 'message' => (string) $wpdb->last_error];
        }

        $prescription_id = (int) $wpdb->insert_id;

        // Attache les pièces justificatives uploadées avant la création.
        if (is_array($evidence_file_ids) && count($evidence_file_ids) > 0) {
            $ids = array_values(array_filter(array_map('intval', $evidence_file_ids), static fn ($v) => $v > 0));
            if (count($ids) > 0) {
                $placeholders = implode(',', array_fill(0, count($ids), '%d'));
                $params = array_merge([$prescription_id, $patient_user_id], $ids);

                // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
                $sql_attach = $wpdb->prepare(
                    "UPDATE {$files_table} SET prescription_id = %d WHERE owner_user_id = %d AND prescription_id IS NULL AND id IN ({$placeholders})",
                    $params
                );
                // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
                $attached = $wpdb->query($sql_attach);
                if ($attached === false) {
                    // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
                    $wpdb->query('ROLLBACK');
                    return ['error' => 'shadow_attach_evidence', 'message' => (string) $wpdb->last_error];
                }
            }
        }

        if (!$worker_shadow_mode) {
            $line_no = 1;
            foreach ($items as $it) {
                if (!is_array($it)) {
                    continue;
                }

                $cis = isset($it['cis']) && is_numeric($it['cis']) ? (int) $it['cis'] : null;
                $cip13 = isset($it['cip13']) ? trim((string) $it['cip13']) : null;
                if ($cip13 === '') { $cip13 = null; }

                $label = isset($it['label']) ? trim((string) $it['label']) : '';
                if ($label === '') { $label = 'Médicament'; }

                $quantite = isset($it['quantite']) ? trim((string) $it['quantite']) : '';
                $quantite = $quantite !== '' ? $quantite : null;

                $schedule = isset($it['schedule']) && is_array($it['schedule']) ? $it['schedule'] : [];

                // Ne calcule une posologie textuelle que si la structure est "complète".
                // Cela évite de générer des sorties absurdes (ex: "1 fois par jour pendant 1 jour")
                // lorsque le patient ne renseigne qu'une remarque.
                $has_core_schedule = isset($schedule['nb'], $schedule['freqUnit'], $schedule['durationVal'], $schedule['durationUnit']);
                $posologie = $has_core_schedule ? Posology::schedule_to_text($schedule) : null;

                $item_json = wp_json_encode($it, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
                if (!is_string($item_json)) {
                    $item_json = '{}';
                }

                // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
                $ok_item = $wpdb->insert($items_table, [
                    'prescription_id' => $prescription_id,
                    'line_no' => $line_no,
                    'cis' => $cis,
                    'cip13' => $cip13,
                    'denomination' => $label,
                    'posologie' => $posologie,
                    'quantite' => $quantite,
                    'item_json' => $item_json,
                ]);

                if (!$ok_item) {
                    // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
                    $wpdb->query('ROLLBACK');
                    return ['error' => 'shadow_insert_item', 'message' => (string) $wpdb->last_error];
                }

                $line_no++;
            }
        }

        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
        $wpdb->query('COMMIT');

        return [
            'id' => $prescription_id,
            'uid' => $uid,
            'status' => $initial_status,
            'created_at' => $now,
        ];
    }

    /**
     * @param array<string, mixed> $payload
     */
    private function isWorkerPostgresShadowPayload(array $payload): bool
    {
        if (!isset($payload['shadow']) || !is_array($payload['shadow'])) {
            return false;
        }

        $mode = isset($payload['shadow']['mode']) ? strtolower(trim((string) $payload['shadow']['mode'])) : '';
        return $mode === 'worker-postgres';
    }

    /**
     * @return array<string, array<string, mixed>>
     */
    private function tableColumns(string $table): array
    {
        if (isset(self::$tableColumnsCache[$table])) {
            return self::$tableColumnsCache[$table];
        }

        global $wpdb;

        $safe_table = str_replace('`', '', $table);
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
        $rows = $wpdb->get_results("SHOW COLUMNS FROM `{$safe_table}`", ARRAY_A);
        if (!is_array($rows)) {
            self::$tableColumnsCache[$table] = [];
            return [];
        }

        $columns = [];
        foreach ($rows as $row) {
            if (!is_array($row) || empty($row['Field'])) {
                continue;
            }

            $name = (string) $row['Field'];
            $columns[$name] = $row;
        }

        self::$tableColumnsCache[$table] = $columns;

        return $columns;
    }

    private function truncateNullableString(?string $value, int $max_length): ?string
    {
        if ($value === null) {
            return null;
        }

        $value = trim($value);
        if ($value === '') {
            return null;
        }

        if ($max_length < 1) {
            return '';
        }

        return function_exists('mb_substr')
            ? (string) mb_substr($value, 0, $max_length, 'UTF-8')
            : substr($value, 0, $max_length);
    }

    /**
     * @param array<string, mixed> $column
     */
    private function normalizeShadowFlowForColumn(string $flow, array $column): string|int
    {
        $normalized = strtolower(trim($flow));
        if ($normalized === '' || $normalized === 'ro_proof' || $normalized === 'renewal' || $normalized === 'renouvellement') {
            $normalized = 'renewal';
        } elseif ($normalized === 'depannage_no_proof' || $normalized === 'depannage' || $normalized === 'depannage-sos' || $normalized === 'sos') {
            $normalized = 'depannage';
        }

        return $this->normalizeValueForColumn($normalized, $column, 64);
    }

    /**
     * @param array<string, mixed> $column
     */
    private function normalizeShadowPriorityForColumn(string $priority, array $column): string|int
    {
        $normalized = strtolower(trim($priority)) === 'express' ? 'express' : 'standard';
        return $this->normalizeValueForColumn($normalized, $column, 32);
    }

    /**
     * @param array<string, mixed> $column
     */
    private function normalizeStatusForColumn(string $status, array $column): string|int
    {
        $normalized = strtolower(trim($status));
        if ($normalized === '') {
            $normalized = 'pending';
        }

        return $this->normalizeValueForColumn($normalized, $column, 32);
    }

    /**
     * @param array<string, mixed> $column
     */
    private function normalizeValueForColumn(string $value, array $column, int $string_max_length): string|int
    {
        $type = isset($column['Type']) ? strtolower((string) $column['Type']) : '';
        if ($type !== '' && preg_match('/(?:tiny|small|medium|big)?int/', $type) === 1) {
            return match ($value) {
                'express' => 10,
                'pending' => 0,
                'payment_pending' => 5,
                'approved' => 20,
                'rejected' => 30,
                'depannage' => 20,
                default => 100,
            };
        }

        return $this->truncateNullableString($value, $string_max_length) ?? '';
    }


    public function update_priority(int $id, string $priority): bool
    {
        global $wpdb;
        $table = Db::table('prescriptions');
        $priority = strtolower(trim($priority));
        if ($priority !== 'express') {
            $priority = 'standard';
        }

        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
        $updated = $wpdb->update(
            $table,
            [
                'priority' => $priority,
                'updated_at' => current_time('mysql'),
            ],
            ['id' => $id],
            ['%s', '%s'],
            ['%d']
        );

        return $updated !== false;
    }

    /**
     * Met à jour le statut uniquement si le statut courant correspond à $from.
     */
    public function set_status_if_current(int $id, string $from, string $to): bool
    {
        global $wpdb;
        $table = Db::table('prescriptions');
        $from = strtolower(trim($from));
        $to = strtolower(trim($to));
        if ($from === '' || $to === '') {
            return false;
        }

        $now = current_time('mysql');

        // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        $updated = $wpdb->query($wpdb->prepare(
            "UPDATE {$table} SET status = %s, updated_at = %s WHERE id = %d AND status = %s",
            $to,
            $now,
            $id,
            $from
        ));

        return $updated !== false;
    }

    /**
     * Assigne une demande au médecin (console).
     *
     * Règles :
     * - interdit si status = approved/rejected/payment_pending
     * - interdit si déjà assignée à un autre médecin
     * - idempotent si déjà assignée au même médecin en in_review
     */
    public function assign_to_doctor(int $id, int $doctor_user_id): bool
    {
        global $wpdb;

        $table = Db::table('prescriptions');

        // État courant
        // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        $row = $wpdb->get_row(
            $wpdb->prepare(
                "SELECT doctor_user_id, status FROM {$table} WHERE id = %d",
                $id
            ),
            ARRAY_A
        );

        if (!$row) {
            return false;
        }

        $current_status = isset($row['status']) ? (string) $row['status'] : '';
        $current_doctor_raw = $row['doctor_user_id'] ?? null;
        $current_doctor = ($current_doctor_raw === null || (int) $current_doctor_raw < 1) ? null : (int) $current_doctor_raw;

        if (in_array($current_status, ['approved', 'rejected', 'payment_pending'], true)) {
            return false;
        }

        if ($current_doctor !== null && $current_doctor !== $doctor_user_id) {
            return false;
        }

        // Déjà assigné en in_review -> OK (idempotent)
        if ($current_doctor === $doctor_user_id && $current_status === 'in_review') {
            return true;
        }

        $now = current_time('mysql');

        // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        $updated = $wpdb->query($wpdb->prepare(
            "UPDATE {$table}
             SET doctor_user_id = %d,
                 status = %s,
                 assigned_at = COALESCE(assigned_at, %s),
                 last_activity_at = %s,
                 updated_at = %s
             WHERE id = %d
               AND (doctor_user_id IS NULL OR doctor_user_id = 0 OR doctor_user_id = %d)
               AND status IN ('pending','needs_info','in_review')",
            $doctor_user_id,
            'in_review',
            $now,
            $now,
            $now,
            $id,
            $doctor_user_id
        ));

        if ($updated === false) {
            return false;
        }

        // Si aucune ligne modifiée, c'est qu'elle n'était pas dans un statut autorisé.
        return is_int($updated) ? $updated > 0 : true;
    }

    /**
     * Met à jour le statut d'une demande via la console médecin.
     *
     * Statuts autorisés : pending | in_review | needs_info
     *
     * Règles :
     * - interdit si status = approved/rejected/payment_pending
     * - interdit si assigné à un autre médecin
     * - si passage en in_review : set doctor_user_id + assigned_at si vide
     */
    public function update_status_by_doctor(int $id, int $doctor_user_id, string $status): bool
    {
        global $wpdb;

        $table = Db::table('prescriptions');

        $status = strtolower(trim($status));
        if (!in_array($status, ['pending', 'in_review', 'needs_info'], true)) {
            return false;
        }

        // État courant
        // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        $row = $wpdb->get_row(
            $wpdb->prepare(
                "SELECT doctor_user_id, status FROM {$table} WHERE id = %d",
                $id
            ),
            ARRAY_A
        );
        if (!$row) {
            return false;
        }

        $current_status = isset($row['status']) ? (string) $row['status'] : '';
        $current_doctor_raw = $row['doctor_user_id'] ?? null;
        $current_doctor = ($current_doctor_raw === null || (int) $current_doctor_raw < 1) ? null : (int) $current_doctor_raw;

        if (in_array($current_status, ['approved', 'rejected', 'payment_pending'], true)) {
            return false;
        }

        if ($current_doctor !== null && $current_doctor !== $doctor_user_id) {
            return false;
        }

        $now = current_time('mysql');

        if ($status === 'in_review') {
            // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
            $updated = $wpdb->query($wpdb->prepare(
                "UPDATE {$table}
                 SET status = %s,
                     doctor_user_id = %d,
                     assigned_at = COALESCE(assigned_at, %s),
                     last_activity_at = %s,
                     updated_at = %s
                 WHERE id = %d
                   AND (doctor_user_id IS NULL OR doctor_user_id = 0 OR doctor_user_id = %d)",
                $status,
                $doctor_user_id,
                $now,
                $now,
                $now,
                $id,
                $doctor_user_id
            ));
        } else {
            // pending / needs_info : on conserve le doctor_user_id (s'il existe), ou on le fixe si besoin.
            $set_doctor = ($current_doctor === null) ? $doctor_user_id : $current_doctor;

            // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
            $updated = $wpdb->query($wpdb->prepare(
                "UPDATE {$table}
                 SET status = %s,
                     doctor_user_id = %d,
                     last_activity_at = %s,
                     updated_at = %s
                 WHERE id = %d
                   AND (doctor_user_id IS NULL OR doctor_user_id = 0 OR doctor_user_id = %d)",
                $status,
                $set_doctor,
                $now,
                $now,
                $id,
                $set_doctor
            ));
        }

        if ($updated === false) {
            return false;
        }

        return is_int($updated) ? $updated > 0 : true;
    }

    public function get_owner_user_id(int $id): ?int
    {
        global $wpdb;
        $table = Db::table('prescriptions');
        // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        $val = $wpdb->get_var($wpdb->prepare("SELECT patient_user_id FROM {$table} WHERE id = %d", $id));
        if ($val === null) {
            return null;
        }
        return (int) $val;
    }

    public function get_doctor_user_id(int $id): ?int
    {
        global $wpdb;
        $table = Db::table('prescriptions');
        // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        $val = $wpdb->get_var($wpdb->prepare("SELECT doctor_user_id FROM {$table} WHERE id = %d", $id));
        if ($val === null) {
            return null;
        }
        $v = (int) $val;
        return $v > 0 ? $v : null;
    }

    public function touch_last_activity(int $id): bool
    {
        global $wpdb;
        $table = Db::table('prescriptions');
        $now = current_time('mysql');
        // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        $updated = $wpdb->query($wpdb->prepare(
            "UPDATE {$table} SET last_activity_at = %s, updated_at = %s WHERE id = %d",
            $now,
            $now,
            $id
        ));
        return $updated !== false;
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public function list(?int $patient_user_id, ?string $status, int $limit, int $offset): array
    {
        global $wpdb;

        $table = Db::table('prescriptions');

        $where = [];
        $params = [];

        if ($patient_user_id !== null) {
            $where[] = 'patient_user_id = %d';
            $params[] = $patient_user_id;
        }

        if ($status !== null && $status !== '') {
            // UX: treat "pending" as a ready-to-process queue which includes prescriptions
            // still waiting for payment authorization (payment_pending). This avoids the
            // impression that requests "do not arrive" in the doctor console.
            if ($status === 'pending') {
                $where[] = '(status = %s OR status = %s)';
                $params[] = 'pending';
                $params[] = 'payment_pending';
            } else {
                $where[] = 'status = %s';
                $params[] = $status;
            }
        }

        $where_sql = count($where) ? ('WHERE ' . implode(' AND ', $where)) : '';

        // IMPORTANT: deterministic ordering for stable polling signatures.
        // On busy test environments multiple rows can share the same created_at (second precision),
        // which makes MySQL return ties in a non-deterministic order.
        // The doctor console compares list signatures to decide whether to re-render;
        // unstable ordering was interpreted as a change every poll tick causing UI jitter.
        $sql = "SELECT id, uid, patient_user_id, doctor_user_id, status,
                       flow, priority,
                       payment_status, amount_cents, currency,
                       last_activity_at, assigned_at,
                       created_at, updated_at, decided_at,
                       payload_json
                FROM {$table}
                {$where_sql}
                ORDER BY created_at DESC, id DESC
                LIMIT %d OFFSET %d";

        $params[] = $limit;
        $params[] = $offset;

        // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        $prepared = $wpdb->prepare($sql, $params);
        // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        $rows = $wpdb->get_results($prepared, ARRAY_A) ?: [];

        foreach ($rows as &$row) {
            $payload = json_decode((string) ($row['payload_json'] ?? '{}'), true);
            $row['payload'] = is_array($payload) ? $payload : [];
        }
        unset($row);

        return $rows;
    }

	/**
	 * Liste côté médecin : dossiers non assignés OU assignés à ce médecin.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public function list_for_doctor(int $doctor_user_id, ?string $status, int $limit, int $offset): array
	{
		global $wpdb;

		$doctor_user_id = (int) $doctor_user_id;
		if ($doctor_user_id < 1) {
			return [];
		}

		$table = Db::table('prescriptions');

		$where = [];
		$params = [];

		$where[] = '(doctor_user_id IS NULL OR doctor_user_id = 0 OR doctor_user_id = %d)';
		$params[] = $doctor_user_id;

		if ($status !== null && $status !== '') {
			// Same behavior as list(): "pending" includes "payment_pending".
			if ($status === 'pending') {
				$where[] = '(status = %s OR status = %s)';
				$params[] = 'pending';
				$params[] = 'payment_pending';
			} else {
				$where[] = 'status = %s';
				$params[] = $status;
			}
		}

		$where_sql = 'WHERE ' . implode(' AND ', $where);

        // Same deterministic tie-break as list(): prevents jitter during polling.
        $sql = "SELECT id, uid, patient_user_id, doctor_user_id, status,
                       flow, priority,
                       payment_status, amount_cents, currency,
                       last_activity_at, assigned_at,
                       created_at, updated_at, decided_at,
                       payload_json
                FROM {$table}
                {$where_sql}
                ORDER BY created_at DESC, id DESC
                LIMIT %d OFFSET %d";

		$params[] = $limit;
		$params[] = $offset;

		// phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
		$prepared = $wpdb->prepare($sql, $params);
		// phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
		$rows = $wpdb->get_results($prepared, ARRAY_A) ?: [];

		foreach ($rows as &$row) {
			$payload = json_decode((string) ($row['payload_json'] ?? '{}'), true);
			$row['payload'] = is_array($payload) ? $payload : [];
		}
		unset($row);

		return $rows;
	}

    /**
     * @return array<string, mixed>|null
     */
    public function get(int $id): ?array
    {
        global $wpdb;

        $table = Db::table('prescriptions');
        $items_table = Db::table('prescription_items');

        // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        $row = $wpdb->get_row($wpdb->prepare("SELECT * FROM {$table} WHERE id = %d", $id), ARRAY_A);
        if (!$row) {
            return null;
        }

        $payload = json_decode((string) ($row['payload_json'] ?? '{}'), true);
        if (!is_array($payload)) {
            $payload = [];
        }

        $worker_shadow_mode = $this->isWorkerPostgresShadowPayload($payload);
        if ($worker_shadow_mode) {
            // En mode shadow Worker, la table locale ne doit plus corriger la vérité canonique
            // via la BDPM MySQL. On relit une projection locale simple, sans enrichissement normatif.
            // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
            $items = $wpdb->get_results(
                $wpdb->prepare(
                    "SELECT it.*
                     FROM {$items_table} it
                     WHERE it.prescription_id = %d
                     ORDER BY it.line_no ASC",
                    $id
                ),
                ARRAY_A
            ) ?: [];
        } else {
            // Héritage local : on conserve l'ancien enrichissement CIS tant que cette branche existe.
            $cis_table = Db::table('cis');

            // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
            $items = $wpdb->get_results(
                $wpdb->prepare(
                    "SELECT it.*, c.denomination AS cis_denomination
                     FROM {$items_table} it
                     LEFT JOIN {$cis_table} c ON c.cis = it.cis
                     WHERE it.prescription_id = %d
                     ORDER BY it.line_no ASC",
                    $id
                ),
                ARRAY_A
            ) ?: [];
        }

        // Patient (dérivés pour l’UI médecin / PDF)
        $patient = [];
        if (isset($payload['patient']) && is_array($payload['patient'])) {
            $patient = $payload['patient'];
        }

        $patient_name = '';
        if (isset($patient['fullname'])) {
            $patient_name = trim((string) $patient['fullname']);
        }
        if ($patient_name === '' && isset($payload['patient_name'])) {
            $patient_name = trim((string) $payload['patient_name']);
        }
        if ($patient_name === '') {
            $patient_name = 'Patient';
        }

        $patient_birth_iso = '';
        if (isset($patient['birthdate'])) {
            $patient_birth_iso = trim((string) $patient['birthdate']);
        }
        if ($patient_birth_iso === '' && isset($payload['patient_birthdate'])) {
            $patient_birth_iso = trim((string) $payload['patient_birthdate']);
        }

        $patient_birth_fr = $patient_birth_iso !== '' ? Date::iso_to_fr($patient_birth_iso) : '';
        $patient_age_label = $patient_birth_iso !== '' ? Date::age_label($patient_birth_iso) : '';

        // Paiement (si activé) — infos d'affichage / suivi.
        $pricing_snapshot = null;
        if (!empty($row['pricing_snapshot_json'])) {
            $tmp = json_decode((string) $row['pricing_snapshot_json'], true);
            if (is_array($tmp)) {
                $pricing_snapshot = $tmp;
            }
        }

        $out_items = [];
        foreach ($items as $it) {
            $raw = json_decode((string) ($it['item_json'] ?? '{}'), true);
            if (!is_array($raw)) { $raw = []; }

            $cis_denom = isset($it['cis_denomination']) ? (string) $it['cis_denomination'] : '';
            $saved_denom = (string) ($it['denomination'] ?? '');
            $raw_denom = isset($raw['denomination']) ? trim((string) $raw['denomination']) : '';
            $final_denom = $worker_shadow_mode
                ? ($raw_denom !== '' ? $raw_denom : $saved_denom)
                : ($cis_denom !== '' ? $cis_denom : ($saved_denom !== '' ? $saved_denom : $raw_denom));

            $out_items[] = [
                'line_no' => (int) ($it['line_no'] ?? 0),
                'cis' => isset($it['cis']) && $it['cis'] !== null ? (string) $it['cis'] : null,
                'cip13' => isset($it['cip13']) ? (string) $it['cip13'] : null,
                'denomination' => $final_denom,
                'posologie' => $it['posologie'] !== null ? (string) $it['posologie'] : null,
                'quantite' => $it['quantite'] !== null ? (string) $it['quantite'] : null,
                'raw' => $raw,
            ];
        }

        // Pièces justificatives (photos/scan ordonnance, boîte, etc.)
        $files_repo = new FileRepository();
        $files = $files_repo->list_for_prescription($id);

        return [
            'id' => (int) $row['id'],
            'uid' => (string) $row['uid'],
            'patient_user_id' => (int) $row['patient_user_id'],
            'patient_name' => $patient_name,
            'patient_birthdate' => $patient_birth_iso,
            'patient_birthdate_fr' => $patient_birth_fr,
            'patient_age_label' => $patient_age_label,
            'patient_dob' => $patient_birth_fr !== '' ? $patient_birth_fr : $patient_birth_iso,
            'doctor_user_id' => $row['doctor_user_id'] !== null ? (int) $row['doctor_user_id'] : null,
            'status' => (string) $row['status'],
            'flow' => isset($row['flow']) ? (string) $row['flow'] : 'renewal',
            'priority' => isset($row['priority']) ? (string) $row['priority'] : 'standard',
            'payment' => [
                'provider' => isset($row['payment_provider']) && $row['payment_provider'] !== null ? (string) $row['payment_provider'] : null,
                'status' => isset($row['payment_status']) && $row['payment_status'] !== null ? (string) $row['payment_status'] : null,
                'amount_cents' => isset($row['amount_cents']) && $row['amount_cents'] !== null ? (int) $row['amount_cents'] : null,
                'currency' => isset($row['currency']) && is_string($row['currency']) ? (string) $row['currency'] : 'EUR',
                'pricing_snapshot' => $pricing_snapshot,
            ],
            'client_request_id' => isset($row['client_request_id']) && $row['client_request_id'] !== null ? (string) $row['client_request_id'] : null,
            'payload' => $payload,
            'decision_reason' => $row['decision_reason'] !== null ? (string) $row['decision_reason'] : null,
            'created_at' => (string) $row['created_at'],
            'updated_at' => (string) $row['updated_at'],
            'decided_at' => $row['decided_at'] !== null ? (string) $row['decided_at'] : null,

            // Vérification publique (QR)
            'verify_token' => isset($row['verify_token']) && $row['verify_token'] !== null ? (string) $row['verify_token'] : null,
            'verify_code' => isset($row['verify_code']) && $row['verify_code'] !== null ? (string) $row['verify_code'] : null,
            'dispensed_at' => isset($row['dispensed_at']) && $row['dispensed_at'] !== null ? (string) $row['dispensed_at'] : null,
            'items' => $out_items,
            'files' => $files,
        ];
    }

    /**
     * Récupère une prescription via son token de vérification publique.
     *
     * @return array|null Détail de prescription identique à get($id)
     */
    public function get_by_verify_token(string $token): ?array
    {
        global $wpdb;

        $token = trim($token);
        if ($token === '') {
            return null;
        }

        $table = Db::table('prescriptions');

        // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        $id = $wpdb->get_var($wpdb->prepare(
            "SELECT id FROM {$table} WHERE verify_token = %s LIMIT 1",
            $token
        ));

        if (!$id) {
            return null;
        }

        return $this->get((int) $id);
    }

    /**
     * Enregistre la décision médicale.
     *
     * Sécurité : n'écrase jamais une décision déjà prise (approved/rejected).
     *
     * @return bool true si la ligne a été mise à jour, false si conflit (déjà décidée) ou erreur.
     */
    public function decide(int $id, int $doctor_user_id, string $decision, ?string $reason = null): bool
    {
        global $wpdb;

        $table = Db::table('prescriptions');

        $decision = $decision === 'approved' ? 'approved' : 'rejected';
        $now = current_time('mysql');
        $reason = $reason !== null ? trim($reason) : null;
        if ($reason === '') { $reason = null; }

        // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        $updated = $wpdb->query($wpdb->prepare(
            "UPDATE {$table}
             SET status = %s,
                 doctor_user_id = %d,
                 decision_reason = %s,
                 decided_at = %s,
                 updated_at = %s
             WHERE id = %d
               AND status NOT IN ('approved','rejected')",
            $decision,
            $doctor_user_id,
            $reason,
            $now,
            $now,
            $id
        ));

        if ($updated === false) {
            return false;
        }

        // $updated est le nombre de lignes modifiées.
        return is_int($updated) ? $updated > 0 : true;
    }

    /**
     * Récupère les champs paiement d'une prescription.
     *
     * @return array{payment_provider:?string,payment_intent_id:?string,payment_status:?string,amount_cents:?int,currency:string,pricing_snapshot:?array,status:string,uid:string,priority:string,flow:string}|null
     */
    public function get_payment_fields(int $id): ?array
    {
        global $wpdb;

        $table = Db::table('prescriptions');

        // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        $row = $wpdb->get_row($wpdb->prepare(
            "SELECT id, uid, status, flow, priority, payment_provider, payment_intent_id, payment_status, amount_cents, currency, pricing_snapshot_json
             FROM {$table} WHERE id = %d",
            $id
        ), ARRAY_A);

        if (!$row) {
            return null;
        }

        $snapshot = null;
        if (isset($row['pricing_snapshot_json']) && $row['pricing_snapshot_json'] !== null) {
            $tmp = json_decode((string) $row['pricing_snapshot_json'], true);
            if (is_array($tmp)) {
                $snapshot = $tmp;
            }
        }

        return [
            'payment_provider' => isset($row['payment_provider']) && $row['payment_provider'] !== null ? (string) $row['payment_provider'] : null,
            'payment_intent_id' => isset($row['payment_intent_id']) && $row['payment_intent_id'] !== null ? (string) $row['payment_intent_id'] : null,
            'payment_status' => isset($row['payment_status']) && $row['payment_status'] !== null ? (string) $row['payment_status'] : null,
            'amount_cents' => isset($row['amount_cents']) && $row['amount_cents'] !== null ? (int) $row['amount_cents'] : null,
            'currency' => isset($row['currency']) && is_string($row['currency']) ? (string) $row['currency'] : 'EUR',
            'pricing_snapshot' => $snapshot,
            'status' => isset($row['status']) ? (string) $row['status'] : 'pending',
            'uid' => isset($row['uid']) ? (string) $row['uid'] : '',
            'priority' => isset($row['priority']) ? (string) $row['priority'] : 'standard',
            'flow' => isset($row['flow']) ? (string) $row['flow'] : 'renewal',
        ];
    }

    /**
     * Met à jour les champs paiement.
     *
     * @param array{payment_provider?:?string,payment_intent_id?:?string,payment_status?:?string,amount_cents?:?int,currency?:?string,pricing_snapshot?:?array} $fields
     */
    public function update_payment_fields(int $id, array $fields): bool
    {
        global $wpdb;

        $table = Db::table('prescriptions');

        $data = [];
        $format = [];

        if (array_key_exists('payment_provider', $fields)) {
            $data['payment_provider'] = $fields['payment_provider'];
            $format[] = '%s';
        }
        if (array_key_exists('payment_intent_id', $fields)) {
            $data['payment_intent_id'] = $fields['payment_intent_id'];
            $format[] = '%s';
        }
        if (array_key_exists('payment_status', $fields)) {
            $data['payment_status'] = $fields['payment_status'];
            $format[] = '%s';
        }
        if (array_key_exists('amount_cents', $fields)) {
            $data['amount_cents'] = $fields['amount_cents'];
            $format[] = '%d';
        }
        if (array_key_exists('currency', $fields)) {
            $cur = $fields['currency'];
            $cur = is_string($cur) ? strtoupper(trim($cur)) : null;
            $data['currency'] = $cur !== '' ? $cur : null;
            $format[] = '%s';
        }
        if (array_key_exists('pricing_snapshot', $fields)) {
            $snap = $fields['pricing_snapshot'];
            if ($snap !== null && !is_array($snap)) {
                $snap = null;
            }
            $snap_json = $snap !== null ? wp_json_encode($snap, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) : null;
            $data['pricing_snapshot_json'] = is_string($snap_json) ? $snap_json : null;
            $format[] = '%s';
        }

        $data['updated_at'] = current_time('mysql');
        $format[] = '%s';

        if (count($data) === 1 && isset($data['updated_at'])) {
            // Rien à faire.
            return true;
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
     * Marque une ordonnance comme "délivrée".
     *
     * Utilisé par la page de vérification publique (/v/{token}) après saisie du code 6 chiffres.
     */
    public function mark_dispensed(int $id, string $ip_hash): bool
    {
        global $wpdb;

        $table = Db::table('prescriptions');
        $now = current_time('mysql');

        // Ne pas écraser une délivrance déjà renseignée.
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
        $updated = $wpdb->query(
            $wpdb->prepare(
                "UPDATE {$table} SET dispensed_at=%s, dispensed_ip_hash=%s, updated_at=%s WHERE id=%d AND (dispensed_at IS NULL OR dispensed_at='0000-00-00 00:00:00')",
                $now,
                $ip_hash,
                $now,
                $id
            )
        );

        return $updated !== false;
    }

    public function find_id_by_payment_intent(string $payment_intent_id): ?int
    {
        global $wpdb;
        $table = Db::table('prescriptions');
        $payment_intent_id = trim($payment_intent_id);
        if ($payment_intent_id === '') {
            return null;
        }
        // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        $val = $wpdb->get_var($wpdb->prepare(
            "SELECT id FROM {$table} WHERE payment_intent_id = %s",
            $payment_intent_id
        ));
        if ($val === null) {
            return null;
        }
        return (int) $val;
    }
}
