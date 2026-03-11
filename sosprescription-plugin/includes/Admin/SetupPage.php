<?php
declare(strict_types=1);

namespace SosPrescription\Admin;

use SosPrescription\Services\Audit;
use SosPrescription\Services\ComplianceConfig;
use SosPrescription\Services\NotificationsConfig;
use SosPrescription\Services\Pricing;
use SosPrescription\Services\StripeConfig;
use SosPrescription\Services\Whitelist;

/**
 * Backoffice : écran d'installation / vérification.
 *
 * Objectifs :
 * - centraliser les réglages critiques (pages, paiements, notifications, conformité, périmètre),
 * - accélérer l'onboarding (création automatique de pages WordPress avec shortcodes),
 * - fournir un "go-live checklist" simple (sans se substituer au juridique / HDS).
 */
final class SetupPage
{
    private const OPTION_KEY = 'sosprescription_pages';

    public static function register_actions(): void
    {
        add_action('admin_post_sosprescription_setup_save', [self::class, 'handle_save']);
        add_action('admin_post_sosprescription_setup_create_pages', [self::class, 'handle_create_pages']);
    }

    private static function can_manage(): bool
    {
        return current_user_can('sosprescription_manage') || current_user_can('manage_options');
    }

    /**
     * @return array<string, mixed>
     */
    private static function get_pages_cfg(): array
    {
        $raw = get_option(self::OPTION_KEY, null);
        $cfg = is_array($raw) ? $raw : [];

        $notif = NotificationsConfig::get();

        return [
            'form_page_id' => isset($cfg['form_page_id']) ? (int) $cfg['form_page_id'] : 0,
            'doctor_account_page_id' => isset($cfg['doctor_account_page_id']) ? (int) $cfg['doctor_account_page_id'] : 0,
            'bdpm_table_page_id' => isset($cfg['bdpm_table_page_id']) ? (int) $cfg['bdpm_table_page_id'] : 0,

            // ces 2 champs sont stockés dans NotificationsConfig
            'patient_portal_page_id' => (int) ($notif['patient_portal_page_id'] ?? 0),
            'doctor_console_page_id' => (int) ($notif['doctor_console_page_id'] ?? 0),

            'updated_at' => isset($cfg['updated_at']) && is_string($cfg['updated_at']) ? (string) $cfg['updated_at'] : '',
        ];
    }

    /**
     * @param array<string, mixed> $patch
     */
    private static function update_pages_cfg(array $patch): void
    {
        $current = self::get_pages_cfg();

        $next = array_merge($current, $patch);
        $next['updated_at'] = current_time('mysql');

        // Sync NotificationsConfig
        $notif_patch = [];
        if (array_key_exists('patient_portal_page_id', $patch)) {
            $notif_patch['patient_portal_page_id'] = (int) $next['patient_portal_page_id'];
        }
        if (array_key_exists('doctor_console_page_id', $patch)) {
            $notif_patch['doctor_console_page_id'] = (int) $next['doctor_console_page_id'];
        }
        if (!empty($notif_patch)) {
            NotificationsConfig::update($notif_patch);
        }

        // Persist only fields owned by this option
        update_option(self::OPTION_KEY, [
            'form_page_id' => (int) $next['form_page_id'],
            'doctor_account_page_id' => (int) $next['doctor_account_page_id'],
            'bdpm_table_page_id' => (int) $next['bdpm_table_page_id'],
            'updated_at' => (string) $next['updated_at'],
        ], false);
    }

