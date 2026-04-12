<?php
/**
 * Fondations WordPress du shell SOS Prescription V2.
 *
 * @package gp-sos-prescription
 */

if (! defined('ABSPATH')) {
    exit;
}

add_action('after_setup_theme', 'sp_theme_setup', 20);
add_action('widgets_init', 'sp_register_sidebars');
add_filter('option_generate_settings', 'sp_filter_generatepress_settings_defaults', 20);
add_filter('generate_copyright', 'sp_filter_generatepress_copyright', 20);

/**
 * Initialise le thème enfant.
 *
 * Le thème parent GeneratePress porte déjà la majorité des supports utiles.
 * Ici on ne déclare que ce qui est propre au shell SOS Prescription.
 *
 * @return void
 */
function sp_theme_setup()
{
    load_child_theme_textdomain('gp-sos-prescription', SP_THEME_PATH . '/languages');

    register_nav_menu('primary', __('Primary Menu', 'sosprescription'));
    register_nav_menu('app-menu', __('Application Menu', 'sosprescription'));
}

/**
 * Définit une valeur par défaut pour le copyright GP.
 *
 * @param mixed $settings Réglages GeneratePress.
 * @return array<string, mixed>
 */
function sp_filter_generatepress_settings_defaults($settings)
{
    if (! is_array($settings)) {
        $settings = array();
    }

    if (empty($settings['copyright'])) {
        $settings['copyright'] = '%copy% %current_year% sosprescription.fr • Tous droits réservés.';
    }

    return $settings;
}

/**
 * Garantit une ligne de copyright discrète et stable.
 *
 * @param string $copyright Copyright GP filtré.
 * @return string
 */
function sp_filter_generatepress_copyright($copyright)
{
    unset($copyright);

    return sprintf('&copy; %s sosprescription.fr &bull; Tous droits réservés.', esc_html(wp_date('Y')));
}

/**
 * Déclare les sidebars fallback du shell applicatif.
 *
 * Les vrais contenus latéraux pourront ensuite être remplacés ou enrichis,
 * mais ces zones offrent une base stable dès la V2.
 *
 * @return void
 */
function sp_register_sidebars()
{
    $common = array(
        'before_widget' => '<section id="%1$s" class="widget %2$s sp-widget-card">',
        'after_widget'  => '</section>',
        'before_title'  => '<h3 class="sp-widget-card__title">',
        'after_title'   => '</h3>',
    );

    register_sidebar(
        array_merge(
            $common,
            array(
                'name'        => __('SOS : Sidebar patient', 'gp-sos-prescription'),
                'id'          => 'sp_patient_sidebar',
                'description' => __('Colonne latérale fallback pour la demande et l’espace patient.', 'gp-sos-prescription'),
            )
        )
    );

    register_sidebar(
        array_merge(
            $common,
            array(
                'name'        => __('SOS : Sidebar médecin', 'gp-sos-prescription'),
                'id'          => 'sp_doctor_sidebar',
                'description' => __('Colonne latérale fallback pour le compte médecin et le référentiel BDPM.', 'gp-sos-prescription'),
            )
        )
    );

    // Compatibilité de transition avec l’ancien thème.
    register_sidebar(
        array_merge(
            $common,
            array(
                'name'        => __('SOS : Sidebar App legacy', 'gp-sos-prescription'),
                'id'          => 'sp_app_sidebar',
                'description' => __('Zone legacy conservée le temps de la migration V2.', 'gp-sos-prescription'),
            )
        )
    );
}
