<?php
declare(strict_types=1);

namespace SOSPrescription\Shortcodes;

use SOSPrescription\Assets;
use SOSPrescription\Services\Logger;

final class FormShortcode
{
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
        $manifest_path = dirname(__DIR__, 2) . '/build/manifest.json';
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
        return '<div class="sp-ui">'
            . '  <div id="sp-error-surface-form" class="sp-alert sp-alert-error" style="display:none" role="alert" aria-live="polite"></div>'
            . '  <div id="sosprescription-root-form" data-app="form">'
            . '    <div class="sp-card" style="max-width:900px;margin:12px auto;">'
            . '      <div class="sp-card-title">Chargement du formulaire…</div>'
            . '      <div class="sp-muted" style="margin-top:6px;">Si cette page reste vide, ouvrez la console (F12) et consultez les logs SOS Prescription.</div>'
            . '    </div>'
            . '  </div>'
            . '</div>'
            . '<noscript>Activez JavaScript pour utiliser le formulaire d\'ordonnance.</noscript>';
    }
}
