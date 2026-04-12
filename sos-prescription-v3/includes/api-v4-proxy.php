<?php

declare(strict_types=1);

defined('ABSPATH') || exit;

if (!function_exists('sosprescription_v4_proxy_require_logged_in_nonce')) {
    /**
     * @return true|WP_Error
     */
    function sosprescription_v4_proxy_require_logged_in_nonce(WP_REST_Request $request)
    {
        if (!is_user_logged_in()) {
            return new WP_Error(
                'sosprescription_auth_required',
                'Connexion requise.',
                ['status' => 401]
            );
        }

        $nonce = (string) ($request->get_header('X-WP-Nonce') ?: $request->get_header('x-wp-nonce'));
        if ($nonce === '' || !wp_verify_nonce($nonce, 'wp_rest')) {
            return new WP_Error(
                'sosprescription_bad_nonce',
                'Nonce REST invalide.',
                ['status' => 403]
            );
        }

        return true;
    }
}

if (!function_exists('sosprescription_v4_proxy_is_doctor_like')) {
    function sosprescription_v4_proxy_is_doctor_like(): bool
    {
        if (class_exists('\SosPrescription\\Services\\AccessPolicy')) {
            $accessPolicy = '\SosPrescription\\Services\\AccessPolicy';
            $isDoctor = method_exists($accessPolicy, 'is_doctor') ? (bool) $accessPolicy::is_doctor() : false;
            $isAdmin = method_exists($accessPolicy, 'is_admin') ? (bool) $accessPolicy::is_admin() : false;
            if ($isDoctor || $isAdmin) {
                return true;
            }
        }

        return current_user_can('manage_options') || current_user_can('edit_others_posts');
    }
}

if (!function_exists('sosprescription_v4_proxy_require_doctor_nonce')) {
    /**
     * @return true|WP_Error
     */
    function sosprescription_v4_proxy_require_doctor_nonce(WP_REST_Request $request)
    {
        $ok = sosprescription_v4_proxy_require_logged_in_nonce($request);
        if (is_wp_error($ok)) {
            return $ok;
        }

        if (!sosprescription_v4_proxy_is_doctor_like()) {
            return new WP_Error(
                'sosprescription_forbidden',
                'Accès refusé.',
                ['status' => 403]
            );
        }

        return true;
    }
}

if (!function_exists('sosprescription_v4_proxy_build_req_id')) {
    function sosprescription_v4_proxy_build_req_id(): string
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
}

if (!function_exists('sosprescription_v4_proxy_normalize_payload')) {
    /**
     * @return array<string, mixed>
     */
    function sosprescription_v4_proxy_normalize_payload($payload): array
    {
        if (is_array($payload) || is_object($payload)) {
            $encoded = wp_json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            if (is_string($encoded) && $encoded !== '') {
                $decoded = json_decode($encoded, true);
                if (is_array($decoded)) {
                    return $decoded;
                }
            }
        }

        if (is_string($payload)) {
            $trimmed = trim($payload);
            if ($trimmed !== '' && ($trimmed[0] === '{' || $trimmed[0] === '[')) {
                $decoded = json_decode($trimmed, true);
                if (is_array($decoded)) {
                    return $decoded;
                }
            }
        }

        return [];
    }
}

if (!function_exists('sosprescription_v4_proxy_request_data')) {
    /**
     * @return array<string, mixed>
     */
    function sosprescription_v4_proxy_request_data(WP_REST_Request $request): array
    {
        $json = sosprescription_v4_proxy_normalize_payload($request->get_json_params());
        if ($json !== []) {
            return $json;
        }

        $body = sosprescription_v4_proxy_normalize_payload($request->get_body_params());
        if ($body !== []) {
            return $body;
        }

        return sosprescription_v4_proxy_normalize_payload($request->get_params());
    }
}

