<?php // includes/Rest/PrescriptionController.php
declare(strict_types=1);

namespace SOSPrescription\Rest;

use SOSPrescription\Repositories\JobRepository;
use SOSPrescription\Repositories\PrescriptionRepository;
use SOSPrescription\Services\AccessPolicy;
use SOSPrescription\Services\Audit;
use SOSPrescription\Services\RestGuard;
use SOSPrescription\Services\StripeConfig;
use SOSPrescription\Services\UidGenerator;
use SOSPrescription\Core\JobDispatcher;
use SOSPrescription\Core\Mls1Verifier;
use SOSPrescription\Core\NdjsonLogger;
use SOSPrescription\Core\NonceStore;
use SOSPrescription\Core\ReqId;
use SOSPrescription\Core\WorkerApiClient;
use SosPrescription\Rest\ErrorResponder;
use WP_Error;
use WP_REST_Request;
use WP_REST_Response;

defined('ABSPATH') || exit;

class PrescriptionController extends \WP_REST_Controller
{
    /** @var \wpdb */
    protected $wpdb;

    /** @var JobRepository */
    protected $jobs;

    /** @var JobDispatcher|null */
    protected $job_dispatcher;

    /** @var PrescriptionRepository */
    protected $prescriptions;

    /** @var WorkerApiClient|null */
    protected $worker_api_client = null;

    /** @var string */
    protected $namespace = 'sosprescription/v1';

    /** @var string */
    protected $rest_base = 'prescriptions';

    /** @var array<string, true>|null */
    protected $prescription_table_columns_cache = null;

    public function __construct($job_dispatcher = null, $jobs = null, $wpdb = null)
    {
        if ($wpdb instanceof \wpdb) {
            $this->wpdb = $wpdb;
        } else {
            global $wpdb;
            $this->wpdb = $wpdb;
        }

        $this->jobs = $jobs instanceof JobRepository ? $jobs : new JobRepository($this->wpdb);
        $this->job_dispatcher = $job_dispatcher instanceof JobDispatcher ? $job_dispatcher : null;
        $this->prescriptions = new PrescriptionRepository();
    }

    public function permissions_check_logged_in_nonce(WP_REST_Request $request): bool|WP_Error
    {
        $ok = RestGuard::require_logged_in($request);
        if (is_wp_error($ok)) {
            return $ok;
        }

        return RestGuard::require_wp_rest_nonce($request);
    }

    public function permissions_check_validate(WP_REST_Request $request): bool|WP_Error
    {
        $ok = $this->permissions_check_logged_in_nonce($request);
        if (is_wp_error($ok)) {
            return $ok;
        }

        return RestGuard::require_any_cap($request, ['sosprescription_validate', 'sosprescription_manage', 'manage_options']);
    }

    public function create(WP_REST_Request $request)
    {
        return new \WP_Error(
            'sosprescription_v1_deprecated',
            'Cette version du formulaire est obsolète. Veuillez rafraîchir la page pour utiliser le nouveau système sécurisé.',
            ['status' => 410]
        );
    }

    public function list(WP_REST_Request $request)
    {
        $status = trim((string) $request->get_param('status'));
        $limit = max(1, min(200, (int) ($request->get_param('limit') ?? 100)));
        $offset = max(0, (int) ($request->get_param('offset') ?? 0));
        $req_id = $this->build_req_id();

        $actorContext = $this->build_read_actor_context();
        if (is_wp_error($actorContext)) {
            return $actorContext;
        }

        $filters = [
            'limit' => $limit,
            'offset' => $offset,
        ];
        if ($status !== '') {
            $filters['status'] = $status;
        }

        $path = $actorContext['kind'] === 'doctor'
            ? '/api/v2/doctor/inbox'
            : '/api/v2/patient/prescriptions/query';
        $scope = $actorContext['kind'] === 'doctor'
            ? 'prescriptions_v1_list_doctor_proxy'
            : 'prescriptions_v1_list_patient_proxy';

        try {
            $workerPayload = $this->get_worker_api_client()->postSignedJson(
                $path,
                [
                    'actor' => $actorContext['actor'],
                    'filters' => $filters,
                ],
                $req_id,
                $scope
            );
        } catch (\Throwable $e) {

            if ($this->is_soft_empty_worker_bridge_error($e)) {

                return $this->to_proxy_response([], 200, $req_id);
            }

            return ErrorResponder::worker_bridge_error(
                $e,
                'sosprescription_worker_read_failed',
                'Le service sécurisé de lecture est temporairement indisponible.',
                502,
                $req_id,
                [
                    'controller' => __CLASS__,
                    'action' => 'list',
                    'actor_role' => $actorContext['actor']['role'],
                    'wp_user_id' => $actorContext['actor']['wp_user_id'],
                    'bridge_error' => $e->getMessage(),
                    'bridge_exception_class' => get_class($e),
                ],
                'prescriptions_v1.list.proxy_failed'
            );
        }

        try {
            $rows = $this->extract_worker_rows_from_payload($workerPayload);
            $rows = $this->swap_worker_row_ids_with_local_ids($rows, $req_id);
            $rows = $this->sanitize_proxy_rows($rows, $req_id);
        } catch (\Throwable $e) {
            $rows = [];
        }

        return $this->to_proxy_response($rows, 200, $req_id);
    }

    public function get_one(WP_REST_Request $request)
    {
        $id = (int) $request->get_param('id');
        if ($id < 1) {
            return new WP_Error('sosprescription_bad_id', 'ID invalide.', ['status' => 400]);
        }

        $req_id = $this->build_req_id();
        $actorContext = $this->build_read_actor_context();
        if (is_wp_error($actorContext)) {
            return $actorContext;
        }

        $localRow = $this->find_local_prescription_stub_by_id($id);
        if (!is_array($localRow)) {
            return new WP_Error('sosprescription_not_found', 'Ordonnance introuvable.', ['status' => 404]);
        }

        try {
            $workerPrescriptionId = $this->resolve_worker_prescription_id_for_local_stub($localRow, $actorContext, $req_id);
        } catch (\Throwable $e) {
            return ErrorResponder::worker_bridge_error(
                $e,
                'sosprescription_worker_read_failed',
                'Le service sécurisé de lecture est temporairement indisponible.',
                502,
                $req_id,
                [
                    'controller' => __CLASS__,
                    'action' => 'get_one_resolve_worker_id',
                    'local_id' => $id,
                    'actor_role' => $actorContext['actor']['role'],
                    'wp_user_id' => $actorContext['actor']['wp_user_id'],
                    'bridge_error' => $e->getMessage(),
                    'bridge_exception_class' => get_class($e),
                ],
                'prescriptions_v1.get_one.resolve_failed'
            );
        }

        if ($workerPrescriptionId === '') {
            return new WP_Error(
                'sosprescription_worker_reference_missing',
                'Référence Worker introuvable.',
                ['status' => 404]
            );
        }

        try {
            $workerPayload = $this->get_worker_api_client()->postSignedJson(
                '/api/v2/prescriptions/get',
                [
                    'actor' => $actorContext['actor'],
                    'prescription_id' => $workerPrescriptionId,
                ],
                $req_id,
                'prescriptions_v1_get_one_proxy'
            );
        } catch (\Throwable $e) {
            return ErrorResponder::worker_bridge_error(
                $e,
                'sosprescription_worker_read_failed',
                'Le service sécurisé de lecture est temporairement indisponible.',
                502,
                $req_id,
                [
                    'controller' => __CLASS__,
                    'action' => 'get_one',
                    'local_id' => $id,
                    'worker_prescription_id' => $workerPrescriptionId,
                    'actor_role' => $actorContext['actor']['role'],
                    'wp_user_id' => $actorContext['actor']['wp_user_id'],
                    'bridge_error' => $e->getMessage(),
                    'bridge_exception_class' => get_class($e),
                ],
                'prescriptions_v1.get_one.proxy_failed'
            );
        }

        $row = $this->extract_worker_prescription_from_payload($workerPayload);

        if (!is_array($row)) {
            return new WP_Error('sosprescription_not_found', 'Ordonnance introuvable.', ['status' => 404]);
        }

        $row['id'] = $id;

        return $this->to_proxy_response($row, 200, $req_id);
    }

    public function update_item($request)
    {
        $request = $this->ensure_rest_request($request);

        return new WP_Error(
            'sosprescription_update_not_supported',
            'La mise à jour directe d’une ordonnance n’est pas supportée par cette version.',
            ['status' => 501]
        );
    }

    public function decision(WP_REST_Request $request)
    {
        $id = (int) $request->get_param('id');
        $decision = strtolower(trim((string) $request->get_param('decision')));
        $items = null;
        if ($decision === 'approved') {
            $reason = null;
            $itemsParam = $request->get_param('items');
            if ($itemsParam !== null) {
                if (!is_array($itemsParam)) {
                    return new WP_Error('sosprescription_bad_items', 'Les médicaments transmis sont invalides.', ['status' => 400]);
                }
                $items = array_values($itemsParam);
            }
        } else {
            $reason = trim((string) ($request->get_param('reason') ?? ''));
            if ($reason === '') {
                $reason = null;
            }
        }

        if ($id < 1 || !in_array($decision, ['approved', 'rejected'], true)) {
            return new WP_Error('sosprescription_bad_request', 'Paramètres invalides.', ['status' => 400]);
        }

        $doctor_id = (int) get_current_user_id();
        if ($doctor_id < 1) {
            return new WP_Error('sosprescription_auth_required', 'Connexion requise.', ['status' => 401]);
        }

        $row = $this->prescriptions->get($id);
        if (!is_array($row)) {
            return new WP_Error('sosprescription_not_found', 'Ordonnance introuvable.', ['status' => 404]);
        }

        $currentStatus = strtolower(trim((string) ($row['status'] ?? '')));
        if (in_array($currentStatus, ['approved', 'rejected'], true) && $currentStatus !== $decision) {
            return new WP_Error('sosprescription_decision_conflict', 'Décision impossible pour cette ordonnance.', ['status' => 409]);
        }

        $req_id = $this->build_req_id();
        $workerMeta = $this->extract_worker_shadow_state($row);
        $workerPrescriptionId = isset($workerMeta['prescription_id']) ? trim((string) $workerMeta['prescription_id']) : '';
        if ($workerPrescriptionId === '') {
            return new WP_Error('sosprescription_worker_reference_missing', 'Référence Worker introuvable.', ['status' => 409]);
        }

        try {
            $dispatcher = $this->get_job_dispatcher();
            if ($decision === 'approved') {
                $doctorPayload = $dispatcher->buildDoctorPayloadFromUserId($doctor_id);
                $workerResult = $dispatcher->approvePrescription($workerPrescriptionId, $doctorPayload, $req_id, $items);
            } else {
                $workerResult = $dispatcher->rejectPrescription($workerPrescriptionId, $reason, $req_id);
            }
            $workerResult = $this->force_decision_worker_shadow_state(
                is_array($workerResult) ? $workerResult : [],
                $decision,
                $workerPrescriptionId,
                $req_id
            );
        } catch (\Throwable $e) {
            return $this->raw_exact_unprocessable_response(
                'Échec de validation HDS (Veuillez faire un screen) : ' . (string) $e->getMessage(),
                $req_id
            );
        }

        $ok = true;
        if (!in_array($currentStatus, ['approved', 'rejected'], true)) {
            $ok = $this->prescriptions->decide($id, $doctor_id, $decision, $reason);
        }

        if (!$ok) {
            return new WP_Error('sosprescription_decision_conflict', 'Décision impossible pour cette ordonnance.', ['status' => 409]);
        }

        if ($decision === 'approved') {
            $workerResult['status'] = 'APPROVED';
            $workerResult['processing_status'] = 'PENDING';
            $workerResult['last_error_code'] = '';
            $workerResult['last_error_message_safe'] = '';
        } else {
            $workerResult['status'] = 'REJECTED';
            $workerResult['processing_status'] = 'FAILED';
        }

        $shadowStore = $this->store_shadow_worker_state($id, $workerResult);
        if (is_wp_error($shadowStore)) {
            return $shadowStore;
        }

        $row = $this->prescriptions->get($id);
        if (!is_array($row)) {
            return new WP_Error('sosprescription_not_found', 'Ordonnance introuvable.', ['status' => 404]);
        }

        if ($decision === 'approved' && is_array($items) && $items !== []) {
            $row['items'] = $items;
        }

        $pdf = $this->build_shadow_pdf_state($id, $row);

        return new WP_REST_Response([
            'id' => $id,
            'decision' => $decision,
            'req_id' => $req_id,
            'prescription' => $row,
            'worker' => [
                'prescription_id' => (string) ($workerResult['prescription_id'] ?? $workerPrescriptionId),
                'status' => (string) ($workerResult['status'] ?? strtoupper($decision)),
                'processing_status' => (string) ($workerResult['processing_status'] ?? ($decision === 'approved' ? 'PENDING' : 'FAILED')),
                'verify_token' => isset($workerResult['verify_token']) && is_scalar($workerResult['verify_token']) ? (string) $workerResult['verify_token'] : '',
                'verify_code' => isset($workerResult['verify_code']) && is_scalar($workerResult['verify_code']) ? (string) $workerResult['verify_code'] : '',
            ],
            'pdf' => $pdf,
            'message' => $decision === 'approved'
                ? 'Validation enregistrée. Le Worker peut maintenant générer le PDF.'
                : 'Rejet enregistré.',
        ], 200);
    }

