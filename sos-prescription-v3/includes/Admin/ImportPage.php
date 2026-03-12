<?php
// includes/Admin/ImportPage.php
declare(strict_types=1);

namespace SOSPrescription\Admin;

use SOSPrescription\Db;
use SOSPrescription\Services\MedicationImporter;
use SOSPrescription\Services\Whitelist;

final class ImportPage
{
    private const MAX_ARCHIVE_BYTES = 5368709120;

    public static function register_actions(): void
    {
        add_action('admin_post_sosprescription_import_upload', [self::class, 'handle_upload_post']);
    }

    public static function handle_upload_post(): void
    {
        if (!is_user_logged_in()) {
            wp_die('Connexion requise.');
        }

        if (!current_user_can('sosprescription_manage_data') && !current_user_can('manage_options')) {
            wp_die('Acces refuse.');
        }

        check_admin_referer('sosprescription_import_upload', 'sp_import_nonce');

        $redirect = admin_url('admin.php?page=sosprescription-import');

        if (!isset($_FILES['file']) || !is_array($_FILES['file'])) {
            wp_safe_redirect(add_query_arg('upload_error', rawurlencode('Fichier manquant.'), $redirect));
            exit;
        }

        $file = $_FILES['file'];
        $err = isset($file['error']) ? (int) $file['error'] : UPLOAD_ERR_NO_FILE;
        if ($err !== UPLOAD_ERR_OK) {
            wp_safe_redirect(add_query_arg('upload_error', rawurlencode('Erreur upload (code ' . $err . ').'), $redirect));
            exit;
        }

        $tmp = isset($file['tmp_name']) ? (string) $file['tmp_name'] : '';
        $name = isset($file['name']) ? (string) $file['name'] : '';
        $size = self::uploaded_file_size($file);

        if ($size > self::plugin_max_archive_bytes()) {
            wp_safe_redirect(add_query_arg('upload_error', rawurlencode('Archive ZIP trop volumineuse. Limite plugin : ' . self::plugin_max_archive_label() . '.'), $redirect));
            exit;
        }

        if ($tmp === '' || !is_uploaded_file($tmp)) {
            wp_safe_redirect(add_query_arg('upload_error', rawurlencode('Upload non valide.'), $redirect));
            exit;
        }

        $uploads = wp_upload_dir();
        $base = isset($uploads['basedir']) ? (string) $uploads['basedir'] : '';
        if ($base === '') {
            wp_safe_redirect(add_query_arg('upload_error', rawurlencode('Impossible de determiner le dossier uploads.'), $redirect));
            exit;
        }

        $dir = rtrim($base, '/') . '/sosprescription-import/uploads';
        wp_mkdir_p($dir);

        $safe_name = sanitize_file_name($name);
        if ($safe_name === '') {
            $safe_name = 'bdpm.zip';
        }
        $dest = rtrim($dir, '/') . '/' . gmdate('Ymd_His') . '_' . $safe_name;

        if (!@move_uploaded_file($tmp, $dest)) {
            wp_safe_redirect(add_query_arg('upload_error', rawurlencode('Impossible de deplacer le fichier uploade.'), $redirect));
            exit;
        }

        $importer = new MedicationImporter();
        $session = $importer->start_session_from_zip($dest);

        if (is_wp_error($session)) {
            $msg = (string) $session->get_error_message();
            wp_safe_redirect(add_query_arg('upload_error', rawurlencode($msg), $redirect));
            exit;
        }

        wp_safe_redirect(add_query_arg('uploaded', '1', $redirect));
        exit;
    }

