<?php

namespace SosPrescription\Admin;

use SosPrescription\Repositories\FileRepository;
use SosPrescription\Services\RxPdfGenerator;
use SosPrescription\Services\Logger;

/**
 * Admin page: Ordonnances (PDF)
 * - Upload/override the mPDF HTML template without touching PHP
 * - Download active/default templates
 * - Download technical note about supported HTML/CSS
 */
class RxPage
{
    public const SLUG = 'sosprescription-rx';

    private static function can_manage(): bool
    {
        return current_user_can('sosprescription_manage') || current_user_can('manage_options');
    }

    public static function register_actions(): void
    {
        add_action('admin_post_sosprescription_rx_template_upload', [self::class, 'handle_upload']);
        add_action('admin_post_sosprescription_rx_template_reset', [self::class, 'handle_reset']);
        add_action('admin_post_sosprescription_rx_template_download', [self::class, 'handle_download_template']);
        add_action('admin_post_sosprescription_rx_doc_download', [self::class, 'handle_download_doc']);
        add_action('admin_post_sosprescription_rx_debug_save', [self::class, 'handle_debug_save']);
        add_action('admin_post_sosprescription_rx_template_download_file', [self::class, 'handle_template_download_file']);
                add_action('admin_post_sosprescription_rx_templates_upload_zip', [self::class, 'handle_upload_templates_zip']);

        // Preview & demo (no DB write)
        add_action('admin_post_sosprescription_rx_template_preview', [self::class, 'handle_preview']);
        add_action('admin_post_sosprescription_rx_template_demo_pdf', [self::class, 'handle_demo_pdf']);
        add_action('admin_post_sosprescription_rx_debug_config', [self::class, 'handle_debug_config']);
        add_action('admin_post_sosprescription_rx_templates_download_zip', [self::class, 'handle_download_templates_zip']);
    }

    /**
     * Default template shipped with the plugin.
     */
    private static function default_template_path(): string
    {
        return rtrim((string) SOSPRESCRIPTION_PATH, '/') . '/templates/rx-ordonnance-mpdf.html';
    }

    /**
     * Upload override template path.
     * NOTE: RxPdfGenerator auto-picks this path if present.
     */
    public static function upload_override_path(): string
    {
        $uploads = wp_upload_dir();
        $dir = rtrim((string) ($uploads['basedir'] ?? ''), '/') . '/sosprescription-templates';
        return $dir . '/rx-ordonnance-mpdf.html';
    }

    private static function upload_override_dir(): string
    {
        $uploads = wp_upload_dir();
        return rtrim((string) ($uploads['basedir'] ?? ''), '/') . '/sosprescription-templates';
    }

    private static function tech_note_path(): string
    {
        return rtrim((string) SOSPRESCRIPTION_PATH, '/') . '/docs/rx-template-tech-note.html';
    }

    /**
     * Returns [path, source_label].
     */
    private static function active_template(): array
    {
        $override = self::upload_override_path();
        if (is_readable($override)) {
            return [$override, 'upload'];
        }

        $default = self::default_template_path();
        return [$default, 'plugin'];
    }

