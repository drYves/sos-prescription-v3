<?php
// includes/Assets/Assets.php
declare(strict_types=1);

namespace SOSPrescription\Assets;

use SOSPrescription\Services\ComplianceConfig;
use SOSPrescription\Services\NoticesConfig;
use SOSPrescription\Services\NotificationsConfig;
use SOSPrescription\Services\OcrConfig;
use SOSPrescription\Utils\Date;

final class Assets
{
    public const ENTRY_FORM  = 'src/entries/form.tsx';
    public const ENTRY_ADMIN = 'src/entries/admin.tsx';

    private static bool $moduleFilterRegistered = false;
    private static ?string $pluginRootPath = null;
    private static ?string $pluginRootUrl = null;
    private static ?string $manifestPath = null;

    public static function enqueue_form_app(): void
    {
        wp_enqueue_style(
            'sosprescription-ui-kit',
            self::asset_url('assets/ui-kit.css'),
            [],
            SOSPRESCRIPTION_VERSION
        );

        $deps = [];

        if (self::maybe_enqueue_turnstile()) {
            $deps[] = 'sosprescription-turnstile';
        }

        wp_enqueue_script(
            'sosprescription-tesseract',
            self::asset_url('assets/js/libs/tesseract/tesseract.min.js'),
            [],
            SOSPRESCRIPTION_VERSION,
            true
        );

        wp_enqueue_script(
            'sosprescription-client-ocr',
            self::asset_url('assets/js/sosprescription-client-ocr.js'),
            ['sosprescription-tesseract'],
            SOSPRESCRIPTION_VERSION,
            true
        );

        $deps[] = 'sosprescription-client-ocr';

        self::enqueue_vite_entry('sosprescription-form', self::ENTRY_FORM, $deps);

        wp_enqueue_style(
            'sosprescription-form-overrides',
            self::asset_url('assets/form-overrides.css'),
            [],
            SOSPRESCRIPTION_VERSION
        );

        wp_enqueue_style(
            'sosprescription-notices',
            self::asset_url('assets/notices.css'),
            ['sosprescription-form-overrides'],
            SOSPRESCRIPTION_VERSION
        );

        wp_enqueue_script(
            'sosprescription-notices',
            self::asset_url('assets/notices.js'),
            [],
            SOSPRESCRIPTION_VERSION,
            true
        );
    }

    public static function enqueue_admin_app(): void
    {
        wp_enqueue_style(
            'sosprescription-ui-kit',
            self::asset_url('assets/ui-kit.css'),
            [],
            SOSPRESCRIPTION_VERSION
        );

        self::enqueue_vite_entry('sosprescription-admin', self::ENTRY_ADMIN);
    }

    private static function enqueue_vite_entry(string $handle, string $entry, array $deps = []): void
    {
        $devServer = defined('SOSPRESCRIPTION_DEV_SERVER') ? (string) constant('SOSPRESCRIPTION_DEV_SERVER') : '';
        $isDev = defined('SOSPRESCRIPTION_DEV') && SOSPRESCRIPTION_DEV === true && $devServer !== '';

        if ($isDev) {
            wp_enqueue_script('vite-client', rtrim($devServer, '/') . '/@vite/client', [], null, true);
            self::mark_script_as_module('vite-client');

            wp_enqueue_script(
                $handle,
                rtrim($devServer, '/') . '/' . ltrim($entry, '/'),
                $deps,
                null,
                true
            );
            self::mark_script_as_module($handle);
            self::localize_app($handle);
            return;
        }

        $loader = self::loader_bootstrap($handle);
        $manifest = self::resolve_manifest();
        $item = $manifest ? $manifest->get($entry) : null;
        $moduleUrl = '';

        if (is_array($item) && !empty($item['file']) && is_string($item['file'])) {
            $moduleUrl = add_query_arg(
                'ver',
                SOSPRESCRIPTION_VERSION,
                self::asset_url('build/' . ltrim($item['file'], '/'))
            );
        } elseif ($manifest !== null) {
            self::log_asset_issue('Vite entry not found in manifest.', [
                'entry' => $entry,
                'manifest_path' => self::manifest_path(),
            ]);
        }

        if ($loader !== null) {
            $loaderHandle = $handle . '-loader';

            wp_enqueue_script(
                $loaderHandle,
                self::asset_url($loader['loader_file']),
                $deps,
                SOSPRESCRIPTION_VERSION,
                true
            );

            if ($manifest !== null && is_array($item) && !empty($item['file'])) {
                foreach (self::collect_css_files($manifest, $entry) as $cssFile) {
                    $cssHandle = 'sosprescription-vite-css-' . substr(md5((string) $cssFile), 0, 12);
                    wp_enqueue_style(
                        $cssHandle,
                        self::asset_url('build/' . ltrim((string) $cssFile, '/')),
                        [],
                        SOSPRESCRIPTION_VERSION
                    );
                }
            }

            self::localize_app($loaderHandle);
            self::localize_boot($loaderHandle, $loader['boot_var'], [
                'moduleUrl' => $moduleUrl,
                'rootId' => $loader['root_id'],
            ]);
            return;
        }

        if ($moduleUrl === '') {
            return;
        }

        wp_enqueue_script($handle, $moduleUrl, $deps, SOSPRESCRIPTION_VERSION, true);
        self::mark_script_as_module($handle);

        if ($manifest !== null) {
            foreach (self::collect_css_files($manifest, $entry) as $cssFile) {
                $cssHandle = 'sosprescription-vite-css-' . substr(md5((string) $cssFile), 0, 12);
                wp_enqueue_style(
                    $cssHandle,
                    self::asset_url('build/' . ltrim((string) $cssFile, '/')),
                    [],
                    SOSPRESCRIPTION_VERSION
                );
            }
        }

        self::localize_app($handle);
    }

