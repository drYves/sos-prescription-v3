<?php

namespace SOSPrescription\Admin;

use SOSPrescription\Services\Logger;
use SOSPrescription\Services\ComplianceConfig;

/**
 * Admin page: Vérification (Pharmacien)
 *
 * Permet d'uploader / télécharger un template HTML pour la page publique /v/{token}
 * sans devoir modifier le code PHP à chaque itération.
 */
class VerificationTemplatePage
{
    public const SLUG = 'sosprescription-verification';

    private static function tech_note_path(): string
    {
        return rtrim((string) SOSPRESCRIPTION_PATH, '/') . '/docs/verification-template-tech-note.html';
    }

    private static function can_manage(): bool
    {
        return current_user_can('sosprescription_manage') || current_user_can('manage_options');
    }

    public static function register_actions(): void
    {
        add_action('admin_post_sosprescription_verif_template_upload', [self::class, 'handle_upload']);
        add_action('admin_post_sosprescription_verif_template_reset', [self::class, 'handle_reset']);
        add_action('admin_post_sosprescription_verif_template_download', [self::class, 'handle_download_template']);
        add_action('admin_post_sosprescription_verif_template_preview', [self::class, 'handle_preview']);
        add_action('admin_post_sosprescription_verif_template_download_doc', [self::class, 'handle_download_doc']);
    }

    private static function default_template_path(): string
    {
        return rtrim((string) SOSPRESCRIPTION_PATH, '/') . '/templates/verification-pharmacien.html';
    }

    public static function upload_override_path(): string
    {
        $uploads = wp_upload_dir();
        $dir = rtrim((string) ($uploads['basedir'] ?? ''), '/') . '/sosprescription-templates';
        return $dir . '/verification-pharmacien.html';
    }

    private static function upload_override_dir(): string
    {
        $uploads = wp_upload_dir();
        return rtrim((string) ($uploads['basedir'] ?? ''), '/') . '/sosprescription-templates';
    }

    /**
     * @return array{0:string,1:string} [path, source]
     */
    private static function active_template(): array
    {
        $override = self::upload_override_path();
        if (is_readable($override)) {
            return [$override, 'upload'];
        }
        return [self::default_template_path(), 'plugin'];
    }

