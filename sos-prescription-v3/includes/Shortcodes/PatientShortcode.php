<?php
declare(strict_types=1);

namespace SosPrescription\Shortcodes;

use SOSPrescription\Assets\Assets;
use SOSPrescription\Services\Logger;
use SOSPrescription\Services\Notices;

final class PatientShortcode
{
    private static function renderLoadingSkeleton(string $title, string $subtitle): string
    {
        return '<style id="sp-patient-skeleton-style">'
            . '@keyframes spPatientSkeletonPulse{0%,100%{opacity:1}50%{opacity:.52}}'
            . '.sp-patient-skeleton{max-width:980px;margin:14px auto;padding:22px;border:1px solid #e5e7eb;border-radius:18px;background:#fff;box-shadow:0 10px 30px rgba(15,23,42,.05);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}'
            . '.sp-patient-skeleton__stack{display:grid;gap:14px}'
            . '.sp-patient-skeleton__line,.sp-patient-skeleton__block{background:linear-gradient(90deg,#f1f5f9 25%,#e2e8f0 37%,#f1f5f9 63%);background-size:400% 100%;animation:spPatientSkeletonPulse 2s cubic-bezier(.4,0,.6,1) infinite;border-radius:999px}'
            . '.sp-patient-skeleton__title{height:22px;width:min(320px,58%)}'
            . '.sp-patient-skeleton__subtitle{height:14px;width:min(520px,84%)}'
            . '.sp-patient-skeleton__block{height:92px;border-radius:16px}'
            . '</style>'
            . '<div class="sp-patient-skeleton" aria-hidden="true">'
            . '  <div class="sp-patient-skeleton__stack">'
            . '    <div class="sp-patient-skeleton__line sp-patient-skeleton__title"></div>'
            . '    <div class="sp-patient-skeleton__line sp-patient-skeleton__subtitle"></div>'
            . '    <div class="sp-patient-skeleton__block"></div>'
            . '    <div class="sp-patient-skeleton__block"></div>'
            . '    <div class="sp-muted" style="font-size:13px;color:#64748b;">' . esc_html($title) . ' · ' . esc_html($subtitle) . '</div>'
            . '  </div>'
            . '</div>';
    }

    public static function register(): void
    {
        add_shortcode('sosprescription_patient', [self::class, 'render']);
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

        Assets::enqueue_form_app();

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
        $display_name = self::resolve_patient_display_name(get_current_user_id());

        $connected_badge = '<div class="sp-row sp-row-between" style="max-width:980px;margin:12px auto 0 auto;">'
            . '<div class="sp-badge sp-badge-success"><span class="sp-dot sp-dot-online" aria-hidden="true"></span> Connecté : ' . esc_html($display_name) . '</div>'
            . '</div>';

        return $notice
            . '<div class="sp-ui">'
            . $connected_badge
            . '  <div id="sp-patient-profile-root"></div>'
            . '  <div id="sp-error-surface-patient" class="sp-alert sp-alert-error" style="display:none" role="alert" aria-live="polite"></div>'
            . '  <div id="sosprescription-root-form" data-app="patient">'
            . self::renderLoadingSkeleton('Préparation de votre espace patient', 'Chargement sécurisé de vos demandes…')
            . '  </div>'
            . '</div>'
            . '<noscript>Activez JavaScript pour accéder à votre espace patient.</noscript>';
    }

    private static function resolve_patient_display_name(int $user_id): string
    {
        $first_name = $user_id > 0 ? trim((string) get_user_meta($user_id, 'first_name', true)) : '';
        $last_name = $user_id > 0 ? trim((string) get_user_meta($user_id, 'last_name', true)) : '';
        $full_name = trim($first_name . ' ' . $last_name);
        if ($full_name !== '') {
            return $full_name;
        }

        $user = wp_get_current_user();
        $display_name = ($user instanceof \WP_User) ? trim((string) $user->display_name) : '';
        if ($display_name !== '' && !is_email($display_name)) {
            return $display_name;
        }

        return 'Utilisateur';
    }
}
