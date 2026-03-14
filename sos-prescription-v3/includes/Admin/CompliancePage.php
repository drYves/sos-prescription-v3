<?php
declare(strict_types=1);

namespace SosPrescription\Admin;

use SosPrescription\Services\ComplianceConfig;
use SosPrescription\Services\Retention;
use SosPrescription\Services\Audit;

final class CompliancePage
{
    public static function register_actions(): void
    {
        add_action('admin_post_sosprescription_compliance_save', [self::class, 'handle_save']);
        add_action('admin_post_sosprescription_compliance_run_retention', [self::class, 'handle_run_retention']);
    }

    public static function render_page(): void
    {
        if (!current_user_can('sosprescription_manage') && !current_user_can('manage_options')) {
            wp_die('Accès refusé.');
        }

        $cfg = ComplianceConfig::get();

        $updated = isset($_GET['updated']) && (string) $_GET['updated'] === '1';
        $ran = isset($_GET['ran']) && (string) $_GET['ran'] === '1';

        $audit_purged = isset($_GET['audit_purged']) ? (int) $_GET['audit_purged'] : null;
        $orphans_purged = isset($_GET['orphans_purged']) ? (int) $_GET['orphans_purged'] : null;

        echo '<div class="wrap">';
        echo '<h1 style="display:flex; align-items:center; gap:10px;">';
        echo '<img src="' . esc_url(SOSPRESCRIPTION_URL . 'assets/caduceus.svg') . '" alt="" style="width:26px;height:26px;" />';
        echo '<span>Conformité &amp; Sécurité (MVP)</span>';
        echo '</h1>';

        echo '<p style="max-width:980px;">Paramètres techniques pour renforcer la traçabilité (consentement versionné, journal d\'audit) et mettre en place des purges de données orphelines. <strong>NB</strong> : cela ne remplace pas une analyse juridique complète (HDS, PSSI, politique de conservation, etc.).</p>';

        if ($updated) {
            echo '<div class="notice notice-success is-dismissible"><p>Paramètres enregistrés.</p></div>';
        }
        if ($ran) {
            $msg = 'Routine de rétention exécutée.';
            if ($audit_purged !== null || $orphans_purged !== null) {
                $msg .= ' Audit purgé: ' . (int) ($audit_purged ?? 0) . ' ; fichiers orphelins purgés: ' . (int) ($orphans_purged ?? 0) . '.';
            }
            echo '<div class="notice notice-info is-dismissible"><p>' . esc_html($msg) . '</p></div>';
        }

        // --- Consentement
        echo '<div style="max-width:980px;background:#fff;border:1px solid #dcdcde;border-radius:12px;padding:16px;margin:14px 0;">';
        echo '<h2>Consentement explicite</h2>';
        echo '<p class="description">Le patient doit accepter explicitement l\'évaluation médicale asynchrone et les documents légaux. Les versions permettent de tracer ce qui a été accepté.</p>';

        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        echo '<input type="hidden" name="action" value="sosprescription_compliance_save" />';
        wp_nonce_field('sosprescription_compliance_save');

        echo '<table class="form-table" role="presentation"><tbody>';

        echo '<tr><th scope="row">Consentement requis</th><td>';
        echo '<label><input type="checkbox" name="consent_required" value="1"' . (!empty($cfg['consent_required']) ? ' checked' : '') . ' /> Oui (recommandé)</label>';
        echo '</td></tr>';

        echo '<tr><th scope="row"><label for="sp_cgu_url">URL CGU</label></th><td>';
        echo '<input type="text" class="regular-text" id="sp_cgu_url" name="cgu_url" value="' . esc_attr((string) $cfg['cgu_url']) . '" />';
        echo '<p class="description">Lien vers vos Conditions Générales / Information patient.</p>';
        echo '</td></tr>';

        echo '<tr><th scope="row"><label for="sp_privacy_url">URL Confidentialité</label></th><td>';
        echo '<input type="text" class="regular-text" id="sp_privacy_url" name="privacy_url" value="' . esc_attr((string) $cfg['privacy_url']) . '" />';
        echo '<p class="description">Lien vers votre Politique de confidentialité / données de santé.</p>';
        echo '</td></tr>';

        echo '<tr><th scope="row"><label for="sp_cgu_ver">Version CGU</label></th><td>';
        echo '<input type="text" class="regular-text" id="sp_cgu_ver" name="cgu_version" value="' . esc_attr((string) $cfg['cgu_version']) . '" placeholder="ex: 2026-01" />';
        echo '</td></tr>';

        echo '<tr><th scope="row"><label for="sp_priv_ver">Version Confidentialité</label></th><td>';
        echo '<input type="text" class="regular-text" id="sp_priv_ver" name="privacy_version" value="' . esc_attr((string) $cfg['privacy_version']) . '" placeholder="ex: 2026-01" />';
        echo '</td></tr>';

        echo '</tbody></table>';

        echo '<p><button type="submit" class="button button-primary">Enregistrer</button></p>';
        echo '<p class="description">Dernière mise à jour : <code>' . esc_html((string) $cfg['updated_at']) . '</code></p>';

        echo '</form>';
        echo '</div>';

        // --- Rétention
        echo '<div style="max-width:980px;background:#fff;border:1px solid #dcdcde;border-radius:12px;padding:16px;margin:14px 0;">';
        echo '<h2>Rétention &amp; purge technique</h2>';
        echo '<p class="description">Purge quotidienne via WP-Cron. Ne supprime pas les demandes traitées/archivées. Concerne surtout les logs d\'audit et les fichiers uploadés mais jamais rattachés.</p>';

        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        echo '<input type="hidden" name="action" value="sosprescription_compliance_save" />';
        wp_nonce_field('sosprescription_compliance_save');

        echo '<table class="form-table" role="presentation"><tbody>';

        echo '<tr><th scope="row">Audit log</th><td>';
        echo '<label><input type="checkbox" name="audit_purge_enabled" value="1"' . (!empty($cfg['audit_purge_enabled']) ? ' checked' : '') . ' /> Purge activée</label><br/>';
        echo '<input type="number" name="audit_retention_days" value="' . esc_attr((string) $cfg['audit_retention_days']) . '" min="1" style="width:120px;" /> jours';
        echo '<p class="description">Par défaut 10 ans (3650 jours).</p>';
        echo '</td></tr>';

        echo '<tr><th scope="row">Fichiers orphelins</th><td>';
        echo '<label><input type="checkbox" name="orphan_files_purge_enabled" value="1"' . (!empty($cfg['orphan_files_purge_enabled']) ? ' checked' : '') . ' /> Purge activée</label><br/>';
        echo '<input type="number" name="orphan_files_retention_days" value="' . esc_attr((string) $cfg['orphan_files_retention_days']) . '" min="1" style="width:120px;" /> jours';
        echo '<p class="description">Utile pour supprimer les pièces uploadées mais jamais rattachées à une demande (abandons).</p>';
        echo '</td></tr>';

        echo '</tbody></table>';

        echo '<p><button type="submit" class="button">Enregistrer rétention</button></p>';
        echo '</form>';

        // Run retention
        echo '<hr/>';
        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        echo '<input type="hidden" name="action" value="sosprescription_compliance_run_retention" />';
        wp_nonce_field('sosprescription_compliance_run_retention');
        echo '<p><button type="submit" class="button button-secondary">Exécuter la purge maintenant</button></p>';
        echo '</form>';

        $next = wp_next_scheduled(Retention::CRON_HOOK);
        if ($next) {
            echo '<p class="description">Prochaine exécution WP-Cron : <code>' . esc_html(gmdate('Y-m-d H:i:s', (int) $next)) . ' UTC</code></p>';
        } else {
            echo '<p class="description">WP-Cron non planifié (il sera créé à la prochaine activation/visite).</p>';
        }

        echo '</div>';

        echo '</div>';
    }