    public static function render(): void
    {
        if (!self::can_manage()) {
            wp_die(__('Accès refusé.', 'sosprescription'));
        }

        [$active_path, $source] = self::active_template();
        $override_path = self::upload_override_path();
        $has_override = is_readable($override_path);

        $active_size = is_readable($active_path) ? (int) (@filesize($active_path) ?: 0) : 0;
        $active_mtime = is_readable($active_path) ? gmdate('Y-m-d H:i:s', (int) filemtime($active_path)) : '';

        $download_active_url = wp_nonce_url(
            admin_url('admin-post.php?action=sosprescription_verif_template_download&which=active'),
            'sosprescription_verif_template_download'
        );
        $download_default_url = wp_nonce_url(
            admin_url('admin-post.php?action=sosprescription_verif_template_download&which=default'),
            'sosprescription_verif_template_download'
        );
        $reset_url = wp_nonce_url(
            admin_url('admin-post.php?action=sosprescription_verif_template_reset'),
            'sosprescription_verif_template_reset'
        );

        $preview_url = wp_nonce_url(
            admin_url('admin-post.php?action=sosprescription_verif_template_preview'),
            'sosprescription_verif_template_preview'
        );

        $download_doc_url = wp_nonce_url(
            admin_url('admin-post.php?action=sosprescription_verif_template_download_doc'),
            'sosprescription_verif_template_download_doc'
        );

        $tech_note_exists = is_readable(self::tech_note_path());

        $active_preview = '';
        if (is_readable($active_path)) {
            $raw = (string) file_get_contents($active_path);
            if (strlen($raw) > 120000) {
                $raw = substr($raw, 0, 120000) . "\n\n<!-- … aperçu tronqué (120KB) … -->\n";
            }
            $active_preview = esc_textarea($raw);
        }

        echo '<div class="wrap sp-ui">';
        echo '<h1>Vérification (Pharmacien)</h1>';
        echo '<p class="sp-muted">Gérez le template HTML/CSS pour la page publique <code>/v/{token}</code> (scan QR). Objectif : rendu premium et itérations rapides.</p>';

        echo '<div class="sp-alert sp-alert-info" style="margin-top:12px;">';
        echo '<strong>Template actif :</strong> ' . esc_html($source === 'upload' ? 'Template uploadé (override)' : 'Template du plugin (par défaut)');
        echo '<div class="sp-muted" style="margin-top:6px;"><code>' . esc_html($active_path) . '</code></div>';
        if ($active_mtime !== '') {
            echo '<div class="sp-muted" style="margin-top:6px;">Dernière modification : ' . esc_html($active_mtime) . ' UTC • Taille : ' . esc_html((string) $active_size) . ' octets</div>';
        }
        echo '</div>';

        echo '<div class="sp-card" style="max-width:1000px; padding:16px; margin-top:12px;">';
        echo '<div class="sp-card-title">Template</div>';
        echo '<div class="sp-muted" style="margin-top:6px;">Chemin override (upload) : <code>' . esc_html(self::upload_override_path()) . '</code></div>';

        echo '<div style="display:flex; gap:10px; flex-wrap:wrap; margin:12px 0;">';
        echo '<a class="sp-btn sp-btn-secondary" target="_blank" rel="noopener" href="' . esc_url($preview_url) . '">Prévisualiser (données de démo)</a>';
        echo '<a class="sp-btn sp-btn-secondary" href="' . esc_url($download_active_url) . '">Télécharger le template actif</a>';
        echo '<a class="sp-btn sp-btn-secondary" href="' . esc_url($download_default_url) . '">Télécharger le template par défaut</a>';
        if ($tech_note_exists) {
            echo '<a class="sp-btn sp-btn-secondary" href="' . esc_url($download_doc_url) . '">Télécharger la note technique</a>';
        }
        if ($has_override) {
            echo '<a class="sp-btn sp-btn-danger" href="' . esc_url($reset_url) . '">Restaurer le template par défaut</a>';
        }
        echo '</div>';

        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '" enctype="multipart/form-data" style="margin-top:14px;">';
        echo '<input type="hidden" name="action" value="sosprescription_verif_template_upload">';
        wp_nonce_field('sosprescription_verif_template_upload');
        echo '<div class="sp-label">Uploader un nouveau template (HTML)</div>';
        echo '<div class="sp-muted" style="margin:6px 0 10px 0;">Ce fichier remplace l\'override actuel. Conservez les placeholders <code>{{...}}</code>.</div>';
        echo '<input type="file" name="verif_template_file" accept="text/html,.html,.htm" required>';
        echo '<div style="margin-top:10px;"><button type="submit" class="sp-btn sp-btn-primary">Uploader & activer</button></div>';
        echo '</form>';

        echo '</div>';

        // Token inspector
        $rows = [
            ['{{PRODUCT}}', 'Nom du produit / service (ex: SOS Prescription)'],
            ['{{RX_BADGE}}', 'Identifiant lisible ordonnance (ex: RX-XXXX)'],
            ['{{SCAN_REF}}', 'Référence scan (affichée en haut)'],
            ['{{UPDATED_LABEL}}', 'Dernière mise à jour (ex: 2026-01-10 08:12)'],
            ['{{DOCTOR_LABEL}}', 'Médecin (Nom + RPPS)'],
            ['{{PATIENT_NAME}}', 'Nom/Prénom patient'],
            ['{{PATIENT_BIRTH}}', 'Date de naissance + âge (label)'],
            ['{{PATIENT_WEIGHT_ROW_HTML}}', 'HTML injecté : ligne Poids/Taille (ou vide si absent)'],
            ['{{ISSUED_LABEL}}', 'Date d\'émission'],
            ['{{DISPENSE_LABEL}}', 'Statut délivrance (ex: Non renseigné / Délivrée)'],
            ['{{MED_COUNT}}', 'Nombre de lignes/médicaments'],
            ['{{DISPENSE_BADGE_HTML}}', 'HTML injecté : badge Délivrée / Non délivrée'],
            ['{{META_ROWS_HTML}}', 'HTML injecté : métadonnées (URL, identifiant, empreinte, code délivrance...)'],
            ['{{MED_LIST_HTML}}', 'HTML injecté : liste des médicaments'],
            ['{{PDF_ACTIONS_HTML}}', 'HTML injecté : boutons PDF (télécharger/voir)'],
            ['{{DISPENSE_SECTION_HTML}}', 'HTML injecté : statut + action “Marquer comme délivrée”'],
            ['{{FLASH_HTML}}', 'HTML injecté : messages succès/erreur (si action)'],
            ['{{HASH_SHORT}}', 'Empreinte courte (hash)'],
        ];

        $supported = [];
        foreach ($rows as $r) {
            $supported[] = (string) $r[0];
        }
        $supported_map = array_fill_keys($supported, true);

        $raw_for_scan = is_readable($active_path) ? (string) file_get_contents($active_path) : '';
        $found = [];
        if ($raw_for_scan !== '') {
            if (preg_match_all('/\{\{[A-Z0-9_]+\}\}/', $raw_for_scan, $m) === 1) {
                $found = array_values(array_unique((array) ($m[0] ?? [])));
            } elseif (!empty($m[0])) {
                $found = array_values(array_unique((array) ($m[0] ?? [])));
            }
        }
        sort($found);

        $unknown = [];
        foreach ($found as $tok) {
            if (!isset($supported_map[$tok])) {
                $unknown[] = $tok;
            }
        }

        echo '<h2>Variables disponibles (placeholders)</h2>';
        echo '<div class="sp-card" style="max-width:1000px; padding:16px;">';
        echo '<div class="sp-card-title">Inspection du template</div>';
        echo '<div class="sp-muted" style="margin-top:6px;">Tokens détectés dans le template : <strong>' . esc_html((string) count($found)) . '</strong>. Tokens inconnus : <strong>' . esc_html((string) count($unknown)) . '</strong>.</div>';
        if (count($unknown) > 0) {
            echo '<div class="sp-alert sp-alert-warning" style="margin-top:12px;">';
            echo '<strong>Tokens inconnus</strong> : ';
            $unknown_escaped = array_map('esc_html', $unknown);
            echo '<code>' . implode('</code>, <code>', $unknown_escaped) . '</code>';
            echo '<div class="sp-muted" style="margin-top:6px;">Ces tokens ne seront pas remplacés côté serveur (ils resteront visibles tels quels).</div>';
            echo '</div>';
        }

        echo '<table class="widefat striped" style="max-width:100%; margin-top:12px;">';
        echo '<thead><tr><th>Placeholder</th><th>Contenu</th><th>Présent</th></tr></thead><tbody>';
        foreach ($rows as $r) {
            $tok = (string) $r[0];
            $desc = (string) $r[1];
            $present = in_array($tok, $found, true);
            echo '<tr>';
            echo '<td><code>' . esc_html($tok) . '</code></td>';
            echo '<td>' . esc_html($desc) . '</td>';
            echo '<td>' . ($present ? '✅' : '—') . '</td>';
            echo '</tr>';
        }
        echo '</tbody></table>';
        echo '<div class="sp-muted" style="margin-top:10px;">Astuce : pour un rendu complet, conservez au minimum <code>{{MED_LIST_HTML}}</code>, <code>{{META_ROWS_HTML}}</code> et <code>{{DISPENSE_SECTION_HTML}}</code>.</div>';
        echo '</div>';

        echo '<h2>Note technique</h2>';
        echo '<div class="sp-card" style="max-width:1000px; padding:16px;">';
        echo '<div class="sp-card-title">Guide (Template /v/{token})</div>';
        echo '<p class="sp-muted" style="margin-top:6px;">Cette note résume les placeholders, les blocs injectés, les règles de sécurité (lien signé, actions), et un protocole de test.</p>';
        if ($tech_note_exists) {
            echo '<p><a class="sp-btn sp-btn-secondary" href="' . esc_url($download_doc_url) . '">Télécharger la note technique (HTML)</a></p>';
            echo '<details style="margin-top:10px;"><summary style="cursor:pointer;">Afficher la note dans l\'admin</summary>';
            $note = (string) file_get_contents(self::tech_note_path());
            echo '<textarea readonly style="width:100%; min-height:260px; font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace; font-size:12px;">' . esc_textarea($note) . '</textarea>';
            echo '</details>';
        } else {
            echo '<p style="color:#b45309;">Note technique introuvable dans le plugin (docs/verification-template-tech-note.html).</p>';
        }
        echo '</div>';

        echo '<h2>Aperçu du template actif</h2>';
        echo '<div class="sp-card" style="max-width:1000px; padding:16px;">';
        if ($active_preview !== '') {
            echo '<textarea readonly style="width:100%; min-height:420px; font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace; font-size:12px;">' . $active_preview . '</textarea>';
        } else {
            echo '<p style="color:#b45309;">Impossible de lire le template actif.</p>';
        }
        echo '</div>';

        echo '</div>';
    }

