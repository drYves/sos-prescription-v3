<?php // includes/Rest/WorkerClaimController.php
declare(strict_types=1);

namespace SOSPrescription\Rest;

use SOSPrescription\Core\Mls1Verifier;
use SOSPrescription\Core\NdjsonLogger;
use SOSPrescription\Core\NonceStore;
use SOSPrescription\Core\ReqId;
use WP_Error;
use WP_REST_Request;
use WP_REST_Response;
use wpdb;

final class WorkerClaimController
{
    private string $jobsTable;

    public function __construct(
        private wpdb $db,
        private NdjsonLogger $logger,
        private Mls1Verifier $verifier,
        private string $siteId
    ) {
        $this->jobsTable = $db->prefix . 'sosprescription_jobs';
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
                $nonceStore = new NonceStore($db, $siteId);
                $verifier = Mls1Verifier::fromEnv($nonceStore, $logger);
                $controller = new self($db, $logger, $verifier, $siteId);

                register_rest_route('sosprescription/v3', '/worker/jobs/claim', [
                    'methods' => 'POST',
                    'permission_callback' => '__return_true',
                    'callback' => [$controller, 'handle'],
                ]);
            } catch (\Throwable $e) {
                register_rest_route('sosprescription/v3', '/worker/jobs/claim', [
                    'methods' => 'POST',
                    'permission_callback' => '__return_true',
                    'callback' => static function (): WP_Error {
                        return new WP_Error(
                            'ml_worker_claim_unavailable',
                            'Worker claim endpoint misconfigured.',
                            ['status' => 503]
                        );
                    },
                ]);
            }
        });
    }

    public function handle(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $verified = $this->verifier->verifyJsonBodySigned($request, 'worker_claim');
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

        $workerRef = $this->extractWorkerRef($data);
        if (is_wp_error($workerRef)) {
            return $workerRef;
        }

        $leaseSeconds = $this->extractLeaseSeconds($data);
        if (is_wp_error($leaseSeconds)) {
            return $leaseSeconds;
        }

        $recovered = $this->recoverExpiredClaims($reqId);
        if ($recovered['requeued'] > 0 || $recovered['failed'] > 0) {
            $this->logger->warning('worker.claim.recovered_expired_claims', $recovered, $reqId);
        }

        $job = $this->claimOnePendingJob($workerRef, $leaseSeconds, $reqId);
        if (is_wp_error($job)) {
            return $job;
        }

        if ($job === null) {
            $this->logger->info('worker.claim.empty', [
                'worker_ref' => $workerRef !== '' ? $workerRef : null,
                'lease_seconds' => $leaseSeconds,
            ], $reqId);

            return new WP_REST_Response([
                'ok' => true,
                'job' => null,
                'req_id' => $reqId,
            ], 200);
        }

        $jobReqId = isset($job['req_id']) && is_string($job['req_id']) && $job['req_id'] !== ''
            ? (string) $job['req_id']
            : $reqId;

        $this->logger->info('worker.claim.granted', [
            'job_id' => (string) ($job['job_id'] ?? ''),
            'rx_id' => (int) ($job['rx_id'] ?? 0),
            'worker_ref' => $workerRef !== '' ? $workerRef : null,
            'lease_seconds' => $leaseSeconds,
            'attempts' => (int) ($job['attempts'] ?? 0),
            'max_attempts' => (int) ($job['max_attempts'] ?? 0),
        ], $jobReqId);

        return new WP_REST_Response([
            'ok' => true,
            'job' => $job,
            'req_id' => $jobReqId,
        ], 200);
    }

    /**
     * @return array{requeued:int,failed:int}
     */
    private function recoverExpiredClaims(string $reqId): array
    {
        $requeued = $this->db->query($this->db->prepare(
            "UPDATE `{$this->jobsTable}`
             SET
                status = 'PENDING',
                available_at = DATE_ADD(NOW(3), INTERVAL 30 SECOND),
                last_error_code = 'ML_LEASE_EXPIRED',
                last_error_message = 'Lease expired; job requeued by claim controller.',
                last_error_message_safe = 'Lease expirée ; job remis en file.',
                last_error_at = NOW(3),
                locked_at = NULL,
                lock_expires_at = NULL,
                locked_by = NULL,
                updated_at = NOW(3)
             WHERE site_id = %s
               AND status = 'CLAIMED'
               AND lock_expires_at IS NOT NULL
               AND lock_expires_at < NOW(3)
               AND attempts < max_attempts",
            $this->siteId
        ));

        $failed = $this->db->query($this->db->prepare(
            "UPDATE `{$this->jobsTable}`
             SET
                status = 'FAILED',
                last_error_code = 'ML_MAX_ATTEMPTS_EXCEEDED',
                last_error_message = 'Maximum attempts reached after lease expiry.',
                last_error_message_safe = 'Nombre maximal de tentatives atteint.',
                last_error_at = NOW(3),
                completed_at = NOW(3),
                finished_at = NOW(3),
                locked_at = NULL,
                lock_expires_at = NULL,
                locked_by = NULL,
                updated_at = NOW(3)
             WHERE site_id = %s
               AND status = 'CLAIMED'
               AND lock_expires_at IS NOT NULL
               AND lock_expires_at < NOW(3)
               AND attempts >= max_attempts",
            $this->siteId
        ));

        return [
            'requeued' => is_int($requeued) && $requeued > 0 ? $requeued : 0,
            'failed' => is_int($failed) && $failed > 0 ? $failed : 0,
        ];
    }

    /**
     * @return array<string, mixed>|null|WP_Error
     */
    private function claimOnePendingJob(string $workerRef, int $leaseSeconds, string $reqId): array|WP_Error|null
    {
        $started = $this->db->query('START TRANSACTION');
        if ($started === false) {
            return new WP_Error('ml_worker_claim_tx', 'Unable to start claim transaction.', ['status' => 500]);
        }

        try {
            $row = $this->selectPendingJobForUpdate();
            if ($row === null) {
                $this->db->query('COMMIT');
                return null;
            }

            $id = isset($row['id']) ? (int) $row['id'] : 0;
            if ($id < 1) {
                $this->db->query('ROLLBACK');
                return new WP_Error('ml_worker_claim_row', 'Invalid queued job row.', ['status' => 500]);
            }

            $lockedBy = $workerRef !== '' ? $workerRef : 'rest-bridge';
            $updated = $this->db->query($this->db->prepare(
                "UPDATE `{$this->jobsTable}`
                 SET
                    status = 'CLAIMED',
                    attempts = attempts + 1,
                    locked_at = NOW(3),
                    lock_expires_at = DATE_ADD(NOW(3), INTERVAL %d SECOND),
                    locked_by = %s,
                    worker_ref = %s,
                    started_at = IF(started_at IS NULL, NOW(3), started_at),
                    updated_at = NOW(3)
                 WHERE id = %d
                   AND site_id = %s
                   AND status = 'PENDING'",
                $leaseSeconds,
                $lockedBy,
                $lockedBy,
                $id,
                $this->siteId
            ));

            if (!is_int($updated) || $updated !== 1) {
                $this->db->query('ROLLBACK');
                return null;
            }

            $claimed = $this->getJobRowById($id);
            if ($claimed === null) {
                $this->db->query('ROLLBACK');
                return new WP_Error('ml_worker_claim_reload', 'Unable to reload claimed job.', ['status' => 500]);
            }

            $this->db->query('COMMIT');
            return $this->serializeJobRow($claimed);
        } catch (\Throwable $e) {
            $this->db->query('ROLLBACK');
            $this->logger->error('worker.claim.exception', [
                'message' => 'Unhandled claim exception',
                'db_error' => (string) $this->db->last_error,
            ], $reqId, $e);

            return new WP_Error('ml_worker_claim_exception', 'Unhandled worker claim exception.', ['status' => 500]);
        }
    }

    /**
     * @return array<string, mixed>|null
     */
    private function selectPendingJobForUpdate(): ?array
    {
        $row = $this->selectPendingJobWithClause('FOR UPDATE SKIP LOCKED');
        if ($row !== null) {
            return $row;
        }

        $lastError = (string) $this->db->last_error;
        if ($lastError !== '') {
            $this->logger->warning('worker.claim.skip_locked_fallback', [
                'db_error' => $lastError,
            ]);
            return $this->selectPendingJobWithClause('FOR UPDATE');
        }

        return null;
    }

    /**
     * @return array<string, mixed>|null
     */
    private function selectPendingJobWithClause(string $lockClause): ?array
    {
        $sql = $this->db->prepare(
            "SELECT
                id,
                job_id,
                site_id,
                req_id,
                job_type,
                status,
                priority,
                available_at,
                rx_id,
                nonce,
                kid,
                exp_ms,
                payload,
                mls1_token,
                s3_key_ref,
                attempts,
                max_attempts,
                locked_at,
                lock_expires_at,
                locked_by,
                worker_ref,
                created_at,
                updated_at
             FROM `{$this->jobsTable}`
             WHERE site_id = %s
               AND job_type = 'PDF_GEN'
               AND status = 'PENDING'
               AND available_at <= NOW(3)
               AND job_id IS NOT NULL
               AND job_id <> ''
             ORDER BY available_at ASC, priority ASC, created_at ASC, id ASC
             LIMIT 1
             {$lockClause}",
            $this->siteId
        );

        $row = $this->db->get_row($sql, ARRAY_A);
        return is_array($row) ? $row : null;
    }

    /**
     * @return array<string, mixed>|null
     */
    private function getJobRowById(int $id): ?array
    {
        $sql = $this->db->prepare(
            "SELECT
                id,
                job_id,
                site_id,
                req_id,
                job_type,
                status,
                priority,
                available_at,
                rx_id,
                nonce,
                kid,
                exp_ms,
                payload,
                mls1_token,
                s3_key_ref,
                attempts,
                max_attempts,
                locked_at,
                lock_expires_at,
                locked_by,
                worker_ref,
                created_at,
                updated_at
             FROM `{$this->jobsTable}`
             WHERE id = %d
             LIMIT 1",
            $id
        );

        $row = $this->db->get_row($sql, ARRAY_A);
        return is_array($row) ? $row : null;
    }

    /**
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    private function serializeJobRow(array $row): array
    {
        $payloadRaw = isset($row['payload']) ? (string) $row['payload'] : '';
        $payload = json_decode($payloadRaw, true);
        if (!is_array($payload)) {
            $payload = null;
        }

        return [
            'id' => isset($row['id']) ? (int) $row['id'] : 0,
            'job_id' => isset($row['job_id']) ? (string) $row['job_id'] : '',
            'site_id' => isset($row['site_id']) ? (string) $row['site_id'] : $this->siteId,
            'req_id' => isset($row['req_id']) && $row['req_id'] !== null ? (string) $row['req_id'] : null,
            'job_type' => isset($row['job_type']) ? (string) $row['job_type'] : 'PDF_GEN',
            'status' => isset($row['status']) ? (string) $row['status'] : 'PENDING',
            'priority' => isset($row['priority']) ? (int) $row['priority'] : 50,
            'available_at' => isset($row['available_at']) && $row['available_at'] !== null ? (string) $row['available_at'] : null,
            'rx_id' => isset($row['rx_id']) ? (int) $row['rx_id'] : 0,
            'nonce' => isset($row['nonce']) ? (string) $row['nonce'] : '',
            'kid' => isset($row['kid']) && $row['kid'] !== null ? (string) $row['kid'] : null,
            'exp_ms' => isset($row['exp_ms']) ? (string) $row['exp_ms'] : '0',
            'payload' => $payload,
            'payload_json' => $payloadRaw,
            'mls1_token' => isset($row['mls1_token']) ? (string) $row['mls1_token'] : '',
            's3_key_ref' => isset($row['s3_key_ref']) && $row['s3_key_ref'] !== null ? (string) $row['s3_key_ref'] : null,
            'attempts' => isset($row['attempts']) ? (int) $row['attempts'] : 0,
            'max_attempts' => isset($row['max_attempts']) ? (int) $row['max_attempts'] : 0,
            'locked_at' => isset($row['locked_at']) && $row['locked_at'] !== null ? (string) $row['locked_at'] : null,
            'lock_expires_at' => isset($row['lock_expires_at']) && $row['lock_expires_at'] !== null ? (string) $row['lock_expires_at'] : null,
            'locked_by' => isset($row['locked_by']) && $row['locked_by'] !== null ? (string) $row['locked_by'] : null,
            'worker_ref' => isset($row['worker_ref']) && $row['worker_ref'] !== null ? (string) $row['worker_ref'] : null,
            'created_at' => isset($row['created_at']) && $row['created_at'] !== null ? (string) $row['created_at'] : null,
            'updated_at' => isset($row['updated_at']) && $row['updated_at'] !== null ? (string) $row['updated_at'] : null,
        ];
    }

    /**
     * @param array<string, mixed> $data
     */
    private function extractWorkerRef(array $data): string|WP_Error
    {
        if (!array_key_exists('worker_ref', $data) || $data['worker_ref'] === null) {
            return '';
        }

        if (!is_scalar($data['worker_ref'])) {
            return new WP_Error('ml_worker_ref', 'Invalid worker_ref', ['status' => 400]);
        }

        return $this->sanitizeWorkerRef((string) $data['worker_ref']);
    }

    /**
     * @param array<string, mixed> $data
     */
    private function extractLeaseSeconds(array $data): int|WP_Error
    {
        if (!array_key_exists('lease_seconds', $data)) {
            return 600;
        }

        $raw = $data['lease_seconds'];
        if (is_int($raw)) {
            return $this->sanitizeLeaseSeconds($raw);
        }

        if (is_string($raw) && ctype_digit($raw)) {
            return $this->sanitizeLeaseSeconds((int) $raw);
        }

        if (is_float($raw) && is_finite($raw)) {
            return $this->sanitizeLeaseSeconds((int) $raw);
        }

        return new WP_Error('ml_lease_seconds', 'Invalid lease_seconds', ['status' => 400]);
    }

    private function sanitizeWorkerRef(string $workerRef): string
    {
        $workerRef = trim($workerRef);
        if ($workerRef === '') {
            return '';
        }

        return substr(sanitize_text_field($workerRef), 0, 191);
    }

    private function sanitizeLeaseSeconds(int $leaseSeconds): int
    {
        return max(30, min(3600, $leaseSeconds));
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