    /**
     * @return array<int, array{key:string,title:string,shortcode:string,slug:string,desc:string,protect:bool}>
     */
    private static function recommended_pages(): array
    {
        return [
            [
                'key' => 'form_page_id',
                'title' => 'Demande (formulaire patient)',
                'shortcode' => '[sosprescription_form]',
                'slug' => 'demande-ordonnance',
                'desc' => 'Création de demande + dépôt de preuves + paiement (autorisation).',
                'protect' => true,
            ],
            [
                'key' => 'patient_portal_page_id',
                'title' => 'Espace patient',
                'shortcode' => '[sosprescription_patient]',
                'slug' => 'espace-patient',
                'desc' => 'Suivi des demandes, messagerie, téléchargement ordonnance.',
                'protect' => true,
            ],
            [
                'key' => 'doctor_console_page_id',
                'title' => 'Console médecin',
                'shortcode' => '[sosprescription_admin]',
                'slug' => 'console-medecin',
                'desc' => 'Queue, dossier, messagerie, décision, génération PDF.',
                'protect' => true,
            ],
            [
                'key' => 'doctor_account_page_id',
                'title' => 'Compte médecin',
                'shortcode' => '[sosprescription_doctor_account]',
                'slug' => 'compte-medecin',
                'desc' => 'Profil (RPPS), informations pro, signature.',
                'protect' => true,
            ],
            [
                'key' => 'bdpm_table_page_id',
                'title' => 'Catalogue médicaments (optionnel)',
                'shortcode' => '[sosprescription_bdpm_table]',
                'slug' => 'catalogue-medicaments',
                'desc' => 'Table BDPM (debug / contrôle import).',
                'protect' => true,
            ],
        ];
    }

    /**
     * @param string $name
     * @param int $selected
     * @param array<int, \WP_Post> $pages
     */
    private static function render_page_select(string $name, int $selected, array $pages): void
    {
        echo '<select name="' . esc_attr($name) . '" style="min-width:320px;">';
        echo '<option value="0">— Non défini —</option>';
        foreach ($pages as $p) {
            $pid = (int) $p->ID;
            $label = (string) $p->post_title;
            if ($label === '') {
                $label = '(sans titre)';
            }
            $status = (string) $p->post_status;
            $suffix = $status !== 'publish' ? (' — ' . $status) : '';
            echo '<option value="' . esc_attr((string) $pid) . '" ' . selected($selected, $pid, false) . '>' . esc_html($label . $suffix) . ' (#' . $pid . ')</option>';
        }
        echo '</select>';
    }

