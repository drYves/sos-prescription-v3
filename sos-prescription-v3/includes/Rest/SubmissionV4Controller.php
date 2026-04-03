<?php
// includes/Rest/SubmissionV4Controller.php
declare(strict_types=1);

namespace SosPrescription\Rest;

use SOSPrescription\Core\ReqId;
use SosPrescription\Services\RestGuard;
use SosPrescription\Services\Turnstile;
use WP_Error;
use WP_REST_Request;
use WP_REST_Response;

defined('ABSPATH') || exit;

final class SubmissionV4Controller extends \WP_REST_Controller
{
    private const WORKER_SCHEMA_VERSION = '2026.6';
    private const DEFAULT_TIMEOUT_S = 12;
    private const NAMESPACE_V4 = 'sosprescription/v4';

    public static function register(): void
    {
        add_action('rest_api_init', static function (): void {
            $controller = new self();

            register_rest_route(self::NAMESPACE_V4, '/form/submissions', [
                'methods' => 'POST',
                'callback' => [$controller, 'create_submission'],
                'permission_callback' => [$controller, 'permissions_check_logged_in_nonce'],
            ]);

            register_rest_route(self::NAMESPACE_V4, '/form/submissions/(?P<submission_ref>[A-Za-z0-9_-]{8,128})/finalize', [
                'methods' => 'POST',
                'callback' => [$controller, 'finalize_submission'],
                'permission_callback' => [$controller, 'permissions_check_logged_in_nonce'],
                'args' => [
                    'submission_ref' => [
                        'required' => true,
                        'sanitize_callback' => static function ($value): string {
                            return is_scalar($value) ? trim((string) $value) : '';
                        },
                    ],
                ],
            ]);
        });
    }

    public function permissions_check_logged_in_nonce(WP_REST_Request $request): bool|WP_Error
    {
        $ok = RestGuard::require_logged_in($request);
        if (is_wp_error($ok)) {
            return $ok;
        }

        return RestGuard::require_wp_rest_nonce($request);
    }

    public function create_submission(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $reqId = ReqId::coalesce(null);
        $params = $this->request_data($request);

        if (Turnstile::should_enforce()) {
            $token = trim((string) ($params['turnstileToken'] ?? ($params['turnstile_token'] ?? '')));
            $remoteIp = isset($_SERVER['REMOTE_ADDR']) ? (string) wp_unslash($_SERVER['REMOTE_ADDR']) : null;
            $verified = Turnstile::verify_token($token, $remoteIp !== null && trim($remoteIp) !== '' ? $remoteIp : null);
            if (is_wp_error($verified)) {
                return $verified;
            }
        }

        $payload = [
            'actor' => $this->build_patient_actor_payload(),
        ];

        $flow = $this->normalize_optional_scalar_string($params['flow'] ?? null);
        if ($flow !== null) {
            $payload['flow'] = $flow;
        }

        $priority = $this->normalize_optional_scalar_string($params['priority'] ?? null);
        if ($priority !== null) {
            $payload['priority'] = $priority;
        }

        $idempotencyKey = $this->normalize_optional_scalar_string($params['idempotency_key'] ?? null);
        if ($idempotencyKey !== null) {
            $payload['idempotency_key'] = $idempotencyKey;
        }

        try {
            return $this->worker_post_signed_json('/api/v2/submissions', $payload, $reqId);
        } catch (\Throwable $e) {
            return ErrorResponder::worker_bridge_error(
                $e,
                'sosprescription_worker_submission_failed',
                'Le service sécurisé est temporairement indisponible.',
                502,
                $reqId,
                [
                    'controller' => __CLASS__,
                    'action' => 'create_submission',
                ],
                'submission_v4.init.failed'
            );
        }
    }