    public static function render(): void
    {
        if (!self::can_manage()) {
            wp_die(__('Accès refusé.', 'sosprescription'));
        }

        
        $req_id = Logger::get_request_id();

        // Sécurité : s'assurer que la page admin reste bien en HTML (certaines libs image/QR peuvent modifier les headers).
        if (!headers_sent()) {
            header('Content-Type: text/html; charset=' . get_bloginfo('charset'));
        }

        Logger::info('admin', 'rx_page_render', [
            'req_id'  => $req_id,
            'user_id' => get_current_user_id(),
        ]);

        try {
[$active_path, $source] = self::active_template();
        $override_path = self::upload_override_path();
        $has_override = is_readable($override_path);

        $active_size = is_readable($active_path) ? filesize($active_path) : 0;
        $active_mtime = is_readable($active_path) ? gmdate('Y-m-d H:i:s', (int) filemtime($active_path)) : '';

        $download_tpl_url = wp_nonce_url(
            admin_url('admin-post.php?action=sosprescription_rx_template_download&which=active'),
            'sosprescription_rx_template_download'
        );
        $download_default_url = wp_nonce_url(
            admin_url('admin-post.php?action=sosprescription_rx_template_download&which=default'),
            'sosprescription_rx_template_download'
        );
        $download_doc_url = wp_nonce_url(
            admin_url('admin-post.php?action=sosprescription_rx_doc_download'),
            'sosprescription_rx_doc_download'
        );

        $preview_url = wp_nonce_url(
            admin_url('admin-post.php?action=sosprescription_rx_template_preview'),
            'sosprescription_rx_template_preview'
        );
        $demo_pdf_url = wp_nonce_url(
            admin_url('admin-post.php?action=sosprescription_rx_template_demo_pdf'),
            'sosprescription_rx_template_demo_pdf'
        );

        $download_all_templates_url = wp_nonce_url(
            admin_url('admin-post.php?action=sosprescription_rx_templates_download_zip'),
            'sosprescription_rx_templates_download_zip'
        );

        $reset_url = wp_nonce_url(
            admin_url('admin-post.php?action=sosprescription_rx_template_reset'),
            'sosprescription_rx_template_reset'
        );

        

        $debug_borders = (bool) get_option('sosprescription_mpdf_debug_borders', false);
        $debug_save_url = admin_url('admin-post.php?action=sosprescription_rx_debug_save');

        $detected_templates = self::scan_templates();

        // Read active template for preview (cap to avoid huge output)
        $active_raw_full = '';
        $active_preview = '';
        if (is_readable($active_path)) {
            $active_raw_full = (string) file_get_contents($active_path);
            $raw = $active_raw_full;
            if (strlen($raw) > 120000) {
                $raw = substr($raw, 0, 120000) . "\n\n<!-- … aperçu tronqué (120KB) … -->\n";
            }
            $active_preview = esc_textarea($raw);
        }

        // Token inspector (helps keep the template as "source of truth")
        $found_tokens = [];
        if ($active_raw_full !== '') {
            if (preg_match_all('/\{\{[A-Z0-9_]+\}\}/', $active_raw_full, $m)) {
                $found_tokens = array_values(array_unique($m[0] ?? []));
                sort($found_tokens);
            }
        }

        $demo = self::build_demo_data();
        $demo_sig = self::load_signature_for_demo();

        $demo_doctor_title = (string) ($demo['doctor_title'] ?? '');
        $demo_doctor_name = (string) ($demo['doctor_name'] ?? '');
        $demo_prefix = 'Dr';
        $t = strtolower(trim($demo_doctor_title));
        if (in_array($t, ['professeur', 'pr', 'prof', 'prof.'], true)) {
            $demo_prefix = 'Pr';
        }
        $demo_display = trim($demo_doctor_name);
        if ($demo_display === '') {
            $demo_display = $demo_prefix;
        } elseif (!preg_match('/^(Dr|Pr|Prof)\b/i', $demo_display)) {
            $demo_display = trim($demo_prefix . ' ' . $demo_display);
        }

        $demo_issue_place = (string) ($demo['issue_place'] ?? '');
        $demo_created_fr = (string) ($demo['created_fr'] ?? '');
        $demo_issue_line = '';
        if (trim($demo_issue_place) !== '' && trim($demo_created_fr) !== '') {
            $demo_issue_line = 'Fait à ' . trim($demo_issue_place) . ', le ' . trim($demo_created_fr);
        } elseif (trim($demo_created_fr) !== '') {
            $demo_issue_line = 'Le ' . trim($demo_created_fr);
        }

        // Build a data URI for the current doctor's signature (if any)
        $demo_sig_uri = '';
        if (is_array($demo_sig) && !empty($demo_sig['bytes']) && is_string($demo_sig['bytes'])) {
            $bytes = (string) $demo_sig['bytes'];
            $mime = 'image/png';
            if (!empty($demo_sig['type']) && is_string($demo_sig['type'])) {
                $tt = strtolower(trim((string) $demo_sig['type']));
                if ($tt === 'image/jpeg' || $tt === 'jpeg' || $tt === 'jpg') {
                    $mime = 'image/jpeg';
                } elseif ($tt === 'image/png' || $tt === 'png') {
                    $mime = 'image/png';
                }
            }
            if (substr($bytes, 0, 2) === "\xFF\xD8") {
                $mime = 'image/jpeg';
            } elseif (substr($bytes, 0, 8) === "\x89PNG\r\n\x1A\n") {
                $mime = 'image/png';
            }
            $demo_sig_uri = 'data:' . $mime . ';base64,' . base64_encode($bytes);
        }

        $token_defs = [
            '{{UID}}' => ['type' => 'texte', 'desc' => 'UID / identifiant dossier', 'example' => (string) ($demo['uid'] ?? '')],
            '{{DOSSIER_UID}}' => ['type' => 'texte', 'desc' => 'Alias UID (compat)', 'example' => (string) ($demo['uid'] ?? '')],
            '{{DATE_FR}}' => ['type' => 'texte', 'desc' => 'Date FR (jj/mm/aaaa)', 'example' => (string) ($demo['created_fr'] ?? '')],

            '{{DOCTOR_PREFIX}}' => ['type' => 'texte', 'desc' => 'Préfixe (Dr / Pr)', 'example' => (string) $demo_prefix],
            '{{DOCTOR_NAME}}' => ['type' => 'texte', 'desc' => 'Nom brut médecin (profil)', 'example' => (string) ($demo['doctor_name'] ?? '')],
            '{{DOCTOR_DISPLAY}}' => ['type' => 'texte', 'desc' => 'Nom affiché (préfixe + nom)', 'example' => (string) $demo_display],
            '{{SPECIALTY}}' => ['type' => 'texte', 'desc' => 'Spécialité', 'example' => (string) ($demo['doctor_specialty'] ?? '')],
            '{{RPPS}}' => ['type' => 'texte', 'desc' => 'RPPS', 'example' => (string) ($demo['doctor_rpps'] ?? '')],
            '{{ADDRESS}}' => ['type' => 'texte', 'desc' => 'Adresse pro', 'example' => (string) ($demo['doctor_address'] ?? '')],
            '{{PHONE}}' => ['type' => 'texte', 'desc' => 'Téléphone pro', 'example' => (string) ($demo['doctor_phone'] ?? '')],
            '{{DIPLOMA_LINE}}' => ['type' => 'texte', 'desc' => 'Ligne diplôme (premium)', 'example' => (string) ($demo['doctor_diploma_line'] ?? '')],

            '{{PATIENT_NAME}}' => ['type' => 'texte', 'desc' => 'Nom patient', 'example' => (string) ($demo['patient_name'] ?? '')],
            '{{PATIENT_BIRTH_LABEL}}' => ['type' => 'texte', 'desc' => 'DDN + âge (label)', 'example' => (string) ($demo['patient_birthdate_label'] ?? '')],
            '{{PATIENT_WH_LABEL}}' => ['type' => 'texte', 'desc' => 'Poids / Taille (label)', 'example' => (string) ($demo['patient_weight_height_label'] ?? '')],

            '{{VERIFY_URL}}' => ['type' => 'texte', 'desc' => 'URL de vérification (QR)', 'example' => (string) ($demo['verify_url'] ?? '')],
            '{{RX_PUBLIC_ID}}' => ['type' => 'texte', 'desc' => 'Identifiant public (RX-XXXX)', 'example' => (string) ($demo['verify_rx_public_id'] ?? '')],
            '{{HASH_SHORT}}' => ['type' => 'texte', 'desc' => 'Empreinte courte', 'example' => (string) ($demo['verify_hash_short'] ?? '')],
            '{{DELIVERY_CODE}}' => ['type' => 'texte', 'desc' => 'Code délivrance (6 chiffres)', 'example' => (string) ($demo['verify_code'] ?? '')],
            '{{MED_COUNT}}' => ['type' => 'texte', 'desc' => 'Compteur médicaments', 'example' => (string) ($demo['checksum_med_count'] ?? '')],
            '{{ISSUE_LINE}}' => ['type' => 'texte', 'desc' => 'Fait à … le …', 'example' => (string) $demo_issue_line],

            '{{MEDICATIONS_HTML}}' => ['type' => 'html', 'desc' => 'Bloc HTML liste médicaments', 'example' => 'HTML (liste générée)'],
            '{{QR_IMG_HTML}}' => ['type' => 'html', 'desc' => 'Balise <img> QR (data-uri)', 'example' => 'HTML <img> (QR)'],
            '{{BARCODE_HTML}}' => ['type' => 'html', 'desc' => 'Balise <barcode> mPDF (RPPS)', 'example' => 'HTML <barcode> (mPDF)'],
            '{{SIGNATURE_IMG_HTML}}' => ['type' => 'html', 'desc' => 'Balise <img> signature (data-uri)', 'example' => $demo_sig_uri !== '' ? 'HTML <img> (signature)' : 'Signature non dispo'],

            '{{QR_DATA_URI}}' => ['type' => 'texte', 'desc' => 'Data URI du QR (si besoin)', 'example' => !empty($demo['qr_jpeg_bytes_base64']) ? 'data:image/jpeg;base64,' . substr((string) $demo['qr_jpeg_bytes_base64'], 0, 20) . '…' : ''],
            '{{SIGNATURE_DATA_URI}}' => ['type' => 'texte', 'desc' => 'Data URI signature (si besoin)', 'example' => $demo_sig_uri !== '' ? substr($demo_sig_uri, 0, 40) . '…' : ''],
        ];

        $unknown_tokens = [];
        foreach ($found_tokens as $tok) {
            if (!isset($token_defs[$tok])) {
                $unknown_tokens[] = $tok;
            }
        }

        $missing_tokens = [];
        foreach (array_keys($token_defs) as $tok) {
            if (!in_array($tok, $found_tokens, true)) {
                $missing_tokens[] = $tok;
            }
        }

        $override_hint = self::upload_override_path();
        $tech_note_exists = is_readable(self::tech_note_path());

        echo '<div class="wrap sp-ui">';
        // Notice: template activated
        if (isset($_GET['activated']) && (string) $_GET['activated'] === '1') {
            $fn = isset($_GET['file']) ? sanitize_text_field((string) $_GET['file']) : '';
            echo '<div class="notice notice-success is-dismissible"><p>Template activé : <code>' . esc_html($fn) . '</code></p></div>';
        }

        // Notice: templates zip import
        if (isset($_GET['zip_upload'])) {
            $st = sanitize_text_field((string) $_GET['zip_upload']);
            $imported = isset($_GET['zip_imported']) ? (int) $_GET['zip_imported'] : 0;
            $skipped  = isset($_GET['zip_skipped']) ? (int) $_GET['zip_skipped'] : 0;
            $errors   = isset($_GET['zip_errors']) ? (int) $_GET['zip_errors'] : 0;

            if ($st === 'ok') {
                echo '<div class="notice notice-success is-dismissible"><p>Pack ZIP importé : <strong>' . esc_html((string) $imported) . '</strong> template(s) ajouté(s). ' . esc_html((string) $skipped) . ' ignoré(s), ' . esc_html((string) $errors) . ' erreur(s).</p></div>';
            } elseif ($st === 'partial') {
                echo '<div class="notice notice-warning is-dismissible"><p>Pack ZIP importé partiellement : <strong>' . esc_html((string) $imported) . '</strong> ajouté(s). ' . esc_html((string) $skipped) . ' ignoré(s), ' . esc_html((string) $errors) . ' erreur(s).</p></div>';
            } elseif ($st === 'missing') {
                echo '<div class="notice notice-error is-dismissible"><p>Aucun fichier ZIP fourni.</p></div>';
            } elseif ($st === 'no_zip') {
                echo '<div class="notice notice-error is-dismissible"><p>Extension PHP ZipArchive indisponible : import ZIP impossible.</p></div>';
            } else {
                echo '<div class="notice notice-error is-dismissible"><p>Import ZIP : échec (' . esc_html($st) . ').</p></div>';
            }
        }

        echo '<h1>Ordonnances (PDF)</h1>';
        echo '<p class="description">Gérez le template HTML/CSS utilisé pour générer les ordonnances (mPDF). Objectif : itérer sur le rendu <strong>sans toucher au PHP</strong>.</p>';


        // Active template summary
        echo '<div class="sp-alert">';
        echo '<div class="sp-alert-title">Template actif</div>';
        echo '<div>' . esc_html($source === 'upload' ? 'Template uploadé (override)' : 'Template du plugin (par défaut)') . '</div>';
        echo '<div style="margin-top:6px;"><span class="sp-code">' . esc_html($active_path) . '</span></div>';
        if ($active_mtime !== '') {
            echo '<div class="sp-muted" style="margin-top:6px;">Dernière modification : ' . esc_html($active_mtime) . ' UTC • Taille : ' . esc_html((string) $active_size) . ' octets</div>';
        }
        echo '</div>';

        echo '<h2>1) Template ordonnance</h2>';
        echo '<div class="sp-card" style="max-width:1000px;">';
        echo '<p><strong>Chemin override (upload)</strong> :<br><code>' . esc_html($override_hint) . '</code></p>';

        echo '<div style="display:flex; gap:10px; flex-wrap:wrap; margin:12px 0;">';
        echo '<a class="sp-btn sp-btn-secondary" href="' . esc_url($download_tpl_url) . '">Télécharger le template actif</a>';
        echo '<a class="sp-btn sp-btn-secondary" href="' . esc_url($download_default_url) . '">Télécharger le template par défaut</a>';
        if ($has_override) {
            echo '<a class="sp-btn sp-btn-secondary" style="border-color:#dc2626; color:#dc2626;" href="' . esc_url($reset_url) . '">Restaurer le template par défaut</a>';
        }
        echo '</div>';

        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '" enctype="multipart/form-data" style="margin-top:14px;">';
        echo '<input type="hidden" name="action" value="sosprescription_rx_template_upload">';
        wp_nonce_field('sosprescription_rx_template_upload');

        echo '<p style="margin:0 0 8px 0;"><strong>Uploader un nouveau template</strong> (HTML) — remplace l\'override actuel :</p>';
        echo '<input type="file" name="rx_template_file" accept="text/html,.html,.htm" required>';
        echo '<p style="margin:6px 0 10px 0; color:#6b7280;">Conseil : partez du template par défaut et modifiez progressivement (CSS limité, tables plutôt que flex/grid).</p>';
        echo '<button type="submit" class="sp-btn sp-btn-primary">Uploader & activer</button>';
        echo '</form>';


        // Upload pack ZIP (variants)
        $nonce_zip = wp_create_nonce('sosprescription_rx_templates_upload_zip');
        echo '<hr style="margin:16px 0; border:none; border-top:1px solid #e5e7eb;">';
        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '" enctype="multipart/form-data" style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">';
        echo '<input type="hidden" name="action" value="sosprescription_rx_templates_upload_zip">';
        echo '<input type="hidden" name="_wpnonce" value="' . esc_attr($nonce_zip) . '">';
        echo '<input type="file" name="rx_templates_zip" accept=".zip,application/zip" required>'; 
        echo '<button class="button button-secondary">Importer pack ZIP</button>';
        echo '<span class="description" style="flex-basis:100%;">Importe plusieurs templates <code>.html</code> (variantes) dans <code>uploads/sosprescription-templates/</code>. Le fichier <code>rx-ordonnance-mpdf.html</code> est ignoré pour éviter d&#039;écraser l&#039;override actif.</span>';
        echo '</form>';

        echo '</div>';

        
        // 1b) Debug (mPDF borders)
        echo '<h2>1b) Debug (mPDF)</h2>';
        echo '<div class="sp-card" style="max-width:1000px;">';
        echo '<form method="post" action="' . esc_url($debug_save_url) . '">';
        wp_nonce_field('sosprescription_rx_debug_save');
        echo '<label style="display:flex; gap:10px; align-items:center; margin:0;">';
        echo '<input type="checkbox" name="sosprescription_mpdf_debug_borders" value="1" ' . checked($debug_borders, true, false) . ' />';
        echo '<span><strong>Afficher les bordures de debug</strong> <span class="sp-muted">(rouge) pour visualiser les cellules et corriger le layout</span></span>';
        echo '</label>';
        echo '<p class="sp-muted" style="margin-top:8px;">Si activé, la génération PDF injecte un style de debug (<code>td, th, div { border: 0.1mm solid red !important; }</code>).</p>';
        echo '<p style="margin-top:12px;"><button class="sp-btn sp-btn-primary" type="submit">Enregistrer</button></p>';
        echo '</form>';
        echo '</div>';

        // 1c) Templates détectés + téléchargement
        echo '<h2>1c) Templates & Troubleshooting</h2>';
        echo '<div class="sp-card" style="max-width:1000px;">';
        echo '<p class="sp-muted">Templates détectés dans <code>templates/</code> (plugin) et <code>wp-content/uploads/sosprescription-templates/</code> (override).</p>';
        echo '<div style="display:flex; justify-content:flex-end; margin:10px 0 12px 0;">';
        echo '<a class="sp-btn sp-btn-secondary" href="' . esc_url($download_all_templates_url) . '">Tout télécharger (ZIP)</a>';
        echo '</div>';

        echo '<table class="sp-table">';
        echo '<thead><tr><th>Source</th><th>Fichier</th><th>Statut</th><th>Actions</th></tr></thead>';
        echo '<tbody>';
        foreach ($detected_templates as $tpl) {
            $is_active = (!empty($tpl['path']) && $tpl['path'] === $active_path);
            $status = $is_active ? '<span class="sp-badge sp-badge-success">Actif</span>' : '';
            $dl_url = wp_nonce_url(
                add_query_arg(
                    [
                        'action' => 'sosprescription_rx_template_download_file',
                        'source' => $tpl['source'],
                        'file'   => $tpl['file'],
                    ],
                    admin_url('admin-post.php')
                ),
                'sosprescription_rx_template_download_file'
            );

            $preview_tpl_url = wp_nonce_url(
                add_query_arg(
                    [
                        'action' => 'sosprescription_rx_template_preview',
                        'source' => $tpl['source'],
                        'file'   => $tpl['file'],
                    ],
                    admin_url('admin-post.php')
                ),
                'sosprescription_rx_template_preview'
            );

            $demo_tpl_pdf_url = wp_nonce_url(
                add_query_arg(
                    [
                        'action' => 'sosprescription_rx_template_demo_pdf',
                        'source' => $tpl['source'],
                        'file'   => $tpl['file'],
                    ],
                    admin_url('admin-post.php')
                ),
                'sosprescription_rx_template_demo_pdf'
            );

            // Audit Config (JSON) — outil de diagnostic “placeholders ↔ variables PHP”.
            $audit_url = wp_nonce_url(
                add_query_arg(
                    [
                        'action' => 'sosprescription_rx_debug_config',
                        'source' => $tpl['source'],
                        'file'   => $tpl['file'],
                    ],
                    admin_url('admin-post.php')
                ),
                'sosprescription_rx_debug_config'
            );

            $activate_url = wp_nonce_url(
                add_query_arg(
                    [
                        'action' => 'sosprescription_rx_template_activate',
                        'source' => $tpl['source'],
                        'file'   => $tpl['file'],
                    ],
                    admin_url('admin-post.php')
                ),
                'sosprescription_rx_template_activate'
            );


            echo '<tr>';
            echo '<td>' . esc_html($tpl['source_label']) . '</td>';
            echo '<td><code>' . esc_html($tpl['file']) . '</code></td>';
            echo '<td>' . $status . '</td>';
            echo '<td>';
            echo '<div class="sp-admin-actions">';
            echo '<a class="sp-icon-btn" title="Télécharger" aria-label="Télécharger" href="' . esc_url($dl_url) . '"><span class="dashicons dashicons-download"></span></a>';
            echo '<a class="sp-icon-btn" title="Prévisualiser" aria-label="Prévisualiser" target="_blank" rel="noopener" href="' . esc_url($preview_tpl_url) . '"><span class="dashicons dashicons-visibility"></span></a>';
            echo '<a class="sp-icon-btn" title="PDF Démo" aria-label="PDF Démo" href="' . esc_url($demo_tpl_pdf_url) . '"><span class="dashicons dashicons-media-document"></span></a>';
            echo '<a class="sp-icon-btn sp-icon-btn-danger" title="Audit Config" aria-label="Audit Config" href="' . esc_url($audit_url) . '"><span class="dashicons dashicons-admin-tools"></span></a>';
            if ($is_active) {
                echo '<span class="sp-badge sp-badge-success">Actif</span>';
            }
            if (!$is_active) {
                echo ' <a class="sp-btn sp-btn-primary" onclick="return confirm(\'Activer ce template ?\\n\\nIl remplacera le template actuel.\');" href="' . esc_url($activate_url) . '">Activer</a>';
            }
            echo '</div>';
            echo '</td>';
            echo '</tr>';
        }
        echo '</tbody>';
        echo '</table>';

        echo '<p class="sp-muted" style="margin-top:10px;">Astuce : utilisez “Prévisualiser le HTML brut” (section 3) pour vérifier les placeholders avant de passer par mPDF.</p>';
        echo '</div>';


        echo '<h2>2) Note technique (mPDF / CSS supporté)</h2>';
        echo '<div class="sp-card" style="max-width:1000px;">';
        echo '<p>Cette note résume les limitations du moteur (HTML/CSS “safe”), les variables disponibles et le protocole de test.</p>';
        if ($tech_note_exists) {
            echo '<p><a class="sp-btn sp-btn-secondary" href="' . esc_url($download_doc_url) . '">Télécharger la note technique (HTML)</a></p>';
        } else {
            echo '<p style="color:#b45309;">Note technique introuvable dans le plugin (docs/rx-template-tech-note.html).</p>';
        }
        echo '<details style="margin-top:10px;"><summary style="cursor:pointer;">Afficher la note dans l\'admin</summary>';
        if ($tech_note_exists) {
            $note = (string) file_get_contents(self::tech_note_path());
            // Keep it readable without executing HTML
            echo '<textarea readonly style="width:100%; min-height:260px; font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace; font-size:12px;">' . esc_textarea($note) . '</textarea>';
        }
        echo '</details>';
        echo '</div>';

        echo '<h2>3) Variables (tokens) disponibles</h2>';
        echo '<div class="sp-card" style="max-width:1000px;">';
        echo '<p class="sp-muted">Les tokens sont remplacés côté serveur lors du rendu mPDF. Écrivez-les exactement comme ci-dessous (avec les doubles accolades <code>{{TOKEN}}</code>).</p>';

        echo '<div class="sp-row sp-row-between" style="margin:10px 0 12px;">';
        echo '<div class="sp-row">';
        echo '<span class="sp-badge">Template : <strong>' . esc_html($source) . '</strong></span>';
        echo '<span class="sp-badge">Tokens détectés : <strong>' . esc_html((string) count($found_tokens)) . '</strong></span>';
        echo '<span class="sp-badge">Tokens supportés : <strong>' . esc_html((string) count($token_defs)) . '</strong></span>';
        echo '</div>';
        echo '</div>';

        if (!empty($unknown_tokens)) {
            echo '<div class="sp-alert" style="border-color:#fecaca; background:#fef2f2; margin-bottom:12px;">';
            echo '<strong>Tokens inconnus détectés dans le template :</strong> ' . esc_html(implode(', ', $unknown_tokens));
            echo '<div class="sp-muted" style="margin-top:6px;">Ces tokens ne seront pas remplacés (risque : affichage brut <code>{{...}}</code> dans le PDF). Corrigez le template ou ajoutez la variable côté PHP.</div>';
            echo '</div>';
        }

        echo '<div class="sp-table-wrap">';
        echo '<table class="sp-table">';
        echo '<thead><tr>';
        echo '<th style="width:22%;">Token</th>';
        echo '<th style="width:10%;">Type</th>';
        echo '<th>Description</th>';
        echo '<th style="width:25%;">Exemple (démo)</th>';
        echo '<th style="width:12%;">Dans le template</th>';
        echo '</tr></thead><tbody>';

        foreach ($token_defs as $tok => $meta) {
            $type = isset($meta['type']) ? (string) $meta['type'] : 'texte';
            $desc = isset($meta['desc']) ? (string) $meta['desc'] : '';
            $ex = isset($meta['example']) ? (string) $meta['example'] : '';
            if (strlen($ex) > 110) {
                $ex = substr($ex, 0, 110) . '…';
            }
            $present = in_array($tok, $found_tokens, true);

            echo '<tr>';
            echo '<td><code>' . esc_html($tok) . '</code></td>';
            echo '<td>' . esc_html($type) . '</td>';
            echo '<td>' . esc_html($desc) . '</td>';
            echo '<td><code style="white-space:nowrap;">' . esc_html($ex) . '</code></td>';
            echo '<td>' . ($present
                ? '<span class="sp-badge sp-badge-success">Présent</span>'
                : '<span class="sp-badge sp-badge-warn">Absent</span>') . '</td>';
            echo '</tr>';
        }

        echo '</tbody></table>';
        echo '</div>';

        if (!empty($missing_tokens)) {
            echo '<p class="sp-muted" style="margin-top:10px;">Tokens supportés mais non utilisés dans le template : <code>' . esc_html(implode('</code>, <code>', $missing_tokens)) . '</code></p>';
        }
        echo '</div>';

        echo '<h2>4) Aperçu du template actif</h2>';
        echo '<div class="sp-card" style="max-width:1000px;">';
        if ($active_preview !== '') {
            echo '<textarea readonly style="width:100%; min-height:420px; font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace; font-size:12px;">' . $active_preview . '</textarea>';
        } else {
            echo '<p style="color:#b45309;">Impossible de lire le template actif.</p>';
        }
        echo '</div>';

        echo '</div>';

        } catch (\Throwable $e) {
            Logger::log_scoped('runtime', 'rx', 'error', 'rx_page_render_exception', [
                'req_id' => $req_id,
                'error'  => $e->getMessage(),
                'file'   => $e->getFile(),
                'line'   => $e->getLine(),
            ]);

            echo '<div class="wrap">';

            echo '<h1>' . esc_html__('Ordonnances (PDF)', 'sosprescription') . '</h1>';
            echo '<div class="notice notice-error"><p>';

            echo '⛔ Erreur interne lors du rendu de la page. ReqID : <code>' . esc_html($req_id) . '</code>';
            echo '</p><p><small>' . esc_html($e->getMessage()) . '</small></p></div>';
            echo '</div>';
        }

    }

