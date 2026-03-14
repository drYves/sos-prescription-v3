<?php
declare(strict_types=1);

namespace SosPrescription\Services;

/**
 * Collects a minimal, support-friendly diagnostics snapshot.
 *
 * ⚠️ Must remain PII-safe: do not include patient names, NIR, raw payloads, etc.
 */
final class DiagnosticsService
{
    /**
     * Build a diagnostics payload safe to export.
     *
     * @return array<string,mixed>
     */
    public static function collect(string $req_id): array
    {
        $now_iso = gmdate('c');

        $uploads = wp_upload_dir();
        $uploads_basedir = (string) ($uploads['basedir'] ?? '');
        $uploads_baseurl = (string) ($uploads['baseurl'] ?? '');

        $logs_dir = rtrim($uploads_basedir, '/').'/sosprescription-logs';
        $templates_override_dir = rtrim($uploads_basedir, '/').'/sosprescription-templates';

        $private_dir = '';
        try {
            $private_dir = FileStorage::base_dir();
        } catch (\Throwable $e) {
            // Do not fail diagnostics if storage is misconfigured.
            $private_dir = '';
        }

        $mpdf = [
            'available' => class_exists('Mpdf\\Mpdf'),
            'version'   => class_exists('Mpdf\\Mpdf') ? (string) (\Mpdf\Mpdf::VERSION ?? '') : '',
        ];

        $php_ext = [
            'mbstring' => extension_loaded('mbstring'),
            'intl'     => extension_loaded('intl'),
            'gd'       => extension_loaded('gd'),
            'curl'     => extension_loaded('curl'),
            'zip'      => extension_loaded('zip'),
        ];

        $tesseract_assets = self::collect_tesseract_assets();

        // Minimal options that matter for support. Must remain PII-free.
        $options = [
            'ocr_client_keywords' => (string) get_option('sosprescription_ocr_client_keywords', ''),
            'logs_retention_days' => (int) apply_filters('sosprescription_logs_retention_days', 30),
        ];

        // Strip excessive whitespace from the OCR keywords (support-friendly export).
        $options['ocr_client_keywords'] = trim($options['ocr_client_keywords']);

        // Environment introspection (no PII): theme + plugin stack.
        $theme = self::collect_theme_info();
        $plugins = self::collect_plugins_info();
        $mu_plugins = self::collect_mu_plugins_info();

        return [
            'req_id' => $req_id,
            'generated_at' => $now_iso,
            'plugin' => [
                'version' => defined('SOSPRESCRIPTION_VERSION') ? (string) SOSPRESCRIPTION_VERSION : '',
                'path'    => defined('SOSPRESCRIPTION_PATH') ? (string) SOSPRESCRIPTION_PATH : '',
            ],
            'options' => $options,
            'theme' => $theme,
            'plugins' => $plugins,
            'mu_plugins' => $mu_plugins,
            'wordpress' => [
                'version' => get_bloginfo('version'),
                'multisite' => is_multisite(),
                'site_url' => site_url(),
                'home_url' => home_url(),
                'wp_debug' => (bool) (defined('WP_DEBUG') ? WP_DEBUG : false),
            ],
            'php' => [
                'version' => PHP_VERSION,
                'memory_limit' => (string) ini_get('memory_limit'),
                'max_execution_time' => (string) ini_get('max_execution_time'),
                'upload_max_filesize' => (string) ini_get('upload_max_filesize'),
                'post_max_size' => (string) ini_get('post_max_size'),
                'extensions' => $php_ext,
            ],
            'paths' => [
                'uploads_basedir' => $uploads_basedir,
                'uploads_baseurl' => $uploads_baseurl,
                'logs_dir' => $logs_dir,
                'templates_override_dir' => $templates_override_dir,
                'private_dir' => $private_dir,
                'writable' => [
                    'uploads_basedir' => $uploads_basedir !== '' ? is_writable($uploads_basedir) : false,
                    'logs_dir' => is_dir($logs_dir) ? is_writable($logs_dir) : false,
                    'templates_override_dir' => is_dir($templates_override_dir) ? is_writable($templates_override_dir) : false,
                    'private_dir' => ($private_dir !== '' && is_dir($private_dir)) ? is_writable($private_dir) : false,
                ],
                'exists' => [
                    'logs_dir' => is_dir($logs_dir),
                    'templates_override_dir' => is_dir($templates_override_dir),
                    'private_dir' => ($private_dir !== '' ? is_dir($private_dir) : false),
                ],
            ],
            'engines' => [
                'mpdf' => $mpdf,
            ],
            'assets' => [
                'tesseract' => $tesseract_assets,
            ],
            'notes' => [
                'PII' => 'No patient data is included in this diagnostics export by design.',
            ],
        ];
    }

