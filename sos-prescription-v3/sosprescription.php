<?php // sosprescription.php
/**
 * Plugin Name: SosPrescription
 * Description: Delivrance et validation d'ordonnances (SOS Prescription V3).
 * Version: 6.5.2
 * Author: SOS Prescription
 * Requires at least: 6.0
 * Requires PHP: 8.2
 * Text Domain: sosprescription
 */

declare(strict_types=1);

defined('ABSPATH') || exit;

define('SOSPRESCRIPTION_VERSION', '6.5.2');
define('SOSPRESCRIPTION_PATH', plugin_dir_path(__FILE__));
define('SOSPRESCRIPTION_URL', plugin_dir_url(__FILE__));

require_once SOSPRESCRIPTION_PATH . 'includes/turnstile.php';
require_once SOSPRESCRIPTION_PATH . 'includes/Autoloader.php';

\SOSPrescription\Autoloader::register(SOSPRESCRIPTION_PATH . 'includes');

register_activation_hook(__FILE__, ['\\SOSPrescription\\Installer', 'activate']);
register_uninstall_hook(__FILE__, ['\\SOSPrescription\\Installer', 'uninstall_hook']);


foreach (['admin_post_sosprescription_logout', 'admin_post_nopriv_sosprescription_logout'] as $sp_logout_hook) {
    add_action($sp_logout_hook, static function (): void {
        $nonce = isset($_REQUEST['_wpnonce']) ? sanitize_text_field(wp_unslash((string) $_REQUEST['_wpnonce'])) : '';
        if ($nonce === '' || !wp_verify_nonce($nonce, 'sosprescription_logout')) {
            wp_safe_redirect(home_url('/'));
            exit;
        }

        wp_logout();
        wp_safe_redirect(home_url('/'));
        exit;
    });
}


add_action('plugins_loaded', static function (): void {
    if (class_exists('\\SOSPrescription\\Plugin')) {
        \SOSPrescription\Plugin::init();
    }

    // SAFETY NET "DIESEL-GRADE" : On garantit l'enregistrement des routes Worker
    // même si Plugin::init() les a omises suite à un patch défectueux.
    if (class_exists('\\SOSPrescription\\Rest\\WorkerClaimController')) {
        \SOSPrescription\Rest\WorkerClaimController::register();
    }
    if (class_exists('\\SOSPrescription\\Rest\\WorkerCallbackController')) {
        \SOSPrescription\Rest\WorkerCallbackController::register();
    }
    if (class_exists('\\SOSPrescription\\Rest\\WorkerRenderController')) {
        \SOSPrescription\Rest\WorkerRenderController::register();
    }
}, 99);


// Pont de communication V4 vers le Worker Node.js Scalingo
require_once plugin_dir_path(__FILE__) . 'includes/api-v4-proxy.php';