    /**
     * Backward-compat alias.
     *
     * Some admin menu registrations historically referenced RxPage::render_page.
     * Keep this method to avoid fatals if a callback still targets that name.
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
        check_admin_referer('sosprescription_rx_template_upload');

        if (empty($_FILES['rx_template_file']) || !is_array($_FILES['rx_template_file'])) {
            wp_redirect(admin_url('admin.php?page=' . self::SLUG . '&upload=missing'));
            exit;
        }
        $f = $_FILES['rx_template_file'];
        $tmp = (string) ($f['tmp_name'] ?? '');
        $name = (string) ($f['name'] ?? '');

        if ($tmp === '' || !is_uploaded_file($tmp)) {
            wp_redirect(admin_url('admin.php?page=' . self::SLUG . '&upload=invalid'));
            exit;
        }

        // Basic validation: extension + small sanity check
        $ext = strtolower((string) pathinfo($name, PATHINFO_EXTENSION));
        if (!in_array($ext, ['html', 'htm'], true)) {
            wp_redirect(admin_url('admin.php?page=' . self::SLUG . '&upload=badext'));
            exit;
        }

        $contents = (string) file_get_contents($tmp);
        if ($contents === '' || strlen($contents) < 50) {
            wp_redirect(admin_url('admin.php?page=' . self::SLUG . '&upload=empty'));
            exit;
        }
        if (stripos($contents, '{{UID}}') === false) {
            // Not blocking, but warn in logs
            Logger::log_scoped('runtime', 'rx', 'warning', 'rx_template_upload_missing_uid_placeholder', ['name' => $name]);
        }

        $dir = self::upload_override_dir();
        if (!wp_mkdir_p($dir)) {
            wp_redirect(admin_url('admin.php?page=' . self::SLUG . '&upload=mkdirfail'));
            exit;
        }
        $dest = self::upload_override_path();

        $ok = @file_put_contents($dest, $contents);
        if ($ok === false) {
            wp_redirect(admin_url('admin.php?page=' . self::SLUG . '&upload=writefail'));
            exit;
        }

        Logger::info('rx_template_uploaded', [
            'name' => $name,
            'bytes' => strlen($contents),
            'dest' => $dest,
        ]);

        wp_redirect(admin_url('admin.php?page=' . self::SLUG . '&upload=ok'));
        exit;
    }


    /**
     * Upload & extract a ZIP pack of HTML templates into the uploads override directory.
     * This is useful to import multiple template variants without FTP.
     */
    public static function handle_upload_templates_zip(): void
    {
        if (!current_user_can('manage_options')) {
            wp_die('Forbidden', 403);
        }

        check_admin_referer('sosprescription_rx_templates_upload_zip');

        if (empty($_FILES['rx_templates_zip']) || !is_array($_FILES['rx_templates_zip'])) {
            wp_safe_redirect(admin_url('admin.php?page=' . self::SLUG . '&zip_upload=missing'));
            exit;
        }

        if (!class_exists('\ZipArchive')) {
            wp_safe_redirect(admin_url('admin.php?page=' . self::SLUG . '&zip_upload=no_zip'));
            exit;
        }

        $file = $_FILES['rx_templates_zip'];

        if (!empty($file['error']) && (int) $file['error'] !== UPLOAD_ERR_OK) {
            wp_safe_redirect(admin_url('admin.php?page=' . self::SLUG . '&zip_upload=error'));
            exit;
        }

        require_once ABSPATH . 'wp-admin/includes/file.php';

        $overrides = [
            'test_form' => false,
            'mimes'     => [
                'zip' => 'application/zip',
            ],
        ];

        $upload = wp_handle_upload($file, $overrides);

        if (!empty($upload['error']) || empty($upload['file'])) {
            wp_safe_redirect(admin_url('admin.php?page=' . self::SLUG . '&zip_upload=error'));
            exit;
        }

        $zip_path = $upload['file'];

        $zip = new ZipArchive();
        $res = $zip->open($zip_path);
        if ($res !== true) {
            @unlink($zip_path);
            wp_safe_redirect(admin_url('admin.php?page=' . self::SLUG . '&zip_upload=invalid'));
            exit;
        }

        $dest_dir = self::upload_templates_dir();
        if (!is_dir($dest_dir)) {
            wp_mkdir_p($dest_dir);
        }

        if (!is_dir($dest_dir) || !is_writable($dest_dir)) {
            $zip->close();
            @unlink($zip_path);
            wp_safe_redirect(admin_url('admin.php?page=' . self::SLUG . '&zip_upload=not_writable'));
            exit;
        }

        $imported = [];
        $skipped  = [];
        $errors   = [];

        // Prevent accidental override of the active template.
        $reserved = basename(self::upload_override_path());

        for ($i = 0; $i < $zip->numFiles; $i++) {
            $stat = $zip->statIndex($i);
            if (empty($stat) || empty($stat['name'])) {
                continue;
            }

            $name = (string) $stat['name'];

            // Directories.
            if (substr($name, -1) === '/') {
                continue;
            }

            $base = basename($name);
            if (!preg_match('/\.html?$/i', $base)) {
                $skipped[] = $base;
                continue;
            }

            $san = sanitize_file_name($base);
            if ($san === '' || strpos($san, '..') !== false) {
                $skipped[] = $base;
                continue;
            }

            if ($san === $reserved) {
                $skipped[] = $san . ' (réservé)';
                continue;
            }

            $content = $zip->getFromIndex($i);
            if ($content === false) {
                $errors[] = $san;
                continue;
            }

            // Safety: avoid huge HTML payloads.
            if (strlen($content) > 1024 * 1024) {
                $skipped[] = $san . ' (trop lourd)';
                continue;
            }

            // Basic sanity check: the UID placeholder is mandatory.
            if (strpos($content, '{{UID}}') === false) {
                $skipped[] = $san . ' (placeholder {{UID}} manquant)';
                continue;
            }

            $target = trailingslashit($dest_dir) . $san;
            $written = @file_put_contents($target, $content);

            if ($written === false) {
                $errors[] = $san;
                continue;
            }

            $imported[] = $san;
        }

        $zip->close();
        @unlink($zip_path);

        Logger::info('rx_templates_zip_upload', [
            'imported' => $imported,
            'skipped'  => $skipped,
            'errors'   => $errors,
        ], 'rx');

        $args = [
            'zip_upload'   => empty($errors) ? 'ok' : 'partial',
            'zip_imported' => count($imported),
            'zip_skipped'  => count($skipped),
            'zip_errors'   => count($errors),
        ];

        wp_safe_redirect(add_query_arg($args, admin_url('admin.php?page=' . self::SLUG)));
        exit;
    }

