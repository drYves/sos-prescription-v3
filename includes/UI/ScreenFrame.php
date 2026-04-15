<?php
declare(strict_types=1);

namespace SOSPrescription\UI;

defined('ABSPATH') || exit;

/**
 * Small HTML helper for V2 shell wrappers.
 * Keeps plugin logic intact while normalizing screen roots.
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
        $root = self::implode_classes(array_merge(['sp-plugin-root', 'sp-plugin-root--' . $screen], $rootClasses));
        $shell = self::implode_classes(array_merge(['sp-plugin-shell', 'sp-plugin-shell--' . $screen], $shellClasses));

        return '<section class="' . esc_attr($root) . '" data-sp-screen="' . esc_attr($screen) . '">'
            . '<div class="' . esc_attr($shell) . '">'
            . $content
            . '</div>'
            . '</section>';
    }

    public static function statusSurface(string $screen, string $innerHtml = ''): string
    {
        return '<div class="sp-plugin-status-surface sp-plugin-status-surface--' . esc_attr($screen) . '">'
            . $innerHtml
            . '</div>';
    }

    public static function toolbarMeta(string $screen, string $innerHtml): string
    {
        return '<div class="sp-plugin-toolbar-meta sp-plugin-toolbar-meta--' . esc_attr($screen) . '">'
            . $innerHtml
            . '</div>';
    }

    public static function profileSlot(string $screen, string $slotHtml): string
    {
        return '<div class="sp-plugin-profile-slot sp-plugin-profile-slot--' . esc_attr($screen) . '">'
            . $slotHtml
            . '</div>';
    }

    /**
     * @param array<string, string> $attrs
     * @param array<int, string> $classes
     */
    public static function mount(string $screen, string $innerHtml, array $attrs = [], array $classes = []): string
    {
        $allClasses = self::implode_classes(array_merge(['sp-plugin-mount', 'sp-plugin-mount--' . $screen], $classes));
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

        $content = '<div class="sp-plugin-guard sp-plugin-guard--' . esc_attr($variant) . '" data-sp-guard-variant="' . esc_attr($variant) . '">';
        $content .= '<div class="sp-plugin-guard__shell">';
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

        $content .= '</div>';
        $content .= '</div>';

        return self::screen($screen, $content);
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
