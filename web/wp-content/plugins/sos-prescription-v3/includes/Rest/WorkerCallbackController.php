<?php
declare(strict_types=1);

namespace SosPrescription\Rest;

use SosPrescription\Core\Mls1Verifier;
use SosPrescription\Core\NdjsonLogger;
use SosPrescription\Core\NonceStore;
use SosPrescription\Core\ReqId;
use WP_Error;
use WP_REST_Request;
use WP_REST_Response;
use wpdb;

final class WorkerCallbackController
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
            $db = $GLOBALS['wpdb'];
            $siteId = getenv('ML_SITE_ID') ?: 'unknown_site';
            $logger = new NdjsonLogger('web', $siteId, getenv('SOSPRESCRIPTION_ENV') ?: 'prod');
            $verifier = Mls1Verifier::fromEnv(new NonceStore($db, $siteId), $logger);
            $controller = new self($db, $logger, $verifier, $siteId);

            register_rest_route('sosprescription/v3', '/worker/callback', [
                'methods' => 'POST',
                'permission_callback' => '__return_true',
                'callback' => [$controller, 'handle'],
            ]);
        });
    }

    public function handle(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $verified = $this->verifier->verifyJsonBodySigned($request, 'worker_callback');
        if (is_wp_error($verified)) {
            return $verified;
        }

        $data = $verified['data'];
        $reqId = ReqId::coalesce($verified['req_id'] ?? null);

        if (($data['schema_version'] ?? null) !== '2026.5') {
            return new WP_Error('ml_schema', 'Schema mismatch', ['status' => 400]);
        }
        if (($data['site_id'] ?? null) !== $this->siteId) {
            return new WP_Error('ml_site', 'Site mismatch', ['status' => 403]);
        }

        $job = is_array($data['job'] ?? null) ? $data['job'] : null;
        if (!is_array($job) || !is_string($job['job_id'] ?? null)) {
            return new WP_Error('ml_job', 'Missing job', ['status' => 400]);
        }

        $jobId = $job['job_id'];
        $status = $job['status'] ?? null;
        if (!in_array($status, ['DONE', 'FAILED'], true)) {
            return new WP_Error('ml_job_status', 'Invalid job status', ['status' => 400]);
        }

        $row = $this->db->get_row(
            $this->db->prepare("SELECT job_id, status, req_id FROM `{$this->jobsTable}` WHERE job_id = %s AND site_id = %s LIMIT 1", $jobId, $this->siteId),
            ARRAY_A
        );
        if (!is_array($row)) {
            $this->logger->warning('worker.callback.unknown_job', ['job_id' => $jobId], $reqId);
            return new WP_Error('ml_job_not_found', 'Job not found', ['status' => 404]);
        }

        if (in_array($row['status'], ['DONE', 'FAILED'], true)) {
            $this->logger->info('worker.callback.idempotent', [
                'job_id' => $jobId,
                'current_status' => $row['status'],
                'incoming_status' => $status,
            ], $reqId);

            do_action('sosprescription_v3_worker_callback_received', $jobId, $status, $data, $reqId);
            return new WP_REST_Response(['ok' => true, 'idempotent' => true], 200);
        }

        if ($status === 'DONE') {
            $artifact = is_array($job['artifact'] ?? null) ? $job['artifact'] : [];
            $s3KeyRef = $job['s3_key_ref'] ?? ($artifact['s3_key_ref'] ?? null);
            if (!is_string($s3KeyRef) || $s3KeyRef === '' || strlen($s3KeyRef) > 1024 || str_starts_with($s3KeyRef, 'http')) {
                return new WP_Error('ml_s3_key', 'Invalid s3_key_ref', ['status' => 400]);
            }

            $shaHex = null;
            if (isset($artifact['sha256_hex']) && is_string($artifact['sha256_hex']) && preg_match('/^[0-9a-f]{64}$/', strtolower($artifact['sha256_hex']))) {
                $shaHex = strtolower($artifact['sha256_hex']);
            } elseif (isset($artifact['sha256']) && is_string($artifact['sha256']) && preg_match('/^sha256:[0-9a-f]{64}$/', strtolower($artifact['sha256']))) {
                $shaHex = substr(strtolower($artifact['sha256']), 7);
            }

            $sizeBytes = isset($artifact['size_bytes']) ? (int) $artifact['size_bytes'] : null;
            $contentType = isset($artifact['content_type']) && is_string($artifact['content_type']) ? $artifact['content_type'] : 'application/pdf';

            $sql = "
                UPDATE `{$this->jobsTable}`
                SET status='DONE',
                    s3_key_ref=%s,
                    artifact_sha256=" . ($shaHex ? 'UNHEX(%s)' : 'NULL') . ",
                    artifact_size_bytes=" . ($sizeBytes !== null ? '%d' : 'NULL') . ",
                    artifact_content_type=%s,
                    completed_at=NOW(3),
                    locked_at=NULL,
                    lock_expires_at=NULL,
                    locked_by=NULL
                WHERE job_id=%s AND site_id=%s
            ";

            $args = [$s3KeyRef];
            if ($shaHex) {
                $args[] = $shaHex;
            }
            if ($sizeBytes !== null) {
                $args[] = $sizeBytes;
            }
            $args[] = $contentType;
            $args[] = $jobId;
            $args[] = $this->siteId;

            $this->db->query($this->db->prepare($sql, ...$args));

            $this->logger->info('worker.callback.done', ['job_id' => $jobId, 's3_key_ref' => $s3KeyRef], $reqId);
            do_action('sosprescription_v3_job_done', $jobId, $data, $reqId);
        } else {
            $error = is_array($job['error'] ?? null) ? $job['error'] : [];
            $code = isset($error['code']) && is_string($error['code']) ? substr($error['code'], 0, 64) : 'ML_WORKER_FAILED';
            $msg = isset($error['message_safe']) && is_string($error['message_safe']) ? substr($error['message_safe'], 0, 255) : 'Worker reported failure';

            $this->db->query($this->db->prepare(
                "UPDATE `{$this->jobsTable}` SET status='FAILED', last_error_code=%s, last_error_message_safe=%s, last_error_at=NOW(3), completed_at=NOW(3), locked_at=NULL, lock_expires_at=NULL, locked_by=NULL WHERE job_id=%s AND site_id=%s",
                $code,
                $msg,
                $jobId,
                $this->siteId
            ));

            $this->logger->warning('worker.callback.failed', ['job_id' => $jobId, 'error_code' => $code], $reqId);
            do_action('sosprescription_v3_job_failed', $jobId, $data, $reqId);
        }

        do_action('sosprescription_v3_worker_callback_received', $jobId, $status, $data, $reqId);
        return new WP_REST_Response(['ok' => true], 200);
    }
}
