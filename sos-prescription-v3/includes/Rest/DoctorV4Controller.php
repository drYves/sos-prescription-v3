<?php // includes/Rest/DoctorV4Controller.php
declare(strict_types=1);

namespace SosPrescription\Rest;

use SOSPrescription\Core\WorkerApiClient;
use SosPrescription\Services\Logger;
use SOSPrescription\Services\RestGuard;
use SOSPrescription\Shortcodes\DoctorAccountShortcode;
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

        register_rest_route(self::NAMESPACE_V4, '/doctor/profile', [
            'methods' => 'GET',
            'callback' => [$controller, 'get_profile'],
            'permission_callback' => [$controller, 'permissions_check_logged_in_nonce'],
        ]);

        register_rest_route(self::NAMESPACE_V4, '/doctor/profile', [
            'methods' => 'POST',
            'callback' => [$controller, 'save_profile'],
            'permission_callback' => [$controller, 'permissions_check_logged_in_nonce'],
        ]);

        register_rest_route(self::NAMESPACE_V4, '/doctor/profile', [
            'methods' => 'PATCH',
            'callback' => [$controller, 'save_profile'],
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
        $reqId = $this->build_req_id();
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

    public function get_profile(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $reqId = $this->build_req_id();
        $targetUserId = $this->resolve_target_user_id($request, $this->request_data($request));
        if ($targetUserId < 1) {
            return $this->error_response('sosprescription_doctor_profile_forbidden', 'Accès refusé.', 403, $reqId);
        }

        $user = get_userdata($targetUserId);
        if (!$user instanceof \WP_User) {
            return $this->error_response('sosprescription_doctor_profile_not_found', 'Profil médecin introuvable.', 404, $reqId);
        }

        return $this->to_rest_response([
            'ok' => true,
            'profile' => $this->build_profile_payload($user),
        ], 200, $reqId);
    }

    public function save_profile(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $reqId = $this->build_req_id();
        $params = $this->request_data($request);
        $targetUserId = $this->resolve_target_user_id($request, $params);
        if ($targetUserId < 1) {
            return $this->error_response('sosprescription_doctor_profile_forbidden', 'Accès refusé.', 403, $reqId);
        }

        $user = get_userdata($targetUserId);
        if (!$user instanceof \WP_User) {
            return $this->error_response('sosprescription_doctor_profile_not_found', 'Profil médecin introuvable.', 404, $reqId);
        }

        $updated = $this->apply_profile_update($user, $params, $reqId);
        if (is_wp_error($updated)) {
            return $updated;
        }

        $freshUser = get_userdata($targetUserId);
        if (!$freshUser instanceof \WP_User) {
            return $this->error_response('sosprescription_doctor_profile_not_found', 'Profil médecin introuvable.', 404, $reqId);
        }

        return $this->to_rest_response([
            'ok' => true,
            'profile' => $this->build_profile_payload($freshUser),
        ], 200, $reqId);
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

        $params = $request->get_params();
        return is_array($params) ? $params : [];
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
        } else {
            $payload['req_id'] = $reqId;
        }

        $response = new WP_REST_Response($payload, $status);
        $response->header('X-SOSPrescription-Request-ID', $responseReqId);
        $response->header('Cache-Control', 'no-store, no-cache, must-revalidate');
        $response->header('Pragma', 'no-cache');
        $response->header('Expires', '0');

        return $response;
    }

    private function error_response(string $code, string $message, int $status, string $reqId): WP_Error
    {
        return new WP_Error($code, $message, [
            'status' => $status,
            'req_id' => $reqId,
        ]);
    }

    /**
     * @param array<string, mixed> $params
     */
    private function resolve_target_user_id(WP_REST_Request $request, array $params): int
    {
        $currentUserId = (int) get_current_user_id();
        $targetUserId = $currentUserId;

        $candidate = $request->get_param('target_user_id');
        if ($candidate === null && array_key_exists('target_user_id', $params)) {
            $candidate = $params['target_user_id'];
        }

        if ((current_user_can('manage_options') || current_user_can('sosprescription_manage')) && $candidate !== null) {
            $maybe = (int) $candidate;
            if ($maybe > 0) {
                $targetUserId = $maybe;
            }
        }

        if (!current_user_can('manage_options') && !current_user_can('sosprescription_manage') && $targetUserId !== $currentUserId) {
            return 0;
        }

        return $targetUserId;
    }

    /**
     * @return array<string, mixed>
     */
    private function build_profile_payload(\WP_User $user): array
    {
        return [
            'target_user_id' => (int) $user->ID,
            'display_name' => (string) $user->display_name,
            'email' => (string) $user->user_email,
            'doctor_title' => $this->read_user_meta_bridge((int) $user->ID, [DoctorAccountShortcode::META_TITLE], ''),
            'rpps' => $this->read_user_meta_bridge((int) $user->ID, [DoctorAccountShortcode::META_RPPS, DoctorAccountShortcode::LEGACY_META_RPPS], ''),
            'specialty' => $this->read_user_meta_bridge((int) $user->ID, [DoctorAccountShortcode::META_SPECIALTY, DoctorAccountShortcode::LEGACY_META_SPECIALTY], ''),
            'diploma_label' => $this->read_user_meta_bridge((int) $user->ID, [DoctorAccountShortcode::META_DIPLOMA_LABEL], ''),
            'diploma_university_location' => $this->read_user_meta_bridge((int) $user->ID, [DoctorAccountShortcode::META_DIPLOMA_UNIVERSITY_LOCATION], ''),
            'diploma_honors' => $this->read_user_meta_bridge((int) $user->ID, [DoctorAccountShortcode::META_DIPLOMA_HONORS], ''),
            'issue_place' => $this->read_user_meta_bridge((int) $user->ID, [DoctorAccountShortcode::META_ISSUE_PLACE, DoctorAccountShortcode::LEGACY_META_ISSUE_PLACE], ''),
            'address' => $this->read_user_meta_bridge((int) $user->ID, [DoctorAccountShortcode::META_ADDRESS], ''),
            'phone' => $this->read_user_meta_bridge((int) $user->ID, [DoctorAccountShortcode::META_PHONE], ''),
            'signature_file_id' => (int) $this->read_user_meta_bridge((int) $user->ID, [DoctorAccountShortcode::META_SIG_FILE_ID], '0'),
            'rpps_verified' => $this->read_user_meta_bool((int) $user->ID, [DoctorAccountShortcode::META_RPPS_VERIFIED], false),
            'rpps_data' => $this->read_user_meta_json((int) $user->ID, [DoctorAccountShortcode::META_RPPS_DATA], []),
        ];
    }

    /**
     * @param array<string, mixed> $params
     */
    private function apply_profile_update(\WP_User $user, array $params, string $reqId): true|WP_Error
    {
        $targetUserId = (int) $user->ID;
        $email = '';
        if (array_key_exists('email_current', $params) && is_scalar($params['email_current'])) {
            $email = sanitize_email((string) $params['email_current']);
        } elseif (array_key_exists('email', $params) && is_scalar($params['email'])) {
            $email = sanitize_email((string) $params['email']);
        }

        if ($email !== '') {
            if (!is_email($email)) {
                return $this->error_response('sosprescription_doctor_profile_bad_email', 'Adresse e-mail invalide.', 400, $reqId);
            }

            $owner = email_exists($email);
            if ($owner && (int) $owner !== $targetUserId) {
                return $this->error_response('sosprescription_doctor_profile_email_conflict', 'Cette adresse e-mail est déjà utilisée par un autre compte.', 409, $reqId);
            }
        }

        $displayName = array_key_exists('display_name', $params) && is_scalar($params['display_name'])
            ? sanitize_text_field((string) $params['display_name'])
            : '';

        $userUpdate = [
            'ID' => $targetUserId,
        ];
        $hasUserUpdate = false;
        if ($email !== '') {
            $userUpdate['user_email'] = $email;
            $hasUserUpdate = true;
        }
        if ($displayName !== '') {
            $userUpdate['display_name'] = $displayName;
            $hasUserUpdate = true;
        }

        if ($hasUserUpdate) {
            $updated = wp_update_user($userUpdate);
            if (is_wp_error($updated)) {
                return $this->error_response('sosprescription_doctor_profile_user_update_failed', $updated->get_error_message(), 400, $reqId);
            }
        }

        $doctorTitle = array_key_exists('doctor_title', $params) && is_scalar($params['doctor_title'])
            ? sanitize_text_field((string) $params['doctor_title'])
            : $this->read_user_meta_bridge($targetUserId, [DoctorAccountShortcode::META_TITLE], 'docteur');
        if (!in_array($doctorTitle, ['docteur', 'professeur'], true)) {
            $doctorTitle = 'docteur';
        }

        $rpps = array_key_exists('rpps', $params) && is_scalar($params['rpps'])
            ? (preg_replace('/\D+/', '', (string) $params['rpps']) ?: '')
            : $this->read_user_meta_bridge($targetUserId, [DoctorAccountShortcode::META_RPPS, DoctorAccountShortcode::LEGACY_META_RPPS], '');

        $specialty = array_key_exists('specialty', $params) && is_scalar($params['specialty'])
            ? sanitize_text_field((string) $params['specialty'])
            : $this->read_user_meta_bridge($targetUserId, [DoctorAccountShortcode::META_SPECIALTY, DoctorAccountShortcode::LEGACY_META_SPECIALTY], '');

        $diplomaLabel = array_key_exists('diploma_label', $params) && is_scalar($params['diploma_label'])
            ? sanitize_text_field((string) $params['diploma_label'])
            : $this->read_user_meta_bridge($targetUserId, [DoctorAccountShortcode::META_DIPLOMA_LABEL], '');

        $diplomaUniversityLocation = array_key_exists('diploma_university_location', $params) && is_scalar($params['diploma_university_location'])
            ? sanitize_text_field((string) $params['diploma_university_location'])
            : $this->read_user_meta_bridge($targetUserId, [DoctorAccountShortcode::META_DIPLOMA_UNIVERSITY_LOCATION], '');

        $diplomaHonors = array_key_exists('diploma_honors', $params) && is_scalar($params['diploma_honors'])
            ? sanitize_text_field((string) $params['diploma_honors'])
            : $this->read_user_meta_bridge($targetUserId, [DoctorAccountShortcode::META_DIPLOMA_HONORS], '');

        $issuePlace = array_key_exists('issue_place', $params) && is_scalar($params['issue_place'])
            ? sanitize_text_field((string) $params['issue_place'])
            : $this->read_user_meta_bridge($targetUserId, [DoctorAccountShortcode::META_ISSUE_PLACE, DoctorAccountShortcode::LEGACY_META_ISSUE_PLACE], '');

        $address = array_key_exists('address', $params) && is_scalar($params['address'])
            ? wp_kses_post((string) $params['address'])
            : $this->read_user_meta_bridge($targetUserId, [DoctorAccountShortcode::META_ADDRESS], '');

        $phone = array_key_exists('phone', $params) && is_scalar($params['phone'])
            ? sanitize_text_field((string) $params['phone'])
            : $this->read_user_meta_bridge($targetUserId, [DoctorAccountShortcode::META_PHONE], '');

        $this->write_user_meta_bridge($targetUserId, [DoctorAccountShortcode::META_TITLE], $doctorTitle);
        $this->write_user_meta_bridge($targetUserId, [DoctorAccountShortcode::META_RPPS, DoctorAccountShortcode::LEGACY_META_RPPS], $rpps);
        $this->write_user_meta_bridge($targetUserId, [DoctorAccountShortcode::META_SPECIALTY, DoctorAccountShortcode::LEGACY_META_SPECIALTY], $specialty);
        $this->write_user_meta_bridge($targetUserId, [DoctorAccountShortcode::META_ADDRESS], $address);
        $this->write_user_meta_bridge($targetUserId, [DoctorAccountShortcode::META_PHONE], $phone);
        $this->write_user_meta_bridge($targetUserId, [DoctorAccountShortcode::META_DIPLOMA_LABEL], $diplomaLabel);
        $this->write_user_meta_bridge($targetUserId, [DoctorAccountShortcode::META_DIPLOMA_UNIVERSITY_LOCATION], $diplomaUniversityLocation);
        $this->write_user_meta_bridge($targetUserId, [DoctorAccountShortcode::META_DIPLOMA_HONORS], $diplomaHonors);
        $this->write_user_meta_bridge($targetUserId, [DoctorAccountShortcode::META_ISSUE_PLACE, DoctorAccountShortcode::LEGACY_META_ISSUE_PLACE], $issuePlace);

        $removeSignature = $this->normalize_bool($params['remove_signature'] ?? false, false);
        if ($removeSignature) {
            delete_user_meta($targetUserId, DoctorAccountShortcode::META_SIG_FILE_ID);
        }

        $rppsVerified = $this->normalize_bool($params['rpps_verified'] ?? false, false);
        $rppsData = $this->sanitize_rpps_data_payload($params['rpps_data'] ?? []);
        $payloadRpps = isset($rppsData['rpps']) && is_scalar($rppsData['rpps'])
            ? (preg_replace('/\D+/', '', (string) $rppsData['rpps']) ?: '')
            : '';
        if (!$rppsVerified || $payloadRpps === '' || $payloadRpps !== $rpps) {
            $rppsVerified = false;
            $rppsData = [];
        }

        $this->write_user_meta_bridge($targetUserId, [DoctorAccountShortcode::META_RPPS_VERIFIED], $rppsVerified ? '1' : '0');
        if ($rppsVerified && $rppsData !== []) {
            $this->write_user_meta_json($targetUserId, DoctorAccountShortcode::META_RPPS_DATA, $rppsData);
        } else {
            delete_user_meta($targetUserId, DoctorAccountShortcode::META_RPPS_DATA);
        }

        return true;
    }

    /**
     * @param array<int, string> $keys
     */
    private function read_user_meta_bridge(int $userId, array $keys, string $default = ''): string
    {
        foreach ($keys as $key) {
            if (!is_string($key) || $key === '') {
                continue;
            }

            $value = get_user_meta($userId, $key, true);
            if (is_scalar($value)) {
                $value = trim((string) $value);
                if ($value !== '') {
                    return $value;
                }
            }
        }

        return $default;
    }

    /**
     * @param array<int, string> $keys
     */
    private function read_user_meta_bool(int $userId, array $keys, bool $default = false): bool
    {
        foreach ($keys as $key) {
            if (!is_string($key) || $key === '') {
                continue;
            }

            $value = get_user_meta($userId, $key, true);
            if ($value === '' || $value === null) {
                continue;
            }

            return $this->normalize_bool($value, $default);
        }

        return $default;
    }

    /**
     * @param array<int, string> $keys
     * @return array<string, mixed>
     */
    private function read_user_meta_json(int $userId, array $keys, array $default = []): array
    {
        foreach ($keys as $key) {
            if (!is_string($key) || $key === '') {
                continue;
            }

            $value = get_user_meta($userId, $key, true);
            if (is_array($value)) {
                return $value;
            }

            if (is_string($value) && trim($value) !== '') {
                $decoded = json_decode($value, true);
                if (is_array($decoded)) {
                    return $decoded;
                }
            }
        }

        return $default;
    }

    /**
     * @param array<int, string> $keys
     */
    private function write_user_meta_bridge(int $userId, array $keys, string $value): void
    {
        foreach ($keys as $key) {
            if (!is_string($key) || $key === '') {
                continue;
            }

            update_user_meta($userId, $key, $value);
        }
    }

    /**
     * @param array<string, mixed> $value
     */
    private function write_user_meta_json(int $userId, string $key, array $value): void
    {
        $json = wp_json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        update_user_meta($userId, $key, is_string($json) ? $json : '{}');
    }

    private function normalize_bool(mixed $value, bool $default = false): bool
    {
        if (is_bool($value)) {
            return $value;
        }

        if (is_int($value)) {
            return $value === 1;
        }

        if (is_string($value)) {
            $normalized = strtolower(trim($value));
            if (in_array($normalized, ['1', 'true', 'yes', 'on'], true)) {
                return true;
            }
            if (in_array($normalized, ['0', 'false', 'no', 'off', ''], true)) {
                return false;
            }
        }

        return $default;
    }

    /**
     * @return array<string, mixed>
     */
    private function sanitize_rpps_data_payload(mixed $raw): array
    {
        if (is_string($raw)) {
            $decoded = json_decode($raw, true);
            $raw = is_array($decoded) ? $decoded : [];
        }

        if (!is_array($raw)) {
            return [];
        }

        $payload = [];
        foreach ([
            'valid',
            'rpps',
            'firstName',
            'lastName',
            'profession',
            'specialty',
            'city',
            'locationLabel',
            'verified_at',
        ] as $key) {
            if (!array_key_exists($key, $raw)) {
                continue;
            }

            if ($key === 'valid') {
                $payload[$key] = $this->normalize_bool($raw[$key], false);
                continue;
            }

            if (is_scalar($raw[$key])) {
                $value = trim((string) $raw[$key]);
                if ($key === 'rpps') {
                    $value = preg_replace('/\D+/', '', $value) ?: '';
                }
                $payload[$key] = $value;
            }
        }

        return $payload;
    }
}
