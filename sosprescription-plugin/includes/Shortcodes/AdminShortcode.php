<?php
declare(strict_types=1);

namespace SosPrescription\Shortcodes;

use SosPrescription\Assets;
use SosPrescription\Services\Logger;

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

            return '<div class="sosprescription-guard" style="max-width:980px;margin:12px auto;padding:16px;border:1px solid #e5e7eb;background:#fff;border-radius:12px;">'
                . '<h3 style="margin:0 0 8px 0;">Connexion requise</h3>'
                . '<p style="margin:0 0 10px 0;">Merci de vous connecter pour accéder à la console médecin.</p>'
                . '<p style="margin:0;"><a class="button button-primary" href="' . esc_url($login_url) . '">Se connecter</a></p>'
                . '</div>';
        }

        if (!current_user_can('sosprescription_validate') && !current_user_can('sosprescription_manage') && !current_user_can('manage_options')) {
            return '<div class="sosprescription-guard" style="max-width:980px;margin:12px auto;padding:16px;border:1px solid #e5e7eb;background:#fff;border-radius:12px;">'
                . '<h3 style="margin:0 0 8px 0;">Accès réservé</h3>'
                . '<p style="margin:0;">Cette page est réservée aux médecins et administrateurs de la plateforme.</p>'
                . '</div>';
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

		$html  = '<div id="sosprescription-doctor-console-root" class="sosprescription-doctor sp-ui">';
		$html .= '<div style="max-width:980px;margin:12px auto;">';
		$html .= '<div class="sp-row sp-row-between" style="margin:0 0 12px 0;">';
		$html .= '  <div class="sp-badge sp-badge-success"><span class="sp-dot sp-dot-online" aria-hidden="true"></span> Connecté : ' . esc_html($connected_label) . '</div>';
		$html .= '</div>';
		$html .= '<div class="sp-card">';
		$html .= '<div class="sp-card-title">Chargement de la console médecin…</div>';
		$html .= '<div class="sp-muted" style="margin-top:6px;">'
			. 'Si l&rsquo;interface reste bloquée, vérifiez les logs / une erreur 403/500, puis rafraîchissez la page.'
			. '</div>';
		$html .= '</div></div></div>';
		$html .= '<noscript>Activez JavaScript pour utiliser la console médecin.</noscript>';
		return $html;
    }
}
