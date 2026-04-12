<?php
/**
 * Intégration GeneratePress Elements : hooks custom SOS Prescription V2.
 *
 * @package gp-sos-prescription
 */

if (! defined('ABSPATH')) {
    exit;
}

add_filter('generate_hooks_list', 'sp_register_generatepress_custom_hooks');

/**
 * Ajoute nos hooks custom dans la liste GP Elements.
 *
 * @param array<string, mixed> $hooks Liste des hooks GP existants.
 * @return array<string, mixed>
 */
function sp_register_generatepress_custom_hooks($hooks)
{
    $hooks['sos-prescription-app-shell'] = array(
        'group' => esc_html__('SOS Prescription : App shell', 'gp-sos-prescription'),
        'hooks' => array(
            'sp_app_rolebar_patient',
            'sp_app_rolebar_doctor',
            'sp_app_console_bar',
            'sp_app_sidebar_request',
            'sp_app_sidebar_patient',
            'sp_app_sidebar_doctor',
        ),
    );

    return $hooks;
}
