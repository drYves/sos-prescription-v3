<?php
declare(strict_types=1);

namespace SOSPrescription\Assets;

use SOSPrescription\Services\ComplianceConfig;
use SOSPrescription\Services\NoticesConfig;
use SOSPrescription\Services\NotificationsConfig;
use SOSPrescription\Services\OcrConfig;
use SOSPrescription\Services\Turnstile;
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

        wp_enqueue_script(
            'sosprescription-turnstile-failopen',
            SOSPRESCRIPTION_URL . 'assets/form-turnstile-failopen.js',
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

        $turnstile_config = [
            'configured' => Turnstile::is_configured(),
            'enabled' => Turnstile::is_enabled(),
        ];
        $json = wp_json_encode($turnstile_config, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if (!is_string($json)) {
            $json = '{}';
        }

        wp_add_inline_script(
            'sosprescription-turnstile-failopen',
            'window.SOSPrescriptionTurnstileFailOpen = ' . $json . ';',
            'before'
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

    private static function enqueue_vite_entry(string $handle, string $entry, array $deps = []): void
    {
        $dev_server = defined('SOSPRESCRIPTION_DEV_SERVER') ? (string) SOSPRESCRIPTION_DEV_SERVER : '';
        $is_dev = defined('SOSPRESCRIPTION_DEV') && SOSPRESCRIPTION_DEV === true && $dev_server !== '';

        if ($is_dev) {
            wp_enqueue_script('vite-client', rtrim($dev_server, '/') . '/@vite/client', [], null, true);
            self::mark_script_as_module('vite-client');

            wp_enqueue_script(
                $handle,
                rtrim($dev_server, '/') . '/' . ltrim($entry, '/'),
                $deps,
                null,
                true
            );
            self::mark_script_as_module($handle);
            self::localize_app($handle);
            return;
        }

        $manifest = new AssetManifest(SOSPRESCRIPTION_PATH . 'build/manifest.json');
        $item = $manifest->get($entry);

        if (!$item || empty($item['file'])) {
            return;
        }

        $module_src = SOSPRESCRIPTION_URL . 'build/' . ltrim((string) $item['file'], '/');

        $loader_handle = $handle . '-loader';
        $loader_file = '';
        $boot_var = '';
        $root_id = '';

        if ($handle === 'sosprescription-form') {
            $loader_file = 'assets/vite-form-loader.js';
            $boot_var = 'SOSPrescriptionViteForm';
            $root_id = 'sosprescription-root-form';
        } elseif ($handle === 'sosprescription-admin') {
            $loader_file = 'assets/vite-admin-loader.js';
            $boot_var = 'SOSPrescriptionViteAdmin';
            $root_id = 'sosprescription-root-admin';
        }

        if ($loader_file !== '' && $boot_var !== '' && $root_id !== '') {
            wp_enqueue_script(
                $loader_handle,
                SOSPRESCRIPTION_URL . $loader_file,
                $deps,
                SOSPRESCRIPTION_VERSION,
                true
            );

            $css_files = self::collect_css_files($manifest, $entry);
            foreach ($css_files as $css_file) {
                $css_file = (string) $css_file;
                if ($css_file === '') {
                    continue;
                }

                $css_handle = 'sosprescription-vite-css-' . substr(md5($css_file), 0, 12);
                $css_src = SOSPRESCRIPTION_URL . 'build/' . ltrim($css_file, '/');
                wp_enqueue_style($css_handle, $css_src, [], SOSPRESCRIPTION_VERSION);
            }

            self::localize_app($loader_handle);
            self::localize_boot($loader_handle, $boot_var, [
                'moduleUrl' => add_query_arg('ver', SOSPRESCRIPTION_VERSION, $module_src),
                'rootId' => $root_id,
            ]);
            return;
        }

        wp_enqueue_script($handle, $module_src, $deps, SOSPRESCRIPTION_VERSION, true);
        self::mark_script_as_module($handle);

        $css_files = self::collect_css_files($manifest, $entry);
        foreach ($css_files as $css_file) {
            $css_file = (string) $css_file;
            if ($css_file === '') {
                continue;
            }

            $css_handle = 'sosprescription-vite-css-' . substr(md5($css_file), 0, 12);
            $css_src = SOSPRESCRIPTION_URL . 'build/' . ltrim($css_file, '/');
            wp_enqueue_style($css_handle, $css_src, [], SOSPRESCRIPTION_VERSION);
        }

        self::localize_app($handle);
    }

    /**
     * @param array<string, mixed> $data
     */
    private static function localize_boot(string $handle, string $global_var, array $data): void
    {
        $json = wp_json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if (!is_string($json)) {
            $json = '{}';
        }

        $global_var = preg_replace('/[^A-Za-z0-9_]/', '', $global_var);
        if (!is_string($global_var) || $global_var === '') {
            return;
        }

        $script = 'window.' . $global_var . ' = ' . $json . ';';

        if (strpos($global_var, 'SOSPrescription') === 0) {
            $legacy_var = 'SosPrescription' . substr($global_var, strlen('SOSPrescription'));
            if ($legacy_var !== $global_var) {
                $script .= 'window.' . $legacy_var . ' = window.' . $global_var . ';';
            }
        } elseif (strpos($global_var, 'SosPrescription') === 0) {
            $modern_var = 'SOSPrescription' . substr($global_var, strlen('SosPrescription'));
            if ($modern_var !== $global_var) {
                $script .= 'window.' . $modern_var . ' = window.' . $global_var . ';';
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

        add_filter('script_loader_tag', static function (string $tag, string $h, string $src): string {
            $module_handles = [
                'vite-client',
                'sosprescription-form',
                'sosprescription-admin',
            ];

            if (!in_array($h, $module_handles, true)) {
                return $tag;
            }

            if (str_contains($tag, 'type="module"') || str_contains($tag, "type='module'")) {
                return $tag;
            }

            $new = preg_replace('/^<script\b/', '<script type="module"', $tag, 1);
            return is_string($new) && $new !== '' ? $new : $tag;
        }, 10, 3);
    }

    /**
     * @return array<int, string>
     */
    private static function collect_css_files(AssetManifest $manifest, string $entry): array
    {
        $item = $manifest->get($entry);
        if (!$item || !is_array($item)) {
            return [];
        }

        $seen_items = [];
        $css = [];

        $walk = static function (array $it) use (&$walk, &$seen_items, &$css, $manifest): void {
            if (!empty($it['css']) && is_array($it['css'])) {
                foreach ($it['css'] as $css_file) {
                    if (is_string($css_file) && $css_file !== '') {
                        $css[$css_file] = true;
                    }
                }
            }

            if (!empty($it['imports']) && is_array($it['imports'])) {
                foreach ($it['imports'] as $imp_key) {
                    if (!is_string($imp_key) || $imp_key === '') {
                        continue;
                    }
                    if (isset($seen_items[$imp_key])) {
                        continue;
                    }

                    $seen_items[$imp_key] = true;
                    $imp = $manifest->get($imp_key);
                    if (is_array($imp)) {
                        $walk($imp);
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
        $user_id = ($user instanceof \WP_User) ? (int) $user->ID : 0;

        $first_name = $user_id > 0 ? sanitize_text_field((string) get_user_meta($user_id, 'first_name', true)) : '';
        $last_name = $user_id > 0 ? sanitize_text_field((string) get_user_meta($user_id, 'last_name', true)) : '';
        $display_name = $user instanceof \WP_User ? (string) $user->display_name : '';

        if (($first_name === '' || $last_name === '') && self::is_human_display_name($display_name)) {
            $parts = self::split_human_name($display_name);
            if ($first_name === '') {
                $first_name = $parts['first_name'];
            }
            if ($last_name === '') {
                $last_name = $parts['last_name'];
            }
        }

        $birth_iso = $user_id > 0 ? (string) get_user_meta($user_id, 'sosp_birthdate', true) : '';
        $birth_precision = $user_id > 0 ? (string) get_user_meta($user_id, 'sosp_birthdate_precision', true) : '';
        $birth_fr = $birth_iso !== '' ? Date::iso_to_fr($birth_iso) : '';
        $phone = $user_id > 0 ? self::read_user_meta_first($user_id, ['sosp_phone', 'phone', 'billing_phone', 'telephone', 'mobile']) : '';
        $weight_kg = $user_id > 0 ? (string) get_user_meta($user_id, 'sosp_weight_kg', true) : '';
        $height_cm = $user_id > 0 ? (string) get_user_meta($user_id, 'sosp_height_cm', true) : '';

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

        $json = wp_json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if (!is_string($json)) {
            $json = '{}';
        }

        $script = 'window.SOSPrescription = ' . $json . ';window.SosPrescription = window.SOSPrescription;';
        wp_add_inline_script($handle, $script, 'before');
    }

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
