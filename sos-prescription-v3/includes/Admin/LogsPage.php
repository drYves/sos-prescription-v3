<?php
declare(strict_types=1);

namespace SOSPrescription\Admin;

use SOSPrescription\Services\Logger;
use SOSPrescription\Services\DiagnosticsService;
use SOSPrescription\Services\SandboxConfig;

final class LogsPage
{
    /**
     * Scopes connus (shortcodes).
     *
     * @return array<string, string>
     */
    private static function known_scopes(): array
    {
        return [
            'sosprescription_form' => 'Formulaire patient (création ordonnance)',
            'sosprescription_admin' => 'Interface médecin (validation)',
            'sosprescription_patient' => 'Espace patient (profil, demandes)',
            'sosprescription_doctor_account' => 'Compte médecin (profil, signature)',
            'sosprescription_bdpm_table' => 'Catalogue BDPM (table front)',
            'sosprescription_rxpdf' => 'Génération ordonnance PDF (mPDF)',
            'rest_errors' => 'REST API (erreurs)',
            'rest_perm' => 'REST API (permissions denied)',
            'system' => 'Système / Stockage (maintenance)',
            'gp_theme' => 'Thème / GeneratePress (diagnostic layout)',
            'php_debug' => 'PHP debug.log (warnings/notices)',
        ];
    }

    public static function register_actions(): void
    {
        // Settings
        add_action('admin_post_sosprescription_logs_save', [self::class, 'handle_save']);

        // Backward compat (ancienne action)
        add_action('admin_post_sosprescription_logs_toggle', [self::class, 'handle_save']);

        // Files
        add_action('admin_post_sosprescription_logs_download', [self::class, 'handle_download']);
        add_action('admin_post_sosprescription_logs_download_zip', [self::class, 'handle_download_zip']);
        add_action('admin_post_sosprescription_logs_export_reqid', [self::class, 'handle_export_reqid']);
        add_action('admin_post_sosprescription_logs_export_reqid_ndjson', [self::class, 'handle_export_reqid_ndjson']);
        add_action('admin_post_sosprescription_logs_export_filtered_ndjson', [self::class, 'handle_export_filtered_ndjson']);
        add_action('admin_post_sosprescription_logs_export_diagnostic', [self::class, 'handle_export_diagnostic']);
        add_action('admin_post_sosprescription_logs_support_bundle', [self::class, 'handle_support_bundle']);
        add_action('admin_post_sosprescription_logs_pii_audit', [self::class, 'handle_pii_audit']);
        add_action('admin_post_sosprescription_logs_delete', [self::class, 'handle_delete']);
        add_action('admin_post_sosprescription_logs_truncate', [self::class, 'handle_truncate']);

        // Bulk
        add_action('admin_post_sosprescription_logs_clear', [self::class, 'handle_clear_channel']);
        add_action('admin_post_sosprescription_logs_clear_channel', [self::class, 'handle_clear_channel']);
        add_action('admin_post_sosprescription_logs_clear_scope', [self::class, 'handle_clear_scope']);

        // Bulk (style DTRM): vider/supprimer tous les fichiers
        add_action('admin_post_sosprescription_logs_truncate_all', [self::class, 'handle_truncate_all']);
        add_action('admin_post_sosprescription_logs_delete_all', [self::class, 'handle_delete_all']);
    }

