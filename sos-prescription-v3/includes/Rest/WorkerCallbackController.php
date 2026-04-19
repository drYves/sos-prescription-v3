<?php // includes/Rest/WorkerCallbackController.php
declare(strict_types=1);

namespace SosPrescription\Rest;

use SosPrescription\Core\Mls1Verifier;
use SosPrescription\Core\NdjsonLogger;
use SosPrescription\Core\NonceStore;
use SOSPrescription\Core\ReqId;
use SOSPrescription\Repositories\FileRepository;
use SOSPrescription\Services\FileStorage;
use SosPrescription\Services\PrescriptionProjectionStore;
use SosPrescription\Services\PrescriptionProjectionSynchronizer;
use WP_Error;
use WP_REST_Request;
use WP_REST_Response;
use wpdb;

require_once dirname(__DIR__) . '/Services/PrescriptionProjectionStore.php';
require_once dirname(__DIR__) . '/Services/PrescriptionProjectionSynchronizer.php';

final class WorkerCallbackController
{
    private string $jobsTable;

    private PrescriptionProjectionSynchronizer $projectionSynchronizer;

    public function __construct(
        private wpdb $db,
        private NdjsonLogger $logger,
        private Mls1Verifier $verifier,
        private string $siteId,
        ?PrescriptionProjectionSynchronizer $projectionSynchronizer = null
    ) {
        $this->jobsTable = $db->prefix . 'sosprescription_jobs';
        $this->projectionSynchronizer = $projectionSynchronizer instanceof PrescriptionProjectionSynchronizer
            ? $projectionSynchronizer
            : new PrescriptionProjectionSynchronizer($db, new PrescriptionProjectionStore($db));
    }

    public static function register(): void
    {
        add_action('rest_api_init', static function (): void {
            $db = $GLOBALS['wpdb'] ?? null;
            if (!($db instanceof wpdb)) {
                return;
            }

            try {
                $siteId = self::readConfigString('ML_SITE_ID', 'unknown_site');
                $env = self::readConfigString('SOSPRESCRIPTION_ENV', 'prod');
                $logger = new NdjsonLogger('web', $siteId, $env);
                $verifier = Mls1Verifier::fromEnv(new NonceStore($db, $siteId), $logger);
                $projectionStore = new PrescriptionProjectionStore($db);
                $projectionSynchronizer = new PrescriptionProjectionSynchronizer($db, $projectionStore);
                $controller = new self($db, $logger, $verifier, $siteId, $projectionSynchronizer);

                register_rest_route('sosprescription/v3', '/worker/jobs/(?P<job_id>[A-Fa-f0-9\-]{36})/callback', [
                    'methods' => 'POST',
                    'permission_callback' => '__return_true',
                    'callback' => [$controller, 'handle'],
                    'args' => [
                        'job_id' => [
                            'validate_callback' => static fn($value): bool => is_string($value) && preg_match('/^[A-Fa-f0-9\-]{36}$/', $value) === 1,
                        ],
                    ],
                ]);

                register_rest_route('sosprescription/v3', '/worker/callback', [
                    'methods' => 'POST',
                    'permission_callback' => '__return_true',
                    'callback' => [$controller, 'handle'],
                ]);

                register_rest_route('sosprescription/v3', '/worker/signatures/file/(?P<file_id>\d+)', [
                    'methods' => 'GET',
                    'permission_callback' => '__return_true',
                    'callback' => [$controller, 'handleSignatureFile'],
                ]);

                register_rest_route('sosprescription/v3', '/worker/signatures/media/(?P<attachment_id>\d+)', [
                    'methods' => 'GET',
                    'permission_callback' => '__return_true',
                    'callback' => [$controller, 'handleSignatureMedia'],
                ]);

                register_rest_route('sosprescription/v3', '/worker/signatures/storage/(?P<storage_ref>[A-Za-z0-9_\-]+)', [
                    'methods' => 'GET',
                    'permission_callback' => '__return_true',
                    'callback' => [$controller, 'handleSignatureStorage'],
                ]);
            } catch (\Throwable $e) {
                $unavailable = static function (): WP_Error {
                    return new WP_Error(
                        'ml_worker_callback_unavailable',
                        'Worker callback endpoint misconfigured.',
                        ['status' => 503]
                    );
                };

                register_rest_route('sosprescription/v3', '/worker/jobs/(?P<job_id>[A-Fa-f0-9\-]{36})/callback', [
                    'methods' => 'POST',
                    'permission_callback' => '__return_true',
                    'callback' => $unavailable,
                ]);

                register_rest_route('sosprescription/v3', '/worker/signatures/file/(?P<file_id>\d+)', [
                    'methods' => 'GET',
                    'permission_callback' => '__return_true',
                    'callback' => $unavailable,
                ]);

                register_rest_route('sosprescription/v3', '/worker/signatures/media/(?P<attachment_id>\d+)', [
                    'methods' => 'GET',
                    'permission_callback' => '__return_true',
                    'callback' => $unavailable,
                ]);

                register_rest_route('sosprescription/v3', '/worker/signatures/storage/(?P<storage_ref>[A-Za-z0-9_\-]+)', [
                    'methods' => 'GET',
                    'permission_callback' => '__return_true',
                    'callback' => $unavailable,
                ]);
            }
        });
    }

