<?php
// includes/Services/PrescriptionProjectionStore.php

declare(strict_types=1);

namespace SosPrescription\Services;

use WP_Error;
use wpdb;

final class PrescriptionProjectionStore
{
    /** @var array<string, true>|null */
    private ?array $prescriptionTableColumnsCache = null;

    public function __construct(private wpdb $db)
    {
    }

    public function table(): string
    {
        return $this->db->prefix . 'sosprescription_prescriptions';
    }

    public function hasColumn(string $column): bool
    {
        $columns = $this->columns();
        return isset($columns[$column]);
    }

    /**
     * @return array<string, true>
     */
    public function columns(): array
    {
        if (is_array($this->prescriptionTableColumnsCache)) {
            return $this->prescriptionTableColumnsCache;
        }

        $table = $this->table();
        $safeTable = str_replace('`', '', $table);
        $rows = $this->db->get_results("SHOW COLUMNS FROM `{$safeTable}`", ARRAY_A);
        $columns = [];
        if (is_array($rows)) {
            foreach ($rows as $row) {
                if (!is_array($row) || empty($row['Field'])) {
                    continue;
                }
                $columns[(string) $row['Field']] = true;
            }
        }

        $this->prescriptionTableColumnsCache = $columns;
        return $columns;
    }

    /**
     * @param mixed $payload
     * @return array<string, mixed>
     */
    public function normalizePayload(mixed $payload): array
    {
        if (is_array($payload)) {
            $encoded = wp_json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            if (is_string($encoded) && $encoded !== '') {
                $decoded = json_decode($encoded, true);
                if (is_array($decoded)) {
                    return $decoded;
                }
            }

            return $payload;
        }

        if (is_object($payload)) {
            $encoded = wp_json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            if (is_string($encoded) && $encoded !== '') {
                $decoded = json_decode($encoded, true);
                if (is_array($decoded)) {
                    return $decoded;
                }
            }
        }

        if (is_string($payload)) {
            $trimmed = trim($payload);
            if ($trimmed !== '' && ($trimmed[0] === '{' || $trimmed[0] === '[')) {
                $decoded = json_decode($trimmed, true);
                if (is_array($decoded)) {
                    return $decoded;
                }
            }
        }

        return [];
    }

    public function normalizeUpdatedAtString(mixed $value): ?string
    {
        if (!is_scalar($value)) {
            return null;
        }

        $normalized = trim((string) $value);
        return $normalized === '' ? null : $normalized;
    }

    /**
     * @return array<string, mixed>|null
     */
    public function findLocalPrescriptionStubById(int $id): ?array
    {
        $id = (int) $id;
        if ($id < 1) {
            return null;
        }

        $table = $this->table();
        $select = ['id'];
        if ($this->hasColumn('uid')) {
            $select[] = 'uid';
        }
        if ($this->hasColumn('status')) {
            $select[] = 'status';
        }
        if ($this->hasColumn('updated_at')) {
            $select[] = 'updated_at';
        }
        if ($this->hasColumn('payload_json')) {
            $select[] = 'payload_json';
        }
        if ($this->hasColumn('verify_token')) {
            $select[] = 'verify_token';
        }
        if ($this->hasColumn('verify_code')) {
            $select[] = 'verify_code';
        }

        $sql = $this->db->prepare(
            sprintf('SELECT %s FROM `%s` WHERE id = %%d LIMIT 1', implode(', ', $select), $table),
            $id
        );
        $row = $this->db->get_row($sql, ARRAY_A);

        return is_array($row) ? $row : null;
    }

    /**
     * @return array<string, mixed>|null
     */
    public function findLocalPrescriptionRowById(int $id): ?array
    {
        $id = (int) $id;
        if ($id < 1) {
            return null;
        }

        $table = $this->table();
        $row = $this->db->get_row(
            $this->db->prepare(
                "SELECT * FROM `{$table}` WHERE id = %d LIMIT 1",
                $id
            ),
            ARRAY_A
        );

        return is_array($row) ? $row : null;
    }