    public static function handle_reset(): void
    {
        if (!self::can_manage()) {
            wp_die(__('Accès refusé.', 'sosprescription'));
        }
        check_admin_referer('sosprescription_rx_template_reset');

        $override = self::upload_override_path();
        if (is_file($override)) {
            @unlink($override);
            Logger::info('rx_template_reset_to_default', ['path' => $override]);
        }

        wp_redirect(admin_url('admin.php?page=' . self::SLUG . '&reset=ok'));
        exit;
    }

    public static function handle_download_template(): void
    {
        if (!self::can_manage()) {
            wp_die(__('Accès refusé.', 'sosprescription'));
        }
        check_admin_referer('sosprescription_rx_template_download');

        $which = (string) ($_GET['which'] ?? 'active');
        $path = '';
        $filename = '';

        if ($which === 'default') {
            $path = self::default_template_path();
            $filename = 'rx-ordonnance-mpdf-default.html';
        } else {
            [$path] = self::active_template();
            $filename = 'rx-ordonnance-mpdf-active.html';
        }

        if (!is_readable($path)) {
            wp_die(__('Template introuvable.', 'sosprescription'));
        }

        // Clean any buffered output before sending headers (prevents corrupted downloads).
        while (ob_get_level()) {
            @ob_end_clean();
        }

        nocache_headers();
        header('Content-Type: text/html; charset=UTF-8');
        header('Content-Disposition: attachment; filename=' . $filename);
        echo (string) file_get_contents($path);
        exit;
    }

