<?php
declare(strict_types=1);

namespace SosPrescription\Admin;

use SosPrescription\Services\Audit;
use SosPrescription\Services\ComplianceConfig;
use SosPrescription\Services\LegalPages;
use SosPrescription\Services\Retention;

final class CompliancePage
{
    public static function register_actions(): void
    {
        add_action('admin_post_sosprescription_compliance_save', [self::class, 'handle_save']);
        add_action('admin_post_sosprescription_compliance_run_retention', [self::class, 'handle_run_retention']);
        add_action('admin_post_sp_generate_legal_pages', [self::class, 'handle_generate_legal_pages']);
    }

    public static function render_page(): void
    {
        if (!self::can_manage()) {
            wp_die('Accès refusé.');
        }

        $cfg = ComplianceConfig::get();
        $bindings = LegalPages::get_dashboard_bindings();

        $updated = isset($_GET['updated']) && (string) $_GET['updated'] === '1';
        $generated = isset($_GET['generated']) && (string) $_GET['generated'] === '1';
        $ran = isset($_GET['ran']) && (string) $_GET['ran'] === '1';
        $issues = isset($_GET['issues']) ? trim((string) wp_unslash($_GET['issues'])) : '';

        $auditPurged = isset($_GET['audit_purged']) ? (int) $_GET['audit_purged'] : null;
        $orphansPurged = isset($_GET['orphans_purged']) ? (int) $_GET['orphans_purged'] : null;
        $createdCount = isset($_GET['created_count']) ? max(0, (int) $_GET['created_count']) : 0;
        $boundCount = isset($_GET['bound_count']) ? max(0, (int) $_GET['bound_count']) : 0;

        echo '<div class="wrap">';
        echo '<h1 style="display:flex; align-items:center; gap:10px;">';
        echo '<img src="' . esc_url(SOSPRESCRIPTION_URL . 'assets/caduceus.svg') . '" alt="" style="width:26px;height:26px;" />';
        echo '<span>Générateur de pages légales</span>';
        echo '<span style="margin-left:6px; padding:2px 8px; border-radius:999px; border:1px solid #dcdcde; background:#f6f7f7; color:#646970; font-size:12px;">V7.1.0</span>';
        echo '</h1>';

        echo '<p style="max-width:980px;">';
        echo 'Tableau de bord de reconnaissance et de génération des documents légaux publics. '; 
        echo 'Cette zone conserve la projection de compatibilité front (consentement, <code>cgu_url</code>, <code>privacy_url</code>, versions) '; 
        echo 'sans réintroduire de racine applicative confinée dans les pages publiques.';
        echo '</p>';

        if ($updated) {
            echo '<div class="notice notice-success is-dismissible"><p>Paramètres de compatibilité enregistrés.</p></div>';
        }

        if ($generated) {
            $message = sprintf(
                'Génération terminée. Pages créées : %d. Bindings valides reconnus : %d.',
                $createdCount,
                $boundCount
            );
            echo '<div class="notice notice-success is-dismissible"><p>' . esc_html($message) . '</p></div>';
        }

        if ($issues !== '') {
            $parts = array_filter(array_map('trim', explode('||', $issues)), static fn(string $item): bool => $item !== '');
            echo '<div class="notice notice-warning"><p><strong>Points d’attention :</strong></p><ul style="margin-left:1.2em;">';
            foreach ($parts as $part) {
                echo '<li>' . esc_html($part) . '</li>';
            }
            echo '</ul></div>';
        }

        if ($ran) {
            $msg = 'Routine de rétention exécutée.';
            if ($auditPurged !== null || $orphansPurged !== null) {
                $msg .= ' Audit purgé : ' . (int) ($auditPurged ?? 0) . ' ; fichiers orphelins purgés : ' . (int) ($orphansPurged ?? 0) . '.';
            }
            echo '<div class="notice notice-info is-dismissible"><p>' . esc_html($msg) . '</p></div>';
        }

        self::render_generator_dashboard($bindings);
        self::render_compatibility_panel($cfg);
        self::render_save_panel($cfg);
        self::render_retention_panel($cfg);

        echo '</div>';
    }

