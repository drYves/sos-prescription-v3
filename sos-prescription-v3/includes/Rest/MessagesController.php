<?php
declare(strict_types=1);

namespace SosPrescription\Rest;

use SOSPrescription\Core\JobDispatcher;
use SOSPrescription\Core\NdjsonLogger;
use SOSPrescription\Core\ReqId;
use SosPrescription\Repositories\PrescriptionRepository;
use SosPrescription\Services\AccessPolicy;
use SosPrescription\Services\Audit;
use SosPrescription\Services\RestGuard;
use WP_Error;
use WP_REST_Request;
use WP_REST_Response;

final class MessagesController
{
    /** @var \wpdb */
    protected $wpdb;

    /** @var JobDispatcher|null */
    protected $job_dispatcher;

    protected PrescriptionRepository $prescriptions;

    public function __construct($job_dispatcher = null, $wpdb = null)
    {
        if ($wpdb instanceof \wpdb) {
            $this->wpdb = $wpdb;
        } else {
            global $wpdb;
            $this->wpdb = $wpdb;
        }

        $this->job_dispatcher = $job_dispatcher instanceof JobDispatcher ? $job_dispatcher : null;
        $this->prescriptions = new PrescriptionRepository();
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

    public function list(WP_REST_Request $request)
    {
        $localId = (int) $request->get_param('id');
        if ($localId < 1) {
            return new WP_Error('sosprescription_bad_id', 'ID invalide.', ['status' => 400]);
        }

        $row = $this->get_prescription_row($localId);
        if (!$row) {
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
        $reqId = $this->build_req_id();

        try {
            $result = $this->get_job_dispatcher()->queryPrescriptionMessages(
                $workerPrescriptionId,
                $this->build_actor_payload(),
                $afterSeq,
                $limit,
                $reqId
            );
        } catch (\Throwable $e) {
            return new WP_Error(
                'sosprescription_messages_query_failed',
                'Impossible de récupérer le fil de discussion : ' . $e->getMessage(),
                ['status' => 502, 'req_id' => $reqId]
            );
        }

        $threadState = isset($result['thread_state']) && is_array($result['thread_state']) ? $result['thread_state'] : [];
        $this->store_shadow_thread_state($localId, $threadState);

        Audit::log('messages_view', 'prescription', $localId, $localId, [
            'after_seq' => $afterSeq,
            'limit' => $limit,
        ]);

        return rest_ensure_response($result);
    }

    public function create(WP_REST_Request $request)
    {
        $localId = (int) $request->get_param('id');
        if ($localId < 1) {
            return new WP_Error('sosprescription_bad_id', 'ID invalide.', ['status' => 400]);
        }

        $row = $this->get_prescription_row($localId);
        if (!$row) {
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

        try {
            $result = $this->get_job_dispatcher()->createPrescriptionMessage(
                $workerPrescriptionId,
                $this->build_actor_payload(),
                $body,
                $attachmentIds,
                $reqId
            );
        } catch (\Throwable $e) {
            return new WP_Error(
                'sosprescription_messages_create_failed',
                'Impossible d’envoyer le message : ' . $e->getMessage(),
                ['status' => 502, 'req_id' => $reqId]
            );
        }

        $threadState = isset($result['thread_state']) && is_array($result['thread_state']) ? $result['thread_state'] : [];
        $this->store_shadow_thread_state($localId, $threadState);
        $this->prescriptions->touch_last_activity($localId);

        $currentUserId = (int) get_current_user_id();
        if ((AccessPolicy::is_doctor() || AccessPolicy::is_admin()) && $currentUserId > 0) {
            $assigned = isset($row['doctor_user_id']) && $row['doctor_user_id'] !== null ? (int) $row['doctor_user_id'] : null;
            if ($assigned === null || $assigned < 1) {
                $this->prescriptions->assign_to_doctor($localId, $currentUserId);
            }
        } else {
            $this->prescriptions->set_status_if_current($localId, 'needs_info', 'pending');
        }

        Audit::log('message_create', 'prescription', $localId, $localId, [
            'attachments_count' => count($attachmentIds),
        ]);

        return new WP_REST_Response($result, 201);
    }

    public function mark_as_read(WP_REST_Request $request)
    {
        $localId = (int) $request->get_param('id');
        if ($localId < 1) {
            return new WP_Error('sosprescription_bad_id', 'ID invalide.', ['status' => 400]);
        }

        $row = $this->get_prescription_row($localId);
        if (!$row) {
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

        try {
            $result = $this->get_job_dispatcher()->markPrescriptionMessagesRead(
                $workerPrescriptionId,
                $this->build_actor_payload(),
                $readUptoSeq,
                $reqId
            );
        } catch (\Throwable $e) {
            return new WP_Error(
                'sosprescription_messages_read_failed',
                'Impossible de synchroniser la lecture : ' . $e->getMessage(),
                ['status' => 502, 'req_id' => $reqId]
            );
        }

        $threadState = isset($result['thread_state']) && is_array($result['thread_state']) ? $result['thread_state'] : [];
        $this->store_shadow_thread_state($localId, $threadState);

        Audit::log('messages_read', 'prescription', $localId, $localId, [
            'read_upto_seq' => $readUptoSeq,
        ]);

        return rest_ensure_response($result);
    }

    /**
     * @return array<string, mixed>|null
     */
    private function get_prescription_row(int $prescription_id): ?array
    {
        $row = $this->prescriptions->get($prescription_id);
        return is_array($row) ? $row : null;
    }

    private function extract_worker_prescription_id(array $row): string
    {
        $payload = isset($row['payload']) && is_array($row['payload']) ? $row['payload'] : [];
        if ($payload === [] && isset($row['payload_json']) && is_string($row['payload_json']) && $row['payload_json'] !== '') {
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
        $payload = isset($row['payload']) && is_array($row['payload']) ? $row['payload'] : [];
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
     * @param array<string, mixed> $threadState
     */
    private function store_shadow_thread_state(int $prescription_id, array $threadState): bool
    {
        $table = $this->wpdb->prefix . 'sosprescription_prescriptions';
        $row = $this->wpdb->get_row(
            $this->wpdb->prepare(
                "SELECT id, payload_json FROM `{$table}` WHERE id = %d LIMIT 1",
                $prescription_id
            ),
            ARRAY_A
        );

        if (!is_array($row)) {
            return false;
        }

        $payload = json_decode((string) ($row['payload_json'] ?? '{}'), true);
        if (!is_array($payload)) {
            $payload = [];
        }

        $shadow = isset($payload['shadow']) && is_array($payload['shadow']) ? $payload['shadow'] : [];
        $shadow['zero_pii'] = true;
        $shadow['mode'] = 'worker-postgres';
        $shadow['worker_thread'] = [
            'message_count' => isset($threadState['message_count']) && is_numeric($threadState['message_count']) ? max(0, (int) $threadState['message_count']) : 0,
            'last_message_seq' => isset($threadState['last_message_seq']) && is_numeric($threadState['last_message_seq']) ? max(0, (int) $threadState['last_message_seq']) : 0,
            'last_message_at' => isset($threadState['last_message_at']) && is_scalar($threadState['last_message_at']) ? trim((string) $threadState['last_message_at']) : null,
            'last_message_role' => isset($threadState['last_message_role']) && is_scalar($threadState['last_message_role']) ? trim((string) $threadState['last_message_role']) : null,
            'doctor_last_read_seq' => isset($threadState['doctor_last_read_seq']) && is_numeric($threadState['doctor_last_read_seq']) ? max(0, (int) $threadState['doctor_last_read_seq']) : 0,
            'patient_last_read_seq' => isset($threadState['patient_last_read_seq']) && is_numeric($threadState['patient_last_read_seq']) ? max(0, (int) $threadState['patient_last_read_seq']) : 0,
            'unread_count_doctor' => isset($threadState['unread_count_doctor']) && is_numeric($threadState['unread_count_doctor']) ? max(0, (int) $threadState['unread_count_doctor']) : 0,
            'unread_count_patient' => isset($threadState['unread_count_patient']) && is_numeric($threadState['unread_count_patient']) ? max(0, (int) $threadState['unread_count_patient']) : 0,
        ];
        $payload['shadow'] = $shadow;

        $updated = $this->wpdb->update(
            $table,
            [
                'payload_json' => wp_json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
                'updated_at' => current_time('mysql'),
            ],
            ['id' => $prescription_id],
            ['%s', '%s'],
            ['%d']
        );

        return $updated !== false;
    }

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

    protected function get_job_dispatcher(): JobDispatcher
    {
        if ($this->job_dispatcher instanceof JobDispatcher) {
            return $this->job_dispatcher;
        }

        $secret = $this->get_env_or_constant('ML_HMAC_SECRET');
        if ($secret === '') {
            throw new \RuntimeException('Missing ML_HMAC_SECRET');
        }

        $kid = $this->get_env_or_constant('ML_HMAC_KID', 'primary');
        $site_id = $this->get_worker_site_id();
        $logger = new NdjsonLogger('web', $site_id, $this->get_env_or_constant('SOSPRESCRIPTION_ENV', 'prod'));

        $this->job_dispatcher = new JobDispatcher(
            $this->wpdb,
            $logger,
            $site_id,
            $secret,
            $kid !== '' ? $kid : null
        );

        return $this->job_dispatcher;
    }

    protected function get_worker_site_id(): string
    {
        $site_id = $this->get_env_or_constant('ML_SITE_ID');
        if ($site_id === '') {
            $site_id = home_url('/') ?: 'unknown_site';
        }

        return trim((string) $site_id);
    }

    protected function get_env_or_constant(string $name, string $default = ''): string
    {
        $value = getenv($name);
        if (is_string($value) && trim($value) !== '') {
            return trim($value);
        }

        if (defined($name)) {
            $constant = constant($name);
            if (is_scalar($constant)) {
                return trim((string) $constant);
            }
        }

        return $default;
    }
}
