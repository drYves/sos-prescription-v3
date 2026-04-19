<?php
// includes/Services/PrescriptionProjectionSynchronizer.php

declare(strict_types=1);

namespace SosPrescription\Services;

use DateTimeImmutable;
use WP_Error;
use wpdb;

final class PrescriptionProjectionSynchronizer
{
    private string $jobsTable;

    public function __construct(
        private wpdb $db,
        private PrescriptionProjectionStore $store
    ) {
        $this->jobsTable = $db->prefix . 'sosprescription_jobs';
    }

    /**
     * @param array<string, mixed> $workerUpdate
     * @return true|WP_Error
     */
    public function applyWorkerUpdate(int $localPrescriptionId, array $workerUpdate): true|WP_Error
    {
        $localRow = $this->store->findLocalPrescriptionRowById($localPrescriptionId);
        if (!is_array($localRow)) {
            return new WP_Error(
                'shadow_sync_target_not_found',
                'Projection locale introuvable pour la synchronisation Worker.',
                ['status' => 422]
            );
        }

        $preparedUpdate = $this->prepareWorkerUpdateForWrite($localRow, $workerUpdate);
        if (!$this->shouldApplyWorkerUpdate($localRow, $preparedUpdate)) {
            return true;
        }

        return $this->store->storeShadowWorkerState($localPrescriptionId, $preparedUpdate);
    }

    /**
     * @param array<string, mixed> $job
     * @return array<string, mixed>
     */
    public function buildLegacyCallbackWorkerUpdate(array $job, string $workerPrescriptionId, string $reqId): array
    {
        $artifact = is_array($job['artifact'] ?? null) ? $job['artifact'] : [];
        $error = is_array($job['error'] ?? null) ? $job['error'] : [];
        $status = $this->normalizeWorkerCallbackStatus($job['status'] ?? 'DONE');
        $processing = $this->normalizeWorkerProcessingStatus($job['processing_status'] ?? $status, $status);

        $artifactShaHex = $this->sanitizeSha256Hex(
            $this->pickString($job, 'artifact_sha256_hex', $artifact, 'sha256_hex')
        );
        if ($artifactShaHex === '' && isset($artifact['sha256']) && is_string($artifact['sha256'])) {
            $candidate = strtolower(trim($artifact['sha256']));
            if (str_starts_with($candidate, 'sha256:')) {
                $artifactShaHex = $this->sanitizeSha256Hex(substr($candidate, 7));
            }
        }

        return [
            'prescription_id' => $workerPrescriptionId,
            'job_id' => isset($job['job_id']) && is_scalar($job['job_id']) && trim((string) $job['job_id']) !== ''
                ? trim((string) $job['job_id'])
                : $workerPrescriptionId,
            'status' => $status,
            'processing_status' => $processing,
            'source_req_id' => isset($job['source_req_id']) && is_scalar($job['source_req_id']) ? (string) $job['source_req_id'] : $reqId,
            'worker_ref' => $this->sanitizeWorkerRef((string) ($job['worker_ref'] ?? '')),
            's3_key_ref' => $this->sanitizeS3KeyRef(
                $this->pickString($job, 's3_key_ref', $artifact, 's3_key_ref')
            ),
            's3_bucket' => $this->sanitizeShortString($this->pickString($job, 's3_bucket', $artifact, 's3_bucket'), 191),
            's3_region' => $this->sanitizeShortString($this->pickString($job, 's3_region', $artifact, 's3_region'), 64),
            'artifact_sha256_hex' => $artifactShaHex,
            'artifact_size_bytes' => $this->pickNullablePositiveInt($job, 'artifact_size_bytes', $artifact, 'size_bytes'),
            'artifact_content_type' => $this->sanitizeContentType(
                $this->pickString($job, 'artifact_content_type', $artifact, 'content_type')
            ),
            'last_error_code' => $status === 'FAILED'
                ? $this->sanitizeErrorCode($this->pickString($job, 'last_error_code', $error, 'code'))
                : '',
            'last_error_message_safe' => $status === 'FAILED'
                ? $this->sanitizeSafeMessage($this->pickString($job, 'last_error_message_safe', $error, 'message_safe'))
                : '',
            'last_sync_at' => $this->selectEventTimestamp([$job, $artifact, $error]) ?? current_time('mysql'),
        ];
    }

