<?php
// includes/Rest/PrescriptionController.php
declare(strict_types=1);

namespace SOSPrescription\Rest;

use SOSPrescription\Repositories\JobRepository;
use SOSPrescription\Repositories\PrescriptionRepository;
use SOSPrescription\Services\AccessPolicy;
use SOSPrescription\Services\Audit;
use SOSPrescription\Services\RestGuard;
use SOSPrescription\Services\RxPdfGenerator;
use SOSPrescription\Services\StripeConfig;
use SOSPrescription\Services\Turnstile;
use SOSPrescription\Services\UidGenerator;
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

    /** @var RxPdfGenerator */
    protected $rx_pdf_generator;

    /** @var PrescriptionRepository */
    protected $prescriptions;

    /** @var string */
    protected $namespace = 'sosprescription/v1';

    /** @var string */
    protected $rest_base = 'prescriptions';

    public function __construct($rx_pdf_generator = null, $jobs = null, $wpdb = null)
    {
        if ($wpdb instanceof \wpdb) {
            $this->wpdb = $wpdb;
        } else {
            global $wpdb;
            $this->wpdb = $wpdb;
        }

        $this->jobs = $jobs instanceof JobRepository ? $jobs : new JobRepository($this->wpdb);
        $this->rx_pdf_generator = $rx_pdf_generator instanceof RxPdfGenerator
            ? $rx_pdf_generator
            : new RxPdfGenerator($this->jobs, $this->wpdb);
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
            return new WP_Error('sosprescription_items_required', 'Au moins un medicament est requis.', ['status' => 400]);
        }

        if (Turnstile::is_enabled()) {
            $token = trim((string) ($params['turnstileToken'] ?? ($params['turnstile_token'] ?? '')));
            $remoteIp = isset($_SERVER['REMOTE_ADDR']) ? (string) wp_unslash($_SERVER['REMOTE_ADDR']) : null;
            $turnstile = Turnstile::verify_token($token, $remoteIp ?: null);
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

        $clientRequestId = isset($params['client_request_id']) ? trim((string) $params['client_request_id']) : null;
        if ($clientRequestId === '') {
            $clientRequestId = null;
        }

        $evidenceFileIds = isset($params['evidence_file_ids']) && is_array($params['evidence_file_ids'])
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
        $initialStatus = !empty($stripe['enabled']) ? 'payment_pending' : 'pending';

        $result = $this->prescriptions->create(
            (int) get_current_user_id(),
            $uid,
            $payload,
            $items,
            $flow,
            $priority,
            $clientRequestId,
            $evidenceFileIds,
            $initialStatus
        );

        if (isset($result['error'])) {
            return new WP_Error(
                'sosprescription_prescription_create_failed',
                isset($result['message']) && is_string($result['message']) && $result['message'] !== ''
                    ? $result['message']
                    : 'Erreur interne lors de la creation de la demande.',
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
        $currentUserId = (int) get_current_user_id();

        if ($currentUserId < 1) {
            return new WP_Error('sosprescription_auth_required', 'Connexion requise.', ['status' => 401]);
        }

        if (AccessPolicy::is_admin()) {
            $rows = $this->prescriptions->list(null, $status !== '' ? $status : null, $limit, $offset);
        } elseif (AccessPolicy::is_doctor()) {
            $rows = $this->prescriptions->list_for_doctor($currentUserId, $status !== '' ? $status : null, $limit, $offset);
        } else {
            $rows = $this->prescriptions->list($currentUserId, $status !== '' ? $status : null, $limit, $offset);
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
            return new WP_Error('sosprescription_forbidden', 'Acces refuse.', ['status' => 403]);
        }

        return rest_ensure_response($row);
    }

    public function update_item($request)
    {
        $request = $this->ensure_rest_request($request);

        return new WP_Error(
            'sosprescription_update_not_supported',
            'La mise a jour directe d une ordonnance n est pas supportee par cette version.',
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
            return new WP_Error('sosprescription_bad_request', 'Parametres invalides.', ['status' => 400]);
        }

        $doctorId = (int) get_current_user_id();
        if ($doctorId < 1) {
            return new WP_Error('sosprescription_auth_required', 'Connexion requise.', ['status' => 401]);
        }

        $ok = $this->prescriptions->decide($id, $doctorId, $decision, $reason);
        if (!$ok) {
            return new WP_Error('sosprescription_decision_conflict', 'Decision impossible pour cette ordonnance.', ['status' => 409]);
        }

        $row = $this->prescriptions->get($id);
        if (!is_array($row)) {
            return new WP_Error('sosprescription_not_found', 'Ordonnance introuvable.', ['status' => 404]);
        }

        if ($decision === 'approved') {
            $reqId = $this->build_req_id();
            $dispatch = $this->rx_pdf_generator->generate($id, [
                'source' => 'doctor_approval',
                'req_id' => $reqId,
            ]);

            if (is_wp_error($dispatch)) {
                return new WP_REST_Response([
                    'id' => $id,
                    'decision' => $decision,
                    'req_id' => $reqId,
                    'prescription' => $row,
                    'pdf' => $this->build_degraded_pdf_state($dispatch, $reqId),
                    'message' => 'Validation enregistree. PDF temporairement indisponible.',
                ], 202);
            }

            $pdf = isset($dispatch['pdf']) && is_array($dispatch['pdf']) ? $dispatch['pdf'] : ['status' => 'pending'];

            return new WP_REST_Response([
                'id' => $id,
                'decision' => $decision,
                'req_id' => $reqId,
                'prescription' => $row,
                'verification' => isset($dispatch['verification']) && is_array($dispatch['verification']) ? $dispatch['verification'] : [],
                'dispatch' => isset($dispatch['dispatch']) && is_array($dispatch['dispatch']) ? $dispatch['dispatch'] : [],
                'pdf' => $pdf,
                'message' => $this->message_for_pdf_state($pdf),
            ], ($pdf['status'] ?? 'pending') === 'done' ? 200 : 202);
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

        $doctorId = (int) get_current_user_id();
        if ($doctorId < 1) {
            return new WP_Error('sosprescription_auth_required', 'Connexion requise.', ['status' => 401]);
        }

        $ok = $this->prescriptions->assign_to_doctor($id, $doctorId);
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
            return new WP_Error('sosprescription_bad_request', 'Parametres invalides.', ['status' => 400]);
        }

        $doctorId = (int) get_current_user_id();
        if ($doctorId < 1) {
            return new WP_Error('sosprescription_auth_required', 'Connexion requise.', ['status' => 401]);
        }

        $ok = $this->prescriptions->update_status_by_doctor($id, $doctorId, $status);
        if (!$ok) {
            return new WP_Error('sosprescription_status_conflict', 'Mise a jour du statut impossible.', ['status' => 409]);
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
        $prescriptionId = (int) $request->get_param('id');
        $reqId = $this->build_req_id();

        $dispatch = $this->rx_pdf_generator->generate($prescriptionId, [
            'source' => 'manual_dispatch',
            'req_id' => $reqId,
        ]);

        if (is_wp_error($dispatch)) {
            return new WP_REST_Response([
                'ok' => false,
                'mode' => 'stateless',
                'req_id' => $reqId,
                'prescription_id' => $prescriptionId,
                'pdf' => $this->build_degraded_pdf_state($dispatch, $reqId),
                'message' => 'Le PDF n a pas pu etre mis en file immediatement.',
            ], 202);
        }

        $statusCode = (isset($dispatch['pdf']['status']) && $dispatch['pdf']['status'] === 'done') ? 200 : 202;
        return new WP_REST_Response($dispatch, $statusCode);
    }

    public function get_pdf_status($request)
    {
        $request = $this->ensure_rest_request($request);
        $prescriptionId = (int) $request->get_param('id');

        return new WP_REST_Response([
            'prescription_id' => $prescriptionId,
            'pdf' => $this->jobs->get_public_state_for_rx_id($prescriptionId),
        ], 200);
    }

    public function get_rx_pdf($request)
    {
        $request = $this->ensure_rest_request($request);
        $prescriptionId = (int) $request->get_param('id');
        $row = $this->prescriptions->get($prescriptionId);

        if (!is_array($row)) {
            return new WP_Error('sosprescription_not_found', 'Ordonnance introuvable.', ['status' => 404]);
        }

        if (!AccessPolicy::can_current_user_access_prescription_row($row)) {
            return new WP_Error('sosprescription_forbidden', 'Acces refuse.', ['status' => 403]);
        }

        $doneJob = $this->jobs->get_latest_done_by_rx_id($prescriptionId);
        if (!empty($doneJob)) {
            $downloadUrl = $this->build_presigned_s3_url_from_job($doneJob, 60);
            if (is_wp_error($downloadUrl)) {
                return $downloadUrl;
            }

            return new WP_REST_Response([
                'prescription_id' => $prescriptionId,
                'pdf' => $this->jobs->public_projection($doneJob),
                'download_url' => $downloadUrl,
                'expires_in' => 60,
            ], 200);
        }

        $autoDispatch = true;
        if ($request->offsetExists('dispatch')) {
            $autoDispatch = $this->truthy($request->get_param('dispatch'));
        }

        if ($autoDispatch) {
            $dispatch = $this->rx_pdf_generator->generate($prescriptionId, [
                'source' => 'download_probe',
                'req_id' => $this->build_req_id(),
            ]);

            if (is_wp_error($dispatch)) {
                return new WP_REST_Response([
                    'prescription_id' => $prescriptionId,
                    'pdf' => $this->build_degraded_pdf_state($dispatch, $this->build_req_id()),
                    'message' => 'PDF temporairement indisponible.',
                ], 202);
            }

            return new WP_REST_Response([
                'prescription_id' => $prescriptionId,
                'pdf' => isset($dispatch['pdf']) ? $dispatch['pdf'] : ['status' => 'pending'],
                'dispatch' => isset($dispatch['dispatch']) ? $dispatch['dispatch'] : [],
                'message' => 'PDF en cours de generation.',
            ], 202);
        }

        return new WP_REST_Response([
            'prescription_id' => $prescriptionId,
            'pdf' => $this->jobs->get_public_state_for_rx_id($prescriptionId),
            'message' => 'PDF en cours de generation.',
        ], 202);
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
    protected function build_degraded_pdf_state(WP_Error $error, string $reqId): array
    {
        return [
            'status' => 'degraded',
            'job_id' => 0,
            'req_id' => $reqId,
            'can_download' => false,
            's3_ready' => false,
            'error' => [
                'code' => $error->get_error_code(),
                'message' => $error->get_error_message(),
            ],
        ];
    }

    /**
     * @param array<string, mixed> $pdfState
     */
    protected function message_for_pdf_state(array $pdfState): string
    {
        $status = isset($pdfState['status']) ? (string) $pdfState['status'] : 'pending';

        if ($status === 'done') {
            return 'Validation enregistree. PDF disponible.';
        }

        if ($status === 'failed') {
            return 'Validation enregistree. Le PDF est indisponible pour le moment.';
        }

        if ($status === 'degraded') {
            return 'Validation enregistree. Service PDF ralenti ; le document sera disponible sous peu.';
        }

        return 'Validation enregistree. PDF en cours de generation.';
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
            return new WP_Error('sosprescription_s3_config_missing', 'Configuration S3 incomplete pour la presignature.', ['status' => 500]);
        }

        $credentials = $this->resolve_s3_credentials();
        if (is_wp_error($credentials)) {
            return $credentials;
        }

        $amzDate = gmdate('Ymd\THis\Z');
        $date = gmdate('Ymd');
        $scope = $date . '/' . $region . '/s3/aws4_request';
        $usePathStyle = ($endpoint !== '' || strpos($bucket, '.') !== false);

        if ($endpoint !== '') {
            $parsed = wp_parse_url($endpoint);
            $scheme = !empty($parsed['scheme']) ? $parsed['scheme'] : 'https';
            $host = !empty($parsed['host']) ? $parsed['host'] : '';
            $basePath = !empty($parsed['path']) ? rtrim($parsed['path'], '/') : '';

            if ($host === '') {
                return new WP_Error('sosprescription_s3_endpoint_invalid', 'Endpoint S3 invalide.', ['status' => 500]);
            }

            $canonicalUri = $basePath . '/' . $this->aws_uri_encode($bucket) . '/' . $this->aws_uri_encode_path($key);
            $urlBase = $scheme . '://' . $host;
        } elseif ($usePathStyle) {
            $host = 's3.' . $region . '.amazonaws.com';
            $canonicalUri = '/' . $this->aws_uri_encode($bucket) . '/' . $this->aws_uri_encode_path($key);
            $urlBase = 'https://' . $host;
        } else {
            $host = $bucket . '.s3.' . $region . '.amazonaws.com';
            $canonicalUri = '/' . $this->aws_uri_encode_path($key);
            $urlBase = 'https://' . $host;
        }

        $query = [
            'X-Amz-Algorithm' => 'AWS4-HMAC-SHA256',
            'X-Amz-Credential' => $credentials['access_key'] . '/' . $scope,
            'X-Amz-Date' => $amzDate,
            'X-Amz-Expires' => (string) $ttl,
            'X-Amz-SignedHeaders' => 'host',
        ];

        if (!empty($credentials['session_token'])) {
            $query['X-Amz-Security-Token'] = $credentials['session_token'];
        }

        $canonicalQuery = $this->aws_build_query($query);
        $canonicalHeaders = 'host:' . $host . "\n";
        $signedHeaders = 'host';
        $canonicalRequest = "GET\n{$canonicalUri}\n{$canonicalQuery}\n{$canonicalHeaders}\n{$signedHeaders}\nUNSIGNED-PAYLOAD";
        $stringToSign = "AWS4-HMAC-SHA256\n{$amzDate}\n{$scope}\n" . hash('sha256', $canonicalRequest);
        $signingKey = $this->aws_signing_key($credentials['secret_key'], $date, $region, 's3');
        $signature = hash_hmac('sha256', $stringToSign, $signingKey);

        return $urlBase . $canonicalUri . '?' . $canonicalQuery . '&X-Amz-Signature=' . $signature;
    }

    /**
     * @return array{access_key:string,secret_key:string,session_token:string}|WP_Error
     */
    protected function resolve_s3_credentials(): array|WP_Error
    {
        $accessKey = $this->get_env_or_constant('SOSPRESCRIPTION_S3_ACCESS_KEY', $this->get_env_or_constant('AWS_ACCESS_KEY_ID'));
        $secretKey = $this->get_env_or_constant('SOSPRESCRIPTION_S3_SECRET_KEY', $this->get_env_or_constant('AWS_SECRET_ACCESS_KEY'));
        $session = $this->get_env_or_constant('SOSPRESCRIPTION_S3_SESSION_TOKEN', $this->get_env_or_constant('AWS_SESSION_TOKEN'));

        if ($accessKey === '' || $secretKey === '') {
            return new WP_Error('sosprescription_s3_credentials_missing', 'Identifiants S3 manquants pour la presignature.', ['status' => 500]);
        }

        return [
            'access_key' => $accessKey,
            'secret_key' => $secretKey,
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
        $kDate = hash_hmac('sha256', $date, 'AWS4' . $secret, true);
        $kRegion = hash_hmac('sha256', $region, $kDate, true);
        $kService = hash_hmac('sha256', $service, $kRegion, true);

        return hash_hmac('sha256', 'aws4_request', $kService, true);
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

    private static function str_len(string $value): int
    {
        return function_exists('mb_strlen') ? (int) mb_strlen($value, 'UTF-8') : strlen($value);
    }
}
