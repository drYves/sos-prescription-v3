<?php // includes/Rest/MessagesV4Controller.php

declare(strict_types=1);

namespace SosPrescription\Rest;

use SOSPrescription\Core\WorkerApiClient;
use SosPrescription\Services\AccessPolicy;
use SosPrescription\Services\Logger;
use SosPrescription\Services\RestGuard;
use WP_Error;
use WP_REST_Request;
use WP_REST_Response;

defined('ABSPATH') || exit;

final class MessagesV4Controller extends \WP_REST_Controller
{
    private const NAMESPACE_V4 = 'sosprescription/v4';

    /** @var \wpdb */
    protected $wpdb;

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

        register_rest_route(self::NAMESPACE_V4, '/prescriptions/(?P<uid>[A-Za-z0-9_-]{4,128})/messages', [
            'methods' => 'GET',
            'callback' => [$controller, 'list'],
            'permission_callback' => [$controller, 'permissions_check_logged_in_nonce'],
        ]);

        register_rest_route(self::NAMESPACE_V4, '/prescriptions/(?P<uid>[A-Za-z0-9_-]{4,128})/messages', [
            'methods' => 'POST',
            'callback' => [$controller, 'create'],
            'permission_callback' => [$controller, 'permissions_check_logged_in_nonce'],
        ]);

