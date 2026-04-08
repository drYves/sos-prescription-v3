<?php // includes/Rest/SubmissionV4Controller.php
declare(strict_types=1);

namespace SosPrescription\Rest;

use SOSPrescription\Core\WorkerApiClient;
use SosPrescription\Services\Logger;
use SosPrescription\Services\RestGuard;
use WP_Error;
use WP_REST_Request;
use WP_REST_Response;

defined('ABSPATH') || exit;

final class SubmissionV4Controller extends \WP_REST_Controller
{
    private const NAMESPACE_V4 = 'sosprescription/v4';

    /** @var \wpdb */
    private $wpdb;

    /** @var array<string, true>|null */
    private ?array $prescriptionTableColumnsCache = null;

    private ?WorkerApiClient $workerApiClient = null;

    public function __construct($wpdb = null)
    {
        if ($wpdb instanceof \wpdb) {
            $this->wpdb = $wpdb;
            return;
        }

        global $wpdb;
        $this->wpdb = $wpdb;
    }

    public static function register(): void
    {
        $controller = new self();

        register_rest_route(self::NAMESPACE_V4, '/form/submissions', [
            'methods' => 'POST',
            'callback' => [$controller, 'create_submission'],
            'permission_callback' => [$controller, 'permissions_check_logged_in_nonce'],
        ]);

        register_rest_route(self::NAMESPACE_V4, '/form/submissions/(?P<ref>[A-Za-z0-9_-]{8,128})/finalize', [
            'methods' => 'POST',
            'callback' => [$controller, 'finalize_submission'],
            'permission_callback' => [$controller, 'permissions_check_logged_in_nonce'],
            'args' => [
                'ref' => [
                    'required' => true,
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

    public function create_submission(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $reqId = $this->build_req_id();
        $params = $this->request_data($request);

        $payload = [
            'actor' => $this->build_patient_actor_payload(),
        ];

        $flow = $this->normalize_optional_scalar_string($params['flow'] ?? null);
        if ($flow !== null) {
            $payload['flow'] = $flow;
        }

        $priority = $this->normalize_optional_scalar_string($params['priority'] ?? null);
        if ($priority !== null) {
            $payload['priority'] = $priority;
        }

        $idempotencyKey = $this->normalize_optional_scalar_string($params['idempotency_key'] ?? null);
        if ($idempotencyKey !== null) {
            $payload['idempotency_key'] = $idempotencyKey;
        }

        try {
            $workerPayload = $this->get_worker_api_client()->postSignedJson(
                '/api/v2/submissions',
                $payload,
                $reqId,
                'submission_v4_create'
            );

            return $this->to_rest_response($workerPayload, 201, $reqId);
        } catch (\Throwable $e) {
            return ErrorResponder::worker_bridge_error(
                $e,
                'sosprescription_worker_submission_failed',
                'Le service sécurisé est temporairement indisponible.',
                502,
                $reqId,
                [
                    'controller' => __CLASS__,
                    'action' => 'create_submission',
                ],
                'submission_v4.init.failed'
            );
        }
    }

    public function finalize_submission(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $reqId = $this->build_req_id();
        $submissionRef = $this->sanitize_submission_ref(
            $request->get_param('ref') ?? $request->get_param('submission_ref')
        );

        if ($submissionRef === '') {
            return new WP_Error(
                'sosprescription_bad_submission_ref',
                'Référence de soumission invalide.',
                [
                    'status' => 400,
                    'req_id' => $reqId,
                ]
            );
        }

        $params = $this->request_data($request);
        unset(
            $params['ref'],
            $params['submission_ref'],
            $params['actor'],
            $params['req_id'],
            $params['schema_version'],
            $params['site_id'],
            $params['ts_ms'],
            $params['nonce'],
            $params['turnstileToken'],
            $params['turnstile_token']
        );

        $payload = is_array($params) ? $params : [];
        $payload['actor'] = $this->build_patient_actor_payload();

        try {
            $workerPayload = $this->get_worker_api_client()->postSignedJson(
                '/api/v2/submissions/' . rawurlencode($submissionRef) . '/finalize',
                $payload,
                $reqId,
                'submission_v4_finalize'
            );

            $localStubId = $this->ensure_local_prescription_stub_from_worker_payload($workerPayload);
            if ($localStubId < 1) {
                error_log('[SOSPrescription] finalize_submission: local stub missing after finalize | req_id=' . $reqId . ' | submission_ref=' . $submissionRef);
            }

            return $this->to_rest_response($workerPayload, 200, $reqId);
        } catch (\Throwable $e) {
            return ErrorResponder::worker_bridge_error(
                $e,
                'sosprescription_worker_submission_failed',
                'Le service sécurisé est temporairement indisponible.',
                502,
                $reqId,
                [
                    'controller' => __CLASS__,
                    'action' => 'finalize_submission',
                    'submission_ref' => $submissionRef,
                ],
                'submission_v4.finalize.failed'
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
     * @return array{role:string,wp_user_id:int}
     */
    private function build_patient_actor_payload(): array
    {
        return [
            'role' => 'PATIENT',
            'wp_user_id' => (int) get_current_user_id(),
        ];
    }

    private function sanitize_submission_ref(mixed $value): string
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

    private function normalize_optional_scalar_string(mixed $value): ?string
    {
        if ($value === null || !is_scalar($value)) {
            return null;
        }

        $normalized = trim((string) $value);
        return $normalized !== '' ? $normalized : null;
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
        if (!isset($payload['req_id']) || !is_scalar($payload['req_id']) || trim((string) $payload['req_id']) === '') {
            $payload['req_id'] = $reqId;
        }

        $response = new WP_REST_Response($payload, $status);
        $response->header('X-SOSPrescription-Request-ID', (string) $payload['req_id']);
        $response->header('Cache-Control', 'no-store, no-cache, must-revalidate');
        $response->header('Pragma', 'no-cache');
        $response->header('Expires', '0');

        return $response;
    }

    /**
     * @param array<string, mixed> $workerPayload
     */
    private function ensure_local_prescription_stub_from_worker_payload(array $workerPayload): int
    {
        $uid = isset($workerPayload['uid']) && is_scalar($workerPayload['uid'])
            ? trim((string) $workerPayload['uid'])
            : '';
        if ($uid === '') {
            return 0;
        }

        $existingId = $this->find_local_stub_id_by_uid($uid);
        if ($existingId > 0) {
            return $existingId;
        }

        $workerPrescriptionId = isset($workerPayload['prescription_id']) && is_scalar($workerPayload['prescription_id'])
            ? trim((string) $workerPayload['prescription_id'])
            : '';

        $status = $this->normalize_local_stub_status($workerPayload['status'] ?? null);

        return $this->insert_local_prescription_stub($uid, $status, $workerPrescriptionId);
    }

    private function find_local_stub_id_by_uid(string $uid): int
    {
        $uid = trim($uid);
        if ($uid === '' || !$this->prescription_table_has_column('uid')) {
            return 0;
        }

        $table = $this->wpdb->prefix . 'sosprescription_prescriptions';
        $id = $this->wpdb->get_var($this->wpdb->prepare(
            "SELECT id FROM `{$table}` WHERE uid = %s LIMIT 1",
            $uid
        ));

        return is_numeric($id) && (int) $id > 0 ? (int) $id : 0;
    }

    private function insert_local_prescription_stub(string $uid, string $status, string $workerPrescriptionId): int
    {
        $uid = trim($uid);
        if ($uid === '' || !$this->prescription_table_has_column('uid')) {
            return 0;
        }

        $table = $this->wpdb->prefix . 'sosprescription_prescriptions';
        $now = current_time('mysql');
        $data = [
            'uid' => $uid,
        ];
        $formats = ['%s'];

        if ($this->prescription_table_has_column('status')) {
            $data['status'] = $status;
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

        $inserted = $this->wpdb->insert($table, $data, $formats);
        if ($inserted !== false) {
            return (int) $this->wpdb->insert_id;
        }

        $existingId = $this->find_local_stub_id_by_uid($uid);
        if ($existingId > 0) {
            return $existingId;
        }

        return 0;
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

        $json = wp_json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        return is_string($json) && $json !== '' ? $json : '{"shadow":{"mode":"worker-postgres","zero_pii":true},"worker":{"prescription_id":""}}';
    }

    private function normalize_local_stub_status(mixed $value): string
    {
        if (!is_scalar($value)) {
            return 'pending';
        }

        $status = strtolower(trim((string) $value));
        if ($status === '') {
            return 'pending';
        }

        return $status;
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
        if (is_array($this->prescriptionTableColumnsCache)) {
            return $this->prescriptionTableColumnsCache;
        }

        $table = $this->wpdb->prefix . 'sosprescription_prescriptions';
        $safeTable = str_replace('`', '', $table);
        $rows = $this->wpdb->get_results("SHOW COLUMNS FROM `{$safeTable}`", ARRAY_A);
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
}