    public function assign(WP_REST_Request $request)
    {
        $id = (int) $request->get_param('id');
        if ($id < 1) {
            return new WP_Error('sosprescription_bad_id', 'ID invalide.', ['status' => 400]);
        }

        $doctor_id = (int) get_current_user_id();
        if ($doctor_id < 1) {
            return new WP_Error('sosprescription_auth_required', 'Connexion requise.', ['status' => 401]);
        }

        $ok = $this->prescriptions->assign_to_doctor($id, $doctor_id);
        if (!$ok) {
            return new WP_Error('sosprescription_assign_conflict', 'Assignation impossible pour cette ordonnance.', ['status' => 409]);
        }

        $row = $this->prescriptions->get($id);
        return rest_ensure_response($row ?: ['ok' => true, 'id' => $id]);
    }

    public function update_status(WP_REST_Request $request)
    {
        $id = (int) $request->get_param('id');
        $status = strtolower(trim((string) $request->get_param('status')));

        if ($id < 1 || $status === '') {
            return new WP_Error('sosprescription_bad_request', 'Paramètres invalides.', ['status' => 400]);
        }

        $doctor_id = (int) get_current_user_id();
        if ($doctor_id < 1) {
            return new WP_Error('sosprescription_auth_required', 'Connexion requise.', ['status' => 401]);
        }

        $ok = $this->prescriptions->update_status_by_doctor($id, $doctor_id, $status);
        if (!$ok) {
            return new WP_Error('sosprescription_status_conflict', 'Mise à jour du statut impossible.', ['status' => 409]);
        }

        $row = $this->prescriptions->get($id);
        return rest_ensure_response($row ?: ['ok' => true, 'id' => $id, 'status' => $status]);
    }

    public function print_view(WP_REST_Request $request)
    {
        if ($this->truthy($request->get_param('download_pdf')) || $this->truthy($request->get_param('pdf'))) {
            return $this->get_rx_pdf($request);
        }

        return $this->get_one($request);
    }

    public function create_item($request)
    {
        $request = $this->ensure_rest_request($request);
        return $this->create($request);
    }

    public function get_items($request)
    {
        $request = $this->ensure_rest_request($request);
        return $this->list($request);
    }

    public function get_item($request)
    {
        $request = $this->ensure_rest_request($request);
        return $this->get_one($request);
    }

    public function decide($request)
    {
        return $this->decision($this->ensure_rest_request($request));
    }

    public function generate_rx_pdf($request)
    {
        $request = $this->ensure_rest_request($request);
        $prescription_id = (int) $request->get_param('id');
        $req_id = $this->build_req_id();

        $dispatch = $this->dispatch_pdf_generation($prescription_id, 'manual_dispatch', $req_id);

        if (is_wp_error($dispatch)) {
            return new WP_REST_Response([
                'ok' => false,
                'mode' => 'stateless',
                'req_id' => $req_id,
                'prescription_id' => $prescription_id,
                'pdf' => $this->build_degraded_pdf_state($dispatch, $req_id),
                'message' => 'Le PDF n’a pas pu être mis en file immédiatement.',
            ], 202);
        }

        $pdf = isset($dispatch['pdf']) && is_array($dispatch['pdf']) ? $dispatch['pdf'] : ['status' => 'pending'];
        $pdf = $this->enrich_pdf_state_for_response($prescription_id, $pdf);

        $payload = $dispatch;
        $payload['pdf'] = $pdf;
        if (!empty($pdf['download_url']) && is_string($pdf['download_url'])) {
            $payload['download_url'] = $pdf['download_url'];
        }
        if (!empty($pdf['expires_in'])) {
            $payload['expires_in'] = (int) $pdf['expires_in'];
        }

        $status_code = (($pdf['status'] ?? 'pending') === 'done') ? 200 : 202;
        return new WP_REST_Response($payload, $status_code);
    }

    public function get_pdf_status($request)
    {
        $request = $this->ensure_rest_request($request);
        $prescription_id = (int) $request->get_param('id');

        $row = $this->prescriptions->get($prescription_id);
        if (!is_array($row)) {
            return new WP_Error('sosprescription_not_found', 'Ordonnance introuvable.', ['status' => 404]);
        }

        if (!AccessPolicy::can_current_user_access_prescription_row($row)) {
            return new WP_Error('sosprescription_forbidden', 'Accès refusé.', ['status' => 403]);
        }

        $pdf = $this->enrich_pdf_state_for_response($prescription_id, $this->build_shadow_pdf_state($prescription_id, $row));

        return new WP_REST_Response([
            'prescription_id' => $prescription_id,
            'pdf' => $pdf,
        ], 200);
    }

    public function worker_pdf_callback(WP_REST_Request $request)
    {
        $verified = $this->get_worker_callback_verifier()->verifyJsonBodySigned($request, 'worker_shadow_callback');
        if (is_wp_error($verified)) {
            return $verified;
        }

        $data = isset($verified['data']) && is_array($verified['data']) ? $verified['data'] : [];
        $req_id = ReqId::coalesce(isset($verified['req_id']) && is_string($verified['req_id']) ? $verified['req_id'] : null);

        $schemaVersion = isset($data['schema_version']) && is_scalar($data['schema_version']) ? (string) $data['schema_version'] : '';
        if (!in_array($schemaVersion, ['2026.6', '2026.5'], true)) {
            return new WP_Error('sosprescription_worker_callback_schema', 'Schema callback invalide.', ['status' => 400]);
        }

        $siteId = isset($data['site_id']) && is_scalar($data['site_id']) ? (string) $data['site_id'] : '';
        if ($siteId !== $this->get_worker_site_id()) {
            return new WP_Error('sosprescription_worker_callback_site', 'Site callback invalide.', ['status' => 403]);
        }

        $job = isset($data['job']) && is_array($data['job']) ? $data['job'] : [];
        if ($job === []) {
            return new WP_Error('sosprescription_worker_callback_job', 'Payload job manquant.', ['status' => 400]);
        }

        $pathJobId = trim((string) $request->get_param('job_id'));
        $bodyJobId = trim((string) ($job['job_id'] ?? ($job['prescription_id'] ?? '')));
        $jobId = $pathJobId !== '' ? $pathJobId : $bodyJobId;
        if (!$this->is_valid_worker_prescription_id($jobId)) {
            return new WP_Error('sosprescription_worker_callback_job_id', 'Identifiant Worker invalide.', ['status' => 400]);
        }
        if ($bodyJobId !== '' && $bodyJobId !== $jobId) {
            return new WP_Error('sosprescription_worker_callback_job_mismatch', 'Mauvais identifiant Worker.', ['status' => 400]);
        }

        $localId = $this->find_shadow_prescription_id_by_worker_prescription_id($jobId);
        if ($localId < 1) {
            return new WP_Error('sosprescription_worker_callback_not_found', 'Shadow record introuvable.', ['status' => 404]);
        }

        $status = $this->normalize_worker_callback_status(isset($job['status']) ? $job['status'] : 'DONE');
        $processing = $this->normalize_worker_processing_status(
            isset($job['processing_status']) ? $job['processing_status'] : $status,
            $status
        );

        $workerUpdate = [
            'prescription_id' => $jobId,
            'job_id' => $jobId,
            'status' => $status,
            'processing_status' => $processing,
            'source_req_id' => isset($job['source_req_id']) && is_scalar($job['source_req_id']) ? (string) $job['source_req_id'] : $req_id,
            'worker_ref' => isset($job['worker_ref']) && is_scalar($job['worker_ref']) ? substr(sanitize_text_field((string) $job['worker_ref']), 0, 191) : '',
            's3_key_ref' => isset($job['s3_key_ref']) && is_scalar($job['s3_key_ref']) ? substr(trim((string) $job['s3_key_ref']), 0, 1024) : '',
            's3_bucket' => isset($job['s3_bucket']) && is_scalar($job['s3_bucket']) ? substr(sanitize_text_field((string) $job['s3_bucket']), 0, 191) : '',
            's3_region' => isset($job['s3_region']) && is_scalar($job['s3_region']) ? substr(sanitize_text_field((string) $job['s3_region']), 0, 64) : '',
            'artifact_sha256_hex' => isset($job['artifact_sha256_hex']) && is_scalar($job['artifact_sha256_hex']) ? strtolower(trim((string) $job['artifact_sha256_hex'])) : '',
            'artifact_size_bytes' => isset($job['artifact_size_bytes']) && is_numeric($job['artifact_size_bytes']) ? (int) $job['artifact_size_bytes'] : null,
            'artifact_content_type' => isset($job['artifact_content_type']) && is_scalar($job['artifact_content_type']) ? substr(sanitize_text_field((string) $job['artifact_content_type']), 0, 128) : '',
            'last_error_code' => isset($job['last_error_code']) && is_scalar($job['last_error_code']) ? substr(preg_replace('/[^A-Z0-9_\-]/i', '_', strtoupper((string) $job['last_error_code'])) ?? 'ML_WORKER_CALLBACK', 0, 64) : '',
            'last_error_message_safe' => isset($job['last_error_message_safe']) && is_scalar($job['last_error_message_safe']) ? substr(trim(wp_strip_all_tags((string) $job['last_error_message_safe'])), 0, 255) : '',
        ];

        $shadowStore = $this->store_shadow_worker_state($localId, $workerUpdate);
        if (is_wp_error($shadowStore)) {
            return $shadowStore;
        }

        $row = $this->prescriptions->get($localId);
        $pdf = is_array($row) ? $this->build_shadow_pdf_state($localId, $row) : ['status' => strtolower($processing)];

        return new WP_REST_Response([
            'ok' => true,
            'req_id' => $req_id,
            'prescription_id' => $localId,
            'worker_prescription_id' => $jobId,
            'status' => $status,
            'processing_status' => $processing,
            'pdf' => $pdf,
        ], 200);
    }

    public function get_rx_pdf($request)
    {
        $request = $this->ensure_rest_request($request);
        $prescription_id = (int) $request->get_param('id');
        $row = $this->prescriptions->get($prescription_id);

        if (!is_array($row)) {
            return new WP_Error('sosprescription_not_found', 'Ordonnance introuvable.', ['status' => 404]);
        }

        if (!AccessPolicy::can_current_user_access_prescription_row($row)) {
            return new WP_Error('sosprescription_forbidden', 'Accès refusé.', ['status' => 403]);
        }

        $auto_dispatch = true;
        if ($request->offsetExists('dispatch')) {
            $auto_dispatch = $this->truthy($request->get_param('dispatch'));
        }

        if ($auto_dispatch) {
            $req_id = $this->build_req_id();
            $dispatch = $this->dispatch_pdf_generation($prescription_id, 'download_probe', $req_id);

            if (is_wp_error($dispatch)) {
                return new WP_REST_Response([
                    'prescription_id' => $prescription_id,
                    'pdf' => $this->build_degraded_pdf_state($dispatch, $req_id),
                    'message' => 'PDF temporairement indisponible.',
                ], 202);
            }

            $pdf = isset($dispatch['pdf']) && is_array($dispatch['pdf']) ? $dispatch['pdf'] : ['status' => 'pending'];
            $pdf = $this->enrich_pdf_state_for_response($prescription_id, $pdf);
            $response = [
                'prescription_id' => $prescription_id,
                'pdf' => $pdf,
                'dispatch' => isset($dispatch['dispatch']) && is_array($dispatch['dispatch']) ? $dispatch['dispatch'] : [],
                'job_payload' => isset($dispatch['job_payload']) && is_array($dispatch['job_payload']) ? $dispatch['job_payload'] : [],
                'message' => ($pdf['status'] ?? 'pending') === 'done'
                    ? $this->message_for_pdf_state($pdf)
                    : 'PDF en cours de génération.',
            ];

            if (!empty($pdf['download_url']) && is_string($pdf['download_url'])) {
                $response['download_url'] = $pdf['download_url'];
            }
            if (!empty($pdf['expires_in'])) {
                $response['expires_in'] = (int) $pdf['expires_in'];
            }

            return new WP_REST_Response($response, ($pdf['status'] ?? 'pending') === 'done' ? 200 : 202);
        }

        $pdf = $this->enrich_pdf_state_for_response($prescription_id, $this->build_shadow_pdf_state($prescription_id, $row));

        $response = [
            'prescription_id' => $prescription_id,
            'pdf' => $pdf,
            'message' => ($pdf['status'] ?? 'pending') === 'done'
                ? $this->message_for_pdf_state($pdf)
                : 'PDF en cours de génération.',
        ];

        if (!empty($pdf['download_url']) && is_string($pdf['download_url'])) {
            $response['download_url'] = $pdf['download_url'];
        }
        if (!empty($pdf['expires_in'])) {
            $response['expires_in'] = (int) $pdf['expires_in'];
        }

        return new WP_REST_Response($response, ($pdf['status'] ?? 'pending') === 'done' ? 200 : 202);
    }