    private static function maybe_enqueue_turnstile(): bool
    {
        if (function_exists('sosprescription_turnstile_enqueue')) {
            \sosprescription_turnstile_enqueue();
        } else {
            self::enqueue_turnstile_fallback();
        }

        return wp_script_is('sosprescription-turnstile', 'registered')
            || wp_script_is('sosprescription-turnstile', 'enqueued');
    }

    private static function enqueue_turnstile_fallback(): void
    {
        $siteKey = self::get_turnstile_site_key();
        if ($siteKey === '') {
            return;
        }

        wp_enqueue_script(
            'sosprescription-turnstile',
            'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
            [],
            null,
            true
        );
    }

    private static function get_turnstile_site_key(): string
    {
        $key = defined('SOSPRESCRIPTION_TURNSTILE_SITE_KEY')
            ? (string) constant('SOSPRESCRIPTION_TURNSTILE_SITE_KEY')
            : '';

        if (function_exists('sosprescription_turnstile_site_key')) {
            $maybe = (string) \sosprescription_turnstile_site_key();
            if ($maybe !== '') {
                $key = $maybe;
            }
        }

        return $key;
    }

    private static function plugin_root_path(): string
    {
        if (self::$pluginRootPath !== null) {
            return self::$pluginRootPath;
        }

        $path = defined('SOSPRESCRIPTION_PATH') ? (string) constant('SOSPRESCRIPTION_PATH') : '';
        if ($path === '') {
            $path = dirname(__DIR__, 2) . DIRECTORY_SEPARATOR;
        }

        self::$pluginRootPath = trailingslashit(wp_normalize_path($path));
        return self::$pluginRootPath;
    }

    private static function plugin_root_url(): string
    {
        if (self::$pluginRootUrl !== null) {
            return self::$pluginRootUrl;
        }

        $url = defined('SOSPRESCRIPTION_URL') ? (string) constant('SOSPRESCRIPTION_URL') : '';
        if ($url === '') {
            $url = plugins_url('', self::plugin_root_path() . 'sosprescription.php');
        }

        self::$pluginRootUrl = trailingslashit($url);
        return self::$pluginRootUrl;
    }

    private static function asset_url(string $relativePath): string
    {
        $relativePath = ltrim(str_replace('\\', '/', $relativePath), '/');
        return self::plugin_root_url() . $relativePath;
    }

    private static function manifest_path(): string
    {
        if (self::$manifestPath !== null) {
            return self::$manifestPath;
        }

        self::$manifestPath = self::plugin_root_path() . 'build' . DIRECTORY_SEPARATOR . 'manifest.json';
        return self::$manifestPath;
    }

