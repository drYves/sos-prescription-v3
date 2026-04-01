<?php

declare(strict_types=1);

namespace SosPrescription\Frontend;

use SosPrescription\Db;
use SosPrescription\Repositories\FileRepository;
use SosPrescription\Repositories\PrescriptionRepository;
use SosPrescription\Services\ComplianceConfig;
use SosPrescription\Services\Logger;
use SosPrescription\Services\FileStorage;
use WP_Error;

/**
 * Public verification endpoint for pharmacists: /v/{token}
 *
 * Zero-PII mode:
 * - reads a local shadow record only
 * - never depends on legacy clear-text payloads
 * - uses the business cache (payload_json) + worker shadow metadata
 */
final class VerificationPage
{
    private const QUERY_VAR = 'sp_rx_verify_token';

    public static function register_hooks(): void
    {
        self::init();
    }

    public static function init(): void
    {
        add_action('init', [self::class, 'register_rewrite'], 9);
        add_filter('query_vars', [self::class, 'register_query_var']);
        add_action('template_redirect', [self::class, 'maybe_render']);
        add_action('admin_init', [self::class, 'maybe_flush_rewrite']);
    }

    public static function register_rewrite(): void
    {
        add_rewrite_rule(
            '^v/([A-Za-z0-9_-]{16,128})/?$',
            'index.php?' . self::QUERY_VAR . '=$matches[1]',
            'top'
        );
    }

    /**
     * @param string[] $vars
     * @return string[]
     */
    public static function register_query_var(array $vars): array
    {
        $vars[] = self::QUERY_VAR;
        return $vars;
    }

    public static function maybe_flush_rewrite(): void
    {
        if (!current_user_can('manage_options')) {
            return;
        }

        $key = 'sosprescription_rewrite_v';
        $expected = (string) (defined('SOSPRESCRIPTION_VERSION') ? SOSPRESCRIPTION_VERSION : '');
        if ($expected === '') {
            return;
        }

        $current = (string) get_option($key, '');
        if ($current === $expected) {
            return;
        }

        self::register_rewrite();
        flush_rewrite_rules(false);
        update_option($key, $expected, true);
    }

    public static function maybe_render(): void
    {
        $token = trim((string) get_query_var(self::QUERY_VAR, ''));
        if ($token === '') {
            return;
        }

        nocache_headers();
        header('X-Robots-Tag: noindex, nofollow', true);
        header('Referrer-Policy: no-referrer', true);
        header('X-Content-Type-Options: nosniff', true);

        $rx = self::find_prescription_by_verify_token($token);
        if (!is_array($rx) || empty($rx['id']) || !self::is_publicly_verifiable($rx)) {
            self::render_not_found();
        }

        $download = isset($_GET['download']) && (string) $_GET['download'] === '1';
        $view = isset($_GET['view']) && (string) $_GET['view'] === '1';
        if ($download || $view) {
            self::download_pdf($rx, $view);
        }

        $flash = [
            'success' => '',
            'error' => '',
        ];

        if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
            $flash = self::handle_dispense_post($rx);
            $refreshed = self::find_prescription_by_verify_token($token);
            if (is_array($refreshed) && !empty($refreshed['id'])) {
                $rx = $refreshed;
            }
        }