    /**
     * @return array<string, mixed>
     */
    protected function request_data(WP_REST_Request $request): array
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

    protected function ensure_rest_request($request): WP_REST_Request
    {
        return $request instanceof WP_REST_Request ? $request : new WP_REST_Request();
    }

    protected function build_req_id(): string
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

    protected function is_soft_empty_worker_bridge_error(\Throwable $error): bool
    {
        $message = strtolower(trim($error->getMessage()));
        if ($message === '') {
            return false;
        }

        foreach ([
            'empty worker response body',
            'invalid worker json response',
            'json decode failed',
            'json_error',
            'json error',
        ] as $needle) {
            if (str_contains($message, $needle)) {
                return true;
            }
        }

        return false;
    }

    protected function sanitize_proxy_rows(array $rows, ?string $reqId = null): array
    {
        $sanitized = [];
        foreach ($rows as $index => $row) {
            try {
                if (!is_array($row)) {
                    continue;
                }
                $sanitized[] = $this->sanitize_proxy_value($row);
            } catch (\Throwable $e) {
            }
        }

        return $sanitized;
    }

    protected function sanitize_proxy_value($value)
    {
        if (is_array($value)) {
            $out = [];
            foreach ($value as $key => $item) {
                $safeKey = is_int($key) ? $key : (string) $key;
                $out[$safeKey] = $this->sanitize_proxy_value($item);
            }
            return $out;
        }

        if (is_object($value)) {
            $encoded = wp_json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            if (is_string($encoded) && $encoded !== '') {
                $decoded = json_decode($encoded, true);
                if (is_array($decoded)) {
                    return $this->sanitize_proxy_value($decoded);
                }
            }

            return [];
        }

        if (is_string($value)) {
            return wp_check_invalid_utf8($value, true);
        }

        if (is_bool($value) || is_int($value) || is_float($value) || $value === null) {
            return $value;
        }

        return is_scalar($value) ? (string) $value : null;
    }

    /**
     * @return array<string, mixed>
     */
    protected function build_degraded_pdf_state(WP_Error $error, string $req_id): array
    {
        return [
            'status' => 'degraded',
            'job_id' => '',
            'req_id' => $req_id,
            'can_download' => false,
            's3_ready' => false,
            'last_error_code' => $error->get_error_code(),
            'last_error_message' => $error->get_error_message(),
            'error' => [
                'code' => $error->get_error_code(),
                'message' => $error->get_error_message(),
            ],
        ];
    }

    /**
     * @param array<string, mixed> $pdf_state
     */
    protected function message_for_pdf_state(array $pdf_state): string
    {
        $status = isset($pdf_state['status']) ? (string) $pdf_state['status'] : 'pending';

        if ($status === 'done') {
            if (empty($pdf_state['can_download'])) {
                $last_error = isset($pdf_state['last_error_message']) ? (string) $pdf_state['last_error_message'] : '';
                return $last_error !== '' ? $last_error : 'PDF généré mais lien de téléchargement indisponible.';
            }
            return 'Validation enregistrée. PDF disponible.';
        }

        if ($status === 'failed') {
            return 'Validation enregistrée. Le PDF est indisponible pour le moment.';
        }

        if ($status === 'degraded') {
            $last_error = isset($pdf_state['last_error_message']) ? (string) $pdf_state['last_error_message'] : '';
            return $last_error !== '' ? $last_error : 'Validation enregistrée. Service PDF ralenti ; le document sera disponible sous peu.';
        }

        if ($status === 'waiting_approval') {
            return 'En attente de validation médecin.';
        }

        return 'Validation enregistrée. PDF en cours de génération.';
    }

    protected function truthy($value): bool
    {
        if (is_bool($value)) {
            return $value;
        }

        if (is_numeric($value)) {
            return (int) $value === 1;
        }

        return in_array(strtolower(trim((string) $value)), ['1', 'true', 'yes', 'y', 'on'], true);
    }

    /**
     * @param array<string, mixed> $job
     */
    protected function build_presigned_s3_url_from_job(array $job, $ttl = 60)
    {
        $ttl = max(1, min(604800, (int) $ttl));

        $filtered = apply_filters('sosprescription_presign_s3_url', null, $job, $ttl);
        if (is_string($filtered) && $filtered !== '') {
            return $filtered;
        }

        $key = !empty($job['s3_key_ref']) ? (string) $job['s3_key_ref'] : '';
        $bucket = !empty($job['s3_bucket']) ? (string) $job['s3_bucket'] : $this->get_env_or_constant('SOSPRESCRIPTION_S3_BUCKET');
        $region = !empty($job['s3_region']) ? (string) $job['s3_region'] : $this->get_env_or_constant('SOSPRESCRIPTION_S3_REGION', $this->get_env_or_constant('AWS_REGION'));
        $endpoint = $this->get_env_or_constant('SOSPRESCRIPTION_S3_ENDPOINT', $this->get_env_or_constant('AWS_ENDPOINT_URL_S3'));

        if ($key === '' || $bucket === '' || $region === '') {
            return new WP_Error(
                'sosprescription_s3_config_missing',
                'Erreur de configuration S3 : lien de téléchargement impossible à générer.',
                ['status' => 500]
            );
        }

        $credentials = $this->resolve_s3_credentials();
        if (is_wp_error($credentials)) {
            return $credentials;
        }

        $amz_date = gmdate('Ymd\THis\Z');
        $date = gmdate('Ymd');
        $scope = $date . '/' . $region . '/s3/aws4_request';
        $use_path_style = ($endpoint !== '' || strpos($bucket, '.') !== false);

        if ($endpoint !== '') {
            $parsed = wp_parse_url($endpoint);
            $scheme = !empty($parsed['scheme']) ? $parsed['scheme'] : 'https';
            $host = !empty($parsed['host']) ? $parsed['host'] : '';
            $base_path = !empty($parsed['path']) ? rtrim($parsed['path'], '/') : '';

            if ($host === '') {
                return new WP_Error('sosprescription_s3_endpoint_invalid', 'Endpoint S3 invalide.', ['status' => 500]);
            }

            $canonical_uri = $base_path . '/' . $this->aws_uri_encode($bucket) . '/' . $this->aws_uri_encode_path($key);
            $url_base = $scheme . '://' . $host;
        } elseif ($use_path_style) {
            $host = 's3.' . $region . '.amazonaws.com';
            $canonical_uri = '/' . $this->aws_uri_encode($bucket) . '/' . $this->aws_uri_encode_path($key);
            $url_base = 'https://' . $host;
        } else {
            $host = $bucket . '.s3.' . $region . '.amazonaws.com';
            $canonical_uri = '/' . $this->aws_uri_encode_path($key);
            $url_base = 'https://' . $host;
        }

        $query = [
            'X-Amz-Algorithm' => 'AWS4-HMAC-SHA256',
            'X-Amz-Credential' => $credentials['access_key'] . '/' . $scope,
            'X-Amz-Date' => $amz_date,
            'X-Amz-Expires' => (string) $ttl,
            'X-Amz-SignedHeaders' => 'host',
        ];

        if (!empty($credentials['session_token'])) {
            $query['X-Amz-Security-Token'] = $credentials['session_token'];
        }

        $canonical_query = $this->aws_build_query($query);
        $canonical_headers = 'host:' . $host . "\n";
        $signed_headers = 'host';
        $canonical_request = "GET\n{$canonical_uri}\n{$canonical_query}\n{$canonical_headers}\n{$signed_headers}\nUNSIGNED-PAYLOAD";
        $string_to_sign = "AWS4-HMAC-SHA256\n{$amz_date}\n{$scope}\n" . hash('sha256', $canonical_request);
        $signing_key = $this->aws_signing_key($credentials['secret_key'], $date, $region, 's3');
        $signature = hash_hmac('sha256', $string_to_sign, $signing_key);

        return $url_base . $canonical_uri . '?' . $canonical_query . '&X-Amz-Signature=' . $signature;
    }

    /**
     * @return array{access_key:string,secret_key:string,session_token:string}|WP_Error
     */
    protected function resolve_s3_credentials(): array|WP_Error
    {
        $access_key = $this->get_env_or_constant('SOSPRESCRIPTION_S3_ACCESS_KEY', $this->get_env_or_constant('AWS_ACCESS_KEY_ID'));
        $secret_key = $this->get_env_or_constant('SOSPRESCRIPTION_S3_SECRET_KEY', $this->get_env_or_constant('AWS_SECRET_ACCESS_KEY'));
        $session = $this->get_env_or_constant('SOSPRESCRIPTION_S3_SESSION_TOKEN', $this->get_env_or_constant('AWS_SESSION_TOKEN'));

        if ($access_key === '' || $secret_key === '') {
            return new WP_Error(
                'sosprescription_s3_credentials_missing',
                'Erreur de configuration S3 : lien de téléchargement impossible à générer.',
                ['status' => 500]
            );
        }

        return [
            'access_key' => $access_key,
            'secret_key' => $secret_key,
            'session_token' => $session,
        ];
    }

    protected function get_env_or_constant(string $name, string $default = ''): string
    {
        if (defined($name)) {
            $value = constant($name);
            if (is_string($value) && $value !== '') {
                return $value;
            }
        }

        $env = getenv($name);
        if (is_string($env) && $env !== '') {
            return $env;
        }

        return $default;
    }

    protected function aws_signing_key(string $secret, string $date, string $region, string $service): string
    {
        $k_date = hash_hmac('sha256', $date, 'AWS4' . $secret, true);
        $k_region = hash_hmac('sha256', $region, $k_date, true);
        $k_service = hash_hmac('sha256', $service, $k_region, true);

        return hash_hmac('sha256', 'aws4_request', $k_service, true);
    }

    /**
     * @param array<string, string> $params
     */
    protected function aws_build_query(array $params): string
    {
        ksort($params);

        $pairs = [];
        foreach ($params as $key => $value) {
            $pairs[] = $this->aws_uri_encode($key) . '=' . $this->aws_uri_encode((string) $value);
        }

        return implode('&', $pairs);
    }

    protected function aws_uri_encode_path(string $value): string
    {
        $segments = explode('/', ltrim($value, '/'));
        $encoded = [];

        foreach ($segments as $segment) {
            $encoded[] = $this->aws_uri_encode($segment);
        }

        return implode('/', $encoded);
    }

    protected function aws_uri_encode(string $value): string
    {
        return str_replace('%7E', '~', rawurlencode($value));
    }