    public function findLocalPrescriptionIdByUid(string $uid): int
    {
        $uid = trim($uid);
        if ($uid === '') {
            return 0;
        }

        $mapped = $this->findLocalPrescriptionIdsByUid([$uid]);
        return isset($mapped[$uid]) ? (int) $mapped[$uid] : 0;
    }

    /**
     * @param array<int, string> $uids
     * @return array<string, int>
     */
    public function findLocalPrescriptionIdsByUid(array $uids): array
    {
        if ($uids === [] || !$this->hasColumn('uid')) {
            return [];
        }

        $uids = array_values(array_unique(array_filter(array_map(static function ($value): string {
            return is_string($value) ? trim($value) : '';
        }, $uids), static fn(string $uid): bool => $uid !== '')));
        if ($uids === []) {
            return [];
        }

        $table = $this->table();
        $placeholders = implode(',', array_fill(0, count($uids), '%s'));
        $sql = $this->db->prepare(
            "SELECT id, uid FROM `{$table}` WHERE uid IN ({$placeholders})",
            $uids
        );

        $rows = $this->db->get_results($sql, ARRAY_A);
        if (!is_array($rows)) {
            return [];
        }

        $out = [];
        foreach ($rows as $row) {
            if (!is_array($row)) {
                continue;
            }
            $uid = isset($row['uid']) && is_scalar($row['uid']) ? trim((string) $row['uid']) : '';
            $id = isset($row['id']) && is_numeric($row['id']) ? (int) $row['id'] : 0;
            if ($uid === '' || $id < 1) {
                continue;
            }
            $out[$uid] = $id;
        }

        return $out;
    }

    /**
     * @param array<int, array<string, mixed>> $rows
     * @return array<int, array<string, mixed>>
     */
    public function swapWorkerRowIdsWithLocalIds(array $rows): array
    {
        $uids = [];
        foreach ($rows as $row) {
            if (!is_array($row)) {
                continue;
            }

            $uid = isset($row['uid']) && is_scalar($row['uid']) ? trim((string) $row['uid']) : '';
            if ($uid === '') {
                continue;
            }

            $uids[] = $uid;
        }

        try {
            $localIdsByUid = $this->findLocalPrescriptionIdsByUid($uids);
        } catch (\Throwable $e) {
            $localIdsByUid = [];
        }

        foreach ($rows as $index => $row) {
            if (!is_array($row)) {
                continue;
            }

            $uid = isset($row['uid']) && is_scalar($row['uid']) ? trim((string) $row['uid']) : '';
            if ($uid === '') {
                continue;
            }

            try {
                if (!isset($localIdsByUid[$uid])) {
                    $localId = $this->ensureLocalPrescriptionStubForWorkerRow($row);
                    if ($localId > 0) {
                        $localIdsByUid[$uid] = $localId;
                    }
                }

                if (!isset($localIdsByUid[$uid])) {
                    continue;
                }

                $rows[$index]['id'] = (int) $localIdsByUid[$uid];
            } catch (\Throwable $e) {
            }
        }

        return $rows;
    }

    /**
     * @param array<string, mixed> $row
     */
    public function ensureLocalPrescriptionStubForWorkerRow(array $row): int
    {
        $uid = isset($row['uid']) && is_scalar($row['uid']) ? trim((string) $row['uid']) : '';
        if ($uid === '') {
            return 0;
        }

        $existingId = $this->findLocalPrescriptionIdByUid($uid);
        if ($existingId > 0) {
            return $existingId;
        }

        $workerPrescriptionId = $this->extractWorkerPrescriptionIdFromWorkerRow($row);
        $status = $this->normalizeLocalStubStatus($row['status'] ?? null);

        return $this->insertLocalPrescriptionStub($uid, $status, $workerPrescriptionId);
    }

