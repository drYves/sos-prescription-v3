<?php
declare(strict_types=1);

namespace SosPrescription\Rest;

use SOSPrescription\Core\JobDispatcher;
use SOSPrescription\Core\NdjsonLogger;
use SOSPrescription\Core\ReqId;
use SosPrescription\Repositories\PrescriptionRepository;
use SosPrescription\Services\AccessPolicy;
use SosPrescription\Services\RestGuard;
use WP_Error;
use WP_REST_Request;
use WP_REST_Response;

final class ArtifactController extends \WP_REST_Controller
{
    /** @var \wpdb */
    protected $wpdb;

    /** @var JobDispatcher|null */
    protected $job_dispatcher;

    protected PrescriptionRepository $prescriptions;

    /** @var string */
    protected $namespace = 'sosprescription/v1';

    /** @var string */
    protected $rest_base = 'artifacts';

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

        if (strtoupper((string) $request->get_method()) === 'POST') {
            $ok = RestGuard::throttle($request, 'files_upload');
            if (is_wp_error($ok)) {
                return $ok;
            }
        }

        return true;
    }

    public function init_upload(WP_REST_Request $request)
    {
        $params = $this->request_data($request);

        $purpose = strtolower(trim((string) ($params['purpose'] ?? '')));
        $kind = $this->normalize_artifact_kind($purpose, $params['kind'] ?? null);
        if ($kind === null) {
            return new WP_Error(
                'sosprescription_bad_artifact_kind',
                'Type de fichier invalide.',
                ['status' => 400]
            );
        }

        $current_user_id = (int) get_current_user_id();
        if ($current_user_id < 1) {
            return new WP_Error('sosprescription_auth_required', 'Connexion requise.', ['status' => 401]);
        }

        $prescription_id = isset($params['prescription_id']) ? (int) $params['prescription_id'] : 0;
        if ($prescription_id < 1) {
            $prescription_id = 0;
        }

        if ($prescription_id > 0) {
            $rx_row = $this->prescriptions->get($prescription_id);
            if (!is_array($rx_row)) {
                return new WP_Error('sosprescription_not_found', 'Ordonnance introuvable.', ['status' => 404]);
            }

            if (!AccessPolicy::can_current_user_access_prescription_row($rx_row)) {
                return new WP_Error('sosprescription_forbidden', 'Accès refusé.', ['status' => 403]);
            }
        }

        $original_name = sanitize_file_name((string) ($params['original_name'] ?? ''));
        if ($original_name === '') {
            $original_name = 'upload.bin';
        }

        $mime_type = trim((string) ($params['mime_type'] ?? 'application/octet-stream'));
        $mime_type = $mime_type !== '' ? substr(sanitize_text_field($mime_type), 0, 191) : 'application/octet-stream';

        $size_bytes = isset($params['size_bytes']) ? (int) $params['size_bytes'] : 0;
        if ($size_bytes < 1) {
            return new WP_Error('sosprescription_bad_artifact_size', 'Taille de fichier invalide.', ['status' => 400]);
        }

        $actor_role = (AccessPolicy::is_doctor() || AccessPolicy::is_admin()) ? 'DOCTOR' : 'PATIENT';
        $req_id = $this->build_req_id();

        $artifact_payload = [
            'kind' => $kind,
            'original_name' => $original_name,
            'mime_type' => $mime_type,
            'size_bytes' => $size_bytes,
        ];
        if ($prescription_id > 0) {
            $artifact_payload['prescription_id'] = $prescription_id;
        }
        if (isset($params['meta']) && is_array($params['meta'])) {
            $artifact_payload['meta'] = $params['meta'];
        }

        try {
            $worker_result = $this->get_job_dispatcher()->initArtifactUpload(
                [
                    'role' => $actor_role,
                    'wp_user_id' => $current_user_id,
                ],
                $artifact_payload,
                $req_id
            );
        } catch (\Throwable $e) {
            return new WP_Error(
                'sosprescription_artifact_init_failed',
                'Échec de préparation de l’upload HDS : ' . $e->getMessage(),
                [
                    'status' => 502,
                    'req_id' => $req_id,
                ]
            );
        }

        return new WP_REST_Response($worker_result, 201);
    }

    public function access(WP_REST_Request $request)
    {
        $artifactId = trim((string) $request->get_param('artifact_id'));
        if ($artifactId === '') {
            return new WP_Error('sosprescription_bad_artifact_id', 'Artefact invalide.', ['status' => 400]);
        }

        $params = $this->request_data($request);
        $prescription_id = isset($params['prescription_id']) ? (int) $params['prescription_id'] : 0;
        if ($prescription_id > 0) {
            $rx_row = $this->prescriptions->get($prescription_id);
            if (!is_array($rx_row)) {
                return new WP_Error('sosprescription_not_found', 'Ordonnance introuvable.', ['status' => 404]);
            }
            if (!AccessPolicy::can_current_user_access_prescription_row($rx_row)) {
                return new WP_Error('sosprescription_forbidden', 'Accès refusé.', ['status' => 403]);
            }
        }

        $disposition = strtolower(trim((string) ($params['disposition'] ?? 'inline')));
        if (!in_array($disposition, ['inline', 'attachment'], true)) {
            $disposition = 'inline';
        }

        $req_id = $this->build_req_id();

        try {
            $worker_result = $this->get_job_dispatcher()->createArtifactAccess(
                $artifactId,
                [
                    'role' => (AccessPolicy::is_doctor() || AccessPolicy::is_admin()) ? 'DOCTOR' : 'PATIENT',
                    'wp_user_id' => (int) get_current_user_id(),
                ],
                $disposition,
                $req_id
            );
        } catch (\Throwable $e) {
            return new WP_Error(
                'sosprescription_artifact_access_failed',
                'Impossible de générer le lien sécurisé : ' . $e->getMessage(),
                [
                    'status' => 502,
                    'req_id' => $req_id,
                ]
            );
        }

        return rest_ensure_response($worker_result);
    }

    public function analyze(WP_REST_Request $request)
    {
        $artifactId = trim((string) $request->get_param('artifact_id'));
        if ($artifactId === '') {
            return new WP_Error('sosprescription_bad_artifact_id', 'Artefact invalide.', ['status' => 400]);
        }

        $req_id = $this->build_req_id();

        try {
            $worker_result = $this->get_job_dispatcher()->analyzeArtifact(
                $artifactId,
                [
                    'role' => (AccessPolicy::is_doctor() || AccessPolicy::is_admin()) ? 'DOCTOR' : 'PATIENT',
                    'wp_user_id' => (int) get_current_user_id(),
                ],
                $req_id
            );
        } catch (\Throwable $e) {
            return new WP_Error(
                'sosprescription_artifact_analyze_failed',
                'Impossible d’analyser le document : ' . $e->getMessage(),
                [
                    'status' => 502,
                    'req_id' => $req_id,
                ]
            );
        }

        return rest_ensure_response($worker_result);
    }

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

    protected function normalize_artifact_kind(string $purpose, $explicit_kind): ?string
    {
        $kind = strtoupper(trim((string) $explicit_kind));
        if ($kind === 'PROOF' || $kind === 'MESSAGE_ATTACHMENT') {
            return $kind;
        }

        return match ($purpose) {
            'evidence', 'proof', 'rx_proof', 'renewal_proof' => 'PROOF',
            'message', 'message_attachment', 'attachment', 'compose' => 'MESSAGE_ATTACHMENT',
            default => null,
        };
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