    private static function resolve_manifest(): ?AssetManifest
    {
        $path = self::manifest_path();

        if (!is_file($path)) {
            self::log_asset_issue('Vite manifest missing.', ['manifest_path' => $path]);
            return null;
        }

        if (!is_readable($path)) {
            self::log_asset_issue('Vite manifest not readable.', ['manifest_path' => $path]);
            return null;
        }

        return new AssetManifest($path);
    }

    /**
     * @return array{loader_file:string,boot_var:string,root_id:string}|null
     */
    private static function loader_bootstrap(string $handle): ?array
    {
        if ($handle === 'sosprescription-form') {
            return [
                'loader_file' => 'assets/vite-form-loader.js',
                'boot_var' => 'SOSPrescriptionViteForm',
                'root_id' => 'sosprescription-root-form',
            ];
        }

        if ($handle === 'sosprescription-admin') {
            return [
                'loader_file' => 'assets/vite-admin-loader.js',
                'boot_var' => 'SOSPrescriptionViteAdmin',
                'root_id' => 'sosprescription-root-admin',
            ];
        }

        return null;
    }

    /**
     * @param array<string, mixed> $context
     */
    private static function log_asset_issue(string $message, array $context = []): void
    {
        $suffix = '';

        if ($context !== []) {
            $json = wp_json_encode($context, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            if (is_string($json) && $json !== '') {
                $suffix = ' ' . $json;
            }
        }

        error_log('[SOSPrescription] ' . $message . $suffix);
    }

    /**
     * @param array<string, mixed> $data
     */
    private static function localize_boot(string $handle, string $globalVar, array $data): void
    {
        $json = wp_json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if (!is_string($json)) {
            $json = '{}';
        }

        $globalVar = preg_replace('/[^A-Za-z0-9_]/', '', $globalVar);
        if (!is_string($globalVar) || $globalVar === '') {
            return;
        }

        $script = 'window.' . $globalVar . ' = ' . $json . ';';

        $legacy = self::legacy_boot_global($globalVar);
        if ($legacy !== '' && $legacy !== $globalVar) {
            $script .= 'window.' . $legacy . ' = window.' . $globalVar . ';';
        }

        wp_add_inline_script($handle, $script, 'before');
    }

    private static function legacy_boot_global(string $globalVar): string
    {
        $prefix = 'SOSPrescription';
        if (strpos($globalVar, $prefix) !== 0) {
            return '';
        }

        return 'SosPrescription' . substr($globalVar, strlen($prefix));
    }

    private static function mark_script_as_module(string $handle): void
    {
        if (function_exists('wp_script_add_data')) {
            wp_script_add_data($handle, 'type', 'module');
        }

        if (self::$moduleFilterRegistered) {
            return;
        }
        self::$moduleFilterRegistered = true;

        add_filter('script_loader_tag', static function (string $tag, string $currentHandle): string {
            $moduleHandles = ['vite-client', 'sosprescription-form', 'sosprescription-admin'];

            if (!in_array($currentHandle, $moduleHandles, true)) {
                return $tag;
            }

            if (str_contains($tag, 'type="module"') || str_contains($tag, "type='module'")) {
                return $tag;
            }

            $patched = preg_replace('/^<script\b/', '<script type="module"', $tag, 1);
            return is_string($patched) && $patched !== '' ? $patched : $tag;
        }, 10, 2);
    }

    /**
     * @return array<int, string>
     */
    private static function collect_css_files(AssetManifest $manifest, string $entry): array
    {
        $item = $manifest->get($entry);
        if (!is_array($item)) {
            return [];
        }

        $seen = [];
        $css = [];

        $walk = static function (array $node) use (&$walk, &$seen, &$css, $manifest): void {
            if (!empty($node['css']) && is_array($node['css'])) {
                foreach ($node['css'] as $file) {
                    if (is_string($file) && $file !== '') {
                        $css[$file] = true;
                    }
                }
            }

            if (!empty($node['imports']) && is_array($node['imports'])) {
                foreach ($node['imports'] as $key) {
                    if (!is_string($key) || $key === '' || isset($seen[$key])) {
                        continue;
                    }

                    $seen[$key] = true;
                    $import = $manifest->get($key);

                    if (is_array($import)) {
                        $walk($import);
                    }
                }
            }
        };

        $walk($item);

        return array_values(array_keys($css));
    }

    /**
     * @return array<string, string>
     */
    private static function i18n_data(): array
    {
        return [
            'error_generic_title' => __('Erreur', 'sosprescription'),
            'error_generic_message' => __('Une erreur est survenue.', 'sosprescription'),
            'label_support_id' => __('ID de support :', 'sosprescription'),
            'btn_copy' => __('Copier', 'sosprescription'),
            'btn_copied' => __('Copié !', 'sosprescription'),
            'error_api_title' => __('Erreur API', 'sosprescription'),
            'error_network_title' => __('Erreur réseau', 'sosprescription'),
            'error_network_message' => __('Connexion impossible. Merci de réessayer.', 'sosprescription'),
            'error_loading_title' => __('Erreur de chargement', 'sosprescription'),
            'error_loading_console_hint' => __('Ouvrez la console du navigateur (F12) pour voir le détail.', 'sosprescription'),
            'error_ocr_title' => __('Erreur OCR', 'sosprescription'),
            'error_bundle_missing' => __('URL du module manquante.', 'sosprescription'),
            'error_bundle_load_fail' => __('Impossible de charger le module.', 'sosprescription'),
            'error_js_boot' => __('Erreur JavaScript lors du démarrage.', 'sosprescription'),
            'ocr_unavailable' => __('OCR local indisponible. Merci de réessayer.', 'sosprescription'),
            'ocr_timeout' => __('L’analyse prend trop de temps. L’image est peut-être trop lourde ou floue. Veuillez réessayer.', 'sosprescription'),
            'rx_delivery_loading' => __('Validation en cours…', 'sosprescription'),
            'rx_delivery_success' => __('✅ Ordonnance marquée comme délivrée.', 'sosprescription'),
            'rx_delivery_invalid_code' => __('Code incorrect.', 'sosprescription'),
            'rx_delivery_api_error' => __('Erreur API. Merci de réessayer.', 'sosprescription'),
        ];
    }

    private static function localize_app(string $handle): void
    {
        $user = wp_get_current_user();

        $birthIso = $user && $user->ID ? (string) get_user_meta((int) $user->ID, 'sosp_birthdate', true) : '';
        $birthPrecision = $user && $user->ID ? (string) get_user_meta((int) $user->ID, 'sosp_birthdate_precision', true) : '';
        $birthFr = $birthIso !== '' ? Date::iso_to_fr($birthIso) : '';
        $weightKg = $user && $user->ID ? (string) get_user_meta((int) $user->ID, 'sosp_weight_kg', true) : '';
        $heightCm = $user && $user->ID ? (string) get_user_meta((int) $user->ID, 'sosp_height_cm', true) : '';
        $turnstileSiteKey = self::get_turnstile_site_key();

        $data = [
            'restBase' => esc_url_raw(rest_url('sosprescription/v1')),
            'nonce' => wp_create_nonce('wp_rest'),
            'site' => [
                'urls' => [
                    'patientPortal' => NotificationsConfig::patient_portal_url(),
                ],
                'url' => home_url('/'),
            ],
            'turnstile' => [
                'siteKey' => $turnstileSiteKey,
                'enabled' => $turnstileSiteKey !== '',
            ],
            'currentUser' => [
                'id' => (int) $user->ID,
                'displayName' => (string) $user->display_name,
                'email' => (string) $user->user_email,
                'roles' => array_values((array) $user->roles),
            ],
            'patientProfile' => [
                'birthdate_iso' => $birthIso,
                'birthdate_fr' => $birthFr,
                'birthdate_precision' => $birthPrecision,
                'weight_kg' => $weightKg,
                'height_cm' => $heightCm,
            ],
            'capabilities' => [
                'manage' => current_user_can('sosprescription_manage') || current_user_can('manage_options'),
                'manageData' => current_user_can('sosprescription_manage_data') || current_user_can('manage_options'),
                'validate' => current_user_can('sosprescription_validate') || current_user_can('manage_options'),
            ],
            'compliance' => ComplianceConfig::public_data(),
            'notices' => NoticesConfig::public_data(),
            'ocr' => OcrConfig::public_data(),
            'i18n' => self::i18n_data(),
        ];

        $json = wp_json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if (!is_string($json)) {
            $json = '{}';
        }

        wp_add_inline_script($handle, 'window.SOSPrescription = ' . $json . ';', 'before');
    }
}