    /**
     * @param array<string, mixed> $callbackData
     * @return true|WP_Error
     */
    public function syncProjectionFromJobCallback(string $jobId, array $callbackData, string $siteId, string $reqId): true|WP_Error
    {
        $jobRow = $this->loadJobRow($jobId, $siteId);
        if (!is_array($jobRow)) {
            return new WP_Error(
                'shadow_sync_job_not_found',
                'Job callback introuvable pour la synchronisation de projection.',
                ['status' => 404]
            );
        }

        $localId = isset($jobRow['rx_id']) && is_numeric($jobRow['rx_id']) ? (int) $jobRow['rx_id'] : 0;
        if ($localId < 1) {
            $job = is_array($callbackData['job'] ?? null) ? $callbackData['job'] : [];
            $candidateWorkerId = isset($job['prescription_id']) && is_scalar($job['prescription_id'])
                ? trim((string) $job['prescription_id'])
                : '';
            if ($this->store->isValidWorkerPrescriptionId($candidateWorkerId)) {
                $localId = $this->store->findShadowPrescriptionIdByWorkerPrescriptionId($candidateWorkerId);
            }
        }

        if ($localId < 1) {
            return new WP_Error(
                'shadow_sync_target_missing',
                'Prescription locale introuvable pour la synchronisation Worker.',
                ['status' => 422]
            );
        }

        $localRow = $this->store->findLocalPrescriptionRowById($localId);
        if (!is_array($localRow)) {
            return new WP_Error(
                'shadow_sync_target_not_found',
                'Projection locale introuvable pour la synchronisation Worker.',
                ['status' => 422]
            );
        }

        $workerUpdate = $this->buildWorkerUpdateFromJobRow($jobRow, $callbackData, $localRow, $reqId);
        return $this->applyWorkerUpdate($localId, $workerUpdate);
    }

    /**
     * @return array<string, mixed>|null
     */
    private function loadJobRow(string $jobId, string $siteId): ?array
    {
        $row = $this->db->get_row(
            $this->db->prepare(
                "SELECT *, LOWER(HEX(artifact_sha256)) AS artifact_sha256_hex_read FROM `{$this->jobsTable}` WHERE job_id = %s AND site_id = %s LIMIT 1",
                $jobId,
                $siteId
            ),
            ARRAY_A
        );

        return is_array($row) ? $row : null;
    }

    /**
     * @param array<string, mixed> $jobRow
     * @param array<string, mixed> $callbackData
     * @param array<string, mixed> $localRow
     * @return array<string, mixed>
     */

    /**
     * @param array<string, mixed> $localRow
     * @param array<string, mixed> $workerUpdate
     * @return array<string, mixed>
     */
    private function prepareWorkerUpdateForWrite(array $localRow, array $workerUpdate): array
    {
        $existingWorker = $this->store->extractWorkerShadowState($localRow);
        $existingTs = $this->store->normalizeUpdatedAtString($existingWorker['last_sync_at'] ?? ($localRow['updated_at'] ?? null));
        $incomingTs = $this->store->normalizeUpdatedAtString($workerUpdate['last_sync_at'] ?? null);

        if ($existingTs !== null) {
            $existingComparableTs = $this->normalizeComparableTimestamp($existingTs);
            $incomingComparableTs = $incomingTs !== null ? $this->normalizeComparableTimestamp($incomingTs) : null;
            if ($incomingComparableTs === null || ($existingComparableTs !== null && $incomingComparableTs < $existingComparableTs)) {
                $workerUpdate['last_sync_at'] = $existingTs;
            }
        }

        return $workerUpdate;
    }

