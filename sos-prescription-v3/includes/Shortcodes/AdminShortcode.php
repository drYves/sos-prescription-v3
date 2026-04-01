<?php
declare(strict_types=1);

namespace SosPrescription\Shortcodes;

use SosPrescription\Assets;
use SosPrescription\Services\Logger;
use SOSPrescription\UI\ScreenFrame;

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
            $redirect = is_singular() ? (string) get_permalink() : (string) home_url('/');
            $login_url = wp_login_url($redirect);

            return ScreenFrame::guard(
                'console',
                'login',
                'Connexion requise',
                'Merci de vous connecter pour accéder à la console médecin.',
                [
                    [
                        'label' => 'Se connecter',
                        'url'   => $login_url,
                        'class' => 'sp-button sp-button--primary button button-primary',
                    ],
                ]
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

        // Ajoute le titre (Dr/Pr) si disponible.
        $title_meta = is_object($user) ? (string) get_user_meta((int) $user->ID, 'sosprescription_doctor_title', true) : '';
        $title_meta = strtolower(trim($title_meta));
        $title_prefix = '';
        if ($title_meta === 'professeur') {
            $title_prefix = 'Pr';
        } elseif ($title_meta === 'docteur') {
            $title_prefix = 'Dr';
        }
        $connected_label = trim($title_prefix . ' ' . $display_name);

		$badge = '<div class="sp-row sp-row-between" style="margin:0;">'
			. '  <div class="sp-badge sp-badge-success"><span class="sp-dot sp-dot-online" aria-hidden="true"></span> Connecté : ' . esc_html($connected_label) . '</div>'
			. '</div>';

		$content  = ScreenFrame::toolbarMeta('console', $badge);
		$content .= ScreenFrame::mount(
			'console',
			'<div id="sosprescription-doctor-console-root" class="sosprescription-doctor sp-ui" data-sp-screen="console">'
			. ScreenFrame::loadingCard(
				'Chargement de la console médecin…',
				'Si l’interface reste bloquée, vérifiez les logs / une erreur 403/500, puis rafraîchissez la page.'
			)
			. '</div>'
		);

		return ScreenFrame::screen('console', $content)
			. '<noscript>Activez JavaScript pour utiliser la console médecin.</noscript>';
    }
}
