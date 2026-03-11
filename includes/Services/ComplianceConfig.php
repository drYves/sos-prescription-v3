<?php
declare(strict_types=1);

namespace SosPrescription\Services;

/**
 * Configuration "Conformité" (MVP).
 *
 * Cette config ne remplace pas les obligations légales (HDS, PSSI, etc.),
 * mais permet de couvrir des points techniques :
 * - consentement explicite versionné,
 * - rétention (purge logs d'audit / fichiers orphelins / demandes non payées),
 * - paramètres visibles côté front (liens CGU / Confidentialité).
 */
final class ComplianceConfig
{
    public const OPTION_KEY = 'sosprescription_compliance';

    /**
     * Nom "produit" affiché dans les templates (PDF / vérification).
     *
     * Par défaut : nom du site WordPress, sinon "SOS Prescription".
     * Filtrable via : `sosprescription_product_name`.
     */
    public function get_product_name(): string
    {
        $site = (string) get_bloginfo('name');
        if (trim($site) === '') {
            $site = 'SOS Prescription';
        }
        /**
         * @param string $site
         */
        return (string) apply_filters('sosprescription_product_name', $site);
    }

    /**
     * @return array<string, mixed>
     */
    public static function get(): array
    {
        $raw = get_option(self::OPTION_KEY);
        $cfg = is_array($raw) ? $raw : [];

        $defaults = [
            // Consentement
            'consent_required' => true,
            'cgu_url' => '',
            'privacy_url' => '',
            'cgu_version' => '',
            'privacy_version' => '',

            // Rétention
            // NB: la conservation du dossier médical est un sujet réglementaire.
            // Ici on vise uniquement des purges techniques "raisonnables".
            'audit_retention_days' => 3650, // 10 ans par défaut
            'audit_purge_enabled' => true,

            'orphan_files_retention_days' => 7,
            'orphan_files_purge_enabled' => true,

            'unpaid_retention_days' => 30,
            'unpaid_purge_enabled' => false,

            'updated_at' => '',
        ];

        // Merge (cfg overrides defaults)
        $out = array_merge($defaults, $cfg);

        // Normalisation
        $out['consent_required'] = (bool) $out['consent_required'];
        $out['cgu_url'] = is_string($out['cgu_url']) ? trim($out['cgu_url']) : '';
        $out['privacy_url'] = is_string($out['privacy_url']) ? trim($out['privacy_url']) : '';
        $out['cgu_version'] = is_string($out['cgu_version']) ? trim($out['cgu_version']) : '';
        $out['privacy_version'] = is_string($out['privacy_version']) ? trim($out['privacy_version']) : '';

        $out['audit_retention_days'] = max(1, (int) $out['audit_retention_days']);
        $out['audit_purge_enabled'] = (bool) $out['audit_purge_enabled'];

        $out['orphan_files_retention_days'] = max(1, (int) $out['orphan_files_retention_days']);
        $out['orphan_files_purge_enabled'] = (bool) $out['orphan_files_purge_enabled'];

        $out['unpaid_retention_days'] = max(1, (int) $out['unpaid_retention_days']);
        $out['unpaid_purge_enabled'] = (bool) $out['unpaid_purge_enabled'];

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
     * Données "publiques" exposées au front (pas de rétention / pas d'infos sensibles).
     *
     * @return array<string, mixed>
     */
    public static function public_data(): array
    {
        $c = self::get();
        return [
            'consent_required' => (bool) $c['consent_required'],
            'cgu_url' => (string) $c['cgu_url'],
            'privacy_url' => (string) $c['privacy_url'],
            'cgu_version' => (string) $c['cgu_version'],
            'privacy_version' => (string) $c['privacy_version'],
        ];
    }
}
