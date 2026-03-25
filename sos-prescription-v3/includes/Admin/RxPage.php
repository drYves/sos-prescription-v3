<?php // includes/Admin/RxPage.php
declare(strict_types=1);

namespace SOSPrescription\Admin;

final class RxPage
{
    public static function render(): void
    {
        echo '<div class="wrap">';
        echo '<h1>Ordonnances (PDF)</h1>';
        echo '<div class="notice notice-info"><p><strong>Architecture V3 HDS :</strong> Les ordonnances sont désormais générées de manière déportée sur le coffre-fort Scalingo (Zéro-PII). Cette ancienne page de diagnostic local est obsolète et a été désactivée pour éviter les faux-positifs. Gérez vos templates directement dans le code source.</p></div>';
        echo '</div>';
    }
}
