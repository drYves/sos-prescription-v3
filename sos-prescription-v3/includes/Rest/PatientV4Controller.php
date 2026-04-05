<?php // includes/Rest/PatientV4Controller.php
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

final class PatientV4Controller extends \WP_REST_Controller
{
    private const NAMESPACE_V4 = 'sosprescription/v4';

    private ?WorkerApiClient $workerApiClient = null;

    public static function register(): void
    {
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
    }

    public function permissions_check_logged_in_nonce(WP_REST_Request $request): bool|WP_Error
    {
        $loggedIn = RestGuard::require_logged_in($request);
        if (is_wp_error($loggedIn)) {
            return $loggedIn;
        }

        return RestGuard::require_wp_rest_nonce($request);
    }

    public function get_profile(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $reqId = ReqId::coalesce(null);
        $actor = $this->build_patient_actor_payload();

        try {
            $workerPayload = $this->get_worker_api_client()->getSignedJson(
                $this->build_patient_profile_get_path($actor),
                $reqId,
                'patient_v4_profile_get'
            );

            return $this->to_rest_response($workerPayload, 200, $reqId);
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
        $payload = $this->build_profile_update_payload($params);
        $payload['actor'] = $this->build_patient_actor_payload();

        try {
            $workerPayload = $this->get_worker_api_client()->putSignedJson(
                '/api/v2/patient/profile',
                $payload,
                $reqId,
                'patient_v4_profile_put'
            );

            return $this->to_rest_response($workerPayload, 200, $reqId);
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
     * @param array<string, mixed> $params
     * @return array<string, mixed>
     */
    private function build_profile_update_payload(array $params): array
    {
        unset(
            $params['actor'],
            $params['req_id'],
            $params['schema_version'],
            $params['site_id'],
            $params['ts_ms'],
            $params['nonce']
        );

        $payload = [];
        foreach ([
            'firstName',
            'first_name',
            'lastName',
            'last_name',
            'birthDate',
            'birthdate',
            'gender',
            'email',
            'phone',
            'weightKg',
            'weight_kg',
            'heightCm',
            'height_cm',
        ] as $key) {
            if (array_key_exists($key, $params)) {
                $payload[$key] = $params[$key];
            }
        }

        return $payload;
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
        $responseReqId = $reqId;
        if (isset($payload['req_id']) && is_scalar($payload['req_id']) && trim((string) $payload['req_id']) !== '') {
            $responseReqId = trim((string) $payload['req_id']);
        }

        $response = new WP_REST_Response($payload, $status);
        $response->header('X-SOSPrescription-Request-ID', $responseReqId);
        $response->header('Cache-Control', 'no-store, no-cache, must-revalidate');
        $response->header('Pragma', 'no-cache');
        $response->header('Expires', '0');

        return $response;
    }
}
