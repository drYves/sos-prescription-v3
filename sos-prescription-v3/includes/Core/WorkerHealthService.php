<?php
declare(strict_types=1);

namespace SOSPrescription\Core;

use RuntimeException;

final class WorkerHealthService
{
    public function __construct(
        private MedLabConnector $connector,
        private NdjsonLogger $logger,
        private string $hmacSecretActive,
        private ?string $hmacSecretPrevious = null,
        private int $skewWindowMs = 30000
    ) {
    }

    public static function fromEnv(NdjsonLogger $logger): self
    {
        $secret = getenv('ML_HMAC_SECRET');
        if (!is_string($secret) || $secret === '') {
            throw new RuntimeException('Missing ML_HMAC_SECRET');
        }

        $prev = getenv('ML_HMAC_SECRET_PREVIOUS');
        $skew = (int) (getenv('ML_AUTH_SKEW_WINDOW_MS') ?: 30000);

        return new self(
            MedLabConnector::fromEnv(),
            $logger,
            $secret,
            is_string($prev) && $prev !== '' ? $prev : null,
            $skew > 0 ? $skew : 30000
        );
    }

    public function pingWorker(?string $reqId = null, ?int $timeoutS = null): array
    {
        $reqId = ReqId::coalesce($reqId);
        $timeoutS = $timeoutS ?? 2;
        $startedAt = microtime(true);
        $response = $this->connector->pulseRaw($timeoutS);
        $latencyMs = (int) round((microtime(true) - $startedAt) * 1000);

        if (!is_array($response) || ($response['status'] ?? 0) < 200 || ($response['status'] ?? 0) >= 300) {
            $errorCode = is_array($response) && isset($response['error_code']) ? (string) $response['error_code'] : 'ML_PULSE_FAILED';
            $this->logger->error('health.worker.ping.failed', [
                'error_code' => $errorCode,
                'latency_ms' => $latencyMs,
                'http_status' => (int) ($response['status'] ?? 0),
            ], $reqId);

            return [
                'ok' => false,
                'req_id' => $reqId,
                'latency_ms' => $latencyMs,
                'error_code' => $errorCode,
                'error_message_safe' => 'Worker ping failed',
            ];
        }

        $body = isset($response['body']) ? (string) $response['body'] : '';
        $sigHeader = $this->getHeaderValue($response['headers'] ?? [], 'x-medlab-signature');
        $signatureVerified = null;

        if (is_string($sigHeader) && $sigHeader !== '') {
            $signatureVerified = $this->verifyMls1SignedBody($sigHeader, $body);
            if ($signatureVerified !== true) {
                $this->logger->error('health.worker.ping.failed', [
                    'error_code' => 'ML_PULSE_BAD_SIGNATURE',
                    'latency_ms' => $latencyMs,
                    'http_status' => (int) ($response['status'] ?? 0),
                ], $reqId);

                return [
                    'ok' => false,
                    'req_id' => $reqId,
                    'latency_ms' => $latencyMs,
                    'error_code' => 'ML_PULSE_BAD_SIGNATURE',
                    'error_message_safe' => 'Invalid Worker signature',
                ];
            }
        }

        $data = json_decode($body, true);
        if (!is_array($data)) {
            $this->logger->error('health.worker.ping.failed', [
                'error_code' => 'ML_PULSE_BAD_JSON',
                'latency_ms' => $latencyMs,
            ], $reqId);

            return [
                'ok' => false,
                'req_id' => $reqId,
                'latency_ms' => $latencyMs,
                'error_code' => 'ML_PULSE_BAD_JSON',
                'error_message_safe' => 'Invalid Worker JSON',
            ];
        }

        $queue = ['pending' => null, 'claimed' => null];
        if (isset($data['queue']) && is_array($data['queue'])) {
            $queue['pending'] = isset($data['queue']['pending']) ? (int) $data['queue']['pending'] : null;
            $queue['claimed'] = isset($data['queue']['claimed']) ? (int) $data['queue']['claimed'] : null;
        }

        $clock = $this->computeClockSkew(isset($data['server_time_ms']) ? (int) $data['server_time_ms'] : null);
        $state = isset($data['state']) && is_string($data['state']) ? $data['state'] : 'UNKNOWN';
        $rssMb = isset($data['rss_mb']) ? (int) $data['rss_mb'] : null;

        $this->logger->info('health.worker.ping.ok', [
            'latency_ms' => $latencyMs,
            'http_status' => (int) ($response['status'] ?? 0),
            'signature_verified' => $signatureVerified,
            'state' => $state,
            'rss_mb' => $rssMb,
            'queue_pending' => $queue['pending'],
            'queue_claimed' => $queue['claimed'],
            'clock_skew_status' => $clock['skew_status'],
        ], $reqId);

        return [
            'ok' => true,
            'req_id' => $reqId,
            'latency_ms' => $latencyMs,
            'http_status' => (int) ($response['status'] ?? 0),
            'signature_verified' => $signatureVerified,
            'metrics' => [
                'state' => $state,
                'rss_mb' => $rssMb,
                'worker_id' => isset($data['worker_id']) ? (string) $data['worker_id'] : null,
                'server_time_ms' => isset($data['server_time_ms']) ? (int) $data['server_time_ms'] : null,
                'queue' => $queue,
                'clock_skew' => $clock,
            ],
        ];
    }

    private function verifyMls1SignedBody(string $token, string $rawBody): bool
    {
        $parts = explode('.', $token);
        if (count($parts) !== 3 || $parts[0] !== 'mls1') {
            return false;
        }

        $payload = Base64Url::decode($parts[1]);
        if ($payload === null || !hash_equals($payload, $rawBody)) {
            return false;
        }

        $sigHex = strtolower($parts[2]);
        if (!preg_match('/^[0-9a-f]{64}$/', $sigHex)) {
            return false;
        }

        $expected = hash_hmac('sha256', $rawBody, $this->hmacSecretActive, false);
        if (hash_equals(strtolower($expected), $sigHex)) {
            return true;
        }

        if ($this->hmacSecretPrevious) {
            $expectedPrevious = hash_hmac('sha256', $rawBody, $this->hmacSecretPrevious, false);
            return hash_equals(strtolower($expectedPrevious), $sigHex);
        }

        return false;
    }

    private function computeClockSkew(?int $serverTimeMs): array
    {
        if ($serverTimeMs === null) {
            return ['delta_ms' => null, 'skew_status' => 'UNKNOWN'];
        }

        $delta = $serverTimeMs - (int) floor(microtime(true) * 1000);
        $abs = abs($delta);

        if ($abs <= 15000) {
            $status = 'OK';
        } elseif ($abs <= $this->skewWindowMs) {
            $status = 'DEGRADED';
        } else {
            $status = 'OFFLINE';
        }

        return ['delta_ms' => $delta, 'skew_status' => $status];
    }

    private function getHeaderValue(mixed $headers, string $name): ?string
    {
        $normalized = strtolower($name);

        if (is_array($headers)) {
            foreach ($headers as $key => $value) {
                if (strtolower((string) $key) === $normalized) {
                    return is_array($value) ? (string) ($value[0] ?? '') : (string) $value;
                }
            }
        }

        if (is_object($headers) && method_exists($headers, 'getAll')) {
            $all = $headers->getAll();
            if (is_array($all)) {
                foreach ($all as $key => $value) {
                    if (strtolower((string) $key) === $normalized) {
                        return is_array($value) ? (string) ($value[0] ?? '') : (string) $value;
                    }
                }
            }
        }

        return null;
    }
}
