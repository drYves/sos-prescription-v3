<?php
/**
 * Chargement conditionnel des assets du shell SOS Prescription V2.
 *
 * @package gp-sos-prescription
 */

if (! defined('ABSPATH')) {
    exit;
}

add_action('wp_enqueue_scripts', 'sp_enqueue_theme_assets', 30);

/**
 * Enqueue les styles du thème selon le contexte courant.
 *
 * @return void
 */
function sp_enqueue_theme_assets()
{
    $context = sp_get_current_context();


    sp_enqueue_theme_style_if_exists('sp-fonts', '/assets/css/fonts.css');
    sp_enqueue_theme_style_if_exists('sp-tokens', '/assets/css/tokens.css', array('sp-fonts'));
    sp_enqueue_theme_style_if_exists('sp-base', '/assets/css/base.css', array('sp-tokens'));

    if ($context === 'public') {
        sp_enqueue_theme_style_if_exists('sp-components', '/assets/css/components.css', array('sp-base'));
        sp_enqueue_theme_style_if_exists('sp-marketing', '/assets/css/marketing.css', array('sp-components'));
        sp_enqueue_theme_style_if_exists('sp-utilities', '/assets/css/utilities.css', array('sp-marketing'));
        sp_enqueue_theme_script_if_exists('sp-public-modals', '/assets/js/public-modals.js', array(), true);
        return;
    }

    if (in_array($context, array('patient', 'doctor'), true)) {
        sp_enqueue_theme_style_if_exists('sp-components', '/assets/css/components.css', array('sp-base'));
        sp_enqueue_theme_style_if_exists('sp-app-shell', '/assets/css/app-shell.css', array('sp-components'));
        sp_enqueue_theme_style_if_exists('sp-plugin-bridge', '/assets/css/plugin-bridge.css', array('sp-app-shell'));
        sp_enqueue_theme_style_if_exists('sp-utilities', '/assets/css/utilities.css', array('sp-plugin-bridge'));
        sp_enqueue_theme_script_if_exists('sp-app-shell', '/assets/js/app-shell.js', array(), true);
        return;
    }

    if (in_array($context, array('console', 'verify'), true)) {
        // No external CDN assets are allowed in the HDS shell.

        sp_enqueue_theme_style_if_exists('sp-app-shell', '/assets/css/app-shell.css', array('sp-base'));
        sp_enqueue_theme_style_if_exists('sp-plugin-bridge', '/assets/css/plugin-bridge.css', array('sp-app-shell'));
        sp_enqueue_theme_script_if_exists('sp-app-shell', '/assets/js/app-shell.js', array(), true);
    }
}

/**
 * Enqueue un style seulement si le fichier existe.
 *
 * @param string              $handle Handle WP.
 * @param string              $relative_path Chemin relatif depuis le thème.
 * @param array<int, string>  $deps Dépendances.
 * @param string              $media Media target.
 * @return void
 */
function sp_enqueue_theme_style_if_exists($handle, $relative_path, $deps = array(), $media = 'all')
{
    $path = SP_THEME_PATH . $relative_path;

    if (! is_readable($path)) {
        return;
    }

    $version = (string) filemtime($path);
    $url     = SP_THEME_URL . $relative_path;

    wp_enqueue_style($handle, $url, $deps, $version, $media);
}

/**
 * Enqueue un script seulement si le fichier existe.
 *
 * @param string             $handle Handle WP.
 * @param string             $relative_path Chemin relatif depuis le thème.
 * @param array<int, string> $deps Dépendances.
 * @param bool               $in_footer Chargement footer.
 * @return void
 */
function sp_enqueue_theme_script_if_exists($handle, $relative_path, $deps = array(), $in_footer = true)
{
    $path = SP_THEME_PATH . $relative_path;

    if (! is_readable($path)) {
        return;
    }

    $version = (string) filemtime($path);
    $url     = SP_THEME_URL . $relative_path;

    wp_enqueue_script($handle, $url, $deps, $version, $in_footer);
}

