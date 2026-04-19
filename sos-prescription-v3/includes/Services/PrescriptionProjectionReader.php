<?php
// includes/Services/PrescriptionProjectionReader.php

declare(strict_types=1);

namespace SosPrescription\Services;

use wpdb;

final class PrescriptionProjectionReader
{
    public function __construct(
        private wpdb $db,
        private PrescriptionProjectionStore $store
    ) {
    }

    /**
     * @param array<string, mixed> $filters
     * @param array{kind:string,actor:array{role:string,wp_user_id:int}} $actorContext
     * @return array{collection_hash:string,max_updated_at:?string,count:int,rows:array<int,array<string,mixed>>}|null
     */
    public function buildLocalDoctorInboxFreshnessSnapshot(array $filters, array $actorContext): ?array
    {
        if (($actorContext['kind'] ?? '') !== 'doctor') {
            return null;
        }

        $table = $this->store->table();
        $select = ['id'];
        if ($this->store->hasColumn('uid')) {
            $select[] = 'uid';
        }
        if ($this->store->hasColumn('status')) {
            $select[] = 'status';
        }
        if ($this->store->hasColumn('updated_at')) {
            $select[] = 'updated_at';
        }
        if ($this->store->hasColumn('payload_json')) {
            $select[] = 'payload_json';
        }

        $status = isset($filters['status']) && is_scalar($filters['status']) ? strtolower(trim((string) $filters['status'])) : '';
        $limit = max(1, min(200, (int) ($filters['limit'] ?? 100)));
        $offset = max(0, (int) ($filters['offset'] ?? 0));

        $sql = sprintf('SELECT %s FROM `%s` WHERE 1=1', implode(', ', $select), $table);
        if ($status !== '') {
            if (!$this->store->hasColumn('status')) {
                return null;
            }

            $sql = $this->db->prepare($sql . ' AND LOWER(status) = %s', $status);
        }

        $sql .= $this->store->hasColumn('updated_at')
            ? ' ORDER BY updated_at DESC, id DESC'
            : ' ORDER BY id DESC';
        $sql .= sprintf(' LIMIT %d OFFSET %d', $limit, $offset);

        $rows = $this->db->get_results($sql, ARRAY_A);
        if (!is_array($rows)) {
            $rows = [];
        }

        $fingerprintRows = [];
        $maxUpdatedAt = null;
        foreach ($rows as $row) {
            if (!is_array($row)) {
                continue;
            }

            $fingerprint = $this->buildLocalDoctorInboxFingerprint($row);
            $fingerprintRows[] = $fingerprint;

            $candidateUpdatedAt = $this->normalizeUpdatedAtString($fingerprint['updated_at'] ?? null);
            if ($candidateUpdatedAt !== null && ($maxUpdatedAt === null || strcmp($candidateUpdatedAt, $maxUpdatedAt) > 0)) {
                $maxUpdatedAt = $candidateUpdatedAt;
            }
        }

        return [
            'collection_hash' => $this->buildPrescriptionCollectionHash($fingerprintRows, $filters, $actorContext),
            'max_updated_at' => $maxUpdatedAt,
            'count' => count($fingerprintRows),
            'rows' => $fingerprintRows,
        ];
    }