    public static function render_page(): void
    {
        if (!self::can_manage()) {
            wp_die('Accès refusé.');
        }

        $cfg = self::get_pages_cfg();
        $pricing = Pricing::get();
        $stripe = StripeConfig::get();
        $notif = NotificationsConfig::get();
        $compliance = ComplianceConfig::get();
        $wl = Whitelist::get();

        $pages = get_pages([
            'sort_column' => 'post_title',
            'sort_order' => 'ASC',
            'post_status' => ['publish', 'draft'],
        ]);
        if (!is_array($pages)) {
            $pages = [];
        }

        $updated = isset($_GET['updated']) && (string) $_GET['updated'] === '1';
        $created = isset($_GET['created']) && (string) $_GET['created'] === '1';
        $error = isset($_GET['error']) ? sanitize_text_field((string) $_GET['error']) : '';

        echo '<div class="wrap">';
        echo '<h1 style="display:flex; align-items:center; gap:10px;">';
        echo '<img src="' . esc_url(SOSPRESCRIPTION_URL . 'assets/caduceus.svg') . '" alt="" style="width:26px;height:26px;" />';
        echo '<span>Installation & statut</span>';
        if (defined('SOSPRESCRIPTION_VERSION')) {
            echo '<span style="margin-left:6px; padding:2px 8px; border-radius:999px; border:1px solid #dcdcde; background:#f6f7f7; color:#646970; font-size:12px;">v' . esc_html((string) SOSPRESCRIPTION_VERSION) . '</span>';
        }
        echo '</h1>';

        echo '<p style="max-width:980px;">'
            . 'Cet écran regroupe les réglages essentiels et une checklist avant mise en production. '
            . 'Il ne remplace pas les obligations réglementaires (HDS, RGPD, déontologie), mais aide à éviter les oublis.'
            . '</p>';

        if ($updated) {
            echo '<div class="notice notice-success is-dismissible"><p>Configuration enregistrée.</p></div>';
        }
        if ($created) {
            echo '<div class="notice notice-success is-dismissible"><p>Pages créées / mises à jour.</p></div>';
        }
        if ($error !== '') {
            echo '<div class="notice notice-error"><p>' . esc_html($error) . '</p></div>';
        }

        // --- Pages / Shortcodes
        echo '<div style="max-width:980px;background:#fff;border:1px solid #dcdcde;border-radius:12px;padding:16px;margin:14px 0;">';
        echo '<h2 style="margin-top:0;">Pages WordPress & shortcodes</h2>';
        echo '<p class="description">Assignez une page à chaque interface. Le plugin peut aussi créer les pages recommandées automatiquement.</p>';

        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        echo '<input type="hidden" name="action" value="sosprescription_setup_save" />';
        wp_nonce_field('sosprescription_setup_save');

        echo '<table class="widefat striped" style="margin-top:10px;">';
        echo '<thead><tr><th>Interface</th><th>Page</th><th>Shortcode</th><th>Slug conseillé</th><th>Statut</th></tr></thead><tbody>';

        foreach (self::recommended_pages() as $rp) {
            $key = $rp['key'];
            $page_id = isset($cfg[$key]) ? (int) $cfg[$key] : 0;
            $sc = (string) $rp['shortcode'];
            $slug = (string) $rp['slug'];

            $post = $page_id > 0 ? get_post($page_id) : null;
            $ok = false;
            if ($post && isset($post->post_content)) {
                // extrait le nom du shortcode (sans crochets)
                $sc_name = trim($sc, '[]');
                $ok = has_shortcode((string) $post->post_content, $sc_name);
            }

            $status_badge = $ok ? '✅ OK' : ($page_id > 0 ? '⚠️ Shortcode absent' : '❌ Non défini');

            echo '<tr>';
            echo '<td><strong>' . esc_html((string) $rp['title']) . '</strong><br/><span class="description">' . esc_html((string) $rp['desc']) . '</span></td>';
            echo '<td>';
            self::render_page_select($key, $page_id, $pages);
            if ($page_id > 0) {
                $edit = get_edit_post_link($page_id);
                $view = get_permalink($page_id);
                if (is_string($edit) && $edit !== '') {
                    echo '<div style="margin-top:6px;"><a href="' . esc_url($edit) . '">Éditer</a>';
                    if (is_string($view) && $view !== '') {
                        echo ' • <a href="' . esc_url($view) . '" target="_blank" rel="noopener">Voir</a>';
                    }
                    echo '</div>';
                }
            }
            echo '</td>';
            echo '<td><code>' . esc_html($sc) . '</code></td>';
            echo '<td><code>' . esc_html($slug) . '</code></td>';
            echo '<td>' . esc_html($status_badge) . '</td>';
            echo '</tr>';
        }

        echo '</tbody></table>';

        $purge_on_uninstall = get_option('sosprescription_purge_on_uninstall', 'no') === 'yes';

        echo '<h2 style="margin-top:18px;">Maintenance &amp; sécurité</h2>';
        echo '<div class="notice notice-info" style="padding:12px; margin:12px 0;">';
        echo '<p><strong>Important :</strong> si vous mettez à jour le plugin en le supprimant puis en le réinstallant, WordPress déclenche une désinstallation. Par défaut, SOS Prescription <strong>conserve</strong> vos données (demandes, signatures, templates) pour éviter toute perte.</p>';
        echo '</div>';

        echo '<label style="display:block; margin:8px 0;">';
        echo '<input type="checkbox" name="purge_on_uninstall" value="1" ' . checked($purge_on_uninstall, true, false) . '/> ';
        echo '<strong>Purger toutes les données lors de la suppression du plugin</strong> (tables, options) — <span style="color:#b91c1c">irréversible</span>';
        echo '</label>';

        echo '<p style="margin:14px 0 0;">'
            . '<button type="submit" class="button button-primary">Enregistrer</button>'
            . '</p>';

        echo '</form>';

        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '" style="margin-top:12px;">';
        echo '<input type="hidden" name="action" value="sosprescription_setup_create_pages" />';
        wp_nonce_field('sosprescription_setup_create_pages');
        echo '<button type="submit" class="button">Créer / réparer les pages recommandées</button>';
        echo '<p class="description" style="margin-top:8px;">Crée les pages manquantes (ou ré-assigne si non défini) avec le contenu du shortcode.</p>';
        echo '</form>';

        echo '</div>';

        // --- Checklist rapide
        echo '<div style="max-width:980px;background:#fff;border:1px solid #dcdcde;border-radius:12px;padding:16px;margin:14px 0;">';
        echo '<h2 style="margin-top:0;">Checklist technique (rapide)</h2>';

        $stripe_ok = (bool) ($stripe['enabled'] ?? false) && (string) ($stripe['publishable_key'] ?? '') !== '' && (string) ($stripe['secret_key'] ?? '') !== '';
        $pricing_ok = (int) ($pricing['standard_cents'] ?? 0) >= 50;
        $wl_mode = (string) ($wl['mode'] ?? 'off');
        $wl_ok = $wl_mode === 'enforce' || $wl_mode === 'warn' || $wl_mode === 'off';
        $consent_required = (bool) ($compliance['consent_required'] ?? true);
        $cgu_ok = !$consent_required || ((string) ($compliance['cgu_url'] ?? '') !== '');
        $privacy_ok = !$consent_required || ((string) ($compliance['privacy_url'] ?? '') !== '');

        // Turnstile est maintenant intégré directement au plugin principal (pas de MU-Plugins requis).
        $turnstile_integrated = function_exists('sosprescription_turnstile_enqueue');
        $turnstile_keys_ok = defined('SOSPRESCRIPTION_TURNSTILE_SITE_KEY') && (string) constant('SOSPRESCRIPTION_TURNSTILE_SITE_KEY') !== '' && defined('SOSPRESCRIPTION_TURNSTILE_SECRET_KEY') && (string) constant('SOSPRESCRIPTION_TURNSTILE_SECRET_KEY') !== '';

        echo '<table class="widefat striped" style="margin-top:10px;">';
        echo '<thead><tr><th>Point</th><th>Statut</th><th>Détails</th></tr></thead><tbody>';

        echo '<tr><td><strong>Paiement (Stripe)</strong></td><td>' . ($stripe_ok ? '✅ OK' : '⚠️ À configurer') . '</td><td>';
        echo 'Mode : <code>' . esc_html(((bool) ($stripe['enabled'] ?? false)) ? 'enabled' : 'disabled') . '</code> • Webhook secret : ' . (((string) ($stripe['webhook_secret'] ?? '')) !== '' ? '✅' : '⚠️ manquant');
        echo '</td></tr>';

        echo '<tr><td><strong>Tarifs</strong></td><td>' . ($pricing_ok ? '✅ OK' : '⚠️ À vérifier') . '</td><td>';
        echo 'Standard : <code>' . esc_html(number_format_i18n(((int) ($pricing['standard_cents'] ?? 0)) / 100, 2)) . ' ' . esc_html((string) ($pricing['currency'] ?? 'EUR')) . '</code> • Express : <code>' . esc_html(number_format_i18n(((int) ($pricing['express_cents'] ?? 0)) / 100, 2)) . ' ' . esc_html((string) ($pricing['currency'] ?? 'EUR')) . '</code>';
        echo '</td></tr>';

        echo '<tr><td><strong>Périmètre (whitelist)</strong></td><td>' . ($wl_ok ? '✅ OK' : '⚠️') . '</td><td>';
        echo 'Mode : <code>' . esc_html($wl_mode) . '</code> • Preuve obligatoire : ' . (((bool) ($wl['require_evidence'] ?? false)) ? '✅' : '⚠️ (recommandé)');
        echo '</td></tr>';

        echo '<tr><td><strong>Notifications</strong></td><td>' . (((bool) ($notif['email_enabled'] ?? true)) ? '✅ Email ON' : '⚠️ Email OFF') . '</td><td>';
        echo 'From : <code>' . esc_html((string) ($notif['from_name'] ?? '')) . ' &lt;' . esc_html((string) ($notif['from_email'] ?? '')) . '&gt;</code> • SMS : ' . (((bool) ($notif['sms_enabled'] ?? false)) ? 'ON' : 'OFF');
        echo '</td></tr>';

        echo '<tr><td><strong>Anti-bot (Turnstile)</strong></td><td>' . (($turnstile_integrated && $turnstile_keys_ok) ? '✅ OK' : '⚠️ À configurer') . '</td><td>';
        echo 'Intégré : ' . ($turnstile_integrated ? '✅' : '⚠️') . ' • Clés (site+secret) : ' . ($turnstile_keys_ok ? '✅' : '⚠️ manquantes');
        echo '</td></tr>';

        echo '<tr><td><strong>Consentement & liens</strong></td><td>' . (($cgu_ok && $privacy_ok) ? '✅ OK' : '⚠️ À compléter') . '</td><td>';
        echo 'Consentement requis : <code>' . ($consent_required ? 'yes' : 'no') . '</code> • CGU : ' . ($cgu_ok ? '✅' : '⚠️') . ' • Confidentialité : ' . ($privacy_ok ? '✅' : '⚠️');
        echo '</td></tr>';

        echo '</tbody></table>';

        echo '<p class="description" style="margin-top:10px;">'
            . 'À prévoir hors plugin : hébergeur HDS, registre RGPD/DPO, politique de conservation, procédures support, vérification Ordre/RPPS, etc.'
            . '</p>';

        echo '</div>';

        echo '</div>';
    }

