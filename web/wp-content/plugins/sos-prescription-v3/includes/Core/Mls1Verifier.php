<?php
declare(strict_types=1);

namespace SosPrescription\Core;

use RuntimeException;
use WP_Error;
use WP_REST_Request;

final class Mls1Verifier
{
    public function __construct(
        private string $siteId,
        private string $secretActive,
        private ?string $secretPrevious,
        private int $skewWindowMs,
        private NonceStore $nonceStore,
        private NdjsonLogger $logger
    ) {
    }

    public static function fromEnv(NonceStore $nonceStore, NdjsonLogger $logger): self
    {
        $siteId = getenv('ML_SITE_ID') ?: 'unknown_site';
        $secret = getenv('ML_HMAC_SECRET');
        if (!$secret) {
            throw new RuntimeException('Missing ML_HMAC_SECRET');
        }

        return new self(
            $siteId,
            $secret,
            getenv('ML_HMAC_SECRET_PREVIOUS') ?: null,
            (int) (getenv('ML_AUTH_SKEW_WINDOW_MS') ?: 30000),
            $nonceStore,
            $logger
        );
    }

    public function verifyJsonBodySigned(WP_REST_Request $request, string $scope): array|WP_Error
    {
        $rawBody = (string) $request->get_body();
        $sigHeader = (string) $request->get_header('x-medlab-signature');
        if ($sigHeader === '') {
            return new WP_Error('ml_auth_missing', 'Missing signature', ['status' => 401]);
        }

        $parts = explode('.', $sigHeader);
        if (count($parts) !== 3 || $parts[0] !== 'mls1') {
            return new WP_Error('ml_auth_format', 'Invalid signature format', ['status' => 401]);
        }

        $payload = Base64Url::decode($parts[1]);
        $sigHex = strtolower($parts[2]);
        if ($payload === null || !preg_match('/^[0-9a-f]{64}$/', $sigHex)) {
            return new WP_Error('ml_auth_sig', 'Invalid signature', ['status' => 401]);
        }

        if (!hash_equals($payload, $rawBody) || !$this->verifyHmacHex($rawBody, $sigHex)) {
            return new WP_Error('ml_auth_bad_sig', 'Invalid signature', ['status' => 401]);
        }

        $data = json_decode($rawBody, true);
        if (!is_array($data)) {
            return new WP_Error('ml_auth_bad_json', 'Invalid JSON', ['status' => 400]);
        }

        $tsMs = $data['ts_ms'] ?? null;
        $nonce = $data['nonce'] ?? null;
        $reqId = isset($data['req_id']) && is_string($data['req_id']) ? $data['req_id'] : null;
        if (!is_int($tsMs) && !(is_string($tsMs) && ctype_digit($tsMs))) {
            return new WP_Error('ml_auth_no_ts', 'Missing ts_ms', ['status' => 401]);
        }
        if (!is_string($nonce) || $nonce === '') {
            return new WP_Error('ml_auth_no_nonce', 'Missing nonce', ['status' => 401]);
        }

        $skew = abs(((int) floor(microtime(true) * 1000)) - (int) $tsMs);
        if ($skew > $this->skewWindowMs) {
            $this->logger->warning('security.mls1.rejected', ['reason' => 'ts_ms_skew', 'skew_ms' => $skew, 'scope' => $scope], $reqId);
            return new WP_Error('ml_auth_expired', 'Expired signature', ['status' => 401]);
        }

        if (!$this->nonceStore->checkAndStore($scope, $nonce, (int) $tsMs, 120, $reqId)) {
            return new WP_Error('ml_auth_replay', 'Replay detected', ['status' => 409]);
        }

        return ['data' => $data, 'req_id' => $reqId];
    }

    private function verifyHmacHex(string $rawBody, string $sigHex): bool
    {
        $active = hash_hmac('sha256', $rawBody, $this->secretActive, false);
        if (hash_equals(strtolower($active), $sigHex)) {
            return true;
        }

        if ($this->secretPrevious) {
            $previous = hash_hmac('sha256', $rawBody, $this->secretPrevious, false);
            return hash_equals(strtolower($previous), $sigHex);
        }

        return false;
    }
}