    public static function handle_save(): void
    {
        if (!self::can_manage()) {
            wp_die('Accès refusé.');
        }

        check_admin_referer('sosprescription_compliance_save');

        $fields = [];
        $fields['consent_required'] = isset($_POST['consent_required']) && (string) wp_unslash($_POST['consent_required']) === '1';

        $fields['audit_purge_enabled'] = isset($_POST['audit_purge_enabled']) && (string) wp_unslash($_POST['audit_purge_enabled']) === '1';
        $fields['orphan_files_purge_enabled'] = isset($_POST['orphan_files_purge_enabled']) && (string) wp_unslash($_POST['orphan_files_purge_enabled']) === '1';

        if (isset($_POST['audit_retention_days'])) {
            $fields['audit_retention_days'] = max(1, (int) wp_unslash($_POST['audit_retention_days']));
        }
        if (isset($_POST['orphan_files_retention_days'])) {
            $fields['orphan_files_retention_days'] = max(1, (int) wp_unslash($_POST['orphan_files_retention_days']));
        }

        ComplianceConfig::update($fields);

        Audit::log('config_update', 'compliance', null, null, [
            'fields' => array_keys($fields),
        ]);

        $url = add_query_arg([
            'page' => 'sosprescription-compliance',
            'updated' => '1',
        ], admin_url('admin.php'));

        wp_safe_redirect($url);
        exit;
    }

    public static function handle_generate_legal_pages(): void
    {
        if (!current_user_can('manage_options')) {
            wp_die('Accès refusé.');
        }

        check_admin_referer('sp_generate_legal_pages');

        $result = LegalPages::ensure_pages();
        $created = isset($result['created']) && is_array($result['created']) ? $result['created'] : [];
        $bound = isset($result['bound']) && is_array($result['bound']) ? $result['bound'] : [];
        $errors = isset($result['errors']) && is_array($result['errors']) ? $result['errors'] : [];

        Audit::log('legal_pages_generate', 'compliance', null, null, [
            'created_count' => count($created),
            'bound_count' => count($bound),
            'errors_count' => count($errors),
            'created_slots' => array_keys($created),
            'bound_slots' => array_keys($bound),
        ]);

        $url = add_query_arg([
            'page' => 'sosprescription-compliance',
            'generated' => '1',
            'created_count' => (string) count($created),
            'bound_count' => (string) count($bound),
            'issues' => implode('||', array_map('strval', $errors)),
        ], admin_url('admin.php'));

        wp_safe_redirect($url);
        exit;
    }

    public static function handle_run_retention(): void
    {
        if (!self::can_manage()) {
            wp_die('Accès refusé.');
        }

        check_admin_referer('sosprescription_compliance_run_retention');

        $res = Retention::run();

        Audit::log('retention_run', 'compliance', null, null, $res);

        $url = add_query_arg([
            'page' => 'sosprescription-compliance',
            'ran' => '1',
            'audit_purged' => (string) ((int) ($res['audit_purged'] ?? 0)),
            'orphans_purged' => (string) ((int) ($res['orphan_files_purged'] ?? 0)),
        ], admin_url('admin.php'));

        wp_safe_redirect($url);
        exit;
    }

