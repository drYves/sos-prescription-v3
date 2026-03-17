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
        $secret = self::readConfigString('ML_HMAC_SECRET');
        if ($secret === '') {
            throw new RuntimeException('Missing ML_HMAC_SECRET');
        }

        $siteId = self::readConfigString('ML_SITE_ID', 'unknown_site');
        $kid = self::readConfigString('ML_HMAC_KID');

        return new self(
            $db,
            $logger,
            $siteId,
            $secret,
            $kid !== '' ? $kid : null
        );
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

    /**
     * @return array{ok:true,job_id:string,dedup:bool,req_id:string}
     */
    public function dispatch_pdf_generation(int $rx_id, ?string $reqId = null): array
    {
        $reqId = ReqId::coalesce($reqId);
        if ($rx_id <= 0) {
            throw new RuntimeException('Invalid rx_id');
        }

        $existing = $this->findActivePdfJob($rx_id);
        if ($existing !== null) {
            $this->logger->info('job.dispatch.dedup', [
                'job_id' => $existing['job_id'],
                'rx_id' => $rx_id,
                'status' => $existing['status'],
            ], $reqId);

            return [
                'ok' => true,
                'job_id' => (string) $existing['job_id'],
                'dedup' => true,
                'req_id' => $reqId,
            ];
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
            'job' => [
                'job_id' => $jobId,
                'job_type' => 'PDF_GEN',
                'rx_id' => $rx_id,
            ],
        ];

        $rawJson = wp_json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if (!is_string($rawJson) || $rawJson === '') {
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
            'kid' => $this->kid ?? 'primary',
            'created_by' => function_exists('get_current_user_id') ? (int) get_current_user_id() : 0,
            'max_attempts' => 5,
            'priority' => 50,
        ]);

        if (!$ok) {
            $this->logger->error('job.dispatch.db_insert_failed', [
                'job_id' => $jobId,
                'rx_id' => $rx_id,
                'db_error' => (string) $this->db->last_error,
            ], $reqId);
            throw new RuntimeException('Failed to enqueue job');
        }

        $this->logger->info('job.dispatch.created', [
            'job_id' => $jobId,
            'rx_id' => $rx_id,
            'site_id' => $this->siteId,
        ], $reqId);

        return [
            'ok' => true,
            'job_id' => $jobId,
            'dedup' => false,
            'req_id' => $reqId,
        ];
    }

    /**
     * @return array{job_id:string,status:string}|null
     */
    private function findActivePdfJob(int $rx_id): ?array
    {
        $sql = "SELECT job_id, status
                FROM `{$this->jobsTable}`
                WHERE site_id = %s
                  AND rx_id = %d
                  AND job_type = 'PDF_GEN'
                  AND status IN ('PENDING','CLAIMED')
                  AND job_id IS NOT NULL
                  AND job_id <> ''
                ORDER BY created_at DESC, id DESC
                LIMIT 1";

        $row = $this->db->get_row($this->db->prepare($sql, $this->siteId, $rx_id), ARRAY_A);
        if (!is_array($row) || empty($row['job_id'])) {
            return null;
        }

        return [
            'job_id' => (string) $row['job_id'],
            'status' => isset($row['status']) ? (string) $row['status'] : 'PENDING',
        ];
    }

    /**
     * @param array<string, mixed> $d
     */
    private function insertJobRow(array $d): bool
    {
        $sql = "INSERT INTO `{$this->jobsTable}`
            (
                job_id,
                site_id,
                req_id,
                job_type,
                status,
                priority,
                attempts,
                max_attempts,
                available_at,
                rx_id,
                nonce,
                kid,
                exp_ms,
                payload,
                payload_sha256,
                mls1_token,
                created_by,
                created_at,
                updated_at
            )
            VALUES
            (
                %s,
                %s,
                %s,
                %s,
                'PENDING',
                %d,
                0,
                %d,
                UTC_TIMESTAMP(3),
                %d,
                %s,
                %s,
                %d,
                %s,
                UNHEX(%s),
                %s,
                %d,
                UTC_TIMESTAMP(),
                UTC_TIMESTAMP(3)
            )";

        $prepared = $this->db->prepare(
            $sql,
            (string) $d['job_id'],
            $this->siteId,
            (string) $d['req_id'],
            (string) $d['job_type'],
            (int) ($d['priority'] ?? 50),
            (int) ($d['max_attempts'] ?? 5),
            (int) $d['rx_id'],
            (string) $d['nonce'],
            (string) ($d['kid'] ?? 'primary'),
            (int) $d['exp_ms'],
            (string) $d['payload_json'],
            (string) $d['payload_sha256_hex'],
            (string) $d['mls1_token'],
            (int) ($d['created_by'] ?? 0)
        );

        return $this->db->query($prepared) === 1;
    }
}
