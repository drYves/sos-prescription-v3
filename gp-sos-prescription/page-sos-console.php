<?php
/**
 * Template Name: SOS Console Layout V2
 * Version: 8.6.0
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
$sp_compliance         = get_option('sosprescription_compliance', []);
$sp_cgu_url            = is_array($sp_compliance) && isset($sp_compliance['cgu_url']) ? trim((string) $sp_compliance['cgu_url']) : '';
$sp_privacy_url        = is_array($sp_compliance) && isset($sp_compliance['privacy_url']) ? trim((string) $sp_compliance['privacy_url']) : '';
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

<?php
get_footer();
