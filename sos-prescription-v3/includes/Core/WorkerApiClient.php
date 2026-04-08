<?php // includes/Core/WorkerApiClient.php

declare(strict_types=1);

namespace SOSPrescription\Core;

use RuntimeException;

final class WorkerApiClient
{
    private const CURRENT_SCHEMA_VERSION = '2026.6';
    private const DEFAULT_TIMEOUT_S = 30;
    private const MIN_TIMEOUT_S = 20;

    private string $workerBaseUrl;
    private int $timeoutS;
    private ?string $hmacSecretPrevious;

    public function __construct(
        private NdjsonLogger $logger,
        private string $siteId,
        private string $hmacSecret,
        private ?string $kid = null,
        ?string $workerBaseUrl = null,
        ?int $timeoutS = null,
        ?string $hmacSecretPrevious = null
    ) {
        $resolvedBaseUrl = trim((string) ($workerBaseUrl !== null ? $workerBaseUrl : self::readConfigString('ML_WORKER_BASE_URL')));
        $this->workerBaseUrl = rtrim($resolvedBaseUrl, '/');

        $resolvedTimeout = $timeoutS ?? self::readTimeoutConfig();
        $this->timeoutS = max(self::MIN_TIMEOUT_S, $resolvedTimeout > 0 ? (int) $resolvedTimeout : self::DEFAULT_TIMEOUT_S);

        $previous = trim((string) ($hmacSecretPrevious !== null ? $hmacSecretPrevious : self::readConfigString('ML_HMAC_SECRET_PREVIOUS')));
        $this->hmacSecretPrevious = $previous !== '' ? $previous : null;
    }