    private function buildWorkerUpdateFromJobRow(array $jobRow, array $callbackData, array $localRow, string $reqId): array
    {
        $job = is_array($callbackData['job'] ?? null) ? $callbackData['job'] : [];
        $artifact = is_array($job['artifact'] ?? null) ? $job['artifact'] : [];
        $error = is_array($job['error'] ?? null) ? $job['error'] : [];

        $status = $this->normalizeWorkerCallbackStatus($jobRow['status'] ?? ($job['status'] ?? 'PENDING'));
        $processing = $this->normalizeWorkerProcessingStatus($job['processing_status'] ?? ($jobRow['processing_status'] ?? $status), $status);
        $workerPrescriptionId = $this->resolveWorkerPrescriptionId($localRow, $job, (string) ($jobRow['job_id'] ?? ''));

        $artifactShaHex = '';
        if (isset($jobRow['artifact_sha256_hex_read']) && is_scalar($jobRow['artifact_sha256_hex_read'])) {
            $artifactShaHex = $this->sanitizeSha256Hex((string) $jobRow['artifact_sha256_hex_read']);
        }
        if ($artifactShaHex === '') {
            $artifactShaHex = $this->sanitizeSha256Hex(
                $this->pickString($job, 'artifact_sha256_hex', $artifact, 'sha256_hex')
            );
            if ($artifactShaHex === '' && isset($artifact['sha256']) && is_string($artifact['sha256'])) {
                $candidate = strtolower(trim($artifact['sha256']));
                if (str_starts_with($candidate, 'sha256:')) {
                    $artifactShaHex = $this->sanitizeSha256Hex(substr($candidate, 7));
                }
            }
        }

        $lastErrorCode = '';
        $lastErrorMessageSafe = '';
        if ($status === 'FAILED') {
            $lastErrorCode = $this->sanitizeErrorCode(
                isset($jobRow['last_error_code']) && is_scalar($jobRow['last_error_code'])
                    ? (string) $jobRow['last_error_code']
                    : $this->pickString($job, 'last_error_code', $error, 'code')
            );
            $lastErrorMessageSafe = $this->sanitizeSafeMessage(
                isset($jobRow['last_error_message_safe']) && is_scalar($jobRow['last_error_message_safe'])
                    ? (string) $jobRow['last_error_message_safe']
                    : $this->pickString($job, 'last_error_message_safe', $error, 'message_safe')
            );
        }

        return [
            'prescription_id' => $workerPrescriptionId,
            'job_id' => isset($jobRow['job_id']) && is_scalar($jobRow['job_id']) ? (string) $jobRow['job_id'] : '',
            'uid' => isset($localRow['uid']) && is_scalar($localRow['uid']) ? trim((string) $localRow['uid']) : '',
            'status' => $status,
            'processing_status' => $processing,
            'source_req_id' => isset($jobRow['req_id']) && is_scalar($jobRow['req_id']) && trim((string) $jobRow['req_id']) !== ''
                ? trim((string) $jobRow['req_id'])
                : (isset($job['source_req_id']) && is_scalar($job['source_req_id']) ? trim((string) $job['source_req_id']) : $reqId),
            'worker_ref' => isset($jobRow['worker_ref']) && is_scalar($jobRow['worker_ref'])
                ? $this->sanitizeWorkerRef((string) $jobRow['worker_ref'])
                : $this->sanitizeWorkerRef((string) ($job['worker_ref'] ?? '')),
            's3_key_ref' => isset($jobRow['s3_key_ref']) && is_scalar($jobRow['s3_key_ref'])
                ? $this->sanitizeS3KeyRef((string) $jobRow['s3_key_ref'])
                : $this->sanitizeS3KeyRef($this->pickString($job, 's3_key_ref', $artifact, 's3_key_ref')),
            's3_bucket' => isset($jobRow['s3_bucket']) && is_scalar($jobRow['s3_bucket'])
                ? $this->sanitizeShortString((string) $jobRow['s3_bucket'], 191)
                : $this->sanitizeShortString($this->pickString($job, 's3_bucket', $artifact, 's3_bucket'), 191),
            's3_region' => isset($jobRow['s3_region']) && is_scalar($jobRow['s3_region'])
                ? $this->sanitizeShortString((string) $jobRow['s3_region'], 64)
                : $this->sanitizeShortString($this->pickString($job, 's3_region', $artifact, 's3_region'), 64),
            'artifact_sha256_hex' => $artifactShaHex,
            'artifact_size_bytes' => isset($jobRow['artifact_size_bytes']) && is_numeric($jobRow['artifact_size_bytes'])
                ? max(0, (int) $jobRow['artifact_size_bytes'])
                : $this->pickNullablePositiveInt($job, 'artifact_size_bytes', $artifact, 'size_bytes'),
            'artifact_content_type' => isset($jobRow['artifact_content_type']) && is_scalar($jobRow['artifact_content_type'])
                ? $this->sanitizeContentType((string) $jobRow['artifact_content_type'])
                : $this->sanitizeContentType($this->pickString($job, 'artifact_content_type', $artifact, 'content_type')),
            'last_error_code' => $lastErrorCode,
            'last_error_message_safe' => $lastErrorMessageSafe,
            'last_sync_at' => $this->selectEventTimestamp([$jobRow, $job, $artifact, $error]) ?? current_time('mysql'),
        ];
    }

