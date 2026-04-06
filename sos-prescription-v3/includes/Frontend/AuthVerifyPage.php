<?php

declare(strict_types=1);

namespace SosPrescription\Frontend;

use SosPrescription\UI\AuthMagicLinkUi;

defined('ABSPATH') || exit;

final class AuthVerifyPage
{
    private const QUERY_VAR = 'sp_auth_verify_page';

    public static function register_hooks(): void
    {
        add_action('init', [self::class, 'register_rewrite'], 9);
        add_filter('query_vars', [self::class, 'register_query_var']);
        add_action('template_redirect', [self::class, 'maybe_render']);
        add_action('admin_init', [self::class, 'maybe_flush_rewrite']);
    }

    public static function register_rewrite(): void
    {
        add_rewrite_rule(
            '^auth/verify/?$',
            'index.php?' . self::QUERY_VAR . '=1',
            'top'
        );
    }

    /**
     * @param array<int, string> $vars
     * @return array<int, string>
     */
    public static function register_query_var(array $vars): array
    {
        $vars[] = self::QUERY_VAR;
        return $vars;
    }

    public static function maybe_flush_rewrite(): void
    {
        if (!current_user_can('manage_options')) {
            return;
        }

        $key = 'sosprescription_auth_verify_rewrite_v';
        $expected = (string) (defined('SOSPRESCRIPTION_VERSION') ? SOSPRESCRIPTION_VERSION : '');
        if ($expected === '') {
            return;
        }

        $current = (string) get_option($key, '');
        if ($current === $expected) {
            return;
        }

        self::register_rewrite();
        flush_rewrite_rules(false);
        update_option($key, $expected, true);
    }

    public static function maybe_render(): void
    {
        if ((string) get_query_var(self::QUERY_VAR, '') !== '1') {
            return;
        }

        nocache_headers();
        status_header(200);
        header('Content-Type: text/html; charset=' . get_bloginfo('charset'), true);
        header('X-Robots-Tag: noindex, nofollow', true);
        header('Referrer-Policy: same-origin', true);
        header('X-Content-Type-Options: nosniff', true);

        AuthMagicLinkUi::enqueue_assets();

        $title = 'Connexion sécurisée';
        $lang = get_bloginfo('language');
        $lang = is_string($lang) && trim($lang) !== '' ? trim($lang) : 'fr-FR';

        echo '<!doctype html>';
        echo '<html lang="' . esc_attr($lang) . '">';
        echo '<head>';
        echo '<meta charset="' . esc_attr(get_bloginfo('charset')) . '">';
        echo '<meta name="viewport" content="width=device-width,initial-scale=1">';
        echo '<title>' . esc_html($title) . '</title>';
        wp_head();
        echo '</head>';
        echo '<body class="sp-plugin-page sp-plugin-page--auth-verify">';
        if (function_exists('wp_body_open')) {
            wp_body_open();
        }
        echo '<main id="primary" class="site-main">';
        echo AuthMagicLinkUi::render_verify_screen(); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
        echo '</main>';
        wp_footer();
        echo '</body>';
        echo '</html>';
        exit;
    }
}