    public static function handle_download_doc(): void
    {
        if (!self::can_manage()) {
            wp_die(__('Accès refusé.', 'sosprescription'));
        }
        check_admin_referer('sosprescription_rx_doc_download');

        $path = self::tech_note_path();
        if (!is_readable($path)) {
            wp_die(__('Note technique introuvable.', 'sosprescription'));
        }

        nocache_headers();
        header('Content-Type: text/html; charset=UTF-8');
        header('Content-Disposition: attachment; filename=rx-template-tech-note.html');
        echo (string) file_get_contents($path);
        exit;
    }


    /**
     * Save mPDF debug flags (borders).
     */
    public static function handle_debug_save(): void
    {
        if (!current_user_can('manage_options')) {
            wp_die('Accès refusé.');
        }
        check_admin_referer('sosprescription_rx_debug_save');

        $enabled = !empty($_POST['sosprescription_mpdf_debug_borders']);
        update_option('sosprescription_mpdf_debug_borders', $enabled ? '1' : '0', false);

        Logger::info('admin', 'rx_debug_borders_saved', ['enabled' => $enabled]);

        wp_safe_redirect(admin_url('admin.php?page=sosprescription-rx'));
        exit;
    }

    /**
     * Download any detected template file (plugin/templates or uploads override dir).
     * This is intentionally restrictive to avoid path traversal.
     */
    public static function handle_template_download_file(): void
    {
        if (!current_user_can('manage_options')) {
            wp_die('Accès refusé.');
        }
        check_admin_referer('sosprescription_rx_template_download_file');

        $source = isset($_GET['source']) ? sanitize_text_field((string) $_GET['source']) : '';
        $file   = isset($_GET['file']) ? sanitize_file_name((string) $_GET['file']) : '';
        $file   = basename($file);

        if ($file === '' || !preg_match('/\.html?$/i', $file)) {
            wp_die('Fichier invalide.');
        }

        if ($source === 'plugin') {
            $base = trailingslashit(SOSPRESCRIPTION_PATH . 'templates');
            $source_label = 'plugin';
        } elseif ($source === 'uploads') {
            $base = self::upload_templates_dir();
            $source_label = 'uploads';
        } else {
            wp_die('Source invalide.');
        }

        $path = $base . $file;
        if (!is_readable($path)) {
            wp_die('Template introuvable.');
        }

        nocache_headers();
        header('Content-Type: text/html; charset=UTF-8');
        header('Content-Disposition: attachment; filename=' . $source_label . '-' . $file);
        header('X-Content-Type-Options: nosniff');

        echo (string) file_get_contents($path);
        exit;
    }

