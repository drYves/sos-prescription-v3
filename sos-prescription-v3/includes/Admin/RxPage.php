<?php // includes/Admin/RxPage.php
declare(strict_types=1);

namespace SOSPrescription\Admin;

final class RxPage
{
    public static function register_actions(): void
    {
        // No-op : l'écran legacy est retiré du backoffice.
    }

    public static function render_page(): void
    {
        self::render();
    }

    public static function render(): void
    {
        if (!current_user_can('sosprescription_manage') && !current_user_can('manage_options')) {
            wp_die('Accès refusé.');
        }

        echo '<div class="wrap">';
        echo '<h1>Ordonnances</h1>';
        echo '<div class="notice notice-warning"><p><strong>Écran retiré :</strong> cette interface legacy a été mise en quarantaine et ne fait plus partie du backoffice SOS Prescription.</p></div>';
        echo '<p>Aucune action opérateur ne doit être déclenchée ici. Les templates et le rendu actifs restent pilotés par les surfaces maintenues du plugin.</p>';
        echo '<p><strong>Important :</strong> aucun nettoyage manuel de fichiers ne doit être demandé depuis cet écran.</p>';
        echo '</div>';
    }
}
