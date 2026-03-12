<?php
/**
 * Turnstile bootstrap (integrated).
 *
 * Objectif : éviter une étape d'installation MU-Plugins sur mutualisé.
 * Le plugin principal expose les helpers attendus (siteKey + enqueue).
 */

declare(strict_types=1);

defined('ABSPATH') || exit;

if (!function_exists('sosprescription_turnstile_site_key')) {
    function sosprescription_turnstile_site_key(): string
    {
        if (defined('SOSPRESCRIPTION_TURNSTILE_SITE_KEY')) {
            return (string) SOSPRESCRIPTION_TURNSTILE_SITE_KEY;
        }
        return '';
    }
}

if (!function_exists('sosprescription_turnstile_enqueue')) {
    function sosprescription_turnstile_enqueue(): void
    {
        $key = sosprescription_turnstile_site_key();
        if ($key === '') {
            return;
        }

        // Enqueue Turnstile script (Cloudflare). The widget is rendered explicitly in React.
        if (!wp_script_is('sosprescription-turnstile', 'enqueued')) {
            wp_enqueue_script(
                'sosprescription-turnstile',
                'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
                [],
                null,
                true
            );
        }
    }
}

// Register the script early (does not enqueue) so other parts can depend on it.
add_action('init', static function (): void {
    $key = sosprescription_turnstile_site_key();
    if ($key === '') {
        return;
    }

    if (!wp_script_is('sosprescription-turnstile', 'registered')) {
        wp_register_script(
            'sosprescription-turnstile',
            'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
            [],
            null,
            true
        );
    }
}, 1);
