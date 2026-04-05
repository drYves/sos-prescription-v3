<?php // includes/Rest/SubmissionV4Controller.php
declare(strict_types=1);

namespace SosPrescription\Rest;

use SOSPrescription\Core\NdjsonLogger;
use SOSPrescription\Core\ReqId;
use SOSPrescription\Core\WorkerApiClient;
use SosPrescription\Services\RestGuard;
use WP_Error;
use WP_REST_Request;
use WP_REST_Response;

defined('ABSPATH') || exit;

final class SubmissionV4Controller extends \WP_REST_Controller
{
    private const NAMESPACE_V4 = 'sosprescription/v4';

    private ?WorkerApiClient $workerApiClient = null;

    public static function register(): void
    {
        $controller = new self();

        register_rest_route(self::NAMESPACE_V4, '/form/submissions', [
            'methods' => 'POST',
            'callback' => [$controller, 'create_submission'],
            'permission_callback' => [$controller, 'permissions_check_logged_in_nonce'],
        ]);

        register_rest_route(self::NAMESPACE_V4, '/form/submissions/(?P<ref>[A-Za-z0-9_-]{8,128})/finalize', [
            'methods' => 'POST',
            'callback' => [$controller, 'finalize_submission'],
            'permission_callback' => [$controller, 'permissions_check_logged_in_nonce'],
            'args' => [
                'ref' => [
                    'required' => true,
                    'sanitize_callback' => static function ($value): string {
                        return is_scalar($value) ? trim((string) $value) : '';
                    },
                ],
            ],
        ]);
    }

    public function permissions_check_logged_in_nonce(WP_REST_Request $request): bool|WP_Error
    {
        $loggedIn = RestGuard::require_logged_in($request);
        if (is_wp_error($loggedIn)) {
            return $loggedIn;
        }

        return RestGuard::require_wp_rest_nonce($request);
    }

    public function create_submission(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $reqId = ReqId::coalesce(null);
        $params = $this->request_data($request);

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
            $workerPayload = $this->get_worker_api_client()->postSignedJson(
                '/api/v2/submissions',
                $payload,
                $reqId,
                'submission_v4_create'
            );

            return $this->to_rest_response($workerPayload, 201, $reqId);
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
        $submissionRef = $this->sanitize_submission_ref(
            $request->get_param('ref') ?? $request->get_param('submission_ref')
        );

        if ($submissionRef === '') {
            return new WP_Error(
                'sosprescription_bad_submission_ref',
                'Référence de soumission invalide.',
                [
                    'status' => 400,
                    'req_id' => $reqId,
                ]
            );
        }

        $params = $this->request_data($request);
        unset(
            $params['ref'],
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
            $workerPayload = $this->get_worker_api_client()->postSignedJson(
                '/api/v2/submissions/' . rawurlencode($submissionRef) . '/finalize',
                $payload,
                $reqId,
                'submission_v4_finalize'
            );

            return $this->to_rest_response($workerPayload, 200, $reqId);
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
        if ($value === null || !is_scalar($value)) {
            return null;
        }

        $normalized = trim((string) $value);
        return $normalized !== '' ? $normalized : null;
    }

    private function get_worker_api_client(): WorkerApiClient
    {
        if ($this->workerApiClient instanceof WorkerApiClient) {
            return $this->workerApiClient;
        }

        $this->workerApiClient = WorkerApiClient::fromEnv(new NdjsonLogger('web'));
        return $this->workerApiClient;
    }

    /**
     * @param array<string, mixed> $payload
     */
    private function to_rest_response(array $payload, int $status, string $reqId): WP_REST_Response
    {
        if (!isset($payload['req_id']) || !is_scalar($payload['req_id']) || trim((string) $payload['req_id']) === '') {
            $payload['req_id'] = $reqId;
        }

        $response = new WP_REST_Response($payload, $status);
        $response->header('X-SOSPrescription-Request-ID', (string) $payload['req_id']);
        $response->header('Cache-Control', 'no-store, no-cache, must-revalidate');
        $response->header('Pragma', 'no-cache');
        $response->header('Expires', '0');

        return $response;
    }
}