    /**
     * Activate a detected template (copy it as the uploads override: rx-ordonnance-mpdf.html).
     * This lets admins switch between variants without manual download/upload.
     */
    public static function handle_template_activate(): void
    {
        if (!current_user_can('manage_options')) {
            wp_die('Accès refusé.');
        }
        check_admin_referer('sosprescription_rx_template_activate');

        $source = isset($_GET['source']) ? sanitize_text_field((string) $_GET['source']) : '';
        $file   = isset($_GET['file']) ? sanitize_file_name((string) $_GET['file']) : '';
        $file   = basename($file);

        if ($file === '' || !preg_match('/\.html?$/i', $file)) {
            wp_die('Fichier invalide.');
        }

        if ($source === 'plugin') {
            $base = trailingslashit(SOSPRESCRIPTION_PATH . 'templates');
        } elseif ($source === 'uploads') {
            $base = self::upload_templates_dir();
        } else {
            wp_die('Source invalide.');
        }

        $src = $base . $file;
        if (!is_readable($src)) {
            wp_die('Template introuvable.');
        }

        // Ensure override dir exists.
        $dir = self::upload_override_dir();
        if (!is_dir($dir)) {
            wp_mkdir_p($dir);
        }

        $dst = self::upload_override_path();
        $html = (string) file_get_contents($src);
        if ($html === '') {
            wp_die('Impossible de lire le template.');
        }

        $ok = (bool) file_put_contents($dst, $html);
        if (!$ok) {
            wp_die("Impossible d'écrire le template override (permissions).");
        }

        Logger::info('admin', 'rx_template_activated', [
            'source' => $source,
            'file'   => $file,
            'dst'    => $dst,
        ]);

        wp_safe_redirect(add_query_arg(['page' => self::SLUG, 'activated' => '1', 'file' => rawurlencode($file)], admin_url('admin.php')));
        exit;
    }




    /**
     * Permet de prévisualiser / générer un PDF de démo à partir d'un template non actif.
     *
     * Usage :
     * - /admin-post.php?action=sosprescription_rx_template_preview&source=plugin|uploads&file=...
     * - /admin-post.php?action=sosprescription_rx_template_demo_pdf&source=plugin|uploads&file=...
     *
     * Le template est résolu via (source,file) parmi la liste scannée, puis injecté via le filtre
     * `sosprescription_rx_template_path` le temps de la requête.
     *
     * @param array<string,mixed> $data
     */
    private static function maybe_apply_template_override_from_query(array &$data): void
    {
        $source = isset($_GET['source']) ? sanitize_text_field((string) wp_unslash($_GET['source'])) : '';
        $file = isset($_GET['file']) ? sanitize_file_name((string) wp_unslash($_GET['file'])) : '';

        if ($source === '' || $file === '') {
            return;
        }

        $path = '';
        foreach (self::scan_templates() as $tpl) {
            if (($tpl['source'] ?? '') === $source && ($tpl['file'] ?? '') === $file) {
                $path = (string) ($tpl['path'] ?? '');
                break;
            }
        }

        if ($path === '' || !is_file($path) || !is_readable($path)) {
            return;
        }

        add_filter(
            'sosprescription_rx_template_path',
            static function ($current) use ($path) {
                return $path;
            },
            9999
        );

        $data['__template_source'] = $source . ':' . $file;
    }

    /**
     * Télécharge un ZIP contenant tous les templates détectés (plugin + uploads override).
     */
    public static function handle_download_templates_zip(): void
    {
        if (!current_user_can('manage_options')) {
            wp_die('Accès refusé.');
        }

        check_admin_referer('sosprescription_rx_templates_download_zip');

        $templates = self::scan_templates();
        if (empty($templates)) {
            wp_die('Aucun template détecté.');
        }

        if (!class_exists('\ZipArchive')) {
            wp_die('ZipArchive non disponible sur ce serveur.');
        }

        $tmp = wp_tempnam('sosprescription-templates');
        if (!is_string($tmp) || $tmp === '') {
            $tmp = rtrim((string) sys_get_temp_dir(), '/') . '/sosprescription-templates-' . gmdate('Ymd-His');
        }
        // wp_tempnam crée un fichier ; on s'assure d'avoir un .zip et on supprime le fichier temp initial si besoin.
        if (substr($tmp, -4) !== '.zip') {
            @unlink($tmp);
            $tmp .= '.zip';
        }

        $zip = new \ZipArchive();
        $ok = $zip->open($tmp, \ZipArchive::CREATE | \ZipArchive::OVERWRITE);
        if ($ok !== true) {
            wp_die('Impossible de créer le ZIP temporaire.');
        }

        $used = [];
        foreach ($templates as $tpl) {
            $path = (string) ($tpl['path'] ?? '');
            if ($path === '' || !is_readable($path)) {
                continue;
            }
            $prefix = (($tpl['source'] ?? '') === 'uploads') ? 'uploads/' : 'plugin/';
            $entry = $prefix . basename($path);

            $base = $entry;
            $i = 2;
            while (in_array($entry, $used, true)) {
                $entry = preg_replace('/\.html$/i', '', $base) . '_' . $i . '.html';
                $i++;
            }

            $used[] = $entry;
            $zip->addFile($path, $entry);
        }

        $zip->close();

        // Log best-effort
        try {
            Logger::log_scoped('runtime', 'sosprescription_admin', 'info', 'rx_templates_zip_download', [
                'count' => count($used),
            ]);
        } catch (\Throwable $e) {
            // ignore
        }

        $filename = 'sosprescription-templates-' . gmdate('Ymd-His') . '.zip';

        nocache_headers();
        header('Content-Type: application/zip');
        header('Content-Disposition: attachment; filename="' . $filename . '"');
        header('Content-Length: ' . (string) filesize($tmp));
        readfile($tmp);
        @unlink($tmp);
        exit;
    }


