<?php
declare(strict_types=1);

namespace SOSPrescription\Shortcodes;

use SOSPrescription\Assets;
use SOSPrescription\Services\Logger;
use SOSPrescription\Services\Notices;
use SOSPrescription\Utils\Date;

final class PatientShortcode
{
    public static function register(): void
    {
        add_shortcode('sosprescription_patient', [self::class, 'render']);

        // Update profile (logged-in only)
        add_action('admin_post_sosprescription_patient_profile_update', [self::class, 'handle_profile_post']);
    }

    public static function handle_profile_post(): void
    {
        if (!is_user_logged_in()) {
            wp_die('Connexion requise.');
        }

        check_admin_referer('sosprescription_patient_profile', 'sp_profile_nonce');

        $user_id = get_current_user_id();

        $birth_raw = isset($_POST['sp_birthdate']) ? (string) $_POST['sp_birthdate'] : '';
        $birth_raw = trim(wp_unslash($birth_raw));
        $birth_iso = $birth_raw !== '' ? (Date::normalize_birthdate($birth_raw) ?? '') : '';
        $birth_precision = Date::birthdate_precision($birth_raw);

        $weight_raw = isset($_POST['sp_weight_kg']) ? (string) $_POST['sp_weight_kg'] : '';
        $weight_raw = trim(wp_unslash($weight_raw));

        $height_raw = isset($_POST['sp_height_cm']) ? (string) $_POST['sp_height_cm'] : '';
        $height_raw = trim(wp_unslash($height_raw));

        $errors = [];

        if ($birth_raw !== '' && $birth_iso === '') {
            $errors[] = 'Date de naissance invalide (format attendu : JJ/MM/AAAA).';
        }

        $weight = null;
        if ($weight_raw !== '') {
            $weight = (float) str_replace(',', '.', $weight_raw);
            if ($weight <= 0 || $weight > 400) {
                $errors[] = 'Poids invalide.';
            }
        }

        $height = null;
        if ($height_raw !== '') {
            $height = (float) str_replace(',', '.', $height_raw);
            if ($height < 40 || $height > 260) {
                $errors[] = 'Taille invalide.';
            }
        }

        // Persist
        if (count($errors) === 0) {
            if ($birth_iso !== '') {
                update_user_meta($user_id, 'sosp_birthdate', $birth_iso);
                update_user_meta($user_id, 'sosp_birthdate_precision', $birth_precision);
            } else {
                delete_user_meta($user_id, 'sosp_birthdate');
                delete_user_meta($user_id, 'sosp_birthdate_precision');
            }

            if ($weight !== null) {
                update_user_meta($user_id, 'sosp_weight_kg', (string) $weight);
            } else {
                delete_user_meta($user_id, 'sosp_weight_kg');
            }

            if ($height !== null) {
                update_user_meta($user_id, 'sosp_height_cm', (string) $height);
            } else {
                delete_user_meta($user_id, 'sosp_height_cm');
            }
        }

        // Redirect back
        $referer = wp_get_referer();
        if (!is_string($referer) || $referer === '') {
            $referer = home_url('/');
        }

        $url = remove_query_arg(['sp_profile_updated', 'sp_profile_error'], $referer);
        if (count($errors) === 0) {
            $url = add_query_arg('sp_profile_updated', '1', $url);
        } else {
            $url = add_query_arg('sp_profile_error', rawurlencode(implode(' ', $errors)), $url);
        }

        wp_safe_redirect($url);
        exit;
    }

