<?php
// includes/Services/V4WorkerTransport.php

declare(strict_types=1);

namespace SosPrescription\Services;

use SosPrescription\Core\NdjsonLogger;
use SOSPrescription\Core\WorkerApiClient;
use Throwable;
use WP_Error;
use WP_REST_Response;

final class V4WorkerTransport
{
    /** @var array<string, WorkerApiClient> */
    private array $workerClients = [];

    private NdjsonLogger $logger;
    private string $siteId;

    public function __construct(private V4InputNormalizer $normalizer)
    {
        $this->siteId = $this->resolveSiteId();
        $env = $this->readConfigString('SOSPRESCRIPTION_ENV', 'prod');
        $this->logger = new NdjsonLogger('web', $this->siteId, $env);
    }

    public function buildReqId(): string
    {
        if (class_exists('\\SosPrescription\\Services\\Logger') && method_exists('\\SosPrescription\\Services\\Logger', 'get_request_id')) {
            $candidate = trim((string) \SosPrescription\Services\Logger::get_request_id());
            if ($candidate !== '') {
                return $candidate;
            }
        }

        try {
            return 'req_' . bin2hex(random_bytes(8));
        } catch (Throwable $e) {
            return 'req_' . md5((string) wp_rand() . microtime(true));
        }
    }

    public function toResponse(mixed $payload, int $status, string $reqId): WP_REST_Response
    {
        $normalized = $this->normalizer->normalizePayload($payload);
        if (!isset($normalized['req_id']) || !is_scalar($normalized['req_id']) || trim((string) $normalized['req_id']) === '') {
            $normalized['req_id'] = $reqId;
        }

        $response = new WP_REST_Response($normalized, $status);
        $response->header('X-SOSPrescription-Request-ID', (string) $normalized['req_id']);
        $response->header('Cache-Control', 'no-store, no-cache, must-revalidate');
        $response->header('Pragma', 'no-cache');
        $response->header('Expires', '0');

        return $response;
    }

    /**
     * @return array{role:string,wp_user_id:int}
     */
    public function buildActorPayload(): array
    {
        $wpUserId = max(0, (int) get_current_user_id());

        return [
            'role' => $this->resolveActorRole($wpUserId),
            'wp_user_id' => $wpUserId,
        ];
    }

    /**
     * @return array<string, mixed>
     */
    public function polishMessage(string $draft, array $constraints, string $reqId): array
    {
        return $this->workerClient()->postSignedJson(
            '/api/v2/messages/polish',
            [
                'actor' => $this->buildActorPayload(),
                'draft' => $draft,
                'constraints' => $constraints,
            ],
            $reqId,
            'messages_v4_polish'
        );
    }

    /**
     * @return array<string, mixed>
     */
    public function createSubmissionDraft(
        string $email,
        string $flow,
        string $priority,
        string $redirectTo,
        string $verifyUrl,
        string $idempotencyKey,
        string $reqId
    ): array {
        return $this->workerClient(30)->postSignedJson(
            '/api/v2/submissions/draft',
            [
                'email' => $email,
                'flow' => $flow,
                'priority' => $priority,
                'redirect_to' => $redirectTo,
                'verify_url' => $verifyUrl,
                'idempotency_key' => $idempotencyKey,
            ],
            $reqId,
            'submission_v4_draft_create'
        );
    }

    /**
     * @return array<string, mixed>
     */
    public function fetchSmartReplies(string $workerPrescriptionId, string $reqId): array
    {
        $actor = $this->buildActorPayload();
        $query = http_build_query($this->buildActorQueryParams($actor), '', '&', PHP_QUERY_RFC3986);

        return $this->workerClient()->getSignedJson(
            '/api/v2/prescriptions/' . rawurlencode($workerPrescriptionId) . '/smart-replies?' . $query,
            $reqId,
            'messages_v4_smart_replies'
        );
    }