    public static function render_page(): void
    {
        if (!current_user_can('sosprescription_manage') && !current_user_can('manage_options')) {
            wp_die('Accès refusé.');
        }

        $tab = isset($_GET['tab']) ? sanitize_key((string) $_GET['tab']) : 'settings';
        $allowed_tabs = ['settings', 'bdpm', 'runtime', 'shortcodes', 'privacy', 'viewer'];
        if (!in_array($tab, $allowed_tabs, true)) {
            $tab = 'settings';
        }

        $enabled = Logger::enabled();
        $runtime_misc_enabled_ui = Logger::runtime_misc_enabled();

        // Sandbox / testing mode (UI)
        $sandbox_ui = SandboxConfig::get();
        $testing_mode_ui = !empty($sandbox_ui['testing_mode']);

        // Infos dossier logs
        $uploads = wp_upload_dir();
        $log_dir = rtrim((string) ($uploads['basedir'] ?? ''), '/') . '/sosprescription-logs';
        $log_dir_exists = is_dir($log_dir);
        $log_files_count = 0;
        if ($log_dir_exists) {
            $g = glob($log_dir . '/*.log');
            if (is_array($g)) {
                $log_files_count = count($g);
            }
        }

        // UI values (sans appliquer la règle "enabled()" pour BDPM)
        $bdpm_opt = get_option('sosprescription_logs_bdpm_enabled', '');
        $bdpm_enabled_ui = ($bdpm_opt === '') ? true : ((string) $bdpm_opt === '1');

        $scopes_known = self::known_scopes();

        // map UI
        $raw = get_option('sosprescription_logs_scopes', false);
        $map_ui = [];
        if ($raw === false) {
            // option absente => compat : tout ON
            foreach ($scopes_known as $k => $_label) {
                $map_ui[$k] = '1';
            }
        } elseif (is_array($raw)) {
            foreach ($scopes_known as $k => $_label) {
                $map_ui[$k] = (isset($raw[$k]) && ((string) $raw[$k] === '1' || $raw[$k] === true)) ? '1' : '0';
            }
        } else {
            foreach ($scopes_known as $k => $_label) {
                $map_ui[$k] = '1';
            }
        }

        $notices = [
            'updated' => isset($_GET['updated']) && (string) $_GET['updated'] === '1',
            'cleared' => isset($_GET['cleared']) && (string) $_GET['cleared'] === '1',
            'deleted' => isset($_GET['deleted']) && (string) $_GET['deleted'] === '1',
            'truncated' => isset($_GET['truncated']) && (string) $_GET['truncated'] === '1',
            'truncated_all' => isset($_GET['truncated_all']) && (string) $_GET['truncated_all'] === '1',
            'deleted_all' => isset($_GET['deleted_all']) && (string) $_GET['deleted_all'] === '1',
            'scope_cleared' => isset($_GET['scope_cleared']) && (string) $_GET['scope_cleared'] === '1',
        ];

        // Viewer
        $view_file = isset($_GET['view']) ? (string) $_GET['view'] : '';
        $view_file = rawurldecode($view_file);
        $view_path = $view_file !== '' ? Logger::validate_log_file($view_file) : null;
        $view_content = '';
        if ($view_path !== null) {
            $view_content_raw = Logger::tail($view_file, 200000);
        $view_content = Logger::format_log_chunk_for_display($view_content_raw);
            $tab = 'viewer';
        }

        // Files for tabs
        $bdpm_files = Logger::list_files('bdpm', 50);

        $runtime_all = Logger::list_files('runtime', 120);
        $runtime_general = [];
        foreach ($runtime_all as $f) {
            $name = (string) ($f['name'] ?? '');
            if (preg_match('/^runtime-\d{4}-\d{2}-\d{2}\.log$/', $name) === 1) {
                $runtime_general[] = $f;
            }
        }

        echo '<div class="wrap sp-ui">';

        echo '<h1 style="display:flex; align-items:center; gap:10px;">';
        echo '<img src="' . esc_url(SOSPRESCRIPTION_URL . 'assets/caduceus.svg') . '" alt="" style="width:26px;height:26px;" />';
        echo '<span>Logs</span>';
        if (defined('SOSPRESCRIPTION_VERSION')) {
            echo '<span style="margin-left:6px; padding:2px 8px; border-radius:999px; border:1px solid #dcdcde; background:#f6f7f7; color:#646970; font-size:12px;">v' . esc_html((string) SOSPRESCRIPTION_VERSION) . '</span>';
        }
        echo '</h1>';

        echo '<p style="max-width: 980px;">';
        echo 'Centre de pilotage des logs (test / recette) : <strong>activation globale</strong>, <strong>activation fine par shortcode</strong>, et <strong>fichiers à consulter / télécharger</strong>.';
        echo '</p>';

        echo '<div class="sp-muted" style="max-width:980px; margin-bottom:10px;">';
        echo 'Dossier logs : <code>' . esc_html($log_dir) . '</code>';
        echo ' &nbsp;•&nbsp; fichiers : <strong>' . esc_html((string) $log_files_count) . '</strong>';
        echo $log_dir_exists ? '' : ' &nbsp;•&nbsp; <span style="color:#b32d2e;">dossier non présent (il sera créé au premier log)</span>';
        echo '</div>';

        if ($notices['updated']) {
            echo '<div class="notice notice-success is-dismissible"><p>Paramètres enregistrés.</p></div>';
        }
        if ($notices['cleared']) {
            echo '<div class="notice notice-success is-dismissible"><p>Logs supprimés (canal).</p></div>';
        }
        if ($notices['scope_cleared']) {
            echo '<div class="notice notice-success is-dismissible"><p>Logs supprimés (shortcode).</p></div>';
        }
        if ($notices['truncated']) {
            echo '<div class="notice notice-success is-dismissible"><p>Fichier de log vidé.</p></div>';
        }
        if ($notices['truncated_all']) {
            echo '<div class="notice notice-success is-dismissible"><p>Tous les fichiers de logs ont été vidés.</p></div>';
        }
        if ($notices['deleted']) {
            echo '<div class="notice notice-success is-dismissible"><p>Fichier de log supprimé.</p></div>';
        }
        if ($notices['deleted_all']) {
            echo '<div class="notice notice-success is-dismissible"><p>Tous les fichiers de logs ont été supprimés.</p></div>';
        }// Tabs
        $tabs = [
            'settings' => 'Logs',
            'bdpm' => 'BDPM',
            'runtime' => 'Runtime',
            'shortcodes' => 'Shortcodes',
            'privacy' => 'Confidentialité',
            'viewer' => 'Visionneuse',
        ];

        echo '<h2 class="nav-tab-wrapper" style="max-width:980px;">';
        foreach ($tabs as $key => $label) {
            $url = add_query_arg([
                'page' => 'sosprescription-logs',
                'tab' => $key,
            ], admin_url('admin.php'));

            $cls = ($tab === $key) ? 'nav-tab nav-tab-active' : 'nav-tab';
            echo '<a href="' . esc_url($url) . '" class="' . esc_attr($cls) . '">' . esc_html($label) . '</a>';
        }
        echo '</h2>';

        if ($tab === 'settings') {
            echo '<div class="sp-card">';
            echo '<h2 style="margin-top:0;">Paramètres</h2>';
            echo '<p class="sp-muted">Astuce : en production, désactivez les logs (case ci-dessous) pour éviter toute écriture disque.</p>';

            echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
            echo '<input type="hidden" name="action" value="sosprescription_logs_save" />';
            echo '<input type="hidden" name="tab" value="settings" />';
            wp_nonce_field('sosprescription_logs_save');

            echo '<label style="display:flex; align-items:center; gap:10px; margin:10px 0;">';
            echo '<input type="checkbox" name="logs_enabled" value="1" ' . checked($enabled, true, false) . ' />';
            echo '<strong>Activer les logs SOS Prescription</strong>';
            echo '</label>';

            echo '<div style="margin-top:12px; border:1px solid #dcdcde; border-radius:12px; padding:12px; background:#f6f7f7;">';
            echo '<div style="font-weight:600; margin-bottom:10px;">Traceurs (Scopes)</div>';

            foreach ($scopes_known as $scope => $label) {
                $checked_scope = isset($map_ui[$scope]) && $map_ui[$scope] === '1';

                echo '<label style="display:flex; align-items:center; gap:10px; margin:6px 0;">';
                echo '<input type="checkbox" name="scopes[' . esc_attr($scope) . ']" value="1" ' . checked($checked_scope, true, false) . ' />';
                echo '<span><strong>' . esc_html($label) . '</strong> <span class="sp-muted">[' . esc_html($scope) . ']</span></span>';
                echo '</label>';
            }

            echo '<hr style="margin:12px 0;" />';
            echo '<div style="font-weight:600; margin-bottom:10px;">Canaux techniques</div>';

            echo '<label style="display:flex; align-items:center; gap:10px; margin:6px 0;">';
            echo '<input type="checkbox" name="bdpm_enabled" value="1" ' . checked($bdpm_enabled_ui, true, false) . ' />';
            echo '<span><strong>Import BDPM</strong> <span class="sp-muted">(canal bdpm)</span></span>';
            echo '</label>';

            echo '<label style="display:flex; align-items:center; gap:10px; margin:6px 0;">';
            echo '<input type="checkbox" name="runtime_misc_enabled" value="1" ' . checked($runtime_misc_enabled_ui, true, false) . ' />';
            echo '<span><strong>Runtime général</strong> <span class="sp-muted">(hors shortcode)</span></span>';
            echo '</label>';

            echo '</div>';

            echo '<p style="margin-top:12px;">';
            echo '<button class="button button-primary" type="submit">Enregistrer</button>';
            echo '</p>';
            echo '</form>';
            echo '</div>';

            echo '<div class="sp-card">';
            echo '<h2 style="margin-top:0;">Fichiers</h2>';
            echo '<p class="sp-muted">Téléchargez, videz ou supprimez les fichiers de logs générés (sans FTP). Affichage : dernier fichier par traceur.</p>';
            self::render_dtrm_style_files_table($tab, $scopes_known);
            echo '</div>';

            // ---
            // Liste des shortcodes & pages recommandées
            // ---
            echo '<div class="sp-card">';
            echo '<h2 style="margin-top:0;">Shortcodes disponibles</h2>';
            echo '<p class="sp-muted">À copier/coller dans des pages WordPress. Recommandation : une page = un shortcode pour éviter les conflits de styles/scripts.</p>';

            $shortcodes = [
                [
                    'code' => '[sosprescription_form]',
                    'label' => 'Formulaire de demande (RO + dépannage)',
                    'page' => 'Demander une ordonnance',
                    'access' => 'Public (preview) / Soumission : connecté',
                ],
                [
                    'code' => '[sosprescription_patient]',
                    'label' => 'Espace patient (demandes, messages, documents)',
                    'page' => 'Espace patient',
                    'access' => 'Patient connecté',
                ],
                [
                    'code' => '[sosprescription_admin]',
                    'label' => 'Console médecin (liste + traitement)',
                    'page' => 'Console médecin',
                    'access' => 'Médecin / Staff',
                ],
                [
                    'code' => '[sosprescription_doctor_account]',
                    'label' => 'Compte médecin (profil, signature, paramètres)',
                    'page' => 'Mon compte médecin',
                    'access' => 'Médecin',
                ],
                [
                    'code' => '[sosprescription_bdpm_table]',
                    'label' => 'Recherche BDPM (outil de contrôle)',
                    'page' => 'BDPM (outil)',
                    'access' => 'Admin / Staff',
                ],
            ];

            echo '<div class="sp-table">';
            echo '<table class="widefat striped">';
            echo '<thead><tr>';
            echo '<th style="width:220px;">Shortcode</th>';
            echo '<th>Description</th>';
            echo '<th style="width:220px;">Page suggérée</th>';
            echo '<th style="width:220px;">Accès</th>';
            echo '</tr></thead>';
            echo '<tbody>';
            foreach ($shortcodes as $sc) {
                echo '<tr>';
                echo '<td><code>' . esc_html((string) $sc['code']) . '</code></td>';
                echo '<td>' . esc_html((string) $sc['label']) . '</td>';
                echo '<td>' . esc_html((string) $sc['page']) . '</td>';
                echo '<td>' . esc_html((string) $sc['access']) . '</td>';
                echo '</tr>';
            }
            echo '</tbody>';
            echo '</table>';
            echo '</div>';

            echo '</div>';
        } elseif ($tab === 'bdpm') {
            echo '<div class="sp-card">';
            echo '<h2 style="margin-top:0;">Canal BDPM (import)</h2>';
            echo '<p class="sp-muted">Fichiers liés aux imports BDPM (sessions, étapes, erreurs DB…).</p>';

            // Aide : si le canal n'est pas activé, la page paraît "vide".
            if (!Logger::enabled()) {
                echo '<div class="notice notice-warning" style="margin:10px 0 0;">';
                echo '<p><strong>Logs désactivés.</strong> Activez les logs dans l’onglet “Logs” pour générer des fichiers.</p>';
                echo '</div>';
            } elseif (!Logger::bdpm_enabled()) {
                echo '<div class="notice notice-warning" style="margin:10px 0 0;">';
                echo '<p><strong>Canal BDPM désactivé.</strong> Cochez “Import BDPM” dans l’onglet “Logs” puis relancez un import pour générer des fichiers.</p>';
                echo '</div>';
            } elseif (empty($bdpm_files)) {
                $import_url = add_query_arg(['page' => 'sosprescription-import'], admin_url('admin.php'));
                echo '<div class="notice notice-info" style="margin:10px 0 0;">';
                echo '<p><strong>Aucun fichier pour le moment.</strong> Les logs BDPM sont créés lors d’un import (ou reprise) sur la page <a href="' . esc_url($import_url) . '">Import BDPM</a>.</p>';
                echo '</div>';
            }

            self::render_files_table('bdpm', '', $bdpm_files, $tab);
            self::render_channel_actions('bdpm', $tab, 'all');
            echo '</div>';
        } elseif ($tab === 'runtime') {
            echo '<div class="sp-card">';
            echo '<h2 style="margin-top:0;">Runtime général (hors shortcode)</h2>';
            echo '<p class="sp-muted">Ce canal capture les logs runtime sans scope. Pratique pour diagnostiquer un problème “global” (REST, hooks, etc.).</p>';

            if (!$runtime_misc_enabled_ui) {
                echo '<div class="notice notice-warning" style="margin:10px 0 0;">';
                echo '<p><strong>Runtime général désactivé.</strong> Activez “Runtime général” dans l’onglet Logs si vous souhaitez générer ce type de logs.</p>';
                echo '</div>';
            }

            self::render_files_table('runtime', '', $runtime_general, $tab);
            self::render_channel_actions('runtime', $tab, 'general');
            echo '</div>';
        } elseif ($tab === 'shortcodes') {
            echo '<div class="sp-card">';
            echo '<h2 style="margin-top:0;">Logs par shortcode</h2>';
            echo '<p class="sp-muted">Chaque shortcode a ses propres fichiers quotidiens. Activez uniquement ce que vous testez.</p>';

            foreach ($scopes_known as $scope => $label) {
                $files = Logger::list_files_scoped('runtime', $scope, 40);
                $is_on = Logger::scope_enabled($scope);

                echo '<details style="margin:10px 0;">';
                echo '<summary style="cursor:pointer; display:flex; align-items:center; gap:10px;">';
                echo '<strong>' . esc_html($label) . '</strong>';
                echo '<span class="sp-muted"><code>[' . esc_html($scope) . ']</code></span>';
                echo '<span class="sp-muted">• ' . ($is_on ? '<span style="color:#0a7f2e;">ON</span>' : '<span style="color:#b32d2e;">OFF</span>') . '</span>';
                echo '</summary>';

                if (empty($files)) {
                    echo '<div style="padding:12px; margin-top:8px; background:#f6f7f7; border:1px solid #ddd; border-radius:10px;">Aucun fichier pour ce shortcode (historique récent).</div>';
                } else {
                    self::render_files_table('runtime', $scope, $files, $tab);
                }

                self::render_scope_actions('runtime', $scope, $tab);
                echo '</details>';
            }

            echo '</div>';
        } elseif ($tab === 'privacy') {
            echo '<div class="sp-card">';
            echo '<h2 style="margin-top:0;">Confidentialité (PII) — Audit des logs</h2>';
            echo '<p class="sp-muted">Objectif : vérifier qu’aucune donnée patient (email, téléphone, NIR, IBAN, etc.) ne fuit dans les logs. Le scanner parcourt les fichiers <code>.log</code> (NDJSON ou texte) et génère un rapport JSON téléchargeable.</p>';

            $nonce = wp_create_nonce('sosprescription_logs_pii_audit');
            $audit_url = add_query_arg([
                'action' => 'sosprescription_logs_pii_audit',
                '_wpnonce' => $nonce,
            ], admin_url('admin-post.php'));

            echo '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">';
            echo '<a class="button button-primary" href="' . esc_url($audit_url) . '">Scanner PII (JSON)</a>';
            echo '<span class="sp-muted">Télécharge <code>sosprescription-pii-audit-*.json</code>.</span>';
            echo '</div>';

            echo '<details style="margin-top:12px;">';
            echo '<summary style="cursor:pointer;"><strong>Patterns scannés</strong> <span class="sp-muted">(best-effort)</span></summary>';
            echo '<div style="margin-top:10px;" class="sp-pre">';
            $patterns = \SOSPrescription\Services\PiiScanner::patterns();
            foreach ($patterns as $key => $re) {
                echo esc_html($key) . ' : ' . esc_html($re) . "\n";
            }
            echo '</div>';
            echo '</details>';

            echo '<div class="notice notice-info" style="margin:12px 0 0;">';
            echo '<p><strong>Note :</strong> ce scanner est une <em>assurance qualité</em>. La protection principale reste la redaction/masking appliquée au moment de l’écriture des logs.</p>';
            echo '</div>';

            echo '</div>';
        } else { // viewer
            echo '<div class="sp-card">';
            echo '<h2 style="margin-top:0;">Visionneuse</h2>';
            echo '<p class="sp-muted">Affiche les ~200KB de fin du fichier (tail). Pratique pour vérifier rapidement sans téléchargement.</p>';

            // Export diagnostic système (support)
            $diag_nonce = wp_create_nonce('sosprescription_logs_export_diagnostic');
            $diag_url = add_query_arg([
                'action' => 'sosprescription_logs_export_diagnostic',
                '_wpnonce' => $diag_nonce,
            ], admin_url('admin-post.php'));

            // Bundle support (ZIP) : diagnostic + audit PII + extrait logs (sanitisé)
            $bundle_nonce = wp_create_nonce('sosprescription_logs_support_bundle');
            $bundle_url = add_query_arg([
                'action' => 'sosprescription_logs_support_bundle',
                '_wpnonce' => $bundle_nonce,
            ], admin_url('admin-post.php'));
            echo '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:10px 0 14px;">';
            echo '<a class="button" href="' . esc_url($diag_url) . '">Exporter diagnostic (JSON)</a>';
            echo '<a class="button button-secondary" href="' . esc_url($bundle_url) . '">Support Bundle (ZIP)</a>';
            echo '<span class="sp-muted">Diagnostic + audit PII + extrait des logs (utile pour le support).</span>';
            echo '</div>';

            // Filtre ReqID (8 chars) - utilisé par la visionneuse (pré-remplissage + filtrage JS)
            $reqid_filter = '';
            if (isset($_GET['reqid'])) {
                $reqid_filter = strtoupper((string) $_GET['reqid']);
                $reqid_filter = preg_replace('/[^A-Z0-9]/', '', $reqid_filter);
                $reqid_filter = substr($reqid_filter, 0, 8);
            }

            if ($view_path === null) {
                echo '<div style="padding:12px; background:#f6f7f7; border:1px solid #ddd; border-radius:10px;">';
                echo '<div style="font-weight:600; margin-bottom:6px;">Aucun fichier sélectionné</div>';
                echo '<div class="sp-muted">Cliquez sur “Voir” dans une liste de logs.</div>';
                echo '</div>';
            } else {
                echo '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">';
                echo '<div><strong>Fichier :</strong> <code>' . esc_html($view_file) . '</code></div>';
                $download_nonce = wp_create_nonce('sosprescription_logs_download');
                $download_url = add_query_arg([
                    'action' => 'sosprescription_logs_download',
                    'file' => rawurlencode($view_file),
                    'tab' => 'viewer',
                    '_wpnonce' => $download_nonce,
                ], admin_url('admin-post.php'));
                echo '<div><a class="button" href="' . esc_url($download_url) . '">Télécharger</a></div>';
                echo '</div>';
                // Recherche instantanée par ReqID (sans rechargement)
                echo '<div style="display:flex;align-items:center;gap:8px;margin:8px 0 12px;">';
                echo '<strong>Recherche par ReqID :</strong>';
                echo '<input type="text" id="sp-log-reqid" maxlength="8" value="' . esc_attr($reqid_filter) . '" placeholder="A1B2C3D4" style="width:120px;font-family:monospace;" />';
                echo '<button type="button" class="button" id="sp-log-reqid-clear">Effacer</button>';
                echo '<button type="button" class="button" id="sp-log-reqid-global">Recherche globale</button>';
                echo '<span class="description" id="sp-log-reqid-count" style="margin:0;"></span>';
                echo '</div>';

                echo '<div style="display:flex;align-items:center;gap:10px;margin:0 0 12px;flex-wrap:wrap;">';
                echo '<strong>Filtres :</strong>';
                echo '<label class="sp-muted" style="display:flex;align-items:center;gap:6px;">Niveau ' . '<select id="sp-log-level" style="min-width:120px;">' . '<option value="">Tous</option>' . '<option value="ERROR">ERROR</option>' . '<option value="WARN">WARN</option>' . '<option value="INFO">INFO</option>' . '<option value="DEBUG">DEBUG</option>' . '</select>' . '</label>';
                echo '<label class="sp-muted" style="display:flex;align-items:center;gap:6px;">Scope ' . '<select id="sp-log-scope" style="min-width:140px;">' . '<option value="">Tous</option>' . '</select>' . '</label>';
                echo '<span class="description sp-muted" style="margin:0;">Filtrage local (sur l’extrait affiché).</span>';

                $export_filtered_nonce = wp_create_nonce('sosprescription_logs_export_filtered_ndjson');
                $export_filtered_url = add_query_arg([
                    'action' => 'sosprescription_logs_export_filtered_ndjson',
                    '_wpnonce' => $export_filtered_nonce,
                ], admin_url('admin-post.php'));
                echo '<button type="button" class="button" id="sp-log-export-ndjson" data-base-url="' . esc_attr($export_filtered_url) . '">Exporter NDJSON (filtré)</button>';
                echo '<span class="sp-muted" style="margin-left:4px;">(Scope / Niveau / ReqID)</span>';
                echo '</div>';

                // Recherche globale backend (tous les fichiers .log) — utile pour le support.
                if (!empty($reqid_filter)) {
                    $export_nonce = wp_create_nonce('sosprescription_export_reqid_' . $reqid_filter);
                    $export_url = add_query_arg([
                        'action' => 'sosprescription_logs_export_reqid',
                        'reqid' => $reqid_filter,
                        '_wpnonce' => $export_nonce,
                    ], admin_url('admin-post.php'));

                    $export_ndjson_nonce = wp_create_nonce('sosprescription_export_reqid_ndjson_' . $reqid_filter);
                    $export_ndjson_url = add_query_arg([
                        'action' => 'sosprescription_logs_export_reqid_ndjson',
                        'reqid' => $reqid_filter,
                        '_wpnonce' => $export_ndjson_nonce,
                    ], admin_url('admin-post.php'));

                    $matches = Logger::search_global_reqid($reqid_filter);
                    echo '<details class="sp-card" style="margin:0 0 12px;" open>';
                    echo '<summary style="cursor:pointer;"><strong>Résultats globaux ReqID</strong> <span class="sp-muted">(' . count($matches) . ')</span></summary>';
                    echo '<div style="margin-top:8px;">' .
                        '<a class="button" href="' . esc_url($export_url) . '">Exporter (TXT)</a> ' .
                        '<a class="button" href="' . esc_url($export_ndjson_url) . '">Exporter (NDJSON)</a>' .
                        '</div>';
                    echo '<div style="margin-top:10px;">';
                    if (empty($matches)) {
                        echo '<div class="sp-muted">Aucune occurrence trouvée dans les fichiers logs.</div>';
                    } else {
                        echo '<div class="sp-muted" style="margin-bottom:8px;">Astuce : cliquez sur un fichier pour l’ouvrir dans le viewer.</div>';
                        echo '<div class="sp-pre" style="max-height:260px;overflow:auto;white-space:pre;">';
                        foreach ($matches as $m) {
                            $fname = (string) ($m['file'] ?? '');
                            $line = (string) ($m['line'] ?? '');
                            $viewer_url = add_query_arg([
                                'page' => 'sosprescription-logs',
                                'tab' => 'viewer',
                                'file' => $fname,
                                'reqid' => $reqid_filter,
                            ], admin_url('admin.php'));
                            echo '[' . '<a href="' . esc_url($viewer_url) . '">' . esc_html($fname) . '</a>' . '] ' . esc_html($line) . "\n";
                        }
                        echo '</div>';
                    }
                    echo '</div>';
                    echo '</details>';
                }

                echo '<pre id="sp-log-view" class="sp-pre">' . esc_html($view_content) . '</pre>';

                $js = <<<'JS'
(function(){
  var input = document.getElementById('sp-log-reqid');
  var pre = document.getElementById('sp-log-view');
  var count = document.getElementById('sp-log-reqid-count');
  var clearBtn = document.getElementById('sp-log-reqid-clear');
  var reqidGlobalInput = document.getElementById('sp-log-reqid-global');
  var globalBtn = document.getElementById('sp-log-search-global');
  var levelSel = document.getElementById('sp-log-level');
  var scopeSel = document.getElementById('sp-log-scope');
  var exportBtn = document.getElementById('sp-log-export-ndjson');
  if (!input || !pre) { return; }

  var originalText = pre.textContent || '';
  var originalLines = originalText.split(/\r?\n/);

  function escapeHtml(str) {
    return (str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function escapeRegExp(str) {
    return (str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function linkifyLine(line) {
    var safe = escapeHtml(line);
    // Un ReqID est toujours le 1er bloc de crochets : [A1B2C3D4] [2026-...]
    return safe.replace(/^\[([A-Z0-9]{8})\]/, function(m, id){
      return '<a href="#" class="sp-reqid-link" data-reqid="' + id + '" title="Filtrer sur ce ReqID">[' + id + ']</a>';
    });
  }

  function render(lines) {
    var html = (lines || []).map(linkifyLine).join("\n");
    pre.innerHTML = html;
  }

  function normalizeReqId(value) {
    return (value || '')
      .trim()
      .replace(/[^a-z0-9]/ig, '')
      .toUpperCase()
      .slice(0, 8);
  }

  function populateScopes() {
    if (!scopeSel) { return; }
    var cur = (scopeSel.value || '').toLowerCase();
    var scopes = {};
    for (var i = 0; i < originalLines.length; i++) {
      var line = originalLines[i] || '';
      var m = line.match(/\]\s+[a-z0-9_-]+:([a-z0-9_-]+)\b/i);
      if (m && m[1]) {
        scopes[m[1].toLowerCase()] = true;
      }
    }
    var list = Object.keys(scopes).sort();

    // Reset options
    scopeSel.innerHTML = '<option value="">Tous</option>';
    for (var j = 0; j < list.length; j++) {
      var opt = document.createElement('option');
      opt.value = list[j];
      opt.textContent = list[j];
      scopeSel.appendChild(opt);
    }
    if (cur && scopes[cur]) {
      scopeSel.value = cur;
    }
  }

  function apply() {
    var q = normalizeReqId(input.value);
    input.value = q;

    var lvl = levelSel ? (levelSel.value || '').trim().toUpperCase() : '';
    var scope = scopeSel ? (scopeSel.value || '').trim().toLowerCase() : '';
    var scopeRe = scope ? new RegExp('\\b[a-z0-9_-]+:' + escapeRegExp(scope) + '\\b', 'i') : null;

    if (!q && !lvl && !scope) {
      render(originalLines);
      if (count) { count.textContent = ''; }
      return;
    }

    var out = [];
    for (var i = 0; i < originalLines.length; i++) {
      var line = originalLines[i] || '';
      if (q && line.indexOf(q) === -1) { continue; }
      if (lvl && line.indexOf('[' + lvl + ']') === -1) { continue; }
      if (scopeRe && !scopeRe.test(line)) { continue; }
      out.push(line);
    }

    render(out);
    if (count) {
      count.textContent = out.length + ' ligne(s) affichée(s).';
    }
  }

  input.addEventListener('input', apply);
  if (levelSel) { levelSel.addEventListener('change', apply); }
  if (scopeSel) { scopeSel.addEventListener('change', apply); }

  // Recherche globale (reload de la page avec ?reqid=... pour obtenir les résultats backend)
  if (globalBtn) {
    globalBtn.addEventListener('click', function () {
      var sourceVal = reqidGlobalInput ? (reqidGlobalInput.value || '') : (input.value || '');
      var q = sourceVal.trim().replace(/[^a-z0-9]/ig, '').toUpperCase().slice(0, 8);
      if (!q) return;
      var url = new URL(window.location.href);
      url.searchParams.set('reqid', q);
      window.location.href = url.toString();
    });
  }

  // Export NDJSON filtré (backend)
  if (exportBtn) {
    exportBtn.addEventListener('click', function () {
      var q = normalizeReqId(input.value);
      var lvl = levelSel ? (levelSel.value || '').trim().toUpperCase() : '';
      var scope = scopeSel ? (scopeSel.value || '').trim().toLowerCase() : '';
      if (!q && !lvl && !scope) {
        alert('Veuillez définir au moins un filtre (Scope, Niveau ou ReqID) avant l’export NDJSON.');
        return;
      }
      var base = exportBtn.getAttribute('data-base-url');
      if (!base) { return; }
      var url = new URL(base);
      if (q) { url.searchParams.set('reqid', q); }
      if (lvl) { url.searchParams.set('level', lvl); }
      if (scope) { url.searchParams.set('scope', scope); }
      window.location.href = url.toString();
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', function(){
      input.value = '';
      apply();
      input.focus();
    });
  }

  // Clic sur un ReqID : remplit le champ + applique le filtre.
  pre.addEventListener('click', function(ev){
    var t = ev.target;
    if (!t || !t.closest) { return; }
    var a = t.closest('a.sp-reqid-link');
    if (!a) { return; }
    ev.preventDefault();
    var rid = (a.getAttribute('data-reqid') || '').toUpperCase();
    if (!rid) { return; }
    input.value = rid;
    apply();
    input.focus();
  });

  // Render initial avec liens + scopes.
  render(originalLines);
  populateScopes();
  if (input.value) { apply(); }
})();
JS;
                echo '<script>' . $js . '</script>';

            }

            echo '</div>';
        }

        echo '</div>';
    }

    /**
     * Table "style DTRM" : 1 ligne par traceur (dernier fichier), avec actions Télécharger / Vider / Supprimer.
     *
     * @param array<string,string> $scopes_known
     */
    private static function render_dtrm_style_files_table(string $tab, array $scopes_known): void
    {
        $uploads = wp_upload_dir();
        $baseurl = (string) ($uploads['baseurl'] ?? '');
        $uploads_path = (string) (parse_url($baseurl, PHP_URL_PATH) ?: '/wp-content/uploads');
        $dir_rel = rtrim($uploads_path, '/') . '/sosprescription-logs/';

        $today = (string) current_time('Y-m-d');

        $download_nonce = wp_create_nonce('sosprescription_logs_download');
        $delete_nonce = wp_create_nonce('sosprescription_logs_delete');
        $truncate_nonce = wp_create_nonce('sosprescription_logs_truncate');

        // Helper format taille FR (o/Ko/Mo)
        $fmt = static function (?int $bytes): string {
            if ($bytes === null) {
                return '-';
            }
            $b = max(0, (int) $bytes);
            if ($b < 1024) {
                return $b . ' o';
            }
            $kb = $b / 1024;
            if ($kb < 1024) {
                return number_format($kb, 1, ',', ' ') . ' Ko';
            }
            $mb = $kb / 1024;
            if ($mb < 1024) {
                return number_format($mb, 1, ',', ' ') . ' Mo';
            }
            $gb = $mb / 1024;
            return number_format($gb, 1, ',', ' ') . ' Go';
        };

        // Construire les lignes (shortcodes)
        $rows = [];
        foreach ($scopes_known as $scope => $label) {
            $latest = Logger::list_files_scoped('runtime', $scope, 1);
            $file = !empty($latest) ? (string) ($latest[0]['name'] ?? '') : '';
            $size = !empty($latest) ? (int) ($latest[0]['size'] ?? 0) : null;
            $modified = !empty($latest) ? (string) ($latest[0]['modified'] ?? '-') : '-';

            if ($file === '') {
                // Nom attendu (aujourd'hui) si aucun fichier présent.
                $file = 'runtime-' . $scope . '-' . $today . '.log';
                $size = null;
                $modified = '-';
            }

            $rows[] = [
                'kind' => 'scope',
                'label' => $label,
                'code' => '[' . $scope . ']',
                'status' => Logger::scope_enabled($scope) ? 'ON' : 'OFF',
                'channel' => 'runtime',
                'file' => $file,
                'size' => $size,
                'modified' => $modified,
                'exists' => (Logger::validate_log_file($file) !== null),
            ];
        }

        // Runtime général
        $runtime_all = Logger::list_files('runtime', 80);
        $runtime_general = [];
        foreach ($runtime_all as $f) {
            $name = (string) ($f['name'] ?? '');
            if (preg_match('/^runtime-\d{4}-\d{2}-\d{2}\.log$/', $name) === 1) {
                $runtime_general[] = $f;
            }
        }
        $general_file = !empty($runtime_general) ? (string) ($runtime_general[0]['name'] ?? '') : '';
        $general_size = !empty($runtime_general) ? (int) ($runtime_general[0]['size'] ?? 0) : null;
        $general_modified = !empty($runtime_general) ? (string) ($runtime_general[0]['modified'] ?? '-') : '-';
        if ($general_file === '') {
            $general_file = 'runtime-' . $today . '.log';
            $general_size = null;
            $general_modified = '-';
        }
        $rows[] = [
            'kind' => 'channel',
            'label' => 'Runtime général',
            'code' => '(hors shortcode)',
            'status' => (Logger::enabled() && Logger::runtime_misc_enabled()) ? 'ON' : 'OFF',
            'channel' => 'runtime',
            'file' => $general_file,
            'size' => $general_size,
            'modified' => $general_modified,
            'exists' => (Logger::validate_log_file($general_file) !== null),
        ];

        // Canal BDPM
        $bdpm_files = Logger::list_files('bdpm', 1);
        $bdpm_file = !empty($bdpm_files) ? (string) ($bdpm_files[0]['name'] ?? '') : '';
        $bdpm_size = !empty($bdpm_files) ? (int) ($bdpm_files[0]['size'] ?? 0) : null;
        $bdpm_modified = !empty($bdpm_files) ? (string) ($bdpm_files[0]['modified'] ?? '-') : '-';
        if ($bdpm_file === '') {
            $bdpm_file = 'bdpm-' . $today . '.log';
            $bdpm_size = null;
            $bdpm_modified = '-';
        }
        $rows[] = [
            'kind' => 'channel',
            'label' => 'Import BDPM',
            'code' => '(canal bdpm)',
            'status' => Logger::bdpm_enabled() ? 'ON' : 'OFF',
            'channel' => 'bdpm',
            'file' => $bdpm_file,
            'size' => $bdpm_size,
            'modified' => $bdpm_modified,
            'exists' => (Logger::validate_log_file($bdpm_file) !== null),
        ];

        // Fatal (toujours ON)
        $fatal = Logger::list_files_scoped('runtime', 'sosprescription_fatal', 1);
        $fatal_file = !empty($fatal) ? (string) ($fatal[0]['name'] ?? '') : '';
        $fatal_size = !empty($fatal) ? (int) ($fatal[0]['size'] ?? 0) : null;
        $fatal_modified = !empty($fatal) ? (string) ($fatal[0]['modified'] ?? '-') : '-';
        if ($fatal_file === '') {
            $fatal_file = 'runtime-sosprescription_fatal-' . $today . '.log';
            $fatal_size = null;
            $fatal_modified = '-';
        }
        $rows[] = [
            'kind' => 'scope',
            'label' => 'Erreurs fatales PHP',
            'code' => '(fatal)',
            'status' => 'ON',
            'channel' => 'runtime',
            'file' => $fatal_file,
            'size' => $fatal_size,
            'modified' => $fatal_modified,
            'exists' => (Logger::validate_log_file($fatal_file) !== null),
        ];

        // Action rapide : tout télécharger (runtime + BDPM)
        $zip_all_url = wp_nonce_url(
            admin_url('admin-post.php?action=sosprescription_logs_download_zip&channel=all'),
            'sosprescription_logs_download_zip'
        );
        echo '<div style="margin-top:10px; display:flex; gap:10px; flex-wrap:wrap; align-items:center;">';
        echo '<a class="button button-primary" href="' . esc_url($zip_all_url) . '">Tout télécharger (ZIP)</a>';
        echo '<span class="description">Inclut les logs runtime & BDPM.</span>';
        echo '</div>';

        echo '<table class="widefat striped" style="margin-top:10px;">';
        echo '<thead><tr>';
        echo '<th style="width:260px;">Canal</th>';
        echo '<th>Fichier</th>';
        echo '<th style="width:90px;">Taille</th>';
        echo '<th style="width:140px;">MàJ</th>';
        echo '<th style="width:260px;">Actions</th>';
        echo '</tr></thead>';
        echo '<tbody>';

        foreach ($rows as $r) {
            $file = (string) $r['file'];
            $exists = (bool) $r['exists'];

            $download_url = add_query_arg([
                'action' => 'sosprescription_logs_download',
                'file' => rawurlencode($file),
                'tab' => $tab,
                '_wpnonce' => $download_nonce,
            ], admin_url('admin-post.php'));

            $truncate_url = add_query_arg([
                'action' => 'sosprescription_logs_truncate',
                'file' => rawurlencode($file),
                'tab' => $tab,
                '_wpnonce' => $truncate_nonce,
            ], admin_url('admin-post.php'));

            $delete_url = add_query_arg([
                'action' => 'sosprescription_logs_delete',
                'file' => rawurlencode($file),
                'tab' => $tab,
                '_wpnonce' => $delete_nonce,
            ], admin_url('admin-post.php'));

            echo '<tr>';
            echo '<td>';
            echo '<div style="font-weight:600;">' . esc_html((string) $r['label']) . ' <span class="sp-muted">' . esc_html((string) $r['code']) . '</span></div>';
            $status = (string) $r['status'];
            $status_color = ($status === 'ON') ? '#0a7f2e' : '#b32d2e';
            echo '<div class="sp-muted" style="margin-top:2px;"><span style="font-weight:700;color:' . esc_attr($status_color) . '">' . esc_html($status) . '</span></div>';
            echo '</td>';

            echo '<td><code>' . esc_html($dir_rel . $file) . '</code></td>';
            echo '<td>' . esc_html($fmt($r['size'] === null ? null : (int) $r['size'])) . '</td>';
            echo '<td>' . esc_html((string) $r['modified']) . '</td>';
            echo '<td>';
            echo '<div class="sp-file-actions">';
            if ($exists) {
                echo '<a class="button button-small" title="Télécharger" aria-label="Télécharger" href="' . esc_url($download_url) . '"><span class="dashicons dashicons-download" aria-hidden="true"></span></a>';
                echo '<a class="button button-small" title="Vider" aria-label="Vider" href="' . esc_url($truncate_url) . '" onclick="return confirm(\'Vider (truncate) ce fichier de log ?\');"><span class="dashicons dashicons-minus" aria-hidden="true"></span></a>';
                echo '<a class="button button-small" title="Supprimer" aria-label="Supprimer" href="' . esc_url($delete_url) . '" style="border-color:#b32d2e;color:#b32d2e;" onclick="return confirm(\'Supprimer ce fichier de log ?\');"><span class="dashicons dashicons-trash" aria-hidden="true"></span></a>';
            } else {
                echo '<button class="button button-small" type="button" disabled aria-label="Télécharger"><span class="dashicons dashicons-download" aria-hidden="true"></span></button>';
                echo '<button class="button button-small" type="button" disabled aria-label="Vider"><span class="dashicons dashicons-minus" aria-hidden="true"></span></button>';
                echo '<button class="button button-small" type="button" disabled aria-label="Supprimer" style="border-color:#b32d2e;color:#b32d2e;"><span class="dashicons dashicons-trash" aria-hidden="true"></span></button>';
            }
            echo '</div>';
            echo '</td>';
            echo '</tr>';
        }

        echo '</tbody>';
        echo '</table>';

        echo '<div class="sp-actions">';

        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '" style="margin:0;">';
        echo '<input type="hidden" name="action" value="sosprescription_logs_truncate_all" />';
        echo '<input type="hidden" name="tab" value="' . esc_attr($tab) . '" />';
        wp_nonce_field('sosprescription_logs_truncate_all');
        echo '<button class="button" type="submit" onclick="return confirm(\'Vider TOUS les fichiers de logs ?\');">Vider tous les logs</button>';
        echo '</form>';

        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '" style="margin:0;">';
        echo '<input type="hidden" name="action" value="sosprescription_logs_delete_all" />';
        echo '<input type="hidden" name="tab" value="' . esc_attr($tab) . '" />';
        wp_nonce_field('sosprescription_logs_delete_all');
        echo '<button class="button" type="submit" style="border-color:#b32d2e;color:#b32d2e;" onclick="return confirm(\'Supprimer TOUS les fichiers de logs ?\');">Supprimer tous les logs</button>';
        echo '</form>';

        echo '</div>';
    }

    /**
     * @param array<int, array{name:string, size:int, modified:string}> $files
     */
    private static function render_files_table(string $channel, string $scope, array $files, string $tab): void
    {
        if (empty($files)) {
            echo '<div style="padding:12px; background:#f6f7f7; border:1px solid #ddd; border-radius:10px;">Aucun fichier de log disponible.</div>';
            return;
        }

        $download_nonce = wp_create_nonce('sosprescription_logs_download');
        $delete_nonce = wp_create_nonce('sosprescription_logs_delete');
        $truncate_nonce = wp_create_nonce('sosprescription_logs_truncate');

        echo '<table class="widefat striped" style="margin-top:10px;">';
        echo '<thead><tr>';
        echo '<th>Fichier</th><th>Taille</th><th>Modifié</th><th>Actions</th>';
        echo '</tr></thead>';
        echo '<tbody>';

        foreach ($files as $f) {
            $name = (string) ($f['name'] ?? '');
            $size = (int) ($f['size'] ?? 0);
            $modified = (string) ($f['modified'] ?? '');

            $view_url = add_query_arg([
                'page' => 'sosprescription-logs',
                'tab' => 'viewer',
                'view' => rawurlencode($name),
            ], admin_url('admin.php'));

            $download_url = add_query_arg([
                'action' => 'sosprescription_logs_download',
                'file' => rawurlencode($name),
                'tab' => $tab,
                '_wpnonce' => $download_nonce,
            ], admin_url('admin-post.php'));

            $truncate_url = add_query_arg([
                'action' => 'sosprescription_logs_truncate',
                'file' => rawurlencode($name),
                'tab' => $tab,
                '_wpnonce' => $truncate_nonce,
            ], admin_url('admin-post.php'));

            $delete_url = add_query_arg([
                'action' => 'sosprescription_logs_delete',
                'file' => rawurlencode($name),
                'tab' => $tab,
                '_wpnonce' => $delete_nonce,
            ], admin_url('admin-post.php'));

            echo '<tr>';
            echo '<td><code>' . esc_html($name) . '</code></td>';
            echo '<td>' . esc_html(size_format((float) $size)) . '</td>';
            echo '<td>' . esc_html($modified) . '</td>';
            echo '<td>';
            echo '<div class="sp-file-actions">';
            echo '<a class="button" href="' . esc_url($view_url) . '">Voir</a>';
            echo '<a class="button" href="' . esc_url($download_url) . '">Télécharger</a>';
            echo '<a class="button button-secondary" href="' . esc_url($truncate_url) . '" onclick="return confirm(\'Vider (truncate) ce fichier de log ?\');">Vider</a>';
            echo '<a class="button button-secondary" href="' . esc_url($delete_url) . '" onclick="return confirm(\'Supprimer ce fichier de log ?\');">Supprimer</a>';
            echo '</div>';
            echo '</td>';
            echo '</tr>';
        }

        echo '</tbody>';
        echo '</table>';
    }

    private static function render_channel_actions(string $channel, string $tab, string $mode = 'all'): void
    {
        $nonce_zip = wp_create_nonce('sosprescription_logs_download_zip');
        $zip_url = add_query_arg([
            'action' => 'sosprescription_logs_download_zip',
            'channel' => $channel,
            'mode' => $mode,
            'tab' => $tab,
            '_wpnonce' => $nonce_zip,
        ], admin_url('admin-post.php'));

        echo '<div class="sp-file-actions" style="margin-top:12px;">';
        echo '<a class="button" href="' . esc_url($zip_url) . '">Télécharger tout (ZIP)</a>';

        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '" style="margin:0;">';
        echo '<input type="hidden" name="action" value="sosprescription_logs_clear_channel" />';
        echo '<input type="hidden" name="channel" value="' . esc_attr($channel) . '" />';
        echo '<input type="hidden" name="tab" value="' . esc_attr($tab) . '" />';
        wp_nonce_field('sosprescription_logs_clear_channel');
        echo '<button class="button button-secondary" type="submit" onclick="return confirm(\'Supprimer TOUS les fichiers du canal ' . esc_js($channel) . ' ?\');">Supprimer tous les fichiers</button>';
        echo '</form>';

        echo '</div>';
    }

    private static function render_scope_actions(string $channel, string $scope, string $tab): void
    {
        $nonce_zip = wp_create_nonce('sosprescription_logs_download_zip');
        $zip_url = add_query_arg([
            'action' => 'sosprescription_logs_download_zip',
            'channel' => $channel,
            'scope' => $scope,
            'mode' => 'scope',
            'tab' => $tab,
            '_wpnonce' => $nonce_zip,
        ], admin_url('admin-post.php'));

        echo '<div class="sp-file-actions" style="margin-top:12px;">';
        echo '<a class="button" href="' . esc_url($zip_url) . '">Télécharger (ZIP)</a>';

        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '" style="margin:0;">';
        echo '<input type="hidden" name="action" value="sosprescription_logs_clear_scope" />';
        echo '<input type="hidden" name="channel" value="' . esc_attr($channel) . '" />';
        echo '<input type="hidden" name="scope" value="' . esc_attr($scope) . '" />';
        echo '<input type="hidden" name="tab" value="' . esc_attr($tab) . '" />';
        wp_nonce_field('sosprescription_logs_clear_scope');
        echo '<button class="button button-secondary" type="submit" onclick="return confirm(\'Supprimer TOUS les logs pour ' . esc_js($scope) . ' ?\');">Supprimer tous les fichiers de ce shortcode</button>';
        echo '</form>';

        echo '</div>';
    }

public static function handle_save(): void
    {
        if (!current_user_can('sosprescription_manage') && !current_user_can('manage_options')) {
            wp_die('Accès refusé.');
        }

        check_admin_referer('sosprescription_logs_save');

        $enabled = isset($_POST['logs_enabled']) && (string) $_POST['logs_enabled'] === '1';
        // Presets (boutons)
        $preset = isset($_POST['preset']) ? (string) $_POST['preset'] : '';
        $preset = trim($preset);
        if ($preset !== '' && $preset !== 'none') {
            // Si l'utilisateur clique sur un preset, on force l'activation globale :
            // sinon c'est contre-intuitif (aucun fichier ne se crée).
            $enabled = true;
        }

        Logger::set_enabled($enabled);

        $bdpm_enabled = isset($_POST['bdpm_enabled']) && (string) $_POST['bdpm_enabled'] === '1';
        Logger::set_bdpm_enabled($bdpm_enabled);

        $runtime_misc_enabled = isset($_POST['runtime_misc_enabled']) && (string) $_POST['runtime_misc_enabled'] === '1';
        Logger::set_runtime_misc_enabled($runtime_misc_enabled);

        $known = self::known_scopes();
        $posted = isset($_POST['scopes']) && is_array($_POST['scopes']) ? (array) $_POST['scopes'] : [];
        $map = [];

        if ($preset === 'all') {
            foreach ($known as $scope => $_label) {
                $map[$scope] = '1';
            }
        } elseif ($preset === 'none') {
            foreach ($known as $scope => $_label) {
                $map[$scope] = '0';
            }
        } elseif (str_starts_with($preset, 'only:')) {
            $only = trim((string) substr($preset, 5));
            foreach ($known as $scope => $_label) {
                $map[$scope] = ($scope === $only) ? '1' : '0';
            }
        } else {
            foreach ($known as $scope => $_label) {
                $map[$scope] = array_key_exists($scope, $posted) ? '1' : '0';
            }
        }
        Logger::set_scopes_map($map);

        // Sandbox / testing mode
        $testing_mode = isset($_POST['sosprescription_testing_mode']) && (string) $_POST['sosprescription_testing_mode'] === '1';
        SandboxConfig::update([
            'testing_mode' => $testing_mode,
        ]);

        $tab = isset($_POST['tab']) ? sanitize_key((string) $_POST['tab']) : 'settings';
        $allowed_tabs = ['settings', 'bdpm', 'runtime', 'shortcodes', 'viewer'];
        if (!in_array($tab, $allowed_tabs, true)) {
            $tab = 'settings';
        }

        $url = add_query_arg([
            'page' => 'sosprescription-logs',
            'tab' => $tab,
            'updated' => '1',
        ], admin_url('admin.php'));

        wp_safe_redirect($url);
        exit;
    }

    public static function handle_download(): void
    {
        if (!current_user_can('sosprescription_manage') && !current_user_can('manage_options')) {
            wp_die('Accès refusé.');
        }

        check_admin_referer('sosprescription_logs_download');

        $file = isset($_GET['file']) ? (string) $_GET['file'] : '';
        $file = rawurldecode($file);

        $path = Logger::validate_log_file($file);
        if ($path === null) {
            wp_die('Fichier de log invalide.');
        }

        $size = (int) (@filesize($path) ?: 0);

        nocache_headers();
        header('Content-Type: text/plain; charset=utf-8');
        header('Content-Disposition: attachment; filename="' . basename($file) . '"');
        if ($size > 0) {
            header('Content-Length: ' . $size);
        }

        // @phpstan-ignore-next-line
        @readfile($path);
        exit;
    }

    public static function handle_download_zip(): void
    {
        if (!current_user_can('sosprescription_manage') && !current_user_can('manage_options')) {
            wp_die('Accès refusé.');
        }

        check_admin_referer('sosprescription_logs_download_zip');

        $channel = isset($_GET['channel']) ? sanitize_key((string) $_GET['channel']) : '';
        $scope = isset($_GET['scope']) ? sanitize_key((string) $_GET['scope']) : '';
        $mode = isset($_GET['mode']) ? sanitize_key((string) $_GET['mode']) : 'all';

        if (!in_array($channel, ['bdpm', 'runtime', 'all'], true)) {
            wp_die('Canal invalide.');
        }

        $files = [];

        // "Tout télécharger" : runtime + bdpm dans un seul zip (scope/mode ignorés).
        if ($channel === 'all') {
            $files = array_merge(Logger::list_files('runtime', 500), Logger::list_files('bdpm', 500));
        } elseif ($mode === 'general' && $channel === 'runtime' && $scope === '') {
            $all = Logger::list_files('runtime', 500);
            foreach ($all as $f) {
                $name = (string) ($f['name'] ?? '');
                if (preg_match('/^runtime-\d{4}-\d{2}-\d{2}\.log$/', $name) === 1) {
                    $files[] = $f;
                }
            }
        } elseif ($scope !== '') {
            $files = Logger::list_files_scoped($channel, $scope, 500);
        } else {
            $files = Logger::list_files($channel, 500);
        }

        if (empty($files)) {
            wp_die('Aucun fichier de log à inclure dans le ZIP.');
        }

        if (!class_exists('ZipArchive')) {
            wp_die('ZipArchive indisponible sur ce serveur.');
        }

        $tmp = tempnam(sys_get_temp_dir(), 'sosprescription_logs_');
        if ($tmp === false) {
            wp_die('Impossible de créer un fichier temporaire.');
        }

        $zip_path = $tmp . '.zip';
        @rename($tmp, $zip_path);

        $zip = new \ZipArchive();
        $ok = $zip->open($zip_path, \ZipArchive::CREATE | \ZipArchive::OVERWRITE);
        if ($ok !== true) {
            @unlink($zip_path);
            wp_die('Impossible de créer le ZIP.');
        }

        foreach ($files as $f) {
            $name = (string) ($f['name'] ?? '');
            if ($name === '') {
                continue;
            }
            $path = Logger::validate_log_file($name);
            if ($path === null) {
                continue;
            }
            // @phpstan-ignore-next-line
            $zip->addFile($path, basename($name));
        }

        $zip->close();

        if (!is_file($zip_path)) {
            wp_die('ZIP non généré.');
        }

        $download_name = 'sosprescription-logs-' . $channel;
        if ($mode === 'general') {
            $download_name .= '-general';
        }
        if ($scope !== '') {
            $download_name .= '-' . $scope;
        }
        $download_name .= '-' . gmdate('Ymd-His') . '.zip';

        $size = (int) (@filesize($zip_path) ?: 0);

        nocache_headers();
        header('Content-Type: application/zip');
        header('Content-Disposition: attachment; filename="' . $download_name . '"');
        if ($size > 0) {
            header('Content-Length: ' . $size);
        }

        // @phpstan-ignore-next-line
        @readfile($zip_path);
        @unlink($zip_path);
        exit;
    }

    public static function handle_delete(): void
    {
        if (!current_user_can('sosprescription_manage') && !current_user_can('manage_options')) {
            wp_die('Accès refusé.');
        }

        check_admin_referer('sosprescription_logs_delete');

        $file = isset($_GET['file']) ? (string) $_GET['file'] : '';
        $file = rawurldecode($file);

        if ($file !== '') {
            Logger::delete_file($file);
        }

        $tab = isset($_GET['tab']) ? sanitize_key((string) $_GET['tab']) : 'settings';
        $allowed_tabs = ['settings', 'bdpm', 'runtime', 'shortcodes', 'viewer'];
        if (!in_array($tab, $allowed_tabs, true)) {
            $tab = 'settings';
        }

        $url = add_query_arg([
            'page' => 'sosprescription-logs',
            'tab' => $tab,
            'deleted' => '1',
        ], admin_url('admin.php'));

        wp_safe_redirect($url);
        exit;
    }

    public static function handle_truncate(): void
    {
        if (!current_user_can('sosprescription_manage') && !current_user_can('manage_options')) {
            wp_die('Accès refusé.');
        }

        check_admin_referer('sosprescription_logs_truncate');

        $file = isset($_GET['file']) ? (string) $_GET['file'] : '';
        $file = rawurldecode($file);

        if ($file !== '') {
            Logger::truncate_file($file);
        }

        $tab = isset($_GET['tab']) ? sanitize_key((string) $_GET['tab']) : 'runtime';
        $allowed_tabs = ['settings', 'bdpm', 'runtime', 'shortcodes', 'viewer'];
        if (!in_array($tab, $allowed_tabs, true)) {
            $tab = 'runtime';
        }

        $url = add_query_arg([
            'page' => 'sosprescription-logs',
            'tab' => $tab,
            'truncated' => '1',
        ], admin_url('admin.php'));

        wp_safe_redirect($url);
        exit;
    }

    /**
     * Vider tous les fichiers de logs (truncate) sans les supprimer.
     */
    public static function handle_truncate_all(): void
    {
        if (!current_user_can('sosprescription_manage') && !current_user_can('manage_options')) {
            wp_die('Accès refusé.');
        }

        check_admin_referer('sosprescription_logs_truncate_all');

        $runtime_files = Logger::list_files('runtime', 5000);
        foreach ($runtime_files as $f) {
            $name = (string) ($f['name'] ?? '');
            if ($name !== '') {
                Logger::truncate_file($name);
            }
        }

        $bdpm_files = Logger::list_files('bdpm', 5000);
        foreach ($bdpm_files as $f) {
            $name = (string) ($f['name'] ?? '');
            if ($name !== '') {
                Logger::truncate_file($name);
            }
        }

        $tab = isset($_POST['tab']) ? sanitize_key((string) $_POST['tab']) : 'settings';
        $allowed_tabs = ['settings', 'bdpm', 'runtime', 'shortcodes', 'viewer'];
        if (!in_array($tab, $allowed_tabs, true)) {
            $tab = 'settings';
        }

        $url = add_query_arg([
            'page' => 'sosprescription-logs',
            'tab' => $tab,
            'truncated_all' => '1',
        ], admin_url('admin.php'));

        wp_safe_redirect($url);
        exit;
    }

    /**
     * Supprimer tous les fichiers de logs (suppression physique).
     */
    public static function handle_delete_all(): void
    {
        if (!current_user_can('sosprescription_manage') && !current_user_can('manage_options')) {
            wp_die('Accès refusé.');
        }

        check_admin_referer('sosprescription_logs_delete_all');

        Logger::clear_channel('runtime');
        Logger::clear_channel('bdpm');

        $tab = isset($_POST['tab']) ? sanitize_key((string) $_POST['tab']) : 'settings';
        $allowed_tabs = ['settings', 'bdpm', 'runtime', 'shortcodes', 'viewer'];
        if (!in_array($tab, $allowed_tabs, true)) {
            $tab = 'settings';
        }

        $url = add_query_arg([
            'page' => 'sosprescription-logs',
            'tab' => $tab,
            'deleted_all' => '1',
        ], admin_url('admin.php'));

        wp_safe_redirect($url);
        exit;
    }

    public static function handle_clear_channel(): void
    {
        if (!current_user_can('sosprescription_manage') && !current_user_can('manage_options')) {
            wp_die('Accès refusé.');
        }

        // compat : ancienne action utilisait nonce 'sosprescription_logs_clear'
        if (isset($_POST['_wpnonce']) && wp_verify_nonce((string) $_POST['_wpnonce'], 'sosprescription_logs_clear_channel') === 1) {
            // ok
        } else {
            check_admin_referer('sosprescription_logs_clear');
        }

        $channel = isset($_POST['channel']) ? (string) $_POST['channel'] : '';
        $channel = strtolower(trim($channel));
        if (!in_array($channel, ['bdpm', 'runtime'], true)) {
            $channel = 'runtime';
        }

        Logger::clear_channel($channel);

        $tab = isset($_POST['tab']) ? sanitize_key((string) $_POST['tab']) : 'runtime';
        $allowed_tabs = ['settings', 'bdpm', 'runtime', 'shortcodes', 'viewer'];
        if (!in_array($tab, $allowed_tabs, true)) {
            $tab = 'runtime';
        }

        $url = add_query_arg([
            'page' => 'sosprescription-logs',
            'tab' => $tab,
            'cleared' => '1',
        ], admin_url('admin.php'));

        wp_safe_redirect($url);
        exit;
    }

    public static function handle_clear_scope(): void
    {
        if (!current_user_can('sosprescription_manage') && !current_user_can('manage_options')) {
            wp_die('Accès refusé.');
        }

        check_admin_referer('sosprescription_logs_clear_scope');

        $channel = isset($_POST['channel']) ? (string) $_POST['channel'] : '';
        $channel = strtolower(trim($channel));
        if (!in_array($channel, ['bdpm', 'runtime'], true)) {
            $channel = 'runtime';
        }

        $scope = isset($_POST['scope']) ? (string) $_POST['scope'] : '';
        $scope = trim($scope);
        if ($scope !== '') {
            Logger::clear_scope($channel, $scope);
        }

        $tab = isset($_POST['tab']) ? sanitize_key((string) $_POST['tab']) : 'shortcodes';
        $allowed_tabs = ['settings', 'bdpm', 'runtime', 'shortcodes', 'viewer'];
        if (!in_array($tab, $allowed_tabs, true)) {
            $tab = 'shortcodes';
        }

        $url = add_query_arg([
            'page' => 'sosprescription-logs',
            'tab' => $tab,
            'scope_cleared' => '1',
        ], admin_url('admin.php'));

        wp_safe_redirect($url);
        exit;
    }

    public static function handle_export_reqid(): void
    {
        if (!current_user_can('sosprescription_manage') && !current_user_can('manage_options')) {
            wp_die('Accès refusé.');
        }

        $reqid = isset($_GET['reqid']) ? sanitize_text_field((string) $_GET['reqid']) : '';
        $reqid = Logger::sanitize_reqid($reqid);

        $nonce = isset($_GET['_wpnonce']) ? sanitize_text_field((string) $_GET['_wpnonce']) : '';
        if (!$reqid || !$nonce || !wp_verify_nonce($nonce, 'sosprescription_export_reqid_' . $reqid)) {
            wp_die('Requête invalide (nonce).');
        }

        $hits = Logger::search_global_reqid($reqid, 5000);

        $out = "SOS Prescription — Export ReqID: {$reqid}\n";
        $out .= 'Généré le: ' . gmdate('Y-m-d H:i:s') . " UTC\n\n";

        if (empty($hits)) {
            $out .= "Aucune ligne trouvée pour cet ID.\n";
        } else {
            foreach ($hits as $hit) {
                $file = isset($hit['file']) ? (string) $hit['file'] : '';
                $line = isset($hit['line']) ? (string) $hit['line'] : '';
                $out .= '[' . $file . '] ' . $line . "\n";
            }
        }

        $filename = 'sosprescription-reqid-' . $reqid . '-' . gmdate('Ymd-His') . '.txt';
        $filename = preg_replace('/[^A-Za-z0-9._-]/', '_', $filename);

        while (ob_get_level()) {
            ob_end_clean();
        }

        header('Content-Type: text/plain; charset=utf-8');
        header('Content-Disposition: attachment; filename=' . $filename);
        header('X-Content-Type-Options: nosniff');

        echo $out;
        exit;
    }

    public static function handle_export_reqid_ndjson(): void
    {
        if (!current_user_can('sosprescription_manage') && !current_user_can('manage_options')) {
            wp_die('Accès refusé.');
        }

        $reqid = isset($_GET['reqid']) ? sanitize_text_field((string) $_GET['reqid']) : '';
        $reqid = Logger::sanitize_reqid($reqid);

        $nonce = isset($_GET['_wpnonce']) ? sanitize_text_field((string) $_GET['_wpnonce']) : '';
        if (!$reqid || !$nonce || !wp_verify_nonce($nonce, 'sosprescription_export_reqid_ndjson_' . $reqid)) {
            wp_die('Requête invalide (nonce).');
        }

        $hits = Logger::search_global_reqid($reqid, 5000);

        $filename = 'sosprescription-reqid-' . $reqid . '-' . gmdate('Ymd-His') . '.ndjson';
        $filename = preg_replace('/[^A-Za-z0-9._-]/', '_', $filename);

        while (ob_get_level()) {
            ob_end_clean();
        }

        header('Content-Type: application/x-ndjson; charset=utf-8');
        header('Content-Disposition: attachment; filename=' . $filename);
        header('X-Content-Type-Options: nosniff');

        if (empty($hits)) {
            echo wp_json_encode([
                'ts'     => gmdate('c'),
                'level'  => 'info',
                'event'  => 'reqid_export_empty',
                'req_id' => $reqid,
            ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n";
            exit;
        }

        foreach ($hits as $hit) {
            $file = isset($hit['file']) ? (string) $hit['file'] : '';
            $line = isset($hit['line']) ? trim((string) $hit['line']) : '';
            if ($line === '') {
                continue;
            }

            $obj = json_decode($line, true);
            if (is_array($obj)) {
                // Preserve original NDJSON record and annotate with file.
                $obj['_file'] = $file;
                echo wp_json_encode($obj, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n";
            } else {
                // Fallback for legacy/plain logs: wrap as an object.
                echo wp_json_encode([
                    'ts'     => gmdate('c'),
                    'level'  => 'info',
                    'event'  => 'reqid_export_legacy_line',
                    'req_id' => $reqid,
                    '_file'  => $file,
                    'raw'    => $line,
                ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n";
            }
        }

        exit;
    }

    public static function handle_export_diagnostic(): void
    {
        if (!current_user_can('manage_options')) {
            wp_die('Permission denied.', 403);
        }

        $nonce = isset($_GET['_wpnonce']) ? sanitize_text_field((string) $_GET['_wpnonce']) : '';
        if (!wp_verify_nonce($nonce, 'sosprescription_logs_export_diagnostic')) {
            wp_die('Invalid nonce.', 403);
        }

        // Build diagnostics (PII-safe)
        $data = DiagnosticsService::collect();
        $rid  = (string) ($data['req_id'] ?? Logger::rid());

        // Trace in NDJSON
        Logger::ndjson_scoped(
            'runtime',
            'support',
            'info',
            'diagnostic_export',
            [
                'req_id'  => $rid,
                'user_id' => get_current_user_id(),
            ]
        );

        // Ensure clean JSON output even if other plugins emitted notices.
        while (ob_get_level()) {
            ob_end_clean();
        }

        $filename = 'sosprescription-diagnostic-' . gmdate('Ymd-His') . '-' . preg_replace('/[^A-Za-z0-9_-]/', '', $rid) . '.json';

        header('Content-Type: application/json; charset=utf-8');
        header('Content-Disposition: attachment; filename="' . $filename . '"');
        header('X-Content-Type-Options: nosniff');

        echo wp_json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
        exit;
    }

    /**
     * Support Bundle (ZIP)
     *
     * Objectif : fournir un artefact unique "ticket-ready" regroupant :
     * - diagnostics.json (PII-safe)
     * - pii-audit.json (redacted)
     * - logs/*.log (extraits, taille plafonnée)
     *
     * ⚠️ Note : le bundle est destiné au support technique. Les logs sont censés
     * être PII-safe (masquage à l'écriture + audit). Par sécurité, l'export
     * applique un masquage "best effort" sur l'extrait des logs.
     */
    
    public static function handle_export_filtered_ndjson(): void
    {
        if (!current_user_can('manage_options')) {
            wp_die('Unauthorized', 403);
        }

        check_admin_referer('sosprescription_logs_export_filtered_ndjson');

        $req_id = isset($_GET['reqid']) ? sanitize_text_field(wp_unslash($_GET['reqid'])) : '';
        $scope  = isset($_GET['scope']) ? sanitize_text_field(wp_unslash($_GET['scope'])) : '';
        $level  = isset($_GET['level']) ? sanitize_text_field(wp_unslash($_GET['level'])) : '';

        // Normalize inputs.
        $req_id = preg_replace('/[^A-Za-z0-9]/', '', (string) $req_id);
        $scope  = preg_replace('/[^A-Za-z0-9_\-]/', '', (string) $scope);
        $level  = strtoupper(preg_replace('/[^A-Za-z]/', '', (string) $level));

        if ($req_id === '' && $scope === '' && $level === '') {
            wp_die('Veuillez fournir au moins un filtre (Scope, Niveau ou ReqID).');
        }

        $dir = Logger::dir();
        if (!is_dir($dir)) {
            wp_die('Répertoire de logs introuvable.');
        }

        $paths = glob($dir . '/*.log');
        if (!$paths) {
            wp_die('Aucun fichier log trouvé.');
        }

        // Sort by mtime (ascending) for a chronological export.
        usort($paths, static function (string $a, string $b): int {
            return (filemtime($a) ?: 0) <=> (filemtime($b) ?: 0);
        });

        // Clean any buffered output to avoid corrupting the NDJSON.
        while (ob_get_level()) {
            ob_end_clean();
        }

        $ts = gmdate('Ymd-His');
        $filename = 'sosprescription-logs-' . $ts . '.ndjson';

        header('Content-Type: application/x-ndjson; charset=utf-8');
        header('Content-Disposition: attachment; filename="' . $filename . '"');
        header('X-Content-Type-Options: nosniff');

        $meta = [
            'type' => 'meta',
            'generated_at' => gmdate('c'),
            'plugin_version' => defined('SOSPRESCRIPTION_VERSION') ? (string) SOSPRESCRIPTION_VERSION : '',
            'site_url' => function_exists('home_url') ? (string) home_url() : '',
            'filters' => [
                'req_id' => $req_id !== '' ? $req_id : null,
                'scope' => $scope !== '' ? $scope : null,
                'level' => $level !== '' ? $level : null,
            ],
        ];
        echo wp_json_encode($meta) . "
";

        $max_records = (int) apply_filters('sosprescription_logs_export_max_records', 20000);
        $count = 0;
        $truncated = false;

        foreach ($paths as $path) {
            try {
                $file = new \SplFileObject($path, 'r');
            } catch (\Throwable $e) {
                continue;
            }

            $line_no = 0;
            while (!$file->eof()) {
                $line = $file->fgets();
                $line_no++;
                if ($line === false) {
                    break;
                }

                $line_trim = trim((string) $line);
                if ($line_trim === '') {
                    continue;
                }

                $decoded = json_decode($line_trim, true);
                $is_json = is_array($decoded) && json_last_error() === JSON_ERROR_NONE;

                if ($is_json) {
                    $rec_req = (string) ($decoded['req_id'] ?? $decoded['rid'] ?? '');
                    $rec_scope = (string) ($decoded['scope'] ?? '');
                    $rec_level = (string) ($decoded['lvl'] ?? $decoded['level'] ?? '');

                    if ($req_id !== '' && $rec_req !== $req_id) {
                        continue;
                    }
                    if ($scope !== '' && strtolower($rec_scope) !== strtolower($scope)) {
                        continue;
                    }
                    if ($level !== '' && strtoupper($rec_level) !== $level) {
                        continue;
                    }

                    // Add source information without overwriting existing fields.
                    if (!isset($decoded['_src_file'])) {
                        $decoded['_src_file'] = basename((string) $path);
                    }
                    if (!isset($decoded['_src_line'])) {
                        $decoded['_src_line'] = $line_no;
                    }

                    echo wp_json_encode($decoded) . "
";
                    $count++;
                } else {
                    // Best-effort: include legacy/raw lines only when filtering by ReqID.
                    if ($req_id !== '' && strpos($line_trim, $req_id) !== false) {
                        $raw = [
                            'type' => 'raw',
                            'req_id' => $req_id,
                            '_src_file' => basename((string) $path),
                            '_src_line' => $line_no,
                            'raw' => $line_trim,
                        ];
                        echo wp_json_encode($raw) . "
";
                        $count++;
                    }
                }

                if ($count >= $max_records) {
                    $truncated = true;
                    break 2;
                }
            }
        }

        $end = [
            'type' => 'meta_end',
            'matches' => $count,
            'truncated' => $truncated,
        ];
        echo wp_json_encode($end) . "
";

        exit;
    }

public static function handle_support_bundle(): void
    {
        if (!current_user_can('manage_options')) {
            wp_die('Forbidden', 403);
        }

        check_admin_referer('sosprescription_logs_support_bundle');

        if (!class_exists('ZipArchive')) {
            wp_die('ZipArchive is not available on this server.', 500);
        }

        $rid = Logger::rid();
        $ts  = gmdate('Ymd-His');

        $uploads = wp_upload_dir();
        $legacy_logs_dir = rtrim((string) ($uploads['basedir'] ?? ''), '/\\') . '/sosprescription-logs';

        $private_logs_dir = Logger::dir();
        $tmp_dir = rtrim($private_logs_dir, '/\\') . '/_tmp';
        wp_mkdir_p($tmp_dir);

        $bundle_name = 'sosprescription-support-bundle-' . $ts . '-' . preg_replace('/[^A-Za-z0-9_-]/', '', $rid) . '.zip';
        $bundle_path = rtrim($tmp_dir, '/\\') . '/' . $bundle_name;

        $zip = new \ZipArchive();
        $open_res = $zip->open($bundle_path, \ZipArchive::CREATE | \ZipArchive::OVERWRITE);
        if ($open_res !== true) {
            wp_die('Failed to create ZIP bundle.', 500);
        }

        // 1) README
        $zip->addFromString(
            'README.txt',
            "SOSPrescription - Support Bundle\n" .
            "Generated (UTC): {$ts}\n" .
            "ReqID: {$rid}\n\n" .
            "Contents:\n" .
            "- diagnostics.json (PII-safe)\n" .
            "- pii-audit.json (redacted)\n" .
            "- logs/private/*.log (tail, size-capped)\n" .
            "- logs/legacy/*.log (tail, size-capped, if present)\n\n" .
            "Notes:\n" .
            "- Logs are expected to be PII-safe (masked) but treat as sensitive.\n" .
            "- This bundle is intended for technical support only.\n"
        );

        // 2) diagnostics.json
        $diag = DiagnosticsService::collect();
        $zip->addFromString('diagnostics.json', wp_json_encode($diag, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));

        // 3) pii-audit.json
        $pii = \SOSPrescription\Services\PiiScanner::audit_logs_dir($private_logs_dir, [
            'max_files' => 80,
            'max_bytes_per_file' => 1024 * 1024,
        ]);
        $zip->addFromString('pii-audit.json', wp_json_encode($pii, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));

        // 4) logs (tail)
        $max_bytes = (int) apply_filters('sosprescription_support_bundle_max_bytes_per_file', 1024 * 1024);
        $max_bytes = max(32 * 1024, min($max_bytes, 5 * 1024 * 1024));

        $add_log_file = function (string $path, string $zip_name) use ($zip, $max_bytes): void {
            if (!is_file($path) || !is_readable($path)) {
                return;
            }

            $size = (int) @filesize($path);
            $fh = @fopen($path, 'rb');
            if (!$fh) {
                return;
            }

            if ($size > $max_bytes) {
                // Seek to last N bytes.
                @fseek($fh, -$max_bytes, SEEK_END);
            }

            $content = (string) stream_get_contents($fh);
            @fclose($fh);

            if ($size > $max_bytes) {
                // Drop partial first line.
                $pos = strpos($content, "\n");
                if ($pos !== false) {
                    $content = substr($content, $pos + 1);
                }
                $content = "[TRUNCATED] Showing last {$max_bytes} bytes\n" . $content;
            }

            // Best-effort masking (do not guarantee full PII removal, but helps).]
            $content = \SOSPrescription\Services\PiiScanner::mask_text($content);

            $zip->addFromString($zip_name, $content);
        };

        $private_files = glob(rtrim($private_logs_dir, '/\\') . '/*.log') ?: [];
        foreach ($private_files as $file) {
            $base = basename((string) $file);
            $add_log_file((string) $file, 'logs/private/' . $base);
        }

        if (is_dir($legacy_logs_dir)) {
            $legacy_files = glob(rtrim($legacy_logs_dir, '/\\') . '/*.log') ?: [];
            foreach ($legacy_files as $file) {
                $base = basename((string) $file);
                $add_log_file((string) $file, 'logs/legacy/' . $base);
            }
        }

        $zip->close();

        // Trace in NDJSON
        Logger::ndjson_scoped(
            'runtime',
            'support',
            'info',
            'support_bundle_export',
            [
                'req_id'  => $rid,
                'user_id' => get_current_user_id(),
                'file'    => $bundle_name,
                'bytes'   => (int) @filesize($bundle_path),
            ]
        );

        // Ensure clean binary output.
        while (ob_get_level()) {
            ob_end_clean();
        }

        header('Content-Type: application/zip');
        header('Content-Disposition: attachment; filename="' . $bundle_name . '"');
        header('X-Content-Type-Options: nosniff');

        $bytes = (int) @filesize($bundle_path);
        if ($bytes > 0) {
            header('Content-Length: ' . $bytes);
        }

        readfile($bundle_path);
        @unlink($bundle_path);
        exit;
    }

    /**
     * PII audit : scan all .log files in the private logs directory and output a JSON report.
     * The report is redacted (no raw PII), safe to share with support.
     */
    public static function handle_pii_audit(): void
    {
        if (!current_user_can('manage_options')) {
            wp_die('Forbidden', 403);
        }

        check_admin_referer('sosprescription_logs_pii_audit');

        // Purge any accidental output that would corrupt the JSON payload.
        while (ob_get_level()) {
            ob_end_clean();
        }

        $dir = Logger::dir();
        $report = \SOSPrescription\Services\PiiScanner::audit_logs_dir($dir, [
            'max_findings' => 300,
            'max_line_len' => 800,
        ]);

        $filename = 'sosprescription-pii-audit-' . gmdate('Ymd-His') . '.json';
        header('Content-Type: application/json; charset=utf-8');
        header('Content-Disposition: attachment; filename="' . $filename . '"');
        echo wp_json_encode($report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        exit;
    }

}
