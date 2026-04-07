<?php // includes/Rest/MessagesV4Controller.php
declare(strict_types=1);

namespace SosPrescription\Rest;

use SOSPrescription\Core\NdjsonLogger;
use SOSPrescription\Core\ReqId;
use SOSPrescription\Core\WorkerApiClient;
use SosPrescription\Services\AccessPolicy;
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
        } else {
            global $wpdb;
            $this->wpdb = $wpdb;
        }
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

        register_rest_route(self::NAMESPACE_V4, '/prescriptions/(?P<uid>[A-Za-z0-9_-]{4,128})/messages/attachments', [
            'methods' => 'POST',
            'callback' => [$controller, 'init_attachment_upload'],
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

        $reqId = ReqId::coalesce(null);
        $actor = $this->build_actor_payload();
        $afterSeq = max(0, (int) ($request->get_param('after_seq') ?? 0));
        $limit = max(1, min(100, (int) ($request->get_param('limit') ?? 50)));

        try {
            $workerPrescriptionId = $this->resolve_worker_prescription_id_from_uid($uid, $actor, $reqId);
            $params = [
                'actor_role' => $actor['role'],
                'actor_wp_user_id' => (string) $actor['wp_user_id'],
                'after_seq' => (string) $afterSeq,
                'limit' => (string) $limit,
            ];

            $workerPayload = $this->get_worker_api_client()->getSignedJson(
                '/api/v1/prescriptions/' . rawurlencode($workerPrescriptionId) . '/messages?' . http_build_query($params, '', '&', PHP_QUERY_RFC3986),
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
                    'wp_user_id' => $actor['wp_user_id'],
                    'actor_role' => $actor['role'],
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

        $reqId = ReqId::coalesce(null);
        $actor = $this->build_actor_payload();
        $params = $this->request_data($request);
        $body = array_key_exists('body', $params) ? trim((string) $params['body']) : '';
        $attachmentIds = $this->normalize_string_ids($params['attachment_artifact_ids'] ?? $params['attachments'] ?? []);

        try {
            $workerPrescriptionId = $this->resolve_worker_prescription_id_from_uid($uid, $actor, $reqId);
            $payload = [
                'actor' => $actor,
                'message' => [
                    'body' => $body,
                ],
            ];
            if ($attachmentIds !== []) {
                $payload['message']['attachment_artifact_ids'] = $attachmentIds;
            }

            $workerPayload = $this->get_worker_api_client()->postSignedJson(
                '/api/v1/prescriptions/' . rawurlencode($workerPrescriptionId) . '/messages',
                $payload,
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
                    'attachments_count' => count($attachmentIds),
                    'wp_user_id' => $actor['wp_user_id'],
                    'actor_role' => $actor['role'],
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

        $reqId = ReqId::coalesce(null);
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
                    'wp_user_id' => $actor['wp_user_id'],
                    'actor_role' => $actor['role'],
                ],
                'messages_v4.read.failed'
            );
        }
    }

    public function init_attachment_upload(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $uid = $this->normalize_uid((string) $request->get_param('uid'));
        if ($uid === '') {
            return new WP_Error('sosprescription_bad_uid', 'Référence de prescription invalide.', ['status' => 400]);
        }

        $reqId = ReqId::coalesce(null);
        $actor = $this->build_actor_payload();
        $params = $this->request_data($request);
        $artifactInput = isset($params['artifact']) && is_array($params['artifact']) ? $params['artifact'] : $params;

        $originalName = isset($artifactInput['original_name']) ? trim((string) $artifactInput['original_name']) : '';
        $mimeType = isset($artifactInput['mime_type']) ? trim((string) $artifactInput['mime_type']) : '';
        $sizeBytes = isset($artifactInput['size_bytes']) ? (int) $artifactInput['size_bytes'] : 0;
        $meta = isset($artifactInput['meta']) && is_array($artifactInput['meta']) ? $artifactInput['meta'] : null;

        if ($originalName === '' || $mimeType === '' || $sizeBytes < 1) {
            return new WP_Error('sosprescription_bad_attachment', 'La pièce jointe de messagerie est invalide.', ['status' => 400]);
        }

        try {
            $workerPrescriptionId = $this->resolve_worker_prescription_id_from_uid($uid, $actor, $reqId);
            $payload = [
                'actor' => $actor,
                'artifact' => [
                    'kind' => 'MESSAGE_ATTACHMENT',
                    'prescription_id' => $workerPrescriptionId,
                    'original_name' => $originalName,
                    'mime_type' => $mimeType,
                    'size_bytes' => $sizeBytes,
                ],
            ];
            if ($meta !== null) {
                $payload['artifact']['meta'] = $meta;
            }

            $workerPayload = $this->get_worker_api_client()->postSignedJson(
                '/api/v1/artifacts/upload/init',
                $payload,
                $reqId,
                'messages_v4_attachment_init'
            );

            return $this->to_rest_response($workerPayload, 201, $reqId);
        } catch (\Throwable $e) {
            return ErrorResponder::worker_bridge_error(
                $e,
                'sosprescription_messages_v4_attachment_failed',
                'La pièce jointe n’a pas pu être préparée.',
                502,
                $reqId,
                [
                    'controller' => __CLASS__,
                    'action' => 'init_attachment_upload',
                    'uid' => $uid,
                    'size_bytes' => $sizeBytes,
                    'mime_type' => $mimeType,
                    'wp_user_id' => $actor['wp_user_id'],
                    'actor_role' => $actor['role'],
                ],
                'messages_v4.attachment_init.failed'
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

        $prescription = isset($workerPayload['prescription']) && is_array($workerPayload['prescription'])
            ? $workerPayload['prescription']
            : [];

        $workerId = $this->extract_worker_prescription_id_from_worker_detail($prescription);
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

        $worker = isset($decoded['worker']) && is_array($decoded['worker']) ? $decoded['worker'] : [];
        $candidate = isset($worker['prescription_id']) && is_scalar($worker['prescription_id'])
            ? trim((string) $worker['prescription_id'])
            : '';

        return $candidate;
    }

    /**
     * @param array<string, mixed> $detail
     */
    private function extract_worker_prescription_id_from_worker_detail(array $detail): string
    {
        $worker = isset($detail['worker']) && is_array($detail['worker']) ? $detail['worker'] : [];
        $candidate = isset($worker['prescription_id']) && is_scalar($worker['prescription_id'])
            ? trim((string) $worker['prescription_id'])
            : '';
        if ($this->is_valid_worker_prescription_id($candidate)) {
            return $candidate;
        }

        $prescription = isset($detail['prescription']) && is_array($detail['prescription']) ? $detail['prescription'] : [];
        $candidate = isset($prescription['id']) && is_scalar($prescription['id'])
            ? trim((string) $prescription['id'])
            : '';
        if ($this->is_valid_worker_prescription_id($candidate)) {
            return $candidate;
        }

        $candidate = isset($detail['id']) && is_scalar($detail['id'])
            ? trim((string) $detail['id'])
            : '';

        return $candidate;
    }

    private function is_valid_worker_prescription_id(string $value): bool
    {
        return $value !== '' && (bool) preg_match('/^[A-Fa-f0-9-]{16,64}$/', $value);
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
        $body = $request->get_json_params();
        if (!is_array($body) || $body === []) {
            $body = $request->get_body_params();
        }
        if (!is_array($body) || $body === []) {
            $body = $request->get_params();
        }

        return is_array($body) ? $body : [];
    }

    /**
     * @param mixed $value
     * @return list<string>
     */
    private function normalize_string_ids(mixed $value): array
    {
        if (!is_array($value)) {
            return [];
        }

        $out = [];
        foreach ($value as $item) {
            if (!is_scalar($item)) {
                continue;
            }
            $normalized = trim((string) $item);
            if ($normalized === '') {
                continue;
            }
            $out[] = $normalized;
            if (count($out) >= 20) {
                break;
            }
        }

        return array_values(array_unique($out));
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