    public function handle(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $verified = $this->verifier->verifyJsonBodySigned($request, 'worker_callback');
        if (is_wp_error($verified)) {
            return $verified;
        }

        $data = is_array($verified['data'] ?? null) ? $verified['data'] : [];
        $reqId = ReqId::coalesce(isset($verified['req_id']) && is_string($verified['req_id']) ? $verified['req_id'] : null);

        if (($data['schema_version'] ?? null) !== '2026.5') {
            return new WP_Error('ml_schema', 'Schema mismatch', ['status' => 400]);
        }
        if (($data['site_id'] ?? null) !== $this->siteId) {
            return new WP_Error('ml_site', 'Site mismatch', ['status' => 403]);
        }

        $job = is_array($data['job'] ?? null) ? $data['job'] : null;
        if (!is_array($job)) {
            return new WP_Error('ml_job', 'Missing job payload', ['status' => 400]);
        }

        $pathJobId = trim((string) ($request->get_param('job_id') ?? ''));
        $bodyJobId = trim((string) ($job['job_id'] ?? ''));
        $jobId = $pathJobId !== '' ? $pathJobId : $bodyJobId;

        if (!$this->isValidJobId($jobId)) {
            return new WP_Error('ml_job_id', 'Invalid job_id', ['status' => 400]);
        }
        if ($bodyJobId === '' || !$this->isValidJobId($bodyJobId) || $bodyJobId !== $jobId) {
            return new WP_Error('ml_job_id_mismatch', 'job_id mismatch between path and payload', ['status' => 400]);
        }

        $status = strtoupper(trim((string) ($job['status'] ?? '')));
        if (!in_array($status, ['DONE', 'FAILED', 'PENDING'], true)) {
            return new WP_Error('ml_job_status', 'Invalid job status', ['status' => 400]);
        }

        $row = $this->db->get_row(
            $this->db->prepare(
                "SELECT job_id, status, req_id, site_id, attempts, max_attempts FROM `{$this->jobsTable}` WHERE job_id = %s AND site_id = %s LIMIT 1",
                $jobId,
                $this->siteId
            ),
            ARRAY_A
        );
        if (!is_array($row)) {
            $this->logger->warning('worker.callback.unknown_job', ['job_id' => $jobId], $reqId);
            return new WP_Error('ml_job_not_found', 'Job not found', ['status' => 404]);
        }

        $currentStatus = strtoupper((string) ($row['status'] ?? ''));
        if (in_array($currentStatus, ['DONE', 'FAILED'], true)) {
            if ($currentStatus === $status) {
                $this->logger->info('worker.callback.idempotent', [
                    'job_id' => $jobId,
                    'current_status' => $currentStatus,
                    'incoming_status' => $status,
                ], $reqId);

                $projectionSync = $this->projectionSynchronizer->syncProjectionFromJobCallback($jobId, $data, $this->siteId, $reqId);
                if (is_wp_error($projectionSync)) {
                    return $projectionSync;
                }

                do_action('sosprescription_v3_worker_callback_received', $jobId, $status, $data, $reqId);
                return new WP_REST_Response(['ok' => true, 'idempotent' => true, 'job_id' => $jobId, 'status' => $currentStatus], 200);
            }

            return new WP_Error('ml_job_terminal', 'Job already completed with a different terminal status', ['status' => 409]);
        }

        $workerRef = $this->sanitizeWorkerRef(
            (string) ($job['worker_ref'] ?? ($data['worker_ref'] ?? ''))
        );

        if ($status === 'DONE') {
            $done = $this->handleDone($jobId, $job, $workerRef, $reqId);
            if (is_wp_error($done)) {
                return $done;
            }

            do_action('sosprescription_v3_job_done', $jobId, $data, $reqId);
        } elseif ($status === 'PENDING') {
            $requeued = $this->handleRequeue($jobId, $job, $workerRef, $reqId);
            if (is_wp_error($requeued)) {
                return $requeued;
            }

            do_action('sosprescription_v3_job_requeued', $jobId, $data, $reqId);
        } else {
            $failed = $this->handleFailed($jobId, $job, $workerRef, $reqId);
            if (is_wp_error($failed)) {
                return $failed;
            }

            do_action('sosprescription_v3_job_failed', $jobId, $data, $reqId);
        }

        $projectionSync = $this->projectionSynchronizer->syncProjectionFromJobCallback($jobId, $data, $this->siteId, $reqId);
        if (is_wp_error($projectionSync)) {
            return $projectionSync;
        }

        do_action('sosprescription_v3_worker_callback_received', $jobId, $status, $data, $reqId);
        return new WP_REST_Response(['ok' => true, 'job_id' => $jobId, 'status' => $status], 200);
    }

