<?php
declare(strict_types=1);

namespace SOSPrescription\Services;

/**
 * Configuration des "mentions" affichées côté patient (bandeau d'information).
 *
 * Objectifs :
 * - afficher clairement le périmètre (RO / continuité documentée), exclusions (stupéfiants, arrêt de travail, urgences),
 * - réduire les demandes hors-cadre,
 * - homogénéiser le micro-copy sur les pages sensibles.
 */
final class NoticesConfig
{
    public const OPTION_KEY = 'sosprescription_notices';

    /**
     * @return array<string, mixed>
     */
    public static function get(): array
    {
        $raw = get_option(self::OPTION_KEY);
        $cfg = is_array($raw) ? $raw : [];

        $defaults = [
            'enabled_form' => true,
            'enabled_patient' => true,
            'dismissible' => true,
            'title' => 'Informations importantes',
            // Une ligne = un point (puces). Autorise HTML léger (lien) mais sera kses côté rendu.
            'items_text' => "Service réservé aux renouvellements / continuité documentée (traitement déjà connu).\nAucun stupéfiant / médicament nécessitant une ordonnance sécurisée.\nAucun arrêt de travail.\nCe service ne traite pas les urgences : en cas d’urgence, appelez le 15 / 112.\nService privé : paiement direct (non remboursé par l’Assurance Maladie).",
            'updated_at' => '',
        ];

        $out = array_merge($defaults, $cfg);

        $out['enabled_form'] = (bool) $out['enabled_form'];
        $out['enabled_patient'] = (bool) $out['enabled_patient'];
        $out['dismissible'] = (bool) $out['dismissible'];

        $out['title'] = is_string($out['title']) ? trim($out['title']) : '';
        if ($out['title'] === '') {
            $out['title'] = (string) $defaults['title'];
        }

        $out['items_text'] = is_string($out['items_text']) ? trim($out['items_text']) : '';
        if ($out['items_text'] === '') {
            $out['items_text'] = (string) $defaults['items_text'];
        }

        $out['updated_at'] = is_string($out['updated_at']) ? (string) $out['updated_at'] : '';

        return $out;
    }

    /**
     * Mise à jour (admin).
     *
     * @param array<string, mixed> $fields
     */
    public static function update(array $fields): void
    {
        $current = self::get();
        $next = array_merge($current, $fields);
        $next['updated_at'] = current_time('mysql');

        update_option(self::OPTION_KEY, $next, false);
    }

    /**
     * Données exposées côté front (sans données sensibles).
     *
     * @return array<string, mixed>
     */
    public static function public_data(): array
    {
        $c = self::get();
        return [
            'enabled_form' => (bool) $c['enabled_form'],
            'enabled_patient' => (bool) $c['enabled_patient'],
            'dismissible' => (bool) $c['dismissible'],
            'title' => (string) $c['title'],
            'items_text' => (string) $c['items_text'],
        ];
    }
}
