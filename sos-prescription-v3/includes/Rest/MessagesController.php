<?php
declare(strict_types=1);

namespace SosPrescription\Rest;

use SOSPrescription\Core\NdjsonLogger;
use SOSPrescription\Core\ReqId;
use SOSPrescription\Core\WorkerApiClient;
use SosPrescription\Services\AccessPolicy;
use SosPrescription\Services\Audit;
use SosPrescription\Services\RestGuard;
use WP_Error;
use WP_REST_Request;
use WP_REST_Response;

final class MessagesController extends \WP_REST_Controller
{
    private const NAMESPACE_V1 = 'sosprescription/v1';

    /** @var \wpdb */
    protected $wpdb;

    private ?WorkerApiClient $workerApiClient = null;

    public function __construct($wpdb = null)
    {
        if ($wpdb instanceof \wpdb) {
            $this->wpdb = $wpdb;
        } else {
            global $wpdb;
            $this->wpdb = $wpdb;
        }
    }

    public static function register(): void
    {
        $controller = new self();

        register_rest_route(self::NAMESPACE_V1, '/prescriptions/(?P<id>\d+)/messages', [
            'methods' => 'GET',
            'callback' => [$controller, 'list'],
            'permission_callback' => [$controller, 'permissions_check_logged_in_nonce'],
            'args' => array_merge(
                ['id' => EndpointArgs::id()],
                EndpointArgs::list_messages_v1()
            ),
        ]);

        register_rest_route(self::NAMESPACE_V1, '/prescriptions/(?P<id>\d+)/messages', [
            'methods' => 'POST',
            'callback' => [$controller, 'create'],
            'permission_callback' => [$controller, 'permissions_check_logged_in_nonce'],
            'args' => array_merge(
                ['id' => EndpointArgs::id()],
                EndpointArgs::create_message_v1()
            ),
        ]);

        register_rest_route(self::NAMESPACE_V1, '/prescriptions/(?P<id>\d+)/messages/read', [
            'methods' => 'POST',
            'callback' => [$controller, 'mark_as_read'],
            'permission_callback' => [$controller, 'permissions_check_logged_in_nonce'],
            'args' => array_merge(
                ['id' => EndpointArgs::id()],
                EndpointArgs::mark_messages_read_v1()
            ),
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

        $method = strtoupper((string) $request->get_method());
        if ($method === 'POST') {
            $ok = RestGuard::throttle($request, 'messages_post');
            if (is_wp_error($ok)) {
                return $ok;
            }
        }

        return true;
    }

    public function list(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $localId = (int) $request->get_param('id');
        if ($localId < 1) {
            return new WP_Error('sosprescription_bad_id', 'ID invalide.', ['status' => 400]);
        }

        $row = $this->get_local_prescription_stub($localId);
        if (!is_array($row)) {
            return new WP_Error('sosprescription_not_found', 'Ordonnance introuvable.', ['status' => 404]);
        }
        if (!AccessPolicy::can_current_user_access_prescription_row($row)) {
            return new WP_Error('sosprescription_forbidden', 'Accès refusé.', ['status' => 403]);
        }

        $workerPrescriptionId = $this->extract_worker_prescription_id($row);
        if ($workerPrescriptionId === '') {
            return new WP_Error('sosprescription_worker_reference_missing', 'Référence Worker introuvable.', ['status' => 409]);
        }

        $afterSeq = max(0, (int) ($request->get_param('after_seq') ?? 0));
        $limit = max(1, min(200, (int) ($request->get_param('limit') ?? 50)));
        $actor = $this->build_actor_payload();
        $reqId = $this->build_req_id();

        $params = [
            'actor_role' => $actor['role'],
            'actor_wp_user_id' => (string) $actor['wp_user_id'],
            'after_seq' => (string) $afterSeq,
            'limit' => (string) $limit,
        ];

        try {
            $result = $this->get_worker_api_client()->getSignedJson(
                '/api/v1/prescriptions/' . rawurlencode($workerPrescriptionId) . '/messages?' . http_build_query($params, '', '&', PHP_QUERY_RFC3986),
                $reqId,
                'messages_query'
            );
        } catch (\Throwable $e) {
            return ErrorResponder::worker_bridge_error(
                $e,
                'sosprescription_messages_query_failed',
                'Le service de messagerie est temporairement indisponible.',
                502,
                $reqId,
                [
                    'controller' => __CLASS__,
                    'action' => 'list',
                    'local_prescription_id' => $localId,
                    'worker_prescription_id' => $workerPrescriptionId,
                    'after_seq' => $afterSeq,
                    'limit' => $limit,
                ],
                'messages.query_failed'
            );
        }

        Audit::log('messages_view', 'prescription', $localId, $localId, [
            'after_seq' => $afterSeq,
            'limit' => $limit,
        ]);

        return $this->to_rest_response($result, 200, $reqId);
    }

    public function create(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $localId = (int) $request->get_param('id');
        if ($localId < 1) {
            return new WP_Error('sosprescription_bad_id', 'ID invalide.', ['status' => 400]);
        }

        $row = $this->get_local_prescription_stub($localId);
        if (!is_array($row)) {
            return new WP_Error('sosprescription_not_found', 'Ordonnance introuvable.', ['status' => 404]);
        }
        if (!AccessPolicy::can_current_user_access_prescription_row($row)) {
            return new WP_Error('sosprescription_forbidden', 'Accès refusé.', ['status' => 403]);
        }

        $workerPrescriptionId = $this->extract_worker_prescription_id($row);
        if ($workerPrescriptionId === '') {
            return new WP_Error('sosprescription_worker_reference_missing', 'Référence Worker introuvable.', ['status' => 409]);
        }

        $params = $this->request_data($request);
        $body = isset($params['body']) ? trim((string) $params['body']) : '';
        if ($body === '') {
            return new WP_Error('sosprescription_bad_body', 'Message vide.', ['status' => 400]);
        }
        if (mb_strlen($body) > 8000) {
            return new WP_Error('sosprescription_body_too_long', 'Message trop long.', ['status' => 400]);
        }

        $attachmentIds = [];
        if (isset($params['attachment_artifact_ids']) && is_array($params['attachment_artifact_ids'])) {
            $attachmentIds = $this->normalize_string_ids($params['attachment_artifact_ids']);
        } elseif (isset($params['attachments']) && is_array($params['attachments'])) {
            $attachmentIds = $this->normalize_string_ids($params['attachments']);
        }

        $reqId = $this->build_req_id();
        $payload = [
            'actor' => $this->build_actor_payload(),
            'message' => [
                'body' => $body,
            ],
        ];
        if ($attachmentIds !== []) {
            $payload['message']['attachment_artifact_ids'] = $attachmentIds;
        }

        try {
            $result = $this->get_worker_api_client()->postSignedJson(
                '/api/v1/prescriptions/' . rawurlencode($workerPrescriptionId) . '/messages',
                $payload,
                $reqId,
                'messages_create'
            );
        } catch (\Throwable $e) {
            return ErrorResponder::worker_bridge_error(
                $e,
                'sosprescription_messages_create_failed',
                'Le service de messagerie est temporairement indisponible.',
                502,
                $reqId,
                [
                    'controller' => __CLASS__,
                    'action' => 'create',
                    'local_prescription_id' => $localId,
                    'worker_prescription_id' => $workerPrescriptionId,
                    'attachments_count' => count($attachmentIds),
                ],
                'messages.create_failed'
            );
        }

        Audit::log('message_create', 'prescription', $localId, $localId, [
            'attachments_count' => count($attachmentIds),
        ]);

        return $this->to_rest_response($result, 201, $reqId);
    }

    public function mark_as_read(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $localId = (int) $request->get_param('id');
        if ($localId < 1) {
            return new WP_Error('sosprescription_bad_id', 'ID invalide.', ['status' => 400]);
        }

        $row = $this->get_local_prescription_stub($localId);
        if (!is_array($row)) {
            return new WP_Error('sosprescription_not_found', 'Ordonnance introuvable.', ['status' => 404]);
        }
        if (!AccessPolicy::can_current_user_access_prescription_row($row)) {
            return new WP_Error('sosprescription_forbidden', 'Accès refusé.', ['status' => 403]);
        }

        $workerPrescriptionId = $this->extract_worker_prescription_id($row);
        if ($workerPrescriptionId === '') {
            return new WP_Error('sosprescription_worker_reference_missing', 'Référence Worker introuvable.', ['status' => 409]);
        }

        $params = $this->request_data($request);
        $readUptoSeq = isset($params['read_upto_seq']) ? (int) $params['read_upto_seq'] : 0;
        if ($readUptoSeq < 1) {
            $readUptoSeq = $this->read_last_shadow_message_seq($row);
        }
        $readUptoSeq = max(0, $readUptoSeq);

        $reqId = $this->build_req_id();
        $payload = [
            'actor' => $this->build_actor_payload(),
            'read_upto_seq' => $readUptoSeq,
        ];

        try {
            $result = $this->get_worker_api_client()->postSignedJson(
                '/api/v1/prescriptions/' . rawurlencode($workerPrescriptionId) . '/messages/read',
                $payload,
                $reqId,
                'messages_read'
            );
        } catch (\Throwable $e) {
            return ErrorResponder::worker_bridge_error(
                $e,
                'sosprescription_messages_read_failed',
                'Le service de messagerie est temporairement indisponible.',
                502,
                $reqId,
                [
                    'controller' => __CLASS__,
                    'action' => 'mark_as_read',
                    'local_prescription_id' => $localId,
                    'worker_prescription_id' => $workerPrescriptionId,
                    'read_upto_seq' => $readUptoSeq,
                ],
                'messages.read_failed'
            );
        }

        Audit::log('messages_read', 'prescription', $localId, $localId, [
            'read_upto_seq' => $readUptoSeq,
        ]);

        return $this->to_rest_response($result, 200, $reqId);
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

    private function extract_worker_prescription_id(array $row): string
    {
        $payload = [];
        if (isset($row['payload_json']) && is_string($row['payload_json']) && $row['payload_json'] !== '') {
            $decoded = json_decode($row['payload_json'], true);
            if (is_array($decoded)) {
                $payload = $decoded;
            }
        }

        $worker = isset($payload['worker']) && is_array($payload['worker']) ? $payload['worker'] : [];
        $prescriptionId = isset($worker['prescription_id']) && is_scalar($worker['prescription_id']) ? trim((string) $worker['prescription_id']) : '';
        if ($prescriptionId !== '') {
            return $prescriptionId;
        }

        return isset($worker['job_id']) && is_scalar($worker['job_id']) ? trim((string) $worker['job_id']) : '';
    }

    /**
     * @param array<string, mixed> $row
     */
    private function read_last_shadow_message_seq(array $row): int
    {
        $payload = [];
        if (isset($row['payload_json']) && is_string($row['payload_json']) && $row['payload_json'] !== '') {
            $decoded = json_decode($row['payload_json'], true);
            if (is_array($decoded)) {
                $payload = $decoded;
            }
        }

        $shadow = isset($payload['shadow']) && is_array($payload['shadow']) ? $payload['shadow'] : [];
        $thread = isset($shadow['worker_thread']) && is_array($shadow['worker_thread']) ? $shadow['worker_thread'] : [];
        return isset($thread['last_message_seq']) && is_numeric($thread['last_message_seq']) ? max(0, (int) $thread['last_message_seq']) : 0;
    }

    /**
     * @param array<int, mixed> $ids
     * @return array<int, string>
     */
    private function normalize_string_ids(array $ids): array
    {
        $out = [];
        foreach ($ids as $raw) {
            if ($raw === null || !is_scalar($raw)) {
                continue;
            }

            $id = trim((string) $raw);
            if ($id === '' || strlen($id) < 8 || strlen($id) > 64) {
                continue;
            }

            $out[] = $id;
            if (count($out) >= 10) {
                break;
            }
        }

        return array_values(array_unique($out));
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
     * @return array<string, mixed>
     */
    private function request_data(WP_REST_Request $request): array
    {
        $body = $request->get_json_params();
        if (!is_array($body) || $body === []) {
            $body = $request->get_body_params();
        }
        if (!is_array($body) || $body === []) {
            $body = $request->get_params();
        }

        return is_array($body) ? $body : [];
    }

    private function build_req_id(): string
    {
        try {
            return ReqId::coalesce(null);
        } catch (\Throwable $e) {
            try {
                return 'req_' . bin2hex(random_bytes(8));
            } catch (\Throwable $fallback) {
                return 'req_' . md5((string) wp_rand() . microtime(true));
            }
        }
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
}
