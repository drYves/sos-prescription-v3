<?php
/**
 * Uninstall handler.
 *
 * IMPORTANT : pendant les phases de tests / mises à jour, il est fréquent de "supprimer" le plugin.
 * Par défaut, SOS Prescription CONSERVE les données (tables/options) pour éviter toute perte.
 *
 * Pour activer une purge complète (destructive) lors de la suppression du plugin :
 * - définissez explicitement la constante suivante dans wp-config.php :
 *     define('SOSPRESCRIPTION_NUKE_ON_UNINSTALL', true);
 *
 * NOTE: l’option admin “Purger les données” et l’ancienne constante
 * SOSPRESCRIPTION_PURGE_ON_UNINSTALL ne sont plus suffisantes à elles seules
 * (sécurité anti-perte de données lors des mises à jour manuelles).
 */

if (!defined('WP_UNINSTALL_PLUGIN')) {
    exit;
}

// SAFETY GUARD (v1.7.8)
// By default, NEVER delete data/files on uninstall. This prevents accidental
// data loss when updating via “Delete → Upload”.
// To perform a full purge, explicitly define in wp-config.php:
//   define('SOSPRESCRIPTION_NUKE_ON_UNINSTALL', true);
if (!defined('SOSPRESCRIPTION_NUKE_ON_UNINSTALL') || SOSPRESCRIPTION_NUKE_ON_UNINSTALL !== true) {
    return;
}

// Charge l'autoloader du plugin de manière sûre, même si le plugin n'est pas "bootstrappé".
if (!defined('SOSPRESCRIPTION_PATH')) {
    define('SOSPRESCRIPTION_PATH', plugin_dir_path(__FILE__));
}

require_once SOSPRESCRIPTION_PATH . 'includes/Autoloader.php';
\SosPrescription\Autoloader::init();

if (class_exists('SosPrescription\Installer')) {
    \SosPrescription\Installer::uninstall_hook();
}