    public function medicationsSearch(string $query, int $limit): WP_REST_Response|WP_Error
    {
        $query = trim($query);
        $limit = max(1, min(50, $limit));
        $reqId = $this->buildReqId();
        $actor = $this->buildPublicActorPayload();

        $requestPath = '/api/v2/medications/search?' . http_build_query(
            array_merge(
                [
                    'q' => $query,
                    'limit' => $limit,
                    'site_id' => $this->siteId,
                ],
                $this->buildActorQueryParams($actor)
            ),
            '',
            '&',
            PHP_QUERY_RFC3986
        );

        try {
            $response = wp_remote_get($this->workerBaseUrl() . $requestPath, [
                'timeout' => 15,
                'headers' => $this->buildSignedGetHeaders($requestPath),
                'redirection' => 0,
                'blocking' => true,
            ]);
        } catch (Throwable $e) {
            $this->logger->error('worker.bridge.medications_search_transport_exception', [
                'path' => $requestPath,
                'actor_role' => $actor['role'],
                'actor_wp_user_id' => $actor['wp_user_id'],
                'limit' => $limit,
            ], $reqId, $e);

            return new WP_Error(
                'worker_unreachable',
                'Moteur de recherche injoignable.',
                ['status' => 502, 'req_id' => $reqId]
            );
        }

        if (is_wp_error($response)) {
            $this->logger->error('worker.bridge.medications_search_http_error', [
                'path' => $requestPath,
                'actor_role' => $actor['role'],
                'actor_wp_user_id' => $actor['wp_user_id'],
                'limit' => $limit,
                'error_code' => (string) $response->get_error_code(),
                'error_message' => trim((string) $response->get_error_message()),
            ], $reqId);

            return new WP_Error(
                'worker_unreachable',
                'Moteur de recherche injoignable.',
                ['status' => 502, 'req_id' => $reqId]
            );
        }

        $statusCode = (int) wp_remote_retrieve_response_code($response);
        $rawBody = $this->sanitizeJsonBody((string) wp_remote_retrieve_body($response));
        $decodedBody = json_decode($rawBody, true);

        if (json_last_error() !== JSON_ERROR_NONE || !is_array($decodedBody)) {
            $this->logger->error('worker.bridge.medications_search_bad_json', [
                'path' => $requestPath,
                'http_status' => $statusCode,
                'response_bytes' => strlen($rawBody),
                'response_sha256' => hash('sha256', $rawBody),
                'response_prefix_hex' => bin2hex(substr($rawBody, 0, 32)),
                'json_error' => json_last_error_msg(),
            ], $reqId);

            return new WP_Error(
                'worker_invalid_response',
                'Réponse invalide du moteur de recherche.',
                ['status' => 502, 'req_id' => $reqId]
            );
        }

        $restResponse = new WP_REST_Response($decodedBody, $statusCode > 0 ? $statusCode : 502);
        $restResponse->header('Cache-Control', 'no-store, no-cache, must-revalidate');
        $restResponse->header('Pragma', 'no-cache');
        $restResponse->header('Expires', '0');
        $restResponse->header('X-SOSPrescription-Request-ID', $reqId);

        return $restResponse;
    }

    private function workerClient(?int $timeoutS = null): WorkerApiClient
    {
        if (!class_exists(WorkerApiClient::class)) {
            throw new \RuntimeException('WorkerApiClient introuvable.');
        }

        $cacheKey = $timeoutS !== null ? 'timeout_' . max(1, (int) $timeoutS) : 'default';
        if (isset($this->workerClients[$cacheKey])) {
            return $this->workerClients[$cacheKey];
        }

        if ($timeoutS === null) {
            $this->workerClients[$cacheKey] = WorkerApiClient::fromEnv($this->logger, $this->siteId);
            return $this->workerClients[$cacheKey];
        }

        $secret = trim((string) $this->readConfigString('ML_HMAC_SECRET', ''));
        if ($secret === '') {
            throw new \RuntimeException('Missing ML_HMAC_SECRET');
        }

        $kid = trim((string) $this->readConfigString('ML_HMAC_KID', ''));
        $workerBaseUrl = trim((string) $this->readConfigString('ML_WORKER_BASE_URL', ''));
        $previous = trim((string) $this->readConfigString('ML_HMAC_SECRET_PREVIOUS', ''));

        $this->workerClients[$cacheKey] = new WorkerApiClient(
            $this->logger,
            $this->siteId,
            $secret,
            $kid !== '' ? $kid : null,
            $workerBaseUrl !== '' ? $workerBaseUrl : null,
            max(1, (int) $timeoutS),
            $previous !== '' ? $previous : null
        );

        return $this->workerClients[$cacheKey];
    }