    /**
     * @param array<string, mixed> $localRow
     * @param array<string, mixed> $incomingUpdate
     */
    private function shouldApplyWorkerUpdate(array $localRow, array $incomingUpdate): bool
    {
        $existingWorker = $this->store->extractWorkerShadowState($localRow);
        $incomingPayload = $this->store->buildWorkerShadowPayload($incomingUpdate);
        $mergedPayload = $this->store->mergeShadowWorkerPayload($existingWorker, $incomingPayload);

        if ($this->workerStateDigest($mergedPayload) === $this->workerStateDigest($existingWorker)) {
            return false;
        }

        if ($this->isStaleWorkerUpdate($localRow, $existingWorker, $incomingPayload)) {
            return false;
        }

        return true;
    }

    /**
     * @param array<string, mixed> $localRow
     * @param array<string, mixed> $existingWorker
     * @param array<string, mixed> $incomingPayload
     */
    private function isStaleWorkerUpdate(array $localRow, array $existingWorker, array $incomingPayload): bool
    {
        if ($this->incomingAddsMissingStableData($existingWorker, $incomingPayload)) {
            return false;
        }

        $existingTs = $this->normalizeComparableTimestamp($existingWorker['last_sync_at'] ?? ($localRow['updated_at'] ?? null));
        $incomingTs = $this->normalizeComparableTimestamp($incomingPayload['last_sync_at'] ?? null);
        $existingRank = $this->workerStateRank($existingWorker);
        $incomingRank = $this->workerStateRank($incomingPayload);

        if ($incomingTs !== null && $existingTs !== null) {
            if ($incomingTs < $existingTs) {
                return true;
            }

            if ($incomingTs === $existingTs && $incomingRank <= $existingRank) {
                return true;
            }

            return false;
        }

        if ($incomingTs === null && $existingTs !== null) {
            return $incomingRank <= $existingRank;
        }

        if ($incomingTs !== null && $existingTs === null) {
            return false;
        }

        return $incomingRank <= $existingRank;
    }

