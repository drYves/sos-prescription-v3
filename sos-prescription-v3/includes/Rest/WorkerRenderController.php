<?php
declare(strict_types=1);

namespace SosPrescription\Rest;

use SosPrescription\Core\Mls1Verifier;
use SosPrescription\Core\NdjsonLogger;
use SosPrescription\Core\NonceStore;
use SosPrescription\Core\ReqId;
use SosPrescription\Lib\InlineCode39Svg;
use SosPrescription\Lib\InlineQrSvg;
use SosPrescription\Repositories\FileRepository;
use SosPrescription\Repositories\PrescriptionRepository;
use SosPrescription\Services\Posology;
use WP_Error;
use WP_REST_Request;
use WP_REST_Response;
use wpdb;

final class WorkerRenderController
{
    private string $jobsTable;
    private string $rxTable;

    public function __construct(
        private wpdb $db,
        private NdjsonLogger $logger,
        private Mls1Verifier $verifier,
        private string $siteId
    ) {
        $this->jobsTable = $db->prefix . 'sosprescription_jobs';
        $this->rxTable = $db->prefix . 'sosprescription_prescriptions';
    }

    public static function register(): void
    {
        add_action('rest_api_init', static function (): void {
            $db = $GLOBALS['wpdb'];
            $siteId = self::readConfigString('ML_SITE_ID', 'unknown_site');
            $env = self::readConfigString('SOSPRESCRIPTION_ENV', 'prod');

            $logger = new NdjsonLogger('web', $siteId, $env);
            $nonceStore = new NonceStore($db, $siteId);
            $verifier = Mls1Verifier::fromEnv($nonceStore, $logger);
            $controller = new self($db, $logger, $verifier, $siteId);

            register_rest_route('sosprescription/v3', '/worker/render/rx/(?P<rx_id>\d+)', [
                'methods' => 'GET',
                'permission_callback' => '__return_true',
                'callback' => [$controller, 'handle'],
                'args' => [
                    'rx_id' => [
                        'validate_callback' => static fn($v): bool => is_numeric($v) && (int) $v > 0,
                    ],
                ],
            ]);

            add_filter('rest_pre_serve_request', [$controller, 'maybeServeHtml'], 10, 4);
        });
    }


    private static function readConfigString(string $name, string $default = ''): string
    {
        if (defined($name)) {
            $value = constant($name);
            if (is_string($value)) {
                return $value;
            }
            if (is_scalar($value)) {
                return (string) $value;
            }
        }

        $value = getenv($name);
        if (is_string($value)) {
            return $value;
        }

        return $default;
    }

