<?php // includes/Rest/AuthV4Controller.php

declare(strict_types=1);

namespace SosPrescription\Rest;

use SOSPrescription\Core\WorkerApiClient;
use SosPrescription\Services\Logger;
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
        $reqId = $this->build_req_id();
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
                [
                    'email' => $email,
                    'verify_url' => $this->magic_redirect_url(),
                ],
                $reqId,
                'auth_v4_request_link'
            );

            $responseReqId = $reqId;
            if (isset($workerPayload['req_id']) && is_scalar($workerPayload['req_id']) && trim((string) $workerPayload['req_id']) !== '') {
                $responseReqId = trim((string) $workerPayload['req_id']);
            }

            $notFound = (isset($workerPayload['not_found']) && $workerPayload['not_found'] === true)
                || (array_key_exists('sent', $workerPayload) && $workerPayload['sent'] === false);

            if ($notFound) {
                return new WP_Error(
                    'sosprescription_auth_email_not_found',
                    'Adresse e-mail inconnue.',
                    [
                        'status' => 404,
                        'req_id' => $responseReqId,
                        'not_found' => true,
                    ]
                );
            }

            return $this->to_rest_response($workerPayload, 200, $responseReqId);
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
        $reqId = $this->build_req_id();
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
        $email = isset($workerPayload['email']) && is_scalar($workerPayload['email'])
            ? sanitize_email((string) $workerPayload['email'])
            : '';
        $draftRef = isset($workerPayload['draft_ref']) && is_scalar($workerPayload['draft_ref'])
            ? trim((string) $workerPayload['draft_ref'])
            : '';
        $redirectTo = isset($workerPayload['redirect_to']) && is_scalar($workerPayload['redirect_to'])
            ? trim((string) $workerPayload['redirect_to'])
            : '';

        if (!$valid) {
            return $this->to_rest_response([
                'ok' => true,
                'valid' => false,
                'message' => 'Lien de connexion invalide ou expiré.',
                'email' => $email !== '' ? $email : null,
                'draft_ref' => $draftRef !== '' ? $draftRef : null,
                'redirect_to' => $redirectTo !== '' ? $this->normalize_redirect_to($redirectTo, $draftRef) : null,
                'can_resend_draft' => $email !== '' && $draftRef !== '',
                'req_id' => $responseReqId,
            ], 200, $responseReqId);
        }

        $wpUserId = isset($workerPayload['wp_user_id']) ? (int) $workerPayload['wp_user_id'] : 0;
        $role = isset($workerPayload['role']) && is_scalar($workerPayload['role']) ? strtolower(trim((string) $workerPayload['role'])) : '';

        if ($role !== 'doctor' && $role !== 'patient') {
            return new WP_Error(
                'sosprescription_auth_worker_payload_invalid',
                'Réponse d’authentification invalide.',
                [
                    'status' => 502,
                    'req_id' => $responseReqId,
                ]
            );
        }

        $user = null;
        if ($wpUserId > 0) {
            $user = get_user_by('id', $wpUserId);
        } elseif ($role === 'patient' && $email !== '' && is_email($email)) {
            $user = $this->resolve_or_create_patient_user($email, $responseReqId);
            $wpUserId = $user instanceof WP_User ? (int) $user->ID : 0;
        }

        if (!($user instanceof WP_User) || $wpUserId <= 0) {
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
            'email' => $email,
            'draft_ref' => $draftRef !== '' ? $draftRef : null,
            'redirect_to' => $this->normalize_redirect_to($redirectTo, $draftRef),
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

    private function normalize_redirect_to(string $redirectTo, string $draftRef = ''): string
    {
        $redirectTo = trim($redirectTo);
        if ($redirectTo !== '') {
            $sanitized = wp_sanitize_redirect($redirectTo);
            if ($sanitized !== '') {
                return $sanitized;
            }
        }

        $base = home_url('/demande-ordonnance/');
        if ($draftRef !== '') {
            return add_query_arg('resume_draft', rawurlencode($draftRef), $base);
        }

        return $base;
    }

    private function resolve_or_create_patient_user(string $email, string $reqId): ?WP_User
    {
        $normalizedEmail = sanitize_email($email);
        if ($normalizedEmail === '' || !is_email($normalizedEmail)) {
            return null;
        }

        $existing = get_user_by('email', $normalizedEmail);
        if ($existing instanceof WP_User) {
            return $existing;
        }

        $login = $this->build_unique_login_from_email($normalizedEmail);
        $password = wp_generate_password(24, true, true);
        $userId = wp_insert_user([
            'user_login' => $login,
            'user_pass' => $password,
            'user_email' => $normalizedEmail,
            'display_name' => $this->default_display_name_from_email($normalizedEmail),
            'role' => 'subscriber',
        ]);

        if (is_wp_error($userId)) {
            Logger::error('auth_v4.verify_link.user_create_failed', [
                'req_id' => $reqId,
                'email_hash' => substr(hash('sha256', $normalizedEmail), 0, 12),
                'message' => $userId->get_error_message(),
            ]);

            throw new \RuntimeException($userId->get_error_message());
        }

        $created = get_user_by('id', (int) $userId);
        if ($created instanceof WP_User) {
            update_user_meta((int) $created->ID, 'sosprescription_magic_link_created', 1);
            update_user_meta((int) $created->ID, 'sosprescription_magic_role_hint', 'patient');
        }

        return $created instanceof WP_User ? $created : null;
    }

    private function build_unique_login_from_email(string $email): string
    {
        $base = preg_replace('/@.*/', '', $email);
        $login = sanitize_user((string) $base, true);
        if ($login === '') {
            $login = 'patient';
        }

        $try = $login;
        $attempts = 0;
        while (username_exists($try)) {
            $attempts++;
            $try = $login . (string) wp_rand(1000, 9999);
            if ($attempts > 5) {
                $try = $login . '-' . (string) time();
                break;
            }
        }

        return $try;
    }

    private function default_display_name_from_email(string $email): string
    {
        $local = preg_replace('/@.*/', '', $email) ?: 'Patient';
        $local = str_replace(['.', '_', '-'], ' ', $local);
        $local = preg_replace('/\s+/', ' ', $local) ?: $local;
        return ucwords(trim($local));
    }

    private function magic_redirect_url(): string
    {
        $url = esc_url_raw(home_url('/connexion-securisee/'));
        return is_string($url) && trim($url) !== '' ? trim($url) : home_url('/connexion-securisee/');
    }

    private function get_worker_api_client(): WorkerApiClient
    {
        if ($this->workerApiClient instanceof WorkerApiClient) {
            return $this->workerApiClient;
        }

        $factory = new \ReflectionMethod(WorkerApiClient::class, 'fromEnv');
        $args = [];

        foreach ($factory->getParameters() as $parameter) {
            if ($parameter->isOptional()) {
                continue;
            }
            $args[] = $this->build_factory_argument($parameter);
        }

        $client = $factory->invokeArgs(null, $args);
        if (!($client instanceof WorkerApiClient)) {
            throw new \RuntimeException('WorkerApiClient::fromEnv() returned an invalid instance');
        }

        $this->workerApiClient = $client;
        return $this->workerApiClient;
    }

    private function build_factory_argument(\ReflectionParameter $parameter): mixed
    {
        $type = $parameter->getType();
        if ($type instanceof \ReflectionNamedType && !$type->isBuiltin()) {
            return $this->instantiate_dependency($type->getName());
        }

        if ($parameter->allowsNull()) {
            return null;
        }

        return $this->default_scalar_dependency_value($parameter);
    }

    private function instantiate_dependency(string $className): object
    {
        $reflection = new \ReflectionClass($className);
        if (!$reflection->isInstantiable()) {
            throw new \RuntimeException('Unable to instantiate dependency: ' . $className);
        }

        $constructor = $reflection->getConstructor();
        if (!($constructor instanceof \ReflectionMethod) || $constructor->getNumberOfRequiredParameters() === 0) {
            return $reflection->newInstance();
        }

        $args = [];
        foreach ($constructor->getParameters() as $parameter) {
            if ($parameter->isOptional()) {
                continue;
            }

            $type = $parameter->getType();
            if ($type instanceof \ReflectionNamedType && !$type->isBuiltin()) {
                $args[] = $this->instantiate_dependency($type->getName());
                continue;
            }

            if ($parameter->allowsNull()) {
                $args[] = null;
                continue;
            }

            $args[] = $this->default_scalar_dependency_value($parameter);
        }

        return $reflection->newInstanceArgs($args);
    }

    private function default_scalar_dependency_value(\ReflectionParameter $parameter): mixed
    {
        if ($parameter->isDefaultValueAvailable()) {
            return $parameter->getDefaultValue();
        }

        $type = $parameter->getType();
        $typeName = $type instanceof \ReflectionNamedType ? strtolower($type->getName()) : '';
        $name = strtolower($parameter->getName());

        if ($typeName === 'string') {
            if ($name === 'component' || $name === 'channel' || $name === 'scope' || $name === 'name') {
                return 'web';
            }
            return '';
        }

        if ($typeName === 'int') {
            return 0;
        }

        if ($typeName === 'float') {
            return 0.0;
        }

        if ($typeName === 'bool') {
            return false;
        }

        if ($typeName === 'array') {
            return [];
        }

        if ($parameter->allowsNull()) {
            return null;
        }

        throw new \RuntimeException('Unable to resolve scalar dependency: $' . $parameter->getName());
    }

    private function build_req_id(): string
    {
        $reqId = trim((string) Logger::get_request_id());
        if ($reqId !== '') {
            return $reqId;
        }

        try {
            return 'req_' . bin2hex(random_bytes(8));
        } catch (\Throwable $e) {
            return 'req_' . md5((string) wp_rand() . microtime(true));
        }
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
