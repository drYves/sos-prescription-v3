<?php
declare(strict_types=1);

namespace SOSPrescription\Core;

use RuntimeException;

final class MedLabConnector
{
    public function __construct(
        private string $baseUrl,
        private string $hmacSecret,
        private ?string $hmacKid = null
    ) {
    }

    public static function fromEnv(): self
    {
        $baseUrl = getenv('ML_WORKER_BASE_URL');
        if (!is_string($baseUrl) || trim($baseUrl) === '') {
            throw new RuntimeException('Missing ML_WORKER_BASE_URL');
        }

        $secret = getenv('ML_HMAC_SECRET');
        if (!is_string($secret) || $secret === '') {
            throw new RuntimeException('Missing ML_HMAC_SECRET');
        }

        $kid = getenv('ML_HMAC_KID');
        return new self(rtrim($baseUrl, '/'), $secret, is_string($kid) && $kid !== '' ? $kid : null);
    }

    public static function mls1Token(string $rawPayload, string $hmacSecret): string
    {
        $payloadB64 = Base64Url::encode($rawPayload);
        $sigHex = hash_hmac('sha256', $rawPayload, $hmacSecret, false);
        return sprintf('mls1.%s.%s', $payloadB64, $sigHex);
    }

    public function pulse(int $timeoutS = 2): array
    {
        $response = $this->pulseRaw($timeoutS);
        unset($response['headers']);
        return $response;
    }

    public function pulseRaw(int $timeoutS = 2): array
    {
        $canonicalPayload = $this->canonicalGet('/pulse');
        return $this->wpRequest('GET', '/pulse', $canonicalPayload, $timeoutS);
    }

    private function canonicalGet(string $path): string
    {
        $tsMs = (int) floor(microtime(true) * 1000);
        $nonce = Base64Url::encode(random_bytes(16));
        return sprintf('GET|%s|%d|%s', $path, $tsMs, $nonce);
    }

    private function wpRequest(string $method, string $path, string $rawPayload, int $timeoutS = 2): array
    {
        $url = $this->baseUrl . $path;
        $headers = [
            'Accept' => 'application/json',
            'X-MedLab-Signature' => self::mls1Token($rawPayload, $this->hmacSecret),
        ];

        if ($this->hmacKid !== null) {
            $headers['X-MedLab-Kid'] = $this->hmacKid;
        }

        $resp = wp_remote_request($url, [
            'method' => strtoupper($method),
            'headers' => $headers,
            'timeout' => $timeoutS,
            'redirection' => 0,
        ]);

        if (is_wp_error($resp)) {
            return [
                'ok' => false,
                'status' => 0,
                'body' => '',
                'headers' => [],
                'error_code' => 'ML_HTTP_ERROR',
                'error_message_safe' => 'HTTP request failed',
            ];
        }

        $status = (int) wp_remote_retrieve_response_code($resp);
        $body = (string) wp_remote_retrieve_body($resp);
        $responseHeaders = wp_remote_retrieve_headers($resp);

        return [
            'ok' => $status >= 200 && $status < 300,
            'status' => $status,
            'body' => $body,
            'headers' => $responseHeaders,
        ];
    }
}