    /**
     * @param array<string, mixed> $row
     */
    public function extractWorkerPrescriptionIdFromWorkerRow(array $row): string
    {
        $candidate = isset($row['worker_prescription_id']) && is_scalar($row['worker_prescription_id'])
            ? trim((string) $row['worker_prescription_id'])
            : '';
        if ($this->isValidWorkerPrescriptionId($candidate)) {
            return $candidate;
        }

        $candidate = isset($row['id']) && is_scalar($row['id']) ? trim((string) $row['id']) : '';
        if ($this->isValidWorkerPrescriptionId($candidate)) {
            return $candidate;
        }

        $payload = $this->normalizePayload($row['payload'] ?? []);
        $payloadNode = $this->normalizePayload($payload['payload'] ?? []);
        $worker = $this->normalizePayload($payloadNode['worker'] ?? ($payload['worker'] ?? []));
        $candidate = isset($worker['prescription_id']) && is_scalar($worker['prescription_id'])
            ? trim((string) $worker['prescription_id'])
            : '';

        return $this->isValidWorkerPrescriptionId($candidate) ? $candidate : '';
    }

    public function extractWorkerPrescriptionIdFromLocalRow(array $row): string
    {
        $worker = $this->extractWorkerShadowState($row);
        $candidate = isset($worker['prescription_id']) && is_scalar($worker['prescription_id'])
            ? trim((string) $worker['prescription_id'])
            : '';

        return $this->isValidWorkerPrescriptionId($candidate) ? $candidate : '';
    }

    public function insertLocalPrescriptionStub(string $uid, string $status, string $workerPrescriptionId): int
    {
        $uid = trim($uid);
        if ($uid === '' || !$this->hasColumn('uid')) {
            return 0;
        }

        $existingId = $this->findLocalPrescriptionIdByUid($uid);
        if ($existingId > 0) {
            return $existingId;
        }

        $table = $this->table();
        $now = current_time('mysql');
        $data = [
            'uid' => $uid,
        ];
        $formats = ['%s'];

        if ($this->hasColumn('status')) {
            $data['status'] = $status;
            $formats[] = '%s';
        }
        if ($this->hasColumn('payload_json')) {
            $data['payload_json'] = $this->buildLocalStubPayloadJson($workerPrescriptionId);
            $formats[] = '%s';
        }
        if ($this->hasColumn('created_at')) {
            $data['created_at'] = $now;
            $formats[] = '%s';
        }
        if ($this->hasColumn('updated_at')) {
            $data['updated_at'] = $now;
            $formats[] = '%s';
        }

        $inserted = $this->db->insert($table, $data, $formats);
        if ($inserted !== false) {
            return (int) $this->db->insert_id;
        }

        return $this->findLocalPrescriptionIdByUid($uid);
    }

    public function buildLocalStubPayloadJson(string $workerPrescriptionId): string
    {
        $payload = [
            'shadow' => [
                'mode' => 'worker-postgres',
                'zero_pii' => true,
            ],
            'worker' => [
                'prescription_id' => trim($workerPrescriptionId),
            ],
        ];

        $json = wp_json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        return is_string($json) && $json !== ''
            ? $json
            : '{"shadow":{"mode":"worker-postgres","zero_pii":true},"worker":{"prescription_id":""}}';
    }

    public function normalizeLocalStubStatus(mixed $value): string
    {
        if (!is_scalar($value)) {
            return 'pending';
        }

        $status = strtolower(trim((string) $value));
        return $status !== '' ? $status : 'pending';
    }

