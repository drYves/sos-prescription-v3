<?php
declare(strict_types=1);

namespace SOSPrescription;

use SOSPrescription\Assets\Assets as AssetManager;
use SOSPrescription\Services\ComplianceConfig;
use SOSPrescription\Services\SandboxConfig;

/**
 * Façade d'assets (compatibilité).
 *
 * Le gestionnaire Vite/manifest est dans \SOSPrescription\Assets\Assets.
 * Certaines classes utilisent historiquement \SOSPrescription\Assets::enqueue(...)
 * => on fournit une couche stable.
 */
final class Assets
{
    /**
     * Enqueue frontend assets.
     *
     * @param string $which form|bdpm_table
     */
    public static function enqueue_frontend(string $which): void
    {
        $which = strtolower(trim($which));

        if ($which === 'form') {
            AssetManager::enqueue_form_app();
            return;
        }

        if ($which === 'bdpm_table') {
            self::enqueue_bdpm_table();
            return;
        }
    }

    /**
     * Enqueue admin assets.
     *
     * @param string $which admin
     */
    public static function enqueue(string $which): void
    {
        $which = strtolower(trim($which));

        if ($which === 'admin') {
            AssetManager::enqueue_admin_app();
            return;
        }

        if ($which === 'doctor_console') {
            self::enqueue_doctor_console();
            return;
        }
    }

    /**
     * Console médecin (front) - JS sans build.
     *
     * Objectif : offrir une interface "queue + dossier + messagerie + décision" sans dépendre
     * d'un build React.
     */
    public static function enqueue_doctor_console(): void
    {
        // Unified UI kit (shared across patient / doctor / backoffice)
        wp_enqueue_style(
            'sosprescription-ui-kit',
            SOSPRESCRIPTION_URL . 'assets/ui-kit.css',
            [],
            SOSPRESCRIPTION_VERSION
        );

        wp_enqueue_style(
            'sosprescription-doctor-console',
            SOSPRESCRIPTION_URL . 'assets/doctor-console.css',
            [],
            SOSPRESCRIPTION_VERSION
        );

        wp_enqueue_script(
            'sosprescription-doctor-console',
            SOSPRESCRIPTION_URL . 'assets/doctor-console.js',
            [],
            SOSPRESCRIPTION_VERSION,
            true
        );

        self::localize_app('sosprescription-doctor-console');
    }

    /**
     * Tableau BDPM (front) - JS sans build.
     */
    public static function enqueue_bdpm_table(): void
    {
        wp_enqueue_style(
            'sosprescription-bdpm-table',
            SOSPRESCRIPTION_URL . 'assets/bdpm-table.css',
            [],
            SOSPRESCRIPTION_VERSION
        );

        wp_enqueue_script(
            'sosprescription-bdpm-table',
            SOSPRESCRIPTION_URL . 'assets/bdpm-table.js',
            [],
            SOSPRESCRIPTION_VERSION,
            true
        );

        self::localize_app('sosprescription-bdpm-table');
    }

    private static function localize_app(string $handle): void
    {
        $user = wp_get_current_user();

        $turnstile_site_key = '';
        if (defined('SOSPRESCRIPTION_TURNSTILE_SITE_KEY')) {
            $turnstile_site_key = (string) SOSPRESCRIPTION_TURNSTILE_SITE_KEY;
        }
        if (function_exists('sosprescription_turnstile_site_key')) {
            $maybe = (string) \sosprescription_turnstile_site_key();
            if ($maybe !== '') {
                $turnstile_site_key = $maybe;
            }
        }

        $cap_manage = current_user_can('sosprescription_manage') || current_user_can('manage_options');
        $cap_manage_data = current_user_can('sosprescription_manage_data') || current_user_can('manage_options');
        $cap_validate = current_user_can('sosprescription_validate') || current_user_can('manage_options');

        $data = [
            'restBase' => esc_url_raw(rest_url('sosprescription/v1')),
            'nonce' => wp_create_nonce('wp_rest'),
            'site' => [
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
            'capabilities' => [
                'manage' => (bool) $cap_manage,
                'manageData' => (bool) $cap_manage_data,
                'validate' => (bool) $cap_validate,
            ],
			'compliance' => ComplianceConfig::public_data(),
            'sandbox' => SandboxConfig::get(),
        ];

        $json = wp_json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if (!is_string($json)) {
            $json = '{}';
        }

        wp_add_inline_script($handle, 'window.SOSPrescription = ' . $json . ';', 'before');
    }
}