    public static function register_menu(): void
    {
        $icon = apply_filters('sosprescription_admin_menu_icon', 'dashicons-sos');

        add_menu_page('SOS Prescription', 'SOS Prescription', 'sosprescription_manage', 'sosprescription', [SetupPage::class, 'render_page'], $icon, 58);
        add_submenu_page('sosprescription', 'Installation & statut', 'Installation & statut', 'sosprescription_manage', 'sosprescription', [SetupPage::class, 'render_page']);
        add_submenu_page('sosprescription', 'Sandbox', 'Sandbox', 'sosprescription_manage_data', 'sosprescription-sandbox', [SandboxPage::class, 'render_page']);
        add_submenu_page('sosprescription', 'Logs', 'Logs', 'sosprescription_manage', 'sosprescription-logs', [LogsPage::class, 'render_page']);
        add_submenu_page('sosprescription', __('System Status', 'sosprescription'), __('System Status', 'sosprescription'), 'manage_options', 'sosprescription-system-status', [SystemStatusPage::class, 'render_page']);
        add_submenu_page('sosprescription', 'Ordonnances', 'Ordonnances', 'sosprescription_manage', 'sosprescription-rx', [RxPage::class, 'render_page']);
        add_submenu_page('sosprescription', 'Verification', 'Verification', 'sosprescription_manage', 'sosprescription-verification', [VerificationTemplatePage::class, 'render_page']);
        add_submenu_page('sosprescription', 'Import BDPM', 'Import BDPM', 'sosprescription_manage_data', 'sosprescription-import', [self::class, 'render_page']);
        add_submenu_page('sosprescription', 'Perimetre', 'Perimetre', 'sosprescription_manage', 'sosprescription-whitelist', [WhitelistPage::class, 'render_page']);
        add_submenu_page('sosprescription', 'Tarifs', 'Tarifs', 'sosprescription_manage', 'sosprescription-pricing', [PricingPage::class, 'render_page']);
        add_submenu_page('sosprescription', 'Paiements', 'Paiements', 'sosprescription_manage', 'sosprescription-payments', [PaymentsPage::class, 'render_page']);
        add_submenu_page('sosprescription', 'Notifications', 'Notifications', 'sosprescription_manage', 'sosprescription-notifications', [NotificationsPage::class, 'render_page']);
        add_submenu_page('sosprescription', 'Mentions patient', 'Mentions patient', 'sosprescription_manage', 'sosprescription-notices', [NoticesPage::class, 'render_page']);
        add_submenu_page('sosprescription', 'OCR & fichiers', 'OCR & fichiers', 'sosprescription_manage', 'sosprescription-ocr', [OcrPage::class, 'render_page']);
        add_submenu_page('sosprescription', 'Conformite', 'Conformite', 'sosprescription_manage', 'sosprescription-compliance', [CompliancePage::class, 'render_page']);

        add_action('admin_enqueue_scripts', [self::class, 'enqueue_assets']);
    }

    public static function enqueue_assets(string $hook): void
    {
        $page = isset($_GET['page']) ? sanitize_key((string) $_GET['page']) : '';
        if ($page !== 'sosprescription-import') {
            return;
        }

        wp_enqueue_style('sosprescription-admin-import', SOSPRESCRIPTION_URL . 'assets/admin-import.css', [], SOSPRESCRIPTION_VERSION);
        wp_enqueue_script('sosprescription-admin-import', SOSPRESCRIPTION_URL . 'assets/admin-import.js', [], SOSPRESCRIPTION_VERSION, true);

        $server_max = (int) wp_max_upload_size();
        $data = [
            'restBase' => esc_url_raw(rest_url('sosprescription/v1')),
            'nonce' => wp_create_nonce('wp_rest'),
            'pluginVersion' => defined('SOSPRESCRIPTION_VERSION') ? (string) SOSPRESCRIPTION_VERSION : '',
            'wpVersion' => isset($GLOBALS['wp_version']) ? (string) $GLOBALS['wp_version'] : '',
            'phpVersion' => PHP_VERSION,
            'maxUploadBytes' => self::plugin_max_archive_bytes(),
            'maxUploadLabel' => self::plugin_max_archive_label(),
            'serverMaxUploadBytes' => $server_max,
            'serverMaxUploadLabel' => size_format((float) $server_max),
        ];

        $json = wp_json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if (!is_string($json)) {
            $json = '{}';
        }

        $inline = ''
            . 'window.SOSPrescriptionImport = ' . $json . ';'
            . 'window.SosPrescriptionImport = window.SOSPrescriptionImport;'
            . 'window.SOSPrescription = Object.assign({}, window.SOSPrescription || {}, {'
            . 'restBase: window.SOSPrescriptionImport.restBase || "",'
            . 'nonce: window.SOSPrescriptionImport.nonce || "",'
            . 'pluginVersion: window.SOSPrescriptionImport.pluginVersion || "",'
            . 'wpVersion: window.SOSPrescriptionImport.wpVersion || "",'
            . 'phpVersion: window.SOSPrescriptionImport.phpVersion || "",'
            . 'adminImport: window.SOSPrescriptionImport'
            . '});'
            . 'window.SosPrescription = window.SOSPrescription;';

        wp_add_inline_script('sosprescription-admin-import', $inline, 'before');
    }