    public static function handle_save(): void
    {
        if (!current_user_can('sosprescription_manage') && !current_user_can('manage_options')) {
            wp_die('Accès refusé.');
        }

        check_admin_referer('sosprescription_compliance_save');

        $fields = [];

        $fields['consent_required'] = isset($_POST['consent_required']) && (string) wp_unslash($_POST['consent_required']) === '1';

        foreach (['cgu_url', 'privacy_url', 'cgu_version', 'privacy_version'] as $k) {
            if (isset($_POST[$k])) {
                $fields[$k] = trim((string) wp_unslash($_POST[$k]));
            }
        }

        // Rétention
        $fields['audit_purge_enabled'] = isset($_POST['audit_purge_enabled']) && (string) wp_unslash($_POST['audit_purge_enabled']) === '1';
        $fields['orphan_files_purge_enabled'] = isset($_POST['orphan_files_purge_enabled']) && (string) wp_unslash($_POST['orphan_files_purge_enabled']) === '1';

        if (isset($_POST['audit_retention_days'])) {
            $fields['audit_retention_days'] = max(1, (int) wp_unslash($_POST['audit_retention_days']));
        }
        if (isset($_POST['orphan_files_retention_days'])) {
            $fields['orphan_files_retention_days'] = max(1, (int) wp_unslash($_POST['orphan_files_retention_days']));
        }

        ComplianceConfig::update($fields);

        // Audit
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

    public static function handle_run_retention(): void
    {
        if (!current_user_can('sosprescription_manage') && !current_user_can('manage_options')) {
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
}
