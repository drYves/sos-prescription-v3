<?php // includes/Admin/RxPage.php
declare(strict_types=1);

namespace SOSPrescription\Admin;

final class RxPage
{
    public static function render(): void
    {
        echo '<div class="wrap">';
        echo '<h1>Ordonnances (PDF)</h1>';
        echo '<div class="notice notice-info"><p><strong>Architecture V3 HDS :</strong> Les ordonnances sont désormais générées de manière déportée sur le coffre-fort Scalingo (Zéro-PII). Cette ancienne page de diagnostic local est obsolète et a été désactivée pour éviter les faux-positifs.</p></div>';
        echo '<div class="notice notice-warning"><p><strong>ATTENTION IMPORTANTE :</strong> Vous devez supprimer TOUS les fichiers présents dans le dossier <code>wp-content/uploads/sosprescription-templates/</code> via votre FTP/Gestionnaire de fichiers. Ils créent un conflit avec le moteur de rendu de la version V3.</p></div>';
        echo '</div>';
    }
}