    /**
     * @param array<string, mixed> $job
     */
    private function handleDone(string $jobId, array $job, string $workerRef, string $reqId): true|WP_Error
    {
        $artifact = is_array($job['artifact'] ?? null) ? $job['artifact'] : [];
        $s3KeyRef = $this->sanitizeS3KeyRef(
            $this->pickString($job, 's3_key_ref', $artifact, 's3_key_ref')
        );

        if ($s3KeyRef === '') {
            return new WP_Error('ml_s3_key', 'Invalid s3_key_ref', ['status' => 400]);
        }

        $shaHex = $this->sanitizeSha256Hex(
            $this->pickString($job, 'artifact_sha256_hex', $artifact, 'sha256_hex')
        );
        if ($shaHex === '' && isset($artifact['sha256']) && is_string($artifact['sha256'])) {
            $candidate = strtolower(trim($artifact['sha256']));
            if (str_starts_with($candidate, 'sha256:')) {
                $shaHex = $this->sanitizeSha256Hex(substr($candidate, 7));
            }
        }

        $artifactSizeBytes = $this->pickNullablePositiveInt($job, 'artifact_size_bytes', $artifact, 'size_bytes');
        $contentType = $this->sanitizeContentType(
            $this->pickString($job, 'artifact_content_type', $artifact, 'content_type')
        );
        $s3Bucket = $this->sanitizeShortString($this->pickString($job, 's3_bucket', $artifact, 's3_bucket'), 191);
        $s3Region = $this->sanitizeShortString($this->pickString($job, 's3_region', $artifact, 's3_region'), 64);

        $sql = "UPDATE `{$this->jobsTable}`
                SET
                    status = 'DONE',
                    s3_key_ref = %s,
                    s3_bucket = %s,
                    s3_region = %s,
                    artifact_sha256 = " . ($shaHex !== '' ? 'UNHEX(%s)' : 'NULL') . ",
                    artifact_size = %d,
                    artifact_size_bytes = " . ($artifactSizeBytes !== null ? '%d' : 'NULL') . ",
                    artifact_content_type = %s,
                    completed_at = NOW(3),
                    finished_at = NOW(3),
                    last_error_code = NULL,
                    last_error_message = NULL,
                    last_error_message_safe = NULL,
                    last_error_at = NULL,
                    locked_at = NULL,
                    lock_expires_at = NULL,
                    locked_by = NULL,
                    worker_ref = %s,
                    updated_at = NOW(3)
                WHERE job_id = %s
                  AND site_id = %s";

        $args = [$s3KeyRef, $s3Bucket, $s3Region];
        if ($shaHex !== '') {
            $args[] = $shaHex;
        }
        $args[] = $artifactSizeBytes !== null ? $artifactSizeBytes : 0;
        if ($artifactSizeBytes !== null) {
            $args[] = $artifactSizeBytes;
        }
        $args[] = $contentType;
        $args[] = $workerRef;
        $args[] = $jobId;
        $args[] = $this->siteId;

        $updated = $this->db->query($this->db->prepare($sql, ...$args));
        if (!is_int($updated) || $updated !== 1) {
            return new WP_Error('ml_callback_update_failed', 'Unable to persist DONE callback.', ['status' => 500]);
        }

        $this->logger->info('worker.callback.done', [
            'job_id' => $jobId,
            's3_key_ref' => $s3KeyRef,
            'artifact_size_bytes' => $artifactSizeBytes,
            'artifact_content_type' => $contentType,
            'worker_ref' => $workerRef !== '' ? $workerRef : null,
        ], $reqId);

        return true;
    }

