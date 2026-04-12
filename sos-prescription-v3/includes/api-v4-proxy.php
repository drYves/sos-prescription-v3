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

if (!function_exists('sosprescription_v4_proxy_read_config_string')) {
    function sosprescription_v4_proxy_read_config_string(string $name, string $default = ''): string
    {
        if (defined($name)) {
            $value = constant($name);
            if (is_string($value)) {
                return $value;
            }

            if (is_scalar($value)) {
                return (string) $value;
            }
        }

        $value = getenv($name);
        if (is_string($value)) {
            return $value;
        }

        return $default;
    }
}

if (!function_exists('sosprescription_v4_proxy_worker_client')) {
    function sosprescription_v4_proxy_worker_client(?int $timeoutS = null)
    {
        static $clients = [];
        $cacheKey = $timeoutS !== null ? 'timeout_' . max(1, (int) $timeoutS) : 'default';
        if (array_key_exists($cacheKey, $clients)) {
            return $clients[$cacheKey];
        }

        $className = '\\SOSPrescription\\Core\\WorkerApiClient';
        if (!class_exists($className)) {
            throw new RuntimeException('WorkerApiClient introuvable.');
        }

        if ($timeoutS === null) {
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

            $clients[$cacheKey] = $factory->invokeArgs(null, $args);
            return $clients[$cacheKey];
        }

        $reflection = new ReflectionClass($className);
        $constructor = $reflection->getConstructor();
        if (!($constructor instanceof ReflectionMethod)) {
            throw new RuntimeException('Constructeur WorkerApiClient introuvable.');
        }

        $args = [];
        foreach ($constructor->getParameters() as $parameter) {
            $name = $parameter->getName();
            $type = $parameter->getType();

            if ($name === 'logger' && $type instanceof ReflectionNamedType && !$type->isBuiltin()) {
                $args[] = sosprescription_v4_proxy_instantiate_dependency($type->getName());
                continue;
            }

            if ($name === 'siteId') {
                $siteId = trim((string) sosprescription_v4_proxy_read_config_string('ML_SITE_ID', ''));
                if ($siteId === '') {
                    $home = home_url('/');
                    $siteId = is_string($home) && trim($home) !== '' ? trim($home) : 'unknown_site';
                }

                $args[] = $siteId;
                continue;
            }

            if ($name === 'hmacSecret') {
                $secret = trim((string) sosprescription_v4_proxy_read_config_string('ML_HMAC_SECRET', ''));
                if ($secret === '') {
                    throw new RuntimeException('Missing ML_HMAC_SECRET');
                }

                $args[] = $secret;
                continue;
            }

            if ($name === 'kid') {
                $kid = trim((string) sosprescription_v4_proxy_read_config_string('ML_HMAC_KID', ''));
                $args[] = $kid !== '' ? $kid : null;
                continue;
            }

            if ($name === 'workerBaseUrl') {
                $workerBaseUrl = trim((string) sosprescription_v4_proxy_read_config_string('ML_WORKER_BASE_URL', ''));
                $args[] = $workerBaseUrl !== '' ? $workerBaseUrl : null;
                continue;
            }

            if ($name === 'timeoutS') {
                $args[] = max(1, (int) $timeoutS);
                continue;
            }

            if ($name === 'hmacSecretPrevious') {
                $previous = trim((string) sosprescription_v4_proxy_read_config_string('ML_HMAC_SECRET_PREVIOUS', ''));
                $args[] = $previous !== '' ? $previous : null;
                continue;
            }

            if ($parameter->isDefaultValueAvailable()) {
                $args[] = $parameter->getDefaultValue();
                continue;
            }

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

        $clients[$cacheKey] = $reflection->newInstanceArgs($args);
        return $clients[$cacheKey];
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


if (!function_exists('sosprescription_v4_proxy_require_public_draft_access')) {
    /**
     * @return true|WP_Error
     */
    function sosprescription_v4_proxy_require_public_draft_access(WP_REST_Request $request)
    {
        if (class_exists('\SosPrescription\Services\RestGuard')) {
            return \SosPrescription\Services\RestGuard::throttle($request, 'prescription_create', ['limit' => 5, 'window' => 900]);
        }

        return true;
    }
}

if (!function_exists('sosprescription_v4_proxy_build_draft_transient_key')) {
    function sosprescription_v4_proxy_build_draft_transient_key(string $submissionRef): string
    {
        return 'sosprescription_v4_draft_' . $submissionRef;
    }
}

if (!function_exists('sosprescription_v4_proxy_normalize_email')) {
    function sosprescription_v4_proxy_normalize_email($value): string
    {
        if (!is_scalar($value)) {
            return '';
        }

        $email = sanitize_email((string) $value);
        return is_email($email) ? strtolower($email) : '';
    }
}

if (!function_exists('sosprescription_v4_proxy_normalize_text')) {
    function sosprescription_v4_proxy_normalize_text($value, int $max = 4000): string
    {
        if (!is_scalar($value)) {
            return '';
        }

        $normalized = trim(preg_replace('/\s+/u', ' ', (string) $value) ?? '');
        if ($normalized === '') {
            return '';
        }

        return function_exists('mb_substr')
            ? mb_substr($normalized, 0, $max)
            : substr($normalized, 0, $max);
    }
}

if (!function_exists('sosprescription_v4_proxy_normalize_slug')) {
    function sosprescription_v4_proxy_normalize_slug($value, int $max = 64): string
    {
        if (!is_scalar($value)) {
            return '';
        }

        $normalized = strtolower(trim((string) $value));
        if ($normalized === '' || strlen($normalized) > $max || !preg_match('/^[a-z0-9][a-z0-9_-]*$/', $normalized)) {
            return '';
        }

        return $normalized;
    }
}

if (!function_exists('sosprescription_v4_proxy_normalize_redirect_to')) {
    function sosprescription_v4_proxy_normalize_redirect_to($value): string
    {
        if (!is_scalar($value)) {
            return '';
        }

        $redirect = trim((string) $value);
        if ($redirect === '') {
            return '';
        }

        $sanitized = esc_url_raw($redirect);
        if ($sanitized === '' || strlen($sanitized) > 1024) {
            return '';
        }

        return $sanitized;
    }
}

if (!function_exists('sosprescription_v4_proxy_magic_redirect_url')) {
    function sosprescription_v4_proxy_magic_redirect_url(): string
    {
        $url = esc_url_raw(home_url('/connexion-securisee/'));
        return is_string($url) && trim($url) !== '' ? trim($url) : home_url('/connexion-securisee/');
    }
}

if (!function_exists('sosprescription_v4_proxy_normalize_draft_ref')) {
    function sosprescription_v4_proxy_normalize_draft_ref($value): string
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
}

if (!function_exists('sosprescription_v4_proxy_generate_draft_idempotency_key')) {
    function sosprescription_v4_proxy_generate_draft_idempotency_key(): string
    {
        if (function_exists('wp_generate_uuid4')) {
            $uuid = strtolower((string) wp_generate_uuid4());
            if ($uuid !== '') {
                return $uuid;
            }
        }

        return 'draft_' . strtolower((string) wp_generate_password(24, false, false));
    }
}

if (!function_exists('sosprescription_v4_proxy_normalize_patient_payload')) {
    /**
     * @param array<string,mixed> $params
     * @return array<string,mixed>
     */
    function sosprescription_v4_proxy_normalize_patient_payload(array $params): array
    {
        $patient = isset($params['patient']) && is_array($params['patient']) ? $params['patient'] : [];

        $fullName = sosprescription_v4_proxy_normalize_text(
            $patient['fullname'] ?? ($patient['fullName'] ?? ($params['fullname'] ?? '')),
            160
        );
        $firstName = sosprescription_v4_proxy_normalize_text(
            $patient['firstName'] ?? ($patient['first_name'] ?? ''),
            100
        );
        $lastName = sosprescription_v4_proxy_normalize_text(
            $patient['lastName'] ?? ($patient['last_name'] ?? ''),
            120
        );
        $birthdate = sosprescription_v4_proxy_normalize_text(
            $patient['birthdate'] ?? ($patient['birthDate'] ?? ($params['birthdate'] ?? '')),
            20
        );
        $note = sosprescription_v4_proxy_normalize_text(
            $patient['note'] ?? ($patient['medical_notes'] ?? ($patient['medicalNotes'] ?? ($params['privateNotes'] ?? ''))),
            4000
        );

        $payload = [
            'fullname' => $fullName,
            'firstName' => $firstName,
            'lastName' => $lastName,
            'birthdate' => $birthdate,
            'birthDate' => $birthdate,
        ];

        if ($note !== '') {
            $payload['note'] = $note;
            $payload['medical_notes'] = $note;
            $payload['medicalNotes'] = $note;
        }

        return $payload;
    }
}

if (!function_exists('sosprescription_v4_proxy_normalize_items_payload')) {
    /**
     * @param mixed $value
     * @return array<int,array<string,mixed>>
     */
    function sosprescription_v4_proxy_normalize_items_payload($value): array
    {
        if (!is_array($value)) {
            return [];
        }

        $items = [];
        foreach ($value as $entry) {
            if (!is_array($entry)) {
                continue;
            }

            $label = sosprescription_v4_proxy_normalize_text($entry['label'] ?? '', 200);
            if ($label === '') {
                continue;
            }

            $item = [
                'label' => $label,
                'schedule' => isset($entry['schedule']) && is_array($entry['schedule']) ? $entry['schedule'] : [],
            ];

            if (isset($entry['cis']) && is_scalar($entry['cis'])) {
                $item['cis'] = trim((string) $entry['cis']);
            }
            if (isset($entry['cip13']) && is_scalar($entry['cip13'])) {
                $item['cip13'] = trim((string) $entry['cip13']);
            }
            if (isset($entry['quantite']) && is_scalar($entry['quantite'])) {
                $item['quantite'] = trim((string) $entry['quantite']);
            }

            $items[] = $item;
        }

        return $items;
    }
}

if (!function_exists('sosprescription_v4_proxy_normalize_files_manifest')) {
    /**
     * @param mixed $value
     * @return array<int,array<string,mixed>>
     */
    function sosprescription_v4_proxy_normalize_files_manifest($value): array
    {
        if (!is_array($value)) {
            return [];
        }

        $files = [];
        foreach ($value as $entry) {
            if (!is_array($entry)) {
                continue;
            }

            $originalName = sosprescription_v4_proxy_normalize_text(
                $entry['original_name'] ?? ($entry['originalName'] ?? ($entry['name'] ?? '')),
                255
            );
            if ($originalName === '') {
                continue;
            }

            $sizeBytes = isset($entry['size_bytes']) && is_numeric($entry['size_bytes'])
                ? max(0, (int) $entry['size_bytes'])
                : (isset($entry['size']) && is_numeric($entry['size']) ? max(0, (int) $entry['size']) : 0);

            $file = [
                'original_name' => $originalName,
                'mime_type' => sosprescription_v4_proxy_normalize_text($entry['mime_type'] ?? ($entry['mime'] ?? 'application/octet-stream'), 120),
                'size_bytes' => $sizeBytes,
                'kind' => 'PROOF',
                'status' => sosprescription_v4_proxy_normalize_text($entry['status'] ?? 'QUEUED', 32) ?: 'QUEUED',
            ];

            $files[] = $file;
        }

        return $files;
    }
}

if (!function_exists('sosprescription_v4_proxy_compute_draft_ttl')) {
    /**
     * @param array<string,mixed> $workerPayload
     */
    function sosprescription_v4_proxy_compute_draft_ttl(array $workerPayload): int
    {
        $defaultTtl = 2 * HOUR_IN_SECONDS;

        $expiresAt = isset($workerPayload['expires_at']) && is_scalar($workerPayload['expires_at'])
            ? strtotime((string) $workerPayload['expires_at'])
            : false;
        if (is_int($expiresAt) && $expiresAt > time()) {
            return max(300, min(12 * HOUR_IN_SECONDS, $expiresAt - time()));
        }

        $expiresIn = isset($workerPayload['expires_in']) && is_numeric($workerPayload['expires_in'])
            ? (int) $workerPayload['expires_in']
            : 0;
        if ($expiresIn > 0) {
            return max(300, min(12 * HOUR_IN_SECONDS, $expiresIn));
        }

        return $defaultTtl;
    }
}

if (!function_exists('sosprescription_v4_proxy_store_draft_payload')) {
    /**
     * @param array<string,mixed> $payload
     */
    function sosprescription_v4_proxy_store_draft_payload(string $submissionRef, array $payload, int $ttl): void
    {
        set_transient(
            sosprescription_v4_proxy_build_draft_transient_key($submissionRef),
            $payload,
            max(300, $ttl)
        );
    }
}

if (!function_exists('sosprescription_v4_proxy_load_draft_payload')) {
    /**
     * @return array<string,mixed>|null
     */
    function sosprescription_v4_proxy_load_draft_payload(string $submissionRef): ?array
    {
        $payload = get_transient(sosprescription_v4_proxy_build_draft_transient_key($submissionRef));
        return is_array($payload) ? $payload : null;
    }
}

if (!function_exists('sosprescription_v4_proxy_current_user_matches_draft')) {
    function sosprescription_v4_proxy_current_user_matches_draft(array $payload): bool
    {
        $email = isset($payload['email']) && is_scalar($payload['email'])
            ? strtolower(trim((string) $payload['email']))
            : '';
        if ($email === '') {
            return current_user_can('manage_options');
        }

        $user = wp_get_current_user();
        if (!($user instanceof WP_User)) {
            return false;
        }

        $currentEmail = isset($user->user_email) ? strtolower(trim((string) $user->user_email)) : '';
        if ($currentEmail !== '' && $currentEmail === $email) {
            return true;
        }

        return current_user_can('manage_options');
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


    register_rest_route('sosprescription/v4', '/submissions/draft', [
        'methods' => 'POST',
        'permission_callback' => 'sosprescription_v4_proxy_require_public_draft_access',
        'callback' => static function (WP_REST_Request $request) {
            $reqId = sosprescription_v4_proxy_build_req_id();
            $params = sosprescription_v4_proxy_request_data($request);

            $email = sosprescription_v4_proxy_normalize_email($params['email'] ?? null);
            $flow = sosprescription_v4_proxy_normalize_slug($params['flow'] ?? null, 64);
            $priority = sosprescription_v4_proxy_normalize_slug($params['priority'] ?? 'standard', 32);
            $redirectTo = sosprescription_v4_proxy_normalize_redirect_to($params['redirect_to'] ?? ($params['redirectTo'] ?? ''));
            $patient = sosprescription_v4_proxy_normalize_patient_payload($params);
            $items = sosprescription_v4_proxy_normalize_items_payload($params['items'] ?? []);
            $files = sosprescription_v4_proxy_normalize_files_manifest($params['files'] ?? ($params['files_manifest'] ?? []));
            $privateNotes = sosprescription_v4_proxy_normalize_text($params['privateNotes'] ?? ($params['private_notes'] ?? ''), 4000);
            $attestationNoProof = !empty($params['attestation_no_proof']) || !empty($params['attestationNoProof']);
            $consentRaw = isset($params['consent']) && is_array($params['consent']) ? $params['consent'] : [];
            $consent = [
                'telemedicine' => !empty($consentRaw['telemedicine']),
                'truth' => !empty($consentRaw['truth']),
                'cgu' => !empty($consentRaw['cgu']),
                'privacy' => !empty($consentRaw['privacy']),
                'timestamp' => isset($consentRaw['timestamp']) && is_scalar($consentRaw['timestamp']) ? trim((string) $consentRaw['timestamp']) : '',
                'cgu_version' => isset($consentRaw['cgu_version']) && is_scalar($consentRaw['cgu_version']) ? trim((string) $consentRaw['cgu_version']) : '',
                'privacy_version' => isset($consentRaw['privacy_version']) && is_scalar($consentRaw['privacy_version']) ? trim((string) $consentRaw['privacy_version']) : '',
            ];
            $idempotencyKey = sosprescription_v4_proxy_normalize_slug($params['idempotency_key'] ?? null, 96);
            if ($idempotencyKey === '') {
                $idempotencyKey = sosprescription_v4_proxy_generate_draft_idempotency_key();
            }
            $verifyUrl = sosprescription_v4_proxy_magic_redirect_url();

            if ($email === '' || $flow === '' || $priority === '') {
                return new WP_Error(
                    'sosprescription_bad_body',
                    'Informations de brouillon invalides.',
                    ['status' => 400, 'req_id' => $reqId]
                );
            }

            try {
                $workerPayload = sosprescription_v4_proxy_worker_client(30)->postSignedJson(
                    '/api/v2/submissions/draft',
                    [
                        'email' => $email,
                        'flow' => $flow,
                        'priority' => $priority,
                        'redirect_to' => $redirectTo,
                        'verify_url' => $verifyUrl,
                        'idempotency_key' => $idempotencyKey,
                    ],
                    $reqId,
                    'submission_v4_draft_create'
                );

                $normalizedWorkerPayload = sosprescription_v4_proxy_normalize_payload($workerPayload);
                $submissionRef = isset($normalizedWorkerPayload['submission_ref']) && is_scalar($normalizedWorkerPayload['submission_ref'])
                    ? trim((string) $normalizedWorkerPayload['submission_ref'])
                    : '';

                if ($submissionRef === '') {
                    return new WP_Error(
                        'sosprescription_draft_ref_missing',
                        'Référence de brouillon introuvable.',
                        ['status' => 502, 'req_id' => $reqId]
                    );
                }

                $draftPayload = [
                    'ok' => true,
                    'submission_ref' => $submissionRef,
                    'email' => $email,
                    'flow' => $flow,
                    'priority' => $priority,
                    'patient' => $patient,
                    'items' => $items,
                    'private_notes' => $privateNotes,
                    'files' => $files,
                    'redirect_to' => $redirectTo,
                    'idempotency_key' => $idempotencyKey,
                    'attestation_no_proof' => $attestationNoProof,
                    'consent' => $consent,
                    'expires_at' => isset($normalizedWorkerPayload['expires_at']) ? $normalizedWorkerPayload['expires_at'] : null,
                    'created_at' => gmdate('c'),
                    'req_id' => $reqId,
                ];

                sosprescription_v4_proxy_store_draft_payload(
                    $submissionRef,
                    $draftPayload,
                    sosprescription_v4_proxy_compute_draft_ttl($normalizedWorkerPayload)
                );

                return sosprescription_v4_proxy_to_response(
                    array_merge(
                        $normalizedWorkerPayload,
                        [
                            'submission_ref' => $submissionRef,
                            'message' => 'Lien de connexion envoyé',
                        ]
                    ),
                    201,
                    $reqId
                );
            } catch (Throwable $e) {
                return new WP_Error(
                    'sosprescription_draft_create_failed',
                    'Le lien de connexion n’a pas pu être envoyé.',
                    ['status' => 502, 'req_id' => $reqId]
                );
            }
        },
    ]);

    register_rest_route('sosprescription/v4', '/submissions/draft/resend', [
        'methods' => 'POST',
        'permission_callback' => 'sosprescription_v4_proxy_require_public_draft_access',
        'callback' => static function (WP_REST_Request $request) {
            $reqId = sosprescription_v4_proxy_build_req_id();
            $params = sosprescription_v4_proxy_request_data($request);

            $ref = sosprescription_v4_proxy_normalize_draft_ref($params['draft_ref'] ?? ($params['submission_ref'] ?? ''));
            $email = sosprescription_v4_proxy_normalize_email($params['email'] ?? null);

            if ($ref === '' || $email === '') {
                return new WP_Error(
                    'sosprescription_bad_draft_resend',
                    'Informations de reprise invalides.',
                    ['status' => 400, 'req_id' => $reqId]
                );
            }

            $payload = sosprescription_v4_proxy_load_draft_payload($ref);
            if (!is_array($payload)) {
                return new WP_Error(
                    'sosprescription_draft_not_found',
                    'Brouillon introuvable ou expiré.',
                    ['status' => 404, 'req_id' => $reqId]
                );
            }

            $storedEmail = sosprescription_v4_proxy_normalize_email($payload['email'] ?? null);
            if ($storedEmail === '' || $storedEmail !== $email) {
                return new WP_Error(
                    'sosprescription_draft_not_found',
                    'Brouillon introuvable ou expiré.',
                    ['status' => 404, 'req_id' => $reqId]
                );
            }

            $flow = sosprescription_v4_proxy_normalize_slug($payload['flow'] ?? null, 64);
            $priority = sosprescription_v4_proxy_normalize_slug($payload['priority'] ?? 'standard', 32);
            $redirectTo = sosprescription_v4_proxy_normalize_redirect_to($payload['redirect_to'] ?? '');
            $idempotencyKey = sosprescription_v4_proxy_normalize_slug($payload['idempotency_key'] ?? '', 96);
            if ($idempotencyKey === '') {
                $idempotencyKey = sosprescription_v4_proxy_normalize_slug($ref, 96);
                if ($idempotencyKey === '') {
                    $idempotencyKey = sosprescription_v4_proxy_generate_draft_idempotency_key();
                }
            }

            if ($flow === '' || $priority === '') {
                return new WP_Error(
                    'sosprescription_draft_invalid',
                    'Ce brouillon ne peut pas être repris pour le moment.',
                    ['status' => 409, 'req_id' => $reqId]
                );
            }

            try {
                $workerPayload = sosprescription_v4_proxy_worker_client(30)->postSignedJson(
                    '/api/v2/submissions/draft',
                    [
                        'email' => $storedEmail,
                        'flow' => $flow,
                        'priority' => $priority,
                        'redirect_to' => $redirectTo,
                        'verify_url' => sosprescription_v4_proxy_magic_redirect_url(),
                        'idempotency_key' => $idempotencyKey,
                    ],
                    $reqId,
                    'submission_v4_draft_resend'
                );

                $normalizedWorkerPayload = sosprescription_v4_proxy_normalize_payload($workerPayload);
                $submissionRef = isset($normalizedWorkerPayload['submission_ref']) && is_scalar($normalizedWorkerPayload['submission_ref'])
                    ? trim((string) $normalizedWorkerPayload['submission_ref'])
                    : $ref;

                $nextPayload = $payload;
                $nextPayload['submission_ref'] = $submissionRef;
                $nextPayload['email'] = $storedEmail;
                $nextPayload['idempotency_key'] = $idempotencyKey;
                $nextPayload['expires_at'] = isset($normalizedWorkerPayload['expires_at']) ? $normalizedWorkerPayload['expires_at'] : ($payload['expires_at'] ?? null);
                $nextPayload['req_id'] = $reqId;

                $ttl = sosprescription_v4_proxy_compute_draft_ttl($normalizedWorkerPayload);
                sosprescription_v4_proxy_store_draft_payload($ref, $nextPayload, $ttl);
                if ($submissionRef !== '' && $submissionRef !== $ref) {
                    sosprescription_v4_proxy_store_draft_payload($submissionRef, $nextPayload, $ttl);
                }

                return sosprescription_v4_proxy_to_response(
                    array_merge(
                        $normalizedWorkerPayload,
                        [
                            'submission_ref' => $submissionRef,
                            'message' => 'Lien de connexion envoyé',
                        ]
                    ),
                    200,
                    $reqId
                );
            } catch (Throwable $e) {
                return new WP_Error(
                    'sosprescription_draft_resend_failed',
                    'Le lien de connexion n’a pas pu être envoyé.',
                    ['status' => 502, 'req_id' => $reqId]
                );
            }
        },
    ]);


    register_rest_route('sosprescription/v4', '/submissions/draft/(?P<ref>[A-Za-z0-9_-]{8,128})', [
        'methods' => 'GET',
        'permission_callback' => 'sosprescription_v4_proxy_require_logged_in_nonce',
        'callback' => static function (WP_REST_Request $request) {
            $reqId = sosprescription_v4_proxy_build_req_id();
            $ref = is_scalar($request->get_param('ref')) ? trim((string) $request->get_param('ref')) : '';
            if ($ref === '') {
                return new WP_Error(
                    'sosprescription_bad_submission_ref',
                    'Référence de brouillon invalide.',
                    ['status' => 400, 'req_id' => $reqId]
                );
            }

            $payload = sosprescription_v4_proxy_load_draft_payload($ref);
            if (!is_array($payload)) {
                return new WP_Error(
                    'sosprescription_draft_not_found',
                    'Brouillon introuvable ou expiré.',
                    ['status' => 404, 'req_id' => $reqId]
                );
            }

            if (!sosprescription_v4_proxy_current_user_matches_draft($payload)) {
                return new WP_Error(
                    'sosprescription_forbidden',
                    'Accès refusé.',
                    ['status' => 403, 'req_id' => $reqId]
                );
            }

            return sosprescription_v4_proxy_to_response($payload, 200, $reqId);
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