    /**
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    public function extractWorkerShadowState(array $row): array
    {
        $payload = isset($row['payload']) && is_array($row['payload']) ? $row['payload'] : [];
        if ($payload === [] && isset($row['payload_json']) && is_string($row['payload_json']) && $row['payload_json'] !== '') {
            $decoded = json_decode($row['payload_json'], true);
            if (is_array($decoded)) {
                $payload = $decoded;
            }
        }

        $payloadNode = $this->normalizePayload($payload['payload'] ?? []);
        return $this->normalizePayload($payloadNode['worker'] ?? ($payload['worker'] ?? []));
    }

    /**
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    public function extractLocalShadowState(array $row): array
    {
        $payload = isset($row['payload']) && is_array($row['payload']) ? $row['payload'] : [];
        if ($payload === [] && isset($row['payload_json']) && is_string($row['payload_json']) && $row['payload_json'] !== '') {
            $decoded = json_decode($row['payload_json'], true);
            if (is_array($decoded)) {
                $payload = $decoded;
            }
        }

        $payloadNode = $this->normalizePayload($payload['payload'] ?? []);
        return $this->normalizePayload($payloadNode['shadow'] ?? ($payload['shadow'] ?? []));
    }

    /**
     * @param array<string, mixed> $workerData
     * @return array<string, mixed>
     */
    public function buildWorkerShadowPayload(array $workerData): array
    {
        $lastSyncAt = $this->normalizeUpdatedAtString($workerData['last_sync_at'] ?? null);
        if ($lastSyncAt === null) {
            $lastSyncAt = current_time('mysql');
        }

        return [
            'prescription_id' => isset($workerData['prescription_id']) && is_scalar($workerData['prescription_id']) ? (string) $workerData['prescription_id'] : '',
            'job_id' => isset($workerData['job_id']) && is_scalar($workerData['job_id']) ? (string) $workerData['job_id'] : '',
            'uid' => isset($workerData['uid']) && is_scalar($workerData['uid']) ? (string) $workerData['uid'] : '',
            'status' => isset($workerData['status']) && is_scalar($workerData['status']) ? (string) $workerData['status'] : 'PENDING',
            'processing_status' => isset($workerData['processing_status']) && is_scalar($workerData['processing_status']) ? (string) $workerData['processing_status'] : 'PENDING',
            'source_req_id' => isset($workerData['source_req_id']) && is_scalar($workerData['source_req_id']) ? (string) $workerData['source_req_id'] : '',
            'verify_token' => isset($workerData['verify_token']) && is_scalar($workerData['verify_token']) ? (string) $workerData['verify_token'] : '',
            'verify_code' => isset($workerData['verify_code']) && is_scalar($workerData['verify_code']) ? (string) $workerData['verify_code'] : '',
            's3_key_ref' => isset($workerData['s3_key_ref']) && is_scalar($workerData['s3_key_ref']) ? (string) $workerData['s3_key_ref'] : '',
            's3_bucket' => isset($workerData['s3_bucket']) && is_scalar($workerData['s3_bucket']) ? (string) $workerData['s3_bucket'] : '',
            's3_region' => isset($workerData['s3_region']) && is_scalar($workerData['s3_region']) ? (string) $workerData['s3_region'] : '',
            'artifact_sha256_hex' => isset($workerData['artifact_sha256_hex']) && is_scalar($workerData['artifact_sha256_hex']) ? (string) $workerData['artifact_sha256_hex'] : '',
            'artifact_size_bytes' => isset($workerData['artifact_size_bytes']) && is_numeric($workerData['artifact_size_bytes']) ? (int) $workerData['artifact_size_bytes'] : null,
            'artifact_content_type' => isset($workerData['artifact_content_type']) && is_scalar($workerData['artifact_content_type']) ? (string) $workerData['artifact_content_type'] : '',
            'last_error_code' => isset($workerData['last_error_code']) && is_scalar($workerData['last_error_code']) ? (string) $workerData['last_error_code'] : '',
            'last_error_message_safe' => isset($workerData['last_error_message_safe']) && is_scalar($workerData['last_error_message_safe']) ? (string) $workerData['last_error_message_safe'] : '',
            'last_sync_at' => $lastSyncAt,
        ];
    }

