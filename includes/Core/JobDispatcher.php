<?php
declare(strict_types=1);

namespace SosPrescription\Core;

use RuntimeException;
use wpdb;

final class JobDispatcher
{
    private string $jobsTable;

    public function __construct(
        private wpdb $db,
        private NdjsonLogger $logger,
        private string $siteId,
        private string $hmacSecret,
        private ?string $kid = null
    ) {
        $this->jobsTable = $db->prefix . 'sosprescription_jobs';
    }

    public static function fromEnv(wpdb $db, NdjsonLogger $logger): self
    {
        $secret = getenv('ML_HMAC_SECRET');
        if (!$secret) {
            throw new RuntimeException('Missing ML_HMAC_SECRET');
        }

        return new self($db, $logger, getenv('ML_SITE_ID') ?: 'unknown_site', $secret, getenv('ML_HMAC_KID') ?: null);
    }

    public function dispatch_pdf_generation(int $rx_id, ?string $reqId = null): array
    {
        $reqId = ReqId::coalesce($reqId);
        if ($rx_id <= 0) {
            throw new RuntimeException('Invalid rx_id');
        }

        $existing = $this->findActivePdfJob($rx_id);
        if ($existing) {
            return ['ok' => true, 'job_id' => $existing['job_id'], 'dedup' => true, 'req_id' => $reqId];
        }

        $jobId = wp_generate_uuid4();
        $tsMs = (int) floor(microtime(true) * 1000);
        $payload = [
            'schema_version' => '2026.5',
            'site_id' => $this->siteId,
            'ts_ms' => $tsMs,
            'nonce' => Base64Url::encode(random_bytes(16)),
            'exp_ms' => $tsMs + 86400000,
            'req_id' => $reqId,
            'kid' => $this->kid,
            'job' => ['job_id' => $jobId, 'job_type' => 'PDF_GEN', 'rx_id' => $rx_id],
        ];

        $rawJson = wp_json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if (!is_string($rawJson)) {
            throw new RuntimeException('JSON encode failed');
        }

        $ok = $this->insertJobRow([
            'job_id' => $jobId,
            'req_id' => $reqId,
            'job_type' => 'PDF_GEN',
            'rx_id' => $rx_id,
            'nonce' => $payload['nonce'],
            'exp_ms' => $payload['exp_ms'],
            'payload_json' => $rawJson,
            'payload_sha256_hex' => hash('sha256', $rawJson, false),
            'mls1_token' => MedLabConnector::mls1Token($rawJson, $this->hmacSecret),
            'kid' => $this->kid,
        ]);

        if (!$ok) {
            $this->logger->error('job.dispatch.db_insert_failed', ['job_id' => $jobId], $reqId);
            throw new RuntimeException('Failed to enqueue job');
        }

        return ['ok' => true, 'job_id' => $jobId, 'dedup' => false, 'req_id' => $reqId];
    }

    private function findActivePdfJob(int $rx_id): ?array
    {
        $sql = "SELECT job_id, status FROM `{$this->jobsTable}` WHERE site_id=%s AND rx_id=%d AND job_type='PDF_GEN' AND status IN ('PENDING','CLAIMED') ORDER BY created_at DESC LIMIT 1";
        $row = $this->db->get_row($this->db->prepare($sql, $this->siteId, $rx_id), ARRAY_A);
        return is_array($row) ? $row : null;
    }

    private function insertJobRow(array $d): bool
    {
        $sql = "INSERT INTO `{$this->jobsTable}` (job_id, site_id, req_id, job_type, status, priority, rx_id, nonce, kid, exp_ms, payload, payload_sha256, mls1_token) VALUES (%s, %s, %s, %s, 'PENDING', 50, %d, %s, %s, %d, CAST(%s AS JSON), UNHEX(%s), %s)";
        $prepared = $this->db->prepare($sql, $d['job_id'], $this->siteId, $d['req_id'], $d['job_type'], $d['rx_id'], $d['nonce'], $d['kid'], (int) $d['exp_ms'], $d['payload_json'], $d['payload_sha256_hex'], $d['mls1_token']);
        return $this->db->query($prepared) === 1;
    }
}
