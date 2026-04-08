<?php // includes/Rest/AccountV4Controller.php
declare(strict_types=1);

namespace SosPrescription\Rest;

use SOSPrescription\Core\WorkerApiClient;
use SosPrescription\Services\Logger;
use SosPrescription\Services\RestGuard;
use WP_Error;
use WP_REST_Request;
use WP_REST_Response;

defined('ABSPATH') || exit;

final class AccountV4Controller extends \WP_REST_Controller
{
    private const NAMESPACE_V4 = 'sosprescription/v4';

    private ?WorkerApiClient $workerApiClient = null;

    public static function register(): void
    {
        $controller = new self();

        register_rest_route(self::NAMESPACE_V4, '/account/delete', [
            'methods' => 'POST',
            'callback' => [$controller, 'delete_account'],
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

        if ($this->detect_actor_role() === '') {
            return new WP_Error(
                'sosprescription_account_delete_forbidden',
                'Suppression de compte indisponible pour ce profil.',
                [
                    'status' => 403,
                    'req_id' => $this->build_req_id(),
                ]
            );
        }

        return true;
    }

    public function delete_account(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $reqId = $this->build_req_id();
        $currentUserId = (int) get_current_user_id();
        if ($currentUserId <= 0) {
            return new WP_Error(
                'sosprescription_account_delete_auth_required',
                'Authentification requise.',
                [
                    'status' => 401,
                    'req_id' => $reqId,
                ]
            );
        }

        $actorRole = $this->detect_actor_role();
        if ($actorRole === '') {
            return new WP_Error(
                'sosprescription_account_delete_forbidden',
                'Suppression de compte indisponible pour ce profil.',
                [
                    'status' => 403,
                    'req_id' => $reqId,
                ]
            );
        }

        try {
            $workerPayload = $this->get_worker_api_client()->postSignedJson(
                '/api/v2/account/delete',
                [
                    'actor' => [
                        'role' => $actorRole,
                        'wp_user_id' => $currentUserId,
                    ],
                ],
                $reqId,
                'account_v4_delete'
            );
        } catch (\Throwable $e) {
            return ErrorResponder::worker_bridge_error(
                $e,
                'sosprescription_account_delete_failed',
                'La suppression du compte a échoué.',
                502,
                $reqId,
                [
                    'controller' => __CLASS__,
                    'action' => 'delete_account',
                    'wp_user_id' => $currentUserId,
                ],
                'account_v4.delete.failed'
            );
        }

        $responseReqId = $reqId;
        if (isset($workerPayload['req_id']) && is_scalar($workerPayload['req_id']) && trim((string) $workerPayload['req_id']) !== '') {
            $responseReqId = trim((string) $workerPayload['req_id']);
        }

        require_once ABSPATH . 'wp-admin/includes/user.php';

        wp_logout();

        $deleted = wp_delete_user($currentUserId, null);
        if ($deleted !== true) {
            return new WP_Error(
                'sosprescription_account_delete_wp_failed',
                'Le compte WordPress local n’a pas pu être supprimé.',
                [
                    'status' => 500,
                    'req_id' => $responseReqId,
                ]
            );
        }

        return $this->to_rest_response([
            'ok' => true,
            'deleted' => true,
            'req_id' => $responseReqId,
        ], 200, $responseReqId);
    }

    private function detect_actor_role(): string
    {
        $user = wp_get_current_user();
        $roles = $user instanceof \WP_User ? array_values((array) $user->roles) : [];

        if (in_array('sosprescription_doctor', $roles, true)) {
            return 'DOCTOR';
        }

        if (current_user_can('manage_options') || current_user_can('sosprescription_manage') || current_user_can('sosprescription_validate')) {
            return '';
        }

        return 'PATIENT';
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