    /**
     * @param array<string, mixed> $workerData
     * @return true|WP_Error
     */
    public function storeShadowWorkerState(int $prescriptionId, array $workerData): true|WP_Error
    {
        $table = $this->table();
        $row = $this->db->get_row(
            $this->db->prepare(
                "SELECT id, payload_json FROM `{$table}` WHERE id = %d LIMIT 1",
                $prescriptionId
            ),
            ARRAY_A
        );

        if (!is_array($row)) {
            $sqlError = is_string($this->db->last_error) ? trim((string) $this->db->last_error) : '';
            return new WP_Error(
                'shadow_store_payload',
                $sqlError !== '' ? $sqlError : 'Shadow record introuvable avant synchronisation du payload.',
                ['status' => 422]
            );
        }

        $payload = json_decode((string) ($row['payload_json'] ?? '{}'), true);
        if (!is_array($payload)) {
            $payload = [];
        }

        $existingWorker = isset($payload['worker']) && is_array($payload['worker']) ? $payload['worker'] : [];
        $incomingWorker = $this->buildWorkerShadowPayload($workerData);

        $proofArtifactIds = isset($payload['proof_artifact_ids']) && is_array($payload['proof_artifact_ids'])
            ? $this->normalizeWorkerArtifactIds($payload['proof_artifact_ids'])
            : [];

        $existingShadow = isset($payload['shadow']) && is_array($payload['shadow']) ? $payload['shadow'] : [];
        $payload['shadow'] = array_merge($existingShadow, [
            'zero_pii' => true,
            'mode' => 'worker-postgres',
        ]);

        if (!isset($payload['shadow']['worker_thread']) || !is_array($payload['shadow']['worker_thread'])) {
            $payload['shadow']['worker_thread'] = [
                'message_count' => 0,
                'last_message_seq' => 0,
                'last_message_at' => null,
                'last_message_role' => null,
                'doctor_last_read_seq' => 0,
                'patient_last_read_seq' => 0,
                'unread_count_doctor' => 0,
                'unread_count_patient' => 0,
            ];
        }

        if (!isset($payload['shadow']['worker_evidence']) || !is_array($payload['shadow']['worker_evidence'])) {
            $payload['shadow']['worker_evidence'] = [
                'has_proof' => $proofArtifactIds !== [],
                'proof_count' => count($proofArtifactIds),
                'proof_artifact_ids' => $proofArtifactIds,
            ];
        } else {
            $payload['shadow']['worker_evidence']['has_proof'] = $proofArtifactIds !== [];
            $payload['shadow']['worker_evidence']['proof_count'] = count($proofArtifactIds);
            $payload['shadow']['worker_evidence']['proof_artifact_ids'] = $proofArtifactIds;
        }

        $payload['worker'] = $this->mergeShadowWorkerPayload($existingWorker, $incomingWorker);

        $update = [
            'payload_json' => wp_json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
            'updated_at' => current_time('mysql'),
        ];
        $formats = ['%s', '%s'];

        if (
            $this->hasColumn('verify_token')
            && isset($incomingWorker['verify_token'])
            && is_scalar($incomingWorker['verify_token'])
            && (string) $incomingWorker['verify_token'] !== ''
        ) {
            $update['verify_token'] = (string) $incomingWorker['verify_token'];
            $formats[] = '%s';
        }
        if (
            $this->hasColumn('verify_code')
            && isset($incomingWorker['verify_code'])
            && is_scalar($incomingWorker['verify_code'])
            && (string) $incomingWorker['verify_code'] !== ''
        ) {
            $update['verify_code'] = (string) $incomingWorker['verify_code'];
            $formats[] = '%s';
        }

        $updated = $this->db->update(
            $table,
            $update,
            ['id' => $prescriptionId],
            $formats,
            ['%d']
        );

        if ($updated === false) {
            $sqlError = is_string($this->db->last_error) ? trim((string) $this->db->last_error) : '';
            return new WP_Error(
                'shadow_store_payload',
                $sqlError !== '' ? $sqlError : 'Échec SQL local lors de la mise à jour du payload shadow.',
                ['status' => 422]
            );
        }

        return true;
    }