    /**
     * @param array<string, mixed> $job
     */
    private function handleFailed(string $jobId, array $job, string $workerRef, string $reqId): true|WP_Error
    {
        $error = is_array($job['error'] ?? null) ? $job['error'] : [];
        $code = $this->sanitizeErrorCode(
            $this->pickString($job, 'last_error_code', $error, 'code')
        );
        $messageSafe = $this->sanitizeSafeMessage(
            $this->pickString($job, 'last_error_message_safe', $error, 'message_safe')
        );

        $updated = $this->db->query($this->db->prepare(
            "UPDATE `{$this->jobsTable}`
             SET
                status = 'FAILED',
                last_error_code = %s,
                last_error_message = %s,
                last_error_message_safe = %s,
                last_error_at = NOW(3),
                completed_at = NOW(3),
                finished_at = NOW(3),
                locked_at = NULL,
                lock_expires_at = NULL,
                locked_by = NULL,
                worker_ref = %s,
                updated_at = NOW(3)
             WHERE job_id = %s
               AND site_id = %s",
            $code,
            $messageSafe,
            $messageSafe,
            $workerRef,
            $jobId,
            $this->siteId
        ));

        if (!is_int($updated) || $updated !== 1) {
            return new WP_Error('ml_callback_update_failed', 'Unable to persist FAILED callback.', ['status' => 500]);
        }

        $this->logger->warning('worker.callback.failed', [
            'job_id' => $jobId,
            'error_code' => $code,
            'worker_ref' => $workerRef !== '' ? $workerRef : null,
        ], $reqId);

        return true;
    }