    /**
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    public function buildLocalDoctorInboxFingerprint(array $row): array
    {
        $worker = $this->store->extractWorkerShadowState($row);
        $shadow = $this->store->extractLocalShadowState($row);
        $thread = isset($shadow['worker_thread']) && is_array($shadow['worker_thread']) ? $shadow['worker_thread'] : [];
        $evidence = isset($shadow['worker_evidence']) && is_array($shadow['worker_evidence']) ? $shadow['worker_evidence'] : [];

        return [
            'id' => isset($row['id']) && is_numeric($row['id']) ? (int) $row['id'] : 0,
            'uid' => isset($row['uid']) && is_scalar($row['uid']) && trim((string) $row['uid']) !== ''
                ? trim((string) $row['uid'])
                : (isset($worker['uid']) && is_scalar($worker['uid']) ? trim((string) $worker['uid']) : ''),
            'status' => $this->normalizeFingerprintStatus($row['status'] ?? ($worker['status'] ?? null)),
            'updated_at' => $this->normalizeUpdatedAtString($row['updated_at'] ?? ($worker['last_sync_at'] ?? null)),
            'processing_status' => isset($worker['processing_status']) && is_scalar($worker['processing_status'])
                ? strtoupper(trim((string) $worker['processing_status']))
                : '',
            'last_message_seq' => isset($thread['last_message_seq']) && is_numeric($thread['last_message_seq'])
                ? max(0, (int) $thread['last_message_seq'])
                : 0,
            'unread_count_doctor' => isset($thread['unread_count_doctor']) && is_numeric($thread['unread_count_doctor'])
                ? max(0, (int) $thread['unread_count_doctor'])
                : 0,
            'unread_count_patient' => isset($thread['unread_count_patient']) && is_numeric($thread['unread_count_patient'])
                ? max(0, (int) $thread['unread_count_patient'])
                : 0,
            'pdf_ready' => $this->isWorkerPdfReady($worker),
            'has_proof' => !empty($evidence['has_proof']) || (isset($evidence['proof_count']) && (int) $evidence['proof_count'] > 0),
            'proof_count' => isset($evidence['proof_count']) && is_numeric($evidence['proof_count'])
                ? max(0, (int) $evidence['proof_count'])
                : 0,
        ];
    }

    /**
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    public function buildLocalPrescriptionDetailFingerprint(array $row): array
    {
        $worker = $this->store->extractWorkerShadowState($row);
        $fingerprint = $this->buildLocalDoctorInboxFingerprint($row);
        $fingerprint['worker_prescription_id'] = isset($worker['prescription_id']) && is_scalar($worker['prescription_id'])
            ? trim((string) $worker['prescription_id'])
            : '';
        $fingerprint['s3_key_ref'] = isset($worker['s3_key_ref']) && is_scalar($worker['s3_key_ref'])
            ? trim((string) $worker['s3_key_ref'])
            : '';
        $fingerprint['artifact_size_bytes'] = isset($worker['artifact_size_bytes']) && is_numeric($worker['artifact_size_bytes'])
            ? max(0, (int) $worker['artifact_size_bytes'])
            : 0;

        return $fingerprint;
    }

    /**
     * @param array<int, array<string, mixed>> $rows
     * @param array<string, mixed> $filters
     * @param array{kind:string,actor:array{role:string,wp_user_id:int}} $actorContext
     */
    public function buildPrescriptionCollectionHash(array $rows, array $filters, array $actorContext): string
    {
        $payload = [
            'kind' => isset($actorContext['kind']) && is_string($actorContext['kind']) ? $actorContext['kind'] : '',
            'role' => isset($actorContext['actor']['role']) && is_string($actorContext['actor']['role']) ? $actorContext['actor']['role'] : '',
            'status' => isset($filters['status']) && is_scalar($filters['status']) ? strtolower(trim((string) $filters['status'])) : '',
            'limit' => max(1, min(200, (int) ($filters['limit'] ?? 100))),
            'offset' => max(0, (int) ($filters['offset'] ?? 0)),
            'rows' => array_values(array_map([$this, 'sanitizeProxyValue'], $rows)),
        ];

        $encoded = wp_json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if (!is_string($encoded) || $encoded === '') {
            $encoded = serialize($payload);
        }

        return hash('sha256', $encoded);
    }

    /**
     * @param array<string, mixed> $fingerprint
     */
    public function buildPrescriptionDetailHash(array $fingerprint): string
    {
        $payload = [
            'fingerprint' => $this->sanitizeProxyValue($fingerprint),
        ];

        $encoded = wp_json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if (!is_string($encoded) || $encoded === '') {
            $encoded = serialize($payload);
        }

        return hash('sha256', $encoded);
    }

    public function normalizeFreshnessHash(mixed $value): ?string
    {
        if (!is_scalar($value)) {
            return null;
        }

        $normalized = trim((string) $value);
        if ($normalized === '' || strlen($normalized) < 16 || strlen($normalized) > 128) {
            return null;
        }

        return $normalized;
    }

    public function normalizeUpdatedAtString(mixed $value): ?string
    {
        return $this->store->normalizeUpdatedAtString($value);
    }

    private function normalizeFingerprintStatus(mixed $value): string
    {
        if (!is_scalar($value)) {
            return '';
        }

        return strtolower(trim((string) $value));
    }

    /**
     * @param array<string, mixed> $worker
     */
    private function isWorkerPdfReady(array $worker): bool
    {
        if (isset($worker['s3_key_ref']) && is_scalar($worker['s3_key_ref']) && trim((string) $worker['s3_key_ref']) !== '') {
            return true;
        }

        if (isset($worker['artifact_size_bytes']) && is_numeric($worker['artifact_size_bytes']) && (int) $worker['artifact_size_bytes'] > 0) {
            return true;
        }

        return false;
    }

    private function sanitizeProxyValue(mixed $value): mixed
    {
        if (is_array($value)) {
            $out = [];
            foreach ($value as $key => $entry) {
                $safeKey = is_int($key) ? $key : sanitize_key((string) $key);
                $out[$safeKey] = $this->sanitizeProxyValue($entry);
            }

            return $out;
        }

        if (is_bool($value) || is_int($value) || is_float($value) || $value === null) {
            return $value;
        }

        if (is_scalar($value)) {
            return trim((string) $value);
        }

        return '';
    }
}