    /**
     * @param array<string, array<string, mixed>> $bindings
     */
    private static function render_generator_dashboard(array $bindings): void
    {
        echo '<div style="max-width:1080px;background:#fff;border:1px solid #dcdcde;border-radius:12px;padding:18px;margin:16px 0;">';
        echo '<h2 style="margin-top:0;">Pages légales publiques</h2>';
        echo '<p class="description">Les trois pages cibles doivent rester theme-owned, avec un contenu limité au shortcode légal correspondant. La reconnaissance combine slug canonique et présence du shortcode attendu.</p>';

        echo '<table class="widefat striped" style="margin-top:12px;">';
        echo '<thead><tr>';
        echo '<th>Document</th><th>Slug public</th><th>Shortcode</th><th>Statut</th><th>Page reconnue</th><th>Binding</th>';
        echo '</tr></thead><tbody>';

        foreach ($bindings as $binding) {
            $statusLabel = isset($binding['status_label']) ? (string) $binding['status_label'] : 'Inconnu';
            $statusKey = isset($binding['status_key']) ? (string) $binding['status_key'] : 'unknown';
            $badgeStyle = self::badge_style($statusKey);
            $pageId = isset($binding['page_id']) ? (int) $binding['page_id'] : 0;
            $pageTitle = isset($binding['page_title']) ? (string) $binding['page_title'] : '';
            $permalink = isset($binding['permalink']) ? (string) $binding['permalink'] : '';
            $pageStatus = isset($binding['page_status']) ? (string) $binding['page_status'] : '';
            $details = isset($binding['details']) ? (string) $binding['details'] : '';

            echo '<tr>';
            echo '<td><strong>' . esc_html((string) ($binding['label'] ?? '')) . '</strong></td>';
            echo '<td><code>' . esc_html((string) ($binding['slug'] ?? '')) . '</code></td>';
            echo '<td><code>' . esc_html((string) ($binding['shortcode'] ?? '')) . '</code></td>';
            echo '<td><span style="' . esc_attr($badgeStyle) . '">' . esc_html($statusLabel) . '</span></td>';
            echo '<td>';
            if ($pageId > 0) {
                echo '<strong>' . esc_html($pageTitle !== '' ? $pageTitle : '(sans titre)') . '</strong>';
                echo '<div class="description">#' . esc_html((string) $pageId) . ' · ' . esc_html($pageStatus !== '' ? $pageStatus : 'inconnu') . '</div>';
                if ($permalink !== '') {
                    echo '<div style="margin-top:4px;"><a href="' . esc_url($permalink) . '" target="_blank" rel="noopener noreferrer">Voir la page</a>';
                    $editLink = get_edit_post_link($pageId);
                    if (is_string($editLink) && $editLink !== '') {
                        echo ' · <a href="' . esc_url($editLink) . '">Éditer</a>';
                    }
                    echo '</div>';
                }
            } else {
                echo '—';
            }
            echo '</td>';
            echo '<td>' . esc_html($details) . '</td>';
            echo '</tr>';
        }

        echo '</tbody></table>';

        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '" style="margin-top:16px;">';
        echo '<input type="hidden" name="action" value="sp_generate_legal_pages" />';
        wp_nonce_field('sp_generate_legal_pages');
        echo '<p>';
        if (current_user_can('manage_options')) {
            echo '<button type="submit" class="button button-primary">Générer les pages manquantes</button>';
        } else {
            echo '<button type="button" class="button" disabled aria-disabled="true">Générer les pages manquantes</button>';
            echo ' <span class="description">Action réservée aux administrateurs disposant de <code>manage_options</code>.</span>';
        }
        echo '</p>';
        echo '<p class="description">';
        echo 'Slugs stricts utilisés : <code>mentions-legales</code>, <code>conditions-du-service</code>, <code>politique-de-confidentialite</code>. '; 
        echo 'Le générateur crée uniquement les pages manquantes et n’écrase pas silencieusement une page existante au mauvais contenu.';
        echo '</p>';
        echo '</form>';
        echo '</div>';
    }

    /**
     * @param array<string, mixed> $cfg
     */
    private static function render_compatibility_panel(array $cfg): void
    {
        echo '<div style="max-width:1080px;background:#fff;border:1px solid #dcdcde;border-radius:12px;padding:18px;margin:16px 0;">';
        echo '<h2 style="margin-top:0;">Projection de compatibilité front</h2>';
        echo '<p class="description">Le front existant continue à consommer <code>cgu_url</code>, <code>privacy_url</code>, <code>cgu_version</code> et <code>privacy_version</code>. Ces valeurs sont maintenant pilotées par le générateur et affichées ici en lecture seule.</p>';

        echo '<table class="form-table" role="presentation"><tbody>';
        self::readonly_row('URL CGU', (string) ($cfg['cgu_url'] ?? ''));
        self::readonly_row('Version CGU', (string) ($cfg['cgu_version'] ?? ''));
        self::readonly_row('URL confidentialité', (string) ($cfg['privacy_url'] ?? ''));
        self::readonly_row('Version confidentialité', (string) ($cfg['privacy_version'] ?? ''));
        echo '</tbody></table>';
        echo '</div>';
    }

    /**
     * @param array<string, mixed> $cfg
     */
    private static function render_save_panel(array $cfg): void
    {
        echo '<div style="max-width:1080px;background:#fff;border:1px solid #dcdcde;border-radius:12px;padding:18px;margin:16px 0;">';
        echo '<h2 style="margin-top:0;">Compatibilité consentement</h2>';
        echo '<p class="description">Le consentement reste éditable pour le tunnel existant. Les URLs et versions juridiques ne se saisissent plus manuellement dans cet écran.</p>';

        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        echo '<input type="hidden" name="action" value="sosprescription_compliance_save" />';
        wp_nonce_field('sosprescription_compliance_save');

        echo '<table class="form-table" role="presentation"><tbody>';
        echo '<tr><th scope="row">Consentement requis</th><td>';
        echo '<label><input type="checkbox" name="consent_required" value="1"' . (!empty($cfg['consent_required']) ? ' checked' : '') . ' /> Oui (recommandé)</label>';
        echo '<p class="description">Conditionne l’affichage et l’exigence des consentements dans le tunnel patient existant.</p>';
        echo '</td></tr>';
        echo '</tbody></table>';

        echo '<p><button type="submit" class="button button-primary">Enregistrer</button></p>';
        echo '<p class="description">Dernière mise à jour : <code>' . esc_html((string) ($cfg['updated_at'] ?? '')) . '</code></p>';
        echo '</form>';
        echo '</div>';
    }

