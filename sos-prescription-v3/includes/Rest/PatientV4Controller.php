<?php
// includes/Rest/PatientV4Controller.php
declare(strict_types=1);

namespace SosPrescription\Rest;

use SOSPrescription\Core\ReqId;
use SosPrescription\Services\RestGuard;
use WP_Error;
use WP_REST_Request;
use WP_REST_Response;

defined('ABSPATH') || exit;

final class PatientV4Controller extends \WP_REST_Controller
{
    private const WORKER_SCHEMA_VERSION = '2026.6';
    private const DEFAULT_TIMEOUT_S = 12;
    private const NAMESPACE_V4 = 'sosprescription/v4';

    public static function register(): void
    {
        add_action('rest_api_init', static function (): void {
            $controller = new self();

            register_rest_route(self::NAMESPACE_V4, '/patient/profile', [
                'methods' => 'GET',
                'callback' => [$controller, 'get_profile'],
                'permission_callback' => [$controller, 'permissions_check_logged_in_nonce'],
            ]);

            register_rest_route(self::NAMESPACE_V4, '/patient/profile', [
                'methods' => 'PUT',
                'callback' => [$controller, 'update_profile'],
                'permission_callback' => [$controller, 'permissions_check_logged_in_nonce'],
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

    public function get_profile(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $reqId = ReqId::coalesce(null);
        $actor = $this->build_patient_actor_payload();

        try {
            return $this->worker_get_signed_json(
                $this->build_patient_profile_get_path($actor),
                $reqId
            );
        } catch (\Throwable $e) {
            return ErrorResponder::worker_bridge_error(
                $e,
                'sosprescription_patient_profile_fetch_failed',
                'Le profil patient sécurisé est temporairement indisponible.',
                502,
                $reqId,
                [
                    'controller' => __CLASS__,
                    'action' => 'get_profile',
                    'wp_user_id' => $actor['wp_user_id'],
                ],
                'patient_v4.profile.fetch.failed'
            );
        }
    }

    public function update_profile(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $reqId = ReqId::coalesce(null);
        $params = $this->request_data($request);

        unset(
            $params['actor'],
            $params['req_id'],
            $params['schema_version'],
            $params['site_id'],
            $params['ts_ms'],
            $params['nonce']
        );

        $payload = is_array($params) ? $params : [];
        $payload['actor'] = $this->build_patient_actor_payload();

        try {
            return $this->worker_put_signed_json('/api/v2/patient/profile', $payload, $reqId);
        } catch (\Throwable $e) {
            return ErrorResponder::worker_bridge_error(
                $e,
                'sosprescription_patient_profile_update_failed',
                'Le profil n’a pas pu être enregistré.',
                502,
                $reqId,
                [
                    'controller' => __CLASS__,
                    'action' => 'update_profile',
                    'wp_user_id' => (int) get_current_user_id(),
                ],
                'patient_v4.profile.update.failed'
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

    /**
     * @param array{role:string,wp_user_id:int} $actor
     */
    private function build_patient_profile_get_path(array $actor): string
    {
        $query = http_build_query([
            'role' => (string) $actor['role'],
            'wp_user_id' => (int) $actor['wp_user_id'],
        ], '', '&', PHP_QUERY_RFC3986);

        return '/api/v2/patient/profile?' . $query;
    }

    /**
     * @param array<string, mixed> $payload
     */
    private function worker_put_signed_json(string $path, array $payload, string $reqId): WP_REST_Response|WP_Error
    {
        $body = $this->normalize_envelope($payload, $reqId);
        $rawJson = wp_json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if (!is_string($rawJson) || $rawJson === '') {
            throw new \RuntimeException('JSON encode failed');
        }

        return $this->dispatch_worker_request(
            'PUT',
            $path,
            [
                'Accept' => 'application/json',
                'Content-Type' => 'application/json; charset=utf-8',
                'X-MedLab-Signature' => $this->build_mls1_token($rawJson, $this->get_hmac_secret()),
            ],
            $rawJson,
            $reqId
        );
    }

    private function worker_get_signed_json(string $path, string $reqId): WP_REST_Response|WP_Error
    {
        $normalizedPath = $this->normalize_api_path($path);
        $token = $this->build_mls1_get_token($normalizedPath, $this->get_hmac_secret());

        return $this->dispatch_worker_request(
            'GET',
            $normalizedPath,
            [
                'Accept' => 'application/json',
                'X-MedLab-Signature' => $token,
            ],
            null,
            $reqId
        );
    }

    private function dispatch_worker_request(
        string $method,
        string $path,
        array $headers,
        ?string $body,
        string $reqId
    ): WP_REST_Response|WP_Error {
        $workerBaseUrl = $this->get_worker_base_url();
        $normalizedPath = $this->normalize_api_path($path);
        $kid = $this->read_config_string('ML_HMAC_KID', 'primary');
        if ($kid !== '') {
            $headers['X-MedLab-Kid'] = $kid;
        }

        $args = [
            'headers' => $headers,
            'method' => strtoupper($method),
            'timeout' => $this->get_worker_timeout_seconds(),
            'redirection' => 0,
            'blocking' => true,
            'data_format' => 'body',
        ];

        if ($body !== null) {
            $args['body'] = $body;
        }

        $response = strtoupper($method) === 'GET'
            ? wp_remote_get($workerBaseUrl . $normalizedPath, $args)
            : wp_remote_request($workerBaseUrl . $normalizedPath, $args);

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

        $workerReqId = isset($decoded['req_id']) && is_scalar($decoded['req_id']) && trim((string) $decoded['req_id']) !== ''
            ? trim((string) $decoded['req_id'])
            : $reqId;

        if ($status < 200 || $status >= 300 || (array_key_exists('ok', $decoded) && $decoded['ok'] !== true)) {
            $code = isset($decoded['code']) && is_scalar($decoded['code']) ? (string) $decoded['code'] : 'sosprescription_patient_profile_failed';
            $message = isset($decoded['message']) && is_scalar($decoded['message'])
                ? (string) $decoded['message']
                : 'La requête n’a pas pu être traitée.';

            return new WP_Error(
                $code,
                $message,
                [
                    'status' => $status >= 400 ? $status : 502,
                    'req_id' => $workerReqId,
                ]
            );
        }

        $restResponse = new WP_REST_Response($decoded, $status);
        $restResponse->header('X-SOSPrescription-Request-ID', $workerReqId);
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

    private function build_mls1_get_token(string $path, string $secret): string
    {
        $tsMs = (int) floor(microtime(true) * 1000);
        $nonce = bin2hex(random_bytes(16));
        $payload = sprintf('GET|%s|%d|%s', $path, $tsMs, $nonce);

        return $this->build_mls1_token($payload, $secret);
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
