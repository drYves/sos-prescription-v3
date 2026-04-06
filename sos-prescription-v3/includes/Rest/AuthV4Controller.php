<?php // includes/Rest/AuthV4Controller.php

declare(strict_types=1);

namespace SosPrescription\Rest;

use SOSPrescription\Core\NdjsonLogger;
use SOSPrescription\Core\ReqId;
use SOSPrescription\Core\WorkerApiClient;
use SosPrescription\Services\RestGuard;
use WP_Error;
use WP_REST_Request;
use WP_REST_Response;
use WP_User;

defined('ABSPATH') || exit;

final class AuthV4Controller extends \WP_REST_Controller
{
    private const NAMESPACE_V4 = 'sosprescription/v4';

    private ?WorkerApiClient $workerApiClient = null;

    public static function register(): void
    {
        $controller = new self();

        register_rest_route(self::NAMESPACE_V4, '/auth/request-link', [
            'methods' => 'POST',
            'callback' => [$controller, 'request_link'],
            'permission_callback' => [$controller, 'permissions_check_request_link'],
        ]);

        register_rest_route(self::NAMESPACE_V4, '/auth/verify-link', [
            'methods' => 'POST',
            'callback' => [$controller, 'verify_link'],
            'permission_callback' => [$controller, 'permissions_check_verify_link'],
        ]);
    }

    public function permissions_check_request_link(WP_REST_Request $request): bool|WP_Error
    {
        return RestGuard::throttle($request, 'prescription_create', ['limit' => 5, 'window' => 900]);
    }

    public function permissions_check_verify_link(WP_REST_Request $request): bool|WP_Error
    {
        return RestGuard::throttle($request, 'prescription_create', ['limit' => 12, 'window' => 900]);
    }

    public function request_link(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $reqId = ReqId::coalesce(null);
        $params = $this->request_data($request);
        $email = $this->extract_email($params);

        if ($email === '') {
            return new WP_Error(
                'sosprescription_auth_email_required',
                'Adresse e-mail invalide.',
                [
                    'status' => 400,
                    'req_id' => $reqId,
                ]
            );
        }

        try {
            $workerPayload = $this->get_worker_api_client()->postSignedJson(
                '/api/v2/auth/request-link',
                ['email' => $email],
                $reqId,
                'auth_v4_request_link'
            );

            return $this->to_rest_response($workerPayload, 200, $reqId);
        } catch (\Throwable $e) {
            return ErrorResponder::worker_bridge_error(
                $e,
                'sosprescription_auth_request_link_failed',
                'Le lien de connexion n’a pas pu être envoyé.',
                502,
                $reqId,
                [
                    'controller' => __CLASS__,
                    'action' => 'request_link',
                ],
                'auth_v4.request_link.failed'
            );
        }
    }

    public function verify_link(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $reqId = ReqId::coalesce(null);
        $params = $this->request_data($request);
        $token = $this->extract_token($params);

        if ($token === '') {
            return new WP_Error(
                'sosprescription_auth_token_required',
                'Token de connexion invalide.',
                [
                    'status' => 400,
                    'req_id' => $reqId,
                ]
            );
        }

        try {
            $workerPayload = $this->get_worker_api_client()->postSignedJson(
                '/api/v2/auth/verify-link',
                ['token' => $token],
                $reqId,
                'auth_v4_verify_link'
            );
        } catch (\Throwable $e) {
            return ErrorResponder::worker_bridge_error(
                $e,
                'sosprescription_auth_verify_link_failed',
                'La vérification du lien de connexion a échoué.',
                502,
                $reqId,
                [
                    'controller' => __CLASS__,
                    'action' => 'verify_link',
                ],
                'auth_v4.verify_link.failed'
            );
        }

        $responseReqId = $reqId;
        if (isset($workerPayload['req_id']) && is_scalar($workerPayload['req_id']) && trim((string) $workerPayload['req_id']) !== '') {
            $responseReqId = trim((string) $workerPayload['req_id']);
        }

        $valid = isset($workerPayload['valid']) && $workerPayload['valid'] === true;
        if (!$valid) {
            return $this->to_rest_response([
                'ok' => true,
                'valid' => false,
                'message' => 'Lien de connexion invalide ou expiré.',
                'req_id' => $responseReqId,
            ], 200, $responseReqId);
        }

        $wpUserId = isset($workerPayload['wp_user_id']) ? (int) $workerPayload['wp_user_id'] : 0;
        $role = isset($workerPayload['role']) && is_scalar($workerPayload['role']) ? strtolower(trim((string) $workerPayload['role'])) : '';
        if ($wpUserId <= 0 || ($role !== 'doctor' && $role !== 'patient')) {
            return new WP_Error(
                'sosprescription_auth_worker_payload_invalid',
                'Réponse d’authentification invalide.',
                [
                    'status' => 502,
                    'req_id' => $responseReqId,
                ]
            );
        }

        $user = get_user_by('id', $wpUserId);
        if (!($user instanceof WP_User)) {
            return new WP_Error(
                'sosprescription_auth_user_not_found',
                'Compte WordPress introuvable pour ce lien.',
                [
                    'status' => 404,
                    'req_id' => $responseReqId,
                ]
            );
        }

        wp_set_current_user($wpUserId);
        wp_set_auth_cookie($wpUserId, true, false);
        do_action('wp_login', (string) $user->user_login, $user);

        return $this->to_rest_response([
            'ok' => true,
            'valid' => true,
            'wp_user_id' => $wpUserId,
            'role' => $role,
            'req_id' => $responseReqId,
        ], 200, $responseReqId);
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
    private function extract_email(array $params): string
    {
        if (!array_key_exists('email', $params) || !is_scalar($params['email'])) {
            return '';
        }

        $email = sanitize_email((string) $params['email']);
        return is_email($email) ? strtolower($email) : '';
    }

    /**
     * @param array<string, mixed> $params
     */
    private function extract_token(array $params): string
    {
        if (!array_key_exists('token', $params) || !is_scalar($params['token'])) {
            return '';
        }

        $token = trim((string) $params['token']);
        if ($token === '' || preg_match('/^[A-Za-z0-9_-]{32,256}$/', $token) !== 1) {
            return '';
        }

        return $token;
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
