<?php
declare(strict_types=1);

namespace SOSPrescription\Services;

/**
 * Désactive le cache HTTP + signale aux plugins de cache WordPress de ne pas mettre en cache
 * les pages applicatives (console médecin / espace patient / formulaire) ainsi que
 * la page de vérification /v/{token}.
 *
 * Objectif : éviter les états "stale" (demande non visible sans purge cache,
 * statut non rafraîchi côté patient, etc.) dans les environnements mutualisés
 * (Hostinger) ou lorsqu'un plugin de cache est activé.
 */
final class NoCache {
    /**
     * Les shortcodes applicatifs dont le rendu doit être considéré "non-cacheable".
     *
     * NB : on exclut volontairement les shortcodes purement informatifs/marketing.
     */
    private const APP_SHORTCODES = [
        'sosprescription_form',
        'sosprescription_patient',
        'sosprescription_doctor_account',
        'sosprescription_admin',
    ];

    /**
     * Query var de la page de vérification /v/{token}.
     *
     * Déclarée dans Frontend\\VerificationPage (const privée) ; on la duplique ici
     * pour éviter un couplage fort.
     */
    private const VERIFY_QUERY_VAR = 'sp_rx_verify_token';

    public static function register_hooks(): void {
        // Déclare les constantes DONOTCACHE* dès qu'on a un contexte WP (requête résolue).
        add_action('wp', [__CLASS__, 'maybe_define_donotcache_constants'], 0);

        // Envoie des headers no-cache (utile même sans plugin de cache).
        add_action('send_headers', [__CLASS__, 'maybe_send_nocache_headers'], 0);
    }

    /**
     * Définit les constantes DONOTCACHE* utilisées par beaucoup de plugins de cache.
     */
    public static function maybe_define_donotcache_constants(): void {
        if (!self::should_disable_cache()) {
            return;
        }

        // Ces constantes sont l'API de facto des plugins de cache WP.
        if (!defined('DONOTCACHEPAGE')) {
            define('DONOTCACHEPAGE', true);
        }
        if (!defined('DONOTCACHEOBJECT')) {
            define('DONOTCACHEOBJECT', true);
        }
        if (!defined('DONOTCACHEDB')) {
            define('DONOTCACHEDB', true);
        }

        // Log optionnel (scope runtime -> nocache).
        if (method_exists(Logger::class, 'scope_enabled') && Logger::scope_enabled('runtime')) {
            Logger::ndjson_scoped('runtime', 'nocache', 'info', 'donotcache_defined', [
                'path' => isset($_SERVER['REQUEST_URI']) ? (string) $_SERVER['REQUEST_URI'] : '',
                'verify' => (bool) self::get_verify_token(),
                'shortcodes' => self::detect_app_shortcodes(),
            ]);
        }
    }

    /**
     * Envoie des headers HTTP no-cache.
     */
    public static function maybe_send_nocache_headers(): void {
        if (!self::should_disable_cache()) {
            return;
        }
        if (headers_sent()) {
            return;
        }

        // WordPress standard.
        if (function_exists('nocache_headers')) {
            nocache_headers();
        }
        // Renforce l'intention (certains proxies sont plus sensibles au Cache-Control explicite).
        header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
        header('Pragma: no-cache');

        if (method_exists(Logger::class, 'scope_enabled') && Logger::scope_enabled('runtime')) {
            Logger::ndjson_scoped('runtime', 'nocache', 'info', 'nocache_headers_sent', [
                'path' => isset($_SERVER['REQUEST_URI']) ? (string) $_SERVER['REQUEST_URI'] : '',
            ]);
        }
    }

    private static function should_disable_cache(): bool {
        if (is_admin()) {
            return false;
        }

        // Page de vérification pharmacien.
        if (self::get_verify_token()) {
            return true;
        }

        // Pages applicatives avec shortcodes.
        return count(self::detect_app_shortcodes()) > 0;
    }

    /**
     * Retourne le token /v/{token} si présent.
     */
    private static function get_verify_token(): string {
        // get_query_var est disponible après parse_query.
        if (function_exists('get_query_var')) {
            $t = (string) get_query_var(self::VERIFY_QUERY_VAR);
            if ($t !== '') {
                return $t;
            }
        }
        // Fallback ultra-défensif.
        if (isset($_GET[self::VERIFY_QUERY_VAR])) {
            return (string) $_GET[self::VERIFY_QUERY_VAR];
        }
        return '';
    }

    /**
     * Détecte la présence de shortcodes applicatifs dans le post courant.
     * Retourne un tableau des shortcodes trouvés.
     */
    private static function detect_app_shortcodes(): array {
        if (!is_singular()) {
            return [];
        }

        global $post;
        if (!$post || !isset($post->post_content)) {
            return [];
        }
        $content = (string) $post->post_content;
        if ($content === '') {
            return [];
        }

        $found = [];
        foreach (self::APP_SHORTCODES as $sc) {
            if (function_exists('has_shortcode') && has_shortcode($content, $sc)) {
                $found[] = $sc;
            }
        }
        return $found;
    }
}
