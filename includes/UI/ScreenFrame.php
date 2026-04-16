<?php
declare(strict_types=1);

namespace SOSPrescription\UI;

defined('ABSPATH') || exit;

/**
 * Small HTML helper for V2 shell wrappers.
 * Keeps plugin logic intact while normalizing screen roots.
 * V7.0.7 — favicon guards fixé avec une URL thème absolue unique.
 */
final class ScreenFrame
{
    private function __construct()
    {
    }

    /**
     * @param array<int, string> $rootClasses
     * @param array<int, string> $shellClasses
     */
    public static function screen(string $screen, string $content, array $rootClasses = [], array $shellClasses = []): string
    {
        $root = self::implode_classes(array_merge(['sp-screen-root', 'sp-plugin-root', 'sp-plugin-root--' . $screen], $rootClasses));
        $shell = self::implode_classes(array_merge(['sp-plugin-shell', 'sp-plugin-shell--' . $screen], $shellClasses));

        return '<section class="' . esc_attr($root) . '" data-sp-screen="' . esc_attr($screen) . '" data-sp-screen-root="' . esc_attr($screen) . '">'
            . '<div class="' . esc_attr($shell) . '">'
            . $content
            . '</div>'
            . '</section>';
    }

    public static function statusSurface(string $screen, string $innerHtml = ''): string
    {
        return '<div class="sp-plugin-slot sp-plugin-slot--status sp-plugin-status-surface sp-plugin-status-surface--' . esc_attr($screen) . '">'
            . $innerHtml
            . '</div>';
    }

    public static function toolbarMeta(string $screen, string $innerHtml): string
    {
        return '<div class="sp-plugin-slot sp-plugin-slot--toolbar-meta sp-plugin-toolbar-meta sp-plugin-toolbar-meta--' . esc_attr($screen) . '">'
            . $innerHtml
            . '</div>';
    }

    public static function profileSlot(string $screen, string $slotHtml): string
    {
        return '<div class="sp-plugin-slot sp-plugin-slot--profile sp-plugin-profile-slot sp-plugin-profile-slot--' . esc_attr($screen) . '">'
            . $slotHtml
            . '</div>';
    }

    /**
     * @param array<string, string> $attrs
     * @param array<int, string> $classes
     */
    public static function mount(string $screen, string $innerHtml, array $attrs = [], array $classes = []): string
    {
        $allClasses = self::implode_classes(array_merge(['sp-plugin-slot', 'sp-plugin-slot--mount', 'sp-plugin-mount', 'sp-plugin-mount--' . $screen], $classes));
        $attrs = array_merge(['class' => $allClasses], $attrs);

        return '<div ' . self::render_attrs($attrs) . '>'
            . $innerHtml
            . '</div>';
    }

    public static function loadingCard(string $title, string $message): string
    {
        return '<div class="sp-card">'
            . '<div class="sp-card-title">' . esc_html($title) . '</div>'
            . '<div class="sp-muted" style="margin-top:6px;">' . esc_html($message) . '</div>'
            . '</div>';
    }

    public static function badge(string $label, string $tone = 'success', bool $withDot = false): string
    {
        $classes = 'sp-badge sp-badge-' . sanitize_html_class($tone);
        $dot = $withDot ? '<span class="sp-dot sp-dot-online" aria-hidden="true"></span>' : '';

        return '<div class="' . esc_attr($classes) . '">' . $dot . ' ' . esc_html($label) . '</div>';
    }

    /**
     * @param array<int, array<string, string>> $actions
     */
    public static function guard(string $screen, string $variant, string $title, string $message, array $actions = []): string
    {
        $variant = sanitize_html_class($variant);
        $eyebrow = 'Compte professionnel sécurisé';

        if ($variant === 'error') {
            $eyebrow = 'Accès temporairement indisponible';
        } elseif ($variant === 'access' || $variant === 'restricted') {
            $eyebrow = 'Accès médecin sécurisé';
        }

        $content = '<div class="sp-plugin-guard sp-guard-surface sp-plugin-guard--' . esc_attr($variant) . '" data-sp-guard-variant="' . esc_attr($variant) . '">';
        $content .= '<div class="sp-plugin-guard__shell">';
        $content .= '<div class="sp-plugin-guard__brand" aria-hidden="true">';
        $favicon = self::guard_favicon_url();
        if ($favicon !== '') {
            $content .= '<span class="sp-plugin-guard__favicon"><img src="' . esc_url($favicon) . '" alt="" loading="eager" decoding="async" /></span>';
        }
        $content .= '</div>';
        $content .= '<p class="sp-plugin-guard__eyebrow">' . esc_html($eyebrow) . '</p>';
        $content .= '<div class="sp-plugin-guard__header">';
        $content .= '<h3 class="sp-plugin-guard__title">' . esc_html($title) . '</h3>';
        $content .= '<p class="sp-plugin-guard__body">' . esc_html($message) . '</p>';
        $content .= '</div>';

        if ($actions !== []) {
            $content .= '<div class="sp-plugin-guard__actions">';
            foreach ($actions as $action) {
                $label = isset($action['label']) ? (string) $action['label'] : '';
                $url = isset($action['url']) ? (string) $action['url'] : '#';
                $class = isset($action['class']) ? (string) $action['class'] : 'sp-button sp-button--secondary';
                $content .= '<a class="' . esc_attr($class) . '" href="' . esc_url($url) . '">' . esc_html($label) . '</a>';
            }
            $content .= '</div>';
        }

        $content .= '<div class="sp-plugin-guard__icons" aria-hidden="true">';
        $content .= '<span class="sp-plugin-guard__icon-chip">' . self::guard_icon('shield-plus') . '</span>';
        $content .= '<span class="sp-plugin-guard__icon-chip">' . self::guard_icon('lock') . '</span>';
        $content .= '</div>';
        $content .= '</div>';
        $content .= '</div>';

        return self::screen($screen, $content);
    }
    private static function guard_favicon_url(): string
    {
        return get_stylesheet_directory_uri() . '/assets/img/brand/sos-favicon.svg';
    }

    private static function guard_icon(string $name): string
    {
        $name = strtolower(trim($name));

        if ($name === 'stethoscope') {
            return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 3v5a4 4 0 0 0 8 0V3"/><path d="M8 3v5"/><path d="M16 11v2a4 4 0 0 0 8 0 4 4 0 0 0-4-4h-1"/><circle cx="20" cy="9" r="2"/></svg>';
        }

        if ($name === 'shield-plus') {
            return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M9 12h6"/><path d="M12 9v6"/></svg>';
        }

        if ($name === 'lock') {
            return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V8a4 4 0 1 1 8 0v3"/></svg>';
        }

        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3z"/><path d="m9 12 2 2 4-4"/></svg>';
    }

    /**
     * @param array<string, string> $attrs
     */
    private static function render_attrs(array $attrs): string
    {
        $pairs = [];
        foreach ($attrs as $name => $value) {
            if ($value === '') {
                continue;
            }
            $pairs[] = sanitize_key((string) $name) . '="' . esc_attr($value) . '"';
        }

        return implode(' ', $pairs);
    }

    /**
     * @param array<int, string> $classes
     */
    private static function implode_classes(array $classes): string
    {
        $out = [];
        foreach ($classes as $class) {
            $class = trim((string) $class);
            if ($class === '') {
                continue;
            }
            $out[] = $class;
        }

        return implode(' ', array_unique($out));
    }
}