    /**
     * @param array<string, mixed> $existingWorker
     * @param array<string, mixed> $incomingPayload
     */
    private function incomingAddsMissingStableData(array $existingWorker, array $incomingPayload): bool
    {
        $stableStringKeys = [
            'prescription_id',
            'job_id',
            'uid',
            'source_req_id',
            'worker_ref',
            'verify_token',
            'verify_code',
            's3_key_ref',
            's3_bucket',
            's3_region',
            'artifact_sha256_hex',
            'artifact_content_type',
        ];

        foreach ($stableStringKeys as $key) {
            $incomingValue = isset($incomingPayload[$key]) && is_scalar($incomingPayload[$key])
                ? trim((string) $incomingPayload[$key])
                : '';
            $existingValue = isset($existingWorker[$key]) && is_scalar($existingWorker[$key])
                ? trim((string) $existingWorker[$key])
                : '';

            if ($incomingValue !== '' && $existingValue === '') {
                return true;
            }
        }

        $incomingSize = isset($incomingPayload['artifact_size_bytes']) && is_numeric($incomingPayload['artifact_size_bytes'])
            ? (int) $incomingPayload['artifact_size_bytes']
            : 0;
        $existingSize = isset($existingWorker['artifact_size_bytes']) && is_numeric($existingWorker['artifact_size_bytes'])
            ? (int) $existingWorker['artifact_size_bytes']
            : 0;

        return $incomingSize > 0 && $existingSize <= 0;
    }

    /**
     * @param array<string, mixed> $worker
     */
    private function workerStateRank(array $worker): int
    {
        $status = $this->normalizeWorkerCallbackStatus($worker['status'] ?? 'PENDING');
        $processing = $this->normalizeWorkerProcessingStatus($worker['processing_status'] ?? $status, $status);

        return match ($status) {
            'DONE', 'APPROVED' => 400,
            'FAILED', 'REJECTED' => 300,
            'CLAIMED' => 200,
            default => match ($processing) {
                'done' => 400,
                'failed' => 300,
                'claimed' => 200,
                default => 100,
            },
        };
    }