    /**
     * @return array{role:string,wp_user_id:?int}
     */
    private function buildPublicActorPayload(): array
    {
        $actor = $this->buildActorPayload();
        $wpUserId = isset($actor['wp_user_id']) ? (int) $actor['wp_user_id'] : 0;
        if ($wpUserId > 0) {
            return [
                'role' => (string) $actor['role'],
                'wp_user_id' => $wpUserId,
            ];
        }

        return [
            'role' => 'SYSTEM',
            'wp_user_id' => null,
        ];
    }

    private function resolveActorRole(int $wpUserId): string
    {
        if ($wpUserId < 1) {
            return 'SYSTEM';
        }

        if (current_user_can('manage_options') || current_user_can('sosprescription_manage')) {
            return 'SYSTEM';
        }

        if (current_user_can('sosprescription_validate') || current_user_can('edit_others_posts')) {
            return 'DOCTOR';
        }

        return 'PATIENT';
    }

    /**
     * @param array{role:string,wp_user_id:int|null} $actor
     * @return array<string, string>
     */
    private function buildActorQueryParams(array $actor): array
    {
        $params = [
            'actor_role' => strtoupper(trim((string) ($actor['role'] ?? 'PATIENT'))) ?: 'PATIENT',
        ];

        $wpUserId = isset($actor['wp_user_id']) && is_numeric($actor['wp_user_id'])
            ? (int) $actor['wp_user_id']
            : 0;

        if ($wpUserId > 0) {
            $params['actor_wp_user_id'] = (string) $wpUserId;
        }

        return $params;
    }

    /**
     * @return array<string, string>
     */
    private function buildSignedGetHeaders(string $path): array
    {
        $secret = trim((string) $this->readConfigString('ML_HMAC_SECRET', ''));
        if ($secret === '') {
            throw new \RuntimeException('Missing ML_HMAC_SECRET');
        }

        $normalizedPath = '/' . ltrim(trim($path), '/');
        $tsMs = (int) floor(microtime(true) * 1000);
        $nonce = $this->generateUrlSafeRandom(16);
        $canonicalPayload = sprintf('GET|%s|%d|%s', $normalizedPath, $tsMs, $nonce);

        $headers = [
            'Accept' => 'application/json',
            'X-MedLab-Signature' => $this->buildMls1Token($canonicalPayload, $secret),
            'Cache-Control' => 'no-cache, no-store, must-revalidate',
            'Pragma' => 'no-cache',
        ];

        $kid = trim((string) $this->readConfigString('ML_HMAC_KID', ''));
        if ($kid !== '') {
            $headers['X-MedLab-Kid'] = $kid;
        }

        return $headers;
    }

    private function buildMls1Token(string $rawPayload, string $secret): string
    {
        $payloadB64 = rtrim(strtr(base64_encode($rawPayload), '+/', '-_'), '=');
        $sigHex = hash_hmac('sha256', $rawPayload, $secret, false);

        return sprintf('mls1.%s.%s', $payloadB64, $sigHex);
    }

    private function workerBaseUrl(): string
    {
        $baseUrl = trim((string) $this->readConfigString('ML_WORKER_BASE_URL', ''));
        if ($baseUrl !== '') {
            return rtrim($baseUrl, '/');
        }

        return 'https://sos-v3-prod.osc-fr1.scalingo.io';
    }

    private function sanitizeJsonBody(string $body): string
    {
        if (str_starts_with($body, "\xEF\xBB\xBF")) {
            $body = substr($body, 3);
        }

        return trim($body);
    }

    private function generateUrlSafeRandom(int $bytesLength): string
    {
        try {
            $bytes = random_bytes(max(8, $bytesLength));
        } catch (Throwable $e) {
            $bytes = (string) wp_generate_password(max(8, $bytesLength), true, true);
        }

        return rtrim(strtr(base64_encode((string) $bytes), '+/', '-_'), '=');
    }

    private function resolveSiteId(): string
    {
        $siteId = trim((string) $this->readConfigString('ML_SITE_ID', ''));
        if ($siteId !== '') {
            return $siteId;
        }

        $home = home_url('/');
        return is_string($home) && trim($home) !== '' ? trim($home) : 'unknown_site';
    }

    private function readConfigString(string $name, string $default = ''): string
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
