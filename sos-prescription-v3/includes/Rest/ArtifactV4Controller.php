<?php // includes/Rest/ArtifactV4Controller.php
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

final class ArtifactV4Controller extends \WP_REST_Controller
{
    private const NAMESPACE_V4 = 'sosprescription/v4';

    private ?WorkerApiClient $workerApiClient = null;

    public static function register(): void
    {
        $controller = new self();

        register_rest_route(self::NAMESPACE_V4, '/form/submissions/(?P<ref>[A-Za-z0-9_-]{8,128})/artifacts', [
            'methods' => 'POST',
            'callback' => [$controller, 'init_submission_artifact'],
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

    public function init_submission_artifact(WP_REST_Request $request): WP_REST_Response|WP_Error
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
        $artifact = $this->normalize_artifact_payload($params, $reqId);
        if (is_wp_error($artifact)) {
            return $artifact;
        }

        $payload = [
            'actor' => $this->build_patient_actor_payload(),
            'artifact' => $artifact,
        ];

        try {
            $workerPayload = $this->get_worker_api_client()->postSignedJson(
                '/api/v2/submissions/' . rawurlencode($submissionRef) . '/artifacts/init',
                $payload,
                $reqId,
                'artifact_v4_submission_init'
            );

            return $this->to_rest_response($workerPayload, 201, $reqId);
        } catch (\Throwable $e) {
            return ErrorResponder::worker_bridge_error(
                $e,
                'sosprescription_artifact_init_failed',
                'La préparation du document sécurisé a échoué.',
                502,
                $reqId,
                [
                    'controller' => __CLASS__,
                    'action' => 'init_submission_artifact',
                    'submission_ref' => $submissionRef,
                    'wp_user_id' => (int) get_current_user_id(),
                ],
                'artifact_v4.init.failed'
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

    /**
     * @param array<string, mixed> $params
     * @return array<string, mixed>|WP_Error
     */
    private function normalize_artifact_payload(array $params, string $reqId): array|WP_Error
    {
        $artifactBlock = $this->pick_record($params['artifact'] ?? null) ?? [];

        $kind = $this->normalize_required_scalar_string(
            $artifactBlock['kind'] ?? ($params['kind'] ?? null)
        );
        if ($kind === null) {
            return new WP_Error(
                'sosprescription_artifact_bad_request',
                'Le type de document est requis.',
                [
                    'status' => 400,
                    'req_id' => $reqId,
                ]
            );
        }

        $originalName = $this->normalize_required_scalar_string(
            $artifactBlock['original_name']
                ?? ($artifactBlock['originalName'] ?? ($params['original_name'] ?? ($params['originalName'] ?? null)))
        );
        if ($originalName === null) {
            return new WP_Error(
                'sosprescription_artifact_bad_request',
                'Le nom du fichier est requis.',
                [
                    'status' => 400,
                    'req_id' => $reqId,
                ]
            );
        }

        $mimeType = $this->normalize_required_scalar_string(
            $artifactBlock['mime_type']
                ?? ($artifactBlock['mimeType'] ?? ($params['mime_type'] ?? ($params['mimeType'] ?? null)))
        );
        if ($mimeType === null) {
            return new WP_Error(
                'sosprescription_artifact_bad_request',
                'Le type MIME du fichier est requis.',
                [
                    'status' => 400,
                    'req_id' => $reqId,
                ]
            );
        }

        $sizeBytes = $this->normalize_required_positive_int(
            $artifactBlock['size_bytes']
                ?? ($artifactBlock['sizeBytes'] ?? ($params['size_bytes'] ?? ($params['sizeBytes'] ?? null)))
        );
        if ($sizeBytes === null) {
            return new WP_Error(
                'sosprescription_artifact_bad_request',
                'La taille du fichier est invalide.',
                [
                    'status' => 400,
                    'req_id' => $reqId,
                ]
            );
        }

        $payload = [
            'kind' => strtoupper($kind),
            'original_name' => $originalName,
            'mime_type' => $mimeType,
            'size_bytes' => $sizeBytes,
        ];

        $meta = $artifactBlock['meta'] ?? ($params['meta'] ?? null);
        if ($meta !== null) {
            $payload['meta'] = $meta;
        }

        return $payload;
    }

    /**
     * @param mixed $value
     * @return array<string, mixed>|null
     */
    private function pick_record(mixed $value): ?array
    {
        if (!is_array($value)) {
            return null;
        }

        return $value;
    }

    private function normalize_required_scalar_string(mixed $value): ?string
    {
        if (!is_scalar($value)) {
            return null;
        }

        $normalized = trim((string) $value);
        return $normalized !== '' ? $normalized : null;
    }

    private function normalize_required_positive_int(mixed $value): ?int
    {
        if ($value === null || $value === '') {
            return null;
        }

        $number = is_int($value) ? $value : (is_numeric($value) ? (int) $value : null);
        if ($number === null || $number <= 0) {
            return null;
        }

        return $number;
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