    /**
     * @param array<string, mixed> $job
     */
    private function handleRequeue(string $jobId, array $job, string $workerRef, string $reqId): true|WP_Error
    {
        $error = is_array($job['error'] ?? null) ? $job['error'] : [];
        $code = $this->sanitizeErrorCode(
            $this->pickString($job, 'last_error_code', $error, 'code')
        );
        $messageSafe = $this->sanitizeSafeMessage(
            $this->pickString($job, 'last_error_message_safe', $error, 'message_safe')
        );

        $retryAfterSeconds = $this->sanitizeRetryAfterSeconds(
            $this->pickNullablePositiveInt($job, 'retry_after_seconds', null, null)
        );

        $updated = $this->db->query($this->db->prepare(
            "UPDATE `{$this->jobsTable}`
             SET
                status = 'PENDING',
                available_at = DATE_ADD(NOW(3), INTERVAL %d SECOND),
                last_error_code = %s,
                last_error_message = %s,
                last_error_message_safe = %s,
                last_error_at = NOW(3),
                completed_at = NULL,
                finished_at = NULL,
                locked_at = NULL,
                lock_expires_at = NULL,
                locked_by = NULL,
                worker_ref = %s,
                updated_at = NOW(3)
             WHERE job_id = %s
               AND site_id = %s",
            $retryAfterSeconds,
            $code,
            $messageSafe,
            $messageSafe,
            $workerRef,
            $jobId,
            $this->siteId
        ));

        if (!is_int($updated) || $updated !== 1) {
            return new WP_Error('ml_callback_update_failed', 'Unable to persist requeue callback.', ['status' => 500]);
        }

        $this->logger->warning('worker.callback.requeued', [
            'job_id' => $jobId,
            'retry_after_seconds' => $retryAfterSeconds,
            'error_code' => $code,
            'worker_ref' => $workerRef !== '' ? $workerRef : null,
        ], $reqId);

        return true;
    }

    public function handleSignatureFile(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $verified = $this->verifyWorkerSignatureRequest($request, 'worker_signature_file');
        if (is_wp_error($verified)) {
            return $verified;
        }

        $fileId = (int) $request->get_param('file_id');
        if ($fileId < 1) {
            return new WP_Error('ml_signature_file_id', 'Invalid signature file ID.', ['status' => 400]);
        }

        $repo = new FileRepository();
        $row = $repo->get($fileId);
        if (!is_array($row)) {
            return new WP_Error('ml_signature_not_found', 'Signature not found.', ['status' => 404]);
        }

        $purpose = isset($row['purpose']) ? (string) $row['purpose'] : '';
        if (!in_array($purpose, ['doctor_signature', 'doctor_stamp'], true)) {
            return new WP_Error('ml_signature_forbidden', 'Signature access denied.', ['status' => 403]);
        }

        $storageKey = isset($row['storage_key']) ? (string) $row['storage_key'] : '';
        $path = FileStorage::safe_abs_path($storageKey);
        if (is_wp_error($path)) {
            return new WP_Error('ml_signature_missing', 'Signature not found.', ['status' => 404]);
        }

        $mime = isset($row['mime']) ? (string) $row['mime'] : '';
        $name = isset($row['original_name']) ? (string) $row['original_name'] : 'signature';
        $this->streamImageFileResponse($path, $mime, $name);
        return new WP_REST_Response(['ok' => true], 200);
    }

    public function handleSignatureMedia(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $verified = $this->verifyWorkerSignatureRequest($request, 'worker_signature_media');
        if (is_wp_error($verified)) {
            return $verified;
        }

        $attachmentId = (int) $request->get_param('attachment_id');
        if ($attachmentId < 1) {
            return new WP_Error('ml_signature_attachment_id', 'Invalid signature attachment ID.', ['status' => 400]);
        }

        $path = get_attached_file($attachmentId);
        if (!is_string($path) || trim($path) === '' || !is_file($path)) {
            return new WP_Error('ml_signature_not_found', 'Signature not found.', ['status' => 404]);
        }

        $mime = get_post_mime_type($attachmentId);
        $name = get_the_title($attachmentId);
        $fallbackName = is_string($name) && trim($name) !== '' ? $name : 'signature';
        $this->streamImageFileResponse($path, is_string($mime) ? $mime : '', $fallbackName);
        return new WP_REST_Response(['ok' => true], 200);
    }

