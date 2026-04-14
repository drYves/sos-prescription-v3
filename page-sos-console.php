<?php
/**
 * Template Name: SOS Console Layout V2
 *
 * Shell console médecin dédié.
 *
 * @package gp-sos-prescription
 */

if (! defined('ABSPATH')) {
    exit;
}

get_header();

$sp_variant            = 'console';
$sp_container_class    = 'sp-container sp-container--console sp-container--console-compact';
$sp_plugin_shell_class = 'sp-plugin-shell sp-plugin-shell--console sp-plugin-shell--console';
?>

<div class="sp-shell sp-shell--console sp-shell--<?php echo esc_attr($sp_variant); ?>">
    <?php sp_render_console_bar(); ?>

    <div class="<?php echo esc_attr($sp_container_class); ?>">
        <div class="sp-console-frame" id="primary" aria-label="Surface de travail console">
            <div class="<?php echo esc_attr($sp_plugin_shell_class); ?>">
            <?php
            while (have_posts()) {
                the_post();
                the_content();
            }
            ?>
            </div>
        </div>
    </div>
</div>

<?php
get_footer();