        self::render_page($rx, $flash);
    }

    /**
     * Lookup helper shared with the REST delivery endpoint.
     *
     * @return array<string,mixed>|null
     */
    public static function find_prescription_by_verify_token(string $token): ?array
    {
        $token = trim($token);
        if ($token === '' || preg_match('/^[A-Za-z0-9_-]{16,128}$/', $token) !== 1) {
            return null;
        }

        $repo = new PrescriptionRepository();
        $rx = $repo->get_by_verify_token($token);
        if (is_array($rx) && !empty($rx['id'])) {
            return $rx;
        }

        global $wpdb;
        $table = Db::table('prescriptions');

        $id = $wpdb->get_var($wpdb->prepare(
            "SELECT id FROM {$table} WHERE verify_token = %s LIMIT 1",
            $token
        ));

        if (!$id) {
            $likeSnake = '%' . $wpdb->esc_like('"verify_token":"' . $token . '"') . '%';
            $id = $wpdb->get_var($wpdb->prepare(
                "SELECT id FROM {$table} WHERE payload_json LIKE %s ORDER BY id DESC LIMIT 1",
                $likeSnake
            ));
        }

        if (!$id) {
            $likeCamel = '%' . $wpdb->esc_like('"verifyToken":"' . $token . '"') . '%';
            $id = $wpdb->get_var($wpdb->prepare(
                "SELECT id FROM {$table} WHERE payload_json LIKE %s ORDER BY id DESC LIMIT 1",
                $likeCamel
            ));
        }

        if (!$id) {
            return null;
        }

        return $repo->get((int) $id);
    }

    /**
     * @param array<string,mixed> $rx
     */
    public static function is_publicly_verifiable(array $rx): bool
    {
        $status = strtolower(trim((string) ($rx['status'] ?? '')));
        if ($status === 'approved') {
            return true;
        }

        $worker = self::extract_worker_shadow_state($rx);
        $workerStatus = strtoupper(trim((string) ($worker['status'] ?? '')));
        $processing = strtolower(trim((string) ($worker['processing_status'] ?? '')));
        $hasPdf = self::has_downloadable_pdf($rx);

        return $workerStatus === 'APPROVED'
            || $processing === 'done'
            || ($hasPdf && $workerStatus !== 'REJECTED');
    }

    private static function render_not_found(): void
    {
        status_header(404);
        header('Content-Type: text/html; charset=utf-8');
        echo '<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ordonnance introuvable</title></head><body class="sp-plugin-root sp-plugin-root--verify" data-sp-screen="verify" style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;padding:24px;color:#111827;">'
            . '<h1 style="font-size:18px;margin:0 0 8px;">Ordonnance introuvable</h1>'
            . '<p style="margin:0;color:#6b7280;">Le lien est invalide, l’ordonnance n’a pas encore été validée ou n’est plus disponible.</p>'
            . '</body></html>';
        exit;
    }

    /**
     * @param array<string,mixed> $rx
     */
    private static function download_pdf(array $rx, bool $inline = false): void
    {
        $token = (string) ($rx['verify_token'] ?? '');
        $tokenPrefix = $token !== '' ? substr($token, 0, 8) : '';
        $ipHash = self::ip_hash((string) ($_SERVER['REMOTE_ADDR'] ?? ''));
        $mode = $inline ? 'view' : 'download';

        Logger::ndjson_scoped('runtime', 'rx', 'info', $inline ? 'rx_pdf_view_attempt' : 'rx_pdf_download_attempt', [
            'actor' => 'pharmacien',
            'mode' => $mode,
            'rx_id' => isset($rx['id']) ? (int) $rx['id'] : null,
            'uid' => isset($rx['uid']) ? (string) $rx['uid'] : null,
            'token_prefix' => $tokenPrefix,
            'ip_hash' => $ipHash,
        ]);

        $presigned = self::resolve_presigned_pdf_url($rx);
        if (is_string($presigned) && $presigned !== '') {
            Logger::ndjson_scoped('runtime', 'rx', 'info', $inline ? 'rx_pdf_viewed' : 'rx_pdf_downloaded', [
                'actor' => 'pharmacien',
                'mode' => $mode,
                'rx_id' => isset($rx['id']) ? (int) $rx['id'] : null,
                'uid' => isset($rx['uid']) ? (string) $rx['uid'] : null,
                'token_prefix' => $tokenPrefix,
                'ip_hash' => $ipHash,
                'storage' => 's3',
            ]);
            wp_redirect($presigned, 302);
            exit;
        }

        $fileRepo = new FileRepository();
        $file = $fileRepo->find_latest_for_prescription_purpose((int) ($rx['id'] ?? 0), 'rx_pdf');
        if (!is_array($file) || empty($file['storage_key'])) {
            Logger::ndjson_scoped('runtime', 'rx', 'warn', $inline ? 'rx_pdf_view_missing' : 'rx_pdf_download_missing', [
                'actor' => 'pharmacien',
                'mode' => $mode,
                'rx_id' => isset($rx['id']) ? (int) $rx['id'] : null,
                'uid' => isset($rx['uid']) ? (string) $rx['uid'] : null,
                'token_prefix' => $tokenPrefix,
                'ip_hash' => $ipHash,
                'storage' => 'local_missing',
            ]);
            self::render_not_found();
        }

        $abs = FileStorage::safe_abs_path((string) $file['storage_key']);
        if ($abs === '' || !is_file($abs)) {
            Logger::ndjson_scoped('runtime', 'rx', 'warn', $inline ? 'rx_pdf_view_missing' : 'rx_pdf_download_missing', [
                'actor' => 'pharmacien',
                'mode' => $mode,
                'rx_id' => isset($rx['id']) ? (int) $rx['id'] : null,
                'uid' => isset($rx['uid']) ? (string) $rx['uid'] : null,
                'token_prefix' => $tokenPrefix,
                'ip_hash' => $ipHash,
                'storage' => 'local_unreadable',
            ]);
            self::render_not_found();
        }

        while (ob_get_level()) {
            @ob_end_clean();
        }

        nocache_headers();
        header('X-Robots-Tag: noindex, nofollow, noarchive', true);
        header('X-Content-Type-Options: nosniff', true);

        $uid = (string) ($rx['uid'] ?? 'rx');
        $safeUid = preg_replace('/[^A-Za-z0-9_-]+/', '-', $uid);
        if (!is_string($safeUid) || $safeUid === '') {
            $safeUid = 'rx';
        }

        header('Content-Type: application/pdf');
        header('Content-Disposition: ' . ($inline ? 'inline' : 'attachment') . '; filename="Ordonnance-' . $safeUid . '.pdf"');
        header('Content-Length: ' . (string) filesize($abs));

        Logger::ndjson_scoped('runtime', 'rx', 'info', $inline ? 'rx_pdf_viewed' : 'rx_pdf_downloaded', [
            'actor' => 'pharmacien',
            'mode' => $mode,
            'rx_id' => isset($rx['id']) ? (int) $rx['id'] : null,
            'uid' => isset($rx['uid']) ? (string) $rx['uid'] : null,
            'token_prefix' => $tokenPrefix,
            'ip_hash' => $ipHash,
            'storage' => 'local',
        ]);

        readfile($abs);
        exit;
    }

    /**
     * @param array<string,mixed> $rx
     * @return array{success:string,error:string}
     */
    private static function handle_dispense_post(array $rx): array
    {
        $out = ['success' => '', 'error' => ''];

        $nonce = isset($_POST['_wpnonce']) ? (string) $_POST['_wpnonce'] : '';
        if (!wp_verify_nonce($nonce, 'sosprescription_dispense')) {
            $out['error'] = 'Requête invalide. Merci de réessayer.';
            return $out;
        }

        if (!self::is_publicly_verifiable($rx)) {
            $out['error'] = 'Ordonnance non disponible pour la délivrance.';
            return $out;
        }

        $rxId = (int) ($rx['id'] ?? 0);
        $token = (string) ($rx['verify_token'] ?? '');
        $tokenPrefix = $token !== '' ? substr($token, 0, 8) : '';
        $ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
        $ipHash = self::ip_hash($ip);

        $expectedCode = (string) ($rx['verify_code'] ?? '');
        $enteredRaw = isset($_POST['dispense_code']) ? (string) $_POST['dispense_code'] : '';
        $entered = preg_replace('/\D+/', '', $enteredRaw);
        $entered = is_string($entered) ? $entered : '';

        if ($entered === '' || strlen($entered) !== 6) {
            $out['error'] = 'Veuillez saisir le code de délivrance à 6 chiffres.';
            return $out;
        }

        $attemptKey = 'sp_dispense_' . md5($token . '|' . $ipHash);
        $attempts = (int) get_transient($attemptKey);
        if ($attempts >= 10) {
            Logger::ndjson_scoped('runtime', 'rx', 'warn', 'rx_delivery_attempt', [
                'rx_id' => $rxId,
                'token_prefix' => $tokenPrefix,
                'code_ok' => false,
                'blocked' => true,
                'reason' => 'too_many_attempts_post',
            ]);
            $out['error'] = 'Trop de tentatives. Merci de réessayer plus tard.';
            return $out;
        }

        if ($expectedCode === '' || !hash_equals($expectedCode, $entered)) {
            $attemptsNext = $attempts + 1;
            set_transient($attemptKey, $attemptsNext, HOUR_IN_SECONDS);
            Logger::ndjson_scoped('runtime', 'rx', 'warn', 'rx_delivery_attempt', [
                'rx_id' => $rxId,
                'token_prefix' => $tokenPrefix,
                'code_ok' => false,
                'attempts' => $attemptsNext,
                'flow' => 'post',
            ]);
            $out['error'] = 'Code incorrect.';
            return $out;
        }

        if (!empty($rx['dispensed_at'])) {
            Logger::ndjson_scoped('runtime', 'rx', 'info', 'rx_delivery_attempt', [
                'rx_id' => $rxId,
                'token_prefix' => $tokenPrefix,
                'already_dispensed' => true,
                'flow' => 'post',
            ]);
            $out['success'] = 'Cette ordonnance est déjà marquée comme délivrée.';
            return $out;
        }

        $repo = new PrescriptionRepository();
        $ok = $repo->mark_dispensed($rxId, $ipHash);
        if (!$ok) {
            Logger::ndjson_scoped('runtime', 'rx', 'error', 'rx_delivery_error', [
                'rx_id' => $rxId,
                'token_prefix' => $tokenPrefix,
                'flow' => 'post',
            ]);
            $out['error'] = 'Impossible d’enregistrer la délivrance. Merci de réessayer.';
            return $out;
        }

        delete_transient($attemptKey);
        Logger::ndjson_scoped('runtime', 'rx', 'info', 'rx_delivered', [
            'rx_id' => $rxId,
            'token_prefix' => $tokenPrefix,
            'flow' => 'post',
        ]);
        $out['success'] = 'Délivrance enregistrée.';

        return $out;
    }

    private static function ip_hash(string $ip): string
    {
        $salt = (string) wp_salt('auth');
        return hash_hmac('sha256', $ip, $salt);
    }

    /**
     * @param array<string,mixed> $rx
     * @param array{success:string,error:string} $flash
     */
    private static function render_page(array $rx, array $flash): void
    {
        $cfg = new ComplianceConfig();
        $product = $cfg->get_product_name();
        $vm = self::build_public_view_model($rx);

        $token = (string) ($rx['verify_token'] ?? '');
        $baseUrl = home_url('/v/' . rawurlencode($token));
        $downloadUrl = add_query_arg(['download' => '1'], $baseUrl);
        $viewUrl = add_query_arg(['view' => '1'], $baseUrl);

        $flashHtml = '';
        if ($flash['success'] !== '') {
            $flashHtml = '<div class="alert ok">' . esc_html($flash['success']) . '</div>';
        } elseif ($flash['error'] !== '') {
            $flashHtml = '<div class="alert err">' . esc_html($flash['error']) . '</div>';
        }

        $dispenseBadgeHtml = !empty($rx['dispensed_at'])
            ? '<span class="badge valid"><span class="dot"></span>Délivrée</span>'
            : '<span class="badge warn"><span class="dot"></span>Non délivrée</span>';

        $patientWeightRowHtml = '';
        if ($vm['patient_weight'] !== '') {
            $patientWeightRowHtml = '<div class="row"><div class="k">Poids</div><div class="v">' . esc_html($vm['patient_weight']) . '</div></div>';
        }

        $displayUrl = preg_replace('#^https?://#', '', $baseUrl);
        if ($displayUrl === null || $displayUrl === '') {
            $displayUrl = $baseUrl;
        }
        if (strlen($displayUrl) > 42) {
            $displayUrl = substr($displayUrl, 0, 22) . '…' . substr($displayUrl, -10);
        }

        $metaRowsHtml = '';
        $metaRowsHtml .= '<div class="row"><div class="k">Vérification</div><div class="v"><code>' . esc_html($displayUrl) . '</code></div></div>';
        $metaRowsHtml .= '<div class="row"><div class="k">Identifiant</div><div class="v"><code>' . esc_html($vm['uid']) . '</code></div></div>';
        $metaRowsHtml .= '<div class="row"><div class="k">Empreinte</div><div class="v"><code>' . esc_html($vm['hash_short']) . '</code></div></div>';
        $metaRowsHtml .= '<div class="row"><div class="k">Code délivrance</div><div class="v"><strong>' . esc_html($vm['verify_code']) . '</strong></div></div>';

        if (self::has_downloadable_pdf($rx)) {
            $pdfActionsHtml =
                '<a class="btn primary" href="' . esc_url($downloadUrl) . '">' .
                '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>' .
                'Télécharger le PDF</a>' .
                '<a class="btn secondary" href="' . esc_url($viewUrl) . '" target="_blank" rel="noopener">' .
                '<svg viewBox="0 0 24 24" fill="none" stroke="var(--blue)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5C7 5 2.73 8.11 1 12c1.73 3.89 6 7 11 7s9.27-3.11 11-7c-1.73-3.89-6-7-11-7z"/><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/></svg>' .
                'Afficher le PDF</a>';
        } else {
            $pdfActionsHtml =
                '<span class="btn primary disabled">Télécharger le PDF</span>' .
                '<span class="btn secondary disabled">Afficher le PDF</span>' .
                '<div class="note">PDF indisponible (non généré ou non synchronisé).</div>';
        }

        $dispenseSectionHtml = '<div class="dispense-box">';
        $dispenseSectionHtml .= '<div class="dispense-title">Statut de délivrance</div>';
        if (!empty($rx['dispensed_at'])) {
            $dispenseSectionHtml .= '<div class="dispense-sub">Délivrance confirmée. Cette ordonnance a déjà été marquée comme délivrée.</div>';
        } else {
            $dispenseSectionHtml .= '<div class="dispense-sub">Pour éviter les doubles délivrances, validez avec le code imprimé sur l’ordonnance.</div>';
            $dispenseSectionHtml .= '<button type="button" class="btn secondary" id="sp-dispense-open">Marquer comme délivrée</button>';
            $dispenseSectionHtml .= '<form method="post" class="dispense-form" id="sp-dispense-form" style="display:none;">';
            $dispenseSectionHtml .= wp_nonce_field('sosprescription_dispense', '_wpnonce', true, false);
            $dispenseSectionHtml .= '<input type="text" name="dispense_code" id="sp-dispense-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="Code à 6 chiffres" aria-label="Code de délivrance" required>';
            $dispenseSectionHtml .= '<button type="submit" class="btn primary" id="sp-dispense-submit">Confirmer la délivrance</button>';
            $dispenseSectionHtml .= '</form>';
            $dispenseSectionHtml .= '<div class="mini">Le code est imprimé sur l’ordonnance (PDF). Ne pas le partager.</div>';
        }
        $dispenseSectionHtml .= '</div>';

        $medListHtml = self::build_med_list_html($rx);

        header('Content-Type: text/html; charset=utf-8');

        $templatePath = self::active_template_path();
        $templateHtml = is_readable($templatePath) ? (string) file_get_contents($templatePath) : '';
        if ($templateHtml === '') {
            echo '<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Vérification</title></head><body class="sp-plugin-root sp-plugin-root--verify" data-sp-screen="verify">';
            echo '<h1>Ordonnance vérifiée</h1>';
            echo '<p>Patient : ' . esc_html($vm['patient_name']) . ' • ' . esc_html($vm['patient_birth']) . '</p>';
            echo $medListHtml;
            echo '</body></html>';
            exit;
        }

        $html = self::render_template($templateHtml, [
            '{{PRODUCT}}' => esc_html($product),
            '{{DISPENSE_BADGE_HTML}}' => $dispenseBadgeHtml,
            '{{RX_BADGE}}' => esc_html($vm['rx_badge']),
            '{{SCAN_REF}}' => esc_html($vm['scan_ref']),
            '{{UPDATED_LABEL}}' => esc_html($vm['updated_label']),
            '{{FLASH_HTML}}' => $flashHtml,
            '{{DOCTOR_LABEL}}' => esc_html($vm['doctor_label']),
            '{{PATIENT_NAME}}' => esc_html($vm['patient_name']),
            '{{PATIENT_BIRTH}}' => esc_html($vm['patient_birth']),
            '{{PATIENT_WEIGHT_ROW_HTML}}' => $patientWeightRowHtml,
            '{{ISSUED_LABEL}}' => esc_html($vm['issued_label']),
            '{{DISPENSE_LABEL}}' => esc_html($vm['dispense_label']),
            '{{MED_COUNT}}' => esc_html((string) $vm['med_count']),
            '{{META_ROWS_HTML}}' => $metaRowsHtml,
            '{{PDF_ACTIONS_HTML}}' => $pdfActionsHtml,
            '{{DISPENSE_SECTION_HTML}}' => $dispenseSectionHtml,
            '{{MED_LIST_HTML}}' => $medListHtml,
            '{{HASH_SHORT}}' => esc_html($vm['hash_short']),
        ]);

        $html = self::decorate_verify_html($html);

        echo $html; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
        exit;
    }

    /**
     * @param array<string,mixed> $rx
     * @return array<string,string|int>
     */
    private static function build_public_view_model(array $rx): array
    {
        $payload = self::safe_payload($rx);
        $patient = isset($payload['patient']) && is_array($payload['patient']) ? $payload['patient'] : [];
        $worker = self::extract_worker_shadow_state($rx);

        $token = (string) ($rx['verify_token'] ?? '');
        $fullname = self::first_non_empty([
            isset($patient['fullname']) ? (string) $patient['fullname'] : '',
            isset($patient['name']) ? (string) $patient['name'] : '',
            isset($payload['patient_name']) ? (string) $payload['patient_name'] : '',
            isset($rx['patient_name']) ? (string) $rx['patient_name'] : '',
        ]);
        $birthDate = self::first_non_empty([
            isset($patient['birthdate']) ? (string) $patient['birthdate'] : '',
            isset($patient['birthDate']) ? (string) $patient['birthDate'] : '',
            isset($payload['patient_birthdate']) ? (string) $payload['patient_birthdate'] : '',
            isset($rx['patient_birthdate']) ? (string) $rx['patient_birthdate'] : '',
        ]);
        $weightRaw = self::first_non_empty([
            isset($patient['weight_label']) ? (string) $patient['weight_label'] : '',
            isset($patient['weight_kg']) ? (string) $patient['weight_kg'] : '',
            isset($patient['weightKg']) ? (string) $patient['weightKg'] : '',
        ]);

        $issuedAt = self::first_non_empty([
            isset($rx['decided_at']) ? (string) $rx['decided_at'] : '',
            isset($rx['created_at']) ? (string) $rx['created_at'] : '',
        ]);
        $updatedAt = self::first_non_empty([
            isset($rx['updated_at']) ? (string) $rx['updated_at'] : '',
            isset($worker['last_sync_at']) ? (string) $worker['last_sync_at'] : '',
        ]);
        $dispensedAt = isset($rx['dispensed_at']) ? (string) $rx['dispensed_at'] : '';

        return [
            'doctor_label' => self::build_doctor_label($rx),
            'patient_name' => self::mask_patient_name($fullname),
            'patient_birth' => self::format_birthdate_label($birthDate),
            'patient_weight' => self::format_weight_label($weightRaw),
            'issued_label' => self::format_datetime_label($issuedAt),
            'updated_label' => self::format_datetime_label($updatedAt),
            'dispense_label' => $dispensedAt !== '' ? 'Délivrée le ' . self::format_datetime_label($dispensedAt) : 'Non renseigné',
            'verify_code' => (string) ($rx['verify_code'] ?? '—'),
            'med_count' => self::count_med_items($rx),
            'scan_ref' => 'V-' . strtoupper(substr(hash('sha256', $token), 0, 6)),
            'rx_badge' => (string) ($rx['uid'] ?? ('#' . (string) ($rx['id'] ?? ''))),
            'uid' => (string) ($rx['uid'] ?? '—'),
            'hash_short' => substr(hash('sha256', $token), 0, 4) . '…' . substr(hash('sha256', $token), -4),
        ];
    }

    /**
     * @param array<string,mixed> $rx
     */
    private static function build_doctor_label(array $rx): string
    {
        $doctorUserId = isset($rx['doctor_user_id']) ? (int) $rx['doctor_user_id'] : 0;
        if ($doctorUserId > 0) {
            $user = get_userdata($doctorUserId);
            $first = '';
            $last = '';
            $display = '';
            if ($user instanceof \WP_User) {
                $display = trim((string) $user->display_name);
                $first = trim((string) get_user_meta($doctorUserId, 'first_name', true));
                $last = trim((string) get_user_meta($doctorUserId, 'last_name', true));
            }
            $name = trim(($first !== '' || $last !== '') ? ($first . ' ' . $last) : $display);
            if ($name === '') {
                $name = 'Médecin validateur';
            }
            $rpps = trim((string) get_user_meta($doctorUserId, 'sosprescription_rpps', true));
            if ($rpps === '') {
                $rpps = trim((string) get_user_meta($doctorUserId, 'rpps', true));
            }
            if ($rpps !== '') {
                $name .= ' • RPPS ' . preg_replace('/\D+/', '', $rpps);
            }
            return $name;
        }

        return 'Médecin validateur';
    }

    /**
     * @param array<string,mixed> $rx
     */
    private static function build_med_list_html(array $rx): string
    {
        $items = isset($rx['items']) && is_array($rx['items']) ? $rx['items'] : [];
        if ($items === []) {
            return '<div class="note">Aucun médicament.</div>';
        }

        $html = '<ul class="rx-list">';
        foreach ($items as $it) {
            if (!is_array($it)) {
                continue;
            }
            $name = trim((string) ($it['bdpm_name'] ?? $it['denomination'] ?? $it['label'] ?? ''));
            if ($name === '') {
                $name = 'Médicament';
            }
            $detail = trim((string) ($it['posologie'] ?? $it['quantite'] ?? ''));
            if ($detail === '' && isset($it['schedule']) && is_array($it['schedule'])) {
                $detail = self::schedule_to_text($it['schedule']);
            }
            if ($detail === '') {
                $detail = '—';
            }
            $html .= '<li class="rx-item">';
            $html .= '<div class="bullet" aria-hidden="true"></div>';
            $html .= '<div>';
            $html .= '<div><strong>' . esc_html($name) . '</strong></div>';
            $html .= '<div class="detail">' . esc_html($detail) . '</div>';
            $html .= '</div>';
            $html .= '</li>';
        }
        $html .= '</ul>';

        return $html;
    }

    /**
     * @param array<string,mixed> $schedule
     */
    private static function schedule_to_text(array $schedule): string
    {
        $note = trim((string) ($schedule['note'] ?? $schedule['text'] ?? $schedule['label'] ?? ''));
        if ($note !== '') {
            return $note;
        }

        $parts = [];
        foreach ([['morning', 'matin'], ['noon', 'midi'], ['evening', 'soir'], ['bedtime', 'coucher']] as [$key, $label]) {
            $n = isset($schedule[$key]) ? (int) $schedule[$key] : 0;
            if ($n > 0) {
                $parts[] = $label . ': ' . $n;
            }
        }

        $everyHours = isset($schedule['everyHours']) ? (int) $schedule['everyHours'] : 0;
        if ($everyHours > 0) {
            $parts[] = 'Toutes les ' . $everyHours . ' h';
        }

        $timesPerDay = isset($schedule['timesPerDay']) ? (int) $schedule['timesPerDay'] : 0;
        if ($timesPerDay > 0) {
            $parts[] = $timesPerDay . ' prise' . ($timesPerDay > 1 ? 's' : '') . ' / jour';
        }

        if (!empty($schedule['asNeeded'])) {
            $parts[] = 'si besoin';
        }

        return implode(' — ', $parts);
    }

    /**
     * @param array<string,mixed> $rx
     */
    private static function has_downloadable_pdf(array $rx): bool
    {
        $worker = self::extract_worker_shadow_state($rx);
        $s3KeyRef = trim((string) ($worker['s3_key_ref'] ?? ''));
        if ($s3KeyRef !== '') {
            return true;
        }

        $fileRepo = new FileRepository();
        $file = $fileRepo->find_latest_for_prescription_purpose((int) ($rx['id'] ?? 0), 'rx_pdf');
        return is_array($file) && !empty($file['storage_key']);
    }

    /**
     * @param array<string,mixed> $rx
     */
    private static function resolve_presigned_pdf_url(array $rx): string
    {
        $worker = self::extract_worker_shadow_state($rx);
        $s3KeyRef = trim((string) ($worker['s3_key_ref'] ?? ''));
        if ($s3KeyRef === '') {
            return '';
        }

        $bucket = trim((string) ($worker['s3_bucket'] ?? ''));
        $region = trim((string) ($worker['s3_region'] ?? ''));

        $presigned = self::build_presigned_s3_url_from_job([
            's3_key_ref' => $s3KeyRef,
            's3_bucket' => $bucket,
            's3_region' => $region,
        ], 300);

        return !is_wp_error($presigned) && is_string($presigned) ? $presigned : '';
    }

    /**
     * @param array<string,mixed> $row
     * @return array<string,mixed>
     */
    private static function extract_worker_shadow_state(array $row): array
    {
        $payload = self::safe_payload($row);
        return isset($payload['worker']) && is_array($payload['worker']) ? $payload['worker'] : [];
    }

    /**
     * @param array<string,mixed> $row
     * @return array<string,mixed>
     */
    private static function safe_payload(array $row): array
    {
        if (isset($row['payload']) && is_array($row['payload'])) {
            return $row['payload'];
        }

        if (isset($row['payload_json']) && is_string($row['payload_json']) && $row['payload_json'] !== '') {
            $decoded = json_decode($row['payload_json'], true);
            if (is_array($decoded)) {
                return $decoded;
            }
        }

        return [];
    }


