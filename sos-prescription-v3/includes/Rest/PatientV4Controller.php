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
    private const ROW_REV_HASH_LENGTH = 24;
    private const COLLECTION_HASH_LENGTH = 32;

    private ?WorkerApiClient $workerApiClient = null;

    /** @var array<string, true>|null */
    private ?array $prescriptionTableColumnsCache = null;

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

        register_rest_route(self::NAMESPACE_V4, '/patient/pulse', [
            'methods' => 'GET',
            'callback' => [$controller, 'get_pulse'],
            'permission_callback' => [$controller, 'permissions_check_logged_in_nonce'],
            'args' => [
                'known_collection_hash' => [
                    'required' => false,
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


    public function get_pulse(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $reqId = $this->build_req_id();
        $actor = $this->build_patient_actor_payload();
        $knownCollectionHash = $this->normalize_collection_hash($request->get_param('known_collection_hash'));

        try {
            $workerPayload = $this->get_worker_api_client()->postSignedJson(
                '/api/v2/patient/prescriptions/pulse',
                [
                    'actor' => $actor,
                ],
                $reqId,
                'patient_v4_pulse_get'
            );

            $workerItems = $this->normalize_worker_pulse_items($workerPayload['items'] ?? []);
            $items = $this->compose_pulse_items_with_payment_shadow($workerItems, $actor['wp_user_id']);
            $maxUpdatedAt = $this->resolve_max_updated_at($items);
            $collectionHash = $this->build_collection_hash($items, $maxUpdatedAt);
            $unchanged = $knownCollectionHash !== null && hash_equals($collectionHash, $knownCollectionHash);

            $responsePayload = [
                'count' => count($items),
                'max_updated_at' => $maxUpdatedAt,
                'collection_hash' => $collectionHash,
                'unchanged' => $unchanged,
            ];

            if (!$unchanged) {
                $responsePayload['items'] = $items;
            }

            return $this->to_rest_response($responsePayload, 200, $reqId);
        } catch (\Throwable $e) {
            return ErrorResponder::worker_bridge_error(
                $e,
                'sosprescription_patient_pulse_failed',
                'Le rafraîchissement silencieux est temporairement indisponible.',
                502,
                $reqId,
                [
                    'controller' => __CLASS__,
                    'action' => 'get_pulse',
                    'wp_user_id' => $actor['wp_user_id'],
                ],
                'patient_v4.pulse.failed'
            );
        }
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<int, array<string, mixed>>
     */
    private function normalize_worker_pulse_items(array $payload): array
    {
        if (!is_array($payload)) {
            return [];
        }

        $items = [];
        foreach ($payload as $entry) {
            if (!is_array($entry)) {
                continue;
            }

            $uid = isset($entry['uid']) && is_scalar($entry['uid']) ? trim((string) $entry['uid']) : '';
            $workerId = isset($entry['id']) && is_scalar($entry['id']) ? trim((string) $entry['id']) : '';
            if ($uid === '' || $workerId === '') {
                continue;
            }

            $workerRowRev = isset($entry['row_rev']) && is_scalar($entry['row_rev'])
                ? trim((string) $entry['row_rev'])
                : '';
            if ($workerRowRev === '') {
                $encoded = wp_json_encode($entry, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
                $workerRowRev = substr(hash('sha256', is_string($encoded) ? $encoded : $uid . '|' . $workerId), 0, self::ROW_REV_HASH_LENGTH);
            }

            $items[] = [
                'worker_prescription_id' => $workerId,
                'uid' => $uid,
                'worker_row_rev' => strtolower($workerRowRev),
                'status' => isset($entry['status']) && is_scalar($entry['status']) ? trim((string) $entry['status']) : 'pending',
                'processing_status' => isset($entry['processing_status']) && is_scalar($entry['processing_status']) ? trim((string) $entry['processing_status']) : 'pending',
                'updated_at' => isset($entry['updated_at']) && is_scalar($entry['updated_at']) ? trim((string) $entry['updated_at']) : null,
                'last_activity_at' => isset($entry['last_activity_at']) && is_scalar($entry['last_activity_at']) ? trim((string) $entry['last_activity_at']) : null,
                'message_count' => isset($entry['message_count']) ? max(0, (int) $entry['message_count']) : 0,
                'last_message_seq' => isset($entry['last_message_seq']) ? max(0, (int) $entry['last_message_seq']) : 0,
                'unread_count_patient' => isset($entry['unread_count_patient']) ? max(0, (int) $entry['unread_count_patient']) : 0,
                'has_proof' => !empty($entry['has_proof']),
                'proof_count' => isset($entry['proof_count']) ? max(0, (int) $entry['proof_count']) : 0,
                'pdf_ready' => !empty($entry['pdf_ready']),
            ];
        }

        return $items;
    }

    /**
     * @param array<int, array<string, mixed>> $workerItems
     * @return array<int, array<string, mixed>>
     */
    private function compose_pulse_items_with_payment_shadow(array $workerItems, int $patientWpUserId): array
    {
        $uids = [];
        foreach ($workerItems as $item) {
            $uid = isset($item['uid']) && is_string($item['uid']) ? trim($item['uid']) : '';
            if ($uid !== '') {
                $uids[] = $uid;
            }
        }

        $localRowsByUid = $this->load_local_shadow_rows_by_uid($uids);

        foreach ($workerItems as $item) {
            $uid = isset($item['uid']) && is_string($item['uid']) ? trim($item['uid']) : '';
            if ($uid === '' || isset($localRowsByUid[$uid])) {
                continue;
            }

            $workerPrescriptionId = isset($item['worker_prescription_id']) && is_string($item['worker_prescription_id'])
                ? trim($item['worker_prescription_id'])
                : '';
            $status = isset($item['status']) && is_string($item['status']) ? trim($item['status']) : 'pending';
            $insertedId = $this->insert_local_prescription_stub($uid, $status, $workerPrescriptionId, $patientWpUserId);
            if ($insertedId > 0) {
                $reloaded = $this->load_local_shadow_rows_by_uid([$uid]);
                if (isset($reloaded[$uid])) {
                    $localRowsByUid[$uid] = $reloaded[$uid];
                }
            }
        }

        $items = [];
        foreach ($workerItems as $item) {
            $uid = isset($item['uid']) && is_string($item['uid']) ? trim($item['uid']) : '';
            if ($uid === '') {
                continue;
            }

            $localRow = $localRowsByUid[$uid] ?? null;
            $localId = is_array($localRow) && isset($localRow['id']) ? (int) $localRow['id'] : 0;
            if ($localId < 1) {
                continue;
            }

            $payment = $this->build_payment_shadow_payload($localRow);
            $effectiveStatus = $this->compose_effective_status((string) ($item['status'] ?? 'pending'), $payment);
            $rowRev = $this->build_row_revision((string) ($item['worker_row_rev'] ?? ''), $effectiveStatus, $payment);

            $items[] = [
                'id' => $localId,
                'uid' => $uid,
                'row_rev' => $rowRev,
                'status' => $effectiveStatus,
                'processing_status' => (string) ($item['processing_status'] ?? 'pending'),
                'updated_at' => isset($item['updated_at']) && is_string($item['updated_at']) ? $item['updated_at'] : null,
                'last_activity_at' => isset($item['last_activity_at']) && is_string($item['last_activity_at']) ? $item['last_activity_at'] : null,
                'message_count' => isset($item['message_count']) ? (int) $item['message_count'] : 0,
                'last_message_seq' => isset($item['last_message_seq']) ? (int) $item['last_message_seq'] : 0,
                'unread_count_patient' => isset($item['unread_count_patient']) ? (int) $item['unread_count_patient'] : 0,
                'has_proof' => !empty($item['has_proof']),
                'proof_count' => isset($item['proof_count']) ? (int) $item['proof_count'] : 0,
                'pdf_ready' => !empty($item['pdf_ready']),
                'payment' => $payment,
            ];
        }

        return $items;
    }

    /**
     * @param array<int, string> $uids
     * @return array<string, array<string, mixed>>
     */
    private function load_local_shadow_rows_by_uid(array $uids): array
    {
        global $wpdb;

        $normalizedUids = array_values(array_unique(array_filter(array_map(static function ($value): string {
            return is_string($value) ? trim($value) : '';
        }, $uids), static fn (string $uid): bool => $uid !== '')));

        if ($normalizedUids === [] || !$this->prescription_table_has_column('uid')) {
            return [];
        }

        $table = $wpdb->prefix . 'sosprescription_prescriptions';
        $columns = ['id', 'uid'];
        foreach (['status', 'payment_provider', 'payment_status', 'amount_cents', 'currency'] as $column) {
            if ($this->prescription_table_has_column($column)) {
                $columns[] = $column;
            }
        }

        $placeholders = implode(',', array_fill(0, count($normalizedUids), '%s'));
        $sql = $wpdb->prepare(
            sprintf('SELECT %s FROM `%s` WHERE uid IN (%s)', implode(', ', $columns), $table, $placeholders),
            $normalizedUids
        );

        $rows = $wpdb->get_results($sql, ARRAY_A);
        if (!is_array($rows)) {
            return [];
        }

        $out = [];
        foreach ($rows as $row) {
            if (!is_array($row)) {
                continue;
            }

            $uid = isset($row['uid']) && is_scalar($row['uid']) ? trim((string) $row['uid']) : '';
            $id = isset($row['id']) ? (int) $row['id'] : 0;
            if ($uid === '' || $id < 1) {
                continue;
            }

            $row['id'] = $id;
            $row['uid'] = $uid;
            $out[$uid] = $row;
        }

        return $out;
    }

    /**
     * @param array<string, mixed>|null $localRow
     * @return array<string, mixed>
     */
    private function build_payment_shadow_payload(?array $localRow): array
    {
        if (!is_array($localRow)) {
            return [
                'local_status' => null,
                'provider' => null,
                'status' => null,
                'amount_cents' => null,
                'currency' => null,
            ];
        }

        $currency = isset($localRow['currency']) && is_scalar($localRow['currency'])
            ? strtoupper(trim((string) $localRow['currency']))
            : '';

        return [
            'local_status' => isset($localRow['status']) && is_scalar($localRow['status'])
                ? strtolower(trim((string) $localRow['status']))
                : null,
            'provider' => isset($localRow['payment_provider']) && is_scalar($localRow['payment_provider'])
                ? trim((string) $localRow['payment_provider'])
                : null,
            'status' => isset($localRow['payment_status']) && is_scalar($localRow['payment_status'])
                ? trim((string) $localRow['payment_status'])
                : null,
            'amount_cents' => isset($localRow['amount_cents']) && $localRow['amount_cents'] !== null
                ? (int) $localRow['amount_cents']
                : null,
            'currency' => $currency !== '' ? $currency : null,
        ];
    }

    /**
     * @param array<string, mixed> $payment
     */
    private function compose_effective_status(string $workerStatus, array $payment): string
    {
        $normalizedWorker = strtolower(trim($workerStatus));
        $localStatus = isset($payment['local_status']) && is_scalar($payment['local_status'])
            ? strtolower(trim((string) $payment['local_status']))
            : '';

        if ($localStatus === 'payment_pending') {
            return 'payment_pending';
        }

        if ($normalizedWorker !== '') {
            return $normalizedWorker;
        }

        return $localStatus !== '' ? $localStatus : 'pending';
    }

    /**
     * @param array<string, mixed> $payment
     */
    private function build_row_revision(string $workerRowRev, string $effectiveStatus, array $payment): string
    {
        $material = implode('|', [
            'worker_row_rev=' . strtolower(trim($workerRowRev)),
            'status=' . strtolower(trim($effectiveStatus)),
            'payment_local_status=' . strtolower(trim((string) ($payment['local_status'] ?? ''))),
            'payment_provider=' . strtolower(trim((string) ($payment['provider'] ?? ''))),
            'payment_status=' . strtolower(trim((string) ($payment['status'] ?? ''))),
            'payment_amount_cents=' . (($payment['amount_cents'] ?? null) !== null ? (string) (int) $payment['amount_cents'] : ''),
            'payment_currency=' . strtoupper(trim((string) ($payment['currency'] ?? ''))),
        ]);

        return substr(hash('sha256', $material), 0, self::ROW_REV_HASH_LENGTH);
    }

    /**
     * @param array<int, array<string, mixed>> $items
     */
    private function resolve_max_updated_at(array $items): ?string
    {
        $maxUpdatedAt = null;
        foreach ($items as $item) {
            $updatedAt = isset($item['updated_at']) && is_string($item['updated_at']) ? trim($item['updated_at']) : '';
            if ($updatedAt === '') {
                continue;
            }

            if ($maxUpdatedAt === null || strcmp($updatedAt, $maxUpdatedAt) > 0) {
                $maxUpdatedAt = $updatedAt;
            }
        }

        return $maxUpdatedAt;
    }

    /**
     * @param array<int, array<string, mixed>> $items
     */
    private function build_collection_hash(array $items, ?string $maxUpdatedAt): string
    {
        $parts = [];
        foreach ($items as $item) {
            $id = isset($item['id']) ? (int) $item['id'] : 0;
            $rowRev = isset($item['row_rev']) && is_scalar($item['row_rev']) ? trim((string) $item['row_rev']) : '';
            if ($id < 1 || $rowRev === '') {
                continue;
            }
            $parts[] = $id . ':' . strtolower($rowRev);
        }

        sort($parts, SORT_STRING);

        $material = implode('|', [
            'count=' . count($items),
            'max_updated_at=' . ($maxUpdatedAt ?? ''),
            'items=' . implode(',', $parts),
        ]);

        return substr(hash('sha256', $material), 0, self::COLLECTION_HASH_LENGTH);
    }

    private function normalize_collection_hash(mixed $value): ?string
    {
        if (!is_scalar($value)) {
            return null;
        }

        $hash = strtolower(trim((string) $value));
        if ($hash === '' || !preg_match('/^[a-f0-9]{12,128}$/', $hash)) {
            return null;
        }

        return $hash;
    }

    private function insert_local_prescription_stub(string $uid, string $status, string $workerPrescriptionId, int $patientWpUserId): int
    {
        global $wpdb;

        $uid = trim($uid);
        if ($uid === '' || !$this->prescription_table_has_column('uid')) {
            return 0;
        }

        $existingId = $this->find_local_prescription_id_by_uid($uid);
        if ($existingId > 0) {
            return $existingId;
        }

        $table = $wpdb->prefix . 'sosprescription_prescriptions';
        $now = current_time('mysql');

        $data = [
            'uid' => $uid,
        ];
        $formats = ['%s'];

        if ($this->prescription_table_has_column('patient_user_id') && $patientWpUserId > 0) {
            $data['patient_user_id'] = $patientWpUserId;
            $formats[] = '%d';
        }

        if ($this->prescription_table_has_column('status')) {
            $data['status'] = strtolower(trim($status)) !== '' ? strtolower(trim($status)) : 'pending';
            $formats[] = '%s';
        }

        if ($this->prescription_table_has_column('payload_json')) {
            $data['payload_json'] = $this->build_local_stub_payload_json($workerPrescriptionId);
            $formats[] = '%s';
        }

        if ($this->prescription_table_has_column('created_at')) {
            $data['created_at'] = $now;
            $formats[] = '%s';
        }

        if ($this->prescription_table_has_column('updated_at')) {
            $data['updated_at'] = $now;
            $formats[] = '%s';
        }

        $inserted = $wpdb->insert($table, $data, $formats);
        if ($inserted !== false) {
            return (int) $wpdb->insert_id;
        }

        return $this->find_local_prescription_id_by_uid($uid);
    }

    private function find_local_prescription_id_by_uid(string $uid): int
    {
        global $wpdb;

        $uid = trim($uid);
        if ($uid === '' || !$this->prescription_table_has_column('uid')) {
            return 0;
        }

        $table = $wpdb->prefix . 'sosprescription_prescriptions';
        $id = $wpdb->get_var($wpdb->prepare(
            "SELECT id FROM `{$table}` WHERE uid = %s LIMIT 1",
            $uid
        ));

        return is_numeric($id) ? (int) $id : 0;
    }

    private function build_local_stub_payload_json(string $workerPrescriptionId): string
    {
        $payload = [
            'shadow' => [
                'mode' => 'worker-postgres',
                'zero_pii' => true,
            ],
            'worker' => [
                'prescription_id' => trim($workerPrescriptionId),
            ],
        ];

        $json = wp_json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        return is_string($json) && $json !== ''
            ? $json
            : '{"shadow":{"mode":"worker-postgres","zero_pii":true},"worker":{"prescription_id":""}}';
    }

    private function prescription_table_has_column(string $column): bool
    {
        $columns = $this->get_prescription_table_columns();
        return isset($columns[$column]);
    }

    /**
     * @return array<string, true>
     */
    private function get_prescription_table_columns(): array
    {
        global $wpdb;

        if (is_array($this->prescriptionTableColumnsCache)) {
            return $this->prescriptionTableColumnsCache;
        }

        $table = $wpdb->prefix . 'sosprescription_prescriptions';
        $safeTable = str_replace('`', '', $table);
        $rows = $wpdb->get_results("SHOW COLUMNS FROM `{$safeTable}`", ARRAY_A);
        $columns = [];
        if (is_array($rows)) {
            foreach ($rows as $row) {
                if (!is_array($row) || empty($row['Field'])) {
                    continue;
                }
                $columns[(string) $row['Field']] = true;
            }
        }

        $this->prescriptionTableColumnsCache = $columns;
        return $columns;
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