    /**
     * @param array<string, mixed> $atts
     */
    public static function render(array $atts = []): string
    {
        Logger::log_shortcode('sosprescription_patient', 'info', 'shortcode_render', [
            'atts_count' => count($atts),
        ]);

        if (!is_user_logged_in()) {
            $redirect = is_singular() ? (string) get_permalink() : (string) home_url('/');
            $login_url = (string) apply_filters('sosprescription_login_url', wp_login_url($redirect), $redirect);
            $register_url = (string) apply_filters('sosprescription_register_url', function_exists('wp_registration_url') ? wp_registration_url() : '', $redirect);

            return '<div class="sosprescription-guard" style="max-width:900px;margin:12px auto;padding:16px;border:1px solid #e5e7eb;background:#fff;border-radius:12px;">'
                . '<h3 style="margin:0 0 8px 0;">Connexion requise</h3>'
                . '<p style="margin:0 0 10px 0;">Merci de vous connecter pour accéder à votre espace patient.</p>'
                . '<p style="margin:0;display:flex;gap:10px;flex-wrap:wrap;">'
                . '<a class="button button-primary" href="' . esc_url($login_url) . '">Se connecter</a>'
                . ($register_url !== '' ? '<a class="button" href="' . esc_url($register_url) . '">Créer un compte</a>' : '')
                . '</p>'
                . '</div>';
        }

        // On réutilise le même bundle Vite que le formulaire.
        // L'app React choisit la vue selon data-app="patient".
        Assets::enqueue_frontend('form');

        // UI premium (messagerie): icônes SVG + layout stable en colonne étroite
        if (defined('SOSPRESCRIPTION_URL') && defined('SOSPRESCRIPTION_VERSION')) {
            wp_enqueue_script(
                'sosprescription-patient-chat-enhancements',
                SOSPRESCRIPTION_URL . 'assets/patient-chat-enhancements.js',
                [],
                SOSPRESCRIPTION_VERSION,
                true
            );
        }

        $notice = Notices::render('patient');

        $user = wp_get_current_user();
        $display_name = is_object($user) ? trim((string) $user->display_name) : '';
        if ($display_name === '') {
            $display_name = 'Utilisateur';
        }
        $connected_badge = '<div class="sp-row sp-row-between" style="max-width:980px;margin:12px auto 0 auto;">'
            . '<div class="sp-badge sp-badge-success"><span class="sp-dot sp-dot-online" aria-hidden="true"></span> Connecté : ' . esc_html($display_name) . '</div>'
            . '</div>';

        $user_id = get_current_user_id();

        $birth_iso = (string) get_user_meta($user_id, 'sosp_birthdate', true);
        $weight_kg = (string) get_user_meta($user_id, 'sosp_weight_kg', true);
        $height_cm = (string) get_user_meta($user_id, 'sosp_height_cm', true);

        $age_label = $birth_iso !== '' ? Date::age_label($birth_iso) : '—';
        $bmi_label = Date::bmi_label($weight_kg, $height_cm);

        $flash = '';
        if (isset($_GET['sp_profile_updated']) && (string) $_GET['sp_profile_updated'] === '1') {
            $flash = '<div class="sp-flash sp-flash--success">Profil mis à jour.</div>';
        } elseif (isset($_GET['sp_profile_error']) && (string) $_GET['sp_profile_error'] !== '') {
            $msg = (string) $_GET['sp_profile_error'];
            $flash = '<div class="sp-flash sp-flash--error">' . esc_html($msg) . '</div>';
        }

        // For display, prefer FR format
        $birth_fr = $birth_iso !== '' ? Date::iso_to_fr($birth_iso) : '';

        $profile = '';
        $profile .= '<div class="sp-profile-card">'
            . '<div class="sp-profile-card__header">'
            . '  <div class="sp-profile-card__title">Mes données patient</div>'
            . '  <div class="sp-profile-card__meta">Âge : <strong>' . esc_html($age_label) . '</strong> · IMC : <strong>' . esc_html($bmi_label) . '</strong></div>'
            . '</div>'
            . $flash
            . '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">' 
            . '  <input type="hidden" name="action" value="sosprescription_patient_profile_update" />'
            . wp_nonce_field('sosprescription_patient_profile', 'sp_profile_nonce', true, false)
            . '  <div class="sp-profile-grid">'
            . '    <label class="sp-field"><span>Date de naissance</span><input type="text" name="sp_birthdate" placeholder="JJ/MM/AAAA" value="' . esc_attr($birth_fr) . '" /></label>'
            . '    <label class="sp-field"><span>Poids (kg)</span><input type="text" name="sp_weight_kg" inputmode="decimal" placeholder="ex: 72.5" value="' . esc_attr($weight_kg) . '" /></label>'
            . '    <label class="sp-field"><span>Taille (cm)</span><input type="text" name="sp_height_cm" inputmode="decimal" placeholder="ex: 175" value="' . esc_attr($height_cm) . '" /></label>'
            . '  </div>'
            . '  <div class="sp-profile-actions"><button class="sp-btn sp-btn--primary" type="submit">Enregistrer</button></div>'
            . '</form>'
            . '<div class="sp-profile-hint">La date de naissance est une donnée de sécurité. L\'âge est recalculé à chaque ouverture.</div>'
            . '</div>';

        return $notice
            . $profile
            . '<div class="sp-ui">'
            . $connected_badge
            . '  <div id="sp-error-surface-patient" class="sp-alert sp-alert-error" style="display:none" role="alert" aria-live="polite"></div>'
            . '  <div id="sosprescription-root-form" data-app="patient">'
            . '    <div class="sp-card">'
            . '      <div class="sp-card-title">Chargement de votre espace patient…</div>'
            . '      <div class="sp-muted">Si cette page reste bloquée, vérifiez votre connexion et réessayez.</div>'
            . '    </div>'
            . '  </div>'
            . '</div>'
            . '<noscript>Activez JavaScript pour accéder à votre espace patient.</noscript>';
    }
}
