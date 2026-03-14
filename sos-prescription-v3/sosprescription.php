<?php
/**
 * Plugin Name: SosPrescription
 * Description: Délivrance et validation d'ordonnances (SOS Prescription V1).
 * Version: 3.3.0
 * Author: SOS Prescription
 * Requires at least: 6.0
 * Requires PHP: 8.2
 * Text Domain: sosprescription
 */

declare(strict_types=1);

defined('ABSPATH') || exit;

// NOTE: keep this value in sync with the plugin header Version above.
// It is used for cache-busting (assets), logs, and DB migrations.
define('SOSPRESCRIPTION_VERSION', '3.3.0');
define('SOSPRESCRIPTION_PATH', plugin_dir_path(__FILE__));
define('SOSPRESCRIPTION_URL', plugin_dir_url(__FILE__));

// Turnstile helpers are integrated directly in the main plugin (no MU-Plugins step).
require_once SOSPRESCRIPTION_PATH . 'includes/turnstile.php';

require_once SOSPRESCRIPTION_PATH . 'includes/Autoloader.php';

\SosPrescription\Autoloader::register();

register_activation_hook(__FILE__, ['\\SosPrescription\\Installer', 'activate']);
// Lors d'une suppression du plugin, on CONSERVE les données par défaut.
// La purge complète est conditionnée (option admin / constante), voir uninstall.php.
register_uninstall_hook(__FILE__, ['\\SosPrescription\\Installer', 'uninstall_hook']);

add_action('plugins_loaded', static function (): void {
    \SosPrescription\Plugin::init();
});