    /**
     * @return array<string,mixed>
     */
    private static function collect_theme_info(): array
    {
        try {
            $theme = wp_get_theme();
            if (!$theme || !$theme->exists()) {
                return [
                    'available' => false,
                    'reason' => 'Theme not available',
                ];
            }

            $parent = $theme->parent();

            return [
                'available' => true,
                'name' => (string) $theme->get('Name'),
                'version' => (string) $theme->get('Version'),
                'stylesheet' => (string) $theme->get_stylesheet(),
                'template' => (string) $theme->get_template(),
                'is_child' => $parent ? true : false,
                'parent' => $parent ? [
                    'name' => (string) $parent->get('Name'),
                    'version' => (string) $parent->get('Version'),
                    'stylesheet' => (string) $parent->get_stylesheet(),
                    'template' => (string) $parent->get_template(),
                ] : null,
            ];
        } catch (\Throwable $e) {
            return [
                'available' => false,
                'reason' => 'Exception: '.$e->getMessage(),
            ];
        }
    }

    /**
     * @return array<string,mixed>
     */
    private static function collect_plugins_info(): array
    {
        // get_plugins() is not loaded on front-end by default.
        if (!function_exists('get_plugins')) {
            $plugin_file = ABSPATH . 'wp-admin/includes/plugin.php';
            if (file_exists($plugin_file)) {
                require_once $plugin_file;
            }
        }

        $active = (array) get_option('active_plugins', []);
        $all = function_exists('get_plugins') ? (array) get_plugins() : [];

        $active_out = [];

        foreach ($active as $basename) {
            $basename = (string) $basename;
            $row = $all[$basename] ?? null;
            $active_out[] = [
                'basename' => $basename,
                'name' => is_array($row) ? (string) ($row['Name'] ?? $basename) : $basename,
                'version' => is_array($row) ? (string) ($row['Version'] ?? '') : '',
            ];
        }

        return [
            'active_count' => count($active_out),
            'active' => $active_out,
        ];
    }

    /**
     * @return array<string,mixed>
     */
    private static function collect_mu_plugins_info(): array
    {
        $dir = defined('WPMU_PLUGIN_DIR') ? (string) WPMU_PLUGIN_DIR : (WP_CONTENT_DIR.'/mu-plugins');

        if (!is_dir($dir)) {
            return [
                'count' => 0,
                'files' => [],
            ];
        }

        $files = glob(rtrim($dir, '/'). '/*.php') ?: [];
        $names = array_map('basename', $files);
        sort($names);

        return [
            'count' => count($names),
            'files' => $names,
        ];
    }

    /**
     * @return array<string,mixed>
     */
    private static function collect_tesseract_assets(): array
    {
        if (!defined('SOSPRESCRIPTION_PATH')) {
            return [
                'available' => false,
                'reason' => 'SOSPRESCRIPTION_PATH not defined',
            ];
        }

        $base = rtrim((string) SOSPRESCRIPTION_PATH, '/');

        $files = [
            'tesseract.min.js' => $base.'/assets/js/libs/tesseract.min.js',
            'worker.min.js' => $base.'/assets/js/libs/worker.min.js',
            'tesseract-core.wasm.js' => $base.'/assets/js/libs/tesseract-core.wasm.js',
            'tesseract-core.wasm' => $base.'/assets/js/libs/tesseract-core.wasm',
            'fra.traineddata.gz' => $base.'/assets/lang/fra.traineddata.gz',
        ];

        $out = [
            'available' => true,
            'files' => [],
        ];

        foreach ($files as $key => $path) {
            $out['files'][$key] = [
                'path' => $path,
                'exists' => file_exists($path),
                'size' => file_exists($path) ? (int) filesize($path) : 0,
            ];
        }

        return $out;
    }
}