private static function decorate_verify_html(string $html): string
{
    if ($html === '') {
        return $html;
    }

    if (stripos($html, 'sp-plugin-root--verify') === false) {
        $html = preg_replace_callback(
            '/<body\b([^>]*)>/i',
            static function (array $matches): string {
                $attrs = isset($matches[1]) ? (string) $matches[1] : '';

                if (preg_match('/\bclass=(["\'])(.*?)\1/i', $attrs, $classMatch) === 1) {
                    $existing = trim((string) ($classMatch[2] ?? ''));
                    $augmented = trim($existing . ' sp-plugin-root sp-plugin-root--verify');
                    $attrs = preg_replace('/\bclass=(["\'])(.*?)\1/i', 'class="' . esc_attr($augmented) . '"', $attrs, 1) ?? $attrs;
                } else {
                    $attrs .= ' class="sp-plugin-root sp-plugin-root--verify"';
                }

                if (stripos($attrs, 'data-sp-screen=') === false) {
                    $attrs .= ' data-sp-screen="verify"';
                }

                return '<body' . $attrs . '>';
            },
            $html,
            1
        ) ?? $html;
    }

    if (stripos($html, 'sp-plugin-shell--verify') === false) {
        $opened = false;
        $html = preg_replace(
            '/<div class="container">/i',
            '<div class="sp-plugin-shell sp-plugin-shell--verify"><div class="container">',
            $html,
            1,
            $count
        ) ?? $html;
        $opened = isset($count) && (int) $count > 0;

        if ($opened) {
            $html = preg_replace('/<\/body>/i', '</div></body>', $html, 1) ?? $html;
        }
    }

    return $html;
}

    private static function default_template_path(): string
    {
        return rtrim((string) SOSPRESCRIPTION_PATH, '/') . '/templates/verification-pharmacien.html';
    }

    private static function override_template_path(): string
    {
        $uploads = wp_upload_dir();
        $dir = rtrim((string) ($uploads['basedir'] ?? ''), '/') . '/sosprescription-templates';
        return $dir . '/verification-pharmacien.html';
    }

    private static function active_template_path(): string
    {
        $override = self::override_template_path();
        if (is_readable($override)) {
            return $override;
        }

        return self::default_template_path();
    }

    /**
     * @param array<string,string> $map
     */
    private static function render_template(string $template_html, array $map): string
    {
        return strtr($template_html, $map);
    }

    private static function mask_patient_name(string $fullName): string
    {
        $clean = trim(preg_replace('/\s+/u', ' ', wp_strip_all_tags($fullName, true)) ?? '');
        if ($clean === '') {
            return 'Patient masqué';
        }

        $parts = preg_split('/\s+/u', $clean) ?: [];
        $parts = array_values(array_filter(array_map('trim', $parts), static fn (string $part): bool => $part !== ''));
        if ($parts === []) {
            return 'Patient masqué';
        }

        $masked = [];
        foreach ($parts as $part) {
            $first = function_exists('mb_substr') ? mb_substr($part, 0, 1, 'UTF-8') : substr($part, 0, 1);
            $upper = function_exists('mb_strtoupper') ? mb_strtoupper((string) $first, 'UTF-8') : strtoupper((string) $first);
            $masked[] = $upper . '***';
        }

        return implode(' ', $masked);
    }

    private static function format_birthdate_label(string $value): string
    {
        $raw = trim($value);
        if ($raw === '') {
            return '—';
        }

        $ts = strtotime($raw);
        if ($ts === false) {
            return $raw;
        }

        return gmdate('d/m/Y', $ts);
    }

    private static function format_datetime_label(string $value): string
    {
        $raw = trim($value);
        if ($raw === '') {
            return '—';
        }

        $ts = strtotime($raw);
        if ($ts === false) {
            return $raw;
        }

        return gmdate('d/m/Y H:i', $ts);
    }

    private static function format_weight_label(string $value): string
    {
        $raw = trim($value);
        if ($raw === '') {
            return '';
        }

        $normalized = str_replace(',', '.', $raw);
        if (is_numeric($normalized)) {
            $num = (float) $normalized;
            $rounded = round($num, 1);
            $display = fmod($rounded, 1.0) === 0.0 ? (string) (int) $rounded : str_replace('.', ',', (string) $rounded);
            return $display . ' kg';
        }

        return $raw;
    }

    /**
     * @param array<string,mixed> $rx
     */
    private static function count_med_items(array $rx): int
    {
        $items = isset($rx['items']) && is_array($rx['items']) ? $rx['items'] : [];
        $count = 0;
        foreach ($items as $it) {
            if (is_array($it)) {
                $count++;
            }
        }
        return $count;
    }

    /**
     * @param array<string,mixed> $job
     * @return string|WP_Error
     */
    private static function build_presigned_s3_url_from_job(array $job, int $ttl = 60)
    {
        $ttl = max(1, min(604800, $ttl));

        $key = !empty($job['s3_key_ref']) ? (string) $job['s3_key_ref'] : '';
        $bucket = !empty($job['s3_bucket']) ? (string) $job['s3_bucket'] : self::get_env_or_constant('SOSPRESCRIPTION_S3_BUCKET');
        $region = !empty($job['s3_region']) ? (string) $job['s3_region'] : self::get_env_or_constant('SOSPRESCRIPTION_S3_REGION', self::get_env_or_constant('AWS_REGION'));
        $endpoint = self::get_env_or_constant('SOSPRESCRIPTION_S3_ENDPOINT', self::get_env_or_constant('AWS_ENDPOINT_URL_S3'));

        if ($key === '' || $bucket === '' || $region === '') {
            return new WP_Error('sosprescription_s3_config_missing', 'Erreur de configuration S3.', ['status' => 500]);
        }

        $credentials = self::resolve_s3_credentials();
        if (is_wp_error($credentials)) {
            return $credentials;
        }

        $amzDate = gmdate('Ymd\THis\Z');
        $date = gmdate('Ymd');
        $scope = $date . '/' . $region . '/s3/aws4_request';
        $usePathStyle = ($endpoint !== '' || strpos($bucket, '.') !== false);

        if ($endpoint !== '') {
            $parsed = wp_parse_url($endpoint);
            $scheme = !empty($parsed['scheme']) ? (string) $parsed['scheme'] : 'https';
            $host = !empty($parsed['host']) ? (string) $parsed['host'] : '';
            $basePath = !empty($parsed['path']) ? rtrim((string) $parsed['path'], '/') : '';
            if ($host === '') {
                return new WP_Error('sosprescription_s3_endpoint_invalid', 'Endpoint S3 invalide.', ['status' => 500]);
            }
            $canonicalUri = $basePath . '/' . self::aws_uri_encode($bucket) . '/' . self::aws_uri_encode_path($key);
            $urlBase = $scheme . '://' . $host;
        } elseif ($usePathStyle) {
            $host = 's3.' . $region . '.amazonaws.com';
            $canonicalUri = '/' . self::aws_uri_encode($bucket) . '/' . self::aws_uri_encode_path($key);
            $urlBase = 'https://' . $host;
        } else {
            $host = $bucket . '.s3.' . $region . '.amazonaws.com';
            $canonicalUri = '/' . self::aws_uri_encode_path($key);
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

        $canonicalQuery = self::aws_build_query($query);
        $canonicalHeaders = 'host:' . $host . "\n";
        $signedHeaders = 'host';
        $canonicalRequest = "GET\n{$canonicalUri}\n{$canonicalQuery}\n{$canonicalHeaders}\n{$signedHeaders}\nUNSIGNED-PAYLOAD";
        $stringToSign = "AWS4-HMAC-SHA256\n{$amzDate}\n{$scope}\n" . hash('sha256', $canonicalRequest);
        $signingKey = self::aws_signing_key($credentials['secret_key'], $date, $region, 's3');
        $signature = hash_hmac('sha256', $stringToSign, $signingKey);

        return $urlBase . $canonicalUri . '?' . $canonicalQuery . '&X-Amz-Signature=' . $signature;
    }

    /**
     * @return array{access_key:string,secret_key:string,session_token:string}|WP_Error
     */
    private static function resolve_s3_credentials(): array|WP_Error
    {
        $accessKey = self::get_env_or_constant('SOSPRESCRIPTION_S3_ACCESS_KEY', self::get_env_or_constant('AWS_ACCESS_KEY_ID'));
        $secretKey = self::get_env_or_constant('SOSPRESCRIPTION_S3_SECRET_KEY', self::get_env_or_constant('AWS_SECRET_ACCESS_KEY'));
        $session = self::get_env_or_constant('SOSPRESCRIPTION_S3_SESSION_TOKEN', self::get_env_or_constant('AWS_SESSION_TOKEN'));

        if ($accessKey === '' || $secretKey === '') {
            return new WP_Error('sosprescription_s3_credentials_missing', 'Erreur de configuration S3.', ['status' => 500]);
        }

        return [
            'access_key' => $accessKey,
            'secret_key' => $secretKey,
            'session_token' => $session,
        ];
    }

    private static function get_env_or_constant(string $name, string $default = ''): string
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

    private static function aws_signing_key(string $secret, string $date, string $region, string $service): string
    {
        $kDate = hash_hmac('sha256', $date, 'AWS4' . $secret, true);
        $kRegion = hash_hmac('sha256', $region, $kDate, true);
        $kService = hash_hmac('sha256', $service, $kRegion, true);
        return hash_hmac('sha256', 'aws4_request', $kService, true);
    }

    /**
     * @param array<string,string> $params
     */
    private static function aws_build_query(array $params): string
    {
        ksort($params);
        $pairs = [];
        foreach ($params as $key => $value) {
            $pairs[] = self::aws_uri_encode($key) . '=' . self::aws_uri_encode((string) $value);
        }
        return implode('&', $pairs);
    }

    private static function aws_uri_encode_path(string $value): string
    {
        $segments = explode('/', ltrim($value, '/'));
        $encoded = [];
        foreach ($segments as $segment) {
            $encoded[] = self::aws_uri_encode($segment);
        }
        return implode('/', $encoded);
    }

    private static function aws_uri_encode(string $value): string
    {
        return str_replace('%7E', '~', rawurlencode($value));
    }

    /**
     * @param array<int,string> $values
     */
    private static function first_non_empty(array $values): string
    {
        foreach ($values as $value) {
            $value = trim((string) $value);
            if ($value !== '') {
                return $value;
            }
        }
        return '';
    }
}