if (!function_exists('sosprescription_v4_proxy_default_scalar_dependency_value')) {
    function sosprescription_v4_proxy_default_scalar_dependency_value(ReflectionParameter $parameter)
    {
        if ($parameter->isDefaultValueAvailable()) {
            return $parameter->getDefaultValue();
        }

        $type = $parameter->getType();
        $typeName = $type instanceof ReflectionNamedType ? strtolower($type->getName()) : '';
        $name = strtolower($parameter->getName());

        if ($typeName === 'string') {
            if (in_array($name, ['component', 'channel', 'scope', 'name'], true)) {
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

        throw new RuntimeException('Unable to resolve scalar dependency: $' . $parameter->getName());
    }
}

if (!function_exists('sosprescription_v4_proxy_instantiate_dependency')) {
    function sosprescription_v4_proxy_instantiate_dependency(string $className): object
    {
        $reflection = new ReflectionClass($className);
        if (!$reflection->isInstantiable()) {
            throw new RuntimeException('Unable to instantiate dependency: ' . $className);
        }

        $constructor = $reflection->getConstructor();
        if (!($constructor instanceof ReflectionMethod) || $constructor->getNumberOfRequiredParameters() === 0) {
            return $reflection->newInstance();
        }

        $args = [];
        foreach ($constructor->getParameters() as $parameter) {
            if ($parameter->isOptional()) {
                continue;
            }

            $type = $parameter->getType();
            if ($type instanceof ReflectionNamedType && !$type->isBuiltin()) {
                $args[] = sosprescription_v4_proxy_instantiate_dependency($type->getName());
                continue;
            }

            if ($parameter->allowsNull()) {
                $args[] = null;
                continue;
            }

            $args[] = sosprescription_v4_proxy_default_scalar_dependency_value($parameter);
        }

        return $reflection->newInstanceArgs($args);
    }
}

if (!function_exists('sosprescription_v4_proxy_worker_client')) {
    function sosprescription_v4_proxy_worker_client()
    {
        static $client = null;
        if ($client !== null) {
            return $client;
        }

        $className = '\\SOSPrescription\\Core\\WorkerApiClient';
        if (!class_exists($className)) {
            throw new RuntimeException('WorkerApiClient introuvable.');
        }

        $factory = new ReflectionMethod($className, 'fromEnv');
        $args = [];

        foreach ($factory->getParameters() as $parameter) {
            if ($parameter->isOptional()) {
                continue;
            }

            $type = $parameter->getType();
            if ($type instanceof ReflectionNamedType && !$type->isBuiltin()) {
                $args[] = sosprescription_v4_proxy_instantiate_dependency($type->getName());
                continue;
            }

            if ($parameter->allowsNull()) {
                $args[] = null;
                continue;
            }

            $args[] = sosprescription_v4_proxy_default_scalar_dependency_value($parameter);
        }

        $client = $factory->invokeArgs(null, $args);
        return $client;
    }
}

if (!function_exists('sosprescription_v4_proxy_to_response')) {
    function sosprescription_v4_proxy_to_response($payload, int $status, string $reqId): WP_REST_Response
    {
        $normalized = sosprescription_v4_proxy_normalize_payload($payload);
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
}

if (!function_exists('sosprescription_v4_proxy_build_actor_payload')) {
    /**
     * @return array{role:string,wp_user_id:int}
     */
    function sosprescription_v4_proxy_build_actor_payload(): array
    {
        return [
            'role' => 'DOCTOR',
            'wp_user_id' => max(1, (int) get_current_user_id()),
        ];
    }
}

if (!function_exists('sosprescription_v4_proxy_get_local_prescription_row')) {
    /**
     * @return array<string, mixed>|null
     */
    function sosprescription_v4_proxy_get_local_prescription_row(int $localId): ?array
    {
        global $wpdb;
        $table = $wpdb->prefix . 'sosprescription_prescriptions';
        $row = $wpdb->get_row(
            $wpdb->prepare(
                "SELECT * FROM `{$table}` WHERE id = %d LIMIT 1",
                $localId
            ),
            ARRAY_A
        );

        return is_array($row) ? $row : null;
    }
}

if (!function_exists('sosprescription_v4_proxy_can_access_prescription_row')) {
    function sosprescription_v4_proxy_can_access_prescription_row(array $row): bool
    {
        if (class_exists('\\SosPrescription\\Services\\AccessPolicy') && method_exists('\\SosPrescription\\Services\\AccessPolicy', 'can_current_user_access_prescription_row')) {
            return (bool) \SosPrescription\Services\AccessPolicy::can_current_user_access_prescription_row($row);
        }

        return sosprescription_v4_proxy_is_doctor_like();
    }
}

if (!function_exists('sosprescription_v4_proxy_extract_worker_id_from_payload_node')) {
    function sosprescription_v4_proxy_extract_worker_id_from_payload_node($node): string
    {
        $arrayNode = sosprescription_v4_proxy_normalize_payload($node);
        if ($arrayNode === []) {
            return '';
        }

        $worker = sosprescription_v4_proxy_normalize_payload($arrayNode['worker'] ?? []);
        $direct = isset($worker['prescription_id']) && is_scalar($worker['prescription_id'])
            ? trim((string) $worker['prescription_id'])
            : '';
        if ($direct !== '' && (bool) preg_match('/^[A-Fa-f0-9-]{16,64}$/', $direct)) {
            return $direct;
        }

        $prescription = sosprescription_v4_proxy_normalize_payload($arrayNode['prescription'] ?? []);
        $nested = isset($prescription['id']) && is_scalar($prescription['id'])
            ? trim((string) $prescription['id'])
            : '';
        if ($nested !== '' && (bool) preg_match('/^[A-Fa-f0-9-]{16,64}$/', $nested)) {
            return $nested;
        }

        $candidate = isset($arrayNode['id']) && is_scalar($arrayNode['id'])
            ? trim((string) $arrayNode['id'])
            : '';
        if ($candidate !== '' && (bool) preg_match('/^[A-Fa-f0-9-]{16,64}$/', $candidate)) {
            return $candidate;
        }

        return '';
    }
}

if (!function_exists('sosprescription_v4_proxy_extract_worker_prescription_id')) {
    function sosprescription_v4_proxy_extract_worker_prescription_id(array $row): string
    {
        $payloadJson = isset($row['payload_json']) ? (string) $row['payload_json'] : '';
        if ($payloadJson === '') {
            return '';
        }

        $decoded = json_decode($payloadJson, true);
        if (!is_array($decoded)) {
            return '';
        }

        $candidates = [
            sosprescription_v4_proxy_extract_worker_id_from_payload_node($decoded['payload'] ?? null),
            sosprescription_v4_proxy_extract_worker_id_from_payload_node($decoded['prescription'] ?? null),
            sosprescription_v4_proxy_extract_worker_id_from_payload_node($decoded['data'] ?? null),
            sosprescription_v4_proxy_extract_worker_id_from_payload_node($decoded),
        ];

        foreach ($candidates as $candidate) {
            if ($candidate !== '' && (bool) preg_match('/^[A-Fa-f0-9-]{16,64}$/', $candidate)) {
                return $candidate;
            }
        }

        return '';
    }
}

add_action('rest_api_init', static function (): void {
    register_rest_route('sosprescription/v4', '/medications/search', [
        'methods' => 'GET',
        'permission_callback' => '__return_true',
        'callback' => static function (WP_REST_Request $request) {
            $query = trim((string) $request->get_param('q'));
            $limit = (int) ($request->get_param('limit') ?? 20);
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
        },
    ]);

    register_rest_route('sosprescription/v4', '/messages/polish', [
        'methods' => 'POST',
        'permission_callback' => 'sosprescription_v4_proxy_require_doctor_nonce',
        'callback' => static function (WP_REST_Request $request) {
            $reqId = sosprescription_v4_proxy_build_req_id();
            $params = sosprescription_v4_proxy_request_data($request);
            $draft = isset($params['draft']) && is_scalar($params['draft']) ? trim((string) $params['draft']) : '';

            if ($draft === '') {
                return new WP_Error(
                    'sosprescription_bad_body',
                    'Message vide.',
                    ['status' => 400]
                );
            }

            $constraints = isset($params['constraints']) && is_array($params['constraints']) ? $params['constraints'] : [];

            try {
                $payload = sosprescription_v4_proxy_worker_client()->postSignedJson(
                    '/api/v2/messages/polish',
                    [
                        'actor' => sosprescription_v4_proxy_build_actor_payload(),
                        'draft' => $draft,
                        'constraints' => $constraints,
                    ],
                    $reqId,
                    'messages_v4_polish'
                );

                return sosprescription_v4_proxy_to_response($payload, 200, $reqId);
            } catch (Throwable $e) {
                return new WP_Error(
                    'sosprescription_messages_polish_failed',
                    'Aide à la rédaction momentanément indisponible.',
                    [
                        'status' => 502,
                        'req_id' => $reqId,
                    ]
                );
            }
        },
    ]);

    register_rest_route('sosprescription/v4', '/prescriptions/(?P<id>\d+)/smart-replies', [
        'methods' => 'GET',
        'permission_callback' => 'sosprescription_v4_proxy_require_doctor_nonce',
        'callback' => static function (WP_REST_Request $request) {
            $localId = (int) $request->get_param('id');
            if ($localId < 1) {
                return new WP_Error(
                    'sosprescription_bad_id',
                    'ID invalide.',
                    ['status' => 400]
                );
            }

            $row = sosprescription_v4_proxy_get_local_prescription_row($localId);
            if (!is_array($row)) {
                return new WP_Error(
                    'sosprescription_not_found',
                    'Ordonnance introuvable.',
                    ['status' => 404]
                );
            }

            if (!sosprescription_v4_proxy_can_access_prescription_row($row)) {
                return new WP_Error(
                    'sosprescription_forbidden',
                    'Accès refusé.',
                    ['status' => 403]
                );
            }

            $workerPrescriptionId = sosprescription_v4_proxy_extract_worker_prescription_id($row);
            if ($workerPrescriptionId === '') {
                return new WP_Error(
                    'sosprescription_worker_reference_missing',
                    'Référence Worker introuvable.',
                    ['status' => 409]
                );
            }

            $reqId = sosprescription_v4_proxy_build_req_id();
            $actor = sosprescription_v4_proxy_build_actor_payload();
            $query = http_build_query([
                'actor_role' => $actor['role'],
                'actor_wp_user_id' => (string) $actor['wp_user_id'],
            ], '', '&', PHP_QUERY_RFC3986);

            try {
                $payload = sosprescription_v4_proxy_worker_client()->getSignedJson(
                    '/api/v2/prescriptions/' . rawurlencode($workerPrescriptionId) . '/smart-replies?' . $query,
                    $reqId,
                    'messages_v4_smart_replies'
                );

                return sosprescription_v4_proxy_to_response($payload, 200, $reqId);
            } catch (Throwable $e) {
                return new WP_Error(
                    'sosprescription_smart_replies_failed',
                    'Suggestions de réponse momentanément indisponibles.',
                    [
                        'status' => 502,
                        'req_id' => $reqId,
                    ]
                );
            }
        },
    ]);
});