    public function finalize_submission(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $reqId = ReqId::coalesce(null);
        $submissionRef = $this->sanitize_submission_ref($request->get_param('submission_ref'));
        if ($submissionRef === '') {
            return new WP_Error(
                'sosprescription_bad_submission_ref',
                'Référence de soumission invalide.',
                ['status' => 400, 'req_id' => $reqId]
            );
        }

        $params = $this->request_data($request);
        unset(
            $params['submission_ref'],
            $params['actor'],
            $params['req_id'],
            $params['schema_version'],
            $params['site_id'],
            $params['ts_ms'],
            $params['nonce'],
            $params['turnstileToken'],
            $params['turnstile_token']
        );

        $payload = is_array($params) ? $params : [];
        $payload['actor'] = $this->build_patient_actor_payload();

        try {
            return $this->worker_post_signed_json(
                '/api/v2/submissions/' . rawurlencode($submissionRef) . '/finalize',
                $payload,
                $reqId
            );
        } catch (\Throwable $e) {
            return ErrorResponder::worker_bridge_error(
                $e,
                'sosprescription_worker_submission_failed',
                'Le service sécurisé est temporairement indisponible.',
                502,
                $reqId,
                [
                    'controller' => __CLASS__,
                    'action' => 'finalize_submission',
                    'submission_ref' => $submissionRef,
                ],
                'submission_v4.finalize.failed'
            );
        }
    }

    /**
     * @return array<string, mixed>
     */
    private function request_data(WP_REST_Request $request): array
    {
        $json = $request->get_json_params();
        if (is_array($json) && $json !== []) {
            return $json;
        }

        $body = $request->get_body_params();
        if (is_array($body) && $body !== []) {
            return $body;
        }

        return [];
    }

    /**
     * @return array{role:string,wp_user_id:int}
     */
    private function build_patient_actor_payload(): array
    {
        return [
            'role' => 'PATIENT',
            'wp_user_id' => (int) get_current_user_id(),
        ];
    }

    private function sanitize_submission_ref(mixed $value): string
    {
        if (!is_scalar($value)) {
            return '';
        }

        $ref = trim((string) $value);
        if ($ref === '' || strlen($ref) > 128 || !preg_match('/^[A-Za-z0-9_-]{8,128}$/', $ref)) {
            return '';
        }

        return $ref;
    }

    private function normalize_optional_scalar_string(mixed $value): ?string
    {
        if ($value === null) {
            return null;
        }

        if (!is_scalar($value)) {
            return null;
        }

        $normalized = trim((string) $value);
        return $normalized !== '' ? $normalized : null;
    }