    /**
     * @param array<string, mixed> $cfg
     */
    private static function render_retention_panel(array $cfg): void
    {
        echo '<div style="max-width:1080px;background:#fff;border:1px solid #dcdcde;border-radius:12px;padding:18px;margin:16px 0;">';
        echo '<h2 style="margin-top:0;">Maintenance technique existante</h2>';
        echo '<p class="description">Zone legacy conservée pour ne pas régresser sur les réglages techniques déjà présents. Elle reste distincte du moteur de génération des pages légales.</p>';

        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        echo '<input type="hidden" name="action" value="sosprescription_compliance_save" />';
        wp_nonce_field('sosprescription_compliance_save');

        echo '<table class="form-table" role="presentation"><tbody>';
        echo '<tr><th scope="row">Audit log</th><td>';
        echo '<label><input type="checkbox" name="audit_purge_enabled" value="1"' . (!empty($cfg['audit_purge_enabled']) ? ' checked' : '') . ' /> Purge activée</label><br />';
        echo '<input type="number" name="audit_retention_days" value="' . esc_attr((string) ($cfg['audit_retention_days'] ?? '3650')) . '" min="1" style="width:120px;" /> jours';
        echo '<p class="description">Par défaut 10 ans (3650 jours).</p>';
        echo '</td></tr>';

        echo '<tr><th scope="row">Fichiers orphelins</th><td>';
        echo '<label><input type="checkbox" name="orphan_files_purge_enabled" value="1"' . (!empty($cfg['orphan_files_purge_enabled']) ? ' checked' : '') . ' /> Purge activée</label><br />';
        echo '<input type="number" name="orphan_files_retention_days" value="' . esc_attr((string) ($cfg['orphan_files_retention_days'] ?? '7')) . '" min="1" style="width:120px;" /> jours';
        echo '<p class="description">Utile pour supprimer les pièces uploadées mais jamais rattachées à une demande.</p>';
        echo '</td></tr>';
        echo '</tbody></table>';

        echo '<p><button type="submit" class="button">Enregistrer la maintenance</button></p>';
        echo '</form>';

        echo '<hr />';
        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        echo '<input type="hidden" name="action" value="sosprescription_compliance_run_retention" />';
        wp_nonce_field('sosprescription_compliance_run_retention');
        echo '<p><button type="submit" class="button button-secondary">Exécuter la purge maintenant</button></p>';
        echo '</form>';

        $next = wp_next_scheduled(Retention::CRON_HOOK);
        if ($next) {
            echo '<p class="description">Prochaine exécution WP-Cron : <code>' . esc_html(gmdate('Y-m-d H:i:s', (int) $next)) . ' UTC</code></p>';
        } else {
            echo '<p class="description">WP-Cron non planifié (il sera créé à la prochaine activation ou visite).</p>';
        }

        echo '</div>';
    }

    private static function readonly_row(string $label, string $value): void
    {
        echo '<tr><th scope="row">' . esc_html($label) . '</th><td>';
        echo '<input type="text" class="regular-text code" value="' . esc_attr($value) . '" readonly="readonly" />';
        echo '</td></tr>';
    }

    private static function badge_style(string $statusKey): string
    {
        return match ($statusKey) {
            'exists' => 'display:inline-block;padding:4px 10px;border-radius:999px;background:#dcfce7;color:#166534;font-weight:600;',
            'missing' => 'display:inline-block;padding:4px 10px;border-radius:999px;background:#fee2e2;color:#991b1b;font-weight:600;',
            default => 'display:inline-block;padding:4px 10px;border-radius:999px;background:#fef3c7;color:#92400e;font-weight:600;',
        };
    }

    private static function can_manage(): bool
    {
        return current_user_can('sosprescription_manage') || current_user_can('manage_options');
    }
}
