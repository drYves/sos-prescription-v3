<?php
declare(strict_types=1);

namespace SOSPrescription\Assets;

use SOSPrescription\Services\ComplianceConfig;
use SOSPrescription\Services\NoticesConfig;
use SOSPrescription\Services\NotificationsConfig;
use SOSPrescription\Services\OcrConfig;
use SOSPrescription\Utils\Date;

final class Assets
{
    public const ENTRY_FORM = 'src/entries/form.tsx';
    public const ENTRY_ADMIN = 'src/entries/admin.tsx';

    private static bool $module_filter_registered = false;

    public static function enqueue_form_app(): void
    {
        wp_enqueue_style(
            'sosprescription-ui-kit',
            SOSPRESCRIPTION_URL . 'assets/ui-kit.css',
            [],
            SOSPRESCRIPTION_VERSION
        );

        $deps = [];

        if (self::maybe_enqueue_turnstile()) {
            $deps[] = 'sosprescription-turnstile';
        }

        wp_enqueue_script(
            'sosprescription-tesseract',
            SOSPRESCRIPTION_URL . 'assets/js/libs/tesseract/tesseract.min.js',
            [],
            SOSPRESCRIPTION_VERSION,
            true
        );

        wp_enqueue_script(
            'sosprescription-client-ocr',
            SOSPRESCRIPTION_URL . 'assets/js/sosprescription-client-ocr.js',
            ['sosprescription-tesseract'],
            SOSPRESCRIPTION_VERSION,
            true
        );

        $deps[] = 'sosprescription-client-ocr';

        self::enqueue_vite_entry('sosprescription-form', self::ENTRY_FORM, $deps);

        wp_enqueue_style(
            'sosprescription-form-overrides',
            SOSPRESCRIPTION_URL . 'assets/form-overrides.css',
            [],
            SOSPRESCRIPTION_VERSION
        );

        wp_enqueue_style(
            'sosprescription-notices',
            SOSPRESCRIPTION_URL . 'assets/notices.css',
            ['sosprescription-form-overrides'],
            SOSPRESCRIPTION_VERSION
        );

        wp_enqueue_script(
            'sosprescription-notices',
            SOSPRESCRIPTION_URL . 'assets/notices.js',
            [],
            SOSPRESCRIPTION_VERSION,
            true
        );
    }

    private static function maybe_enqueue_turnstile(): bool
    {
        if (function_exists('sosprescription_turnstile_enqueue')) {
            \sosprescription_turnstile_enqueue();
        } else {
            self::enqueue_turnstile_fallback();
        }

        return wp_script_is('sosprescription-turnstile', 'enqueued')
            || wp_script_is('sosprescription-turnstile', 'registered');
    }

    public static function enqueue_admin_app(): void
    {
        wp_enqueue_style(
            'sosprescription-ui-kit',
            SOSPRESCRIPTION_URL . 'assets/ui-kit.css',
            [],
            SOSPRESCRIPTION_VERSION
        );

        self::enqueue_vite_entry('sosprescription-admin', self::ENTRY_ADMIN, []);
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
        $key = '';
        if (defined('SOSPRESCRIPTION_TURNSTILE_SITE_KEY')) {
            $key = (string) SOSPRESCRIPTION_TURNSTILE_SITE_KEY;
        }
        if (function_exists('sosprescription_turnstile_site_key')) {
            $maybe = (string) \sosprescription_turnstile_site_key();
            if ($maybe !== '') {
                $key = $maybe;
            }
        }

        return $key;
    }

