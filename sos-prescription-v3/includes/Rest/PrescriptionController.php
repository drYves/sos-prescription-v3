<?php // includes/Rest/PrescriptionController.php
declare(strict_types=1);

namespace SOSPrescription\Rest;

use SOSPrescription\Repositories\JobRepository;
use SOSPrescription\Repositories\PrescriptionRepository;
use SOSPrescription\Services\AccessPolicy;
use SOSPrescription\Services\Audit;
use SOSPrescription\Services\RestGuard;
use SOSPrescription\Services\StripeConfig;
use SOSPrescription\Services\Turnstile;
use SOSPrescription\Services\UidGenerator;
use SOSPrescription\Core\JobDispatcher;
use SOSPrescription\Core\NdjsonLogger;
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

    /** @var string */
    protected $namespace = 'sosprescription/v1';

    /** @var string */
    protected $rest_base = 'prescriptions';

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
        $params = $this->request_data($request);

        $patient = isset($params['patient']) && is_array($params['patient']) ? $params['patient'] : [];
        $fullname = trim((string) ($patient['fullname'] ?? ''));
        $birthdate = trim((string) ($patient['birthdate'] ?? ''));
        $note = isset($patient['note']) ? trim((string) $patient['note']) : null;
        if ($note === '') {
            $note = null;
        }

        if (self::str_len($fullname) < 2) {
            return new WP_Error('sosprescription_patient_name_required', 'Nom du patient manquant.', ['status' => 400]);
        }

        if ($birthdate === '') {
            return new WP_Error('sosprescription_patient_birthdate_required', 'Date de naissance manquante.', ['status' => 400]);
        }

        $items = isset($params['items']) && is_array($params['items']) ? array_values($params['items']) : [];
        if ($items === []) {
            return new WP_Error('sosprescription_items_required', 'Au moins un médicament est requis.', ['status' => 400]);
        }

        if (Turnstile::is_enabled()) {
            $token = trim((string) ($params['turnstileToken'] ?? ($params['turnstile_token'] ?? '')));
            $remote_ip = isset($_SERVER['REMOTE_ADDR']) ? (string) wp_unslash($_SERVER['REMOTE_ADDR']) : null;
            $turnstile = Turnstile::verify_token($token, $remote_ip ?: null);
            if (is_wp_error($turnstile)) {
                return $turnstile;
            }
        }

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

        $evidence_file_ids = isset($params['evidence_file_ids']) && is_array($params['evidence_file_ids'])
            ? array_values(array_filter(array_map('intval', $params['evidence_file_ids']), static fn ($value): bool => $value > 0))
            : [];

        $payload = [
            'patient' => [
                'fullname' => $fullname,
                'birthdate' => $birthdate,
                'note' => $note,
            ],
            'consent' => isset($params['consent']) && is_array($params['consent']) ? $params['consent'] : null,
            'attestation_no_proof' => !empty($params['attestation_no_proof']),
        ];

        $uid = UidGenerator::generate(10);
        $stripe = StripeConfig::get();
        $initial_status = !empty($stripe['enabled']) ? 'payment_pending' : 'pending';

        $result = $this->prescriptions->create(
            (int) get_current_user_id(),
            $uid,
            $payload,
            $items,
            $flow,
            $priority,
            $client_request_id,
            $evidence_file_ids,
            $initial_status
        );

        if (isset($result['error'])) {
            return new WP_Error(
                'sosprescription_prescription_create_failed',
                isset($result['message']) && is_string($result['message']) && $result['message'] !== ''
                    ? $result['message']
                    : 'Erreur interne lors de la création de la demande.',
                ['status' => 500]
            );
        }

        if (isset($result['id'])) {
            Audit::log('prescription_create', 'prescription', (int) $result['id'], (int) $result['id'], [
                'uid' => (string) ($result['uid'] ?? $uid),
                'flow' => $flow,
                'priority' => $priority,
            ]);
        }

        return rest_ensure_response($result);
    }

    public function list(WP_REST_Request $request)
    {
        $status = trim((string) $request->get_param('status'));
        $limit = max(1, min(200, (int) ($request->get_param('limit') ?? 100)));
        $offset = max(0, (int) ($request->get_param('offset') ?? 0));
        $current_user_id = (int) get_current_user_id();

        if ($current_user_id < 1) {
            return new WP_Error('sosprescription_auth_required', 'Connexion requise.', ['status' => 401]);
        }

        if (AccessPolicy::is_admin()) {
            $rows = $this->prescriptions->list(null, $status !== '' ? $status : null, $limit, $offset);
        } elseif (AccessPolicy::is_doctor()) {
            $rows = $this->prescriptions->list_for_doctor($current_user_id, $status !== '' ? $status : null, $limit, $offset);
        } else {
            $rows = $this->prescriptions->list($current_user_id, $status !== '' ? $status : null, $limit, $offset);
        }

        return rest_ensure_response($rows);
    }

    public function get_one(WP_REST_Request $request)
    {
        $id = (int) $request->get_param('id');
        if ($id < 1) {
            return new WP_Error('sosprescription_bad_id', 'ID invalide.', ['status' => 400]);
        }

        $row = $this->prescriptions->get($id);
        if (!is_array($row)) {
            return new WP_Error('sosprescription_not_found', 'Ordonnance introuvable.', ['status' => 404]);
        }

        if (!AccessPolicy::can_current_user_access_prescription_row($row)) {
            return new WP_Error('sosprescription_forbidden', 'Accès refusé.', ['status' => 403]);
        }

        return rest_ensure_response($row);
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
        $reason = trim((string) ($request->get_param('reason') ?? ''));
        if ($reason === '') {
            $reason = null;
        }

        if ($id < 1 || !in_array($decision, ['approved', 'rejected'], true)) {
            return new WP_Error('sosprescription_bad_request', 'Paramètres invalides.', ['status' => 400]);
        }

        $doctor_id = (int) get_current_user_id();
        if ($doctor_id < 1) {
            return new WP_Error('sosprescription_auth_required', 'Connexion requise.', ['status' => 401]);
        }

        $ok = $this->prescriptions->decide($id, $doctor_id, $decision, $reason);
        if (!$ok) {
            return new WP_Error('sosprescription_decision_conflict', 'Décision impossible pour cette ordonnance.', ['status' => 409]);
        }

        $row = $this->prescriptions->get($id);
        if (!is_array($row)) {
            return new WP_Error('sosprescription_not_found', 'Ordonnance introuvable.', ['status' => 404]);
        }

        if ($decision === 'approved') {
            $req_id = $this->build_req_id();
            $dispatch = $this->dispatch_pdf_generation($id, 'doctor_approval', $req_id);

            if (is_wp_error($dispatch)) {
                return new WP_REST_Response([
                    'id' => $id,
                    'decision' => $decision,
                    'req_id' => $req_id,
                    'prescription' => $row,
                    'pdf' => $this->build_degraded_pdf_state($dispatch, $req_id),
                    'message' => 'Validation enregistrée. PDF temporairement indisponible.',
                ], 202);
            }

            $pdf = isset($dispatch['pdf']) && is_array($dispatch['pdf']) ? $dispatch['pdf'] : ['status' => 'pending'];
            $pdf = $this->enrich_pdf_state_for_response($id, $pdf);

            $response = [
                'id' => $id,
                'decision' => $decision,
                'req_id' => $req_id,
                'prescription' => $row,
                'verification' => isset($dispatch['verification']) && is_array($dispatch['verification']) ? $dispatch['verification'] : [],
                'dispatch' => isset($dispatch['dispatch']) && is_array($dispatch['dispatch']) ? $dispatch['dispatch'] : [],
                'job_payload' => isset($dispatch['job_payload']) && is_array($dispatch['job_payload']) ? $dispatch['job_payload'] : [],
                'pdf' => $pdf,
                'message' => $this->message_for_pdf_state($pdf),
            ];

            if (!empty($pdf['download_url']) && is_string($pdf['download_url'])) {
                $response['download_url'] = $pdf['download_url'];
            }
            if (!empty($pdf['expires_in'])) {
                $response['expires_in'] = (int) $pdf['expires_in'];
            }

            return new WP_REST_Response($response, ($pdf['status'] ?? 'pending') === 'done' ? 200 : 202);
        }

        return new WP_REST_Response([
            'id' => $id,
            'decision' => $decision,
            'prescription' => $row,
            'pdf' => $this->jobs->get_public_state_for_rx_id($id),
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

        $pdf = $this->jobs->get_public_state_for_rx_id($prescription_id);
        $pdf = $this->enrich_pdf_state_for_response($prescription_id, is_array($pdf) ? $pdf : []);

        return new WP_REST_Response([
            'prescription_id' => $prescription_id,
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

        $done_job = $this->jobs->get_latest_done_by_rx_id($prescription_id);
        if (!empty($done_job)) {
            $download_url = $this->build_presigned_s3_url_from_job($done_job, 60);
            if (is_wp_error($download_url)) {
                $pdf = $this->build_pdf_error_state_from_job($done_job, $download_url);

                return new WP_REST_Response([
                    'prescription_id' => $prescription_id,
                    'pdf' => $pdf,
                    'message' => $pdf['last_error_message'],
                ], 200);
            }

            $pdf = $this->jobs->public_projection($done_job);
            $pdf['can_download'] = true;
            $pdf['download_url'] = $download_url;
            $pdf['expires_in'] = 60;
            $pdf['last_error_code'] = null;
            $pdf['last_error_message'] = null;

            return new WP_REST_Response([
                'prescription_id' => $prescription_id,
                'pdf' => $pdf,
                'download_url' => $download_url,
                'expires_in' => 60,
            ], 200);
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

        $pdf = $this->jobs->get_public_state_for_rx_id($prescription_id);
        $pdf = $this->enrich_pdf_state_for_response($prescription_id, is_array($pdf) ? $pdf : []);

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
            return 'req_' . bin2hex(random_bytes(8));
        } catch (\Throwable $e) {
            return 'req_' . md5((string) wp_rand() . microtime(true));
        }
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
        $download_url = isset($pdf['download_url']) ? (string) $pdf['download_url'] : '';

        if ($download_url !== '') {
            $pdf['can_download'] = true;
            if (!isset($pdf['expires_in'])) {
                $pdf['expires_in'] = 60;
            }
            return $pdf;
        }

        if ($status !== 'done') {
            return $pdf;
        }

        $done_job = $this->jobs->get_latest_done_by_rx_id($prescription_id);
        if (empty($done_job)) {
            return $pdf;
        }

        $presigned = $this->build_presigned_s3_url_from_job($done_job, 60);
        if (is_wp_error($presigned)) {
            return $this->build_pdf_error_state_from_job($done_job, $presigned, $pdf);
        }

        $pdf['status'] = 'done';
        $pdf['can_download'] = true;
        $pdf['s3_ready'] = true;
        $pdf['download_url'] = $presigned;
        $pdf['expires_in'] = 60;
        $pdf['last_error_code'] = null;
        $pdf['last_error_message'] = null;

        return $pdf;
    }

    /**
     * @param array<string, mixed> $job
     * @param array<string, mixed>|null $base_pdf
     * @return array<string, mixed>
     */
    protected function build_pdf_error_state_from_job(array $job, WP_Error $error, ?array $base_pdf = null): array
    {
        $pdf = is_array($base_pdf) ? $base_pdf : $this->jobs->public_projection($job);

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
    protected function dispatch_pdf_generation(int $prescription_id, string $source, ?string $req_id = null): array|WP_Error
    {
        $prescription_id = (int) $prescription_id;
        $req_id = is_string($req_id) && $req_id !== '' ? $req_id : $this->build_req_id();

        if ($prescription_id < 1) {
            return new WP_Error('sosprescription_bad_id', 'ID invalide.', ['status' => 400]);
        }

        $verification = $this->ensure_verification_payload($prescription_id);
        if (is_wp_error($verification)) {
            return $verification;
        }

        try {
            $dispatcher = $this->get_job_dispatcher();
            $result = $dispatcher->dispatch_pdf_generation($prescription_id, $req_id);
        } catch (\Throwable $e) {
            return new WP_Error(
                'sosprescription_pdf_dispatch_failed',
                'La mise en file du PDF a échoué.',
                [
                    'status' => 500,
                    'req_id' => $req_id,
                    'error' => $e->getMessage(),
                ]
            );
        }

        $pdf = $this->jobs->get_public_state_for_rx_id($prescription_id);
        $pdf = $this->enrich_pdf_state_for_response($prescription_id, is_array($pdf) ? $pdf : []);

        $dispatch_job_id = '';
        if (!empty($pdf['job_id']) && is_scalar($pdf['job_id'])) {
            $dispatch_job_id = (string) $pdf['job_id'];
        } elseif (!empty($result['job_id'])) {
            $dispatch_job_id = (string) $result['job_id'];
        }

        if ($dispatch_job_id !== '' && (empty($pdf['job_id']) || !is_scalar($pdf['job_id']))) {
            $pdf['job_id'] = $dispatch_job_id;
        }

        return [
            'ok' => true,
            'mode' => 'stateless',
            'site_id' => $this->jobs->get_site_id(),
            'req_id' => $req_id,
            'prescription_id' => $prescription_id,
            'verification' => [
                'verify_token' => (string) ($verification['verify_token'] ?? ''),
                'verify_code' => (string) ($verification['verify_code'] ?? ''),
            ],
            'dispatch' => [
                'action' => !empty($result['dedup']) ? 'reused' : 'created',
                'job_id' => $dispatch_job_id,
                'worker_job_id' => (string) ($result['job_id'] ?? ''),
                'status' => isset($pdf['status']) ? (string) $pdf['status'] : 'pending',
                'dedup' => !empty($result['dedup']),
                'source' => $source,
                'req_id' => $req_id,
            ],
            'job_payload' => [
                'schema_version' => '2026.5',
                'site_id' => $this->jobs->get_site_id(),
                'job_id' => (string) ($result['job_id'] ?? ''),
                'job_type' => 'PDF_GEN',
                'rx_id' => $prescription_id,
                'source' => $source,
            ],
            'pdf' => $pdf,
        ];
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
        $siteId = $this->jobs->get_site_id();
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