    public static function handle_save(): void
    {
        if (!self::can_manage()) {
            wp_die('Accès refusé.');
        }
        check_admin_referer('sosprescription_setup_save');

        $patch = [];
        foreach (self::recommended_pages() as $rp) {
            $key = (string) $rp['key'];
            $val = isset($_POST[$key]) ? (int) wp_unslash($_POST[$key]) : 0;
            if ($val < 0) {
                $val = 0;
            }
            $patch[$key] = $val;
        }

        self::update_pages_cfg($patch);

        Audit::log('config_setup_pages_update', 'config', null, null, [
            'keys' => array_keys($patch),
        ]);

        // Sécurité / maintenance : purge complète à la suppression du plugin (décoché par défaut).
        $purge_on_uninstall = isset($_POST['purge_on_uninstall']) ? 'yes' : 'no';
        update_option('sosprescription_purge_on_uninstall', $purge_on_uninstall, false);

        Audit::log('config_uninstall_purge_update', 'config', null, null, [
            'purge_on_uninstall' => $purge_on_uninstall,
        ]);

        $url = add_query_arg([
            'page' => 'sosprescription',
            'updated' => '1',
        ], admin_url('admin.php'));
        wp_safe_redirect($url);
        exit;
    }

    public static function handle_create_pages(): void
    {
        if (!self::can_manage()) {
            wp_die('Accès refusé.');
        }
        check_admin_referer('sosprescription_setup_create_pages');

        $cfg = self::get_pages_cfg();

        $created_ids = [];
        $patch = [];

        foreach (self::recommended_pages() as $rp) {
            $key = (string) $rp['key'];
            $page_id = isset($cfg[$key]) ? (int) $cfg[$key] : 0;
            if ($page_id > 0 && get_post($page_id)) {
                continue;
            }

            $title = (string) $rp['title'];
            $content = (string) $rp['shortcode'];
            $slug = (string) $rp['slug'];

            $new_id = wp_insert_post([
                'post_type' => 'page',
                'post_status' => 'publish',
                'post_title' => $title,
                'post_content' => $content,
                'post_name' => $slug,
            ], true);

            if (is_wp_error($new_id)) {
                $url = add_query_arg([
                    'page' => 'sosprescription',
                    'error' => rawurlencode('Création page impossible : ' . $new_id->get_error_message()),
                ], admin_url('admin.php'));
                wp_safe_redirect($url);
                exit;
            }

            $created_ids[] = (int) $new_id;
            $patch[$key] = (int) $new_id;
        }

        if (!empty($patch)) {
            self::update_pages_cfg($patch);
        }

        Audit::log('setup_pages_create', 'config', null, null, [
            'created_count' => count($created_ids),
            'created_ids' => $created_ids,
        ]);

        $url = add_query_arg([
            'page' => 'sosprescription',
            'created' => '1',
        ], admin_url('admin.php'));
        wp_safe_redirect($url);
        exit;
    }
}
