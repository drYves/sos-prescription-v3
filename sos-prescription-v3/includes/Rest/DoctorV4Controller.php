<?php // includes/Rest/DoctorV4Controller.php
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

final class DoctorV4Controller extends \WP_REST_Controller
{
    private const NAMESPACE_V4 = 'sosprescription/v4';

    private ?WorkerApiClient $workerApiClient = null;

    public static function register(): void
    {
        $controller = new self();

        register_rest_route(self::NAMESPACE_V4, '/doctor/verify-rpps', [
            'methods' => 'POST',
            'callback' => [$controller, 'verify_rpps'],
            'permission_callback' => [$controller, 'permissions_check_logged_in_nonce'],
        ]);
    }

    public function permissions_check_logged_in_nonce(WP_REST_Request $request): bool|WP_Error
    {
        $loggedIn = RestGuard::require_logged_in($request);
        if (is_wp_error($loggedIn)) {
            return $loggedIn;
        }

        $nonce = RestGuard::require_wp_rest_nonce($request);
        if (is_wp_error($nonce)) {
            return $nonce;
        }

        return RestGuard::require_any_cap($request, ['sosprescription_validate', 'sosprescription_manage', 'manage_options']);
    }

    public function verify_rpps(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $reqId = ReqId::coalesce(null);
        $params = $this->request_data($request);
        $rpps = $this->extract_rpps($params);

        if ($rpps === '') {
            return new WP_Error(
                'sosprescription_doctor_rpps_required',
                'Numéro RPPS requis.',
                [
                    'status' => 400,
                    'req_id' => $reqId,
                ]
            );
        }

        $payload = [
            'rpps' => $rpps,
            'actor' => $this->build_doctor_actor_payload(),
        ];

        try {
            $workerPayload = $this->get_worker_api_client()->postSignedJson(
                '/api/v2/doctor/verify-rpps',
                $payload,
                $reqId,
                'doctor_v4_verify_rpps'
            );

            return $this->to_rest_response($workerPayload, 200, $reqId);
        } catch (\Throwable $e) {
            return ErrorResponder::worker_bridge_error(
                $e,
                'sosprescription_doctor_rpps_verify_failed',
                'La vérification RPPS est temporairement indisponible.',
                502,
                $reqId,
                [
                    'controller' => __CLASS__,
                    'action' => 'verify_rpps',
                    'wp_user_id' => (int) get_current_user_id(),
                ],
                'doctor_v4.verify_rpps.failed'
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
     */
    private function extract_rpps(array $params): string
    {
        if (!array_key_exists('rpps', $params) || !is_scalar($params['rpps'])) {
            return '';
        }

        return preg_replace('/\D+/', '', (string) $params['rpps']) ?: '';
    }

    /**
     * @return array{role:string,wp_user_id:int}
     */
    private function build_doctor_actor_payload(): array
    {
        $role = current_user_can('manage_options') || current_user_can('sosprescription_manage')
            ? 'SYSTEM'
            : 'DOCTOR';

        return [
            'role' => $role,
            'wp_user_id' => (int) get_current_user_id(),
        ];
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
