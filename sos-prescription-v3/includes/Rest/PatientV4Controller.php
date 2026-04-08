<?php // includes/Rest/PatientV4Controller.php
declare(strict_types=1);

namespace SosPrescription\Rest;

use SOSPrescription\Core\WorkerApiClient;
use SosPrescription\Services\Logger;
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
        $reqId = $this->build_req_id();
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
        $reqId = $this->build_req_id();
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
            'note',
            'medical_notes',
            'medicalNotes',
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
