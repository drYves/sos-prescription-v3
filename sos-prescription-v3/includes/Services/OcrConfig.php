<?php

declare(strict_types=1);

namespace SosPrescription\Services;

/**
 * OCR configuration (client-side, Tesseract.js).
 *
 * - No server-side OCR (mutualised hosting compatible).
 * - Keywords list is configurable via WP Admin.
 * - Assets are bundled locally (no CDN).
 */
final class OcrConfig
{
    private const OPTION_KEY_ENABLED  = 'sosprescription_ocr_client_enabled';
    private const OPTION_KEY_DEBUG    = 'sosprescription_ocr_client_debug';
    private const OPTION_KEY_KEYWORDS = 'sosprescription_ocr_client_keywords';

    /**
     * Throttle key to avoid spamming logs when OCR assets are missing.
     *
     * @var string
     */
    private const TRANSIENT_OCR_ASSET_ALERT = 'sosprescription_ocr_alert_sent';

    public static function is_enabled(): bool
    {
        return (bool) get_option(self::OPTION_KEY_ENABLED, true);
    }

    public static function is_debug_enabled(): bool
    {
        return (bool) get_option(self::OPTION_KEY_DEBUG, false);
    }

    public static function get_keywords_raw(): string
    {
        return (string) get_option(self::OPTION_KEY_KEYWORDS, '');
    }

    public static function option_key_enabled(): string
    {
        return self::OPTION_KEY_ENABLED;
    }

    public static function option_key_debug(): string
    {
        return self::OPTION_KEY_DEBUG;
    }

    public static function option_key_keywords(): string
    {
        return self::OPTION_KEY_KEYWORDS;
    }

    /**
     * Returns keywords regex (without delimiters), built from admin option.
     *
     * Example: "docteur|dr\.|médecin".
     */
    public static function get_keywords_regex(): string
    {
        $raw = self::get_keywords_raw();

        $keywords = self::parse_keywords_input($raw);
        if ($keywords === []) {
            $keywords = self::default_keywords();
        }

        return self::build_keywords_regex($keywords);
    }

    /**
     * @return array<int, string>
     */
    private static function default_keywords(): array
    {
        return [
            'docteur',
            'dr',
            'medecin',
            'médecin',
            'ordonnance',
            'prescription',
            'rpps',
            'finess',
        ];
    }

    /**
     * @param string $raw
     * @return array<int, string>
     */
    private static function parse_keywords_input(string $raw): array
    {
        // Accept commas OR newlines.
        $raw = str_replace(["\r\n", "\r"], "\n", $raw);
        $raw = str_replace(',', "\n", $raw);

        $parts = array_map('trim', explode("\n", $raw));
        $parts = array_values(array_filter($parts, static fn ($s) => $s !== ''));

        return $parts;
    }

    /**
     * Build a safe regex from keywords.
     *
     * IMPORTANT: The returned string has no delimiters or flags.
     *
     * @param array<int, string> $keywords
     */
    private static function build_keywords_regex(array $keywords): string
    {
        $escaped = [];
        foreach ($keywords as $kw) {
            $kw = trim((string) $kw);
            if ($kw === '') {
                continue;
            }
            $escaped[] = preg_quote($kw, '/');
        }

        if ($escaped === []) {
            // Best-effort fallback (should not happen).
            $escaped = array_map(static fn ($kw) => preg_quote($kw, '/'), self::default_keywords());
        }

        return implode('|', $escaped);
    }

    /**
     * Public configuration exposed to the frontend.
     *
     * @return array<string, mixed>
     */
    public static function public_data(): array
    {
        $enabled = self::is_enabled();
        $debug   = self::is_debug_enabled();

        $base = trailingslashit((string) (defined('SOSPRESCRIPTION_URL') ? SOSPRESCRIPTION_URL : plugins_url('/', __FILE__)));

        // Detect missing assets (failsafe). We log once per 12h to avoid noise.
        $missingAssets = [];
        if ($enabled) {
            $missingAssets = self::detect_missing_assets();
            if ($missingAssets !== []) {
                self::log_missing_assets_once($missingAssets);
            }
        }

        return [
            'client' => [
                'enabled' => $enabled,
                'debug' => $debug,
                // Local assets (no CDN)
                'worker_path' => $base . 'assets/js/libs/tesseract/worker.min.js',
                'core_path' => $base . 'assets/js/libs/tesseract/tesseract-core.wasm.js',
                'lang_path' => $base . 'assets/lang',
                'lang' => 'fra',
                // Dynamic keywords regex (configured in Admin)
                'keywords_regex' => self::get_keywords_regex(),
                // Extra diagnostics (non-breaking for existing JS)
                'assets_ok' => $missingAssets === [],
                'missing_assets' => $missingAssets,
                // ReqID tracing (when available in Logger)
                'req_id_enabled' => class_exists(Logger::class),
            ],
        ];
    }

    /**
     * Detect required OCR assets missing (or unreadable) on the server.
     *
     * IMPORTANT: We only return relative paths (no absolute server paths)
     * to avoid leaking filesystem structure to front users.
     *
     * @return array<int, string> Relative paths missing.
     */
    private static function detect_missing_assets(): array
    {
        if (!defined('SOSPRESCRIPTION_PATH')) {
            // Defensive: should never happen once the plugin bootstrap runs.
            return ['SOSPRESCRIPTION_PATH'];
        }

        $base = trailingslashit((string) SOSPRESCRIPTION_PATH);

        $required = [
            'assets/js/libs/tesseract/tesseract.min.js',
            'assets/js/libs/tesseract/worker.min.js',
            'assets/js/libs/tesseract/tesseract-core.wasm.js',
            'assets/js/libs/tesseract/tesseract-core.wasm',
            'assets/lang/fra.traineddata.gz',
        ];

        $missing = [];
        foreach ($required as $rel) {
            $path = $base . ltrim($rel, '/');
            if (!file_exists($path) || !is_readable($path)) {
                $missing[] = $rel;
            }
        }

        return $missing;
    }

    /**
     * Log missing assets once per 12 hours (throttled by transient).
     *
     * @param array<int, string> $missingAssets
     */
    private static function log_missing_assets_once(array $missingAssets): void
    {
        // If transients are not available (edge cases), fallback to always log once per request.
        $alreadySent = get_transient(self::TRANSIENT_OCR_ASSET_ALERT);
        if ($alreadySent) {
            return;
        }

        $context = [
            'missing_assets' => array_values($missingAssets),
        ];

        // NDJSON (preferred)
        if (class_exists(Logger::class)) {
            Logger::log_scoped(
                'runtime',
                'ocr',
                'error',
                'ocr_client_assets_missing',
                [
                    'message' => 'OCR client-side assets missing (Tesseract.js) — OCR will be degraded/disabled in browser',
                    'missing_assets' => array_values($missingAssets),
                ]
            );
        } else {
            // Fallback (should be rare)
            // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
            error_log('SOSPrescription OCR assets missing: ' . implode(', ', $missingAssets));
        }

        set_transient(self::TRANSIENT_OCR_ASSET_ALERT, 1, 12 * HOUR_IN_SECONDS);
    }
}