    public function handleSignatureStorage(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $verified = $this->verifyWorkerSignatureRequest($request, 'worker_signature_storage');
        if (is_wp_error($verified)) {
            return $verified;
        }

        $encoded = trim((string) $request->get_param('storage_ref'));
        $decoded = $this->decodeBase64Url($encoded);
        if ($decoded === '') {
            return new WP_Error('ml_signature_storage_ref', 'Invalid storage reference.', ['status' => 400]);
        }

        $path = FileStorage::safe_abs_path($decoded);
        if (is_wp_error($path)) {
            return new WP_Error('ml_signature_not_found', 'Signature not found.', ['status' => 404]);
        }

        $this->streamImageFileResponse($path, '', basename($decoded));
        return new WP_REST_Response(['ok' => true], 200);
    }

    private function verifyWorkerSignatureRequest(WP_REST_Request $request, string $scope): array|WP_Error
    {
        $route = (string) $request->get_route();
        return $this->verifier->verifyCanonicalGet($request, $route, $scope);
    }

    private function streamImageFileResponse(string $path, string $mime, string $name): void
    {
        if (!is_file($path)) {
            wp_die('Signature introuvable.', 'Signature introuvable', ['response' => 404]);
        }

        $resolvedMime = $this->inferImageMimeType($path, $mime);
        if ($resolvedMime === '') {
            wp_die('Type de signature non supporté.', 'Signature invalide', ['response' => 415]);
        }

        $size = (int) (@filesize($path) ?: 0);
        $fallback = preg_replace('/[^A-Za-z0-9._-]/', '_', $name);
        $fallback = is_string($fallback) && $fallback !== '' ? $fallback : 'signature';

        while (ob_get_level()) {
            @ob_end_clean();
        }

        nocache_headers();
        header('Content-Type: ' . $resolvedMime);
        header('X-Content-Type-Options: nosniff');
        header('Cache-Control: private, no-store, no-cache, must-revalidate, max-age=0');
        header('Pragma: no-cache');
        header('Content-Disposition: inline; filename="' . $fallback . '"');
        if ($size > 0) {
            header('Content-Length: ' . (string) $size);
        }

        readfile($path);
        exit;
    }

    private function inferImageMimeType(string $path, string $mime): string
    {
        $candidate = trim($mime);
        if ($candidate !== '' && str_starts_with($candidate, 'image/')) {
            return $candidate;
        }

        $wpType = wp_check_filetype($path);
        $type = isset($wpType['type']) && is_string($wpType['type']) ? trim($wpType['type']) : '';
        if ($type !== '' && str_starts_with($type, 'image/')) {
            return $type;
        }

        $ext = strtolower((string) pathinfo($path, PATHINFO_EXTENSION));
        return match ($ext) {
            'png' => 'image/png',
            'jpg', 'jpeg' => 'image/jpeg',
            'webp' => 'image/webp',
            'gif' => 'image/gif',
            'svg' => 'image/svg+xml',
            default => '',
        };
    }

    private function decodeBase64Url(string $value): string
    {
        $normalized = trim($value);
        if ($normalized === '') {
            return '';
        }

        $padding = (4 - (strlen($normalized) % 4)) % 4;
        $base64 = strtr($normalized, '-_', '+/') . str_repeat('=', $padding);
        $decoded = base64_decode($base64, true);
        return is_string($decoded) ? trim($decoded) : '';
    }

    /**
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

    private function sanitizeRetryAfterSeconds(?int $value): int
    {
        if ($value === null) {
            return 30;
        }

        return max(1, min(900, $value));
    }

    private function isValidJobId(string $jobId): bool
    {
        return preg_match('/^[A-Fa-f0-9\-]{36}$/', $jobId) === 1;
    }

    private static function readConfigString(string $name, string $default = ''): string
    {
        if (defined($name)) {
            $value = constant($name);
            if (is_string($value)) {
                return $value;
            }
            if (is_scalar($value)) {
                return (string) $value;
            }
        }

        $value = getenv($name);
        if (is_string($value)) {
            return $value;
        }

        return $default;
    }
}
