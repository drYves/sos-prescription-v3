<?php

declare(strict_types=1);

namespace SosPrescription\Shortcodes;

use SOSPrescription\Assets\Assets;
use SOSPrescription\Services\Logger;
use SOSPrescription\UI\ScreenFrame;
use SosPrescription\UI\AuthMagicLinkUi;

final class PatientShortcode
{
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
            AuthMagicLinkUi::enqueue_assets();

            return AuthMagicLinkUi::render_patient_request_screen();
        }

        Assets::enqueue_form_app();

        wp_dequeue_script('sosprescription-patient-chat-enhancements');
        wp_dequeue_script('sosprescription-patient-profile-enhancements');

        $display_name = self::resolve_patient_display_name(get_current_user_id());
        $lock_icon = '<svg class="sp-lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';

        $toolbar = '<div class="sp-patient-session-bar">'
            . '<div class="sp-patient-session-bar__copy">'
            . '<span class="sp-patient-session-bar__eyebrow"><span class="sp-patient-session-bar__icon" aria-hidden="true">' . $lock_icon . '</span>Session sécurisée</span>'
            . '<span class="sp-patient-session-bar__identity">Connecté · ' . esc_html($display_name) . '</span>'
            . '</div>'
            . '<div class="sp-patient-session-bar__actions">'
            . self::render_logout_form()
            . '</div>'
            . '</div>';

        $content  = ScreenFrame::toolbarMeta('patient', $toolbar);
        $content .= ScreenFrame::statusSurface(
            'patient',
            '<div id="sp-error-surface-patient" class="sp-alert sp-alert--error" hidden role="alert" aria-live="polite"></div>'
        );
        $content .= ScreenFrame::mount(
            'patient',
            '<div id="sosprescription-root-form" class="sp-app-surface sp-app-surface--patient" data-app="patient" data-sp-surface="patient">'
            . ScreenFrame::loadingCard(
                'Préparation de votre espace patient',
                'Chargement sécurisé de vos demandes en cours…'
            )
            . '</div>'
        );

        return ScreenFrame::screen('patient', $content, [], ['sp-ui'])
            . '<noscript>Activez JavaScript pour accéder à votre espace patient.</noscript>';
    }

    private static function render_logout_form(): string
    {
        return LogoutShortcode::render([
            'class' => 'sp-button sp-button--secondary sp-patient-session-bar__logout-button',
            'form_class' => 'sp-form sp-logout-form sp-patient-session-bar__logout-form',
            'redirect' => home_url('/'),
        ]);
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