    /**
     * Backward-compat alias.
     */
    public static function render_page(): void
    {
        self::render();
    }

    public static function handle_upload(): void
    {
        if (!self::can_manage()) {
            wp_die(__('Accès refusé.', 'sosprescription'));
        }
        check_admin_referer('sosprescription_verif_template_upload');

        $redirect = admin_url('admin.php?page=' . self::SLUG);

        if (empty($_FILES['verif_template_file']) || !is_array($_FILES['verif_template_file'])) {
            wp_safe_redirect(add_query_arg('upload', 'missing', $redirect));
            exit;
        }
        $f = $_FILES['verif_template_file'];
        $tmp = (string) ($f['tmp_name'] ?? '');
        $name = (string) ($f['name'] ?? '');

        if ($tmp === '' || !is_uploaded_file($tmp)) {
            wp_safe_redirect(add_query_arg('upload', 'invalid', $redirect));
            exit;
        }

        $ext = strtolower((string) pathinfo($name, PATHINFO_EXTENSION));
        if (!in_array($ext, ['html', 'htm'], true)) {
            wp_safe_redirect(add_query_arg('upload', 'badext', $redirect));
            exit;
        }

        $contents = (string) file_get_contents($tmp);
        if ($contents === '' || strlen($contents) < 80) {
            wp_safe_redirect(add_query_arg('upload', 'empty', $redirect));
            exit;
        }

        $dir = self::upload_override_dir();
        if (!wp_mkdir_p($dir)) {
            wp_safe_redirect(add_query_arg('upload', 'mkdirfail', $redirect));
            exit;
        }

        $dest = self::upload_override_path();
        $ok = @file_put_contents($dest, $contents);
        if ($ok === false) {
            wp_safe_redirect(add_query_arg('upload', 'writefail', $redirect));
            exit;
        }

        Logger::info('verification_template_uploaded', [
            'name' => $name,
            'bytes' => strlen($contents),
            'dest' => $dest,
        ]);

        wp_safe_redirect(add_query_arg('upload', 'ok', $redirect));
        exit;
    }