        register_rest_route(self::NAMESPACE_V4, '/prescriptions/(?P<uid>[A-Za-z0-9_-]{4,128})/messages/read', [
            'methods' => 'POST',
            'callback' => [$controller, 'mark_as_read'],
            'permission_callback' => [$controller, 'permissions_check_logged_in_nonce'],
        ]);

    }

    public function permissions_check_logged_in_nonce(WP_REST_Request $request): bool|WP_Error
    {
        $ok = RestGuard::require_logged_in($request);
        if (is_wp_error($ok)) {
            return $ok;
        }

        $ok = RestGuard::require_wp_rest_nonce($request);
        if (is_wp_error($ok)) {
            return $ok;
        }

        if (strtoupper((string) $request->get_method()) === 'POST') {
            $ok = RestGuard::throttle($request, 'messages_post');
            if (is_wp_error($ok)) {
                return $ok;
            }
        }

        return true;
    }

    public function list(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $uid = $this->normalize_uid((string) $request->get_param('uid'));
        if ($uid === '') {
            return new WP_Error('sosprescription_bad_uid', 'Référence de prescription invalide.', ['status' => 400]);
        }

        $reqId = $this->build_req_id();
        $actor = $this->build_actor_payload();
        $afterSeq = max(0, (int) ($request->get_param('after_seq') ?? 0));
        $limit = max(1, min(100, (int) ($request->get_param('limit') ?? 50)));

        try {
            $workerPrescriptionId = $this->resolve_worker_prescription_id_from_uid($uid, $actor, $reqId);
            $query = http_build_query([
                'actor_role' => $actor['role'],
                'actor_wp_user_id' => (string) $actor['wp_user_id'],
                'after_seq' => (string) $afterSeq,
                'limit' => (string) $limit,
            ], '', '&', PHP_QUERY_RFC3986);

            $workerPayload = $this->get_worker_api_client()->getSignedJson(
                '/api/v1/prescriptions/' . rawurlencode($workerPrescriptionId) . '/messages?' . $query,
                $reqId,
                'messages_v4_query'
            );

            return $this->to_rest_response($workerPayload, 200, $reqId);
        } catch (\Throwable $e) {
            return ErrorResponder::worker_bridge_error(
                $e,
                'sosprescription_messages_v4_query_failed',
                'Le service de messagerie est temporairement indisponible.',
                502,
                $reqId,
                [
                    'controller' => __CLASS__,
                    'action' => 'list',
                    'uid' => $uid,
                    'after_seq' => $afterSeq,
                    'limit' => $limit,
                ],
                'messages_v4.query_failed'
            );
        }
    }

    public function create(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $uid = $this->normalize_uid((string) $request->get_param('uid'));
        if ($uid === '') {
            return new WP_Error('sosprescription_bad_uid', 'Référence de prescription invalide.', ['status' => 400]);
        }

        $reqId = $this->build_req_id();
        $actor = $this->build_actor_payload();
        $params = $this->request_data($request);

        $body = '';
        if (isset($params['message']) && is_array($params['message']) && array_key_exists('body', $params['message']) && is_scalar($params['message']['body'])) {
            $body = trim((string) $params['message']['body']);
        } elseif (array_key_exists('body', $params) && is_scalar($params['body'])) {
            $body = trim((string) $params['body']);
        }

        try {
            $workerPrescriptionId = $this->resolve_worker_prescription_id_from_uid($uid, $actor, $reqId);
            $workerPayload = $this->get_worker_api_client()->postSignedJson(
                '/api/v1/prescriptions/' . rawurlencode($workerPrescriptionId) . '/messages',
                [
                    'actor' => $actor,
                    'message' => [
                        'body' => $body,
                    ],
                ],
                $reqId,
                'messages_v4_create'
            );

            return $this->to_rest_response($workerPayload, 201, $reqId);
        } catch (\Throwable $e) {
            return ErrorResponder::worker_bridge_error(
                $e,
                'sosprescription_messages_v4_create_failed',
                'Le message n’a pas pu être envoyé.',
                502,
                $reqId,
                [
                    'controller' => __CLASS__,
                    'action' => 'create',
                    'uid' => $uid,
                ],
                'messages_v4.create.failed'
            );
        }
    }

    public function mark_as_read(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $uid = $this->normalize_uid((string) $request->get_param('uid'));
        if ($uid === '') {
            return new WP_Error('sosprescription_bad_uid', 'Référence de prescription invalide.', ['status' => 400]);
        }

        $reqId = $this->build_req_id();
        $actor = $this->build_actor_payload();
        $params = $this->request_data($request);
        $payload = [
            'actor' => $actor,
        ];

        if (array_key_exists('read_upto_seq', $params)) {
            $payload['read_upto_seq'] = (int) $params['read_upto_seq'];
        }

        try {
            $workerPrescriptionId = $this->resolve_worker_prescription_id_from_uid($uid, $actor, $reqId);
            $workerPayload = $this->get_worker_api_client()->postSignedJson(
                '/api/v1/prescriptions/' . rawurlencode($workerPrescriptionId) . '/messages/read',
                $payload,
                $reqId,
                'messages_v4_read'
            );

            return $this->to_rest_response($workerPayload, 200, $reqId);
        } catch (\Throwable $e) {
            return ErrorResponder::worker_bridge_error(
                $e,
                'sosprescription_messages_v4_read_failed',
                'L’état de lecture de la messagerie n’a pas pu être synchronisé.',
                502,
                $reqId,
                [
                    'controller' => __CLASS__,
                    'action' => 'mark_as_read',
                    'uid' => $uid,
                ],
                'messages_v4.read.failed'
            );
        }
    }

    public function polish(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $reqId = $this->build_req_id();
        $actor = $this->build_actor_payload();
        if ($actor['role'] !== 'DOCTOR') {
            return new WP_Error(
                'sosprescription_doctor_actor_required',
                'Accès refusé.',
                ['status' => 403, 'req_id' => $reqId]
            );
        }

        $params = $this->request_data($request);
        $draft = isset($params['draft']) && is_scalar($params['draft']) ? trim((string) $params['draft']) : '';
        if ($draft === '') {
            return new WP_Error(
                'sosprescription_bad_body',
                'Message vide.',
                ['status' => 400, 'req_id' => $reqId]
            );
        }

        $constraints = $this->normalize_payload($params['constraints'] ?? []);
        $context = $this->resolve_polish_context($params, $constraints, $actor, $reqId);
        if (is_wp_error($context)) {
            return $context;
        }

        try {
            $workerRequest = $this->build_polish_worker_payload($draft, $constraints, $actor, $context);
            $workerPayload = $this->dispatch_polish_worker_request($workerRequest, $context, $reqId);
            return $this->to_rest_response($workerPayload, 200, $reqId);
        } catch (\Throwable $e) {
            return ErrorResponder::worker_bridge_error(
                $e,
                'sosprescription_messages_v4_polish_failed',
                'Aide à la rédaction momentanément indisponible.',
                502,
                $reqId,
                [
                    'controller' => __CLASS__,
                    'action' => 'polish',
                    'local_prescription_id' => $context['local_prescription_id'] > 0 ? $context['local_prescription_id'] : null,
                    'prescription_uid' => $context['prescription_uid'] !== '' ? $context['prescription_uid'] : null,
                    'worker_prescription_id' => $context['worker_prescription_id'] !== '' ? $context['worker_prescription_id'] : null,
                ],
                'messages_v4.polish.failed'
            );
        }
    }

    /**
     * @return array{role:string,wp_user_id:int}
     */
    private function build_actor_payload(): array
    {
        $currentUserId = (int) get_current_user_id();

        return [
            'role' => (AccessPolicy::is_doctor() || AccessPolicy::is_admin()) ? 'DOCTOR' : 'PATIENT',
            'wp_user_id' => max(1, $currentUserId),
        ];
    }

    /**
     * @param array{role:string,wp_user_id:int} $actor
     */
    private function resolve_worker_prescription_id_from_uid(string $uid, array $actor, string $reqId): string
    {
        $localWorkerId = $this->find_worker_prescription_id_in_local_stub_by_uid($uid);
        if ($this->is_valid_worker_prescription_id($localWorkerId)) {
            return $localWorkerId;
        }

        $workerPayload = $this->get_worker_api_client()->postSignedJson(
            '/api/v2/prescriptions/get',
            [
                'actor' => $actor,
                'prescription_id' => $uid,
            ],
            $reqId,
            'messages_v4_resolve_uid'
        );

        $normalized = $this->normalize_payload($workerPayload);
        $workerId = $this->extract_worker_prescription_id_from_worker_payload($normalized);
        if (!$this->is_valid_worker_prescription_id($workerId)) {
            throw new \RuntimeException('Canonical Worker prescription id not found for uid');
        }

        return $workerId;
    }

    private function find_worker_prescription_id_in_local_stub_by_uid(string $uid): string
    {
        $table = $this->wpdb->prefix . 'sosprescription_prescriptions';
        $row = $this->wpdb->get_row(
            $this->wpdb->prepare(
                "SELECT payload_json FROM `{$table}` WHERE uid = %s LIMIT 1",
                $uid
            ),
            ARRAY_A
        );

        if (!is_array($row)) {
            return '';
        }

        return $this->extract_worker_prescription_id_from_payload_json($row['payload_json'] ?? null);
    }

    private function extract_worker_prescription_id_from_payload_json(mixed $payloadJson): string
    {
        if (!is_string($payloadJson) || trim($payloadJson) === '') {
            return '';
        }

        $decoded = json_decode($payloadJson, true);
        if (!is_array($decoded)) {
            return '';
        }

        return $this->extract_worker_prescription_id_from_worker_payload($decoded);
    }

    /**
     * @param array<string, mixed> $payload
     */
    private function extract_worker_prescription_id_from_worker_payload(array $payload): string
    {
        $candidates = [
            $this->extract_worker_id_from_node($payload['payload'] ?? null),
            $this->extract_worker_id_from_node($payload['prescription'] ?? null),
            $this->extract_worker_id_from_node($payload['data'] ?? null),
            $this->extract_worker_id_from_node($payload),
        ];

        foreach ($candidates as $candidate) {
            if ($this->is_valid_worker_prescription_id($candidate)) {
                return $candidate;
            }
        }

        return '';
    }

    private function extract_worker_id_from_node(mixed $node): string
    {
        $arrayNode = $this->normalize_payload($node);
        if ($arrayNode === []) {
            return '';
        }

        $worker = $this->normalize_payload($arrayNode['worker'] ?? []);
        $direct = isset($worker['prescription_id']) && is_scalar($worker['prescription_id'])
            ? trim((string) $worker['prescription_id'])
            : '';
        if ($this->is_valid_worker_prescription_id($direct)) {
            return $direct;
        }

        $prescription = $this->normalize_payload($arrayNode['prescription'] ?? []);
        $nested = isset($prescription['id']) && is_scalar($prescription['id'])
            ? trim((string) $prescription['id'])
            : '';
        if ($this->is_valid_worker_prescription_id($nested)) {
            return $nested;
        }

        $candidate = isset($arrayNode['id']) && is_scalar($arrayNode['id'])
            ? trim((string) $arrayNode['id'])
            : '';
        if ($this->is_valid_worker_prescription_id($candidate)) {
            return $candidate;
        }

        return '';
    }

    private function is_valid_worker_prescription_id(string $value): bool
    {
        return $value !== '' && (bool) preg_match('/^[A-Fa-f0-9-]{16,64}$/', $value);
    }

    /**
     * @param array<string, mixed> $params
     * @param array<string, mixed> $constraints
     * @param array{role:string,wp_user_id:int} $actor
     * @return array{local_prescription_id:int,prescription_uid:string,worker_prescription_id:string}|WP_Error
     */
    private function resolve_polish_context(array $params, array $constraints, array $actor, string $reqId): array|WP_Error
    {
        $paramContext = $this->normalize_payload($params['context'] ?? []);
        $constraintContext = $this->normalize_payload($constraints['context'] ?? []);

        $rawPrescriptionIdCandidates = [
            $params['prescription_id'] ?? null,
            $params['prescriptionId'] ?? null,
            $params['local_prescription_id'] ?? null,
            $paramContext['prescription_id'] ?? null,
            $paramContext['prescriptionId'] ?? null,
            $paramContext['local_prescription_id'] ?? null,
            $constraintContext['prescription_id'] ?? null,
            $constraintContext['prescriptionId'] ?? null,
            $constraintContext['local_prescription_id'] ?? null,
            $constraints['prescription_id'] ?? null,
            $constraints['prescriptionId'] ?? null,
            $constraints['local_prescription_id'] ?? null,
        ];

        foreach ($rawPrescriptionIdCandidates as $candidate) {
            $localPrescriptionId = $this->normalize_positive_int($candidate);
            if ($localPrescriptionId < 1) {
                continue;
            }

            $row = $this->get_local_prescription_stub($localPrescriptionId);
            if (!is_array($row)) {
                return new WP_Error(
                    'sosprescription_not_found',
                    'Ordonnance introuvable.',
                    ['status' => 404, 'req_id' => $reqId]
                );
            }

            if (!AccessPolicy::can_current_user_access_prescription_row($row)) {
                return new WP_Error(
                    'sosprescription_forbidden',
                    'Accès refusé.',
                    ['status' => 403, 'req_id' => $reqId]
                );
            }

            $prescriptionUid = isset($row['uid']) && is_scalar($row['uid']) ? $this->normalize_uid((string) $row['uid']) : '';
            $workerPrescriptionId = $this->extract_worker_prescription_id_from_payload_json($row['payload_json'] ?? null);
            if (!$this->is_valid_worker_prescription_id($workerPrescriptionId) && $prescriptionUid !== '') {
                $workerPrescriptionId = $this->resolve_worker_prescription_id_from_uid($prescriptionUid, $actor, $reqId);
            }

            if (!$this->is_valid_worker_prescription_id($workerPrescriptionId)) {
                return new WP_Error(
                    'sosprescription_worker_reference_missing',
                    'Référence Worker introuvable.',
                    ['status' => 409, 'req_id' => $reqId]
                );
            }

            return [
                'local_prescription_id' => $localPrescriptionId,
                'prescription_uid' => $prescriptionUid,
                'worker_prescription_id' => $workerPrescriptionId,
            ];
        }

        $uidCandidates = [
            $params['prescription_uid'] ?? null,
            $params['uid'] ?? null,
            $paramContext['prescription_uid'] ?? null,
            $paramContext['uid'] ?? null,
            $constraintContext['prescription_uid'] ?? null,
            $constraintContext['uid'] ?? null,
            $constraints['prescription_uid'] ?? null,
            $constraints['uid'] ?? null,
        ];
        foreach ($rawPrescriptionIdCandidates as $candidate) {
            if (!is_scalar($candidate)) {
                continue;
            }
            $uidCandidates[] = $candidate;
        }

        foreach ($uidCandidates as $candidate) {
            if (!is_scalar($candidate)) {
                continue;
            }

            $prescriptionUid = $this->normalize_uid((string) $candidate);
            if ($prescriptionUid === '') {
                continue;
            }

            $workerPrescriptionId = $this->resolve_worker_prescription_id_from_uid($prescriptionUid, $actor, $reqId);
            if ($this->is_valid_worker_prescription_id($workerPrescriptionId)) {
                return [
                    'local_prescription_id' => 0,
                    'prescription_uid' => $prescriptionUid,
                    'worker_prescription_id' => $workerPrescriptionId,
                ];
            }
        }

        $workerCandidates = [
            $params['worker_prescription_id'] ?? null,
            $paramContext['worker_prescription_id'] ?? null,
            $constraintContext['worker_prescription_id'] ?? null,
            $constraints['worker_prescription_id'] ?? null,
        ];
        foreach ($rawPrescriptionIdCandidates as $candidate) {
            if (!is_scalar($candidate)) {
                continue;
            }
            $workerCandidates[] = $candidate;
        }

        foreach ($workerCandidates as $candidate) {
            if (!is_scalar($candidate)) {
                continue;
            }

            $workerPrescriptionId = trim((string) $candidate);
            if ($this->is_valid_worker_prescription_id($workerPrescriptionId)) {
                return [
                    'local_prescription_id' => 0,
                    'prescription_uid' => '',
                    'worker_prescription_id' => $workerPrescriptionId,
                ];
            }
        }

        return new WP_Error(
            'sosprescription_polish_prescription_required',
            'Contexte dossier manquant pour la reformulation.',
            ['status' => 400, 'req_id' => $reqId]
        );
    }

    /**
     * @param array<string, mixed> $constraints
     * @param array{role:string,wp_user_id:int} $actor
     * @param array{local_prescription_id:int,prescription_uid:string,worker_prescription_id:string} $context
     * @return array<string, mixed>
     */
    private function normalize_polish_constraints(array $constraints, array $actor, array $context): array
    {
        $normalized = $constraints;
        $nestedContext = $this->normalize_payload($normalized['context'] ?? []);

        $normalized['actor'] = $actor;
        $normalized['actor_role'] = $actor['role'];
        $normalized['actor_wp_user_id'] = $actor['wp_user_id'];
        $normalized['doctor_actor_required'] = true;

        $nestedContext['surface'] = 'doctor_messaging';
        $nestedContext['channel'] = 'doctor_admin';
        $nestedContext['actor_role'] = $actor['role'];
        $nestedContext['actor_wp_user_id'] = $actor['wp_user_id'];
        $nestedContext['doctor_actor_required'] = true;

        if ($context['local_prescription_id'] > 0) {
            $normalized['local_prescription_id'] = $context['local_prescription_id'];
            $nestedContext['local_prescription_id'] = $context['local_prescription_id'];
        }

        if ($context['prescription_uid'] !== '') {
            $normalized['prescription_uid'] = $context['prescription_uid'];
            $nestedContext['prescription_uid'] = $context['prescription_uid'];
        }

        if ($context['worker_prescription_id'] !== '') {
            $normalized['prescription_id'] = $context['worker_prescription_id'];
            $normalized['worker_prescription_id'] = $context['worker_prescription_id'];
            $nestedContext['prescription_id'] = $context['worker_prescription_id'];
            $nestedContext['worker_prescription_id'] = $context['worker_prescription_id'];
        }

        $normalized['context'] = $nestedContext;
        return $normalized;
    }

    /**
     * @param array<string, mixed> $constraints
     * @param array{role:string,wp_user_id:int} $actor
     * @param array{local_prescription_id:int,prescription_uid:string,worker_prescription_id:string} $context
     * @return array<string, mixed>
     */
    private function build_polish_worker_payload(string $draft, array $constraints, array $actor, array $context): array
    {
        $normalizedConstraints = $this->normalize_polish_constraints($constraints, $actor, $context);
        $payload = [
            'draft' => $draft,
            'actor' => $actor,
            'actor_role' => $actor['role'],
            'actor_wp_user_id' => $actor['wp_user_id'],
            'constraints' => $normalizedConstraints,
            'context' => $normalizedConstraints['context'] ?? [],
        ];

        if ($context['local_prescription_id'] > 0) {
            $payload['local_prescription_id'] = $context['local_prescription_id'];
        }

        if ($context['prescription_uid'] !== '') {
            $payload['prescription_uid'] = $context['prescription_uid'];
        }

        if ($context['worker_prescription_id'] !== '') {
            $payload['prescription_id'] = $context['worker_prescription_id'];
            $payload['worker_prescription_id'] = $context['worker_prescription_id'];
        }

        return $payload;
    }

    /**
     * @param array<string, mixed> $workerRequest
     * @param array{local_prescription_id:int,prescription_uid:string,worker_prescription_id:string} $context
     * @return array<string, mixed>
     */
    private function dispatch_polish_worker_request(array $workerRequest, array $context, string $reqId): array
    {
        $paths = ['/api/v1/messages/polish'];
        if ($context['worker_prescription_id'] !== '') {
            $paths[] = '/api/v1/prescriptions/' . rawurlencode($context['worker_prescription_id']) . '/messages/polish';
        }
        $paths[] = '/api/v1/copilot/messages/polish';

        $lastError = null;
        foreach (array_values(array_unique($paths)) as $path) {
            try {
                $payload = $this->get_worker_api_client()->postSignedJson(
                    $path,
                    $workerRequest,
                    $reqId,
                    'messages_v4_polish'
                );
                return $this->normalize_payload($payload);
            } catch (\Throwable $e) {
                $lastError = $e;
            }
        }

        if ($lastError instanceof \Throwable) {
            throw $lastError;
        }

        throw new \RuntimeException('Worker polish bridge failed.');
    }

    /**
     * @return array<string, mixed>|null
     */
    private function get_local_prescription_stub(int $prescriptionId): ?array
    {
        $table = $this->wpdb->prefix . 'sosprescription_prescriptions';
        $row = $this->wpdb->get_row(
            $this->wpdb->prepare(
                "SELECT id, uid, patient_user_id, doctor_user_id, payload_json FROM `{$table}` WHERE id = %d LIMIT 1",
                $prescriptionId
            ),
            ARRAY_A
        );

        return is_array($row) ? $row : null;
    }

    private function normalize_positive_int(mixed $value): int
    {
        if (is_int($value) || is_float($value) || is_string($value)) {
            $normalized = (int) $value;
            return $normalized > 0 ? $normalized : 0;
        }

        return 0;
    }

    private function normalize_uid(string $uid): string
    {
        $uid = trim($uid);
        if ($uid === '') {
            return '';
        }

        return preg_match('/^[A-Za-z0-9_-]{4,128}$/', $uid) ? $uid : '';
    }

    /**
     * @return array<string, mixed>
     */
    private function request_data(WP_REST_Request $request): array
    {
        $json = $this->normalize_payload($request->get_json_params());
        if ($json !== []) {
            return $json;
        }

        $body = $this->normalize_payload($request->get_body_params());
        if ($body !== []) {
            return $body;
        }

        return $this->normalize_payload($request->get_params());
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

    /**
     * @return array<string, mixed>
     */
    private function normalize_payload(mixed $payload): array
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

    private function to_rest_response(mixed $payload, int $status, string $reqId): WP_REST_Response
    {
        $normalizedPayload = $this->normalize_payload($payload);
        $responseRequestId = $reqId;

        if (isset($normalizedPayload['req_id']) && is_scalar($normalizedPayload['req_id']) && trim((string) $normalizedPayload['req_id']) !== '') {
            $responseRequestId = trim((string) $normalizedPayload['req_id']);
        } else {
            $normalizedPayload['req_id'] = $responseRequestId;
        }

        $response = new WP_REST_Response($normalizedPayload, $status);
        $response->header('X-SOSPrescription-Request-ID', $responseRequestId);
        $response->header('Cache-Control', 'no-store, no-cache, must-revalidate');
        $response->header('Pragma', 'no-cache');
        $response->header('Expires', '0');

        return $response;
    }
}