    private static function plugin_max_archive_bytes(): int
    {
        return (int) apply_filters('sosprescription_import_max_archive_bytes', self::MAX_ARCHIVE_BYTES);
    }

    private static function plugin_max_archive_label(): string
    {
        return size_format((float) self::plugin_max_archive_bytes());
    }

    /**
     * @param array<string, mixed> $file
     */
    private static function uploaded_file_size(array $file): int
    {
        if (!isset($file['size'])) {
            return 0;
        }

        $size = $file['size'];
        if (is_int($size) || is_float($size)) {
            return max(0, (int) $size);
        }

        if (is_string($size) && $size !== '' && preg_match('/^\d+$/', $size) === 1) {
            return max(0, (int) $size);
        }

        return 0;
    }

    /**
     * @param array<int, array<string, mixed>> $history
     */
    private static function render_history_table(array $history): void
    {
        if (empty($history)) {
            echo '<div class="sp-empty">Aucun historique disponible.</div>';
            return;
        }

        echo '<div class="sp-table-wrap"><table class="widefat striped"><thead><tr>';
        echo '<th>BDPM en base</th><th>Importe le</th><th>ZIP</th><th>Session</th><th style="text-align:right;">Total lignes</th>';
        echo '</tr></thead><tbody>';

        $i = 0;
        foreach ($history as $row) {
            if (!is_array($row)) {
                continue;
            }
            $i++;
            if ($i > 10) {
                break;
            }

            $v = isset($row['bdpm_version']) ? (string) $row['bdpm_version'] : '—';
            $at = isset($row['imported_at']) ? (string) $row['imported_at'] : '—';
            $zip = isset($row['zip_name']) && (string) $row['zip_name'] !== '' ? (string) $row['zip_name'] : '—';
            $sid = isset($row['session_id']) ? (string) $row['session_id'] : '—';
            $total = isset($row['total_rows']) ? (int) $row['total_rows'] : 0;

            echo '<tr><td><code>' . esc_html($v) . '</code></td><td>' . esc_html($at) . '</td><td>' . esc_html($zip) . '</td><td><code>' . esc_html($sid) . '</code></td><td style="text-align:right;">' . esc_html(number_format_i18n($total)) . '</td></tr>';
        }

        echo '</tbody></table></div>';
    }

    /**
     * @return array{exists:bool, rows:int}
     */
    private static function table_health(string $table): array
    {
        global $wpdb;

        if ($table === '') {
            return ['exists' => false, 'rows' => 0];
        }

        $sql = $wpdb->prepare(
            "SELECT TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s LIMIT 1",
            $table
        );
        $val = $wpdb->get_var($sql);

        if ($val !== null) {
            return ['exists' => true, 'rows' => (int) $val];
        }

        $like = str_replace(['\\', '_', '%'], ['\\\\', '\\_', '\\%'], $table);
        $sql2 = $wpdb->prepare("SHOW TABLES LIKE %s", $like);
        $r = $wpdb->get_var($sql2);

        if (!is_string($r) || $r === '') {
            return ['exists' => false, 'rows' => 0];
        }

        $rows = (int) $wpdb->get_var("SELECT COUNT(1) FROM {$table}");
        return ['exists' => true, 'rows' => $rows];
    }

    private static function count_lines(string $text): int
    {
        $lines = preg_split('/\r\n|\r|\n/', $text);
        if (!is_array($lines)) {
            return 0;
        }

        $n = 0;
        foreach ($lines as $l) {
            $l = trim((string) $l);
            if ($l === '' || str_starts_with($l, '#')) {
                continue;
            }
            $n++;
        }

        return $n;
    }

