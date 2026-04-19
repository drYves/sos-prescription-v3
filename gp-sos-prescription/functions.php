<?php
/**
 * Bootstrap minimal du thème enfant SOS Prescription V8.8.1.
 *
 * @package gp-sos-prescription
 */

if (! defined('ABSPATH')) {
    exit;
}

if (! defined('SP_THEME_VERSION')) {
    define('SP_THEME_VERSION', '8.13.0');
}

if (! defined('SP_THEME_PATH')) {
    define('SP_THEME_PATH', untrailingslashit(get_stylesheet_directory()));
}

if (! defined('SP_THEME_URL')) {
    define('SP_THEME_URL', untrailingslashit(get_stylesheet_directory_uri()));
}


add_filter('generate_header_layout', static function () {
    return 'contained-header';
});

add_filter('generate_header_inner_width', static function () {
    return 'contained';
});

$sp_theme_bootstrap = array(
    SP_THEME_PATH . '/inc/setup.php',
    SP_THEME_PATH . '/inc/helpers.php',
    SP_THEME_PATH . '/inc/context.php',
    SP_THEME_PATH . '/inc/gp-elements.php',
    SP_THEME_PATH . '/inc/assets.php',
);

foreach ($sp_theme_bootstrap as $sp_theme_file) {
    if (is_readable($sp_theme_file)) {
        require_once $sp_theme_file;
    }
}

/**
 * Snippet v7.0.2 — Enqueue conditionnel du skin structurel applicatif.
 *
 * À placer dans functions.php du thème enfant gp-sos-prescription
 * ou dans un fichier inclus depuis functions.php.
 */

add_action('wp_enqueue_scripts', 'sp_enqueue_app_skin_v700', 90);

/**
 * Charge app-skin.css uniquement sur les templates applicatifs.
 *
 * Templates cibles :
 * - page-sos-app.php
 * - page-sos-console.php
 *
 * @return void
 */
function sp_enqueue_app_skin_v700()
{
    if (is_admin()) {
        return;
    }

    if (! is_page_template('page-sos-app.php') && ! is_page_template('page-sos-console.php')) {
        return;
    }

    $relative_path = '/assets/css/app-skin.css';
    $path          = SP_THEME_PATH . $relative_path;

    if (! is_readable($path)) {
        return;
    }

    wp_register_style(
        'sp-app-skin',
        SP_THEME_URL . $relative_path,
        array('sp-plugin-bridge'),
        (string) filemtime($path)
    );

    wp_enqueue_style('sp-app-skin');
}
