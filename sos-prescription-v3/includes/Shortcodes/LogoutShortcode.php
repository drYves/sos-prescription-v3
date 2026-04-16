<?php

declare(strict_types=1);

namespace SosPrescription\Shortcodes;

final class LogoutShortcode
{
    public static function register(): void
    {
        add_shortcode('sosprescription_logout', [self::class, 'render']);
    }

    /**
     * @param array<string, mixed> $atts
     */
    public static function render(array $atts = []): string
    {
        $atts = shortcode_atts([
            'label' => 'Se déconnecter',
            'class' => 'sp-button sp-button--secondary',
            'form_class' => 'sp-form sp-logout-form',
            'redirect' => home_url('/'),
        ], $atts, 'sosprescription_logout');

        $action = esc_url(admin_url('admin-post.php'));
        $label = is_string($atts['label']) ? $atts['label'] : 'Se déconnecter';
        $buttonClass = is_string($atts['class']) ? $atts['class'] : 'sp-button sp-button--secondary';
        $formClass = is_string($atts['form_class']) ? $atts['form_class'] : 'sp-form sp-logout-form';
        $redirect = is_string($atts['redirect']) ? trim($atts['redirect']) : '';
        if ($redirect === '') {
            $redirect = home_url('/');
        }

        $html = '';
        $html .= '<form class="' . esc_attr($formClass) . '" method="post" action="' . $action . '">';
        $html .= '<input type="hidden" name="action" value="sosprescription_logout" />';
        $html .= '<input type="hidden" name="redirect_to" value="' . esc_attr($redirect) . '" />';
        $html .= wp_nonce_field('sosprescription_logout', '_wpnonce', true, false);
        $html .= '<button type="submit" class="' . esc_attr($buttonClass) . '">' . esc_html($label) . '</button>';
        $html .= '</form>';

        return $html;
    }
}