    public static function fromEnv(NdjsonLogger $logger, ?string $siteId = null): self
    {
        $secret = self::readConfigString('ML_HMAC_SECRET');
        if ($secret === '') {
            throw new RuntimeException('Missing ML_HMAC_SECRET');
        }

        $resolvedSiteId = trim((string) ($siteId !== null ? $siteId : self::readConfigString('ML_SITE_ID', '')));
        if ($resolvedSiteId === '') {
            $home = home_url('/');
            $resolvedSiteId = is_string($home) && trim($home) !== '' ? trim($home) : 'unknown_site';
        }

        $kid = self::readConfigString('ML_HMAC_KID');
        $workerBaseUrl = self::readConfigString('ML_WORKER_BASE_URL');
        $timeoutS = self::readTimeoutConfig();
        $previous = self::readConfigString('ML_HMAC_SECRET_PREVIOUS');

        return new self(
            $logger,
            $resolvedSiteId,
            $secret,
            $kid !== '' ? $kid : null,
            $workerBaseUrl !== '' ? $workerBaseUrl : null,
            $timeoutS,
            $previous !== '' ? $previous : null
        );
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    public function postSignedJson(string $path, array $payload, ?string $reqId = null, string $scope = 'worker_post'): array
    {
        $resolvedReqId = ReqId::coalesce($reqId);
        $envelopedPayload = $this->normalizeEnvelope($payload, $resolvedReqId);

        return $this->sendSignedJsonRequest('POST', $path, $envelopedPayload, $resolvedReqId, $scope);
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    public function putSignedJson(string $path, array $payload, ?string $reqId = null, string $scope = 'worker_put'): array
    {
        $resolvedReqId = ReqId::coalesce($reqId);
        $envelopedPayload = $this->normalizeEnvelope($payload, $resolvedReqId);

        return $this->sendSignedJsonRequest('PUT', $path, $envelopedPayload, $resolvedReqId, $scope);
    }

    /**
     * @return array<string, mixed>
     */
    public function getSignedJson(string $path, ?string $reqId = null, string $scope = 'worker_get'): array
    {
        if ($this->workerBaseUrl === '') {
            throw new RuntimeException('La constante ML_WORKER_BASE_URL est manquante ou vide dans wp-config.php');
        }

        $resolvedReqId = ReqId::coalesce($reqId);
        $normalizedPath = self::normalizeApiPath($path);
        $tsMs = (int) floor(microtime(true) * 1000);
        $nonce = $this->generateUrlSafeRandom(16);
        $canonicalPayload = sprintf('GET|%s|%d|%s', $normalizedPath, $tsMs, $nonce);

        $headers = [
            'Accept' => 'application/json',
            'X-MedLab-Signature' => $this->buildMls1Token($canonicalPayload),
            'Cache-Control' => 'no-cache, no-store, must-revalidate',
            'Pragma' => 'no-cache',
        ];
        if ($this->kid !== null && $this->kid !== '') {
            $headers['X-MedLab-Kid'] = $this->kid;
        }

        $response = wp_remote_get($this->workerBaseUrl . $normalizedPath, [
            'headers' => $headers,
            'timeout' => $this->timeoutS,
            'redirection' => 0,
            'blocking' => true,
        ]);

        return $this->decodeWorkerResponse($response, $normalizedPath, $resolvedReqId, $scope);
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

    private static function readTimeoutConfig(): int
    {
        $timeout = (int) self::readConfigString('ML_WORKER_HTTP_TIMEOUT_S', '0');
        if ($timeout <= 0) {
            $timeout = (int) self::readConfigString('ML_WORKER_INGEST_TIMEOUT_S', (string) self::DEFAULT_TIMEOUT_S);
        }

        return max(self::MIN_TIMEOUT_S, $timeout > 0 ? $timeout : self::DEFAULT_TIMEOUT_S);
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    private function normalizeEnvelope(array $payload, string $reqId): array
    {
        $body = $payload;
        $body['schema_version'] = isset($body['schema_version']) && is_scalar($body['schema_version'])
            ? (string) $body['schema_version']
            : self::CURRENT_SCHEMA_VERSION;
        $body['site_id'] = isset($body['site_id']) && is_scalar($body['site_id'])
            ? (string) $body['site_id']
            : $this->siteId;
        $body['ts_ms'] = (int) floor(microtime(true) * 1000);
        $body['nonce'] = $this->generateUrlSafeRandom(16);
        $body['req_id'] = $reqId;

        return $body;
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    private function sendSignedJsonRequest(string $method, string $path, array $payload, string $reqId, string $scope): array
    {
        if ($this->workerBaseUrl === '') {
            throw new RuntimeException('La constante ML_WORKER_BASE_URL est manquante ou vide dans wp-config.php');
        }

        $normalizedPath = self::normalizeApiPath($path);
        $rawJson = wp_json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if (!is_string($rawJson) || $rawJson === '') {
            throw new RuntimeException('JSON encode failed');
        }

        $headers = [
            'Accept' => 'application/json',
            'Content-Type' => 'application/json; charset=utf-8',
            'X-MedLab-Signature' => $this->buildMls1Token($rawJson),
        ];
        if ($this->kid !== null && $this->kid !== '') {
            $headers['X-MedLab-Kid'] = $this->kid;
        }

        $response = wp_remote_request($this->workerBaseUrl . $normalizedPath, [
            'headers' => $headers,
            'body' => $rawJson,
            'method' => strtoupper($method),
            'timeout' => $this->timeoutS,
            'redirection' => 0,
            'blocking' => true,
            'data_format' => 'body',
        ]);

        return $this->decodeWorkerResponse($response, $normalizedPath, $reqId, $scope);
    }

    /**
     * @param mixed $response
     * @return array<string, mixed>
     */
    private function decodeWorkerResponse($response, string $normalizedPath, string $reqId, string $scope): array
    {
        if (is_wp_error($response)) {
            $errCode = (string) $response->get_error_code();
            $errMsg = trim((string) $response->get_error_message());
            $this->logger->error('worker.bridge.http_error', [
                'scope' => $scope,
                'path' => $normalizedPath,
                'error_code' => $errCode,
                'error_message' => $errMsg,
                'timeout_s' => $this->timeoutS,
            ], $reqId);
            throw new RuntimeException(sprintf(
                'Requête bloquée par WordPress : [%s] %s',
                $errCode !== '' ? $errCode : 'wp_http_error',
                $errMsg !== '' ? $errMsg : 'unknown error'
            ));
        }

        $status = (int) wp_remote_retrieve_response_code($response);
        $rawBody = (string) wp_remote_retrieve_body($response);
        $signatureBody = $rawBody;
        $body = $this->sanitizeJsonBody($rawBody);
        $responseHeaders = wp_remote_retrieve_headers($response);
        $contentType = (string) ($this->getHeaderValue($responseHeaders, 'content-type') ?? '');

        $sigHeader = $this->getHeaderValue($responseHeaders, 'x-medlab-signature');
        if (!$this->verifyMls1SignedBody($sigHeader, $signatureBody)) {
            $sanitizedSignatureBody = $this->sanitizeJsonBody($signatureBody);
            $this->logger->error('worker.bridge.bad_signature', [
                'scope' => $scope,
                'path' => $normalizedPath,
                'http_status' => $status,
                'content_type' => $contentType,
                'response_bytes' => strlen($rawBody),
                'response_sha256' => hash('sha256', $rawBody),
                'response_prefix_hex' => bin2hex(substr($rawBody, 0, 16)),
                'response_sanitized_bytes' => strlen($sanitizedSignatureBody),
                'response_sanitized_sha256' => hash('sha256', $sanitizedSignatureBody),
                'response_sanitized_prefix_hex' => bin2hex(substr($sanitizedSignatureBody, 0, 16)),
            ], $reqId);
            throw new RuntimeException('Invalid Worker response signature');
        }

        if ($body === '') {
            $this->logger->error('worker.bridge.empty_body', [
                'scope' => $scope,
                'path' => $normalizedPath,
                'http_status' => $status,
                'content_type' => $contentType,
                'response_bytes' => strlen($rawBody),
                'response_sha256' => hash('sha256', $rawBody),
            ], $reqId);
            throw new RuntimeException(sprintf('Empty Worker response body (HTTP %d)', $status));
        }

        $decoded = json_decode($body, true);
        if (!is_array($decoded)) {
            $this->logger->error('worker.bridge.bad_json', [
                'scope' => $scope,
                'path' => $normalizedPath,
                'http_status' => $status,
                'content_type' => $contentType,
                'json_error' => json_last_error_msg(),
                'response_bytes' => strlen($rawBody),
                'response_sha256' => hash('sha256', $rawBody),
                'response_prefix_hex' => bin2hex(substr($rawBody, 0, 32)),
            ], $reqId);
            throw new RuntimeException('Invalid Worker JSON response: ' . json_last_error_msg());
        }

        if (!isset($decoded['req_id']) || !is_scalar($decoded['req_id']) || trim((string) $decoded['req_id']) === '') {
            $decoded['req_id'] = $reqId;
        }

        if ($status < 200 || $status >= 300 || (array_key_exists('ok', $decoded) && $decoded['ok'] !== true)) {
            $code = isset($decoded['code']) && is_scalar($decoded['code']) ? trim((string) $decoded['code']) : 'ML_WORKER_REJECTED';
            $msg = isset($decoded['message']) && is_scalar($decoded['message']) ? trim((string) $decoded['message']) : '';
            if ($msg === '') {
                $msg = $status >= 500 ? 'Erreur Worker' : 'Rejeté';
            }

            $this->logger->error('worker.bridge.rejected', [
                'scope' => $scope,
                'path' => $normalizedPath,
                'http_status' => $status,
                'error_code' => $code,
                'error_message' => $msg,
                'content_type' => $contentType,
                'response_bytes' => strlen($rawBody),
                'response_sha256' => hash('sha256', $rawBody),
            ], $reqId);
            throw new RuntimeException(sprintf('Worker HTTP %d : %s (%s)', $status, $msg, $code !== '' ? $code : 'ML_WORKER_REJECTED'));
        }

        $this->logger->info('worker.bridge.accepted', [
            'scope' => $scope,
            'path' => $normalizedPath,
            'http_status' => $status,
            'content_type' => $contentType,
            'response_bytes' => strlen($rawBody),
            'response_req_id' => isset($decoded['req_id']) && is_scalar($decoded['req_id']) ? (string) $decoded['req_id'] : $reqId,
        ], $reqId);

        return $decoded;
    }

    private function buildMls1Token(string $rawPayload): string
    {
        $payloadB64 = rtrim(strtr(base64_encode($rawPayload), '+/', '-_'), '=');
        $sigHex = hash_hmac('sha256', $rawPayload, $this->hmacSecret, false);
        return sprintf('mls1.%s.%s', $payloadB64, $sigHex);
    }

    private function verifyMls1SignedBody(?string $token, string $rawBody): bool
    {
        $token = is_string($token) ? trim($token) : '';
        if ($token === '') {
            return false;
        }

        $parts = explode('.', $token);
        if (count($parts) !== 3 || strtolower((string) $parts[0]) !== 'mls1') {
            return false;
        }

        $b64 = strtr((string) $parts[1], '-_', '+/');
        $padding = strlen($b64) % 4;
        if ($padding > 0) {
            $b64 .= str_repeat('=', 4 - $padding);
        }

        $payload = base64_decode($b64, true);
        if (!is_string($payload)) {
            return false;
        }

        $sigHex = strtolower((string) $parts[2]);
        if (!preg_match('/^[0-9a-f]{64}$/', $sigHex)) {
            return false;
        }

        foreach ($this->buildSignedBodyCandidates($rawBody) as $candidateBody) {
            if (!hash_equals($payload, $candidateBody)) {
                continue;
            }

            if ($this->matchesSignedBodyHash($candidateBody, $sigHex, $this->hmacSecret)) {
                return true;
            }

            if ($this->hmacSecretPrevious !== null && $this->hmacSecretPrevious !== '' && $this->matchesSignedBodyHash($candidateBody, $sigHex, $this->hmacSecretPrevious)) {
                return true;
            }
        }

        return false;
    }

    /**
     * @return list<string>
     */
    private function buildSignedBodyCandidates(string $rawBody): array
    {
        $candidates = [];

        $this->appendSignedBodyCandidate($candidates, $rawBody);

        $withoutBom = $this->stripUtf8Bom($rawBody);
        $this->appendSignedBodyCandidate($candidates, $withoutBom);

        $this->appendSignedBodyCandidate($candidates, rtrim($rawBody, "\r\n"));
        $this->appendSignedBodyCandidate($candidates, rtrim($withoutBom, "\r\n"));

        $this->appendSignedBodyCandidate($candidates, trim($rawBody));
        $this->appendSignedBodyCandidate($candidates, trim($withoutBom));

        return $candidates;
    }

    /**
     * @param list<string> $candidates
     */
    private function appendSignedBodyCandidate(array &$candidates, string $candidate): void
    {
        foreach ($candidates as $existing) {
            if ($existing === $candidate) {
                return;
            }
        }

        $candidates[] = $candidate;
    }

    private function stripUtf8Bom(string $body): string
    {
        return str_starts_with($body, "\xEF\xBB\xBF") ? substr($body, 3) : $body;
    }

    private function matchesSignedBodyHash(string $body, string $sigHex, string $secret): bool
    {
        $expected = hash_hmac('sha256', $body, $secret, false);
        return hash_equals(strtolower($expected), strtolower($sigHex));
    }

    private function getHeaderValue(mixed $headers, string $name): ?string
    {
        $needle = strtolower($name);

        if (is_array($headers)) {
            foreach ($headers as $key => $value) {
                if (strtolower((string) $key) === $needle) {
                    return is_array($value) ? (string) ($value[0] ?? '') : (string) $value;
                }
            }
        }

        if (is_object($headers) && method_exists($headers, 'getAll')) {
            $all = $headers->getAll();
            if (is_array($all)) {
                foreach ($all as $key => $value) {
                    if (strtolower((string) $key) === $needle) {
                        return is_array($value) ? (string) ($value[0] ?? '') : (string) $value;
                    }
                }
            }
        }

        return null;
    }

    private static function normalizeApiPath(string $path): string
    {
        $trimmed = trim($path);
        if ($trimmed === '') {
            throw new RuntimeException('Le chemin API Worker est vide.');
        }

        return '/' . ltrim($trimmed, '/');
    }

    private function sanitizeJsonBody(string $body): string
    {
        $body = $this->stripUtf8Bom($body);

        return trim($body);
    }

    private function generateUrlSafeRandom(int $bytesLength): string
    {
        try {
            $bytes = random_bytes(max(8, $bytesLength));
        } catch (\Throwable $e) {
            $bytes = wp_generate_password(max(8, $bytesLength), true, true);
        }

        return rtrim(strtr(base64_encode((string) $bytes), '+/', '-_'), '=');
    }
}
