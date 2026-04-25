<?php
declare(strict_types=1);

namespace SOSPrescription\Assets;

use SOSPrescription\Services\ComplianceConfig;
use SosPrescription\Services\LocaleContractBroker;
use SOSPrescription\Services\NoticesConfig;
use SOSPrescription\Services\NotificationsConfig;
use SOSPrescription\Services\OcrConfig;
use SOSPrescription\Services\Turnstile;

final class Assets
{
    /**
     * V4.3 — Bundles monolithiques IIFE (scripts classiques, sans import/export au runtime).
     *
     * IMPORTANT : ces fichiers sont générés par le build front et sont volontairement sans hash.
     * Le cache-busting est assuré par WordPress via SOSPRESCRIPTION_VERSION.
     */
    private const BUILD_FORM_JS = 'build/form.js';
    private const BUILD_FORM_CSS = 'build/form.css';
    private const BUILD_ADMIN_JS = 'build/admin.js';
    private const BUILD_ADMIN_CSS = 'build/admin.css';
    private const BUILD_POC_LOCALE_ISLAND_JS = 'build/pocLocaleIsland.js';
    /**
     * Scripts that must execute immediately for the request flow to hydrate.
     * LiteSpeed delayed JS can otherwise leave the public form stuck on skeleton.
     *
     * @var array<int, string>
     */
    private const LITESPEED_CRITICAL_SCRIPT_HANDLES = [
        'sosprescription-turnstile',
        'sosprescription-tesseract',
        'sosprescription-client-ocr',
        'sosprescription-form',
    ];
    /**
     * Partial strings consumed by LiteSpeed Cache exclusion filters.
     *
     * @var array<int, string>
     */
    private const LITESPEED_CRITICAL_SCRIPT_EXCLUDES = [
        'sosprescription-runtime-config',
        'sosprescription-form-js-before',
        'sosprescription-form-js',
        'window.SOSPrescription',
        'sos-prescription-v3/build/form.js',
        'sos-prescription-v3/assets/js/sosprescription-client-ocr.js',
        'sos-prescription-v3/assets/js/libs/tesseract/tesseract.min.js',
        'challenges.cloudflare.com/turnstile',
    ];

    private static bool $runtime_config_requested = false;
    private static bool $runtime_config_hooks_registered = false;
    private static bool $runtime_config_printed = false;
    private static bool $critical_script_tag_filter_registered = false;
    private static bool $critical_script_litespeed_filters_registered = false;
    private static bool $form_bundle_print_requested = false;
    private static bool $form_bundle_printed = false;

