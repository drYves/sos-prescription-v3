<?php
/**
 * Template Name: SOS App Layout V2
 * Version: 8.8.1
 *
 * Recovery structurel GP / SOS :
 * - restauration d'un scaffolding applicatif pragmatique
 * - conservation des points d'appui GP utiles (header / footer / metabox layout)
 * - respect du layout GP réel pour décider de la présence de la sidebar applicative
 * - priorité absolue aux surfaces de garde / secure-entry
 *
 * @package gp-sos-prescription
 */

if (! defined('ABSPATH')) {
    exit;
}

get_header();

$sp_variant            = sp_get_page_shell_variant();
$sp_container_class    = 'sp-container sp-container--app';
$sp_plugin_shell_class = 'sp-plugin-shell sp-plugin-shell--app sp-plugin-shell--' . sanitize_html_class($sp_variant);
$sp_compliance         = get_option('sosprescription_compliance', []);
$sp_cgu_url            = is_array($sp_compliance) && isset($sp_compliance['cgu_url']) ? trim((string) $sp_compliance['cgu_url']) : '';
$sp_privacy_url        = is_array($sp_compliance) && isset($sp_compliance['privacy_url']) ? trim((string) $sp_compliance['privacy_url']) : '';
$sp_content            = '';
$sp_detect_guard_surface = static function (string $html): bool {
    return str_contains($html, 'sp-plugin-root--guarded')
        || str_contains($html, 'sp-plugin-guard')
        || str_contains($html, 'sp-auth-entry--guarded')
        || str_contains($html, 'sp-auth-surface--guarded');
};

while (have_posts()) {
    the_post();
    ob_start();
    the_content();
    $sp_content = (string) ob_get_clean();
}

$sp_is_guard_surface = $sp_detect_guard_surface($sp_content);
$sp_has_sidebar      = ! $sp_is_guard_surface && sp_page_has_context_sidebar($sp_variant);
$sp_show_rolebar     = ! $sp_is_guard_surface;
$sp_show_legal_footer = ! $sp_is_guard_surface && ($sp_cgu_url !== '' || $sp_privacy_url !== '');

if ($sp_is_guard_surface || sp_uses_compact_app_container($sp_variant)) {
    $sp_container_class .= ' sp-container--app-compact';
}

$sp_shell_classes = [
    'sp-shell',
    'sp-shell--app',
    'sp-shell--' . sanitize_html_class($sp_variant),
];

if ($sp_is_guard_surface) {
    $sp_shell_classes[] = 'sp-shell--guarded';
    $sp_shell_classes[] = 'sp-shell--secure-surface';
}

$sp_frame_classes = ['sp-app-frame'];

if (! $sp_has_sidebar) {
    $sp_frame_classes[] = 'sp-app-frame--no-sidebar';
}

if ($sp_is_guard_surface) {
    $sp_frame_classes[] = 'sp-app-frame--guarded';
}
?>

<div class="<?php echo esc_attr(implode(' ', $sp_shell_classes)); ?>" data-sp-zone="shell" data-sp-variant="<?php echo esc_attr($sp_variant); ?>" data-sp-shell-mode="<?php echo esc_attr($sp_is_guard_surface ? 'guarded' : 'standard'); ?>">
    <?php if ($sp_show_rolebar) : ?>
        <?php sp_render_app_rolebar(); ?>
    <?php endif; ?>

    <div class="<?php echo esc_attr($sp_container_class); ?>" data-sp-zone="frame">
        <div class="<?php echo esc_attr(implode(' ', $sp_frame_classes)); ?>" data-sp-zone="content-grid">
            <main class="sp-app-main" id="primary" aria-label="<?php echo esc_attr($sp_is_guard_surface ? 'Surface sécurisée' : 'Contenu principal applicatif'); ?>" data-sp-zone="content">
                <div class="<?php echo esc_attr($sp_plugin_shell_class . ($sp_is_guard_surface ? ' sp-plugin-shell--guarded' : '')); ?>">
                    <?php echo $sp_content; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped ?>
                    <?php
                    wp_link_pages(
                        array(
                            'before' => '<div class="page-links">' . esc_html__('Pages:', 'generatepress'),
                            'after'  => '</div>',
                        )
                    );
                    ?>
                </div>
            </main>

            <?php if ($sp_has_sidebar) : ?>
            <aside class="sp-app-sidebar" aria-label="Colonne latérale contextuelle" data-sp-zone="sidebar">
                <?php sp_render_context_sidebar(); ?>
            </aside>
            <?php endif; ?>
        </div>

        <?php if ($sp_show_legal_footer) : ?>
        <footer class="sp-app-legal-footer" aria-label="Informations juridiques applicatives" data-sp-zone="footer">
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
