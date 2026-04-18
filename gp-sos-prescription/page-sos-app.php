<?php
/**
 * Template Name: SOS App Layout V2
 * Version: 8.6.0
 *
 * Shell applicatif standard :
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

$sp_variant             = sp_get_page_shell_variant();
$sp_has_sidebar         = sp_page_has_context_sidebar($sp_variant);
$sp_container_class     = 'sp-container sp-container--app';
$sp_plugin_shell_class  = 'sp-plugin-shell sp-plugin-shell--app sp-plugin-shell--' . sanitize_html_class($sp_variant);
$sp_compliance          = get_option('sosprescription_compliance', []);
$sp_cgu_url             = is_array($sp_compliance) && isset($sp_compliance['cgu_url']) ? trim((string) $sp_compliance['cgu_url']) : '';
$sp_privacy_url         = is_array($sp_compliance) && isset($sp_compliance['privacy_url']) ? trim((string) $sp_compliance['privacy_url']) : '';

if (sp_uses_compact_app_container($sp_variant)) {
    $sp_container_class .= ' sp-container--app-compact';
}
?>

<div class="sp-shell sp-shell--app sp-shell--<?php echo esc_attr($sp_variant); ?>">
    <?php sp_render_app_rolebar(); ?>

    <div class="<?php echo esc_attr($sp_container_class); ?>">
        <div class="sp-app-frame<?php echo $sp_has_sidebar ? '' : ' sp-app-frame--no-sidebar'; ?>">
            <main class="sp-app-main" id="primary" aria-label="Contenu principal applicatif">
                <div class="<?php echo esc_attr($sp_plugin_shell_class); ?>">
                <?php
                while (have_posts()) {
                    the_post();
                    the_content();
                }
                ?>
                </div>
            </main>

            <?php if ($sp_has_sidebar) : ?>
            <aside class="sp-app-sidebar" aria-label="Colonne latérale contextuelle">
                <?php sp_render_context_sidebar(); ?>
            </aside>
            <?php endif; ?>
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
