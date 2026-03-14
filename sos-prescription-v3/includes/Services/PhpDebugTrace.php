<?php
declare(strict_types=1);

namespace SosPrescription\Services;

/**
 * Capture des erreurs PHP (warning/notice/deprecated, etc.) dans un fichier de logs
 * "type debug.log" (sans dépendre de WP_DEBUG_LOG).
 *
 * Objectif : aider le support sur des hébergements mutualisés où la sortie d'erreurs
 * peut être limitée ou polluer des réponses JSON.
 */
final class PhpDebugTrace
{
    private static bool $installed = false;
    /** @var callable|null */
    private static $previous_handler = null;
    private static bool $in_handler = false;

    public static function register_hooks(): void
    {
        // Le plus tôt possible, mais après chargement WordPress.
        add_action('plugins_loaded', [self::class, 'maybe_install'], 1);
    }

    public static function maybe_install(): void
    {
        if (self::$installed) {
            return;
        }

        // "Soft" : on n'installe le handler que si le scope est activé.
        if (!Logger::scope_enabled('php_debug')) {
            return;
        }

        self::$installed = true;
        self::$previous_handler = set_error_handler([self::class, 'handle_error']);
    }

    /**
     * @return bool true si l'erreur est "gérée" (bloque le handler PHP), false sinon.
     */
    public static function handle_error(int $errno, string $errstr, string $errfile, int $errline): bool
    {
        // Respecte le "@" et le niveau error_reporting courant.
        if ((error_reporting() & $errno) === 0) {
            return false;
        }

        // Si l'option a été désactivée à chaud (save + reload), on n'écrit plus.
        if (!Logger::scope_enabled('php_debug')) {
            return self::delegate($errno, $errstr, $errfile, $errline);
        }

        // Anti-récursion (écriture logs -> warning -> écriture logs...).
        if (self::$in_handler) {
            return self::delegate($errno, $errstr, $errfile, $errline);
        }

        self::$in_handler = true;
        try {
            // Filtre anti-bruit : on ignore le warning Action Scheduler (plugin externe) déjà identifié.
            // L'objectif est de ne pas noyer les logs SOS Prescription.
            if (
                stripos($errstr, 'as_next_scheduled_action') !== false
                || stripos($errstr, 'Action Scheduler data store') !== false
            ) {
                self::$in_handler = false;
                return self::delegate($errno, $errstr, $errfile, $errline);
            }

            $level = self::map_level($errno);
            $context = [
                'errno' => $errno,
                'file' => $errfile,
                'line' => $errline,
                'php' => PHP_VERSION,
                'sapi' => php_sapi_name(),
                'rid' => Logger::rid(),
                'url' => (isset($_SERVER['REQUEST_URI']) ? (string) $_SERVER['REQUEST_URI'] : ''),
                'method' => (isset($_SERVER['REQUEST_METHOD']) ? (string) $_SERVER['REQUEST_METHOD'] : ''),
                'is_admin' => function_exists('is_admin') ? (bool) is_admin() : null,
            ];

            // On écrit dans un fichier "runtime" au scope dédié.
            Logger::log_scoped('runtime', 'php_debug', $level, $errstr, $context);
        } catch (\Throwable $e) {
            // Never fail the request because of logging.
        }

        self::$in_handler = false;
        return self::delegate($errno, $errstr, $errfile, $errline);
    }

    private static function delegate(int $errno, string $errstr, string $errfile, int $errline): bool
    {
        if (is_callable(self::$previous_handler)) {
            try {
                $res = call_user_func(self::$previous_handler, $errno, $errstr, $errfile, $errline);
                return is_bool($res) ? $res : false;
            } catch (\Throwable $e) {
                return false;
            }
        }
        return false;
    }

    private static function map_level(int $errno): string
    {
        switch ($errno) {
            case E_ERROR:
            case E_USER_ERROR:
            case E_RECOVERABLE_ERROR:
                return 'error';

            case E_WARNING:
            case E_USER_WARNING:
                return 'warning';

            case E_PARSE:
            case E_COMPILE_ERROR:
            case E_CORE_ERROR:
                return 'fatal';

            case E_NOTICE:
            case E_USER_NOTICE:
                return 'notice';

            case E_DEPRECATED:
            case E_USER_DEPRECATED:
                return 'deprecated';

            case E_STRICT:
                return 'strict';

            default:
                return 'debug';
        }
    }
}