    /**
     * @param array<string, mixed> $pdf
     * @return array<string, mixed>
     */
    protected function enrich_pdf_state_for_response(int $prescription_id, array $pdf): array
    {
        $status = isset($pdf['status']) ? strtolower((string) $pdf['status']) : '';
        $download_url = isset($pdf['download_url']) && is_scalar($pdf['download_url']) ? trim((string) $pdf['download_url']) : '';

        if ($download_url !== '') {
            $pdf['can_download'] = true;
            $pdf['s3_ready'] = true;
            if (!isset($pdf['expires_in']) || !is_numeric($pdf['expires_in'])) {
                $pdf['expires_in'] = 300;
            }
            return $pdf;
        }

        if ($status === 'done') {
            $row = $this->prescriptions->get($prescription_id);
            if (is_array($row)) {
                $worker = $this->extract_worker_shadow_state($row);
                $s3KeyRef = isset($worker['s3_key_ref']) && is_scalar($worker['s3_key_ref']) ? trim((string) $worker['s3_key_ref']) : '';
                $s3Bucket = isset($worker['s3_bucket']) && is_scalar($worker['s3_bucket']) ? trim((string) $worker['s3_bucket']) : '';
                $s3Region = isset($worker['s3_region']) && is_scalar($worker['s3_region']) ? trim((string) $worker['s3_region']) : '';
                $artifactSizeBytes = isset($worker['artifact_size_bytes']) && is_numeric($worker['artifact_size_bytes']) ? (int) $worker['artifact_size_bytes'] : null;
                $artifactContentType = isset($worker['artifact_content_type']) && is_scalar($worker['artifact_content_type'])
                    ? trim((string) $worker['artifact_content_type'])
                    : 'application/pdf';

                if ($s3KeyRef !== '') {
                    $presigned = $this->build_presigned_s3_url_from_job([
                        'job_id' => isset($worker['job_id']) && is_scalar($worker['job_id']) ? (string) $worker['job_id'] : (string) $prescription_id,
                        's3_key_ref' => $s3KeyRef,
                        's3_bucket' => $s3Bucket,
                        's3_region' => $s3Region,
                        'artifact_size_bytes' => $artifactSizeBytes,
                        'artifact_content_type' => $artifactContentType,
                    ], 300);

                    if (!is_wp_error($presigned) && is_string($presigned) && $presigned !== '') {
                        $pdf['download_url'] = $presigned;
                        $pdf['can_download'] = true;
                        $pdf['s3_ready'] = true;
                        $pdf['expires_in'] = 300;
                        if (empty($pdf['message'])) {
                            $pdf['message'] = 'Validation enregistrée. PDF disponible.';
                        }
                        return $pdf;
                    }

                    $pdf['last_error_code'] = is_wp_error($presigned) ? $presigned->get_error_code() : 's3_link_unavailable';
                    $pdf['last_error_message'] = is_wp_error($presigned)
                        ? $presigned->get_error_message()
                        : 'Le lien de téléchargement n’a pas pu être généré.';
                }
            }

            $pdf['can_download'] = false;
            $pdf['s3_ready'] = false;
            if (!isset($pdf['last_error_code'])) {
                $pdf['last_error_code'] = null;
            }
            if (!isset($pdf['last_error_message']) || !is_string($pdf['last_error_message']) || trim($pdf['last_error_message']) === '') {
                $pdf['last_error_message'] = 'Le PDF est prêt côté Worker, mais le lien de téléchargement n’est pas encore synchronisé.';
            }
        }

        return $pdf;
    }

    /**
     * @param array<string, mixed> $job
     * @param array<string, mixed>|null $base_pdf
     * @return array<string, mixed>
     */
    protected function build_pdf_error_state_from_job(array $job, WP_Error $error, ?array $base_pdf = null): array
    {
        $pdf = is_array($base_pdf) ? $base_pdf : [
            'status' => 'done',
            'job_id' => isset($job['job_id']) && is_scalar($job['job_id']) ? (string) $job['job_id'] : '',
            'worker_prescription_id' => isset($job['prescription_id']) && is_scalar($job['prescription_id']) ? (string) $job['prescription_id'] : '',
        ];

        $pdf['status'] = isset($pdf['status']) ? (string) $pdf['status'] : 'done';
        $pdf['can_download'] = false;
        $pdf['s3_ready'] = false;
        $pdf['download_url'] = '';
        $pdf['expires_in'] = 0;
        $pdf['last_error_code'] = $error->get_error_code();
        $pdf['last_error_message'] = $error->get_error_message();

        return $pdf;
    }

    /**
     * @return array<string, mixed>|WP_Error
     */
    /**
     * @return array<string, mixed>|WP_Error
     */
    protected function dispatch_pdf_generation(int $prescription_id, string $source, ?string $req_id = null): array|WP_Error
    {
        $prescription_id = (int) $prescription_id;
        $req_id = is_string($req_id) && $req_id !== '' ? $req_id : $this->build_req_id();

        if ($prescription_id < 1) {
            return new WP_Error('sosprescription_bad_id', 'ID invalide.', ['status' => 400]);
        }

        $row = $this->prescriptions->get($prescription_id);
        if (!is_array($row)) {
            return new WP_Error('sosprescription_not_found', 'Ordonnance introuvable.', ['status' => 404]);
        }

        $workerMeta = $this->extract_worker_shadow_state($row);
        $workerPrescriptionId = isset($workerMeta['prescription_id']) ? trim((string) $workerMeta['prescription_id']) : '';
        if ($workerPrescriptionId === '') {
            return new WP_Error('sosprescription_worker_reference_missing', 'Référence Worker introuvable.', ['status' => 409]);
        }

        $workerResult = null;
        $workerStatus = strtoupper(trim((string) ($workerMeta['status'] ?? 'PENDING')));
        $canAutoApprove = in_array($source, ['doctor_approval', 'manual_dispatch'], true)
            && (AccessPolicy::is_doctor() || AccessPolicy::is_admin());

        if ($workerStatus === 'PENDING' && $canAutoApprove) {
            $doctorId = (int) get_current_user_id();
            if ($doctorId < 1) {
                return new WP_Error('sosprescription_auth_required', 'Connexion requise.', ['status' => 401]);
            }

            try {
                $dispatcher = $this->get_job_dispatcher();
                $doctorPayload = $dispatcher->buildDoctorPayloadFromUserId($doctorId);
                $workerResult = $dispatcher->approvePrescription($workerPrescriptionId, $doctorPayload, $req_id);
                $workerResult = $this->force_decision_worker_shadow_state(
                    is_array($workerResult) ? $workerResult : [],
                    'approved',
                    $workerPrescriptionId,
                    $req_id
                );
                $shadowStore = $this->store_shadow_worker_state($prescription_id, $workerResult);
                if (is_wp_error($shadowStore)) {
                    return $shadowStore;
                }
                $row = $this->prescriptions->get($prescription_id) ?: $row;
                $workerMeta = $this->extract_worker_shadow_state($row);
            } catch (\Throwable $e) {
                return ErrorResponder::internal_error(
                    $e,
                    'sosprescription_pdf_dispatch_failed',
                    'La génération du document est temporairement indisponible.',
                    502,
                    $req_id,
                    [
                        'controller' => __CLASS__,
                        'action' => 'dispatch_pdf_generation',
                        'local_prescription_id' => $prescription_id,
                        'worker_prescription_id' => $workerPrescriptionId,
                        'source' => $source,
                    ],
                    'prescription.pdf_dispatch_failed'
                );
            }
        }

        $pdf = $this->build_shadow_pdf_state($prescription_id, $row);
        $dispatchStatus = isset($workerMeta['processing_status']) ? strtolower((string) $workerMeta['processing_status']) : 'pending';
        if ($dispatchStatus === 'pending' && strtoupper(trim((string) ($workerMeta['status'] ?? 'PENDING'))) === 'PENDING') {
            $dispatchStatus = 'waiting_approval';
        }

        return [
            'ok' => true,
            'mode' => 'worker-postgres',
            'site_id' => $this->get_worker_site_id(),
            'req_id' => $req_id,
            'prescription_id' => $prescription_id,
            'verification' => [
                'verify_token' => isset($row['verify_token']) && is_scalar($row['verify_token']) ? (string) $row['verify_token'] : '',
                'verify_code' => isset($row['verify_code']) && is_scalar($row['verify_code']) ? (string) $row['verify_code'] : '',
            ],
            'dispatch' => [
                'action' => $workerResult !== null ? 'released' : 'noop',
                'job_id' => isset($workerMeta['job_id']) ? (string) $workerMeta['job_id'] : '',
                'worker_job_id' => isset($workerMeta['job_id']) ? (string) $workerMeta['job_id'] : '',
                'worker_prescription_id' => $workerPrescriptionId,
                'status' => $dispatchStatus,
                'source' => $source,
                'req_id' => $req_id,
            ],
            'job_payload' => [
                'schema_version' => '2026.6',
                'site_id' => $this->get_worker_site_id(),
                'job_id' => isset($workerMeta['job_id']) ? (string) $workerMeta['job_id'] : '',
                'job_type' => 'PDF_GEN',
                'worker_prescription_id' => $workerPrescriptionId,
                'source' => $source,
            ],
            'pdf' => $pdf,
        ];
    }

    /**
     * @param array<string, mixed> $params
     * @return array<string, mixed>|WP_Error
     */
    protected function build_worker_ingress_payload_from_create_params(array $params, string $req_id): array|WP_Error
    {
        $patient = isset($params['patient']) && is_array($params['patient']) ? $params['patient'] : [];
        $patientIdentity = $this->extract_patient_identity_from_params($params);
        $fullname = $patientIdentity['full_name'];
        $birthdate = $patientIdentity['birth_date'];
        if (self::str_len($fullname) < 2) {
            return new WP_Error('sosprescription_patient_name_required', 'Nom du patient manquant.', ['status' => 400]);
        }
        if ($birthdate === '') {
            return new WP_Error('sosprescription_patient_birthdate_required', 'Date de naissance manquante.', ['status' => 400]);
        }

        $firstName = $patientIdentity['first_name'];
        $lastName = $patientIdentity['last_name'];
        if ($firstName === '' || $lastName === '') {
            return new WP_Error(
                'sosprescription_patient_identity_invalid',
                'Merci de saisir le prénom et le nom du patient, et non une adresse e-mail.',
                ['status' => 400]
            );
        }

        $items = isset($params['items']) && is_array($params['items']) ? array_values($params['items']) : [];
        if ($items === []) {
            return new WP_Error('sosprescription_items_required', 'Au moins un médicament est requis.', ['status' => 400]);
        }

        $note = isset($patient['note']) ? trim((string) $patient['note']) : '';
        $flow = strtolower(trim((string) ($params['flow'] ?? 'ro_proof')));
        if ($flow === '') {
            $flow = 'ro_proof';
        }

        $priority = strtolower(trim((string) ($params['priority'] ?? 'standard')));
        if ($priority !== 'express') {
            $priority = 'standard';
        }

        $client_request_id = isset($params['client_request_id']) ? trim((string) $params['client_request_id']) : null;
        if ($client_request_id === '') {
            $client_request_id = null;
        }

        $proof_artifact_ids = $this->extract_proof_artifact_ids_from_create_params($params);

        $email = isset($patient['email']) ? sanitize_email((string) $patient['email']) : '';
        $phone = isset($patient['phone']) ? trim((string) $patient['phone']) : '';
        $gender = isset($patient['gender']) ? trim((string) $patient['gender']) : '';

        $dispatcher = $this->get_job_dispatcher();
        $doctorPayload = $this->resolve_doctor_payload_from_create_params($params);

        $patientProfilePayload = [];
        $patientUserId = (int) get_current_user_id();
        if ($patientUserId > 0) {
            try {
                $patientProfilePayload = $dispatcher->buildPatientPayloadFromUserId($patientUserId);
            } catch (\Throwable $e) {
                $patientProfilePayload = [];
            }
        }

        $profileGender = isset($patientProfilePayload['gender']) && is_scalar($patientProfilePayload['gender']) ? trim((string) $patientProfilePayload['gender']) : '';
        $profileEmail = isset($patientProfilePayload['email']) && is_scalar($patientProfilePayload['email']) ? sanitize_email((string) $patientProfilePayload['email']) : '';
        $profilePhone = isset($patientProfilePayload['phone']) && is_scalar($patientProfilePayload['phone']) ? trim((string) $patientProfilePayload['phone']) : '';
        $profileWeightKg = isset($patientProfilePayload['weight_kg']) && is_scalar($patientProfilePayload['weight_kg']) ? trim((string) $patientProfilePayload['weight_kg']) : '';

        $prescriptionPayload = [
            'items' => $items,
            'privateNotes' => $note !== '' ? $note : null,
            'source' => 'wordpress_capture',
            'flow' => $flow,
            'priority' => $priority,
            'clientRequestId' => $client_request_id,
        ];

        if ($proof_artifact_ids !== []) {
            $prescriptionPayload['proof_artifact_ids'] = $proof_artifact_ids;
        }

        return [
            'schema_version' => '2026.6',
            'site_id' => $this->get_worker_site_id(),
            'ts_ms' => (int) floor(microtime(true) * 1000),
            'nonce' => $this->generate_verify_token(),
            'req_id' => $req_id,
            'doctor' => $doctorPayload,
            'patient' => [
                'firstName' => $firstName,
                'lastName' => $lastName,
                'birthDate' => $birthdate,
                'gender' => $gender !== '' ? $gender : ($profileGender !== '' ? $profileGender : null),
                'email' => $email !== '' ? $email : ($profileEmail !== '' ? $profileEmail : null),
                'phone' => $phone !== '' ? $phone : ($profilePhone !== '' ? $profilePhone : null),
                'weight_kg' => $profileWeightKg !== '' ? $profileWeightKg : null,
            ],
            'prescription' => $prescriptionPayload,
        ];
    }

    /**
     * @return array<int, string>
     */
    protected function extract_proof_artifact_ids_from_create_params(array $params): array
    {
        $raw = null;
        if (array_key_exists('proof_artifact_ids', $params)) {
            $raw = $params['proof_artifact_ids'];
        } elseif (array_key_exists('evidence_file_ids', $params)) {
            $raw = $params['evidence_file_ids'];
        }

        if (!is_array($raw)) {
            return [];
        }

        $filtered = [];
        foreach ($raw as $value) {
            if ($value === null || !is_scalar($value)) {
                continue;
            }
            $id = trim((string) $value);
            if ($id === '') {
                continue;
            }
            $filtered[] = $id;
            if (count($filtered) >= 10) {
                break;
            }
        }

        return $this->normalize_worker_artifact_ids($filtered);
    }