    public static function render_page(): void
    {
        if (!current_user_can('sosprescription_manage_data') && !current_user_can('manage_options')) {
            wp_die('Acces refuse.');
        }

        $meta = get_option('sosprescription_bdpm_meta');
        $meta_version = (is_array($meta) && isset($meta['bdpm_version'])) ? (string) $meta['bdpm_version'] : '—';
        $meta_imported = (is_array($meta) && isset($meta['imported_at'])) ? (string) $meta['imported_at'] : '—';
        $meta_session = (is_array($meta) && isset($meta['session_id'])) ? (string) $meta['session_id'] : '—';
        $meta_zip = (is_array($meta) && isset($meta['zip_name']) && (string) $meta['zip_name'] !== '') ? (string) $meta['zip_name'] : '—';
        $meta_rows = (is_array($meta) && isset($meta['total_rows'])) ? (int) $meta['total_rows'] : 0;
        $history = get_option('sosprescription_bdpm_meta_history', []);
        if (!is_array($history)) {
            $history = [];
        }

        $plugin_version = defined('SOSPRESCRIPTION_VERSION') ? (string) SOSPRESCRIPTION_VERSION : '';
        $wp_version = isset($GLOBALS['wp_version']) ? (string) $GLOBALS['wp_version'] : '';
        $php_version = PHP_VERSION;
        $bdpm_ready = ($meta_imported !== '—' && $meta_imported !== '' && $meta_rows > 0);

        $zip_ok = class_exists('ZipArchive');
        $cis_table = Db::table('cis');
        $cip_table = Db::table('cip');
        $mitm_table = Db::table('mitm');
        $cis_health = self::table_health($cis_table);
        $cip_health = self::table_health($cip_table);
        $mitm_health = self::table_health($mitm_table);

        $wh = get_option(Whitelist::OPTION_KEY, []);
        if (!is_array($wh)) {
            $wh = [];
        }

        $allowed_atc_txt = isset($wh['allowed_atc_prefixes']) ? (string) $wh['allowed_atc_prefixes'] : '';
        $denied_atc_txt = isset($wh['denied_atc_prefixes']) ? (string) $wh['denied_atc_prefixes'] : '';
        $allowed_cis_txt = isset($wh['allowed_cis']) ? (string) $wh['allowed_cis'] : '';
        $denied_cis_txt = isset($wh['denied_cis']) ? (string) $wh['denied_cis'] : '';
        $allowed_atc_n = self::count_lines($allowed_atc_txt);
        $denied_atc_n = self::count_lines($denied_atc_txt);
        $allowed_cis_n = self::count_lines($allowed_cis_txt);
        $denied_cis_n = self::count_lines($denied_cis_txt);
        $wh_needs_mitm = ($allowed_atc_n > 0 || $denied_atc_n > 0);
        $mitm_missing_for_whitelist = $wh_needs_mitm && (!$mitm_health['exists'] || (int) $mitm_health['rows'] <= 0);

        echo '<div class="wrap sp-ui sosprescription-admin-import">';
        echo '<div class="sp-topbar"><div class="sp-topbar-left"><div class="sp-h1"><img src="' . esc_url(SOSPRESCRIPTION_URL . 'assets/caduceus.svg') . '" alt="" class="sp-icon" /><span>Import BDPM</span></div><div class="sp-topbar-meta">';
        if ($plugin_version !== '') {
            echo '<span class="sp-pill">Plugin v' . esc_html($plugin_version) . '</span>';
        }
        if ($wp_version !== '') {
            echo '<span class="sp-pill sp-pill-muted">WP ' . esc_html($wp_version) . '</span>';
        }
        echo '<span class="sp-pill sp-pill-muted">PHP ' . esc_html($php_version) . '</span></div></div><div class="sp-topbar-right">';
        echo '<a class="button" href="' . esc_url(admin_url('admin.php?page=sosprescription-whitelist')) . '">Perimetre (whitelist)</a>';
        echo '<a class="button" href="' . esc_url(admin_url('admin.php?page=sosprescription-logs&tab=bdpm')) . '">Logs BDPM</a></div></div>';
        echo '<p class="sp-lead">Importez la <strong>Base de Donnees Publique des Medicaments</strong> (BDPM), suivez la progression, puis testez immediatement la recherche utilisee cote patient.</p>';

        if (isset($_GET['uploaded']) && (string) $_GET['uploaded'] === '1') {
            echo '<div class="notice notice-success is-dismissible"><p>ZIP uploade. Vous pouvez lancer / reprendre l’import.</p></div>';
        }
        if (isset($_GET['upload_error']) && (string) $_GET['upload_error'] !== '') {
            $msg = sanitize_text_field((string) $_GET['upload_error']);
            echo '<div class="notice notice-error"><p><strong>Upload impossible :</strong> ' . esc_html($msg) . '</p></div>';
        }

        echo '<div class="sp-grid"><div class="sp-main">';
        echo '<div class="sp-card"><div class="sp-card-title">Etat BDPM</div><div class="sp-card-subtitle">Statut</div><div class="sp-row" style="margin-bottom:10px;">';
        echo $bdpm_ready ? '<span class="sp-badge sp-badge-ok">BDPM prete</span>' : '<span class="sp-badge sp-badge-warn">BDPM a importer</span>';
        echo '<span class="sp-muted">La BDPM est le referentiel qui alimente la recherche medicament et la whitelist (ATC).</span></div>';
        echo '<div id="sosprescription-import-meta" class="sp-kv">';
        echo '<div><strong>Version BDPM en base :</strong> <code>' . esc_html($meta_version) . '</code></div>';
        echo '<div><strong>Dernier import :</strong> ' . esc_html($meta_imported) . '</div>';
        echo '<div><strong>Derniere session :</strong> <code>' . esc_html($meta_session) . '</code></div>';
        echo '<div><strong>ZIP source :</strong> ' . esc_html($meta_zip) . '</div>';
        echo '<div><strong>Total lignes importees :</strong> ' . esc_html(number_format_i18n($meta_rows)) . '</div>';
        echo '<div class="sp-muted" style="margin-top:8px;">Astuce : si la recherche cote patient ne retourne rien, verifiez (1) que l’import est termine, (2) que la whitelist n’exclut pas tout, et (3) que le fichier <code>CIS_MITM</code> a bien ete importe (codes ATC).</div></div>';
        echo '<div style="margin-top:14px;"><div class="sp-card-subtitle">Historique (10 derniers imports)</div><div id="sosprescription-import-history">';
        self::render_history_table($history);
        echo '</div></div></div>';

        echo '<div class="sp-card"><div class="sp-card-title">1) Charger l’archive ZIP BDPM</div>';
        echo '<form id="sosprescription-import-upload-form" method="post" action="' . esc_url(admin_url('admin-post.php')) . '" enctype="multipart/form-data" class="sp-row">';
        echo '<input type="hidden" name="action" value="sosprescription_import_upload" />';
        wp_nonce_field('sosprescription_import_upload', 'sp_import_nonce');
        echo '<input type="file" id="sosprescription-import-file" name="file" accept=".zip" class="sp-file" />';
        echo '<button type="submit" class="button button-primary" id="sosprescription-import-upload">Uploader</button></form>';
        echo '<div class="sp-muted" style="margin-top:8px;">Importer l’archive ZIP officielle (BDPM) ou un ZIP contenant les fichiers TXT tabules.</div>';
        echo '<div class="sp-muted" style="margin-top:6px;">Limite logicielle plugin : <code>' . esc_html(self::plugin_max_archive_label()) . '</code></div>';
        echo '<div class="sp-muted" style="margin-top:6px;">Taille max upload serveur : <code>' . esc_html(size_format((float) wp_max_upload_size())) . '</code></div></div>';

        echo '<div class="sp-card"><div class="sp-card-title">2) Importer en batch</div><div class="sp-muted" style="margin-bottom:10px;">Le batch avance par etapes (securise sur hebergement mutualise). Vous pouvez recharger la page et reprendre.</div>';
        echo '<div class="sp-actions"><button type="button" class="button button-primary" id="sosprescription-import-start">Demarrer / Reprendre</button><button type="button" class="button" id="sosprescription-import-reset">Reinitialiser</button></div>';
        echo '<div id="sosprescription-import-status" class="sp-status">Statut : pret.</div>';
        echo '<div class="sp-progress" aria-hidden="true"><div id="sosprescription-import-progress-bar" class="sp-progress-bar" style="width:0%"></div></div>';
        echo '<div class="sp-muted" id="sosprescription-import-progress-text" style="margin-top:6px;">0%</div><div id="sosprescription-import-files" style="margin-top:12px;"></div></div>';

        echo '<div class="sp-card"><div class="sp-card-title">3) Verifier la recherche medicament (BDPM)</div><div class="sp-muted" style="margin-bottom:10px;">Ce test interroge la BDPM en base (sans filtrage whitelist). Tapez au moins 2 caracteres (ou un code CIS/CIP).</div>';
        echo '<div class="sp-search-wrap"><input type="text" id="sosprescription-import-test-q" class="sp-input" placeholder="Ex: doliprane, CIS 6000123, CIP13 3400..." autocomplete="off" /><div id="sosprescription-import-test-dropdown" class="sp-dropdown" style="display:none;"></div></div>';
        echo '<div id="sosprescription-import-test-picked" class="sp-picked">—</div></div></div>';

        echo '<div class="sp-side"><div class="sp-card"><div class="sp-card-title">Raccourcis</div><div class="sp-actions">';
        echo '<a class="button" href="' . esc_url(admin_url('admin.php?page=sosprescription')) . '">Installation & statut</a>';
        echo '<a class="button" href="' . esc_url(admin_url('admin.php?page=sosprescription-whitelist')) . '">Perimetre</a>';
        echo '<a class="button" href="' . esc_url(admin_url('admin.php?page=sosprescription-logs&tab=bdpm')) . '">Logs BDPM</a></div>';
        echo '<div class="sp-muted" style="margin-top:10px;">Apres import, configurez la whitelist pour limiter les classes (ATC) au perimetre RO / continuite.</div></div>';

        echo '<div class="sp-card"><div class="sp-card-title">Sante du moteur</div><div class="sp-card-subtitle">Extensions & tables</div><div class="sp-kv">';
        echo '<div><strong>ZipArchive :</strong> ' . ($zip_ok ? '<span class="sp-badge sp-badge-ok">OK</span>' : '<span class="sp-badge sp-badge-warn">Manquant</span>') . '</div>';
        echo '<div><strong>Table CIS :</strong> ' . ($cis_health['exists'] ? '<span class="sp-badge sp-badge-ok">OK</span> <span class="sp-muted">' . esc_html(number_format_i18n((int) $cis_health['rows'])) . ' lignes</span>' : '<span class="sp-badge sp-badge-warn">Absente</span>') . '</div>';
        echo '<div><strong>Table CIP :</strong> ' . ($cip_health['exists'] ? '<span class="sp-badge sp-badge-ok">OK</span> <span class="sp-muted">' . esc_html(number_format_i18n((int) $cip_health['rows'])) . ' lignes</span>' : '<span class="sp-badge sp-badge-warn">Absente</span>') . '</div>';
        echo '<div><strong>Table CIS_MITM (ATC) :</strong> ' . ($mitm_health['exists'] ? (((int) $mitm_health['rows'] > 0) ? '<span class="sp-badge sp-badge-ok">OK</span> <span class="sp-muted">' . esc_html(number_format_i18n((int) $mitm_health['rows'])) . ' lignes</span>' : '<span class="sp-badge sp-badge-warn">Vide</span>') : '<span class="sp-badge sp-badge-warn">Absente</span>') . '</div>';
        echo '</div><div class="sp-card-subtitle" style="margin-top:12px;">Whitelist</div><div class="sp-kv">';
        echo '<div><strong>ATC autorises :</strong> <code>' . esc_html((string) $allowed_atc_n) . '</code></div>';
        echo '<div><strong>ATC interdits :</strong> <code>' . esc_html((string) $denied_atc_n) . '</code></div>';
        echo '<div><strong>CIS autorises (override) :</strong> <code>' . esc_html((string) $allowed_cis_n) . '</code></div>';
        echo '<div><strong>CIS interdits (override) :</strong> <code>' . esc_html((string) $denied_cis_n) . '</code></div></div>';
        if ($mitm_missing_for_whitelist) {
            echo '<div class="sp-status" style="margin-top:10px;background:#fff8e5;border-color:#f0c36d;">La whitelist ATC est configuree, mais la table <code>CIS_MITM</code> est absente / vide. Resultat : la recherche cote patient peut sembler sans resultats. Relancez l’import et verifiez que le fichier <code>CIS_MITM</code> est bien present dans le ZIP.</div>';
        }
        echo '</div><div class="sp-card"><div class="sp-card-title">Source BDPM</div><div class="sp-muted">Telechargement officiel :</div><div style="margin-top:6px;"><a href="https://base-donnees-publique.medicaments.gouv.fr/telechargement" target="_blank" rel="noopener noreferrer">base-donnees-publique.medicaments.gouv.fr/telechargement</a></div></div></div></div></div>';
    }
}
