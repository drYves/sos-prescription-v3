<?php

declare(strict_types=1);

namespace SosPrescription\Frontend;

use SosPrescription\Repositories\PrescriptionRepository;
use SosPrescription\Repositories\FileRepository;
use SosPrescription\Services\FileStorage;
use SosPrescription\Services\ComplianceConfig;
use SosPrescription\Services\Logger;

/**
 * Public verification endpoint for pharmacists: /v/{token}
 *
 * - No authentication.
 * - Token is a long random string stored on the prescription.
 * - Allows downloading the PDF and (optionally) marking as dispensed using a 6-digit code.
 */
final class VerificationPage
{
    private const QUERY_VAR = 'sp_rx_verify_token';

    /**
     * Backward-compatible hook registrar.
     *
     * The plugin bootstrap uses a "register_hooks" naming convention for
     * services. This page historically exposed "init()".
     * Provide both to prevent fatal errors during upgrades.
     */
    public static function register_hooks(): void
    {
        self::init();
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
     * Remplace les placeholders {{TOKEN}} dans le template HTML.
     *
     * @param array<string,string> $map
     */
    private static function render_template(string $template_html, array $map): string
    {
        // strtr est plus rapide et évite certains effets de cascade.
        return strtr($template_html, $map);
    }

    public static function init(): void
    {
        add_action('init', [self::class, 'register_rewrite'], 9);
        add_filter('query_vars', [self::class, 'register_query_var']);
        add_action('template_redirect', [self::class, 'maybe_render']);

        // Flush rewrite once after update (admin only).
        add_action('admin_init', [self::class, 'maybe_flush_rewrite']);
    }

    /**
     * /v/{token}
     */
    public static function register_rewrite(): void
    {
        add_rewrite_rule(
            '^v/([A-Za-z0-9_-]{16,64})/?$',
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

        // Ensure rule is registered.
        self::register_rewrite();
        flush_rewrite_rules(false);
        update_option($key, $expected, true);
    }

    public static function maybe_render(): void
    {
        $token = (string) get_query_var(self::QUERY_VAR, '');
        if ($token === '') {
            return;
        }

        // Hard security headers.
        nocache_headers();
        header('X-Robots-Tag: noindex, nofollow', true);
        header('Referrer-Policy: no-referrer', true);
        header('X-Content-Type-Options: nosniff', true);

        $repo = new PrescriptionRepository();
        $rx = $repo->get_by_verify_token($token);
        if (!$rx) {
            self::render_not_found();
        }

        // Only approved prescriptions should be verifiable.
        $status = isset($rx['status']) ? (string) $rx['status'] : '';
        if ($status !== 'approved') {
            self::render_not_found();
        }

        // PDF download / view.
        $download = isset($_GET['download']) && (string) $_GET['download'] === '1';
        $view = isset($_GET['view']) && (string) $_GET['view'] === '1';
        if ($download || $view) {
            self::download_pdf($rx, $view);
        }

        $flash = [
            'success' => '',
            'error' => '',
        ];

        // Mark as dispensed.
        if ($_SERVER['REQUEST_METHOD'] === 'POST') {
            $flash = self::handle_dispense_post($rx);
            // Refresh rx (dispensed state may have changed).
            $rx = $repo->get_by_verify_token($token) ?: $rx;
        }

        self::render_page($rx, $flash);
    }

    private static function render_not_found(): void
    {
        status_header(404);
        header('Content-Type: text/html; charset=utf-8');
        echo '<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ordonnance introuvable</title></head><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;padding:24px;color:#111827;">
            <h1 style="font-size:18px;margin:0 0 8px;">Ordonnance introuvable</h1>
            <p style="margin:0;color:#6b7280;">Le lien est invalide ou l’ordonnance n’est pas disponible.</p>
        </body></html>';
        exit;
    }

    /**
     * @param array<string,mixed> $rx
     */

    private static function download_pdf(array $rx, bool $inline = false): void
    {
        // Pharmacist PDF access (no auth) - trace every access for audit/support (ReqID=rId).
        $token_prefix = isset($rx['verify_token']) ? substr((string) $rx['verify_token'], 0, 8) : '';
        $ip_hash = self::ip_hash();

        $event_attempt = $inline ? 'rx_pdf_view_attempt' : 'rx_pdf_download_attempt';
        $event_missing = $inline ? 'rx_pdf_view_missing' : 'rx_pdf_download_missing';
        $event_served  = $inline ? 'rx_pdf_viewed' : 'rx_pdf_downloaded';

        Logger::ndjson_scoped('runtime', 'rx', 'info', $event_attempt, [
            'actor'        => 'pharmacien',
            'mode'         => $inline ? 'view' : 'download',
            'rx_id'        => $rx['id'] ?? null,
            'uid'          => $rx['uid'] ?? null,
            'token_prefix' => $token_prefix,
            'ip_hash'      => $ip_hash,
        ]);

        $file_repo = new FileRepository();
        $file = $file_repo->find_latest_for_prescription_purpose((int) ($rx['id'] ?? 0), 'rx_pdf');

        if (!$file || empty($file['storage_key'])) {
            Logger::ndjson_scoped('runtime', 'rx', 'warn', $event_missing, [
                'actor'        => 'pharmacien',
                'mode'         => $inline ? 'view' : 'download',
                'rx_id'        => $rx['id'] ?? null,
                'uid'          => $rx['uid'] ?? null,
                'token_prefix' => $token_prefix,
                'ip_hash'      => $ip_hash,
            ]);
            self::render_not_found();
            return;
        }

        $abs = FileStorage::safe_abs_path((string) $file['storage_key']);
        if (!$abs || !is_file($abs)) {
            Logger::ndjson_scoped('runtime', 'rx', 'warn', $event_missing, [
                'actor'        => 'pharmacien',
                'mode'         => $inline ? 'view' : 'download',
                'rx_id'        => $rx['id'] ?? null,
                'uid'          => $rx['uid'] ?? null,
                'token_prefix' => $token_prefix,
                'ip_hash'      => $ip_hash,
                'storage_key'  => $file['storage_key'] ?? null,
            ]);
            self::render_not_found();
            return;
        }

        // Prevent any stray output (notices from other plugins) from corrupting the PDF stream.
        while (ob_get_level()) {
            @ob_end_clean();
        }

        nocache_headers();
        header('X-Robots-Tag: noindex, nofollow, noarchive', true);
        header('X-Content-Type-Options: nosniff', true);

        $uid = (string) ($rx['uid'] ?? 'rx');
        $safe_uid = preg_replace('/[^A-Za-z0-9_-]+/', '-', $uid);
        $filename = 'Ordonnance-' . $safe_uid . '.pdf';

        header('Content-Type: application/pdf');
        header('Content-Disposition: ' . ($inline ? 'inline' : 'attachment') . '; filename="' . $filename . '"');
        header('Content-Length: ' . (string) filesize($abs));

        Logger::ndjson_scoped('runtime', 'rx', 'info', $event_served, [
            'actor'        => 'pharmacien',
            'mode'         => $inline ? 'view' : 'download',
            'rx_id'        => $rx['id'] ?? null,
            'uid'          => $rx['uid'] ?? null,
            'token_prefix' => $token_prefix,
            'ip_hash'      => $ip_hash,
            'file_id'      => $file['id'] ?? null,
            'bytes'        => (int) filesize($abs),
        ]);

        // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_read_readfile
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

        // Nonce (CSRF) protection.
        $nonce = isset($_POST['_wpnonce']) ? (string) $_POST['_wpnonce'] : '';
        if (!wp_verify_nonce($nonce, 'sosprescription_dispense')) {
            $out['error'] = 'Requête invalide. Merci de réessayer.';
            return $out;
        }

        $rx_id = (int) ($rx['id'] ?? 0);
        $token = (string) ($rx['verify_token'] ?? '');
        $token_prefix = $token !== '' ? substr($token, 0, 8) : '';
        $ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
        $ip_hash = self::ip_hash($ip);

        $expected_code = (string) ($rx['verify_code'] ?? '');
        $entered_raw = isset($_POST['dispense_code']) ? (string) $_POST['dispense_code'] : '';
        $entered = preg_replace('/\D+/', '', $entered_raw);
        $entered = is_string($entered) ? $entered : '';

        if ($entered === '' || strlen($entered) != 6) {
            $out['error'] = 'Veuillez saisir le code de délivrance à 6 chiffres.';
            return $out;
        }

        // Basic brute-force protection for the legacy POST flow.
        // (The recommended flow is the REST endpoint with RateLimiter.)
        $attempt_key = 'sp_dispense_' . md5($token . '|' . $ip_hash);
        $attempts = (int) get_transient($attempt_key);

        if ($attempts >= 10) {
            Logger::ndjson_scoped('rx', 'rx_delivery_attempt', [
                'rx_id' => $rx_id,
                'token_prefix' => $token_prefix,
                'code_ok' => false,
                'blocked' => true,
                'reason' => 'too_many_attempts_post',
            ], 'warn');

            $out['error'] = 'Trop de tentatives. Merci de réessayer plus tard.';
            return $out;
        }

        if ($expected_code === '' || !hash_equals($expected_code, $entered)) {
            $attempts_next = $attempts + 1;
            set_transient($attempt_key, $attempts_next, HOUR_IN_SECONDS);

            Logger::ndjson_scoped('rx', 'rx_delivery_attempt', [
                'rx_id' => $rx_id,
                'token_prefix' => $token_prefix,
                'code_ok' => false,
                'attempts' => $attempts_next,
                'flow' => 'post',
            ], 'warn');

            $out['error'] = 'Code incorrect.';
            return $out;
        }

        // Already dispensed.
        $dispensed_at = (string) ($rx['dispensed_at'] ?? '');
        if ($dispensed_at !== '') {
            Logger::ndjson_scoped('rx', 'rx_delivery_attempt', [
                'rx_id' => $rx_id,
                'token_prefix' => $token_prefix,
                'already_dispensed' => true,
                'flow' => 'post',
            ], 'info');

            $out['success'] = 'Cette ordonnance est déjà marquée comme délivrée.';
            return $out;
        }

        $repo = new PrescriptionRepository();
        $ok = $repo->mark_dispensed($rx_id, $ip);
        if (!$ok) {
            Logger::ndjson_scoped('rx', 'rx_delivery_error', [
                'rx_id' => $rx_id,
                'token_prefix' => $token_prefix,
                'flow' => 'post',
            ], 'error');

            $out['error'] = 'Impossible d\'enregistrer la délivrance. Merci de réessayer.';
            return $out;
        }

        Logger::ndjson_scoped('rx', 'rx_delivered', [
            'rx_id' => $rx_id,
            'token_prefix' => $token_prefix,
            'flow' => 'post',
        ], 'info');

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

        $public_id = (string) ($rx['rx_public_id'] ?? '');
        $hash_full = (string) ($rx['rx_public_hash'] ?? '');
        $hash_full = $hash_full !== '' ? $hash_full : '';
        $hash_short = $hash_full !== '' ? (substr($hash_full, 0, 4) . '…' . substr($hash_full, -4)) : '';

        $token = (string) ($rx['verify_token'] ?? '');
        $base_url = home_url('/v/' . rawurlencode($token));
        $download_url = add_query_arg(['download' => '1'], $base_url);
        $view_url = add_query_arg(['view' => '1'], $base_url);

        $payload = isset($rx['payload']) && is_array($rx['payload']) ? $rx['payload'] : [];
        $doctor = isset($payload['doctor']) && is_array($payload['doctor']) ? $payload['doctor'] : [];
        $patient = isset($payload['patient']) && is_array($payload['patient']) ? $payload['patient'] : [];

        $doctor_name = (string) ($doctor['name'] ?? '');
        $doctor_rpps = (string) ($doctor['rpps'] ?? '');
        $doctor_label = trim($doctor_name);
        if ($doctor_rpps !== '') {
            $doctor_label .= ($doctor_label !== '' ? ' • ' : '') . 'RPPS ' . $doctor_rpps;
        }

        $patient_name = (string) ($patient['name'] ?? '');
        $patient_birth = (string) ($patient['birthdate_label'] ?? '');
        $patient_weight = (string) ($patient['weight_label'] ?? '');

        $items = isset($rx['items']) && is_array($rx['items']) ? $rx['items'] : [];
        $med_count = 0;
        foreach ($items as $it) {
            if (is_array($it)) {
                $med_count++;
            }
        }

        $issued_at = (string) ($rx['decided_at'] ?? '');
        if ($issued_at === '') {
            $issued_at = (string) ($rx['created_at'] ?? '');
        }
        $issued_label = $issued_at !== '' ? mysql2date('d/m/Y H:i', $issued_at) : '—';
        $updated_at = (string) ($rx['updated_at'] ?? '');
        $updated_label = $updated_at !== '' ? mysql2date('d/m/Y H:i', $updated_at) : '—';

        $dispensed_at = (string) ($rx['dispensed_at'] ?? '');
        $is_dispensed = $dispensed_at !== '';
        $dispense_label = $is_dispensed ? ('Délivrée le ' . mysql2date('d/m/Y H:i', $dispensed_at)) : 'Non renseigné';

        $verify_code = (string) ($rx['verify_code'] ?? '');

        $scan_ref = 'V-' . strtoupper(substr(hash('sha256', $token), 0, 4));
        $rx_badge = $public_id !== '' ? $public_id : ('#' . (string) ($rx['id'] ?? ''));

        // PDF availability
        $files = new FileRepository();
        $pdf = $files->find_latest_for_prescription_purpose((int) ($rx['id'] ?? 0), 'rx_pdf');
        $has_pdf = (bool) $pdf;

        header('Content-Type: text/html; charset=utf-8');

        // --- Render via external template file if available ---
        $template_path = self::active_template_path();
        $template_html = is_readable($template_path) ? (string) file_get_contents($template_path) : '';

        if ($template_html !== '') {
            // Flash
            $flash_html = '';
            if (!empty($flash['success'])) {
                $flash_html = '<div class="alert ok">' . esc_html((string) $flash['success']) . '</div>';
            } elseif (!empty($flash['error'])) {
                $flash_html = '<div class="alert err">' . esc_html((string) $flash['error']) . '</div>';
            }

            // Badge délivrance (header)
            $dispense_badge_html = $is_dispensed
                ? '<span class="badge valid"><span class="dot"></span>Délivrée</span>'
                : '<span class="badge warn"><span class="dot"></span>Non délivrée</span>';

            // Patient weight row (optional)
            $patient_weight_row_html = '';
            if ($patient_weight !== '' && $patient_weight !== '—') {
                $patient_weight_row_html = '<div class="row"><div class="k">Poids / Taille</div><div class="v">' . esc_html($patient_weight) . '</div></div>';
            }

            // Meta rows (order: Vérification, Identifiant, Empreinte, Code délivrance)
            $display_url = preg_replace('#^https?://#', '', $base_url);
            if ($display_url === null) {
                $display_url = $base_url;
            }
            if (strlen($display_url) > 42) {
                $display_url = substr($display_url, 0, 22) . '…' . substr($display_url, -10);
            }
            $rx_uid = (string) ($rx['uid'] ?? $rx_badge);
            $meta_rows_html = '';
            $meta_rows_html .= '<div class="row"><div class="k">Vérification</div><div class="v"><code>' . esc_html($display_url) . '</code></div></div>';
            $meta_rows_html .= '<div class="row"><div class="k">Identifiant</div><div class="v"><code>' . esc_html($rx_uid !== '' ? $rx_uid : '—') . '</code></div></div>';
            $meta_rows_html .= '<div class="row"><div class="k">Empreinte</div><div class="v"><code>' . esc_html($hash_short !== '' ? $hash_short : '—') . '</code></div></div>';
            $meta_rows_html .= '<div class="row"><div class="k">Code délivrance</div><div class="v"><strong>' . esc_html($verify_code !== '' ? $verify_code : '—') . '</strong></div></div>';

            // PDF actions
            if ($has_pdf) {
                $pdf_actions_html =
                    '<a class="btn primary" href="' . esc_url($download_url) . '">' .
                    '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>' .
                    'Télécharger le PDF</a>' .
                    '<a class="btn secondary" href="' . esc_url($view_url) . '" target="_blank" rel="noopener">' .
                    '<svg viewBox="0 0 24 24" fill="none" stroke="var(--blue)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5C7 5 2.73 8.11 1 12c1.73 3.89 6 7 11 7s9.27-3.11 11-7c-1.73-3.89-6-7-11-7z"/><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/></svg>' .
                    'Afficher le PDF</a>';
            } else {
                $pdf_actions_html =
                    '<span class="btn primary disabled">Télécharger le PDF</span>' .
                    '<span class="btn secondary disabled">Afficher le PDF</span>' .
                    '<div class="note">PDF indisponible (non généré).</div>';
            }

            // Dispense section
            $dispense_section_html = '<div class="dispense-box">';
            $dispense_section_html .= '<div class="dispense-title">Statut de délivrance</div>';
            if ($is_dispensed) {
                $dispense_section_html .= '<div class="dispense-sub">Délivrance confirmée. Cette ordonnance a été marquée comme délivrée.</div>';
            } else {
                $dispense_section_html .= '<div class="dispense-sub">Pour éviter les doubles délivrances, validez avec le code imprimé sur l’ordonnance.</div>';
                if ($verify_code !== '') {
                    $deliver_endpoint = rest_url('sosprescription/v1/verify/' . rawurlencode($token) . '/deliver');

                    $dispense_section_html .= '<div class="alert" id="sp-dispense-status">En attente de délivrance</div>';
                    $dispense_section_html .= '<button type="button" class="btn secondary" id="sp-dispense-open">Marquer comme délivrée</button>';
                    $dispense_section_html .= '<form method="post" class="dispense-form" id="sp-dispense-form" style="display:none;">';
                    $dispense_section_html .= wp_nonce_field('sosprescription_dispense', '_wpnonce', true, false);
                    $dispense_section_html .= '<input type="text" name="dispense_code" id="sp-dispense-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="Code à 6 chiffres" aria-label="Code de délivrance" required>';
                    $dispense_section_html .= '<button type="submit" class="btn primary" id="sp-dispense-submit">Confirmer la délivrance</button>';
                    $dispense_section_html .= '</form>';
                    $dispense_section_html .= '<div class="note" id="sp-dispense-msg" style="display:none"></div>';
                    $dispense_section_html .= '<div class="mini">Le code est imprimé sur l’ordonnance (PDF). Ne pas le partager.</div>';

                    $dispense_i18n = [
                        'rx_delivery_loading' => __('Validation en cours…', 'sosprescription'),
                        'rx_delivery_success' => __('✅ Ordonnance marquée comme délivrée.', 'sosprescription'),
                        'rx_delivery_invalid_code' => __('Code incorrect.', 'sosprescription'),
                        'rx_delivery_api_error' => __('Erreur API. Merci de réessayer.', 'sosprescription'),
                        'error_network_message' => __('Connexion impossible. Merci de réessayer.', 'sosprescription'),
                    ];

                    $deliver_endpoint_json = wp_json_encode($deliver_endpoint, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
                    $dispense_i18n_json = wp_json_encode($dispense_i18n, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
                    if (!is_string($deliver_endpoint_json)) {
                        $deliver_endpoint_json = '""';
                    }
                    if (!is_string($dispense_i18n_json)) {
                        $dispense_i18n_json = '{}';
                    }

                    $js = <<<JS
(function () {
  var deliverUrl = {$deliver_endpoint_json};
  var i18n = {$dispense_i18n_json};

  window.SosPrescription = window.SosPrescription || {};
  window.SosPrescription.i18n = Object.assign({}, window.SosPrescription.i18n || {}, i18n);

  var t = function (key, fallback) {
    try {
      var v = window.SosPrescription.i18n && window.SosPrescription.i18n[key];
      if (typeof v === 'string' && v.length) return v;
    } catch (e) {}
    return fallback;
  };

  var openBtn = document.getElementById('sp-dispense-open');
  var form = document.getElementById('sp-dispense-form');
  var codeInput = document.getElementById('sp-dispense-code');
  var submitBtn = document.getElementById('sp-dispense-submit');
  var msgEl = document.getElementById('sp-dispense-msg');
  var statusEl = document.getElementById('sp-dispense-status');

  if (!openBtn || !form || !codeInput || !submitBtn || !statusEl) {
    return;
  }

  var inFlight = false;
  var originalBtnHtml = submitBtn.innerHTML;

  var setMsg = function (txt, kind) {
    if (!msgEl) return;
    msgEl.textContent = txt || '';
    msgEl.className = 'mini ' + (kind ? ' ' + kind : '');
  };

  var setStatus = function (txt, kind) {
    if (!statusEl) return;
    statusEl.textContent = txt || '';
    statusEl.className = 'alert ' + (kind ? ' ' + kind : '');
  };

  var setLoading = function (on) {
    if (on) {
      submitBtn.classList.add('is-loading');
      submitBtn.innerHTML = '<span class="sp-spinner" aria-hidden="true"></span>' + t('rx_delivery_loading', 'Validation en cours…');
    } else {
      submitBtn.classList.remove('is-loading');
      submitBtn.innerHTML = originalBtnHtml;
    }
  };

  var refreshBtn = function () {
    var v = (codeInput.value || '').replace(/\D+/g, '');
    var ok = (v.length === 6);

    if (inFlight) {
      submitBtn.disabled = true;
      submitBtn.classList.add('disabled');
      return;
    }

    submitBtn.disabled = !ok;
    submitBtn.classList.toggle('disabled', submitBtn.disabled);
  };

  codeInput.addEventListener('input', function () {
    this.value = (this.value || '').replace(/\D+/g, '').slice(0, 6);
    refreshBtn();
  });

  openBtn.addEventListener('click', function () {
    openBtn.style.display = 'none';
    form.style.display = 'block';
    codeInput.focus();
    refreshBtn();
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    if (inFlight) {
      return;
    }

    var code = (codeInput.value || '').replace(/\D+/g, '').slice(0, 6);
    if (code.length !== 6) {
      var m = t('rx_delivery_invalid_code', 'Code incorrect.');
      setStatus(m, 'err');
      setMsg(m, 'err');
      refreshBtn();
      return;
    }

    inFlight = true;
    submitBtn.disabled = true;
    submitBtn.classList.add('disabled');
    codeInput.disabled = true;
    setLoading(true);
    setMsg(t('rx_delivery_loading', 'Validation en cours…'), '');

    fetch(deliverUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code })
    })
      .then(function (resp) {
        return resp
          .json()
          .catch(function () { return { ok: false, error: 'invalid_json' }; })
          .then(function (data) {
            return { resp: resp, data: data };
          });
      })
      .then(function (out) {
        var resp = out && out.resp ? out.resp : null;
        var data = out && out.data ? out.data : {};

        if (!resp || !resp.ok || !data.ok) {
          var err = data && data.error ? String(data.error) : '';

          if (err === 'invalid_code') {
            var msg = t('rx_delivery_invalid_code', 'Code incorrect.');
            setStatus(msg, 'err');
            setMsg(msg, 'err');
          } else {
            var msg2 = t('rx_delivery_api_error', 'Erreur API. Merci de réessayer.');
            setStatus(msg2, 'err');
            setMsg(msg2, 'err');
          }

          // Re-enable only on error
          inFlight = false;
          codeInput.disabled = false;
          setLoading(false);
          refreshBtn();
          return;
        }

        var delivered = data.delivered_at ? ('✅ Délivrée le ' + data.delivered_at) : t('rx_delivery_success', '✅ Ordonnance marquée comme délivrée.');
        setStatus(delivered, 'ok');
        setMsg(t('rx_delivery_success', '✅ Ordonnance marquée comme délivrée.'), 'ok');
        form.style.display = 'none';
        openBtn.style.display = 'none';
      })
      .catch(function () {
        var m = t('error_network_message', 'Connexion impossible. Merci de réessayer.');
        setStatus(m, 'err');
        setMsg(m, 'err');
        inFlight = false;
        codeInput.disabled = false;
        setLoading(false);
        refreshBtn();
      });
  });
})();
JS;

                    $dispense_section_html .= '<script>' . $js . '</script>';
                } else {
                    $dispense_section_html .= '<div class="note">Code de délivrance indisponible.</div>';
                }
            }
            $dispense_section_html .= '</div>';

            // Medication list
            if (empty($items)) {
                $med_list_html = '<div class="note">Aucun médicament.</div>';
            } else {
                $med_list_html = '<ul class="rx-list">';
                foreach ($items as $it) {
                    if (!is_array($it)) {
                        continue;
                    }
                    $name = (string) ($it['bdpm_name'] ?? $it['label'] ?? '');
                    $poso = (string) ($it['posology_text'] ?? $it['posology'] ?? '');
                    $med_list_html .= '<li class="rx-item">';
                    $med_list_html .= '<div class="bullet" aria-hidden="true"></div>';
                    $med_list_html .= '<div>';
                    $med_list_html .= '<div><strong>' . esc_html($name !== '' ? $name : 'Médicament') . '</strong></div>';
                    $med_list_html .= '<div class="detail">' . esc_html($poso !== '' ? $poso : '—') . '</div>';
                    $med_list_html .= '</div>';
                    $med_list_html .= '</li>';
                }
                $med_list_html .= '</ul>';
            }

            $map = [
                '{{PRODUCT}}' => esc_html($product),
                '{{RX_BADGE}}' => esc_html($rx_badge),
                '{{SCAN_REF}}' => esc_html($scan_ref),
                '{{UPDATED_LABEL}}' => esc_html($updated_label),
                '{{FLASH_HTML}}' => $flash_html,
                '{{DISPENSE_BADGE_HTML}}' => $dispense_badge_html,
                '{{DOCTOR_LABEL}}' => esc_html($doctor_label !== '' ? $doctor_label : '—'),
                '{{PATIENT_NAME}}' => esc_html($patient_name !== '' ? $patient_name : '—'),
                '{{PATIENT_BIRTH}}' => esc_html($patient_birth !== '' ? $patient_birth : '—'),
                '{{PATIENT_WEIGHT_ROW_HTML}}' => $patient_weight_row_html,
                '{{ISSUED_LABEL}}' => esc_html($issued_label),
                '{{DISPENSE_LABEL}}' => esc_html($dispense_label),
                '{{MED_COUNT}}' => esc_html((string) $med_count),
                '{{META_ROWS_HTML}}' => $meta_rows_html,
                '{{PDF_ACTIONS_HTML}}' => $pdf_actions_html,
                '{{DISPENSE_SECTION_HTML}}' => $dispense_section_html,
                '{{MED_LIST_HTML}}' => $med_list_html,
                '{{HASH_SHORT}}' => esc_html($hash_short !== '' ? $hash_short : '—'),
            ];

            echo self::render_template($template_html, $map);
            exit;
        }

        ?>
<!doctype html>
<html lang="fr">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="robots" content="noindex,nofollow,noarchive,nosnippet">
    <title>Vérification d’ordonnance • <?php echo esc_html($product); ?></title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

        :root{
            --ink:#0f172a;
            --muted:#64748b;
            --line:#e2e8f0;
            --bg:#f1f5f9;
            --card:#ffffff;
            --blue:#2563eb;
            --blue-50:#eff6ff;
            --green:#16a34a;
            --green-50:#ecfdf5;
            --amber:#f59e0b;
            --amber-50:#fffbeb;
            --red:#dc2626;
            --red-50:#fef2f2;
            --shadow: 0 18px 45px -18px rgba(15,23,42,.28);
            --radius: 18px;
        }
        *{box-sizing:border-box}
        body{
            margin:0;
            font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
            background: linear-gradient(180deg, #eef2ff 0%, var(--bg) 45%, #ffffff 100%);
            color:var(--ink);
            padding: 26px;
        }

        .topbar{
            max-width: 980px;
            margin: 0 auto 18px auto;
            display:flex;
            align-items:center;
            justify-content:space-between;
            gap:12px;
        }
        .brand{
            display:flex;
            gap:12px;
            align-items:center;
        }
        .logo{
            width:44px;height:44px;
            border-radius:14px;
            background: radial-gradient(circle at 30% 30%, #60a5fa, var(--blue));
            display:flex;align-items:center;justify-content:center;
            box-shadow: 0 12px 22px -14px rgba(37,99,235,.8);
        }
        .logo svg{width:22px;height:22px;fill:white}
        .brand-name{font-weight:700; letter-spacing:-.02em}
        .brand-sub{font-size:12px;color:var(--muted); margin-top:2px}
        .pill{
            padding:10px 14px;
            border: 1px solid var(--line);
            background: rgba(255,255,255,.75);
            border-radius: 999px;
            font-size: 13px;
            color: var(--muted);
            display:flex; align-items:center; gap:10px;
            backdrop-filter: blur(10px);
        }
        .pill .dot{width:10px;height:10px;border-radius:99px;background:var(--green); box-shadow:0 0 0 3px var(--green-50)}

        .container{max-width:980px;margin:0 auto;}
        .card{
            background: var(--card);
            border: 1px solid var(--line);
            border-radius: var(--radius);
            box-shadow: var(--shadow);
            overflow:hidden;
        }
        .card-header{
            padding: 18px 20px;
            border-bottom:1px solid var(--line);
            display:flex;
            justify-content:space-between;
            gap: 16px;
            align-items:flex-start;
        }
        .card-title{display:flex; gap:14px; align-items:flex-start}
        .card-title .icon{
            width:44px;height:44px;border-radius:14px;
            border:1px solid var(--line);
            background: var(--blue-50);
            display:flex;align-items:center;justify-content:center;
        }
        .card-title .icon svg{width:22px;height:22px;fill:var(--blue)}
        h1{font-size:16px;margin:0 0 2px 0; letter-spacing:-.02em}
        .sub{font-size:12.5px;color:var(--muted); line-height:1.35}
        .card-meta{text-align:right}
        .badges{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-bottom:6px}
        .badge{
            display:inline-flex;align-items:center;gap:8px;
            padding: 6px 10px;
            border-radius: 999px;
            font-size: 12px;
            border: 1px solid var(--line);
            background: #fff;
            color: var(--muted);
            white-space:nowrap;
        }
        .badge .dot{width:8px;height:8px;border-radius:99px;background:var(--muted)}
        .badge.valid{background: var(--green-50);border-color:#a7f3d0;color:#065f46}
        .badge.valid .dot{background:var(--green)}
        .badge.warn{background: var(--amber-50);border-color:#fde68a;color:#92400e}
        .badge.warn .dot{background:var(--amber)}
        .badge.danger{background: var(--red-50);border-color:#fecaca;color:#991b1b}
        .badge.danger .dot{background:var(--red)}
        .tiny{font-size:11.5px;color:var(--muted)}

        .card-body{padding: 18px 20px;}
        .grid{
            display:grid;
            grid-template-columns: 1.15fr .85fr;
            gap: 18px;
        }
        @media (max-width: 860px){
            body{padding:18px}
            .grid{grid-template-columns:1fr}
            .card-meta{text-align:left}
            .badges{justify-content:flex-start}
        }

        .panel{
            border:1px solid var(--line);
            border-radius: 16px;
            padding: 14px 14px;
            background: linear-gradient(180deg, #ffffff 0%, #fbfdff 100%);
        }
        .panel-title{
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: .08em;
            color: var(--muted);
            margin: 0 0 12px 0;
        }
        .kv{
            display:grid;
            grid-template-columns: 1fr;
            gap: 10px;
        }
        .row{display:flex;justify-content:space-between; gap:12px; align-items:flex-start}
        .k{font-size:12px;color:var(--muted)}
        .v{font-size:13.5px;font-weight:600; color:var(--ink); text-align:right; line-height:1.35}
        .v code{font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
            font-size: 12px; font-weight:700; padding:3px 6px; border:1px dashed #cbd5e1; border-radius:10px; background:#f8fafc;}
        .divider{height:1px;background:var(--line);margin: 16px 0}

        .actions{display:flex; flex-direction:column; gap:10px;}
        .btn{
            display:inline-flex;align-items:center;justify-content:center;gap:10px;
            padding: 12px 14px;
            border-radius: 14px;
            border:1px solid var(--line);
            background:#fff;
            color: var(--ink);
            text-decoration:none;
            font-weight:700;
            font-size: 13px;
            cursor:pointer;
        }
        .btn svg{width:18px;height:18px}
        .btn.primary{background: var(--blue); border-color: var(--blue); color:white}
        .btn.primary:hover{filter:brightness(.98)}
        .btn.secondary{background: var(--blue-50); border-color:#bfdbfe; color: var(--blue)}
        .btn.secondary:hover{filter:brightness(.99)}
        .btn.disabled{opacity:.55; cursor:not-allowed; pointer-events:none}
        .btn.is-loading{opacity:.85; cursor:wait}
        .btn .sp-spinner{
            width:14px;height:14px;
            border:2px solid currentColor;
            border-right-color: transparent;
            border-radius: 999px;
            display:inline-block;
            animation: spSpin .7s linear infinite;
        }
        @keyframes spSpin{to{transform:rotate(360deg)}}
        .note{font-size:12px;color:var(--muted);line-height:1.45}

        .rx-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:10px}
        .rx-item{padding:12px 12px;border:1px solid var(--line);border-radius:14px;background:#fff;display:flex;gap:12px;align-items:flex-start}
        .rx-item .bullet{
            width:10px;height:10px;border-radius:99px;background:var(--blue);
            box-shadow:0 0 0 4px var(--blue-50);
            margin-top:6px;
            flex:0 0 auto;
        }
        .rx-item strong{font-weight:800}
        .rx-item .detail{font-size:13px;color:var(--muted);margin-top:2px;line-height:1.4}

        .dispense-box{
            padding: 12px 12px;
            border-radius: 16px;
            border:1px solid var(--line);
            background: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%);
        }
        .dispense-title{font-weight:800; font-size: 13px; margin: 0 0 4px 0}
        .dispense-sub{font-size: 12px; color: var(--muted); margin: 0 0 10px 0}
        .dispense-form{display:flex; gap:10px; align-items:center; flex-wrap:wrap}
        .dispense-form input{
            flex: 1 1 160px;
            padding: 12px 12px;
            border-radius: 14px;
            border:1px solid var(--line);
            font-size: 14px;
            outline:none;
        }
        .dispense-form input:focus{border-color:#93c5fd; box-shadow: 0 0 0 4px rgba(37,99,235,.12)}
        .mini{font-size:11px;color:var(--muted); margin-top:8px}

        .alert{padding:12px 14px;border-radius:16px;border:1px solid var(--line);margin-bottom:14px;font-size:13px;}
        .alert.ok{background: var(--green-50);border-color:#a7f3d0;color:#065f46}
        .alert.err{background: var(--red-50);border-color:#fecaca;color:#991b1b}

        .card-footer{
            border-top:1px solid var(--line);
            padding: 14px 20px;
            display:flex;
            justify-content:space-between;
            gap:12px;
            color: var(--muted);
            font-size: 12px;
            flex-wrap:wrap;
        }
        .footer{max-width:980px;margin: 14px auto 0 auto; text-align:center; font-size: 11.5px; color: var(--muted)}
        .footer a{color:var(--blue); text-decoration:none}
    </style>
</head>
<body>
    <div class="topbar">
        <div class="brand">
            <div class="logo" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M11 2h2v20h-2zM2 11h20v2H2z"/></svg>
            </div>
            <div>
                <div class="brand-name"><?php echo esc_html($product); ?></div>
                <div class="brand-sub">Vérification d’ordonnance</div>
            </div>
        </div>
        <div class="pill"><span class="dot"></span>Lecture sécurisée</div>
    </div>

    <div class="container">
        <div class="card">
            <div class="card-header">
                <div class="card-title">
                    <div class="icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24"><path d="M9 2h6a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm1 3v2h4V5h-4zm0 4h4v2h-4V9z"/></svg>
                    </div>
                    <div>
                        <h1>Ordonnance vérifiée</h1>
                        <div class="sub">Cette page permet de vérifier l’authenticité. Ne partagez pas ce lien.</div>
                    </div>
                </div>
                <div class="card-meta">
                    <div class="badges">
                        <span class="badge valid"><span class="dot"></span>Valide</span>
                        <?php if ($is_dispensed): ?>
                            <span class="badge valid"><span class="dot"></span>Délivrée</span>
                        <?php else: ?>
                            <span class="badge warn"><span class="dot"></span>Non délivrée</span>
                        <?php endif; ?>
                        <span class="badge"><span class="dot"></span><?php echo esc_html($rx_badge); ?></span>
                    </div>
                    <div class="tiny">Référence scan : <?php echo esc_html($scan_ref); ?> • Dernière mise à jour : <?php echo esc_html($updated_label); ?></div>
                </div>
            </div>

            <div class="card-body">
                <?php if (!empty($flash['success'])): ?>
                    <div class="alert ok"><?php echo esc_html($flash['success']); ?></div>
                <?php elseif (!empty($flash['error'])): ?>
                    <div class="alert err"><?php echo esc_html($flash['error']); ?></div>
                <?php endif; ?>

                <div class="grid">
                    <div class="panel">
                        <div class="panel-title">Détails</div>
                        <div class="kv">
                            <div class="row"><div class="k">Praticien</div><div class="v"><?php echo esc_html($doctor_label !== '' ? $doctor_label : '—'); ?></div></div>
                            <div class="row"><div class="k">Patient</div><div class="v"><?php echo esc_html($patient_name !== '' ? $patient_name : '—'); ?><?php if ($patient_birth !== ''): ?> • <?php echo esc_html($patient_birth); ?><?php endif; ?></div></div>
                            <?php if ($patient_weight !== '' && $patient_weight !== '—'): ?>
                                <div class="row"><div class="k">Poids / Taille</div><div class="v"><?php echo esc_html($patient_weight); ?></div></div>
                            <?php endif; ?>
                            <div class="row"><div class="k">Émise le</div><div class="v"><?php echo esc_html($issued_label); ?></div></div>
                            <div class="row"><div class="k">Délivrance</div><div class="v"><?php echo esc_html($dispense_label); ?></div></div>
                            <div class="row"><div class="k">Nombre de lignes</div><div class="v"><?php echo esc_html((string) $med_count); ?></div></div>
                        </div>
                        <div class="divider"></div>
                        <div class="note">Empreinte (intégrité) : <code><?php echo esc_html($hash_short !== '' ? $hash_short : '—'); ?></code></div>
                    </div>

                    <div class="panel">
                        <div class="panel-title">Actions</div>
                        <div class="actions">
                            <?php if ($has_pdf): ?>
                                <a class="btn primary" href="<?php echo esc_url($download_url); ?>">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>
                                    Télécharger le PDF
                                </a>
                                <a class="btn secondary" href="<?php echo esc_url($view_url); ?>" target="_blank" rel="noopener">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="var(--blue)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5C7 5 2.73 8.11 1 12c1.73 3.89 6 7 11 7s9.27-3.11 11-7c-1.73-3.89-6-7-11-7z"/><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/></svg>
                                    Afficher le PDF
                                </a>
                            <?php else: ?>
                                <span class="btn primary disabled">Télécharger le PDF</span>
                                <span class="btn secondary disabled">Afficher le PDF</span>
                                <div class="note">PDF indisponible (non généré).</div>
                            <?php endif; ?>

                            <div class="dispense-box">
                                <div class="dispense-title">Statut de délivrance</div>
                                <?php if ($is_dispensed): ?>
                                    <div class="dispense-sub">Délivrance confirmée. Cette ordonnance a été marquée comme délivrée.</div>
                                <?php else: ?>
                                    <div class="dispense-sub">Pour éviter les doubles délivrances, validez avec le code imprimé sur l’ordonnance.</div>
                                    <?php if ($verify_code !== ''): ?>
                                        <button type="button" class="btn secondary" id="sp-dispense-open">Marquer comme délivrée</button>
                                        <form method="post" class="dispense-form" id="sp-dispense-form" style="display:none;">
                                            <?php echo wp_nonce_field('sosprescription_dispense', '_wpnonce', true, false); ?>
                                            <input type="text" name="dispense_code" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="Code à 6 chiffres" aria-label="Code de délivrance">
                                            <button type="submit" class="btn primary">Valider</button>
                                        </form>
                                        <div class="mini">Le code est imprimé sur l’ordonnance (PDF). Ne pas le partager.</div>
                                    <?php else: ?>
                                        <div class="note">Code de délivrance indisponible.</div>
                                    <?php endif; ?>
                                <?php endif; ?>
                            </div>

                            <div class="note">Données affichées via un lien sécurisé. Échanges chiffrés (TLS).</div>
                        </div>
                    </div>
                </div>

                <div class="divider"></div>

                <div class="panel">
                    <div class="panel-title">Prescription</div>
                    <?php if (empty($items)): ?>
                        <div class="note">Aucun médicament.</div>
                    <?php else: ?>
                        <ul class="rx-list">
                            <?php foreach ($items as $it):
                                if (!is_array($it)) { continue; }
                                $name = (string) ($it['bdpm_name'] ?? $it['label'] ?? '');
                                $poso = (string) ($it['posology_text'] ?? $it['posology'] ?? '');
                                ?>
                                <li class="rx-item">
                                    <div class="bullet" aria-hidden="true"></div>
                                    <div>
                                        <div><strong><?php echo esc_html($name !== '' ? $name : 'Médicament'); ?></strong></div>
                                        <div class="detail"><?php echo esc_html($poso !== '' ? $poso : '—'); ?></div>
                                    </div>
                                </li>
                            <?php endforeach; ?>
                        </ul>
                    <?php endif; ?>
                </div>
            </div>

            <div class="card-footer">
                <div>Généré par <?php echo esc_html($product); ?> • Vérification en lecture seule</div>
                <div>Empreinte : <code><?php echo esc_html($hash_short !== '' ? $hash_short : '—'); ?></code></div>
            </div>
        </div>

        <div class="footer">
            Besoin d’aide ? Contactez le support <?php echo esc_html($product); ?>.
        </div>
    </div>

    <script>
        (function(){
            var btn = document.getElementById('sp-dispense-open');
            var form = document.getElementById('sp-dispense-form');
            if(btn && form){
                btn.addEventListener('click', function(){
                    btn.style.display = 'none';
                    form.style.display = 'flex';
                    var input = form.querySelector('input[name="dispense_code"]');
                    if(input){ input.focus(); }
                });
            }
        })();
    </script>
</body>
</html>
        <?php
        exit;
    }
}