    /**
     * @param mixed $value
     * @return array<int, string>
     */
    protected function normalize_worker_artifact_ids($value): array
    {
        if (!is_array($value)) {
            return [];
        }

        $out = [];
        foreach ($value as $raw) {
            if ($raw === null || !is_scalar($raw)) {
                continue;
            }

            $id = trim((string) $raw);
            if ($id === '') {
                continue;
            }
            if (preg_match('/^[A-Za-z0-9\-]{8,64}$/', $id) !== 1) {
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
     * @param array<string, mixed> $workerResult
     * @param array<string, mixed> $params
     * @return array<string, mixed>|WP_Error
     */
    protected function create_shadow_prescription_from_worker_result(array $workerResult, array $params): array|WP_Error
    {
        $flow = $this->normalize_shadow_flow_key((string) ($params['flow'] ?? 'ro_proof'));

        $priority = strtolower(trim((string) ($params['priority'] ?? 'standard')));
        if ($priority !== 'express') {
            $priority = 'standard';
        }

        $client_request_id = isset($params['client_request_id']) ? trim((string) $params['client_request_id']) : null;
        if ($client_request_id === '') {
            $client_request_id = null;
        }

        $stripe = StripeConfig::get();
        $initial_status = !empty($stripe['enabled']) ? 'payment_pending' : 'pending';

        $uid = isset($workerResult['uid']) && is_scalar($workerResult['uid']) && (string) $workerResult['uid'] !== ''
            ? (string) $workerResult['uid']
            : UidGenerator::generate(10);

        $proof_artifact_ids = $this->extract_proof_artifact_ids_from_create_params($params);

        $payload = array_merge($this->build_business_cache_payload($params), [
            'proof_artifact_ids' => $proof_artifact_ids,
            'shadow' => [
                'zero_pii' => true,
                'mode' => 'worker-postgres',
                'worker_thread' => [
                    'message_count' => 0,
                    'last_message_seq' => 0,
                    'last_message_at' => null,
                    'last_message_role' => null,
                    'doctor_last_read_seq' => 0,
                    'patient_last_read_seq' => 0,
                    'unread_count_doctor' => 0,
                    'unread_count_patient' => 0,
                ],
                'worker_evidence' => [
                    'has_proof' => $proof_artifact_ids !== [],
                    'proof_count' => count($proof_artifact_ids),
                    'proof_artifact_ids' => $proof_artifact_ids,
                ],
            ],
            'worker' => $this->build_worker_shadow_payload($workerResult),
        ]);

        $result = $this->prescriptions->create(
            (int) get_current_user_id(),
            $uid,
            $payload,
            $this->build_business_cache_items($params),
            $flow,
            $priority,
            $client_request_id,
            [],
            $initial_status
        );

        if (isset($result['error'])) {
            $phase = isset($result['error']) && is_string($result['error']) && trim((string) $result['error']) !== ''
                ? trim((string) $result['error'])
                : 'shadow_insert_main';
            $message = isset($result['message']) && is_string($result['message']) && trim((string) $result['message']) !== ''
                ? trim((string) $result['message'])
                : 'Erreur SQL locale inconnue lors de la création du shadow record.';

            return new WP_Error($phase, $message, ['status' => 422]);
        }

        $localId = isset($result['id']) ? (int) $result['id'] : 0;
        if ($localId < 1) {
            return new WP_Error('shadow_readback', 'Shadow record introuvable après création.', ['status' => 422]);
        }

        $shadowStore = $this->store_shadow_worker_state($localId, $workerResult);
        if (is_wp_error($shadowStore)) {
            return $shadowStore;
        }

        $row = $this->prescriptions->get($localId);
        if (!is_array($row)) {
            return new WP_Error('shadow_readback', 'Shadow record introuvable après création.', ['status' => 422]);
        }

        return $row;
    }

    /**
     * @param array<string, mixed> $workerResult
     * @return array<string, mixed>
     */
    protected function force_decision_worker_shadow_state(array $workerResult, string $decision, string $workerPrescriptionId, string $req_id): array
    {
        $normalizedDecision = strtolower(trim($decision));
        $workerResult['prescription_id'] = isset($workerResult['prescription_id']) && is_scalar($workerResult['prescription_id'])
            ? (string) $workerResult['prescription_id']
            : $workerPrescriptionId;
        $workerResult['source_req_id'] = isset($workerResult['source_req_id']) && is_scalar($workerResult['source_req_id']) && (string) $workerResult['source_req_id'] !== ''
            ? (string) $workerResult['source_req_id']
            : $req_id;

        if ($normalizedDecision === 'approved') {
            $workerResult['status'] = 'APPROVED';
            $workerResult['processing_status'] = 'PENDING';
            $workerResult['last_error_code'] = '';
            $workerResult['last_error_message_safe'] = '';
        } elseif ($normalizedDecision === 'rejected') {
            $workerResult['status'] = 'REJECTED';
            $workerResult['processing_status'] = 'FAILED';
            if (!isset($workerResult['last_error_code']) || !is_scalar($workerResult['last_error_code']) || trim((string) $workerResult['last_error_code']) === '') {
                $workerResult['last_error_code'] = 'rejected';
            }
            if (!isset($workerResult['last_error_message_safe']) || !is_scalar($workerResult['last_error_message_safe']) || trim((string) $workerResult['last_error_message_safe']) === '') {
                $workerResult['last_error_message_safe'] = 'L’ordonnance a été rejetée.';
            }
        }

        return $workerResult;
    }

    /**
     * @param array<string, mixed> $workerData
     * @return array<string, mixed>
     */
    protected function build_worker_shadow_payload(array $workerData): array
    {
        return [
            'prescription_id' => isset($workerData['prescription_id']) && is_scalar($workerData['prescription_id']) ? (string) $workerData['prescription_id'] : '',
            'job_id' => isset($workerData['job_id']) && is_scalar($workerData['job_id']) ? (string) $workerData['job_id'] : '',
            'uid' => isset($workerData['uid']) && is_scalar($workerData['uid']) ? (string) $workerData['uid'] : '',
            'status' => isset($workerData['status']) && is_scalar($workerData['status']) ? (string) $workerData['status'] : 'PENDING',
            'processing_status' => isset($workerData['processing_status']) && is_scalar($workerData['processing_status']) ? (string) $workerData['processing_status'] : 'PENDING',
            'source_req_id' => isset($workerData['source_req_id']) && is_scalar($workerData['source_req_id']) ? (string) $workerData['source_req_id'] : '',
            'verify_token' => isset($workerData['verify_token']) && is_scalar($workerData['verify_token']) ? (string) $workerData['verify_token'] : '',
            'verify_code' => isset($workerData['verify_code']) && is_scalar($workerData['verify_code']) ? (string) $workerData['verify_code'] : '',
            's3_key_ref' => isset($workerData['s3_key_ref']) && is_scalar($workerData['s3_key_ref']) ? (string) $workerData['s3_key_ref'] : '',
            's3_bucket' => isset($workerData['s3_bucket']) && is_scalar($workerData['s3_bucket']) ? (string) $workerData['s3_bucket'] : '',
            's3_region' => isset($workerData['s3_region']) && is_scalar($workerData['s3_region']) ? (string) $workerData['s3_region'] : '',
            'artifact_sha256_hex' => isset($workerData['artifact_sha256_hex']) && is_scalar($workerData['artifact_sha256_hex']) ? (string) $workerData['artifact_sha256_hex'] : '',
            'artifact_size_bytes' => isset($workerData['artifact_size_bytes']) && is_numeric($workerData['artifact_size_bytes']) ? (int) $workerData['artifact_size_bytes'] : null,
            'artifact_content_type' => isset($workerData['artifact_content_type']) && is_scalar($workerData['artifact_content_type']) ? (string) $workerData['artifact_content_type'] : '',
            'last_error_code' => isset($workerData['last_error_code']) && is_scalar($workerData['last_error_code']) ? (string) $workerData['last_error_code'] : '',
            'last_error_message_safe' => isset($workerData['last_error_message_safe']) && is_scalar($workerData['last_error_message_safe']) ? (string) $workerData['last_error_message_safe'] : '',
            'last_sync_at' => current_time('mysql'),
        ];
    }

    /**
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    protected function extract_worker_shadow_state(array $row): array
    {
        $payload = isset($row['payload']) && is_array($row['payload']) ? $row['payload'] : [];
        if ($payload === [] && isset($row['payload_json']) && is_string($row['payload_json']) && $row['payload_json'] !== '') {
            $decoded = json_decode($row['payload_json'], true);
            if (is_array($decoded)) {
                $payload = $decoded;
            }
        }

        $payloadNode = $this->normalize_worker_payload($payload['payload'] ?? []);
        $worker = $this->normalize_worker_payload($payloadNode['worker'] ?? ($payload['worker'] ?? []));
        return $worker;
    }

    /**
     * @param array<string, mixed> $workerData
     * @return true|WP_Error
     */
    protected function store_shadow_worker_state(int $prescription_id, array $workerData): true|WP_Error
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
            $sqlError = is_string($this->wpdb->last_error) ? trim((string) $this->wpdb->last_error) : '';
            return new WP_Error(
                'shadow_store_payload',
                $sqlError !== '' ? $sqlError : 'Shadow record introuvable avant synchronisation du payload.',
                ['status' => 422]
            );
        }

        $payload = json_decode((string) ($row['payload_json'] ?? '{}'), true);
        if (!is_array($payload)) {
            $payload = [];
        }

        $existingWorker = isset($payload['worker']) && is_array($payload['worker']) ? $payload['worker'] : [];
        $incomingWorker = $this->build_worker_shadow_payload($workerData);

        $proofArtifactIds = isset($payload['proof_artifact_ids']) && is_array($payload['proof_artifact_ids'])
            ? $this->normalize_worker_artifact_ids($payload['proof_artifact_ids'])
            : [];

        $existingShadow = isset($payload['shadow']) && is_array($payload['shadow']) ? $payload['shadow'] : [];
        $payload['shadow'] = array_merge($existingShadow, [
            'zero_pii' => true,
            'mode' => 'worker-postgres',
        ]);

        if (!isset($payload['shadow']['worker_thread']) || !is_array($payload['shadow']['worker_thread'])) {
            $payload['shadow']['worker_thread'] = [
                'message_count' => 0,
                'last_message_seq' => 0,
                'last_message_at' => null,
                'last_message_role' => null,
                'doctor_last_read_seq' => 0,
                'patient_last_read_seq' => 0,
                'unread_count_doctor' => 0,
                'unread_count_patient' => 0,
            ];
        }

        if (!isset($payload['shadow']['worker_evidence']) || !is_array($payload['shadow']['worker_evidence'])) {
            $payload['shadow']['worker_evidence'] = [
                'has_proof' => $proofArtifactIds !== [],
                'proof_count' => count($proofArtifactIds),
                'proof_artifact_ids' => $proofArtifactIds,
            ];
        } else {
            $payload['shadow']['worker_evidence']['has_proof'] = $proofArtifactIds !== [];
            $payload['shadow']['worker_evidence']['proof_count'] = count($proofArtifactIds);
            $payload['shadow']['worker_evidence']['proof_artifact_ids'] = $proofArtifactIds;
        }

        $payload['worker'] = $this->merge_shadow_worker_payload($existingWorker, $incomingWorker);

        $update = [
            'payload_json' => wp_json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
            'updated_at' => current_time('mysql'),
        ];
        $formats = ['%s', '%s'];

        if ($this->prescription_table_has_column('verify_token')
            && isset($incomingWorker['verify_token'])
            && is_scalar($incomingWorker['verify_token'])
            && (string) $incomingWorker['verify_token'] !== '') {
            $update['verify_token'] = (string) $incomingWorker['verify_token'];
            $formats[] = '%s';
        }
        if ($this->prescription_table_has_column('verify_code')
            && isset($incomingWorker['verify_code'])
            && is_scalar($incomingWorker['verify_code'])
            && (string) $incomingWorker['verify_code'] !== '') {
            $update['verify_code'] = (string) $incomingWorker['verify_code'];
            $formats[] = '%s';
        }

        $updated = $this->wpdb->update(
            $table,
            $update,
            ['id' => $prescription_id],
            $formats,
            ['%d']
        );

        if ($updated === false) {
            $sqlError = is_string($this->wpdb->last_error) ? trim((string) $this->wpdb->last_error) : '';
            return new WP_Error(
                'shadow_store_payload',
                $sqlError !== '' ? $sqlError : 'Échec SQL local lors de la mise à jour du payload shadow.',
                ['status' => 422]
            );
        }

        return true;
    }
    /**
     * @param array<string, mixed> $existing
     * @param array<string, mixed> $incoming
     * @return array<string, mixed>
     */
    protected function merge_shadow_worker_payload(array $existing, array $incoming): array
    {
        $merged = $existing;
        foreach ($incoming as $key => $value) {
            if ($this->should_preserve_existing_worker_value($key, $value, $existing, $incoming)) {
                continue;
            }
            $merged[$key] = $value;
        }

        return $merged;
    }

    /**
     * @param array<string, mixed> $existing
     * @param array<string, mixed> $incoming
     */
    protected function should_preserve_existing_worker_value(string $key, mixed $value, array $existing, array $incoming): bool
    {
        $stickyStringKeys = [
            's3_key_ref',
            's3_bucket',
            's3_region',
            'artifact_sha256_hex',
            'artifact_content_type',
            'verify_token',
            'verify_code',
        ];

        if (in_array($key, $stickyStringKeys, true)) {
            return (!is_scalar($value) || trim((string) $value) === '')
                && isset($existing[$key])
                && is_scalar($existing[$key])
                && trim((string) $existing[$key]) !== '';
        }

        if ($key === 'artifact_size_bytes') {
            return ($value === null || (is_numeric($value) && (int) $value <= 0))
                && isset($existing[$key])
                && is_numeric($existing[$key])
                && (int) $existing[$key] > 0;
        }

        if ($key === 'last_error_code' || $key === 'last_error_message_safe') {
            $status = isset($incoming['status']) && is_scalar($incoming['status']) ? strtoupper(trim((string) $incoming['status'])) : '';
            $processing = isset($incoming['processing_status']) && is_scalar($incoming['processing_status']) ? strtoupper(trim((string) $incoming['processing_status'])) : '';
            if (in_array($status, ['DONE', 'APPROVED'], true) || $processing === 'DONE') {
                return false;
            }
            return (!is_scalar($value) || trim((string) $value) === '')
                && isset($existing[$key])
                && is_scalar($existing[$key])
                && trim((string) $existing[$key]) !== '';
        }

        return false;
    }

    /**
     * @param array<string, mixed> $params
     * @return array<string, mixed>
     */
    protected function build_business_cache_payload(array $params): array
    {
        $patientIdentity = $this->extract_patient_identity_from_params($params);
        $patient = isset($params['patient']) && is_array($params['patient']) ? $params['patient'] : [];
        $note = isset($patient['note']) ? trim((string) $patient['note']) : '';
        $patientWeightKg = $this->extract_patient_weight_kg_from_params($params);
        $cacheFields = ['patient_identity', 'medication_lines'];

        if ($patientWeightKg !== '') {
            array_splice($cacheFields, 1, 0, 'patient_weight');
        }

        return [
            'patient' => [
                'fullname' => $patientIdentity['full_name'],
                'birthdate' => $patientIdentity['birth_date'],
                'weight_kg' => $patientWeightKg !== '' ? $patientWeightKg : null,
            ],
            'patient_name' => $patientIdentity['full_name'],
            'patient_birthdate' => $patientIdentity['birth_date'],
            'patient_weight_kg' => $patientWeightKg !== '' ? $patientWeightKg : null,
            'prescription' => [
                'privateNotes' => $note !== '' ? $note : null,
            ],
            'cache' => [
                'mode' => 'business',
                'fields' => $cacheFields,
            ],
        ];
    }

    protected function extract_patient_weight_kg_from_params(array $params): string
    {
        $patient = isset($params['patient']) && is_array($params['patient']) ? $params['patient'] : [];
        $candidate = $this->normalize_metric_string((string) ($patient['weight_kg'] ?? $patient['weightKg'] ?? $patient['weight'] ?? $params['patient_weight_kg'] ?? $params['weight_kg'] ?? ''));
        if ($candidate !== '') {
            return $candidate;
        }

        $patientUserId = (int) get_current_user_id();
        if ($patientUserId > 0) {
            foreach (['sosp_weight_kg', 'weight_kg', 'patient_weight_kg'] as $metaKey) {
                $value = $this->normalize_metric_string((string) get_user_meta($patientUserId, $metaKey, true));
                if ($value !== '') {
                    return $value;
                }
            }
        }

        return '';
    }

    protected function normalize_metric_string(string $value, float $min = 1.0, float $max = 500.0): string
    {
        $raw = str_replace(',', '.', trim($value));
        if ($raw === '' || !is_numeric($raw)) {
            return '';
        }

        $number = (float) $raw;
        if ($number < $min || $number > $max) {
            return '';
        }

        $formatted = number_format($number, 1, '.', '');
        return str_ends_with($formatted, '.0') ? substr($formatted, 0, -2) : $formatted;
    }

    /**
     * @param array<string, mixed> $params
     * @return array<int, array<string, mixed>>
     */
    protected function build_business_cache_items(array $params): array
    {
        $items = isset($params['items']) && is_array($params['items']) ? array_values($params['items']) : [];
        $normalized = [];

        foreach ($items as $item) {
            if (!is_array($item)) {
                continue;
            }

            $label = trim((string) ($item['label'] ?? $item['denomination'] ?? $item['name'] ?? ''));
            if ($label === '') {
                $label = 'Médicament';
            }

            $normalized[] = [
                'cis' => isset($item['cis']) && $item['cis'] !== '' ? (string) $item['cis'] : null,
                'cip13' => isset($item['cip13']) && $item['cip13'] !== '' ? (string) $item['cip13'] : null,
                'label' => $label,
                'schedule' => isset($item['schedule']) && is_array($item['schedule']) ? $item['schedule'] : [],
                'quantite' => isset($item['quantite']) && trim((string) $item['quantite']) !== '' ? trim((string) $item['quantite']) : null,
            ];
        }

        return $normalized;
    }

    /**
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    protected function build_shadow_pdf_state(int $prescription_id, array $row): array
    {
        $worker = $this->extract_worker_shadow_state($row);
        $processing = strtolower(trim((string) ($worker['processing_status'] ?? 'pending')));
        $workerStatus = strtoupper(trim((string) ($worker['status'] ?? 'PENDING')));
        $s3KeyRef = isset($worker['s3_key_ref']) && is_scalar($worker['s3_key_ref']) ? trim((string) $worker['s3_key_ref']) : '';
        $s3Bucket = isset($worker['s3_bucket']) && is_scalar($worker['s3_bucket']) ? trim((string) $worker['s3_bucket']) : '';
        $s3Region = isset($worker['s3_region']) && is_scalar($worker['s3_region']) ? trim((string) $worker['s3_region']) : '';
        $artifactSizeBytes = isset($worker['artifact_size_bytes']) && is_numeric($worker['artifact_size_bytes']) ? (int) $worker['artifact_size_bytes'] : null;
        $artifactContentType = isset($worker['artifact_content_type']) && is_scalar($worker['artifact_content_type']) ? trim((string) $worker['artifact_content_type']) : 'application/pdf';
        $businessStatus = strtolower(trim((string) ($row['status'] ?? 'pending')));

        if ($businessStatus === 'approved' && $workerStatus === 'PENDING') {
            $workerStatus = 'APPROVED';
        } elseif ($businessStatus === 'rejected' && $workerStatus !== 'REJECTED') {
            $workerStatus = 'REJECTED';
            if ($processing === '' || $processing === 'pending') {
                $processing = 'failed';
            }
        }

        $status = 'pending';
        if ($processing === 'done') {
            $status = 'done';
        } elseif ($processing === 'failed' || $workerStatus === 'REJECTED' || $businessStatus === 'rejected') {
            $status = 'failed';
        } elseif ($processing === 'claimed' || $processing === 'processing') {
            $status = 'processing';
        } elseif ($workerStatus === 'PENDING' && $businessStatus !== 'approved') {
            $status = 'waiting_approval';
        } else {
            $status = 'pending';
        }

        $pdf = [
            'status' => $status,
            'job_id' => isset($worker['job_id']) ? (string) $worker['job_id'] : '',
            'worker_prescription_id' => isset($worker['prescription_id']) ? (string) $worker['prescription_id'] : '',
            'worker_status' => $workerStatus !== '' ? $workerStatus : 'PENDING',
            'processing_status' => $status === 'waiting_approval'
                ? 'waiting_approval'
                : ($processing !== '' ? $processing : 'pending'),
            'verify_token' => isset($row['verify_token']) && is_scalar($row['verify_token']) ? (string) $row['verify_token'] : '',
            'verify_code' => isset($row['verify_code']) && is_scalar($row['verify_code']) ? (string) $row['verify_code'] : '',
            's3_ready' => false,
            'can_download' => false,
            'download_url' => '',
            'expires_in' => 0,
            'last_error_code' => null,
            'last_error_message' => null,
        ];

        if ($status === 'waiting_approval') {
            $pdf['message'] = 'En attente de validation médecin.';
        } elseif ($status === 'pending') {
            $pdf['message'] = ($businessStatus === 'approved' || $workerStatus === 'APPROVED')
                ? 'PDF en file d’attente.'
                : 'En attente de validation médecin.';
        } elseif ($status === 'processing') {
            $pdf['message'] = 'Génération du PDF en cours.';
        } elseif ($status === 'failed') {
            $pdf['message'] = 'Le PDF n’est pas disponible pour cette ordonnance.';
            $pdf['last_error_code'] = isset($worker['last_error_code']) && is_scalar($worker['last_error_code']) && (string) $worker['last_error_code'] !== ''
                ? (string) $worker['last_error_code']
                : ($workerStatus === 'REJECTED' ? 'rejected' : 'worker_failed');
            $pdf['last_error_message'] = isset($worker['last_error_message_safe']) && is_scalar($worker['last_error_message_safe']) && (string) $worker['last_error_message_safe'] !== ''
                ? (string) $worker['last_error_message_safe']
                : ($workerStatus === 'REJECTED'
                    ? 'L’ordonnance a été rejetée.'
                    : 'Le Worker a signalé un échec de génération.');
        }

        if ($status === 'done') {
            if ($s3KeyRef !== '') {
                $presigned = $this->build_presigned_s3_url_from_job([
                    'job_id' => isset($worker['job_id']) ? (string) $worker['job_id'] : (string) $prescription_id,
                    's3_key_ref' => $s3KeyRef,
                    's3_bucket' => $s3Bucket,
                    's3_region' => $s3Region,
                    'artifact_size_bytes' => $artifactSizeBytes,
                    'artifact_content_type' => $artifactContentType,
                ], 300);

                if (!is_wp_error($presigned) && is_string($presigned) && $presigned !== '') {
                    $pdf['s3_ready'] = true;
                    $pdf['can_download'] = true;
                    $pdf['download_url'] = $presigned;
                    $pdf['expires_in'] = 300;
                    $pdf['message'] = 'Validation enregistrée. PDF disponible.';
                } else {
                    $pdf['message'] = 'PDF généré mais lien de téléchargement indisponible.';
                    $pdf['last_error_code'] = is_wp_error($presigned) ? $presigned->get_error_code() : 's3_link_unavailable';
                    $pdf['last_error_message'] = is_wp_error($presigned) ? $presigned->get_error_message() : 'Le lien de téléchargement n’a pas pu être généré.';
                }
            } else {
                $pdf['message'] = 'PDF généré mais lien de téléchargement indisponible.';
                $pdf['last_error_code'] = 's3_key_missing';
                $pdf['last_error_message'] = 'La clé S3 du PDF n’a pas encore été synchronisée.';
            }
        }

        return $pdf;
    }

    /**
     * @param array<string, mixed> $params
     * @return array{first_name:string,last_name:string,full_name:string,birth_date:string}
     */
    protected function extract_patient_identity_from_params(array $params): array
    {
        $patient = isset($params['patient']) && is_array($params['patient']) ? $params['patient'] : [];

        $firstName = $this->sanitize_person_name_token((string) ($patient['firstName'] ?? $patient['first_name'] ?? ''));
        $lastName = $this->sanitize_person_name_token((string) ($patient['lastName'] ?? $patient['last_name'] ?? ''));
        $fullName = $this->sanitize_full_name_string((string) ($patient['fullname'] ?? $patient['fullName'] ?? ''));
        $birthDate = trim((string) ($patient['birthdate'] ?? $patient['birthDate'] ?? ''));

        if ($fullName === '' && ($firstName !== '' || $lastName !== '')) {
            $fullName = trim($firstName . ' ' . $lastName);
        }

        if (($firstName === '' || $lastName === '') && $fullName !== '') {
            [$splitFirstName, $splitLastName] = $this->split_fullname_for_worker($fullName);
            if ($firstName === '') {
                $firstName = $splitFirstName;
            }
            if ($lastName === '') {
                $lastName = $splitLastName;
            }
        }

        $firstName = $this->sanitize_person_name_token($firstName);
        $lastName = $this->sanitize_person_name_token($lastName);
        $fullName = ($firstName !== '' || $lastName !== '') ? trim($firstName . ' ' . $lastName) : $fullName;

        return [
            'first_name' => $firstName,
            'last_name' => $lastName,
            'full_name' => $fullName,
            'birth_date' => $birthDate,
        ];
    }

    /**
     * @return array{0:string,1:string}
     */
    protected function split_fullname_for_worker(string $fullname): array
    {
        $clean = $this->sanitize_full_name_string($fullname);
        if ($clean === '') {
            return ['', ''];
        }

        $parts = preg_split('/\s+/u', $clean) ?: [];
        $parts = array_values(array_filter(array_map('trim', $parts), static fn (string $part): bool => $part !== ''));
        if ($parts === []) {
            return ['', ''];
        }
        if (count($parts) < 2) {
            return [$this->sanitize_person_name_token($parts[0] ?? ''), ''];
        }

        $firstName = $this->sanitize_person_name_token((string) array_shift($parts));
        $lastName = $this->sanitize_person_name_token(trim(implode(' ', $parts)));

        return [$firstName, $lastName];
    }

    protected function sanitize_full_name_string(string $value): string
    {
        $clean = trim(preg_replace('/\s+/u', ' ', wp_strip_all_tags($value, true)) ?? '');
        if ($clean === '' || $this->looks_like_email_string($clean)) {
            return '';
        }

        return $clean;
    }

    protected function sanitize_person_name_token(string $value): string
    {
        $clean = trim(preg_replace('/\s+/u', ' ', wp_strip_all_tags($value, true)) ?? '');
        if ($clean === '' || $this->looks_like_email_string($clean)) {
            return '';
        }

        return $clean;
    }

    protected function looks_like_email_string(string $value): bool
    {
        $value = trim($value);
        if ($value === '' || strpos($value, '@') === false) {
            return false;
        }

        return (bool) is_email($value);
    }

    /**
     * @return array<string, mixed>|null
     */
    protected function resolve_doctor_payload_from_create_params(array $params): ?array
    {
        $doctorUserId = 0;

        foreach (['doctor_user_id', 'doctor_id', 'assigned_doctor_id'] as $key) {
            if (isset($params[$key]) && is_numeric($params[$key])) {
                $doctorUserId = max($doctorUserId, (int) $params[$key]);
            }
        }

        if ($doctorUserId < 1 && AccessPolicy::is_doctor()) {
            $doctorUserId = (int) get_current_user_id();
        }

        if ($doctorUserId < 1) {
            return null;
        }

        try {
            return $this->get_job_dispatcher()->buildDoctorPayloadFromUserId($doctorUserId);
        } catch (\Throwable $e) {
            return null;
        }
    }

    /**
     * @return array{kind:string,actor:array{role:string,wp_user_id:int}}|WP_Error
     */
    protected function build_read_actor_context(): array|WP_Error
    {
        $current_user_id = (int) get_current_user_id();
        if ($current_user_id < 1) {
            return new WP_Error('sosprescription_auth_required', 'Connexion requise.', ['status' => 401]);
        }

        if (AccessPolicy::is_admin() || AccessPolicy::is_doctor()) {
            return [
                'kind' => 'doctor',
                'actor' => [
                    'role' => 'DOCTOR',
                    'wp_user_id' => $current_user_id,
                ],
            ];
        }

        return [
            'kind' => 'patient',
            'actor' => [
                'role' => 'PATIENT',
                'wp_user_id' => $current_user_id,
            ],
        ];
    }

    /**
     * @param array<int, array<string, mixed>> $rows
     * @return array<int, array<string, mixed>>
     */
    protected function swap_worker_row_ids_with_local_ids(array $rows, ?string $reqId = null): array
    {
        $uids = [];
        foreach ($rows as $index => $row) {
            if (!is_array($row)) {
                continue;
            }

            $uid = isset($row['uid']) && is_scalar($row['uid']) ? trim((string) $row['uid']) : '';
            if ($uid === '') {
                continue;
            }

            $uids[] = $uid;
        }

        try {
            $localIdsByUid = $this->find_local_prescription_ids_by_uid($uids);
        } catch (\Throwable $e) {
            $localIdsByUid = [];
        }

        foreach ($rows as $index => $row) {
            if (!is_array($row)) {
                continue;
            }

            $uid = isset($row['uid']) && is_scalar($row['uid']) ? trim((string) $row['uid']) : '';
            $workerId = $this->extract_worker_prescription_id_from_worker_row($row);

            if ($uid === '') {
                continue;
            }

            try {
                if (!isset($localIdsByUid[$uid])) {
                    $localId = $this->ensure_local_prescription_stub_for_worker_row($row);
                    if ($localId > 0) {
                        $localIdsByUid[$uid] = $localId;
                    }
                }

                if (!isset($localIdsByUid[$uid])) {
                    continue;
                }

                $rows[$index]['id'] = (int) $localIdsByUid[$uid];
            } catch (\Throwable $e) {
            }
        }

        return $rows;
    }

    /**
     * @param array<string, mixed> $row
     */
    protected function ensure_local_prescription_stub_for_worker_row(array $row): int
    {
        $uid = isset($row['uid']) && is_scalar($row['uid']) ? trim((string) $row['uid']) : '';
        if ($uid === '') {
            return 0;
        }

        $existingId = $this->find_local_prescription_id_by_uid($uid);
        if ($existingId > 0) {
            return $existingId;
        }

        $workerPrescriptionId = $this->extract_worker_prescription_id_from_worker_row($row);
        $status = $this->normalize_local_stub_status($row['status'] ?? null);

        return $this->insert_local_prescription_stub($uid, $status, $workerPrescriptionId);
    }

    protected function find_local_prescription_id_by_uid(string $uid): int
    {
        $uid = trim($uid);
        if ($uid === '') {
            return 0;
        }

        $mapped = $this->find_local_prescription_ids_by_uid([$uid]);
        return isset($mapped[$uid]) ? (int) $mapped[$uid] : 0;
    }

    /**
     * @param array<string, mixed> $row
     */
    protected function extract_worker_prescription_id_from_worker_row(array $row): string
    {
        $candidate = isset($row['worker_prescription_id']) && is_scalar($row['worker_prescription_id'])
            ? trim((string) $row['worker_prescription_id'])
            : '';
        if ($this->is_valid_worker_prescription_id($candidate)) {
            return $candidate;
        }

        $candidate = isset($row['id']) && is_scalar($row['id']) ? trim((string) $row['id']) : '';
        if ($this->is_valid_worker_prescription_id($candidate)) {
            return $candidate;
        }

        $payload = $this->normalize_worker_payload($row['payload'] ?? []);
        $payloadNode = $this->normalize_worker_payload($payload['payload'] ?? []);
        $worker = $this->normalize_worker_payload($payloadNode['worker'] ?? ($payload['worker'] ?? []));
        $candidate = isset($worker['prescription_id']) && is_scalar($worker['prescription_id'])
            ? trim((string) $worker['prescription_id'])
            : '';

        return $this->is_valid_worker_prescription_id($candidate) ? $candidate : '';
    }

    protected function insert_local_prescription_stub(string $uid, string $status, string $workerPrescriptionId): int
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
            $insertId = (int) $this->wpdb->insert_id;
            return $insertId;
        }

