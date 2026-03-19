<?php // sosprescription.php
/**
 * Plugin Name: SosPrescription
 * Description: Delivrance et validation d'ordonnances (SOS Prescription V1).
 * Version: 3.3.22
 * Author: SOS Prescription
 * Requires at least: 6.0
 * Requires PHP: 8.2
 * Text Domain: sosprescription
 */

declare(strict_types=1);

defined('ABSPATH') || exit;

define('SOSPRESCRIPTION_VERSION', '3.3.22');
define('SOSPRESCRIPTION_PATH', plugin_dir_path(__FILE__));
define('SOSPRESCRIPTION_URL', plugin_dir_url(__FILE__));

require_once SOSPRESCRIPTION_PATH . 'includes/turnstile.php';
require_once SOSPRESCRIPTION_PATH . 'includes/Autoloader.php';

\SOSPrescription\Autoloader::register(SOSPRESCRIPTION_PATH . 'includes');

register_activation_hook(__FILE__, ['\\SOSPrescription\\Installer', 'activate']);
register_uninstall_hook(__FILE__, ['\\SOSPrescription\\Installer', 'uninstall_hook']);

add_action('plugins_loaded', static function (): void {
    \SOSPrescription\Plugin::init();
});