    public function handle(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $rxId = (int) $request->get_param('rx_id');
        if ($rxId <= 0) {
            return new WP_Error('ml_rx_invalid', 'Invalid rx_id', ['status' => 400]);
        }

        $jobCtx = $this->findJobContext($rxId);
        $reqId = ReqId::coalesce($jobCtx['req_id'] ?? null);
        $jobId = $jobCtx['job_id'] ?? null;
        $expectedPath = $this->expectedCanonicalPathForRx($rxId);

        if ($this->isDebugAllowed()) {
            $this->logger->warning('render.debug_access.granted', ['rx_id' => $rxId], $reqId);
        } else {
            $auth = $this->verifier->verifyCanonicalGet($request, $expectedPath, 'worker_render');
            if (is_wp_error($auth)) {
                $this->logger->warning('render.auth.denied', [
                    'rx_id' => $rxId,
                    'path' => $expectedPath,
                    'code' => $auth->get_error_code(),
                ], $reqId);
                return $auth;
            }
        }

        if (!$this->tableExists($this->rxTable)) {
            return new WP_Error('ml_rx_store_missing', 'Prescription store unavailable', ['status' => 503]);
        }

        $t0 = (int) floor(microtime(true) * 1000);
        $repo = new PrescriptionRepository();
        $rx = $repo->get($rxId);
        if (!is_array($rx)) {
            $this->logger->warning('render.rx_not_found', ['rx_id' => $rxId], $reqId);
            return new WP_Error('ml_rx_not_found', 'Prescription not found', ['status' => 404]);
        }

        $html = $this->renderMedicalHtml($rxId, $reqId, $jobId, $rx);
        $dt = ((int) floor(microtime(true) * 1000)) - $t0;

        $this->logger->info('render.responded', [
            'rx_id' => $rxId,
            'job_id' => $jobId,
            'items_count' => count(isset($rx['items']) && is_array($rx['items']) ? $rx['items'] : []),
            'template' => basename($this->resolveTemplatePath()),
            'duration_ms' => $dt,
        ], $reqId);

        $response = new WP_REST_Response($html, 200);
        $response->header('Content-Type', 'text/html; charset=utf-8');
        $response->header('Cache-Control', 'no-store, private, max-age=0');
        $response->header('Pragma', 'no-cache');
        $response->header('X-Robots-Tag', 'noindex, nofollow, noarchive');
        $response->header('X-Content-Type-Options', 'nosniff');
        $response->header('Referrer-Policy', 'no-referrer');
        $response->header('X-Frame-Options', 'DENY');
        $response->header('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'unsafe-inline'; connect-src 'self'");

        return $response;
    }

    public function maybeServeHtml(bool $served, $result, WP_REST_Request $request, $server): bool
    {
        if ($served) {
            return true;
        }

        $route = $request->get_route();
        if (!is_string($route) || strpos($route, '/sosprescription/v3/worker/render/rx/') !== 0) {
            return false;
        }

        if (!($result instanceof WP_REST_Response)) {
            return false;
        }

        $headers = $result->get_headers();
        $ct = $headers['Content-Type'] ?? $headers['content-type'] ?? '';
        if (stripos((string) $ct, 'text/html') !== 0) {
            return false;
        }

        status_header($result->get_status());
        foreach ($headers as $name => $value) {
            header($name . ': ' . $value);
        }

        $body = $result->get_data();
        echo is_string($body) ? $body : '<!doctype html><html><body>Invalid response</body></html>';
        return true;
    }

    private function expectedCanonicalPathForRx(int $rxId): string
    {
        $base = parse_url(rest_url(), PHP_URL_PATH);
        $base = is_string($base) && $base !== '' ? rtrim($base, '/') : '/wp-json';
        return $base . '/sosprescription/v3/worker/render/rx/' . $rxId;
    }

    private function isDebugAllowed(): bool
    {
        return defined('SOSPRESCRIPTION_RENDER_DEBUG')
            && SOSPRESCRIPTION_RENDER_DEBUG === true
            && is_user_logged_in()
            && current_user_can('manage_options');
    }

    /**
     * @return array{job_id:?string,req_id:?string}
     */
    private function findJobContext(int $rxId): array
    {
        $sql = "
            SELECT job_id, req_id, status, locked_at, created_at
            FROM `{$this->jobsTable}`
            WHERE site_id = %s
              AND rx_id = %d
              AND job_type = 'PDF_GEN'
              AND status IN ('CLAIMED','PENDING','DONE')
              AND job_id IS NOT NULL
              AND job_id <> ''
            ORDER BY CASE WHEN status='CLAIMED' THEN 0 WHEN status='PENDING' THEN 1 ELSE 2 END ASC,
                     locked_at DESC,
                     created_at DESC,
                     id DESC
            LIMIT 1
        ";

        $row = $this->db->get_row($this->db->prepare($sql, $this->siteId, $rxId), ARRAY_A);
        if (!is_array($row)) {
            return [];
        }

        return [
            'job_id' => isset($row['job_id']) && $row['job_id'] !== '' ? (string) $row['job_id'] : null,
            'req_id' => isset($row['req_id']) && $row['req_id'] !== '' ? (string) $row['req_id'] : null,
        ];
    }

    private function tableExists(string $table): bool
    {
        $found = $this->db->get_var($this->db->prepare('SHOW TABLES LIKE %s', $table));
        return is_string($found) && $found === $table;
    }

    /**
     * @param array<string, mixed> $rx
     */
    private function renderMedicalHtml(int $rxId, string $reqId, ?string $jobId, array $rx): string
    {
        $templatePath = $this->resolveTemplatePath();
        $templateHtml = $this->loadTemplateHtml($templatePath);
        $doctor = $this->buildDoctorProfile($rx);
        $verifyUrl = $this->buildVerificationUrl($rx);
        $qrDataUri = $this->buildQrDataUri($verifyUrl !== '' ? $verifyUrl : ('rx:' . $rxId));
        $signatureDataUri = $this->buildSignatureDataUri($doctor);
        $rppsBarcodeDataUri = $this->buildRppsBarcodeDataUri($doctor);

        $signatureImgHtml = $signatureDataUri !== ''
            ? '<img class="sig-img" src="' . esc_attr($signatureDataUri) . '" alt="Signature du médecin" />'
            : '<div class="sig-fallback">Signature non renseignée.</div>';
        $qrImgHtml = '<img class="qr-img" src="' . esc_attr($qrDataUri) . '" alt="QR Code de vérification" />';
        $rppsBarcodeHtml = $rppsBarcodeDataUri !== ''
            ? '<img class="doctor-rpps-barcode" src="' . esc_attr($rppsBarcodeDataUri) . '" alt="Code barre RPPS" />'
            : '';

        $patientName = trim((string) ($rx['patient_name'] ?? 'Patient'));
        $patientBirthLabel = trim((string) ($rx['patient_birthdate_fr'] ?? ($rx['patient_dob'] ?? '')));
        $patientWhLabel = '—';
        $issueLine = $this->buildIssueLine($doctor, $rx);
        $footerBlock = $this->buildFooterBlockHtml($rx, $reqId, $jobId, $verifyUrl, $doctor);
        $doctorBlock = $this->buildDoctorBlockHtml($doctor, $rx, $issueLine, $rppsBarcodeDataUri);
        $patientBlock = $this->buildPatientBlockHtml($rx, $verifyUrl);
        $medRows = $this->buildMedicationRowsHtml($rx);
        $medBlocks = $this->buildLegacyMedicationBlocksHtml($rx);
        $hashShort = substr(hash('sha256', (string) ($rx['uid'] ?? '') . '|' . (string) ($rx['verify_token'] ?? '')), 0, 12);

        $replacements = [
            '{{DOCTOR_BLOCK}}' => $doctorBlock,
            '{{PATIENT_BLOCK}}' => $patientBlock,
            '{{MEDICATIONS_LIST}}' => $medRows,
            '{{QR_CODE}}' => esc_attr($qrDataUri !== '' ? $qrDataUri : $this->blankImageDataUri()),
            '{{SIGNATURE_IMAGE}}' => esc_attr($signatureDataUri !== '' ? $signatureDataUri : $this->blankImageDataUri()),
            '{{FOOTER_BLOCK}}' => $footerBlock,

            // Compatibilité templates variantes A/B/C.
            '{{ADDRESS}}' => nl2br(esc_html((string) ($doctor['address'] ?? '—'))),
            '{{BARCODE_HTML}}' => $rppsBarcodeHtml !== '' ? $rppsBarcodeHtml : $qrImgHtml,
            '{{DELIVERY_CODE}}' => esc_html((string) ($rx['verify_code'] ?? '—')),
            '{{DIPLOMA_LINE}}' => esc_html((string) ($doctor['diploma_line'] ?? '')),
            '{{DOCTOR_DISPLAY}}' => esc_html((string) ($doctor['full_name'] ?? 'SOS Prescription')),
            '{{HASH_SHORT}}' => esc_html($hashShort),
            '{{ISSUE_LINE}}' => esc_html($issueLine),
            '{{MEDICATIONS_HTML}}' => $medBlocks,
            '{{MED_COUNT}}' => esc_html((string) max(1, count(isset($rx['items']) && is_array($rx['items']) ? $rx['items'] : []))),
            '{{PATIENT_BIRTH_LABEL}}' => esc_html($patientBirthLabel !== '' ? $patientBirthLabel : '—'),
            '{{PATIENT_NAME}}' => esc_html($patientName !== '' ? $patientName : 'Patient'),
            '{{PATIENT_WH_LABEL}}' => esc_html($patientWhLabel),
            '{{PHONE}}' => esc_html((string) ($doctor['phone'] ?? '—')),
            '{{QR_IMG_HTML}}' => $qrImgHtml,
            '{{RPPS}}' => esc_html((string) ($doctor['rpps'] ?? '—')),
            '{{RPPS_BARCODE}}' => esc_attr($rppsBarcodeDataUri),
            '{{RPPS_BARCODE_HTML}}' => $rppsBarcodeHtml,
            '{{RX_PUBLIC_ID}}' => esc_html($verifyUrl !== '' ? $verifyUrl : ((string) ($rx['uid'] ?? ('RX-' . $rxId)))),
            '{{SIGNATURE_IMG_HTML}}' => $signatureImgHtml,
            '{{SPECIALTY}}' => esc_html((string) ($doctor['specialty'] ?? 'Médecin prescripteur')),
            '{{UID}}' => esc_html((string) ($rx['uid'] ?? ('RX-' . $rxId))),
        ];

        $html = strtr($templateHtml, $replacements);
        $html = $this->injectMetaAndReadiness($html, $rxId, $reqId, $jobId, basename($templatePath));

        return $html;
    }

    private function resolveTemplatePath(): string
    {
        $defaultPath = rtrim((string) SOSPRESCRIPTION_PATH, '/') . '/templates/rx-ordonnance-mpdf.html';

        $uploads = wp_upload_dir();
        $overrideDir = rtrim((string) ($uploads['basedir'] ?? ''), '/');
        $overridePath = $overrideDir !== '' ? $overrideDir . '/sosprescription-templates/rx-ordonnance-mpdf.html' : '';

        $candidate = '';
        if ($overridePath !== '' && is_readable($overridePath)) {
            $candidate = $overridePath;
        } else {
            $active = get_option('sosprescription_rx_template_active', 'plugin:rx-ordonnance-mpdf.html');
            $candidate = $this->resolveTemplatePathFromOption(is_string($active) ? $active : '');
        }

        if ($candidate === '' || !is_readable($candidate)) {
            $candidate = $defaultPath;
        }

        $filtered = apply_filters('sosprescription_rx_template_path', $candidate, basename($candidate));
        if (is_string($filtered) && $filtered !== '' && is_readable($filtered)) {
            return $filtered;
        }

        return $candidate;
    }

    private function resolveTemplatePathFromOption(string $active): string
    {
        $active = trim($active);
        if ($active === '') {
            return '';
        }

        if (strpos($active, 'plugin:') === 0) {
            $file = basename(substr($active, strlen('plugin:')));
            $path = rtrim((string) SOSPRESCRIPTION_PATH, '/') . '/templates/' . $file;
            return is_readable($path) ? $path : '';
        }

        if (strpos($active, 'uploads:') === 0) {
            $file = basename(substr($active, strlen('uploads:')));
            $uploads = wp_upload_dir();
            $path = rtrim((string) ($uploads['basedir'] ?? ''), '/') . '/sosprescription-templates/' . $file;
            return is_readable($path) ? $path : '';
        }

        return '';
    }

    private function loadTemplateHtml(string $path): string
    {
        if ($path !== '' && is_readable($path)) {
            $html = file_get_contents($path);
            if (is_string($html) && $html !== '') {
                return $html;
            }
        }

        return '<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Ordonnance</title></head><body><div>{{DOCTOR_BLOCK}}</div><div>{{PATIENT_BLOCK}}</div><table><tbody>{{MEDICATIONS_LIST}}</tbody></table><div>{{FOOTER_BLOCK}}</div></body></html>';
    }

    /**
     * @param array<string, mixed> $rx
     * @return array<string, mixed>
     */
    private function buildDoctorProfile(array $rx): array
    {
        $doctorUserId = isset($rx['doctor_user_id']) ? (int) $rx['doctor_user_id'] : 0;
        $user = $doctorUserId > 0 ? get_userdata($doctorUserId) : null;

        $firstName = $doctorUserId > 0 ? $this->readUserMetaString($doctorUserId, ['first_name']) : '';
        $lastName = $doctorUserId > 0 ? $this->readUserMetaString($doctorUserId, ['last_name']) : '';
        if ($firstName === '' && $user instanceof \WP_User) {
            $firstName = trim((string) $user->first_name);
        }
        if ($lastName === '' && $user instanceof \WP_User) {
            $lastName = trim((string) $user->last_name);
        }

        $displayName = trim($firstName . ' ' . $lastName);
        if ($displayName === '' && $user instanceof \WP_User) {
            $displayName = trim((string) $user->display_name);
        }
        if ($displayName === '' && $user instanceof \WP_User) {
            $displayName = trim((string) $user->user_nicename);
        }
        if ($displayName === '') {
            $displayName = 'Médecin prescripteur';
        }

        $titleRaw = $doctorUserId > 0 ? $this->readUserMetaString($doctorUserId, ['sosprescription_doctor_title']) : '';
        $titleDisplay = $this->mapDoctorTitle($titleRaw);
        $specialty = $doctorUserId > 0 ? $this->readUserMetaString($doctorUserId, ['sosprescription_specialty', 'sosprescription_doctor_specialty']) : '';
        $rpps = $doctorUserId > 0 ? $this->sanitizeDigits($this->readUserMetaString($doctorUserId, ['sosprescription_rpps', 'sosprescription_doctor_rpps'])) : '';
        $address = $doctorUserId > 0 ? $this->readUserMetaString($doctorUserId, ['sosprescription_professional_address']) : '';
        $phone = $doctorUserId > 0 ? $this->readUserMetaString($doctorUserId, ['sosprescription_professional_phone']) : '';
        $diplomaLabel = $doctorUserId > 0 ? $this->readUserMetaString($doctorUserId, ['sosprescription_diploma_label', 'sosprescription_doctor_diploma_line']) : '';
        $diplomaLocation = $doctorUserId > 0 ? $this->readUserMetaString($doctorUserId, ['sosprescription_diploma_university_location']) : '';
        $diplomaHonors = $doctorUserId > 0 ? $this->readUserMetaString($doctorUserId, ['sosprescription_diploma_honors']) : '';
        $issuePlace = $doctorUserId > 0 ? $this->readUserMetaString($doctorUserId, ['sosprescription_issue_place', 'sosprescription_doctor_issue_place']) : '';
        $signatureFileId = $doctorUserId > 0 ? (int) $this->readUserMetaString($doctorUserId, ['sosprescription_signature_file_id']) : 0;
        $signatureAttachmentId = $doctorUserId > 0 ? (int) $this->readUserMetaString($doctorUserId, ['sosprescription_signature_attachment_id', 'sosprescription_signature_media_id']) : 0;

        $fullName = $displayName;
        if ($titleDisplay !== '' && stripos($displayName, $titleDisplay) !== 0) {
            $fullName = trim($titleDisplay . ' ' . $displayName);
        }

        $diplomaParts = array_values(array_filter([$diplomaLabel, $diplomaLocation, $diplomaHonors], static fn($value): bool => trim((string) $value) !== ''));
        $diplomaLine = trim(implode(' — ', $diplomaParts));

        return [
            'user_id' => $doctorUserId,
            'first_name' => $firstName,
            'last_name' => $lastName,
            'full_name' => $fullName,
            'display_name' => $displayName,
            'title' => $titleDisplay,
            'specialty' => $specialty !== '' ? $specialty : 'Médecin prescripteur',
            'rpps' => $rpps,
            'address' => $address,
            'phone' => $phone,
            'diploma_line' => $diplomaLine,
            'issue_place' => $issuePlace,
            'signature_file_id' => $signatureFileId,
            'signature_attachment_id' => $signatureAttachmentId,
        ];
    }

    /**
     * @param array<string, mixed> $doctor
     * @param array<string, mixed> $rx
     */
    private function buildDoctorBlockHtml(array $doctor, array $rx, string $issueLine, string $rppsBarcodeDataUri): string
    {
        $lines = [];
        $lines[] = '<div class="doctor-name">' . esc_html((string) ($doctor['full_name'] ?? 'Médecin prescripteur')) . '</div>';

        if (!empty($doctor['specialty'])) {
            $lines[] = '<div class="doctor-specialty">' . esc_html((string) $doctor['specialty']) . '</div>';
        }
        if (!empty($doctor['diploma_line'])) {
            $lines[] = '<div class="doctor-diploma">' . esc_html((string) $doctor['diploma_line']) . '</div>';
        }

        $metaRows = [];
        if (!empty($doctor['address'])) {
            $metaRows[] = $this->buildLabeledValueRowHtml('Adresse', nl2br(esc_html((string) $doctor['address'])), true);
        }
        if (!empty($doctor['phone'])) {
            $metaRows[] = $this->buildLabeledValueRowHtml('Téléphone', esc_html((string) $doctor['phone']), true);
        }
        if (!empty($doctor['rpps'])) {
            $metaRows[] = $this->buildLabeledValueRowHtml('RPPS', esc_html((string) $doctor['rpps']), true);
        }
        if ($issueLine !== '') {
            $metaRows[] = $this->buildLabeledValueRowHtml('Émission', esc_html($issueLine), true);
        }

        if ($metaRows !== []) {
            $lines[] = '<div class="doctor-meta-grid">' . implode("\n", $metaRows) . '</div>';
        }

        if (!empty($doctor['rpps']) && $rppsBarcodeDataUri !== '') {
            $lines[] = '<div class="doctor-rpps-panel">'
                . '<div class="doctor-rpps-heading">Code barre RPPS</div>'
                . '<div class="doctor-rpps-value">' . esc_html((string) $doctor['rpps']) . '</div>'
                . '<img class="doctor-rpps-barcode" src="' . esc_attr($rppsBarcodeDataUri) . '" alt="Code barre RPPS ' . esc_attr((string) $doctor['rpps']) . '" />'
                . '</div>';
        }

        return implode("\n", $lines);
    }

    /**
     * @param array<string, mixed> $rx
     */
    private function buildPatientBlockHtml(array $rx, string $verifyUrl): string
    {
        $patientName = trim((string) ($rx['patient_name'] ?? 'Patient'));
        $birthLabel = trim((string) ($rx['patient_birthdate_fr'] ?? ($rx['patient_dob'] ?? '')));
        $ageLabel = trim((string) ($rx['patient_age_label'] ?? ''));
        $uid = trim((string) ($rx['uid'] ?? ''));
        $verifyCode = trim((string) ($rx['verify_code'] ?? ''));
        $createdAt = $this->formatDateFr((string) ($rx['created_at'] ?? ''));

        $rows = [];
        $rows[] = $this->buildLabeledValueRowHtml('Nom', esc_html($patientName !== '' ? $patientName : 'Patient'), true);
        $rows[] = $this->buildLabeledValueRowHtml('Date de naissance', esc_html($birthLabel !== '' ? $birthLabel : '—'), true);
        if ($ageLabel !== '') {
            $rows[] = $this->buildLabeledValueRowHtml('Âge', esc_html($ageLabel), true);
        }
        if ($uid !== '') {
            $rows[] = $this->buildLabeledValueRowHtml('Référence', '<code>' . esc_html($uid) . '</code>', true);
        }
        if ($createdAt !== '') {
            $rows[] = $this->buildLabeledValueRowHtml('Créée le', esc_html($createdAt), true);
        }
        if ($verifyCode !== '') {
            $rows[] = $this->buildLabeledValueRowHtml('Code délivrance', '<strong>' . esc_html($verifyCode) . '</strong>', true);
        }
        if ($verifyUrl !== '') {
            $rows[] = $this->buildLabeledValueRowHtml('URL de vérification', '<span class="verify-link">' . esc_html($verifyUrl) . '</span>', true);
        }

        return '<div class="patient-grid">' . implode("\n", $rows) . '</div>';
    }

    /**
     * @param array<string, mixed> $rx
     */
    private function buildMedicationRowsHtml(array $rx): string
    {
        $items = isset($rx['items']) && is_array($rx['items']) ? $rx['items'] : [];
        if ($items === []) {
            return '<tr><td colspan="3" style="color:#64748b;">Aucune ligne trouvée.</td></tr>';
        }

        $rows = [];
        foreach ($items as $item) {
            if (!is_array($item)) {
                continue;
            }

            $view = $this->buildMedicationViewModel($item);
            $nameHtml = '<div class="med-name">' . esc_html($view['label']) . '</div>';
            if ($view['meta'] !== '') {
                $nameHtml .= '<div class="med-meta">' . esc_html($view['meta']) . '</div>';
            }

            $rows[] = '<tr>'
                . '<td>' . $nameHtml . '</td>'
                . '<td><div class="med-posology">' . esc_html($view['posology']) . '</div></td>'
                . '<td><div class="med-duration">' . esc_html($view['duration']) . '</div></td>'
                . '</tr>';
        }

        return $rows !== []
            ? implode("\n", $rows)
            : '<tr><td colspan="3" style="color:#64748b;">Aucune ligne trouvée.</td></tr>';
    }

    /**
     * @param array<string, mixed> $rx
     */
    private function buildLegacyMedicationBlocksHtml(array $rx): string
    {
        $items = isset($rx['items']) && is_array($rx['items']) ? $rx['items'] : [];
        if ($items === []) {
            return '<div class="med-row"><div class="med-posology">Aucune ligne trouvée.</div></div>';
        }

        $blocks = [];
        foreach ($items as $item) {
            if (!is_array($item)) {
                continue;
            }

            $view = $this->buildMedicationViewModel($item);
            $detailParts = [];
            if ($view['posology'] !== '—') {
                $detailParts[] = 'Posologie : ' . $view['posology'];
            }
            if ($view['duration'] !== '—') {
                $detailParts[] = 'Durée : ' . $view['duration'];
            }
            if ($view['meta'] !== '') {
                $detailParts[] = $view['meta'];
            }
            if ($detailParts === []) {
                $detailParts[] = 'Sans précision complémentaire.';
            }

            $blocks[] = '<div class="med-row">'
                . '<table class="med-table" cellpadding="0" cellspacing="0">'
                . '<tr>'
                . '<td class="med-dot-cell"><div class="med-dot"></div></td>'
                . '<td>'
                . '<div class="med-name-wrap"><span class="med-name">' . esc_html($view['label']) . '</span></div>'
                . '<div class="med-posology">' . esc_html(implode(' — ', $detailParts)) . '</div>'
                . '</td>'
                . '</tr>'
                . '</table>'
                . '</div>';
        }

        return implode("\n", $blocks);
    }

    /**
     * @param array<string, mixed> $rx
     * @param array<string, mixed> $doctor
     */
    private function buildFooterBlockHtml(array $rx, string $reqId, ?string $jobId, string $verifyUrl, array $doctor): string
    {
        $parts = [];
        $uid = trim((string) ($rx['uid'] ?? ''));
        $verifyCode = trim((string) ($rx['verify_code'] ?? ''));
        $issued = $this->formatDateFr((string) ($rx['decided_at'] ?? ($rx['created_at'] ?? '')));

        if ($uid !== '') {
            $parts[] = '<div><strong>Dossier :</strong> ' . esc_html($uid) . '</div>';
        }
        if ($issued !== '') {
            $parts[] = '<div><strong>Date :</strong> ' . esc_html($issued) . '</div>';
        }
        if (!empty($doctor['rpps'])) {
            $parts[] = '<div><strong>RPPS :</strong> ' . esc_html((string) $doctor['rpps']) . '</div>';
        }
        if ($verifyCode !== '') {
            $parts[] = '<div><strong>Code délivrance :</strong> ' . esc_html($verifyCode) . '</div>';
        }
        if ($verifyUrl !== '') {
            $parts[] = '<div style="word-break:break-all;"><strong>Vérification :</strong> ' . esc_html($verifyUrl) . '</div>';
        }

        $parts[] = '<div style="margin-top:1.5mm;color:#64748b;font-size:8.5pt;">req_id=' . esc_html($reqId) . ($jobId ? ' — job_id=' . esc_html($jobId) : '') . '</div>';

        return implode("\n", $parts);
    }

    /**
     * @param array<string, mixed> $doctor
     * @param array<string, mixed> $rx
     */
    private function buildIssueLine(array $doctor, array $rx): string
    {
        $place = trim((string) ($doctor['issue_place'] ?? ''));
        $date = $this->formatDateFr((string) ($rx['decided_at'] ?? ($rx['created_at'] ?? '')));

        if ($place !== '' && $date !== '') {
            return $place . ', le ' . $date;
        }
        if ($date !== '') {
            return 'Émis le ' . $date;
        }

        return $place;
    }

    /**
     * @param array<string, mixed> $rx
     */
    private function buildVerificationUrl(array $rx): string
    {
        $token = trim((string) ($rx['verify_token'] ?? ''));
        if ($token === '') {
            return '';
        }

        return home_url('/v/' . rawurlencode($token));
    }

    private function buildQrDataUri(string $text): string
    {
        $text = trim($text);
        if ($text === '') {
            $text = 'SOS Prescription';
        }

        $dataUri = InlineQrSvg::dataUri($text);
        return $dataUri !== '' ? $dataUri : $this->blankImageDataUri();
    }

    /**
     * @param array<string, mixed> $doctor
     */
    private function buildSignatureDataUri(array $doctor): string
    {
        $doctorUserId = isset($doctor['user_id']) ? (int) $doctor['user_id'] : 0;
        if ($doctorUserId < 1) {
            return '';
        }

        $attachmentId = isset($doctor['signature_attachment_id']) ? (int) $doctor['signature_attachment_id'] : 0;
        if ($attachmentId > 0) {
            $attachmentPath = get_attached_file($attachmentId);
            if (is_string($attachmentPath) && $attachmentPath !== '' && is_file($attachmentPath)) {
                $bytes = @file_get_contents($attachmentPath);
                if (is_string($bytes) && $bytes !== '') {
                    $mime = get_post_mime_type($attachmentId);
                    if (!is_string($mime) || strpos($mime, 'image/') !== 0) {
                        $mime = 'image/png';
                    }
                    return 'data:' . $mime . ';base64,' . base64_encode($bytes);
                }
            }
        }

        $repo = new FileRepository();
        $fileId = isset($doctor['signature_file_id']) ? (int) $doctor['signature_file_id'] : 0;
        if ($fileId < 1) {
            $latest = $repo->find_latest_for_owner_purpose($doctorUserId, 'doctor_signature');
            if (!is_array($latest)) {
                $latest = $repo->find_latest_for_owner_purpose($doctorUserId, 'doctor_stamp');
            }
            if (is_array($latest)) {
                $fileId = (int) ($latest['id'] ?? 0);
            }
        }

        if ($fileId < 1) {
            return '';
        }

        $file = $repo->get($fileId);
        if (!is_array($file)) {
            return '';
        }

        $absPath = $repo->get_file_absolute_path($fileId);
        if (is_wp_error($absPath) || !is_string($absPath) || !is_file($absPath)) {
            return '';
        }

        $bytes = @file_get_contents($absPath);
        if (!is_string($bytes) || $bytes === '') {
            return '';
        }

        $mime = trim((string) ($file['mime'] ?? 'image/png'));
        if ($mime === '' || strpos($mime, 'image/') !== 0) {
            $mime = 'image/png';
        }

        return 'data:' . $mime . ';base64,' . base64_encode($bytes);
    }

    private function buildRppsBarcodeDataUri(array $doctor): string
    {
        $rpps = $this->sanitizeDigits((string) ($doctor['rpps'] ?? ''));
        if ($rpps === '') {
            return '';
        }

        return InlineCode39Svg::dataUri($rpps);
    }

    /**
     * @param array<string, mixed> $item
     * @return array{label:string,posology:string,duration:string,meta:string}
     */
    private function buildMedicationViewModel(array $item): array
    {
        $raw = isset($item['raw']) && is_array($item['raw']) ? $item['raw'] : [];
        $schedule = isset($raw['schedule']) && is_array($raw['schedule']) ? $raw['schedule'] : [];

        $label = trim((string) ($item['denomination'] ?? ($raw['label'] ?? 'Médicament')));
        if ($label === '') {
            $label = 'Médicament';
        }

        $posology = trim((string) ($item['posologie'] ?? ''));
        if ($posology === '' && $schedule !== []) {
            try {
                $posology = trim(Posology::schedule_to_text($schedule));
            } catch (\Throwable $e) {
                $posology = '';
            }
        }
        if ($posology === '') {
            $posology = '—';
        }

        $duration = trim((string) ($item['quantite'] ?? ''));
        if ($duration === '') {
            $duration = $this->extractDurationLabelFromSchedule($schedule);
        }
        if ($duration === '') {
            $duration = '—';
        }

        $metaParts = [];
        $cip13 = trim((string) ($item['cip13'] ?? ($raw['cip13'] ?? '')));
        if ($cip13 !== '') {
            $metaParts[] = 'CIP13 ' . $cip13;
        }
        $scheduleNote = trim((string) ($schedule['note'] ?? ($raw['note'] ?? '')));
        if ($scheduleNote !== '') {
            $metaParts[] = $scheduleNote;
        }

        return [
            'label' => $label,
            'posology' => $posology,
            'duration' => $duration,
            'meta' => implode(' — ', $metaParts),
        ];
    }

    /**
     * @param array<string, mixed> $schedule
     */
    private function extractDurationLabelFromSchedule(array $schedule): string
    {
        $value = isset($schedule['durationVal']) ? (int) $schedule['durationVal'] : 0;
        $unit = isset($schedule['durationUnit']) ? trim((string) $schedule['durationUnit']) : '';
        if ($value < 1 || $unit === '') {
            return '';
        }

        return $value . ' ' . $this->pluralizeDurationUnit($unit, $value);
    }

    private function pluralizeDurationUnit(string $unit, int $value): string
    {
        $unit = strtolower(trim($unit));
        if ($unit === '') {
            return '';
        }
        if ($value <= 1) {
            return $unit;
        }
        if ($unit === 'mois') {
            return 'mois';
        }
        return $unit . 's';
    }

    private function buildLabeledValueRowHtml(string $label, string $valueHtml, bool $allowHtml = false): string
    {
        $labelHtml = esc_html($label);
        $value = $allowHtml ? $valueHtml : esc_html($valueHtml);

        return '<div class="kv-row">'
            . '<div class="kv-label">' . $labelHtml . '</div>'
            . '<div class="kv-value">' . $value . '</div>'
            . '</div>';
    }

    /**
     * @param array<int, string> $keys
     */
    private function readUserMetaString(int $userId, array $keys): string
    {
        foreach ($keys as $key) {
            $value = get_user_meta($userId, $key, true);
            if (is_scalar($value)) {
                $value = trim((string) $value);
                if ($value !== '') {
                    return $value;
                }
            }
        }

        return '';
    }

    private function mapDoctorTitle(string $titleRaw): string
    {
        $titleRaw = strtolower(trim($titleRaw));
        if ($titleRaw === 'professeur' || $titleRaw === 'pr') {
            return 'Pr';
        }
        if ($titleRaw === 'docteur' || $titleRaw === 'dr' || $titleRaw === 'docteur en médecine') {
            return 'Dr';
        }
        return '';
    }

    private function sanitizeDigits(string $value): string
    {
        return preg_replace('/\D+/', '', $value) ?? '';
    }

    private function blankImageDataUri(): string
    {
        $svg = '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="72" viewBox="0 0 220 72"><rect width="220" height="72" fill="#ffffff" stroke="#d1d5db"/><line x1="18" y1="54" x2="202" y2="18" stroke="#94a3b8" stroke-width="2"/><text x="110" y="42" font-size="12" text-anchor="middle" fill="#64748b">Signature / QR</text></svg>';
        return 'data:image/svg+xml;base64,' . base64_encode($svg);
    }

    private function injectMetaAndReadiness(string $html, int $rxId, string $reqId, ?string $jobId, string $templateName): string
    {
        $meta = [];
        $meta[] = '<meta name="ml:req_id" content="' . esc_attr($reqId) . '">';
        $meta[] = '<meta name="ml:job_id" content="' . esc_attr((string) ($jobId ?? '')) . '">';
        $meta[] = '<meta name="ml:rx_id" content="' . esc_attr((string) $rxId) . '">';
        $meta[] = '<meta name="ml:template" content="' . esc_attr($templateName) . '">';

        $marker = "\n<!-- req_id: " . esc_html($reqId) . ' job_id: ' . esc_html((string) ($jobId ?? '')) . " -->\n";
        $marker .= '<div data-ml-pdf-ready="1" style="display:none"></div>' . "\n";
        $marker .= '<script>window.__ML_PDF_READY__ = true;</script>' . "\n";

        if (stripos($html, '</head>') !== false) {
            $html = preg_replace('/<\/head>/i', implode("\n", $meta) . "\n</head>", $html, 1) ?: $html;
        } else {
            $html = implode("\n", $meta) . "\n" . $html;
        }

        if (stripos($html, '</body>') !== false) {
            $html = preg_replace('/<\/body>/i', $marker . '</body>', $html, 1) ?: ($html . $marker);
        } else {
            $html .= $marker;
        }

        return $html;
    }

    private function formatDateFr(string $value): string
    {
        $value = trim($value);
        if ($value === '') {
            return '';
        }

        try {
            $dt = new \DateTimeImmutable($value);
            return $dt->format('d/m/Y');
        } catch (\Throwable $e) {
            return $value;
        }
    }
}