    public static function handle_download_doc(): void
    {
        if (!self::can_manage()) {
            wp_die(__('Accès refusé.', 'sosprescription'));
        }
        check_admin_referer('sosprescription_verif_template_download_doc');

        $path = self::tech_note_path();
        if (!is_readable($path)) {
            wp_die(__('Document introuvable.', 'sosprescription'));
        }

        nocache_headers();

        header('Content-Type: text/html; charset=utf-8');
        header('Content-Disposition: attachment; filename=verification-template-tech-note.html');
        header('X-Content-Type-Options: nosniff');
        @readfile($path);
        exit;
    }

    public static function handle_reset(): void
    {
        if (!self::can_manage()) {
            wp_die(__('Accès refusé.', 'sosprescription'));
        }
        check_admin_referer('sosprescription_verif_template_reset');

        $redirect = admin_url('admin.php?page=' . self::SLUG);
        $path = self::upload_override_path();

        if (is_file($path)) {
            @unlink($path);
            Logger::info('verification_template_reset', ['path' => $path]);
        }

        wp_safe_redirect(add_query_arg('reset', 'ok', $redirect));
        exit;
    }

    /**
     * Preview the current verification template with demo data.
     *
     * This avoids requiring a real /v/{token} record to validate layout changes.
     */
    public static function handle_preview(): void
    {
        if (!self::can_manage()) {
            wp_die(__('Accès refusé.', 'sosprescription'));
        }

        check_admin_referer('sosprescription_verif_template_preview');

        [$path] = self::active_template();
        if (!is_readable($path)) {
            wp_die('Template introuvable.');
        }

        $template_html = (string) file_get_contents($path);
        if (trim($template_html) === '') {
            wp_die('Template vide.');
        }

        $cfg = new ComplianceConfig();
        $product = $cfg->get_product_name();

        // Demo data (no real medical data).
        $rx_badge = 'RX-31EE58-53E2';
        $scan_ref = 'V-DEMO';
        $updated_label = gmdate('Y-m-d H:i');
        $doctor_label = 'Pr Yves BURCKEL • RPPS 10000554302';
        $patient_name = 'M. Khaled RABII';
        $patient_birth = '14/01/1968 (57 ans)';
        $patient_weight_row_html = '<div class="row"><div class="k">Poids / Taille</div><div class="v">78 kg / 175 cm</div></div>';
        $issued_label = '10/01/2026 12:34';
        $dispense_label = 'Non renseigné';
        $med_count = '2';

        $hash_short = 'a1b2…c3d4';

        $flash_html = '<div class="alert ok"><strong>Aperçu (données fictives).</strong> Aucune donnée réelle n\'est affichée.</div>';

        $meta_rows_html = ''
            . '<div class="row"><div class="k">Vérification</div><div class="v"><code>' . esc_html((string) home_url('/v/DEMO…')) . '</code></div></div>'
            . '<div class="row"><div class="k">Identifiant</div><div class="v"><code>' . esc_html($rx_badge) . '</code></div></div>'
            . '<div class="row"><div class="k">Empreinte</div><div class="v"><code>' . esc_html($hash_short) . '</code></div></div>'
            . '<div class="row"><div class="k">Code délivrance</div><div class="v"><code>734637</code></div></div>';

        $med_list_html = ''
            . '<ul class="rx-list">'
            .   '<li class="rx-item"><span class="bullet"></span><div><div><strong>DOLIPRANE 1000 mg</strong></div><div class="detail">1 prise/jour pendant 5 jours (1@08:00)</div></div></li>'
            .   '<li class="rx-item"><span class="bullet"></span><div><div><strong>VOLTARENE 1%</strong></div><div class="detail">Application locale 2×/jour pendant 7 jours</div></div></li>'
            . '</ul>';

        // Actions are visually present but disabled (preview only).
        $pdf_actions_html = ''
            . '<a class="btn primary disabled" href="#">Télécharger le PDF</a>'
            . '<a class="btn secondary disabled" href="#">Afficher le PDF</a>';

        $dispense_badge_html = '<span class="badge warn"><span class="dot"></span>Non délivrée</span>';
        $dispense_section_html = ''
            . '<div class="dispense-box">'
            .   '<div class="dispense-title">Statut de délivrance</div>'
            .   '<div class="dispense-sub">Aperçu : action désactivée.</div>'
            .   '<button type="button" class="btn secondary disabled">Marquer comme délivrée</button>'
            .   '<div class="mini">Code à 6 chiffres imprimé sur l\'ordonnance.</div>'
            . '</div>';

        $map = [
            '{{PRODUCT}}' => esc_html($product),
            '{{RX_BADGE}}' => esc_html($rx_badge),
            '{{SCAN_REF}}' => esc_html($scan_ref),
            '{{UPDATED_LABEL}}' => esc_html($updated_label),
            '{{DOCTOR_LABEL}}' => esc_html($doctor_label),
            '{{PATIENT_NAME}}' => esc_html($patient_name),
            '{{PATIENT_BIRTH}}' => esc_html($patient_birth),
            '{{PATIENT_WEIGHT_ROW_HTML}}' => $patient_weight_row_html,
            '{{ISSUED_LABEL}}' => esc_html($issued_label),
            '{{DISPENSE_LABEL}}' => esc_html($dispense_label),
            '{{MED_COUNT}}' => esc_html($med_count),
            '{{HASH_SHORT}}' => esc_html($hash_short),
            '{{FLASH_HTML}}' => $flash_html,
            '{{META_ROWS_HTML}}' => $meta_rows_html,
            '{{MED_LIST_HTML}}' => $med_list_html,
            '{{PDF_ACTIONS_HTML}}' => $pdf_actions_html,
            '{{DISPENSE_BADGE_HTML}}' => $dispense_badge_html,
            '{{DISPENSE_SECTION_HTML}}' => $dispense_section_html,
        ];

        $html = strtr($template_html, $map);

        nocache_headers();
        header('Content-Type: text/html; charset=utf-8');
        echo $html;
        exit;
    }

    public static function handle_download_template(): void
    {
        if (!self::can_manage()) {
            wp_die(__('Accès refusé.', 'sosprescription'));
        }
        check_admin_referer('sosprescription_verif_template_download');

        $which = isset($_GET['which']) ? sanitize_key((string) $_GET['which']) : 'active';

        $path = '';
        $filename = 'verification-pharmacien.html';

        if ($which === 'default') {
            $path = self::default_template_path();
            $filename = 'verification-pharmacien.default.html';
        } else {
            [$p] = self::active_template();
            $path = $p;
            $filename = 'verification-pharmacien.active.html';
        }

        if (!is_readable($path)) {
            wp_die('Template introuvable.');
        }

        $contents = (string) file_get_contents($path);
        header('Content-Type: text/html; charset=utf-8');
        header('Content-Disposition: attachment; filename=' . $filename);
        header('Content-Length: ' . strlen($contents));
        echo $contents;
        exit;
    }
}
