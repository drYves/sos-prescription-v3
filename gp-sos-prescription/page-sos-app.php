<?php
/**
 * Template Name: SOS App Layout V2
 * Version: 8.8.0
 *
 * Shell applicatif natif GeneratePress :
 * - Demande d’ordonnance
 * - Espace patient
 * - Compte médecin
 * - Référentiel Médicaments (BDPM)
 *
 * @package gp-sos-prescription
 */

if (! defined('ABSPATH')) {
    exit;
}

get_header();

$sp_variant            = sp_get_page_shell_variant();
$sp_plugin_shell_class = 'sp-plugin-shell sp-plugin-shell--app sp-plugin-shell--' . sanitize_html_class($sp_variant);
$sp_compliance         = get_option('sosprescription_compliance', []);
$sp_cgu_url            = is_array($sp_compliance) && isset($sp_compliance['cgu_url']) ? trim((string) $sp_compliance['cgu_url']) : '';
$sp_privacy_url        = is_array($sp_compliance) && isset($sp_compliance['privacy_url']) ? trim((string) $sp_compliance['privacy_url']) : '';
$sp_use_default_loop   = function_exists('generate_has_default_loop') ? generate_has_default_loop() : true;
?>

<div id="primary" <?php generate_do_element_classes('content'); ?>>
    <main id="main" <?php generate_do_element_classes('main'); ?>>
        <?php
        do_action('generate_before_main_content');

        if ($sp_use_default_loop) :
            while (have_posts()) :
                the_post();
                ?>
                <article id="post-<?php the_ID(); ?>" <?php post_class(); ?><?php if (function_exists('generate_do_microdata')) : ?> <?php generate_do_microdata('article'); ?><?php endif; ?>>
                    <div class="inside-article">
                        <?php
                        do_action('generate_before_content');

                        if (! function_exists('generate_show_entry_header') || generate_show_entry_header()) :
                            ?>
                            <header class="entry-header">
                                <?php
                                do_action('generate_before_page_title');

                                if (! function_exists('generate_show_title') || generate_show_title()) {
                                    if (function_exists('generate_get_the_title_parameters')) {
                                        $sp_title_params = generate_get_the_title_parameters();
                                        the_title($sp_title_params['before'], $sp_title_params['after']);
                                    } else {
                                        the_title('<h1 class="entry-title">', '</h1>');
                                    }
                                }

                                do_action('generate_after_page_title');
                                ?>
                            </header>
                            <?php
                        endif;

                        do_action('generate_after_entry_header');

                        $sp_itemprop = '';

                        if (function_exists('generate_get_schema_type') && 'microdata' === generate_get_schema_type()) {
                            $sp_itemprop = ' itemprop="text"';
                        }
                        ?>
                        <div class="entry-content"<?php echo $sp_itemprop; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped ?>>
                            <div class="sp-shell sp-shell--app sp-shell--<?php echo esc_attr($sp_variant); ?>">
                                <?php sp_render_app_rolebar(); ?>

                                <div class="<?php echo esc_attr($sp_plugin_shell_class); ?>">
                                    <?php
                                    the_content();

                                    wp_link_pages(
                                        array(
                                            'before' => '<div class="page-links">' . esc_html__('Pages:', 'generatepress'),
                                            'after'  => '</div>',
                                        )
                                    );
                                    ?>
                                </div>

                                <?php if ($sp_cgu_url !== '' || $sp_privacy_url !== '') : ?>
                                <footer class="sp-app-legal-footer" aria-label="Informations juridiques applicatives">
                                    <div class="sp-app-legal-footer__inner">
                                        <span class="sp-app-legal-footer__eyebrow"><span class="sp-app-legal-footer__icon" aria-hidden="true"><?php echo sp_get_secure_menu_icon_svg('doctor-account'); ?></span>Cadre sécurisé</span>
                                        <nav class="sp-app-legal-footer__links" aria-label="Liens juridiques applicatifs">
                                            <?php if ($sp_cgu_url !== '') : ?>
                                            <a href="<?php echo esc_url($sp_cgu_url); ?>" target="_blank" rel="noreferrer noopener">CGU</a>
                                            <?php endif; ?>
                                            <?php if ($sp_privacy_url !== '') : ?>
                                            <a href="<?php echo esc_url($sp_privacy_url); ?>" target="_blank" rel="noreferrer noopener">Politique de confidentialité</a>
                                            <?php endif; ?>
                                        </nav>
                                    </div>
                                </footer>
                                <?php endif; ?>
                            </div>
                        </div>
                        <?php do_action('generate_after_content'); ?>
                    </div>
                </article>
                <?php
            endwhile;
        endif;

        do_action('generate_after_main_content');
        ?>
    </main>
</div>

<?php
do_action('generate_after_primary_content_area');

if (function_exists('generate_construct_sidebars')) {
    generate_construct_sidebars();
} else {
    get_sidebar();
}

get_footer();