    public static function enqueue_form_app(): void
    {
        self::ensure_critical_script_tag_filter();

        wp_enqueue_style(
            'sosprescription-ui-kit',
            SOSPRESCRIPTION_URL . 'assets/ui-kit.css',
            [],
            SOSPRESCRIPTION_VERSION
        );

        $deps = [];

        $turnstile = self::maybe_enqueue_turnstile();
        if ($turnstile) {
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

        // Configuration runtime (restBase, nonce, currentUser, etc.)
        // imprimée indépendamment des handles + attachée en inline "before".
        self::ensure_global_runtime_config();

        // CSS build (si présent) — chargé AVANT les overrides.
        $formBaseStyleDeps = ['sosprescription-ui-kit'];
        $formBaseStyleHandle = self::maybe_enqueue_build_style(
            'sosprescription-form-app',
            self::BUILD_FORM_CSS,
            $formBaseStyleDeps
        );

        // JS build (monolithique IIFE)
        // Printed manually in footer so the final tag keeps LiteSpeed bypass attributes.
        if (is_file(self::plugin_asset_path(self::BUILD_FORM_JS))) {
            self::request_form_bundle_print();
        }

        // Styles additionnels (legacy / overrides)
        $overridesDeps = [];
        if ($formBaseStyleHandle !== '') {
            $overridesDeps[] = $formBaseStyleHandle;
        }

        wp_enqueue_style(
            'sosprescription-form-overrides',
            SOSPRESCRIPTION_URL . 'assets/form-overrides.css',
            $overridesDeps,
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

        wp_enqueue_script(
            'sosprescription-patient-profile-enhancements',
            SOSPRESCRIPTION_URL . 'assets/patient-profile-enhancements.js',
            [],
            SOSPRESCRIPTION_VERSION,
            true
        );
    }

    public static function enqueue_admin_app(?string $rootId = null): string
    {
        wp_enqueue_style(
            'sosprescription-ui-kit',
            SOSPRESCRIPTION_URL . 'assets/ui-kit.css',
            [],
            SOSPRESCRIPTION_VERSION
        );

        // Le rootId est conservé pour compatibilité d'API, mais en V4.3
        // le bundle admin est un bridge global (pas d'auto-mount).
        $normalizedRootId = is_string($rootId) && trim($rootId) !== ''
            ? trim($rootId)
            : 'sosprescription-root-admin';
        unset($normalizedRootId);

        self::ensure_global_runtime_config();

        // CSS admin build (si présent)
        self::maybe_enqueue_build_style(
            'sosprescription-admin-app',
            self::BUILD_ADMIN_CSS,
            ['sosprescription-ui-kit']
        );

        // JS admin build : expose window.SosDoctorMessagingBridge
        $handle = 'sosprescription-admin';
        if (self::maybe_enqueue_build_script($handle, self::BUILD_ADMIN_JS, [], true)) {
            self::localize_app($handle);
            return $handle;
        }

        return '';
    }

    public static function enqueue_poc_locale_island(): void
    {
        self::ensure_global_runtime_config();

        self::maybe_enqueue_build_script(
            'sosprescription-poc-locale-island',
            self::BUILD_POC_LOCALE_ISLAND_JS,
            [],
            true
        );
    }

    private static function maybe_enqueue_turnstile(): bool
    {
        if (!Turnstile::is_configured()) {
            return false;
        }

        if (function_exists('sosprescription_turnstile_enqueue')) {
            \sosprescription_turnstile_enqueue();
        } else {
            self::enqueue_turnstile_fallback();
        }

        if (wp_script_is('sosprescription-turnstile', 'enqueued')) {
            return true;
        }
        if (wp_script_is('sosprescription-turnstile', 'registered')) {
            return true;
        }

        return false;
    }

    private static function enqueue_turnstile_fallback(): void
    {
        $site_key = Turnstile::site_key();
        if ($site_key === '') {
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

    /**
     * @param array<int, string> $deps
     */
    private static function maybe_enqueue_build_script(
        string $handle,
        string $relativeFile,
        array $deps,
        bool $in_footer
    ): bool {
        $handle = trim($handle);
        if ($handle === '') {
            return false;
        }

        $path = self::plugin_asset_path($relativeFile);
        if (!is_file($path)) {
            return false;
        }

        wp_enqueue_script(
            $handle,
            self::plugin_asset_url($relativeFile),
            $deps,
            SOSPRESCRIPTION_VERSION,
            $in_footer
        );

        return true;
    }

    /**
     * @param array<int, string> $deps
     */
    private static function maybe_enqueue_build_style(string $handle, string $relativeFile, array $deps = []): string
    {
        $handle = trim($handle);
        if ($handle === '') {
            return '';
        }

        $path = self::plugin_asset_path($relativeFile);
        if (!is_file($path)) {
            return '';
        }

        wp_enqueue_style(
            $handle,
            self::plugin_asset_url($relativeFile),
            $deps,
            SOSPRESCRIPTION_VERSION
        );

        return $handle;
    }

    private static function plugin_asset_url(string $relative): string
    {
        $relative = ltrim(trim($relative), '/');
        return SOSPRESCRIPTION_URL . $relative;
    }

    private static function plugin_asset_path(string $relative): string
    {
        $relative = ltrim(trim($relative), '/');
        return SOSPRESCRIPTION_PATH . $relative;
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

    public static function ensure_global_runtime_config(): void
    {
        self::$runtime_config_requested = true;

        if (self::$runtime_config_hooks_registered) {
            return;
        }

        self::$runtime_config_hooks_registered = true;
        $callback = [self::class, 'print_global_runtime_config'];

        add_action('wp_print_scripts', $callback, 0);
        add_action('admin_print_scripts', $callback, 0);
        add_action('wp_print_footer_scripts', $callback, 0);
        add_action('admin_print_footer_scripts', $callback, 0);
    }

    public static function print_global_runtime_config(): void
    {
        if (!self::$runtime_config_requested || self::$runtime_config_printed) {
            return;
        }

        self::$runtime_config_printed = true;
        echo '<script id="sosprescription-runtime-config"' . self::script_litespeed_protection_attributes() . '>' . self::runtime_config_script() . "</script>\n";
    }

    private static function runtime_config_script(): string
    {
        return 'window.SOSPrescription = ' . self::runtime_config_json() . ';window.SosPrescription = window.SOSPrescription;';
    }

    private static function runtime_config_json(): string
    {
        $json = wp_json_encode(self::runtime_config_data(), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if (!is_string($json)) {
            return '{}';
        }

        return str_replace('</', '<\/', $json);
    }

    /**
     * @return array<string, mixed>
     */
    private static function runtime_config_data(): array
    {
        $user = wp_get_current_user();
        $user_id = ($user instanceof \WP_User) ? (int) $user->ID : 0;

        $first_name = $user_id > 0 ? sanitize_text_field((string) get_user_meta($user_id, 'first_name', true)) : '';
        $last_name = $user_id > 0 ? sanitize_text_field((string) get_user_meta($user_id, 'last_name', true)) : '';
        $display_name = $user instanceof \WP_User ? (string) $user->display_name : '';
        $birth_iso = '';
        $birth_precision = '';
        $birth_fr = '';
        $phone = '';
        $weight_kg = '';
        $height_cm = '';

        $full_name = trim($first_name . ' ' . $last_name);
        $public_display_name = self::is_human_display_name($display_name)
            ? $display_name
            : ($full_name !== '' ? $full_name : '');

        $turnstile_enabled = Turnstile::is_enabled();
        $turnstile_site_key = $turnstile_enabled ? Turnstile::site_key() : '';
        $patient_portal_url = NotificationsConfig::patient_portal_url();

        $cap_manage = current_user_can('sosprescription_manage') || current_user_can('manage_options');
        $cap_manage_data = current_user_can('sosprescription_manage_data') || current_user_can('manage_options');
        $cap_validate = current_user_can('sosprescription_validate') || current_user_can('manage_options');

        $data = [
            'restBase' => esc_url_raw(rest_url('sosprescription/v1')),
            'restV4Base' => esc_url_raw(rest_url('sosprescription/v4')),
            'nonce' => wp_create_nonce('wp_rest'),
            'site' => [
                'urls' => [
                    'patientPortal' => $patient_portal_url,
                ],
                'url' => home_url('/'),
            ],
            'urls' => [
                'patientPortal' => $patient_portal_url,
            ],
            'turnstile' => [
                'siteKey' => $turnstile_site_key,
                'enabled' => $turnstile_enabled,
                'configured' => Turnstile::is_configured(),
            ],
            'currentUser' => [
                'id' => $user_id,
                'displayName' => $public_display_name,
                'email' => ($user instanceof \WP_User) ? (string) $user->user_email : '',
                'roles' => ($user instanceof \WP_User) ? array_values((array) $user->roles) : [],
                'firstName' => $first_name,
                'lastName' => $last_name,
                'first_name' => $first_name,
                'last_name' => $last_name,
                'birthDate' => $birth_iso,
                'birthdate' => $birth_iso,
                'sosp_birthdate' => $birth_iso,
                'phone' => $phone,
            ],
            'patientProfile' => [
                'first_name' => $first_name,
                'last_name' => $last_name,
                'fullname' => $full_name,
                'birthdate_iso' => $birth_iso,
                'birthdate_fr' => $birth_fr,
                'birthdate_precision' => $birth_precision,
                'phone' => $phone,
                'weight_kg' => $weight_kg,
                'height_cm' => $height_cm,
            ],
            'capabilities' => [
                'manage' => (bool) $cap_manage,
                'manageData' => (bool) $cap_manage_data,
                'validate' => (bool) $cap_validate,
            ],
            'compliance' => ComplianceConfig::public_data(),
            'notices' => NoticesConfig::public_data(),
            'ocr' => OcrConfig::public_data(),
            'i18n' => self::i18n_data(),
        ];

        $locale_contract = LocaleContractBroker::runtime_contract();
        if (is_array($locale_contract)) {
            $data['localeContract'] = $locale_contract;
        }

        return $data;
    }

    private static function localize_app(string $handle): void
    {
        self::ensure_global_runtime_config();
        wp_add_inline_script($handle, self::runtime_config_script(), 'before');
    }

    private static function request_form_bundle_print(): void
    {
        if (self::$form_bundle_print_requested) {
            return;
        }

        self::$form_bundle_print_requested = true;
        add_action('wp_footer', [self::class, 'print_form_bundle_script'], 100);
    }

    public static function print_form_bundle_script(): void
    {
        if (!self::$form_bundle_print_requested || self::$form_bundle_printed) {
            return;
        }

        self::$form_bundle_printed = true;
        echo '<script id="sosprescription-form-js"' . self::script_litespeed_protection_attributes() . ' src="' . esc_url(self::plugin_asset_url(self::BUILD_FORM_JS)) . '"></script>' . "\n";
    }

    private static function ensure_critical_script_tag_filter(): void
    {
        self::ensure_critical_script_litespeed_filters();

        if (self::$critical_script_tag_filter_registered) {
            return;
        }

        self::$critical_script_tag_filter_registered = true;
        add_filter('script_loader_tag', [self::class, 'protect_litespeed_critical_script_tag'], 10, 3);
    }

    private static function ensure_critical_script_litespeed_filters(): void
    {
        if (self::$critical_script_litespeed_filters_registered) {
            return;
        }

        self::$critical_script_litespeed_filters_registered = true;
        add_filter('litespeed_optimize_js_excludes', [self::class, 'add_litespeed_critical_script_excludes']);
        add_filter('litespeed_optm_js_defer_exc', [self::class, 'add_litespeed_critical_script_excludes']);
        add_filter('litespeed_optm_gm_js_exc', [self::class, 'add_litespeed_critical_script_excludes']);
    }

    /**
     * @param mixed $excludes
     * @return array<int, string>
     */
    public static function add_litespeed_critical_script_excludes($excludes): array
    {
        $list = is_array($excludes) ? array_values($excludes) : [];

        foreach (self::LITESPEED_CRITICAL_SCRIPT_EXCLUDES as $exclude) {
            if (in_array($exclude, $list, true)) {
                continue;
            }
            $list[] = $exclude;
        }

        return $list;
    }

    public static function protect_litespeed_critical_script_tag(string $tag, string $handle, string $src): string
    {
        unset($src);

        if (!in_array($handle, self::LITESPEED_CRITICAL_SCRIPT_HANDLES, true)) {
            return $tag;
        }

        return self::add_script_litespeed_protection_attributes($tag);
    }

    private static function add_script_litespeed_protection_attributes(string $tag): string
    {
        $attributes = [
            'data-no-optimize' => '1',
            'data-no-defer' => '1',
            'data-no-minify' => '1',
            'data-cfasync' => 'false',
        ];

        $missing = '';
        foreach ($attributes as $name => $value) {
            if (strpos($tag, $name . '=') !== false) {
                continue;
            }
            $missing .= ' ' . $name . '="' . esc_attr($value) . '"';
        }

        if ($missing === '') {
            return $tag;
        }

        return preg_replace('/<script\\b/', '<script' . $missing, $tag, 1) ?? $tag;
    }

    private static function script_litespeed_protection_attributes(): string
    {
        return ' data-no-optimize="1" data-no-defer="1" data-no-minify="1" data-cfasync="false"';
    }

    /**
     * @param array<int, string> $keys
     */
    private static function read_user_meta_first(int $user_id, array $keys): string
    {
        if ($user_id < 1) {
            return '';
        }

        foreach ($keys as $key) {
            $value = get_user_meta($user_id, (string) $key, true);
            if (is_scalar($value)) {
                $text = trim((string) $value);
                if ($text !== '') {
                    return $text;
                }
            }
        }

        return '';
    }

    private static function is_human_display_name(string $value): bool
    {
        $clean = trim($value);
        return $clean !== '' && !self::looks_like_email($clean);
    }

    /**
     * @return array{first_name:string,last_name:string}
     */
    private static function split_human_name(string $value): array
    {
        $clean = trim(preg_replace('/\s+/u', ' ', wp_strip_all_tags($value, true)) ?? '');
        if ($clean === '' || self::looks_like_email($clean)) {
            return ['first_name' => '', 'last_name' => ''];
        }

        $parts = preg_split('/\s+/u', $clean) ?: [];
        $parts = array_values(array_filter(array_map('trim', $parts), static fn (string $part): bool => $part !== ''));
        if ($parts === []) {
            return ['first_name' => '', 'last_name' => ''];
        }
        if (count($parts) === 1) {
            return ['first_name' => $parts[0], 'last_name' => ''];
        }

        $first_name = (string) array_shift($parts);
        return [
            'first_name' => $first_name,
            'last_name' => implode(' ', $parts),
        ];
    }

    private static function looks_like_email(string $value): bool
    {
        $value = trim($value);
        if ($value === '' || strpos($value, '@') === false) {
            return false;
        }

        return (bool) is_email($value);
    }
}
