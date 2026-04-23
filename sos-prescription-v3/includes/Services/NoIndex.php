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
    private static array $shortcodesNoIndexNoFollow = [
        'sosprescription_form',
        'sosprescription_patient',
        'sosprescription_admin',
        'sosprescription_doctor_account',
        'sosprescription_magic_redirect',
        'sosprescription_logout',
    ];

    /**
     * Shortcodes POC devant rester explorables en liens, mais jamais indexés.
     * Le catalogue BDPM sert ici uniquement de surface POC de recette multilingue.
     * Il ne devient ni une surface SEO publique, ni un entrypoint multilingue produit.
     * @var string[]
     */
    private static array $shortcodesNoIndexFollow = [
        'sosprescription_bdpm_table',
    ];

    public static function register_hooks(): void
    {
        add_action('wp_head', [self::class, 'maybe_output_meta'], 0);
        add_action('send_headers', [self::class, 'maybe_send_headers'], 0);
    }

    public static function maybe_output_meta(): void
    {
        $robots = self::robots_directive();
        if ($robots === null) {
            return;
        }

        echo "\n" . '<meta name="robots" content="' . esc_attr($robots) . '" />' . "\n";
    }

    public static function maybe_send_headers(): void
    {
        $robots = self::robots_directive();
        if ($robots === null) {
            return;
        }

        // Important: header envoyé seulement si pas déjà envoyé.
        if (!headers_sent()) {
            header('X-Robots-Tag: ' . $robots, true);
        }
    }

    private static function robots_directive(): ?string
    {
        if (!is_singular()) {
            return null;
        }

        global $post;
        if (!isset($post) || !$post) {
            return null;
        }

        $content = isset($post->post_content) ? (string) $post->post_content : '';
        if ($content === '') {
            return null;
        }

        foreach (self::$shortcodesNoIndexNoFollow as $sc) {
            if (has_shortcode($content, $sc)) {
                return 'noindex, nofollow';
            }
        }

        foreach (self::$shortcodesNoIndexFollow as $sc) {
            if (has_shortcode($content, $sc)) {
                return 'noindex, follow';
            }
        }

        return null;
    }
}
