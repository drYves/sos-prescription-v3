<?php
declare(strict_types=1);

namespace SOSPrescription\Admin;

use SOSPrescription\Services\NoticesConfig;
use SOSPrescription\Services\Audit;

final class NoticesPage
{
    public static function register_actions(): void
    {
        add_action('admin_post_sosprescription_notices_save', [self::class, 'handle_save']);
    }

    private static function can_manage(): bool
    {
        return current_user_can('sosprescription_manage') || current_user_can('manage_options');
    }

    public static function render_page(): void
    {
        if (!self::can_manage()) {
            wp_die('Accès refusé.');
        }

        $cfg = NoticesConfig::get();

        $updated = isset($_GET['updated']) && (string) $_GET['updated'] === '1';

        echo '<div class="wrap">';
        echo '<h1 style="display:flex; align-items:center; gap:10px;">';
        echo '<img src="' . esc_url(SOSPRESCRIPTION_URL . 'assets/caduceus.svg') . '" alt="" style="width:26px;height:26px;" />';
        echo '<span>Mentions patient (bandeau)</span>';
        echo '</h1>';

        echo '<p style="max-width:980px;">';
        echo 'Ce bandeau est affiché sur les interfaces patient (formulaire et/ou espace patient) pour clarifier le périmètre, les exclusions et la notion d\'urgence.';
        echo '</p>';

        if ($updated) {
            echo '<div class="notice notice-success is-dismissible"><p>Paramètres enregistrés.</p></div>';
        }

        echo '<div style="max-width:980px;background:#fff;border:1px solid #dcdcde;border-radius:12px;padding:16px;margin:14px 0;">';
        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        echo '<input type="hidden" name="action" value="sosprescription_notices_save" />';
        wp_nonce_field('sosprescription_notices_save');

        echo '<table class="form-table" role="presentation"><tbody>';

        echo '<tr><th scope="row">Afficher sur</th><td>';
        echo '<label style="display:block;margin-bottom:6px;"><input type="checkbox" name="enabled_form" value="1"' . (!empty($cfg['enabled_form']) ? ' checked' : '') . ' /> Formulaire patient</label>';
        echo '<label style="display:block;"><input type="checkbox" name="enabled_patient" value="1"' . (!empty($cfg['enabled_patient']) ? ' checked' : '') . ' /> Espace patient</label>';
        echo '</td></tr>';

        echo '<tr><th scope="row">Fermable</th><td>';
        echo '<label><input type="checkbox" name="dismissible" value="1"' . (!empty($cfg['dismissible']) ? ' checked' : '') . ' /> Autoriser la fermeture (mémorisée en localStorage)</label>';
        echo '</td></tr>';

        echo '<tr><th scope="row"><label for="sp_notice_title">Titre</label></th><td>';
        echo '<input type="text" class="regular-text" id="sp_notice_title" name="title" value="' . esc_attr((string) ($cfg['title'] ?? '')) . '" />';
        echo '</td></tr>';

        echo '<tr><th scope="row"><label for="sp_notice_items">Contenu (1 ligne = 1 puce)</label></th><td>';
        echo '<textarea id="sp_notice_items" name="items_text" rows="7" class="large-text code">' . esc_textarea((string) ($cfg['items_text'] ?? '')) . '</textarea>';
        echo '<p class="description">Vous pouvez inclure des liens HTML simples (&lt;a href=...&gt;).</p>';
        echo '</td></tr>';

        echo '</tbody></table>';

        echo '<p><button type="submit" class="button button-primary">Enregistrer</button></p>';
        echo '<p class="description">Dernière mise à jour : <code>' . esc_html((string) ($cfg['updated_at'] ?? '')) . '</code></p>';

        echo '</form>';
        echo '</div>';

        // Preview
        echo '<div style="max-width:980px;background:#fff;border:1px solid #dcdcde;border-radius:12px;padding:16px;margin:14px 0;">';
        echo '<h2 style="margin-top:0;">Aperçu</h2>';
        echo '<p class="description">Aperçu statique du bandeau (style front).</p>';

        // Enqueue notice CSS for preview in admin
        wp_enqueue_style('sosprescription-notices', SOSPRESCRIPTION_URL . 'assets/notices.css', [], SOSPRESCRIPTION_VERSION);

        $tmp = NoticesConfig::get();
        // Rendu via service (chargé côté front aussi)
        if (class_exists('SOSPrescription\\Services\\Notices')) {
            echo \SOSPrescription\Services\Notices::render('form');
        }
        echo '</div>';

        echo '</div>';
    }

    public static function handle_save(): void
    {
        if (!self::can_manage()) {
            wp_die('Accès refusé.');
        }

        check_admin_referer('sosprescription_notices_save');

        $fields = [];
        $fields['enabled_form'] = isset($_POST['enabled_form']) && (string) wp_unslash($_POST['enabled_form']) === '1';
        $fields['enabled_patient'] = isset($_POST['enabled_patient']) && (string) wp_unslash($_POST['enabled_patient']) === '1';
        $fields['dismissible'] = isset($_POST['dismissible']) && (string) wp_unslash($_POST['dismissible']) === '1';

        if (isset($_POST['title'])) {
            $fields['title'] = trim((string) wp_unslash($_POST['title']));
        }
        if (isset($_POST['items_text'])) {
            $fields['items_text'] = trim((string) wp_unslash($_POST['items_text']));
        }

        NoticesConfig::update($fields);

        Audit::log('config_update', 'notices', null, null, [
            'fields' => array_keys($fields),
        ]);

        $url = add_query_arg([
            'page' => 'sosprescription-notices',
            'updated' => '1',
        ], admin_url('admin.php'));

        wp_safe_redirect($url);
        exit;
    }
}