        $existingId = $this->find_local_prescription_id_by_uid($uid);
        if ($existingId > 0) {
            return $existingId;
        }

        return 0;
    }

    protected function build_local_stub_payload_json(string $workerPrescriptionId): string
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

    protected function normalize_local_stub_status($value): string
    {
        if (!is_scalar($value)) {
            return 'pending';
        }

        $status = strtolower(trim((string) $value));
        return $status !== '' ? $status : 'pending';
    }

    /**
     * @param array<int, string> $uids
     * @return array<string, int>
     */
    protected function find_local_prescription_ids_by_uid(array $uids): array
    {
        if ($uids === [] || !$this->prescription_table_has_column('uid')) {
            return [];
        }

        $uids = array_values(array_unique(array_filter(array_map(static function ($value): string {
            return is_string($value) ? trim($value) : '';
        }, $uids), static fn (string $uid): bool => $uid !== '')));
        if ($uids === []) {
            return [];
        }

        $table = $this->wpdb->prefix . 'sosprescription_prescriptions';
        $placeholders = implode(',', array_fill(0, count($uids), '%s'));
        $sql = $this->wpdb->prepare(
            "SELECT id, uid FROM `{$table}` WHERE uid IN ({$placeholders})",
            $uids
        );

        $rows = $this->wpdb->get_results($sql, ARRAY_A);
        if (!is_array($rows)) {
            return [];
        }

        $out = [];
        foreach ($rows as $row) {
            if (!is_array($row)) {
                continue;
            }
            $uid = isset($row['uid']) && is_scalar($row['uid']) ? trim((string) $row['uid']) : '';
            $id = isset($row['id']) && is_numeric($row['id']) ? (int) $row['id'] : 0;
            if ($uid === '' || $id < 1) {
                continue;
            }
            $out[$uid] = $id;
        }

        return $out;
    }

    /**
     * @return array<string, mixed>|null
     */
    protected function find_local_prescription_stub_by_id(int $id): ?array
    {
        $id = (int) $id;
        if ($id < 1) {
            return null;
        }

        $table = $this->wpdb->prefix . 'sosprescription_prescriptions';
        $select = ['id'];
        if ($this->prescription_table_has_column('uid')) {
            $select[] = 'uid';
        }
        if ($this->prescription_table_has_column('payload_json')) {
            $select[] = 'payload_json';
        }

        $sql = $this->wpdb->prepare(
            sprintf('SELECT %s FROM `%s` WHERE id = %%d LIMIT 1', implode(', ', $select), $table),
            $id
        );
        $row = $this->wpdb->get_row($sql, ARRAY_A);

        return is_array($row) ? $row : null;
    }

    /**
     * @param array<string, mixed> $localRow
     * @param array{kind:string,actor:array{role:string,wp_user_id:int}} $actorContext
     */
    protected function resolve_worker_prescription_id_for_local_stub(array $localRow, array $actorContext, string $req_id): string
    {
        $worker = $this->extract_worker_shadow_state($localRow);
        $workerPrescriptionId = isset($worker['prescription_id']) && is_scalar($worker['prescription_id'])
            ? trim((string) $worker['prescription_id'])
            : '';

        if ($this->is_valid_worker_prescription_id($workerPrescriptionId)) {
            return $workerPrescriptionId;
        }

        $uid = isset($localRow['uid']) && is_scalar($localRow['uid']) ? trim((string) $localRow['uid']) : '';
        if ($uid === '') {
            return '';
        }

        return $this->find_worker_prescription_id_by_uid($uid, $actorContext, $req_id);
    }

    /**
     * @param array{kind:string,actor:array{role:string,wp_user_id:int}} $actorContext
     */
    protected function find_worker_prescription_id_by_uid(string $uid, array $actorContext, string $req_id): string
    {
        $uid = trim($uid);
        if ($uid === '') {
            return '';
        }

        $path = $actorContext['kind'] === 'doctor'
            ? '/api/v2/doctor/inbox'
            : '/api/v2/patient/prescriptions/query';
        $scope = $actorContext['kind'] === 'doctor'
            ? 'prescriptions_v1_worker_id_doctor_lookup'
            : 'prescriptions_v1_worker_id_patient_lookup';

        $limit = 200;
        $offset = 0;
        for ($page = 0; $page < 10; $page++) {
            $workerPayload = $this->get_worker_api_client()->postSignedJson(
                $path,
                [
                    'actor' => $actorContext['actor'],
                    'filters' => [
                        'limit' => $limit,
                        'offset' => $offset,
                    ],
                ],
                $req_id,
                $scope
            );

            $rows = $this->extract_worker_rows_from_payload($workerPayload);
            if ($rows === []) {
                return '';
            }

            foreach ($rows as $row) {
                if (!is_array($row)) {
                    continue;
                }
                $rowUid = isset($row['uid']) && is_scalar($row['uid']) ? trim((string) $row['uid']) : '';
                if ($rowUid !== $uid) {
                    continue;
                }

                $candidate = $this->extract_worker_prescription_id_from_worker_row($row);
                if ($this->is_valid_worker_prescription_id($candidate)) {
                    return $candidate;
                }
            }

            if (count($rows) < $limit) {
                return '';
            }

            $offset += $limit;
        }

        return '';
    }

    /**
     * @param mixed $payload
     * @return array<string, mixed>
     */
    protected function normalize_worker_payload($payload): array
    {
        if (is_array($payload)) {
            $encoded = wp_json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            if (is_string($encoded) && $encoded !== '') {
                $decoded = json_decode($encoded, true);
                if (is_array($decoded)) {
                    return $decoded;
                }
            }

            return $payload;
        }

        if (is_object($payload)) {
            $encoded = wp_json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
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

    /**
     * @param mixed $payload
     * @return array<int, array<string, mixed>>
     */
    protected function extract_worker_rows_from_payload($payload): array
    {
        $normalized = $this->normalize_worker_payload($payload);
        if ($normalized === []) {
            return [];
        }

        $candidates = [];

        foreach (['rows', 'items', 'prescriptions', 'results'] as $key) {
            if (isset($normalized[$key]) && is_array($normalized[$key])) {
                $candidates[] = $normalized[$key];
            }
        }

        $data = isset($normalized['data']) ? $this->normalize_worker_payload($normalized['data']) : [];
        foreach (['rows', 'items', 'prescriptions', 'results'] as $key) {
            if (isset($data[$key]) && is_array($data[$key])) {
                $candidates[] = $data[$key];
            }
        }
        if (array_is_list($data)) {
            $candidates[] = $data;
        }

        $payloadNode = isset($normalized['payload']) ? $this->normalize_worker_payload($normalized['payload']) : [];
        foreach (['rows', 'items', 'prescriptions', 'results'] as $key) {
            if (isset($payloadNode[$key]) && is_array($payloadNode[$key])) {
                $candidates[] = $payloadNode[$key];
            }
        }
        if (array_is_list($payloadNode)) {
            $candidates[] = $payloadNode;
        }

        if (array_is_list($normalized)) {
            $candidates[] = $normalized;
        }

        foreach ($candidates as $candidate) {
            if (!is_array($candidate)) {
                continue;
            }

            $rows = [];
            foreach ($candidate as $index => $row) {
                try {
                    $normalizedRow = $this->normalize_worker_payload($row);
                    if ($normalizedRow !== []) {
                        $rows[] = $normalizedRow;
                    } elseif (is_array($row)) {
                        $rows[] = $row;
                    }
                } catch (\Throwable $e) {
                }
            }

            if ($rows !== []) {
                return $rows;
            }
        }

        return [];
    }

    /**
     * @param mixed $payload
     * @return array<string, mixed>|null
     */
    protected function extract_worker_prescription_from_payload($payload): ?array
    {
        $normalized = $this->normalize_worker_payload($payload);
        $candidates = [];

        if (isset($normalized['prescription'])) {
            $candidates[] = $normalized['prescription'];
        }

        $data = isset($normalized['data']) ? $this->normalize_worker_payload($normalized['data']) : [];
        if (isset($data['prescription'])) {
            $candidates[] = $data['prescription'];
        }

        $payloadNode = isset($normalized['payload']) ? $this->normalize_worker_payload($normalized['payload']) : [];
        if (isset($payloadNode['prescription'])) {
            $candidates[] = $payloadNode['prescription'];
        }

        $candidates[] = $normalized;

        foreach ($candidates as $candidate) {
            $normalizedCandidate = $this->normalize_worker_payload($candidate);
            if ($normalizedCandidate === []) {
                continue;
            }

            if (isset($normalizedCandidate['uid']) || isset($normalizedCandidate['status']) || isset($normalizedCandidate['worker'])) {
                return $normalizedCandidate;
            }
        }

        return null;
    }

    /**
     * @param mixed $payload
     */
    protected function to_proxy_response($payload, int $status, string $reqId): WP_REST_Response
    {
        $normalized = is_array($payload) ? $this->sanitize_proxy_value($payload) : [];
        $isList = array_is_list($normalized);

        if (!$isList) {
            if (!isset($normalized['req_id']) || !is_scalar($normalized['req_id']) || trim((string) $normalized['req_id']) === '') {
                $normalized['req_id'] = $reqId;
            }
        }

        $response = new WP_REST_Response($normalized, $status);
        $response->header('X-SOSPrescription-Request-ID', $isList ? $reqId : (string) $normalized['req_id']);
        $response->header('Cache-Control', 'no-store, no-cache, must-revalidate');
        $response->header('Pragma', 'no-cache');
        $response->header('Expires', '0');

        return $response;
    }

    protected function get_worker_api_client(): WorkerApiClient
    {
        if ($this->worker_api_client instanceof WorkerApiClient) {
            return $this->worker_api_client;
        }

        $siteId = $this->get_worker_site_id();
        $logger = new NdjsonLogger('web', $siteId, $this->get_env_or_constant('SOSPRESCRIPTION_ENV', 'prod'));
        $this->worker_api_client = WorkerApiClient::fromEnv($logger, $siteId);

        return $this->worker_api_client;
    }

    protected function get_worker_site_id(): string
    {
        $siteId = $this->get_env_or_constant('ML_SITE_ID');
        if ($siteId === '') {
            $siteId = 'mls1';
        }

        return $siteId;
    }

    protected function get_worker_callback_verifier(): Mls1Verifier
    {
        $siteId = $this->get_worker_site_id();
        $logger = new NdjsonLogger('web', $siteId, $this->get_env_or_constant('SOSPRESCRIPTION_ENV', 'prod'));
        return Mls1Verifier::fromEnv(new NonceStore($this->wpdb, $siteId), $logger);
    }

    protected function find_shadow_prescription_id_by_worker_prescription_id(string $workerPrescriptionId): int
    {
        $workerPrescriptionId = trim($workerPrescriptionId);
        if (!$this->is_valid_worker_prescription_id($workerPrescriptionId)) {
            return 0;
        }

        $table = $this->wpdb->prefix . 'sosprescription_prescriptions';

        $id = $this->wpdb->get_var($this->wpdb->prepare(
            "SELECT id FROM `{$table}` WHERE JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.worker.prescription_id')) = %s LIMIT 1",
            $workerPrescriptionId
        ));

        if (is_numeric($id) && (int) $id > 0) {
            return (int) $id;
        }

        $like = '%"prescription_id":"' . $this->wpdb->esc_like($workerPrescriptionId) . '"%';
        $id = $this->wpdb->get_var($this->wpdb->prepare(
            "SELECT id FROM `{$table}` WHERE payload_json LIKE %s LIMIT 1",
            $like
        ));

        return is_numeric($id) && (int) $id > 0 ? (int) $id : 0;
    }

    protected function normalize_worker_callback_status($value): string
    {
        $status = strtoupper(trim((string) $value));
        if (in_array($status, ['DONE', 'FAILED', 'PENDING', 'CLAIMED', 'APPROVED', 'REJECTED'], true)) {
            return $status;
        }

        return 'PENDING';
    }

    protected function normalize_worker_processing_status($value, string $fallbackStatus = 'PENDING'): string
    {
        $processing = strtolower(trim((string) $value));
        if (in_array($processing, ['done', 'failed', 'pending', 'claimed', 'waiting_approval'], true)) {
            return $processing;
        }

        $fallback = strtoupper(trim($fallbackStatus));
        if ($fallback === 'DONE') {
            return 'done';
        }
        if ($fallback === 'FAILED' || $fallback === 'REJECTED') {
            return 'failed';
        }
        if ($fallback === 'CLAIMED') {
            return 'claimed';
        }

        return 'pending';
    }

    protected function is_valid_worker_prescription_id(string $value): bool
    {
        return preg_match('/^[A-Fa-f0-9\-]{36}$/', trim($value)) === 1;
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
        $siteId = $this->get_worker_site_id();
        $logger = new NdjsonLogger('web', $siteId, $this->get_env_or_constant('SOSPRESCRIPTION_ENV', 'prod'));

        $this->job_dispatcher = new JobDispatcher(
            $this->wpdb,
            $logger,
            $siteId,
            $secret,
            $kid !== '' ? $kid : null
        );

        return $this->job_dispatcher;
    }

    /**
     * @return array<string, mixed>|WP_Error
     */
    protected function ensure_verification_payload(int $prescription_id): array|WP_Error
    {
        $prescription_id = (int) $prescription_id;
        if ($prescription_id < 1) {
            return new WP_Error('sosprescription_bad_id', 'ID invalide.', ['status' => 400]);
        }

        $table = $this->wpdb->prefix . 'sosprescription_prescriptions';
        $row = $this->wpdb->get_row(
            $this->wpdb->prepare(
                "SELECT id, verify_token, verify_code FROM `{$table}` WHERE id = %d LIMIT 1",
                $prescription_id
            ),
            ARRAY_A
        );

        if (!is_array($row)) {
            return new WP_Error('sosprescription_prescription_not_found', 'Prescription introuvable.', ['status' => 404]);
        }

        $verifyToken = isset($row['verify_token']) ? trim((string) $row['verify_token']) : '';
        $verifyCode = isset($row['verify_code']) ? trim((string) $row['verify_code']) : '';

        if ($verifyToken !== '' && $verifyCode !== '') {
            return [
                'verify_token' => $verifyToken,
                'verify_code' => $verifyCode,
            ];
        }

        if ($verifyToken === '') {
            $verifyToken = $this->generate_verify_token();
        }
        if ($verifyCode === '') {
            $verifyCode = $this->generate_verify_code();
        }

        $updated = $this->wpdb->update(
            $table,
            [
                'verify_token' => $verifyToken,
                'verify_code' => $verifyCode,
                'updated_at' => current_time('mysql'),
            ],
            ['id' => $prescription_id],
            ['%s', '%s', '%s'],
            ['%d']
        );

        if ($updated === false) {
            return new WP_Error(
                'sosprescription_verification_update_failed',
                'Impossible de préparer les données de vérification.',
                ['status' => 500]
            );
        }

        return [
            'verify_token' => $verifyToken,
            'verify_code' => $verifyCode,
        ];
    }

    protected function format_shadow_phase_error(WP_Error $error): string
    {
        $code = trim((string) $error->get_error_code());
        $message = trim((string) $error->get_error_message());

        if ($code !== '' && $message !== '') {
            return $code . ': ' . $message;
        }

        if ($message !== '') {
            return $message;
        }

        if ($code !== '') {
            return $code;
        }

        return 'Erreur lors de la synchronisation du shadow record.';
    }

    protected function raw_unprocessable_response(string $message, string $req_id): WP_REST_Response
    {
        $message = $this->sanitize_unprocessable_message($message);
        if ($message === '') {
            $message = 'Erreur lors de la création de la demande.';
        }

        return new WP_REST_Response([
            'ok' => false,
            'message' => $message,
            'req_id' => $req_id,
        ], 422);
    }

    protected function raw_exact_unprocessable_response(string $message, string $req_id): WP_REST_Response
    {
        $message = trim($message);
        if ($message === '') {
            $message = 'Erreur lors de la création de la demande.';
        }

        return new WP_REST_Response([
            'ok' => false,
            'message' => $message,
            'req_id' => $req_id,
        ], 422);
    }

    protected function sanitize_unprocessable_message(string $message): string
    {
        return trim((string) str_ireplace(
            ['Worker HTTP', 'Requête bloquée par WordPress', 'détail :', 'detail :'],
            ['Serveur distant', 'Erreur de connexion réseau', 'Info:', 'Info:'],
            $message
        ));
    }

    protected function normalize_shadow_flow_key(string $flow): string
    {
        $normalized = strtolower(trim($flow));
        if ($normalized === '' || $normalized === 'ro_proof' || $normalized === 'renewal' || $normalized === 'renouvellement') {
            return 'renewal';
        }

        if ($normalized === 'depannage_no_proof' || $normalized === 'depannage' || $normalized === 'depannage-sos' || $normalized === 'sos') {
            return 'depannage';
        }

        return $normalized;
    }

    protected function prescription_table_has_column(string $column): bool
    {
        $columns = $this->get_prescription_table_columns();
        return isset($columns[$column]);
    }

    /**
     * @return array<string, true>
     */
    protected function get_prescription_table_columns(): array
    {
        if (is_array($this->prescription_table_columns_cache)) {
            return $this->prescription_table_columns_cache;
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

        $this->prescription_table_columns_cache = $columns;

        return $columns;
    }

    protected function generate_verify_token(): string
    {
        try {
            return rtrim(strtr(base64_encode(random_bytes(24)), '+/', '-_'), '=');
        } catch (\Throwable $e) {
            return wp_generate_password(32, false, false);
        }
    }

    protected function generate_verify_code(): string
    {
        try {
            return str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
        } catch (\Throwable $e) {
            return str_pad((string) wp_rand(0, 999999), 6, '0', STR_PAD_LEFT);
        }
    }

    private static function str_len(string $value): int
    {
        return function_exists('mb_strlen') ? (int) mb_strlen($value, 'UTF-8') : strlen($value);
    }
}
