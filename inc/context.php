<?php
/**
 * Classes de contexte et réglages structurels GP.
 *
 * @package gp-sos-prescription
 */

if (! defined('ABSPATH')) {
    exit;
}

add_filter('body_class', 'sp_filter_body_classes', 20);
add_filter('generate_sidebar_layout', 'sp_force_no_sidebar_for_shell_templates', 99);

/**
 * Ajoute des classes de contexte stables au body.
 *
 * @param array<int, string> $classes Classes existantes.
 * @return array<int, string>
 */
function sp_filter_body_classes($classes)
{
    $context = sp_get_current_context();
    $variant = sp_get_page_shell_variant();

    $classes[] = 'sp-context-' . sanitize_html_class($context);
    $classes[] = 'sp-shell-variant-' . sanitize_html_class($variant);

    if (is_front_page()) {
        $classes[] = 'sp-page-home';
    }

    if (sp_current_page_is('security')) {
        $classes[] = 'sp-page-security';
    }

    if (sp_current_page_is('request')) {
        $classes[] = 'sp-page-request';
    }

    if (sp_current_page_is('patient')) {
        $classes[] = 'sp-page-patient';
    }

    if (sp_current_page_is('doctor-account')) {
        $classes[] = 'sp-page-doctor-account';
    }

    if (sp_current_page_is('doctor-catalog')) {
        $classes[] = 'sp-page-doctor-catalog';
    }

    if (sp_is_console_context()) {
        $classes[] = 'sp-page-console';
    }

    if (sp_current_page_is('legal')) {
        $classes[] = 'sp-page-legal';
    }

    if (sp_is_verify_context()) {
        $classes[] = 'sp-page-verify';
    }

    if (is_user_logged_in()) {
        $classes[] = 'sp-user-logged';
    } else {
        $classes[] = 'sp-user-anon';
    }

    if (current_user_can('sosprescription_validate') || current_user_can('sosprescription_manage')) {
        $classes[] = 'sp-user-doctor';
    }

    if (current_user_can('manage_options')) {
        $classes[] = 'sp-user-admin';
    }

    return array_values(array_unique($classes));
}

/**
 * Force GeneratePress en no-sidebar sur les shells app/console/verify.
 *
 * Cela évite l’apparition d’une colonne fantôme GP quand nos templates
 * gèrent eux-mêmes leur structure interne.
 *
 * @param string $layout Layout courant GP.
 * @return string
 */
function sp_force_no_sidebar_for_shell_templates($layout)
{
    if (sp_is_patient_context() || sp_is_doctor_context() || sp_is_console_context() || sp_is_verify_context()) {
        return 'no-sidebar';
    }

    return $layout;
}
