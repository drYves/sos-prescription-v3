<?php

declare(strict_types=1);

namespace SosPrescription\Shortcodes;

use SOSPrescription\UI\ScreenFrame;

final class LogoutShortcode
{
    private const QUERY_STATE = 'sp_logout_state';
    private const QUERY_CONTEXT = 'sp_logout_context';
    private const QUERY_RETURN = 'sp_logout_return_to';
    private const STATE_CLOSED = 'closed';

    /**
     * @var array<string, string>
     */
    private static array $shortcode_page_urls = [];

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
            'mode' => 'screen',
            'label' => 'Se déconnecter',
            'class' => 'sp-button sp-button--secondary',
            'form_class' => 'sp-form sp-logout-form',
            'redirect' => home_url('/'),
            'return_to' => '',
            'context' => '',
        ], $atts, 'sosprescription_logout');

        $mode = isset($atts['mode']) && is_string($atts['mode']) ? strtolower(trim((string) $atts['mode'])) : 'screen';

        if ($mode === 'entry') {
            return self::render_entry($atts);
        }

        return self::render_screen($atts);
    }

    public static function current_page_url(): string
    {
        $fallback = (string) home_url('/');
        $pageId = function_exists('get_queried_object_id') ? (int) get_queried_object_id() : 0;
        $url = $pageId > 0 ? get_permalink($pageId) : '';

        if (!is_string($url) || $url === '') {
            $url = $fallback;
        }

        $queryString = isset($_SERVER['QUERY_STRING']) ? trim((string) $_SERVER['QUERY_STRING']) : '';
        if ($queryString !== '') {
            parse_str($queryString, $params);
            if (is_array($params)) {
                unset($params[self::QUERY_STATE], $params[self::QUERY_CONTEXT], $params[self::QUERY_RETURN]);
                if ($params !== []) {
                    $url = add_query_arg($params, $url);
                }
            }
        }

        return self::normalize_internal_url((string) $url, $fallback);
    }

    /**
     * @param array<string, mixed> $atts
     */
    private static function render_entry(array $atts): string
    {
        $screenUrl = self::configured_page_url('', '', 'sosprescription_logout');
        $context = self::resolve_requested_context($atts);
        $buttonLabel = isset($atts['label']) && is_string($atts['label']) ? trim((string) $atts['label']) : 'Se déconnecter';
        $buttonClass = isset($atts['class']) && is_string($atts['class']) ? trim((string) $atts['class']) : 'sp-button sp-button--secondary';
        $formClass = isset($atts['form_class']) && is_string($atts['form_class']) ? trim((string) $atts['form_class']) : 'sp-form sp-logout-form';
        $returnTo = self::resolve_entry_return_url($atts, $context);

        $html = '';
        $html .= '<form class="' . esc_attr($formClass) . '" method="get" action="' . esc_url($screenUrl) . '">';
        $html .= '<input type="hidden" name="' . esc_attr(self::QUERY_CONTEXT) . '" value="' . esc_attr($context) . '" />';
        $html .= '<input type="hidden" name="' . esc_attr(self::QUERY_RETURN) . '" value="' . esc_attr($returnTo) . '" />';
        $html .= '<button type="submit" class="' . esc_attr($buttonClass) . '">' . esc_html($buttonLabel) . '</button>';
        $html .= '</form>';

        return $html;
    }

    /**
     * @param array<string, mixed> $atts
     */
    private static function render_screen(array $atts): string
    {
        self::enqueue_surface_styles();

        $context = self::resolve_requested_context($atts);
        $returnTo = self::resolve_screen_return_url($atts, $context);
        $state = is_user_logged_in() ? '' : self::STATE_CLOSED;

        $content = $state === self::STATE_CLOSED
            ? self::render_closed_card($context)
            : self::render_intent_card($context, $returnTo);

        return ScreenFrame::screen('security', $content, [], ['sp-ui', 'sp-page-shell', 'sp-app-container']);
    }

    private static function render_intent_card(string $context, string $returnTo): string
    {
        $confirmRedirect = self::build_screen_url($context, [
            self::QUERY_STATE => self::STATE_CLOSED,
        ]);

        $html = '';
        $html .= '<article class="sp-logout-card sp-plugin-guard" data-sp-logout-state="intent" data-sp-logout-context="' . esc_attr($context) . '">';
        $html .= '<div class="sp-plugin-guard__shell">';
        $html .= '<div class="sp-plugin-guard__brand" aria-hidden="true">';
        $html .= '<span class="sp-plugin-guard__favicon">' . self::icon_svg('lock') . '</span>';
        $html .= '</div>';
        $html .= '<p class="sp-plugin-guard__eyebrow">Session sécurisée</p>';
        $html .= '<div class="sp-plugin-guard__header">';
        $html .= '<h1 class="sp-plugin-guard__title">Quitter votre espace sécurisé</h1>';
        $html .= '<p class="sp-plugin-guard__body">Vous êtes sur le point de fermer votre session sur cet appareil.</p>';
        $html .= '</div>';
        $html .= '<p class="sp-plugin-guard__body">Vous pourrez vous reconnecter à tout moment via un lien sécurisé.</p>';
        $html .= self::render_context_card($context);
        $html .= '<div class="sp-plugin-guard__actions">';
        $html .= '<form class="sp-form sp-logout-form" method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        $html .= '<input type="hidden" name="action" value="sosprescription_logout" />';
        $html .= '<input type="hidden" name="redirect_to" value="' . esc_attr($confirmRedirect) . '" />';
        $html .= wp_nonce_field('sosprescription_logout', '_wpnonce', true, false);
        $html .= '<button type="submit" class="sp-button sp-button--primary">Se déconnecter</button>';
        $html .= '</form>';
        $html .= '<a class="sp-button sp-button--secondary" href="' . esc_url($returnTo) . '">Retour à mon espace</a>';
        $html .= '</div>';
        $html .= '<div class="sp-plugin-guard__icons" aria-hidden="true">';
        $html .= '<span class="sp-plugin-guard__icon-chip">' . self::icon_svg('shield-plus') . '</span>';
        $html .= '<span class="sp-plugin-guard__icon-chip">' . self::icon_svg('lock') . '</span>';
        $html .= '</div>';
        $html .= '</div>';
        $html .= '</article>';

        return $html;
    }

    private static function render_closed_card(string $context): string
    {
        $homeUrl = (string) home_url('/');
        $reconnectUrl = self::resolve_context_entry_url($context);

        $html = '';
        $html .= '<article class="sp-logout-card sp-plugin-guard" data-sp-logout-state="closed" data-sp-logout-context="' . esc_attr($context) . '">';
        $html .= '<div class="sp-plugin-guard__shell">';
        $html .= '<div class="sp-plugin-guard__brand" aria-hidden="true">';
        $html .= '<span class="sp-plugin-guard__favicon">' . self::icon_svg('shield-plus') . '</span>';
        $html .= '</div>';
        $html .= '<p class="sp-plugin-guard__eyebrow">Session fermée</p>';
        $html .= '<div class="sp-plugin-guard__header">';
        $html .= '<h1 class="sp-plugin-guard__title">Vous êtes déconnecté</h1>';
        $html .= '<p class="sp-plugin-guard__body">Votre session sécurisée a bien été fermée.</p>';
        $html .= '</div>';
        $html .= '<p class="sp-plugin-guard__body">Vous pouvez revenir à l’accueil ou demander un nouveau lien de connexion si nécessaire.</p>';
        $html .= '<div class="sp-plugin-guard__actions">';
        $html .= '<a class="sp-button sp-button--primary" href="' . esc_url($homeUrl) . '">Retour à l’accueil</a>';
        $html .= '<a class="sp-button sp-button--secondary" href="' . esc_url($reconnectUrl) . '">Se reconnecter</a>';
        $html .= '</div>';
        $html .= '<div class="sp-plugin-guard__icons" aria-hidden="true">';
        $html .= '<span class="sp-plugin-guard__icon-chip">' . self::icon_svg('shield-plus') . '</span>';
        $html .= '<span class="sp-plugin-guard__icon-chip">' . self::icon_svg('lock') . '</span>';
        $html .= '</div>';
        $html .= '</div>';
        $html .= '</article>';

        return $html;
    }

    private static function render_context_card(string $context): string
    {
        return '<div class="sp-inline-card">'
            . '<div class="sp-inline-card__content">'
            . '<div class="sp-inline-card__title">Contexte</div>'
            . '<div class="sp-inline-card__meta">' . esc_html(self::resolve_context_label($context)) . '</div>'
            . '</div>'
            . '</div>';
    }

    private static function enqueue_surface_styles(): void
    {
        if (!defined('SOSPRESCRIPTION_URL')) {
            return;
        }

        wp_enqueue_style(
            'sosprescription-ui-kit',
            SOSPRESCRIPTION_URL . 'assets/ui-kit.css',
            [],
            defined('SOSPRESCRIPTION_VERSION') ? SOSPRESCRIPTION_VERSION : null
        );

        if (!defined('SOSPRESCRIPTION_PATH')) {
            return;
        }

        $buildPath = SOSPRESCRIPTION_PATH . 'build/form.css';
        if (!file_exists($buildPath)) {
            return;
        }

        wp_enqueue_style(
            'sosprescription-logout-surface',
            SOSPRESCRIPTION_URL . 'build/form.css',
            ['sosprescription-ui-kit'],
            defined('SOSPRESCRIPTION_VERSION') ? SOSPRESCRIPTION_VERSION : null
        );
    }

    /**
     * @param array<string, mixed> $atts
     */
    private static function resolve_requested_context(array $atts): string
    {
        $raw = '';

        if (isset($_GET[self::QUERY_CONTEXT]) && is_scalar($_GET[self::QUERY_CONTEXT])) {
            $raw = (string) wp_unslash((string) $_GET[self::QUERY_CONTEXT]);
        } elseif (isset($atts['context']) && is_string($atts['context'])) {
            $raw = (string) $atts['context'];
        }

        $context = self::normalize_context($raw);
        if ($context !== '') {
            return $context;
        }

        if (current_user_can('sosprescription_validate') || current_user_can('sosprescription_manage') || current_user_can('manage_options')) {
            return 'console';
        }

        return 'patient';
    }

    /**
     * @param array<string, mixed> $atts
     */
    private static function resolve_entry_return_url(array $atts, string $context): string
    {
        $fallback = self::current_page_url();
        $candidate = '';

        if (isset($atts['return_to']) && is_string($atts['return_to'])) {
            $candidate = trim((string) $atts['return_to']);
        }
        if ($candidate === '' && isset($atts['redirect']) && is_string($atts['redirect'])) {
            $candidate = trim((string) $atts['redirect']);
        }
        if ($candidate === '') {
            $candidate = $fallback;
        }

        $returnTo = self::normalize_internal_url($candidate, $fallback);
        $logoutScreen = self::configured_page_url('', '', 'sosprescription_logout');

        if (self::same_url($returnTo, $logoutScreen)) {
            return self::resolve_context_entry_url($context);
        }

        return $returnTo;
    }

    /**
     * @param array<string, mixed> $atts
     */
    private static function resolve_screen_return_url(array $atts, string $context): string
    {
        $fallback = self::resolve_context_entry_url($context);
        $candidate = '';

        if (isset($_GET[self::QUERY_RETURN]) && is_scalar($_GET[self::QUERY_RETURN])) {
            $candidate = trim((string) wp_unslash((string) $_GET[self::QUERY_RETURN]));
        }
        if ($candidate === '' && isset($atts['return_to']) && is_string($atts['return_to'])) {
            $candidate = trim((string) $atts['return_to']);
        }
        if ($candidate === '' && isset($atts['redirect']) && is_string($atts['redirect'])) {
            $candidate = trim((string) $atts['redirect']);
        }
        if ($candidate === '') {
            $candidate = $fallback;
        }

        $returnTo = self::normalize_internal_url($candidate, $fallback);
        $logoutScreen = self::configured_page_url('', '', 'sosprescription_logout');

        if (self::same_url($returnTo, $logoutScreen)) {
            return $fallback;
        }

        return $returnTo;
    }

    private static function resolve_context_label(string $context): string
    {
        return match ($context) {
            'console' => 'Console médecin',
            'doctor-account' => 'Compte médecin',
            default => 'Espace patient',
        };
    }

    private static function resolve_context_entry_url(string $context): string
    {
        return match ($context) {
            'console' => self::configured_page_url('doctor_console_page_id', 'console', 'sosprescription_admin'),
            'doctor-account' => self::configured_page_url('doctor_account_page_id', 'doctor-account', 'sosprescription_doctor_account'),
            default => self::configured_page_url('patient_portal_page_id', 'patient', 'sosprescription_patient'),
        };
    }

    /**
     * @param array<string, string> $args
     */
    private static function build_screen_url(string $context, array $args = []): string
    {
        $baseUrl = self::configured_page_url('', '', 'sosprescription_logout');
        $queryArgs = array_merge([
            self::QUERY_CONTEXT => $context,
        ], $args);

        return (string) add_query_arg($queryArgs, $baseUrl);
    }

    private static function configured_page_url(string $optionKey = '', string $routeKey = '', string $shortcodeTag = ''): string
    {
        $fallback = (string) home_url('/');

        if ($optionKey !== '') {
            $pages = get_option('sosprescription_pages', []);
            if (is_array($pages)) {
                $pageId = (int) ($pages[$optionKey] ?? 0);
                if ($pageId > 0) {
                    $url = get_permalink($pageId);
                    if (is_string($url) && $url !== '') {
                        return $url;
                    }
                }
            }
        }

        if ($routeKey !== '' && function_exists('sp_get_page_url')) {
            $routeUrl = (string) sp_get_page_url($routeKey);
            if ($routeUrl !== '') {
                return $routeUrl;
            }
        }

        if ($shortcodeTag !== '') {
            $shortcodeUrl = self::locate_shortcode_page_url($shortcodeTag);
            if ($shortcodeUrl !== '') {
                return $shortcodeUrl;
            }
        }

        return $fallback;
    }

    private static function locate_shortcode_page_url(string $shortcodeTag): string
    {
        $shortcodeTag = trim($shortcodeTag);
        if ($shortcodeTag === '') {
            return '';
        }

        if (isset(self::$shortcode_page_urls[$shortcodeTag])) {
            return self::$shortcode_page_urls[$shortcodeTag];
        }

        if (is_singular()) {
            global $post;
            if ($post instanceof \WP_Post) {
                $content = isset($post->post_content) ? (string) $post->post_content : '';
                if ($content !== '' && function_exists('has_shortcode') && has_shortcode($content, $shortcodeTag)) {
                    $permalink = get_permalink($post);
                    if (is_string($permalink) && $permalink !== '') {
                        self::$shortcode_page_urls[$shortcodeTag] = $permalink;
                        return $permalink;
                    }
                }
            }
        }

        global $wpdb;
        if (isset($wpdb) && $wpdb instanceof \wpdb) {
            $like = '%' . $wpdb->esc_like('[' . $shortcodeTag) . '%';
            $sql = $wpdb->prepare(
                "SELECT ID FROM {$wpdb->posts} WHERE post_status = 'publish' AND post_type = 'page' AND post_content LIKE %s ORDER BY menu_order ASC, ID ASC LIMIT 1",
                $like
            );
            $pageId = (int) $wpdb->get_var($sql);
            if ($pageId > 0) {
                $permalink = get_permalink($pageId);
                if (is_string($permalink) && $permalink !== '') {
                    self::$shortcode_page_urls[$shortcodeTag] = $permalink;
                    return $permalink;
                }
            }
        }

        self::$shortcode_page_urls[$shortcodeTag] = '';

        return '';
    }

    private static function normalize_context(string $context): string
    {
        $context = strtolower(trim($context));

        return match ($context) {
            'console', 'doctor-console', 'doctor_console' => 'console',
            'doctor-account', 'doctor_account', 'account', 'compte-medecin' => 'doctor-account',
            'patient', 'patient-portal', 'patient_portal', 'espace-patient' => 'patient',
            default => '',
        };
    }

    private static function normalize_internal_url(string $url, string $fallback): string
    {
        $candidate = trim($url);
        if ($candidate === '') {
            return $fallback;
        }

        $validated = wp_validate_redirect($candidate, false);
        if (!is_string($validated) || $validated === '') {
            return $fallback;
        }

        return $validated;
    }

    private static function same_url(string $left, string $right): bool
    {
        if ($left === '' || $right === '') {
            return false;
        }

        return self::compare_url($left) === self::compare_url($right);
    }

    private static function compare_url(string $url): string
    {
        $parts = wp_parse_url($url);
        if (!is_array($parts)) {
            return untrailingslashit($url);
        }

        $scheme = isset($parts['scheme']) ? strtolower((string) $parts['scheme']) . '://' : '';
        $host = isset($parts['host']) ? strtolower((string) $parts['host']) : '';
        $port = isset($parts['port']) ? ':' . (string) $parts['port'] : '';
        $path = isset($parts['path']) ? untrailingslashit((string) $parts['path']) : '';

        return $scheme . $host . $port . $path;
    }

    private static function icon_svg(string $name): string
    {
        $name = strtolower(trim($name));

        if ($name === 'shield-plus') {
            return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M9 12h6"/><path d="M12 9v6"/></svg>';
        }

        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V8a4 4 0 1 1 8 0v3"/></svg>';
    }
}
