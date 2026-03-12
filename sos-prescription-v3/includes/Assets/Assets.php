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
    public const ENTRY_FORM  = 'src/entries/form.tsx';
    public const ENTRY_ADMIN = 'src/entries/admin.tsx';

    /** @var bool */
    private static bool $module_filter_registered = false;

    private static function plugin_root_url(): string
    {
        return untrailingslashit(plugins_url('', plugin_dir_path(dirname(__DIR__)) . 'sosprescription.php')) . '/';
    }

    public static function enqueue_form_app(): void
    {
        // Unified UI kit (shared across patient / doctor / backoffice).
        wp_enqueue_style(
            'sosprescription-ui-kit',
            self::plugin_root_url() . 'assets/ui-kit.css',
            [],
            SOSPRESCRIPTION_VERSION
        );

        // Turnstile est optionnel côté front (mode test). Si la clé n'est pas configurée,
        // on doit quand même charger l'app React.
        $deps = [];

        $turnstile = self::maybe_enqueue_turnstile();
        if ($turnstile) {
            $deps[] = 'sosprescription-turnstile';
        }

        // Client-side OCR (Tesseract.js)
        // - Aucun CDN externe (fiabilité / RGPD)
        // - Chargé uniquement sur le formulaire
        wp_enqueue_script(
            'sosprescription-tesseract',
            self::plugin_root_url() . 'assets/js/libs/tesseract/tesseract.min.js',
            [],
            SOSPRESCRIPTION_VERSION,
            true
        );

        wp_enqueue_script(
            'sosprescription-client-ocr',
            self::plugin_root_url() . 'assets/js/sosprescription-client-ocr.js',
            ['sosprescription-tesseract'],
            SOSPRESCRIPTION_VERSION,
            true
        );

        // Le loader Vite doit dépendre de notre wrapper OCR
        $deps[] = 'sosprescription-client-ocr';

        self::enqueue_vite_entry('sosprescription-form', self::ENTRY_FORM, $deps);

        // Correctifs CSS légers pour éviter les collisions de thèmes (notamment sur les <button>).
        // Exemple : dropdown de recherche médicaments rendu illisible par des styles globaux.
        wp_enqueue_style(
            'sosprescription-form-overrides',
            self::plugin_root_url() . 'assets/form-overrides.css',
            [],
            SOSPRESCRIPTION_VERSION
        );

        // Consentement géré dans React (plus de bloc HTML server-side ni patch fetch).

        // Bandeau 'mentions patient' (périmètre / exclusions).
        wp_enqueue_style(
            'sosprescription-notices',
            self::plugin_root_url() . 'assets/notices.css',
            ['sosprescription-form-overrides'],
            SOSPRESCRIPTION_VERSION
        );

        wp_enqueue_script(
            'sosprescription-notices',
            self::plugin_root_url() . 'assets/notices.js',
            [],
            SOSPRESCRIPTION_VERSION,
            true
        );

        // OCR / pré-remplissage
        // Depuis v1.5.17 : l'OCR est déclenché "best effort" directement depuis
        // le bloc justificatif (React) afin d'éviter un second bloc redondant.
    }

    private static function maybe_enqueue_turnstile(): bool
    {
        // Prefer MU-plugin hook, but provide a fallback for safety.
        if (function_exists('sosprescription_turnstile_enqueue')) {
            \sosprescription_turnstile_enqueue();
        } else {
            self::enqueue_turnstile_fallback();
        }

        // IMPORTANT: si un script dépend d'un handle inexistant, WP n'imprime pas le script.
        // On utilise donc Turnstile en dépendance uniquement s'il est bien enregistré.
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
        // Unified UI kit (shared across patient / doctor / backoffice).
        wp_enqueue_style(
            'sosprescription-ui-kit',
            self::plugin_root_url() . 'assets/ui-kit.css',
            [],
            SOSPRESCRIPTION_VERSION
        );

        self::enqueue_vite_entry('sosprescription-admin', self::ENTRY_ADMIN, []);
    }

    private static function enqueue_turnstile_fallback(): void
    {
        $site_key = self::get_turnstile_site_key();
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
        $dev_server = defined('SOSPRESCRIPTION_DEV_SERVER') ? (string) SOSPRESCRIPTION_DEV_SERVER : '';
        $is_dev = defined('SOSPRESCRIPTION_DEV') && SOSPRESCRIPTION_DEV === true && $dev_server !== '';

        if ($is_dev) {
            wp_enqueue_script('vite-client', rtrim($dev_server, '/') . '/@vite/client', [], null, true);
            self::mark_script_as_module('vite-client');
            wp_enqueue_script($handle, rtrim($dev_server, '/') . '/' . $entry, $deps, null, true);
            self::mark_script_as_module($handle);
            self::localize_app($handle);
            return;
        }

        $manifest_path = plugin_dir_path(dirname(__DIR__)) . 'build/manifest.json';

        if (!is_file($manifest_path)) {
            error_log('[SOSPrescription] Vite manifest missing at: ' . $manifest_path);
        }

        $manifest = new AssetManifest($manifest_path);
        $item = $manifest->get($entry);

        if (!$item || empty($item['file'])) {
            return;
        }

        $module_src = self::plugin_root_url() . 'build/' . ltrim((string) $item['file'], '/');

        // En prod mutualisé, certains optimiseurs (minify/defer) peuvent casser les scripts type="module".
        // On charge donc l'entry Vite via un loader classique qui fait un import() dynamique.
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
                self::plugin_root_url() . $loader_file,
                $deps,
                SOSPRESCRIPTION_VERSION,
                true
            );

            // CSS : Vite peut rattacher le CSS aux chunks importés (pas forcément à l'entry).
            // On collecte donc le CSS de l'entry + de ses imports.
            $css_files = self::collect_css_files($manifest, $entry);
            foreach ($css_files as $css_file) {
                $css_file = (string) $css_file;
                if ($css_file === '') {
                    continue;
                }
                $css_handle = 'sosprescription-vite-css-' . substr(md5($css_file), 0, 12);
                $css_src = self::plugin_root_url() . 'build/' . ltrim($css_file, '/');
                wp_enqueue_style($css_handle, $css_src, [], SOSPRESCRIPTION_VERSION);
            }

            self::localize_app($loader_handle);
            self::localize_boot($loader_handle, $boot_var, [
                'moduleUrl' => add_query_arg('ver', SOSPRESCRIPTION_VERSION, $module_src),
                'rootId' => $root_id,
            ]);
            return;
        }

        // Fallback : en dernier recours, on tente le chargement direct (type="module").
        wp_enqueue_script($handle, $module_src, $deps, SOSPRESCRIPTION_VERSION, true);
        self::mark_script_as_module($handle);

        // CSS : Vite peut rattacher le CSS aux chunks importés (pas forcément à l'entry).
        // On collecte donc le CSS de l'entry + de ses imports.
        $css_files = self::collect_css_files($manifest, $entry);
        foreach ($css_files as $css_file) {
            $css_file = (string) $css_file;
            if ($css_file === '') {
                continue;
            }
            $css_handle = 'sosprescription-vite-css-' . substr(md5($css_file), 0, 12);
            $css_src = self::plugin_root_url() . 'build/' . ltrim($css_file, '/');
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

        wp_add_inline_script($handle, 'window.' . $global_var . ' = ' . $json . ';', 'before');
    }

    private static function mark_script_as_module(string $handle): void
    {
        // WP >= 5.3 supporte 'type' via wp_script_add_data. On ajoute en plus un fallback via filter.
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
        if (!$item) {
            return [];
        }

        /** @var array<string, bool> $seen_items */
        $seen_items = [];
        /** @var array<string, bool> $css */
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

        // Profil patient (stocké en user_meta via le portail patient)
        $birth_iso = $user && $user->ID ? (string) get_user_meta((int) $user->ID, 'sosp_birthdate', true) : '';
        $birth_precision = $user && $user->ID ? (string) get_user_meta((int) $user->ID, 'sosp_birthdate_precision', true) : '';
        $birth_fr = $birth_iso !== '' ? Date::iso_to_fr($birth_iso) : '';

        $weight_kg = $user && $user->ID ? (string) get_user_meta((int) $user->ID, 'sosp_weight_kg', true) : '';
        $height_cm = $user && $user->ID ? (string) get_user_meta((int) $user->ID, 'sosp_height_cm', true) : '';

        $turnstile_site_key = self::get_turnstile_site_key();

        $cap_manage = current_user_can('sosprescription_manage') || current_user_can('manage_options');
        $cap_manage_data = current_user_can('sosprescription_manage_data') || current_user_can('manage_options');
        $cap_validate = current_user_can('sosprescription_validate') || current_user_can('manage_options');

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
                'siteKey' => $turnstile_site_key,
                'enabled' => $turnstile_site_key !== '',
            ],
            'currentUser' => [
                'id' => (int) $user->ID,
                'displayName' => (string) $user->display_name,
                'email' => (string) $user->user_email,
                'roles' => array_values((array) $user->roles),
            ],
            'patientProfile' => [
                'birthdate_iso' => $birth_iso,
                'birthdate_fr' => $birth_fr,
                'birthdate_precision' => $birth_precision,
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

        wp_add_inline_script($handle, 'window.SOSPrescription = ' . $json . ';', 'before');
    }
}