    /**
     * @param array<string, mixed> $existing
     * @param array<string, mixed> $incoming
     * @return array<string, mixed>
     */
    public function mergeShadowWorkerPayload(array $existing, array $incoming): array
    {
        $merged = $existing;
        foreach ($incoming as $key => $value) {
            if ($this->shouldPreserveExistingWorkerValue($key, $value, $existing, $incoming)) {
                continue;
            }
            $merged[$key] = $value;
        }

        return $merged;
    }

    /**
     * @param array<string, mixed> $existing
     * @param array<string, mixed> $incoming
     */
    public function shouldPreserveExistingWorkerValue(string $key, mixed $value, array $existing, array $incoming): bool
    {
        $stickyStringKeys = [
            's3_key_ref',
            's3_bucket',
            's3_region',
            'artifact_sha256_hex',
            'artifact_content_type',
            'verify_token',
            'verify_code',
        ];

        if (in_array($key, $stickyStringKeys, true)) {
            return (!is_scalar($value) || trim((string) $value) === '')
                && isset($existing[$key])
                && is_scalar($existing[$key])
                && trim((string) $existing[$key]) !== '';
        }

        if ($key === 'artifact_size_bytes') {
            return ($value === null || (is_numeric($value) && (int) $value <= 0))
                && isset($existing[$key])
                && is_numeric($existing[$key])
                && (int) $existing[$key] > 0;
        }

        if ($key === 'last_error_code' || $key === 'last_error_message_safe') {
            $status = isset($incoming['status']) && is_scalar($incoming['status']) ? strtoupper(trim((string) $incoming['status'])) : '';
            $processing = isset($incoming['processing_status']) && is_scalar($incoming['processing_status']) ? strtoupper(trim((string) $incoming['processing_status'])) : '';
            if (in_array($status, ['DONE', 'APPROVED'], true) || $processing === 'DONE') {
                return false;
            }

            return (!is_scalar($value) || trim((string) $value) === '')
                && isset($existing[$key])
                && is_scalar($existing[$key])
                && trim((string) $existing[$key]) !== '';
        }

        return false;
    }

    public function findShadowPrescriptionIdByWorkerPrescriptionId(string $workerPrescriptionId): int
    {
        $workerPrescriptionId = trim($workerPrescriptionId);
        if (!$this->isValidWorkerPrescriptionId($workerPrescriptionId)) {
            return 0;
        }

        $table = $this->table();
        $id = $this->db->get_var($this->db->prepare(
            "SELECT id FROM `{$table}` WHERE JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.worker.prescription_id')) = %s LIMIT 1",
            $workerPrescriptionId
        ));

        if (is_numeric($id) && (int) $id > 0) {
            return (int) $id;
        }

        $like = '%"prescription_id":"' . $this->db->esc_like($workerPrescriptionId) . '"%';
        $id = $this->db->get_var($this->db->prepare(
            "SELECT id FROM `{$table}` WHERE payload_json LIKE %s LIMIT 1",
            $like
        ));

        return is_numeric($id) && (int) $id > 0 ? (int) $id : 0;
    }

    /**
     * @param mixed $value
     * @return array<int, string>
     */
    public function normalizeWorkerArtifactIds(mixed $value): array
    {
        if (!is_array($value)) {
            return [];
        }

        $out = [];
        foreach ($value as $raw) {
            if ($raw === null || !is_scalar($raw)) {
                continue;
            }

            $id = trim((string) $raw);
            if ($id === '' || preg_match('/^[A-Za-z0-9\-]{8,64}$/', $id) !== 1) {
                continue;
            }

            $out[] = $id;
            if (count($out) >= 10) {
                break;
            }
        }

        return array_values(array_unique($out));
    }

    public function isValidWorkerPrescriptionId(string $value): bool
    {
        return preg_match('/^[A-Fa-f0-9\-]{36}$/', trim($value)) === 1;
    }
}