    private static function enqueue_vite_entry(string $handle, string $entry, array $deps = []): void
    {
        $devServer = defined('SOSPRESCRIPTION_DEV_SERVER') ? (string) SOSPRESCRIPTION_DEV_SERVER : '';
        $isDev = defined('SOSPRESCRIPTION_DEV') && SOSPRESCRIPTION_DEV === true && $devServer !== '';

        if ($isDev) {
            wp_enqueue_script('vite-client', rtrim($devServer, '/') . '/@vite/client', [], null, true);
            self::mark_script_as_module('vite-client');
            wp_enqueue_script($handle, rtrim($devServer, '/') . '/' . $entry, $deps, null, true);
            self::mark_script_as_module($handle);
            self::localize_app($handle);
            return;
        }

        $manifest = new AssetManifest(SOSPRESCRIPTION_PATH . 'build/manifest.json');
        $item = $manifest->get($entry);

        if (!$item || empty($item['file'])) {
            return;
        }

        $moduleSrc = SOSPRESCRIPTION_URL . 'build/' . ltrim((string) $item['file'], '/');

        $loaderHandle = $handle . '-loader';
        $loaderFile = '';
        $bootVar = '';
        $rootId = '';

        if ($handle === 'sosprescription-form') {
            $loaderFile = 'assets/vite-form-loader.js';
            $bootVar = 'SosPrescriptionViteForm';
            $rootId = 'sosprescription-root-form';
        } elseif ($handle === 'sosprescription-admin') {
            $loaderFile = 'assets/vite-admin-loader.js';
            $bootVar = 'SosPrescriptionViteAdmin';
            $rootId = 'sosprescription-root-admin';
        }

        if ($loaderFile !== '' && $bootVar !== '' && $rootId !== '') {
            wp_enqueue_script($loaderHandle, SOSPRESCRIPTION_URL . $loaderFile, $deps, SOSPRESCRIPTION_VERSION, true);

            foreach (self::collect_css_files($manifest, $entry) as $cssFile) {
                $cssFile = (string) $cssFile;
                if ($cssFile === '') {
                    continue;
                }
                wp_enqueue_style(
                    'sosprescription-vite-css-' . substr(md5($cssFile), 0, 12),
                    SOSPRESCRIPTION_URL . 'build/' . ltrim($cssFile, '/'),
                    [],
                    SOSPRESCRIPTION_VERSION
                );
            }

            self::localize_app($loaderHandle);
            self::localize_boot($loaderHandle, $bootVar, [
                'moduleUrl' => add_query_arg('ver', SOSPRESCRIPTION_VERSION, $moduleSrc),
                'rootId' => $rootId,
            ]);
            return;
        }

        wp_enqueue_script($handle, $moduleSrc, $deps, SOSPRESCRIPTION_VERSION, true);
        self::mark_script_as_module($handle);

        foreach (self::collect_css_files($manifest, $entry) as $cssFile) {
            $cssFile = (string) $cssFile;
            if ($cssFile === '') {
                continue;
            }
            wp_enqueue_style(
                'sosprescription-vite-css-' . substr(md5($cssFile), 0, 12),
                SOSPRESCRIPTION_URL . 'build/' . ltrim($cssFile, '/'),
                [],
                SOSPRESCRIPTION_VERSION
            );
        }

        self::localize_app($handle);
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

        if (strpos($globalVar, 'SOSPrescription') === 0) {
            $legacyVar = 'SosPrescription' . substr($globalVar, strlen('SOSPrescription'));
            if ($legacyVar !== $globalVar) {
                $script .= 'window.' . $legacyVar . ' = window.' . $globalVar . ';';
            }
        } elseif (strpos($globalVar, 'SosPrescription') === 0) {
            $modernVar = 'SOSPrescription' . substr($globalVar, strlen('SosPrescription'));
            if ($modernVar !== $globalVar) {
                $script .= 'window.' . $modernVar . ' = window.' . $globalVar . ';';
            }
        }

        wp_add_inline_script($handle, $script, 'before');
    }

    private static function mark_script_as_module(string $handle): void
    {
        if (function_exists('wp_script_add_data')) {
            wp_script_add_data($handle, 'type', 'module');
        }

        if (self::$module_filter_registered) {
            return;
        }
        self::$module_filter_registered = true;

        add_filter('script_loader_tag', static function (string $tag, string $h): string {
            $moduleHandles = ['vite-client', 'sosprescription-form', 'sosprescription-admin'];
            if (!in_array($h, $moduleHandles, true)) {
                return $tag;
            }
            if (str_contains($tag, 'type="module"') || str_contains($tag, "type='module'")) {
                return $tag;
            }
            $new = preg_replace('/^<script\b/', '<script type="module"', $tag, 1);
            return is_string($new) && $new !== '' ? $new : $tag;
        }, 10, 2);
    }

    /**
     * @return array<int, string>
     */
    private static function collect_css_files(AssetManifest $manifest, string $entry): array
    {
        $item = $manifest->get($entry);
        if (!$item) {
            return [];
        }

        $seenItems = [];
        $css = [];

        $walk = static function (array $it) use (&$walk, &$seenItems, &$css, $manifest): void {
            if (!empty($it['css']) && is_array($it['css'])) {
                foreach ($it['css'] as $cssFile) {
                    if (is_string($cssFile) && $cssFile !== '') {
                        $css[$cssFile] = true;
                    }
                }
            }

            if (!empty($it['imports']) && is_array($it['imports'])) {
                foreach ($it['imports'] as $impKey) {
                    if (!is_string($impKey) || $impKey === '' || isset($seenItems[$impKey])) {
                        continue;
                    }
                    $seenItems[$impKey] = true;
                    $imp = $manifest->get($impKey);
                    if (is_array($imp)) {
                        $walk($imp);
                    }
                }
            }
        };

        $walk($item);

        return array_values(array_keys($css));
    }

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

        $capManage = current_user_can('sosprescription_manage') || current_user_can('manage_options');
        $capManageData = current_user_can('sosprescription_manage_data') || current_user_can('manage_options');
        $capValidate = current_user_can('sosprescription_validate') || current_user_can('manage_options');

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
                'manage' => (bool) $capManage,
                'manageData' => (bool) $capManageData,
                'validate' => (bool) $capValidate,
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

        wp_add_inline_script($handle, 'window.SOSPrescription = ' . $json . ';window.SosPrescription = window.SOSPrescription;', 'before');
    }
}
