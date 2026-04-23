<?php
/**
 * Template Name: SOS Console Layout V2
 * Version: 10.0.5-beta1
 *
 * Recovery structurel GP / SOS pour la console médecin :
 * - restauration d'un cadre console stable
 * - conservation du shell GeneratePress sur header / footer
 * - priorité absolue aux surfaces de garde
 * - convergence des surfaces d'entrée / authentification
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
$sp_content            = '';
$sp_detect_guard_surface = static function (string $html): bool {
    return str_contains($html, 'sp-plugin-root--guarded')
        || str_contains($html, 'sp-plugin-guard')
        || str_contains($html, 'sp-auth-entry--guarded')
        || str_contains($html, 'sp-auth-surface--guarded');
};
$sp_detect_entry_auth_surface = static function (string $html): bool {
    return str_contains($html, 'sp-auth-entry')
        || str_contains($html, 'sp-auth-surface')
        || str_contains($html, 'data-sp-auth-request-form="1"')
        || str_contains($html, 'data-sp-auth-verify="1"')
        || str_contains($html, 'data-sp-magic-redirect="1"')
        || str_contains($html, 'sp-magic-redirect');
};

while (have_posts()) {
    the_post();
    ob_start();
    the_content();
    $sp_content = (string) ob_get_clean();
}

$sp_is_guard_surface      = $sp_detect_guard_surface($sp_content);
$sp_is_entry_auth_surface = $sp_detect_entry_auth_surface($sp_content);
$sp_is_entry_shell        = $sp_is_guard_surface || $sp_is_entry_auth_surface;
$sp_show_console_bar      = ! $sp_is_entry_shell;
$sp_show_legal_footer     = ! $sp_is_entry_shell && ($sp_cgu_url !== '' || $sp_privacy_url !== '');

$sp_shell_classes = [
    'sp-shell',
    'sp-shell--console',
    'sp-shell--' . sanitize_html_class($sp_variant),
];

if ($sp_is_entry_auth_surface) {
    $sp_shell_classes[] = 'sp-shell--entry-auth';
}

if ($sp_is_guard_surface) {
    $sp_shell_classes[] = 'sp-shell--guarded';
    $sp_shell_classes[] = 'sp-shell--secure-surface';
}

$sp_console_frame_classes = ['sp-console-frame'];

if ($sp_is_entry_auth_surface) {
    $sp_console_frame_classes[] = 'sp-console-frame--entry-auth';
}

if ($sp_is_guard_surface) {
    $sp_console_frame_classes[] = 'sp-console-frame--guarded';
}

$sp_shell_mode = 'standard';
if ($sp_is_guard_surface) {
    $sp_shell_mode = 'guarded';
} elseif ($sp_is_entry_auth_surface) {
    $sp_shell_mode = 'entry-auth';
}

$sp_bridge_classes = $sp_plugin_shell_class . ' sp-shell-bridge sp-shell-bridge--console';
if ($sp_is_entry_auth_surface) {
    $sp_bridge_classes .= ' sp-shell-bridge--entry-auth';
}
if ($sp_is_guard_surface) {
    $sp_bridge_classes .= ' sp-plugin-shell--guarded';
}
?>

<div class="<?php echo esc_attr(implode(' ', $sp_shell_classes)); ?>" data-sp-zone="shell" data-sp-variant="<?php echo esc_attr($sp_variant); ?>" data-sp-shell-mode="<?php echo esc_attr($sp_shell_mode); ?>">
    <?php if ($sp_show_console_bar) : ?>
        <?php sp_render_console_bar(); ?>
    <?php endif; ?>

    <div class="<?php echo esc_attr($sp_container_class); ?>" data-sp-zone="frame">
        <div class="<?php echo esc_attr(implode(' ', $sp_console_frame_classes)); ?> sp-shell-content" id="primary" aria-label="<?php echo esc_attr($sp_is_entry_shell ? 'Surface d’accès sécurisée console' : 'Surface de travail console'); ?>" data-sp-zone="content">
            <div class="<?php echo esc_attr($sp_bridge_classes); ?>">
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
