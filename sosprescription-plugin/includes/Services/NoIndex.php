<?php
declare(strict_types=1);

namespace SosPrescription\Services;

/**
 * Ajoute un "noindex" automatique sur les pages qui contiennent des shortcodes sensibles.
 *
 * Objectif : éviter qu'une page d'espace patient / console médecin ne se retrouve indexée
 * par un moteur de recherche.
 *
 * NB: on ne bloque pas l'accès ; la protection d'accès est gérée par les shortcodes/API.
 */
final class NoIndex
{
    /**
     * Shortcodes considérés comme "sensibles".
     * @var string[]
     */
    private static array $shortcodes = [
        'sosprescription_form',
        'sosprescription_patient',
        'sosprescription_admin',
        'sosprescription_doctor_account',
    ];

    public static function register_hooks(): void
    {
        add_action('wp_head', [self::class, 'maybe_output_meta'], 0);
        add_action('send_headers', [self::class, 'maybe_send_headers'], 0);
    }

    public static function maybe_output_meta(): void
    {
        if (!self::should_noindex()) {
            return;
        }

        echo "\n" . '<meta name="robots" content="noindex,nofollow" />' . "\n";
    }

    public static function maybe_send_headers(): void
    {
        if (!self::should_noindex()) {
            return;
        }

        // Important: header envoyé seulement si pas déjà envoyé.
        if (!headers_sent()) {
            header('X-Robots-Tag: noindex, nofollow', true);
        }
    }

    private static function should_noindex(): bool
    {
        if (!is_singular()) {
            return false;
        }

        global $post;
        if (!isset($post) || !$post) {
            return false;
        }

        $content = isset($post->post_content) ? (string) $post->post_content : '';
        if ($content === '') {
            return false;
        }

        foreach (self::$shortcodes as $sc) {
            if (has_shortcode($content, $sc)) {
                return true;
            }
        }

        return false;
    }
}