    private static function upload_templates_dir(): string
    {
        $u = wp_upload_dir();
        return trailingslashit($u['basedir']) . 'sosprescription-templates/';
    }

    /**
     * Scan both plugin templates and uploads overrides.
     *
     * @return array<int, array{source:string,source_label:string,file:string,path:string}>
     */
    private static function scan_templates(): array
    {
        $items = [];

        $plugin_dir = trailingslashit(SOSPRESCRIPTION_PATH . 'templates');
        if (is_dir($plugin_dir)) {
            foreach (glob($plugin_dir . '*.html') ?: [] as $path) {
                $items[] = [
                    'source'       => 'plugin',
                    'source_label' => 'Plugin',
                    'file'         => basename((string) $path),
                    'path'         => (string) $path,
                ];
            }
        }

        $uploads_dir = self::upload_templates_dir();
        if (is_dir($uploads_dir)) {
            foreach (glob($uploads_dir . '*.html') ?: [] as $path) {
                $items[] = [
                    'source'       => 'uploads',
                    'source_label' => 'Uploads (override)',
                    'file'         => basename((string) $path),
                    'path'         => (string) $path,
                ];
            }
        }

        usort(
            $items,
            static function (array $a, array $b): int {
                $s = strcmp((string) $a['source'], (string) $b['source']);
                if ($s !== 0) {
                    return $s;
                }
                return strcmp((string) $a['file'], (string) $b['file']);
            }
        );

        return $items;
    }


    /**
     * Preview the active template in-browser with demo data (no DB write).
     */
    public static function handle_preview(): void
    {
        if (!self::can_manage()) {
            wp_die(__('Accès refusé.', 'sosprescription'));
        }
        check_admin_referer('sosprescription_rx_template_preview');

        $data = self::build_demo_data();
        self::maybe_apply_template_override_from_query($data);
        $sig = self::load_signature_for_demo();

        $html = RxPdfGenerator::render_template_html($data, $sig);
        if (is_wp_error($html)) {
            wp_die('Erreur prévisualisation template : ' . esc_html($html->get_error_message()));
        }

        Logger::info('rx_template_preview', [
            'template' => $data['__template_source'] ?? 'active',
        ]);

        nocache_headers();
        header('Content-Type: text/html; charset=UTF-8');
        echo $html;
        exit;
    }

    /**
     * Download a demo PDF generated from the active template (no DB write).
     */
    
