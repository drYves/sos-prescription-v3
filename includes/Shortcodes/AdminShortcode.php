<?php

declare(strict_types=1);

namespace SosPrescription\Shortcodes;

use SosPrescription\Assets;
use SosPrescription\Services\Logger;
use SOSPrescription\UI\ScreenFrame;
use SosPrescription\UI\AuthMagicLinkUi;

final class AdminShortcode
{
    public static function register(): void
    {
        add_shortcode('sosprescription_admin', [self::class, 'render']);
    }

    /**
     * @param array<string, mixed> $atts
     */
    public static function render(array $atts = []): string
    {
        Logger::log_shortcode('sosprescription_admin', 'info', 'shortcode_render', [
            'atts_count' => count($atts),
        ]);

        if (!is_user_logged_in()) {
            AuthMagicLinkUi::enqueue_assets();

            return AuthMagicLinkUi::render_request_screen(
                'doctor',
                'Connexion médecin',
                'Saisissez votre adresse e-mail professionnelle pour recevoir un lien de connexion sécurisé vers la console médecin.'
            );
        }

        if (!current_user_can('sosprescription_validate') && !current_user_can('sosprescription_manage') && !current_user_can('manage_options')) {
            return ScreenFrame::guard(
                'console',
                'access',
                'Accès réservé',
                'Cette page est réservée aux médecins et administrateurs de la plateforme.'
            );
        }

        // Console médecin (vanilla JS) : évite de dépendre d'un build React.
        Assets::enqueue('doctor_console');

        $user = wp_get_current_user();
        $display_name = is_object($user) ? trim((string) $user->display_name) : '';
        if ($display_name === '') {
            $display_name = 'Utilisateur';
        }

        $title_meta = is_object($user) ? (string) get_user_meta((int) $user->ID, 'sosprescription_doctor_title', true) : '';
        $title_meta = strtolower(trim($title_meta));
        $title_prefix = '';
        if ($title_meta === 'professeur') {
            $title_prefix = 'Pr';
        } elseif ($title_meta === 'docteur') {
            $title_prefix = 'Dr';
        }
        $connected_label = trim($title_prefix . ' ' . $display_name);

        $toolbar = '<div class="sp-card">'
            . '<div class="sp-stack">'
            . ScreenFrame::badge('Connecté : ' . $connected_label, 'success', true)
            . self::render_logout_form()
            . '</div>'
            . '</div>';

        $content  = ScreenFrame::toolbarMeta('console', $toolbar);
        $content .= ScreenFrame::statusSurface(
            'console',
            '<div class="sp-alert sp-alert--info" role="status" aria-live="polite">'
            . '<p class="sp-alert__title">Console médecin</p>'
            . '<p class="sp-alert__body">Accédez à vos dossiers patients et à vos actions de validation en session sécurisée.</p>'
            . '</div>'
        );
        $content .= ScreenFrame::mount(
            'console',
            '<div id="sosprescription-doctor-console-root" class="sosprescription-doctor sp-ui" data-sp-screen="console">'
            . ScreenFrame::loadingCard(
                'Chargement de la console médecin…',
                'Si l’interface reste bloquée, vérifiez les logs 403/500 éventuels puis rafraîchissez la page.'
            )
            . '</div>'
        );

        return ScreenFrame::screen('console', $content, [], ['sp-ui'])
            . '<noscript>Activez JavaScript pour utiliser la console médecin.</noscript>';
    }

    private static function render_logout_form(): string
    {
        $html = '';
        $html .= '<form class="sp-form" method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        $html .= '<input type="hidden" name="action" value="sosprescription_logout" />';
        $html .= wp_nonce_field('sosprescription_logout', '_wpnonce', true, false);
        $html .= '<button type="submit" class="sp-button sp-button--secondary">Se déconnecter</button>';
        $html .= '</form>';

        return $html;
    }
}