    /**
     * @param array<string, mixed> $payload
     */
    private function worker_post_signed_json(string $path, array $payload, string $reqId): WP_REST_Response
    {
        $body = $this->normalize_envelope($payload, $reqId);
        $rawJson = wp_json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if (!is_string($rawJson) || $rawJson === '') {
            throw new \RuntimeException('JSON encode failed');
        }

        $workerBaseUrl = $this->get_worker_base_url();
        $normalizedPath = $this->normalize_api_path($path);
        $secret = $this->get_hmac_secret();
        $kid = $this->read_config_string('ML_HMAC_KID', 'primary');

        $headers = [
            'Accept' => 'application/json',
            'Content-Type' => 'application/json; charset=utf-8',
            'X-MedLab-Signature' => $this->build_mls1_token($rawJson, $secret),
        ];
        if ($kid !== '') {
            $headers['X-MedLab-Kid'] = $kid;
        }

        $response = wp_remote_post($workerBaseUrl . $normalizedPath, [
            'headers' => $headers,
            'body' => $rawJson,
            'method' => 'POST',
            'timeout' => $this->get_worker_timeout_seconds(),
            'redirection' => 0,
            'blocking' => true,
            'data_format' => 'body',
        ]);

        if (is_wp_error($response)) {
            throw new \RuntimeException('Requête bloquée par WordPress : ' . $response->get_error_message());
        }

        $status = (int) wp_remote_retrieve_response_code($response);
        $responseBody = (string) wp_remote_retrieve_body($response);
        $responseHeaders = wp_remote_retrieve_headers($response);
        $sigHeader = $this->get_header_value($responseHeaders, 'x-medlab-signature');

        if (!$this->verify_mls1_signed_body($sigHeader, $responseBody)) {
            throw new \RuntimeException('Invalid Worker response signature');
        }

        $decoded = json_decode($responseBody, true);
        if (!is_array($decoded)) {
            throw new \RuntimeException('Invalid Worker JSON response');
        }

        if (!isset($decoded['req_id']) || !is_scalar($decoded['req_id']) || trim((string) $decoded['req_id']) === '') {
            $decoded['req_id'] = $reqId;
        }

        if ($status < 200 || $status >= 300 || (array_key_exists('ok', $decoded) && $decoded['ok'] !== true)) {
            $code = isset($decoded['code']) && is_scalar($decoded['code']) ? (string) $decoded['code'] : 'ML_WORKER_REJECTED';
            $message = isset($decoded['message']) && is_scalar($decoded['message']) ? (string) $decoded['message'] : 'Rejeté';
            throw new \RuntimeException(sprintf('Worker HTTP %d : %s (%s)', $status, $message, $code));
        }

        $restResponse = new WP_REST_Response($decoded, $status);
        $restResponse->header('X-SOSPrescription-Request-ID', (string) $decoded['req_id']);
        $restResponse->header('Cache-Control', 'no-store, no-cache, must-revalidate');
        $restResponse->header('Pragma', 'no-cache');
        $restResponse->header('Expires', '0');

        return $restResponse;
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    private function normalize_envelope(array $payload, string $reqId): array
    {
        $body = $payload;
        $body['schema_version'] = self::WORKER_SCHEMA_VERSION;
        $body['site_id'] = $this->get_worker_site_id();
        $body['ts_ms'] = (int) floor(microtime(true) * 1000);
        $body['nonce'] = bin2hex(random_bytes(16));
        $body['req_id'] = $reqId;

        return $body;
    }

    private function get_worker_base_url(): string
    {
        $baseUrl = trim($this->read_config_string('ML_WORKER_BASE_URL'));
        if ($baseUrl === '') {
            throw new \RuntimeException('Missing ML_WORKER_BASE_URL');
        }

        return rtrim($baseUrl, '/');
    }

    private function get_worker_site_id(): string
    {
        $siteId = trim($this->read_config_string('ML_SITE_ID'));
        if ($siteId !== '') {
            return $siteId;
        }

        $home = home_url('/');
        return is_string($home) && trim($home) !== '' ? trim($home) : 'unknown_site';
    }

    private function get_hmac_secret(): string
    {
        $secret = $this->read_config_string('ML_HMAC_SECRET');
        if ($secret === '') {
            throw new \RuntimeException('Missing ML_HMAC_SECRET');
        }

        return $secret;
    }

    private function get_worker_timeout_seconds(): int
    {
        $raw = $this->read_config_string('ML_WORKER_INGEST_TIMEOUT_S', (string) self::DEFAULT_TIMEOUT_S);
        $timeout = is_numeric($raw) ? (int) $raw : self::DEFAULT_TIMEOUT_S;

        return max(2, $timeout);
    }

    private function build_mls1_token(string $rawPayload, string $secret): string
    {
        $payloadB64 = rtrim(strtr(base64_encode($rawPayload), '+/', '-_'), '=');
        $sigHex = hash_hmac('sha256', $rawPayload, $secret, false);

        return sprintf('mls1.%s.%s', $payloadB64, $sigHex);
    }

    private function verify_mls1_signed_body(?string $token, string $rawBody): bool
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
        if (!is_string($payload) || !hash_equals($payload, $rawBody)) {
            return false;
        }

        $sigHex = strtolower((string) $parts[2]);
        if (!preg_match('/^[0-9a-f]{64}$/', $sigHex)) {
            return false;
        }

        $current = hash_hmac('sha256', $rawBody, $this->get_hmac_secret(), false);
        if (hash_equals(strtolower($current), $sigHex)) {
            return true;
        }

        $previousSecret = trim($this->read_config_string('ML_HMAC_SECRET_PREVIOUS'));
        if ($previousSecret !== '') {
            $previous = hash_hmac('sha256', $rawBody, $previousSecret, false);
            if (hash_equals(strtolower($previous), $sigHex)) {
                return true;
            }
        }

        return false;
    }

    private function get_header_value(mixed $headers, string $name): ?string
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

    private function read_config_string(string $name, string $default = ''): string
    {
        if (defined($name)) {
            $constant = constant($name);
            if (is_scalar($constant)) {
                return trim((string) $constant);
            }
        }

        $value = getenv($name);
        if (is_string($value)) {
            return trim($value);
        }

        return $default;
    }

    private function normalize_api_path(string $path): string
    {
        $normalized = '/' . ltrim(trim($path), '/');
        return preg_replace('#/+#', '/', $normalized) ?: '/';
    }
}
