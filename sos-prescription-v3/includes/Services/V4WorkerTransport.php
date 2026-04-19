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
        if (class_exists('\SosPrescription\\Services\\Logger') && method_exists('\SosPrescription\\Services\\Logger', 'get_request_id')) {
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
        return [
            'role' => 'DOCTOR',
            'wp_user_id' => max(1, (int) get_current_user_id()),
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
        $query = http_build_query([
            'actor_role' => $actor['role'],
            'actor_wp_user_id' => (string) $actor['wp_user_id'],
        ], '', '&', PHP_QUERY_RFC3986);

        return $this->workerClient()->getSignedJson(
            '/api/v2/prescriptions/' . rawurlencode($workerPrescriptionId) . '/smart-replies?' . $query,
            $reqId,
            'messages_v4_smart_replies'
        );
    }

    public function medicationsSearch(string $query, int $limit): WP_REST_Response|WP_Error
    {
        $workerUrl = 'https://sos-v3-prod.osc-fr1.scalingo.io/api/v2/medications/search';
        $requestUrl = add_query_arg(
            [
                'q' => $query,
                'limit' => max(1, min(50, $limit)),
            ],
            $workerUrl
        );

        $response = wp_remote_get($requestUrl, [
            'timeout' => 15,
            'headers' => [
                'Accept' => 'application/json',
            ],
        ]);

        if (is_wp_error($response)) {
            return new WP_Error(
                'worker_unreachable',
                'Moteur de recherche injoignable.',
                ['status' => 500]
            );
        }

        $statusCode = (int) wp_remote_retrieve_response_code($response);
        $rawBody = wp_remote_retrieve_body($response);
        $decodedBody = json_decode($rawBody, true);

        if (json_last_error() !== JSON_ERROR_NONE) {
            return new WP_Error(
                'worker_invalid_response',
                'Réponse invalide du moteur de recherche.',
                ['status' => 502]
            );
        }

        return new WP_REST_Response($decodedBody, $statusCode > 0 ? $statusCode : 502);
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