    /**
     * Admin action: download a JSON audit of template placeholders vs injected variables (no PDF generation).
     * URL: admin-post.php?action=sosprescription_rx_debug_config&source=...&file=...
     */
    public static function handle_debug_config(): void
    {
        if (!self::can_manage()) {
            wp_die('Accès refusé.');
        }
        check_admin_referer('sosprescription_rx_debug_config');

        // Avoid any PHP notices/warnings being printed before our JSON headers.
        // (Some external plugins can emit notices during admin-post requests.)
        @ini_set('display_errors', '0');
        @ini_set('html_errors', '0');

        // Start a buffer so any stray output (notices/warnings) can be safely discarded.
        @ob_start();

        $source = sanitize_text_field(wp_unslash($_GET['source'] ?? ''));
        $file   = sanitize_text_field(wp_unslash($_GET['file'] ?? ''));

        // Load template source HTML (raw, with {{PLACEHOLDERS}}).
        $templates = self::scan_templates();
        $target = null;
        foreach ($templates as $t) {
            if (($t['source'] ?? '') === $source && ($t['file'] ?? '') === $file) {
                $target = $t;
                break;
            }
        }

        // Fallback: active template if target not found / params missing.
        if (!$target) {
            $active = get_option('sosprescription_rx_template_active', 'plugin:rx-ordonnance-mpdf.html');
            if (strpos($active, 'uploads:') === 0) {
                $target = [
                    'source' => 'uploads',
                    'file'   => basename(substr($active, strlen('uploads:'))),
                    'path'   => self::upload_templates_dir() . basename(substr($active, strlen('uploads:'))),
                ];
            } else {
                $target = [
                    'source' => 'plugin',
                    'file'   => basename(substr($active, strlen('plugin:'))),
                    'path'   => SOSPRESCRIPTION_PLUGIN_DIR . 'templates/' . basename(substr($active, strlen('plugin:'))),
                ];
            }
        }

        $template_path = $target['path'] ?? '';
        $template_html = '';
        if ($template_path && file_exists($template_path)) {
            $template_html = file_get_contents($template_path);
        }
        if ($template_html === '' || $template_html === false) {
            wp_die('Template introuvable ou illisible.');
        }

        // Extract placeholders {{PLACEHOLDER}} from template source.
        $placeholders = [];
        if (preg_match_all('/\{\{\s*([A-Z0-9_]+)\s*\}\}/', $template_html, $m)) {
            foreach ($m[1] as $ph) {
                $placeholders[] = '{{' . $ph . '}}';
            }
        }
        $placeholders = array_values(array_unique($placeholders));
        sort($placeholders);

        // Build demo data and replacements.
        $demo = self::build_demo_data();
        // Ensure the generator uses the requested template when computing replacements.
        $demo['__template_source'] = $target['source'] ?? 'plugin';
        $demo['__template_file']   = $target['file'] ?? 'rx-ordonnance-mpdf.html';

        $sig  = self::load_signature_for_demo();
        $repl = \SosPrescription\Services\RxPdfGenerator::debug_build_template_replacements($demo, $sig);

        $injected_keys = array_keys($repl);
        sort($injected_keys);

        $missing = array_values(array_diff($placeholders, $injected_keys));
        $unused  = array_values(array_diff($injected_keys, $placeholders));

        // Build a readable representation (avoid huge base64 payloads).
        $vars = [];
        foreach ($repl as $k => $v) {
            if (is_array($v)) {
                $vars[$k] = [
                    'type' => 'array',
                    'count' => count($v),
                ];
                continue;
            }
            $s = (string)$v;
            $len = strlen($s);
            $entry = [
                'type' => 'string',
                'len'  => $len,
            ];
            if ($len <= 500) {
                $entry['value'] = $s;
            } else {
                $entry['preview'] = substr($s, 0, 200) . '…';
                $entry['sha1'] = sha1($s);
            }
            $vars[$k] = $entry;
        }

        // Metrics (dimensions sent to images, etc.)
        $metrics = [
            'qr' => [
                'mm' => ['w' => 18.0, 'h' => 18.0],
                'present' => (!empty($repl['{{QR_IMG_HTML}}']) && strpos($repl['{{QR_IMG_HTML}}'], '<img') !== false),
            ],
            'signature' => [
                'present' => (!empty($repl['{{SIGNATURE_IMG_HTML}}']) && strpos($repl['{{SIGNATURE_IMG_HTML}}'], '<img') !== false),
                // Expected size (single source of truth lives in RxPdfGenerator)
                'expected_mm' => ['w' => 55.0, 'h' => 18.0],
                'mm' => ['w' => null, 'h' => null],
            ],
        ];
        // Try to parse signature sizes from the generated <img ...>.
        if (!empty($repl['{{SIGNATURE_IMG_HTML}}']) && strpos($repl['{{SIGNATURE_IMG_HTML}}'], '<img') !== false) {
            if (preg_match('/width="([0-9\.]+)mm"/i', $repl['{{SIGNATURE_IMG_HTML}}'], $mmw)) {
                $metrics['signature']['mm']['w'] = (float)$mmw[1];
            }
            if (preg_match('/height="([0-9\.]+)mm"/i', $repl['{{SIGNATURE_IMG_HTML}}'], $mmh)) {
                $metrics['signature']['mm']['h'] = (float)$mmh[1];
            }
        }

        $payload = [
            'meta' => [
                'generated_at_utc' => gmdate('c'),
                'plugin_version'   => SOSPRESCRIPTION_VERSION,
                'wp_version'       => get_bloginfo('version'),
                'php_version'      => PHP_VERSION,
            ],
            // Snapshot of the effective mPDF config used for ordonnance rendering.
            // Useful to validate critical flags (eg: shrink_tables_to_fit).
            'mpdf_config' => \SosPrescription\Services\RxPdfGenerator::debug_get_mpdf_config(),
            'template' => [
                'source' => $target['source'] ?? '',
                'file'   => $target['file'] ?? '',
                'path'   => $template_path,
                'sha1'   => sha1($template_html),
                'size_bytes' => strlen($template_html),
            ],
            'placeholders' => $placeholders,
            'injected' => [
                'keys' => $injected_keys,
                'vars' => $vars,
            ],
            'delta' => [
                'missing_placeholders' => $missing,
                'unused_vars'          => $unused,
            ],
            'metrics' => $metrics,
        ];

        \SosPrescription\Services\Logger::info('rx_template_audit_config', [
            'source' => $target['source'] ?? '',
            'file'   => $target['file'] ?? '',
            'ph_count' => count($placeholders),
            'vars_count' => count($injected_keys),
            'missing' => count($missing),
            'unused' => count($unused),
        ]);

        $fname = 'sosprescription-rx-audit-config-' . gmdate('Ymd-His') . '.json';
        // Clean any buffered output before sending JSON (prevents corrupted downloads).
        while (ob_get_level()) {
            @ob_end_clean();
        }

        nocache_headers();
        header('Content-Type: application/json; charset=utf-8');
        header('Content-Disposition: attachment; filename="' . $fname . '"');
        $json = wp_json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if (!is_string($json) || $json === '') {
            $json = json_encode([
                'error' => 'json_encode_failed',
                'json_last_error' => function_exists('json_last_error_msg') ? json_last_error_msg() : (string) json_last_error(),
            ], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        }
        echo (string) $json;
        exit;
    }

public static function handle_demo_pdf(): void
    {
        if (!self::can_manage()) {
            wp_die(__('Accès refusé.', 'sosprescription'));
        }
        check_admin_referer('sosprescription_rx_template_demo_pdf');

        $data = self::build_demo_data();
        self::maybe_apply_template_override_from_query($data);
        $sig = self::load_signature_for_demo();

        $bytes = RxPdfGenerator::build_pdf_bytes_from_data($data, $sig);
        if (is_wp_error($bytes)) {
            wp_die('Erreur génération PDF (démo) : ' . esc_html($bytes->get_error_message()));
        }

        Logger::info('rx_template_demo_pdf', [
            'bytes' => is_string($bytes) ? strlen($bytes) : 0,
        ]);

        nocache_headers();
        header('Content-Type: application/pdf');
        header('Content-Disposition: attachment; filename=ordonnance-demo.pdf');
        echo $bytes;
        exit;
    }

    /**
     * Builds a stable demo dataset compatible with the ordonnance template tokens.
     *
     * @return array<string,mixed>
     */
    private static function build_demo_data(): array
    {
        $now = time();
        $uid = 'RX-DEMO-' . strtoupper(substr(md5((string) $now), 0, 10));

        $current = wp_get_current_user();
        $user_id = get_current_user_id();

        $doctor_name = trim((string) ($current->display_name ?? ''));
        if ($doctor_name === '') {
            $doctor_name = 'Yves BURCKEL';
        }

        $doctor_title = (string) get_user_meta($user_id, 'sosprescription_doctor_title', true);
        if (trim($doctor_title) === '') {
            $doctor_title = 'Docteur';
        }
        $doctor_specialty = (string) get_user_meta($user_id, 'sosprescription_doctor_specialty', true);
        if (trim($doctor_specialty) === '') {
            $doctor_specialty = 'Médecine générale';
        }
        $doctor_rpps = (string) get_user_meta($user_id, 'sosprescription_doctor_rpps', true);
        if (trim($doctor_rpps) === '') {
            $doctor_rpps = '10000554302';
        }

        $doctor_address = (string) get_user_meta($user_id, 'sosprescription_doctor_address', true);
        if (trim($doctor_address) === '') {
            $doctor_address = '184 avenue Vauban, 06700 Saint-Laurent-du-Var';
        }
        $doctor_phone = (string) get_user_meta($user_id, 'sosprescription_doctor_phone', true);
        $doctor_diploma_line = (string) get_user_meta($user_id, 'sosprescription_doctor_diploma_line', true);
        if (trim($doctor_diploma_line) === '') {
            $doctor_diploma_line = 'Diplômé Faculté Paris XIII • Lauréat de l\'Académie';
        }
        $issue_place = (string) get_user_meta($user_id, 'sosprescription_doctor_issue_place', true);
        if (trim($issue_place) === '') {
            $issue_place = 'Saint-Laurent-du-Var';
        }

        $created_fr = wp_date('d/m/Y', $now);

        $verify_token = strtolower(substr(hash('sha256', $uid . '|' . $doctor_rpps), 0, 16));
        $verify_url = home_url('/v/' . $verify_token);
        $verify_code = '734637';
        $verify_hash_short = substr(hash('sha256', $uid . '|' . $verify_token), 0, 12);
        $verify_rx_public_id = 'RX-' . strtoupper(substr(hash('sha1', $uid), 0, 4)) . '-' . strtoupper(substr(hash('sha1', $doctor_rpps), 0, 4));

        $qr_b64 = RxPdfGenerator::generate_qr_jpeg_base64($verify_url);

        $items = [
            [
                'display_name' => 'DOLIRHUME PARACETAMOL ET PSEUDOEPHEDRINE',
                'strength' => '500 mg/30 mg',
                'form' => 'comprimé',
                'posology_text' => '1 fois par jour pendant 5 jours (1@08:00)',
            ],
            [
                'display_name' => 'CETIRIZINE',
                'strength' => '10 mg',
                'form' => 'comprimé pelliculé',
                'posology_text' => '1 fois par jour pendant 7 jours (1@20:00)',
            ],
        ];

        return [
            'uid' => $uid,
            'created_fr' => $created_fr,

            'doctor_title' => $doctor_title,
            'doctor_name' => $doctor_name,
            'doctor_specialty' => $doctor_specialty,
            'doctor_rpps' => $doctor_rpps,
            'doctor_address' => $doctor_address,
            'doctor_phone' => $doctor_phone,
            'doctor_diploma_line' => $doctor_diploma_line,
            'issue_place' => $issue_place,

            'patient_name' => 'M. Khaled RABII',
            'patient_birthdate_label' => '14/01/1968 (57 ans)',
            'patient_weight_height_label' => '78 kg / 175 cm',

            'verify_url' => $verify_url,
            'verify_rx_public_id' => $verify_rx_public_id,
            'verify_hash_short' => $verify_hash_short,
            'verify_code' => $verify_code,
            'checksum_med_count' => count($items),

            'qr_jpeg_bytes_base64' => $qr_b64,
            'items' => $items,
        ];
    }

    /**
     * Best-effort: attach the currently logged-in doctor's signature into the demo (if available).
     *
     * @return array{type?:string,bytes?:string}|null
     */
    private static function load_signature_for_demo(): ?array
    {
        $user_id = get_current_user_id();
        if ($user_id <= 0) {
            return null;
        }

        $file_id = (int) get_user_meta($user_id, 'sosprescription_signature_file_id', true);
        if ($file_id <= 0) {
            return null;
        }

        $repo = new FileRepository();
        $file = $repo->get($file_id);
        if (!$file) {
            return null;
        }

        $path = $repo->get_file_absolute_path($file_id);
        if (is_wp_error($path) || !is_string($path) || !is_readable($path)) {
            return null;
        }

        $bytes = @file_get_contents($path);
        if (!is_string($bytes) || $bytes === '') {
            return null;
        }

        $mime = (string) ($file['mime'] ?? 'image/png');
        return [
            'type' => $mime,
            'bytes' => $bytes,
        ];
    }
}
