<?php
declare(strict_types=1);

namespace SOSPrescription;

use SOSPrescription\Assets\Assets as AssetManager;
use SOSPrescription\Services\ComplianceConfig;
use SosPrescription\Services\LocaleContractBroker;
use SOSPrescription\Services\SandboxConfig;

final class Assets
{
    public static function enqueue_frontend(string $which): void
    {
        $which = strtolower(trim($which));

        if ($which === 'form') {
            AssetManager::enqueue_form_app();
            return;
        }

        if ($which === 'bdpm_table') {
            self::enqueue_bdpm_table();
        }
    }

    public static function enqueue(string $which): void
    {
        $which = strtolower(trim($which));

        if ($which === 'admin') {
            AssetManager::enqueue_admin_app();
            return;
        }

        if ($which === 'doctor_console') {
            self::enqueue_doctor_console();
        }
    }

    public static function enqueue_doctor_console(): void
    {
        $adminHandle = AssetManager::enqueue_admin_app('sosprescription-doctor-console-root');

        wp_enqueue_style(
            'sosprescription-doctor-console',
            SOSPRESCRIPTION_URL . 'assets/doctor-console.css',
            ['sosprescription-ui-kit'],
            SOSPRESCRIPTION_VERSION
        );

        $dependencies = [];
        if (is_string($adminHandle) && $adminHandle !== '') {
            $dependencies[] = $adminHandle;
        }

        wp_enqueue_script(
            'sosprescription-doctor-console',
            SOSPRESCRIPTION_URL . 'assets/doctor-console.js',
            $dependencies,
            SOSPRESCRIPTION_VERSION,
            true
        );

        if (!is_string($adminHandle) || $adminHandle === '') {
            self::localize_app('sosprescription-doctor-console');
        }
    }

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

        $turnstileSiteKey = '';
        if (defined('SOSPRESCRIPTION_TURNSTILE_SITE_KEY')) {
            $turnstileSiteKey = (string) SOSPRESCRIPTION_TURNSTILE_SITE_KEY;
        }
        if (function_exists('sosprescription_turnstile_site_key')) {
            $maybe = (string) \sosprescription_turnstile_site_key();
            if ($maybe !== '') {
                $turnstileSiteKey = $maybe;
            }
        }

        $capManage = current_user_can('sosprescription_manage') || current_user_can('manage_options');
        $capManageData = current_user_can('sosprescription_manage_data') || current_user_can('manage_options');
        $capValidate = current_user_can('sosprescription_validate') || current_user_can('manage_options');

        $data = [
            'restBase' => esc_url_raw(rest_url('sosprescription/v1')),
            'nonce' => wp_create_nonce('wp_rest'),
            'site' => [
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
            'capabilities' => [
                'manage' => (bool) $capManage,
                'manageData' => (bool) $capManageData,
                'validate' => (bool) $capValidate,
            ],
            'compliance' => ComplianceConfig::public_data(),
            'sandbox' => SandboxConfig::get(),
        ];

        $localeContract = LocaleContractBroker::runtime_contract();
        if (is_array($localeContract)) {
            $data['localeContract'] = $localeContract;
        }

        $json = wp_json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if (!is_string($json)) {
            $json = '{}';
        }

        wp_add_inline_script($handle, 'window.SOSPrescription = ' . $json . ';window.SosPrescription = window.SOSPrescription;', 'before');
    }
}