    /**
     * @param array<string, mixed> $worker
     */
    private function workerStateDigest(array $worker): string
    {
        $encoded = wp_json_encode($worker, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if (!is_string($encoded) || $encoded === '') {
            $encoded = serialize($worker);
        }

        return hash('sha256', $encoded);
    }

    /**
     * @param list<array<string, mixed>> $nodes
     */
    private function selectEventTimestamp(array $nodes): ?string
    {
        foreach ($nodes as $node) {
            foreach (['updated_at', 'completed_at', 'finished_at', 'last_sync_at', 'event_at', 'timestamp'] as $key) {
                if (!array_key_exists($key, $node)) {
                    continue;
                }

                $candidate = $this->store->normalizeUpdatedAtString($node[$key]);
                if ($candidate !== null) {
                    return $candidate;
                }
            }
        }

        return null;
    }

    private function normalizeComparableTimestamp(mixed $value): ?string
    {
        if (!is_scalar($value)) {
            return null;
        }

        $raw = trim((string) $value);
        if ($raw === '') {
            return null;
        }

        $formats = [
            'Y-m-d H:i:s.u',
            'Y-m-d H:i:s',
            'Y-m-d\TH:i:s.uP',
            'Y-m-d\TH:i:sP',
            'Y-m-d\TH:i:s.u',
            'Y-m-d\TH:i:s',
        ];
        foreach ($formats as $format) {
            $date = DateTimeImmutable::createFromFormat($format, $raw);
            if ($date instanceof DateTimeImmutable) {
                return $date->format('Y-m-d H:i:s.u');
            }
        }

        $timestamp = strtotime($raw);
        if ($timestamp === false) {
            return null;
        }

        return gmdate('Y-m-d H:i:s.000000', $timestamp);
    }

    /**
     * @param array<string, mixed> $localRow
     * @param array<string, mixed> $job
     */
    private function resolveWorkerPrescriptionId(array $localRow, array $job, string $jobId): string
    {
        $existing = $this->store->extractWorkerPrescriptionIdFromLocalRow($localRow);
        if ($this->store->isValidWorkerPrescriptionId($existing)) {
            return $existing;
        }

        $candidate = isset($job['prescription_id']) && is_scalar($job['prescription_id'])
            ? trim((string) $job['prescription_id'])
            : '';
        if ($this->store->isValidWorkerPrescriptionId($candidate) && $candidate !== $jobId) {
            return $candidate;
        }

        return '';
    }

    /**
     * @param array<string, mixed> $primary
     * @param array<string, mixed>|null $secondary
     */
    private function pickString(array $primary, string $primaryKey, ?array $secondary, ?string $secondaryKey): string
    {
        if (isset($primary[$primaryKey]) && is_string($primary[$primaryKey])) {
            return (string) $primary[$primaryKey];
        }

        if ($secondary !== null && $secondaryKey !== null && isset($secondary[$secondaryKey]) && is_string($secondary[$secondaryKey])) {
            return (string) $secondary[$secondaryKey];
        }

        return '';
    }

    /**
     * @param array<string, mixed> $primary
     * @param array<string, mixed>|null $secondary
     */
    private function pickNullablePositiveInt(array $primary, string $primaryKey, ?array $secondary, ?string $secondaryKey): ?int
    {
        if (isset($primary[$primaryKey]) && is_numeric($primary[$primaryKey])) {
            $value = (int) $primary[$primaryKey];
            return $value >= 0 ? $value : null;
        }

        if ($secondary !== null && $secondaryKey !== null && isset($secondary[$secondaryKey]) && is_numeric($secondary[$secondaryKey])) {
            $value = (int) $secondary[$secondaryKey];
            return $value >= 0 ? $value : null;
        }

        return null;
    }

    private function normalizeWorkerCallbackStatus(mixed $value): string
    {
        $status = strtoupper(trim((string) $value));
        if (in_array($status, ['DONE', 'FAILED', 'PENDING', 'CLAIMED', 'APPROVED', 'REJECTED'], true)) {
            return $status;
        }

        return 'PENDING';
    }

    private function normalizeWorkerProcessingStatus(mixed $value, string $fallbackStatus = 'PENDING'): string
    {
        $processing = strtolower(trim((string) $value));
        if (in_array($processing, ['done', 'failed', 'pending', 'claimed', 'waiting_approval'], true)) {
            return $processing;
        }

        $fallback = strtoupper(trim($fallbackStatus));
        if ($fallback === 'DONE') {
            return 'done';
        }
        if ($fallback === 'FAILED' || $fallback === 'REJECTED') {
            return 'failed';
        }
        if ($fallback === 'CLAIMED') {
            return 'claimed';
        }

        return 'pending';
    }

    private function sanitizeWorkerRef(string $workerRef): string
    {
        $workerRef = trim($workerRef);
        if ($workerRef === '') {
            return '';
        }

        return substr(sanitize_text_field($workerRef), 0, 191);
    }

    private function sanitizeS3KeyRef(string $value): string
    {
        $value = trim($value);
        if ($value === '' || str_starts_with(strtolower($value), 'http')) {
            return '';
        }

        return substr($value, 0, 1024);
    }

    private function sanitizeSha256Hex(string $value): string
    {
        $value = strtolower(trim($value));
        if ($value === '') {
            return '';
        }

        return preg_match('/^[0-9a-f]{64}$/', $value) === 1 ? $value : '';
    }

    private function sanitizeContentType(string $value): string
    {
        $value = trim($value);
        if ($value === '') {
            return 'application/pdf';
        }

        return substr(sanitize_text_field($value), 0, 128);
    }

    private function sanitizeErrorCode(string $value): string
    {
        $value = trim($value);
        if ($value === '') {
            return 'ML_WORKER_FAILED';
        }

        return substr(preg_replace('/[^A-Z0-9_\-]/i', '_', strtoupper($value)) ?? 'ML_WORKER_FAILED', 0, 64);
    }

    private function sanitizeSafeMessage(string $value): string
    {
        $value = trim(wp_strip_all_tags($value));
        if ($value === '') {
            return 'Worker reported failure';
        }

        return substr($value, 0, 255);
    }

    private function sanitizeShortString(string $value, int $maxLen): string
    {
        $value = trim($value);
        if ($value === '') {
            return '';
        }

        return substr(sanitize_text_field($value), 0, $maxLen);
    }
}
