<?php
declare(strict_types=1);

namespace SosPrescription\Shortcodes;

use SosPrescription\Assets;
use SosPrescription\Services\Logger;
use SOSPrescription\UI\ScreenFrame;

final class FormShortcode
{
    private static function renderLoadingSkeleton(string $title, string $subtitle): string
    {
        return '<style id="sp-form-skeleton-style">'
            . '@keyframes spSkeletonPulse{0%,100%{opacity:1}50%{opacity:.52}}'
            . '.sp-skeleton-card{max-width:960px;margin:14px auto;padding:22px;border:1px solid #e5e7eb;border-radius:18px;background:#fff;box-shadow:0 10px 30px rgba(15,23,42,.05);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}'
            . '.sp-skeleton-stack{display:grid;gap:14px}'
            . '.sp-skeleton-line,.sp-skeleton-input,.sp-skeleton-block{background:linear-gradient(90deg,#f1f5f9 25%,#e2e8f0 37%,#f1f5f9 63%);background-size:400% 100%;animation:spSkeletonPulse 2s cubic-bezier(.4,0,.6,1) infinite;border-radius:999px}'
            . '.sp-skeleton-line-title{height:22px;width:min(320px,68%)}'
            . '.sp-skeleton-line-subtitle{height:14px;width:min(540px,88%)}'
            . '.sp-skeleton-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}'
            . '.sp-skeleton-field{display:grid;gap:8px}'
            . '.sp-skeleton-line-label{height:12px;width:120px}'
            . '.sp-skeleton-input{height:44px;border-radius:12px}'
            . '.sp-skeleton-block{height:120px;border-radius:16px}'
            . '.sp-skeleton-actions{display:flex;gap:10px;justify-content:flex-end}'
            . '.sp-skeleton-btn{width:150px;height:42px;border-radius:999px}'
            . '@media (max-width:768px){.sp-skeleton-grid{grid-template-columns:1fr}.sp-skeleton-btn{width:100%}}'
            . '</style>'
            . '<div class="sp-skeleton-card" aria-hidden="true">'
            . '  <div class="sp-skeleton-stack">'
            . '    <div class="sp-skeleton-line sp-skeleton-line-title"></div>'
            . '    <div class="sp-skeleton-line sp-skeleton-line-subtitle"></div>'
            . '    <div class="sp-skeleton-grid">'
            . '      <div class="sp-skeleton-field"><div class="sp-skeleton-line sp-skeleton-line-label"></div><div class="sp-skeleton-input"></div></div>'
            . '      <div class="sp-skeleton-field"><div class="sp-skeleton-line sp-skeleton-line-label"></div><div class="sp-skeleton-input"></div></div>'
            . '      <div class="sp-skeleton-field"><div class="sp-skeleton-line sp-skeleton-line-label"></div><div class="sp-skeleton-input"></div></div>'
            . '      <div class="sp-skeleton-field"><div class="sp-skeleton-line sp-skeleton-line-label"></div><div class="sp-skeleton-input"></div></div>'
            . '    </div>'
            . '    <div class="sp-skeleton-block"></div>'
            . '    <div class="sp-skeleton-actions"><div class="sp-skeleton-line sp-skeleton-btn"></div></div>'
            . '    <div class="sp-muted" style="margin-top:4px;font-size:13px;color:#64748b;">' . esc_html($title) . ' · ' . esc_html($subtitle) . '</div>'
            . '  </div>'
            . '</div>';
    }

    public static function register(): void
    {
        add_shortcode('sosprescription_form', [self::class, 'render']);
    }

    /**
     * Formulaire principal (front) — rendu via l'app React.
     *
     * @param array<string, mixed> $atts
     */
    public static function render(array $atts = []): string
    {
        // Log standard : (shortcode, level, message, context).
        Logger::log_shortcode('sosprescription_form', 'info', 'shortcode_render', [
            'atts_count' => count($atts),
        ]);

        // IMPORTANT : le shortcode doit aussi enqueue les assets.
        // Sinon le conteneur <div id="sosprescription-root-form"> reste vide.
        Assets::enqueue_frontend('form');

        // Debug : vérifier que WP a bien enqueue les scripts (sinon React ne montera pas).
        $manifest_path = SOSPRESCRIPTION_PATH . 'build/manifest.json';
        $manifest_exists = is_file($manifest_path);
        $manifest_size = $manifest_exists ? (int) (@filesize($manifest_path) ?: 0) : 0;

        Logger::log_shortcode('sosprescription_form', 'info', 'assets_state', [
            'dev_mode' => (defined('SOSPRESCRIPTION_DEV') && SOSPRESCRIPTION_DEV === true) ? true : false,
            'manifest_exists' => $manifest_exists,
            'manifest_size' => $manifest_size,
            // En prod, on charge via un loader (vite-form-loader.js)
            'entry_enqueued' => wp_script_is('sosprescription-form', 'enqueued'),
            'loader_enqueued' => wp_script_is('sosprescription-form-loader', 'enqueued'),
            'turnstile_registered' => wp_script_is('sosprescription-turnstile', 'registered'),
            'turnstile_enqueued' => wp_script_is('sosprescription-turnstile', 'enqueued'),
        ]);

        // IMPORTANT: l'entry Vite (build) cherche l'ID "sosprescription-root-form".
        // On ajoute une surface d'erreur unifiée (API / loader) au-dessus du root React.
        // Cette surface peut afficher un ReqID si disponible.
        $content  = ScreenFrame::statusSurface('request',
            '<div id="sp-error-surface-form" class="sp-alert sp-alert-error" style="display:none" role="alert" aria-live="polite"></div>'
        );
        $content .= ScreenFrame::mount(
            'request',
            '<div id="sosprescription-root-form" data-app="form">'
            . self::renderLoadingSkeleton('Préparation du formulaire', 'Chargement sécurisé de l\'application patient…')
            . '</div>'
        );

        return ScreenFrame::screen('request', $content, [], ['sp-ui'])
            . '<noscript>Activez JavaScript pour utiliser le formulaire d\'ordonnance.</noscript>';
    }
}
