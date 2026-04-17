<?php

declare(strict_types=1);

namespace SosPrescription\Services;

use WP_Error;
use WP_Post;

final class LegalPages
{
    public const OPTION_KEY = 'sosprescription_legal_pages';

    public const CORPUS_VERSION = '1.2.0';
    public const STORAGE_VERSION = '7.2.4';

    /** @var array<int, string> */
    private const PLACEHOLDER_FRAGMENTS = [
        '[à confirmer',
        '[a confirmer',
        'à confirmer avant publication',
        'a confirmer avant publication',
        'placeholder',
        'todo',
        'tbd',
        'à renseigner',
        'a renseigner',
    ];

    /** @var array<int, string> */
    private const MIGRATION_PRESERVE_REGISTRY_FIELDS = [
        'brand_name',
        'brand_registration_number',
        'brand_registration_date',
        'operator_name',
        'operator_identity',
        'publication_director',
        'main_contact_email',
        'privacy_contact_email',
        'complaint_contact',
        'doctor_enabled',
        'doctor_identity',
        'consent_required',
        'privacy_page_sync',
        'worker_runtime',
        'object_storage',
        'payment_provider',
        'site_url',
    ];


    /**
     * @return array<string, array<string, string>>
     */
    public static function slots(): array
    {
        return [
            'mentions' => [
                'label' => 'Mentions légales',
                'title' => 'Mentions légales',
                'slug' => 'mentions-legales',
                'shortcode_tag' => 'sosprescription_legal_mentions',
                'shortcode' => '[sosprescription_legal_mentions]',
            ],
            'conditions' => [
                'label' => 'Conditions du service, tarifs et paiement',
                'title' => 'Conditions du service, tarifs et paiement',
                'slug' => 'conditions-du-service',
                'shortcode_tag' => 'sosprescription_legal_cgu',
                'shortcode' => '[sosprescription_legal_cgu]',
            ],
            'privacy' => [
                'label' => 'Confidentialité, données de santé et cookies',
                'title' => 'Confidentialité, données de santé et cookies',
                'slug' => 'politique-de-confidentialite',
                'shortcode_tag' => 'sosprescription_legal_privacy',
                'shortcode' => '[sosprescription_legal_privacy]',
            ],
        ];
    }

    /**
     * @return array<string, array<string, mixed>>
     */
        /**
     * @return array<string, array<string, mixed>>
     */
    public static function global_field_definitions(): array
    {
        return [
            'consent_required' => [
                'label' => 'Consentement requis dans le tunnel',
                'type' => 'checkbox',
                'description' => 'Conserve l’exigence de consentement dans le tunnel patient existant.',
            ],
            'privacy_page_sync' => [
                'label' => 'Déclarer la page 3 comme privacy page native WordPress',
                'type' => 'checkbox',
                'description' => 'Active une synchronisation unidirectionnelle vers la page de confidentialité native de WordPress.',
            ],
            'worker_runtime' => [
                'label' => 'Exécution métier déclarée',
                'type' => 'text',
                'description' => 'Valeur partagée affichée dans la page confidentialité pour décrire le runtime métier séparé.',
            ],
            'object_storage' => [
                'label' => 'Stockage objet déclaré',
                'type' => 'text',
                'description' => 'Valeur partagée affichée pour le stockage objet publié.',
            ],
            'payment_provider' => [
                'label' => 'Prestataire de paiement déclaré',
                'type' => 'text',
                'description' => 'Prestataire de paiement mentionné dans les pages 2 et 3.',
            ],
        ];
    }


    /**
     * @return array<string, array<string, mixed>>
     */
        /**
     * @return array<string, array<string, mixed>>
     */
    public static function tab_definitions(): array
    {
        return [
            'mentions' => [
                'title' => 'Mentions légales',
                'description' => 'Identité de l’éditeur, publication, hébergement du site public et identification des intervenants techniques déclarés.',
                'sections' => [
                    'identity' => [
                        'title' => 'Éditeur, marque et publication',
                        'description' => 'Identité affichée publiquement dans la page 1.',
                    ],
                    'technical' => [
                        'title' => 'Hébergement et intervenants techniques',
                        'description' => 'Résumé public des acteurs techniques déclarés autour du site et du service.',
                    ],
                    'medical' => [
                        'title' => 'Référence médicale affichée',
                        'description' => 'Sous-section activable pour la référence médicale de travail.',
                    ],
                ],
                'fields' => [
                    'brand_name' => [
                        'section' => 'identity',
                        'label' => 'Marque affichée',
                        'type' => 'text',
                        'description' => 'Nom public de la marque ou du service.',
                    ],
                    'brand_registration_number' => [
                        'section' => 'identity',
                        'label' => 'Numéro de marque affiché',
                        'type' => 'text',
                        'description' => 'Numéro de dépôt ou d’enregistrement affiché dans les mentions.',
                    ],
                    'brand_registration_date' => [
                        'section' => 'identity',
                        'label' => 'Date de dépôt de la marque',
                        'type' => 'date',
                        'description' => 'Date publiée pour le dépôt de la marque.',
                    ],
                    'operator_name' => [
                        'section' => 'identity',
                        'label' => 'Éditeur / exploitant',
                        'type' => 'text',
                        'description' => 'Dénomination affichée publiquement comme exploitant du site et du service.',
                    ],
                    'operator_identity' => [
                        'section' => 'identity',
                        'label' => 'Identité juridique affichée',
                        'type' => 'textarea',
                        'layout' => 'full',
                        'description' => 'Adresse et références de l’exploitant, une information par ligne.',
                    ],
                    'publication_director' => [
                        'section' => 'identity',
                        'label' => 'Directeur de publication',
                        'type' => 'text',
                        'description' => 'Nom ou dénomination affiché comme responsable de la publication.',
                    ],
                    'main_contact_email' => [
                        'section' => 'identity',
                        'label' => 'Email de contact public',
                        'type' => 'email',
                        'description' => 'Adresse affichée pour le contact général du service.',
                    ],
                    'public_host_summary' => [
                        'section' => 'technical',
                        'label' => 'Hébergeur du site public',
                        'type' => 'textarea',
                        'layout' => 'full',
                        'description' => 'Résumé public de l’hébergement WordPress du site public.',
                    ],
                    'technical_maintainer_summary' => [
                        'section' => 'technical',
                        'label' => 'Maintenance technique',
                        'type' => 'textarea',
                        'layout' => 'full',
                        'description' => 'Résumé public du prestataire ou de l’équipe de maintenance.',
                    ],
                    'technical_interveners_summary' => [
                        'section' => 'technical',
                        'label' => 'Intervenants techniques déclarés',
                        'type' => 'textarea',
                        'layout' => 'full',
                        'description' => 'Une ligne par intervenant technique ou maillon publié de la chaîne.',
                    ],
                    'doctor_enabled' => [
                        'section' => 'medical',
                        'label' => 'Afficher la référence médicale',
                        'type' => 'checkbox',
                        'description' => 'Active la sous-section publique dédiée au médecin référent de travail.',
                    ],
                    'doctor_identity' => [
                        'section' => 'medical',
                        'label' => 'Médecin référent affiché',
                        'type' => 'text',
                        'description' => 'Affichage compact du médecin référent et de son RPPS.',
                    ],
                ],
            ],
            'conditions' => [
                'title' => 'Conditions du service, tarifs et paiement',
                'description' => 'Cadre du service, décision médicale, obligations du patient, paiement, responsabilité et litiges.',
                'sections' => [
                    'positioning' => [
                        'title' => 'Cadre du service',
                        'description' => 'Positionnement du service, périmètre et délais.',
                    ],
                    'patient' => [
                        'title' => 'Décision médicale et obligations du patient',
                        'description' => 'Sincérité, usage personnel de l’ordonnance, coordination des soins et accès aux documents.',
                    ],
                    'economics' => [
                        'title' => 'Tarifs, paiement, disponibilité et responsabilité',
                        'description' => 'Préautorisation, force majeure, responsabilité et réclamations.',
                    ],
                ],
                'fields' => [
                    'service_positioning' => [
                        'section' => 'positioning',
                        'label' => 'Positionnement du service',
                        'type' => 'textarea',
                        'layout' => 'full',
                        'description' => 'Résumé public du service, de sa nature privée, non urgente et asynchrone.',
                    ],
                    'eligibility_summary' => [
                        'section' => 'positioning',
                        'label' => 'Éligibilité et exclusions',
                        'type' => 'textarea',
                        'layout' => 'full',
                        'description' => 'Cadre d’usage, limites et cas exclus.',
                    ],
                    'response_delay' => [
                        'section' => 'positioning',
                        'label' => 'Délais de traitement',
                        'type' => 'textarea',
                        'layout' => 'full',
                        'description' => 'Formulation prudente sur le traitement asynchrone et les demandes d’informations complémentaires.',
                    ],
                    'medical_decision_summary' => [
                        'section' => 'patient',
                        'label' => 'Décision médicale et refus cliniques',
                        'type' => 'textarea',
                        'layout' => 'full',
                        'description' => 'Explique l’analyse humaine du dossier, l’indépendance du médecin et les motifs de refus ou de réorientation.',
                    ],
                    'patient_honesty_summary' => [
                        'section' => 'patient',
                        'label' => 'Devoir de sincérité du patient',
                        'type' => 'textarea',
                        'layout' => 'full',
                        'description' => 'Une ligne par obligation ou exigence d’usage loyal du service.',
                    ],
                    'prescription_usage_summary' => [
                        'section' => 'patient',
                        'label' => 'Usage personnel de l’ordonnance et coordination des soins',
                        'type' => 'textarea',
                        'layout' => 'full',
                        'description' => 'Une ligne par rappel public sur l’usage personnel, la validité pratique et l’information du médecin traitant.',
                    ],
                    'reversibility_summary' => [
                        'section' => 'patient',
                        'label' => 'Accès aux ordonnances et conservation des documents',
                        'type' => 'textarea',
                        'layout' => 'full',
                        'description' => 'Décrit la réversibilité d’accès et l’obligation pour le patient de conserver ses documents.',
                    ],
                    'pricing_summary' => [
                        'section' => 'economics',
                        'label' => 'Tarifs',
                        'type' => 'textarea',
                        'layout' => 'full',
                        'description' => 'Texte public sur le tarif, son affichage et l’absence de garantie de prescription.',
                    ],
                    'payment_summary' => [
                        'section' => 'economics',
                        'label' => 'Paiement et préautorisation',
                        'type' => 'textarea',
                        'layout' => 'full',
                        'description' => 'Explique le fonctionnement Stripe sans présenter le service comme un achat standard.',
                    ],
                    'force_majeure_summary' => [
                        'section' => 'economics',
                        'label' => 'Disponibilité, maintenance et force majeure',
                        'type' => 'textarea',
                        'layout' => 'full',
                        'description' => 'Décrit les limites raisonnables de disponibilité, les maintenances et les événements hors contrôle.',
                    ],
                    'liability_summary' => [
                        'section' => 'economics',
                        'label' => 'Responsabilité',
                        'type' => 'textarea',
                        'layout' => 'full',
                        'description' => 'Formulation prudente sur la responsabilité du service et les limites qui peuvent être rappelées publiquement.',
                    ],
                    'disputes_summary' => [
                        'section' => 'economics',
                        'label' => 'Réclamations et litiges',
                        'type' => 'textarea',
                        'layout' => 'full',
                        'description' => 'Formulation publique sur les réclamations et le traitement des contestations.',
                    ],
                    'complaint_contact' => [
                        'section' => 'economics',
                        'label' => 'Contact réclamations',
                        'type' => 'email',
                        'description' => 'Adresse affichée pour les réclamations non urgentes.',
                    ],
                ],
            ],
            'privacy' => [
                'title' => 'Confidentialité, données de santé et cookies',
                'description' => 'Contact confidentialité, finalités, chaîne de sous-traitance, incidents, archivage et cookies.',
                'sections' => [
                    'privacy_contact' => [
                        'title' => 'Responsable du traitement, contact et finalités',
                        'description' => 'Contact confidentialité, DPO éventuel, catégories de données et finalités.',
                    ],
                    'processors' => [
                        'title' => 'Chaîne technique et sous-traitance',
                        'description' => 'Résumé public de l’architecture déclarée et de la chaîne de sous-traitance.',
                    ],
                    'security' => [
                        'title' => 'Sécurité, incidents, conservation et droits',
                        'description' => 'Mesures générales, incidents, archivage, effacement, assistance et cookies.',
                    ],
                ],
                'fields' => [
                    'privacy_contact_email' => [
                        'section' => 'privacy_contact',
                        'label' => 'Contact confidentialité',
                        'type' => 'email',
                        'description' => 'Point de contact dédié aux demandes relatives aux données personnelles.',
                    ],
                    'dpo_declared' => [
                        'section' => 'privacy_contact',
                        'label' => 'DPO formel déclaré',
                        'type' => 'checkbox',
                        'description' => 'À activer uniquement si un DPO est réellement formalisé.',
                    ],
                    'dpo_identity' => [
                        'section' => 'privacy_contact',
                        'label' => 'DPO affiché',
                        'type' => 'text',
                        'description' => 'Nom ou qualité du DPO, si déclaré.',
                    ],
                    'purposes_summary' => [
                        'section' => 'privacy_contact',
                        'label' => 'Finalités principales',
                        'type' => 'textarea',
                        'layout' => 'full',
                        'description' => 'Résumé public des finalités de traitement.',
                    ],
                    'data_categories_summary' => [
                        'section' => 'privacy_contact',
                        'label' => 'Catégories de données',
                        'type' => 'textarea',
                        'layout' => 'full',
                        'description' => 'Une ligne par famille de données traitées.',
                    ],
                    'processor_summary' => [
                        'section' => 'processors',
                        'label' => 'Architecture et sous-traitance publiée',
                        'type' => 'textarea',
                        'layout' => 'full',
                        'description' => 'Résumé public de la séparation WordPress / worker et des grands prestataires.',
                    ],
                    'subprocessor_chain_summary' => [
                        'section' => 'processors',
                        'label' => 'Chaîne de sous-traitance détaillée',
                        'type' => 'textarea',
                        'layout' => 'full',
                        'description' => 'Une ligne par acteur, avec son rôle public.',
                    ],
                    'hosting_hds_summary' => [
                        'section' => 'processors',
                        'label' => 'Hébergement de données de santé / HDS',
                        'type' => 'textarea',
                        'layout' => 'full',
                        'description' => 'Précise le cadre HDS et la localisation publiée des traitements sensibles.',
                    ],
                    'security_summary' => [
                        'section' => 'security',
                        'label' => 'Mesures générales de sécurité',
                        'type' => 'textarea',
                        'layout' => 'full',
                        'description' => 'Une ligne par mesure ou engagement général de sécurité publié.',
                    ],
                    'incident_management_summary' => [
                        'section' => 'security',
                        'label' => 'Gestion des incidents et violations de données',
                        'type' => 'textarea',
                        'layout' => 'full',
                        'description' => 'Explique l’analyse des incidents, la remédiation et les notifications réglementaires.',
                    ],
                    'retention_summary' => [
                        'section' => 'security',
                        'label' => 'Conservation des données',
                        'type' => 'textarea',
                        'layout' => 'full',
                        'description' => 'Décrit la logique générale de conservation et de cycle de vie des données.',
                    ],
                    'archival_vs_erasure_summary' => [
                        'section' => 'security',
                        'label' => 'Archivage, suspension et limites du droit à l’effacement',
                        'type' => 'textarea',
                        'layout' => 'full',
                        'description' => 'Explique pourquoi une suspension de compte n’équivaut pas toujours à un effacement immédiat.',
                    ],
                    'rights_assistance_summary' => [
                        'section' => 'security',
                        'label' => 'Assistance aux droits des personnes',
                        'type' => 'textarea',
                        'layout' => 'full',
                        'description' => 'Décrit l’exercice des droits, l’assistance des prestataires et le recours à la CNIL.',
                    ],
                    'ai_summary' => [
                        'section' => 'security',
                        'label' => 'IA / assistance documentaire',
                        'type' => 'textarea',
                        'layout' => 'full',
                        'description' => 'Décrit l’assistance algorithmique sans la présenter comme une décision médicale automatisée.',
                    ],
                    'cookies_list' => [
                        'section' => 'security',
                        'label' => 'Liste des cookies / traceurs',
                        'type' => 'textarea',
                        'layout' => 'full',
                        'description' => 'Une ligne par famille de cookies ou de traceurs.',
                    ],
                ],
            ],
        ];
    }


    /**
     * @return array<string, mixed>
     */
        /**
     * @return array<string, mixed>
     */
    public static function get_state(): array
    {
        $raw = get_option(self::OPTION_KEY, null);
        $stored = is_array($raw) ? $raw : [];
        $defaults = self::default_state();

        $storedRegistry = is_array($stored['registry'] ?? null) ? $stored['registry'] : [];
        $storedCorpusVersion = is_string($stored['corpus_version'] ?? null) ? trim((string) $stored['corpus_version']) : '';
        $forceCorpusDefaults = $storedCorpusVersion === '' || version_compare($storedCorpusVersion, self::CORPUS_VERSION, '<');

        $state = array_merge($defaults, $stored);
        $state['corpus_version'] = self::CORPUS_VERSION;
        $state['storage_version'] = self::STORAGE_VERSION;
        $state['registry'] = self::normalize_registry($storedRegistry, is_array($defaults['registry'] ?? null) ? $defaults['registry'] : [], $forceCorpusDefaults);

        foreach (array_keys(self::slots()) as $slot) {
            $slotDefaults = is_array($defaults[$slot] ?? null) ? $defaults[$slot] : [];
            $storedSlot = is_array($stored[$slot] ?? null) ? $stored[$slot] : [];

            if ($forceCorpusDefaults) {
                $slotState = $slotDefaults;
                if (isset($storedSlot['page_id'])) {
                    $slotState['page_id'] = max(0, (int) $storedSlot['page_id']);
                }
            } else {
                $slotState = array_merge($slotDefaults, $storedSlot);
            }

            $slotState['page_id'] = max(0, (int) ($slotState['page_id'] ?? 0));
            $slotState['version'] = self::normalize_version((string) ($slotState['version'] ?? ($slotDefaults['version'] ?? self::CORPUS_VERSION)));
            $slotState['effective_date'] = self::normalize_date_string((string) ($slotState['effective_date'] ?? ''), (string) ($slotDefaults['effective_date'] ?? self::today()));
            $slotState['updated_at'] = self::normalize_date_string((string) ($slotState['updated_at'] ?? ''), (string) $slotState['effective_date']);
            $slotState['sources_public'] = self::normalize_sources($forceCorpusDefaults ? ($slotDefaults['sources_public'] ?? []) : ($storedSlot['sources_public'] ?? ($slotDefaults['sources_public'] ?? [])));

            $state[$slot] = $slotState;
        }

        $state['updated_at'] = is_string($stored['updated_at'] ?? null)
            ? trim((string) $stored['updated_at'])
            : (string) ($defaults['updated_at'] ?? '');

        $shouldPersist = self::state_needs_persist($stored, $state);
        if ($shouldPersist) {
            update_option(self::OPTION_KEY, $state, false);
            self::sync_compatibility($state, self::calculate_dashboard_bindings($state));
        }

        return $state;
    }


    public static function corpus_version(): string
    {
        return self::CORPUS_VERSION;
    }

    public static function storage_version(): string
    {
        return self::STORAGE_VERSION;
    }

    /**
     * @return array<string, array<string, mixed>>
     */
    private static function all_field_definitions(): array
    {
        $definitions = self::global_field_definitions();

        foreach (self::tab_definitions() as $tab) {
            foreach ((array) ($tab['fields'] ?? []) as $fieldName => $definition) {
                $definitions[$fieldName] = is_array($definition) ? $definition : [];
            }
        }

        return $definitions;
    }

    /**
     * @param array<string, mixed> $registry
     * @param array<string, mixed> $defaultsRegistry
     * @return array<string, mixed>
     */
    private static function normalize_registry(array $registry, array $defaultsRegistry, bool $forceCorpusDefaults): array
    {
        $definitions = self::all_field_definitions();
        $normalized = [];

        foreach ($defaultsRegistry as $key => $default) {
            $definition = is_array($definitions[$key] ?? null) ? $definitions[$key] : [];
            $type = (string) ($definition['type'] ?? self::guess_field_type($default));
            $candidate = array_key_exists($key, $registry) ? $registry[$key] : $default;

            if ($forceCorpusDefaults && !in_array($key, self::MIGRATION_PRESERVE_REGISTRY_FIELDS, true)) {
                $candidate = $default;
            }

            if (self::is_placeholder_like($candidate)) {
                $candidate = $default;
            }

            $normalized[$key] = self::normalize_registry_value($key, $candidate, $type, $default);
        }

        return $normalized;
    }

    /**
     * @param mixed $candidate
     * @param mixed $default
     * @return mixed
     */
    private static function normalize_registry_value(string $key, mixed $candidate, string $type, mixed $default): mixed
    {
        if ($key === 'site_url') {
            $sanitized = esc_url_raw(is_scalar($candidate) ? (string) $candidate : '');
            $fallback = esc_url_raw(is_scalar($default) ? (string) $default : home_url('/'));
            return $sanitized !== '' ? $sanitized : $fallback;
        }

        return self::sanitize_field($candidate, $type, $default);
    }

    /**
     * @param mixed $default
     */
    private static function guess_field_type(mixed $default): string
    {
        return match (true) {
            is_bool($default) => 'checkbox',
            default => 'text',
        };
    }

    /**
     * @param array<string, mixed> $stored
     * @param array<string, mixed> $state
     */
    private static function state_needs_persist(array $stored, array $state): bool
    {
        return wp_json_encode($stored) !== wp_json_encode($state);
    }

    private static function is_placeholder_like(mixed $value): bool
    {
        if (!is_scalar($value)) {
            return false;
        }

        $candidate = trim((string) $value);
        if ($candidate === '') {
            return false;
        }

        $normalized = function_exists('mb_strtolower') ? mb_strtolower($candidate, 'UTF-8') : strtolower($candidate);
        foreach (self::PLACEHOLDER_FRAGMENTS as $fragment) {
            if ($fragment !== '' && str_contains($normalized, $fragment)) {
                return true;
            }
        }

        return false;
    }

    /**
     * @param array<string, mixed> $state
     */
        /**
     * @param array<string, mixed> $state
     */
    public static function save_state(array $state): void
    {
        $current = self::get_state();
        $next = array_merge($current, $state);
        $next['corpus_version'] = self::CORPUS_VERSION;
        $next['storage_version'] = self::STORAGE_VERSION;
        $next['updated_at'] = current_time('mysql');
        update_option(self::OPTION_KEY, $next, false);
    }


    /**
     * @param array<string, mixed> $post
     * @return array<string, mixed>
     */
    public static function build_state_from_admin_submission(array $post, string $activeTab): array
    {
        $current = self::get_state();
        $registry = is_array($current['registry'] ?? null) ? $current['registry'] : [];

        foreach (self::global_field_definitions() as $field => $def) {
            $registry[$field] = self::sanitize_field($post[$field] ?? null, (string) ($def['type'] ?? 'text'), $registry[$field] ?? null);
        }

        $tabs = self::tab_definitions();
        if (isset($tabs[$activeTab]['fields']) && is_array($tabs[$activeTab]['fields'])) {
            foreach ($tabs[$activeTab]['fields'] as $field => $def) {
                $registry[$field] = self::sanitize_field($post[$field] ?? null, (string) ($def['type'] ?? 'text'), $registry[$field] ?? null);
            }
        }

        $slotState = is_array($current[$activeTab] ?? null) ? $current[$activeTab] : [];
        $today = self::today();
        $slotState['version'] = self::normalize_version((string) ($post[$activeTab . '_version'] ?? ($slotState['version'] ?? '1.0.0')));
        $slotState['effective_date'] = self::normalize_date_string((string) ($post[$activeTab . '_effective_date'] ?? ($slotState['effective_date'] ?? $today)), $today);
        $slotState['updated_at'] = $today;

        $current['registry'] = $registry;
        $current[$activeTab] = array_merge($current[$activeTab], $slotState);
        $current['updated_at'] = current_time('mysql');

        return $current;
    }

    /**
     * @param array<string, mixed> $state
     * @return array<string, array<string, mixed>>
     */
    private static function calculate_dashboard_bindings(array $state): array
    {
        $rows = [];

        foreach (self::slots() as $slot => $def) {
            $slug = (string) $def['slug'];
            $shortcodeTag = (string) $def['shortcode_tag'];
            $canonicalShortcode = (string) $def['shortcode'];
            $configuredPageId = (int) ($state[$slot]['page_id'] ?? 0);
            $configuredPost = $configuredPageId > 0 ? get_post($configuredPageId) : null;
            $slugPost = self::get_page_by_slug($slug);

            $statusKey = 'missing';
            $statusLabel = 'Manquante';
            $details = 'Aucune page publique liée n’a été détectée.';
            $page = null;
            $valid = false;
            $source = 'none';

            if ($slugPost instanceof WP_Post) {
                $page = $slugPost;
                $source = 'slug';
                $inspection = self::inspect_page($slugPost, $slug, $shortcodeTag, $canonicalShortcode);
                $statusKey = $inspection['status_key'];
                $statusLabel = $inspection['status_label'];
                $details = $inspection['details'];
                $valid = $inspection['valid'];
            }

            if ($configuredPost instanceof WP_Post) {
                $inspection = self::inspect_page($configuredPost, $slug, $shortcodeTag, $canonicalShortcode);

                if ($slugPost instanceof WP_Post && (int) $slugPost->ID !== (int) $configuredPost->ID && self::page_uses_shortcode($configuredPost, $shortcodeTag)) {
                    $page = $configuredPost;
                    $statusKey = 'occupied_slug';
                    $statusLabel = 'Ambiguë';
                    $details = 'Une page liée existe, mais le slug canonique est déjà occupé par une autre page.';
                    $valid = false;
                    $source = 'binding';
                } elseif (!$valid && !($slugPost instanceof WP_Post)) {
                    $page = $configuredPost;
                    $statusKey = $inspection['status_key'];
                    $statusLabel = $inspection['status_label'];
                    $details = $inspection['details'];
                    $valid = $inspection['valid'];
                    $source = 'binding';
                } elseif ($valid && $page instanceof WP_Post && (int) $page->ID === (int) $configuredPost->ID) {
                    $source = 'binding';
                }
            }

            $rows[$slot] = [
                'slot' => $slot,
                'label' => (string) $def['label'],
                'title' => (string) $def['title'],
                'slug' => $slug,
                'shortcode_tag' => $shortcodeTag,
                'shortcode' => $canonicalShortcode,
                'configured_page_id' => $configuredPageId,
                'page_id' => $page instanceof WP_Post ? (int) $page->ID : 0,
                'page_title' => $page instanceof WP_Post ? (string) $page->post_title : '',
                'page_status' => $page instanceof WP_Post ? (string) $page->post_status : '',
                'permalink' => $page instanceof WP_Post ? (string) get_permalink($page) : '',
                'status_key' => $statusKey,
                'status_label' => $statusLabel,
                'details' => $details,
                'source' => $source,
                'valid' => $valid,
                'version' => (string) ($state[$slot]['version'] ?? self::CORPUS_VERSION),
                'effective_date' => (string) ($state[$slot]['effective_date'] ?? self::today()),
                'updated_at' => (string) ($state[$slot]['updated_at'] ?? self::today()),
            ];
        }

        return $rows;
    }

    /**
     * @return array<string, array<string, mixed>>
     */
        /**
     * @return array<string, array<string, mixed>>
     */
    public static function get_dashboard_bindings(): array
    {
        return self::calculate_dashboard_bindings(self::get_state());
    }


    /**
     * @return array<string, mixed>
     */
    public static function ensure_pages(): array
    {
        $state = self::get_state();
        $bindings = self::get_dashboard_bindings();
        $created = [];
        $updated = [];
        $bound = [];
        $errors = [];

        foreach (self::slots() as $slot => $def) {
            $binding = $bindings[$slot] ?? null;
            if (!is_array($binding)) {
                $errors[] = sprintf('Impossible de résoudre le binding pour « %s ».', (string) $def['title']);
                continue;
            }

            $resolvedPageId = 0;
            $createdHere = false;
            $updatedHere = false;
            $statusKey = (string) ($binding['status_key'] ?? 'missing');
            $existingPageId = (int) ($binding['page_id'] ?? 0);
            $configuredPageId = (int) ($binding['configured_page_id'] ?? 0);

            if (!empty($binding['valid']) && $existingPageId > 0) {
                $resolvedPageId = $existingPageId;
            } elseif ($statusKey === 'missing') {
                $inserted = wp_insert_post([
                    'post_type' => 'page',
                    'post_status' => 'publish',
                    'post_title' => (string) $def['title'],
                    'post_name' => (string) $def['slug'],
                    'post_content' => (string) $def['shortcode'],
                ], true);

                if ($inserted instanceof WP_Error) {
                    $errors[] = sprintf('Création impossible pour « %s » : %s', (string) $def['title'], $inserted->get_error_message());
                    continue;
                }

                $resolvedPageId = (int) $inserted;
                $createdHere = true;
            } elseif (in_array($statusKey, ['modified_manually', 'incorrect_shortcode'], true) && $existingPageId > 0) {
                $resolvedPageId = $existingPageId;
                $updatedHere = true;
            } elseif ($statusKey === 'incorrect_slug' && $configuredPageId > 0 && !self::slug_is_occupied((string) $def['slug'], $configuredPageId)) {
                $resolvedPageId = $configuredPageId;
                $updatedHere = true;
            } else {
                $errors[] = sprintf(
                    'Le document « %s » nécessite une résolution manuelle : %s',
                    (string) $def['title'],
                    (string) ($binding['details'] ?? 'état non résolu')
                );
                continue;
            }

            $update = wp_update_post([
                'ID' => $resolvedPageId,
                'post_title' => (string) $def['title'],
                'post_name' => (string) $def['slug'],
                'post_status' => 'publish',
                'post_content' => (string) $def['shortcode'],
            ], true);

            if ($update instanceof WP_Error) {
                $errors[] = sprintf('Mise à jour impossible pour « %s » : %s', (string) $def['title'], $update->get_error_message());
                continue;
            }

            $state[$slot]['page_id'] = $resolvedPageId;
            if ($createdHere || $updatedHere) {
                $state[$slot]['updated_at'] = self::today();
            }

            $bound[$slot] = $resolvedPageId;
            if ($createdHere) {
                $created[$slot] = $resolvedPageId;
            }
            if ($updatedHere) {
                $updated[$slot] = $resolvedPageId;
            }
        }

        self::save_state($state);
        $bindingsAfter = self::get_dashboard_bindings();
        self::sync_compatibility($state, $bindingsAfter);

        return [
            'created' => $created,
            'updated' => $updated,
            'bound' => $bound,
            'errors' => $errors,
            'bindings' => $bindingsAfter,
        ];
    }

    public static function render(string $slot): string
    {
        $state = self::get_state();

        return match ($slot) {
            'mentions' => self::render_mentions($state),
            'conditions' => self::render_conditions($state),
            'privacy' => self::render_privacy($state),
            default => '',
        };
    }

    public static function render_cookies_shortcode(): string
    {
        return self::render_cookies_fragment(self::get_state(), true);
    }

    public static function should_enqueue_public_assets(WP_Post $post): bool
    {
        $postContent = (string) $post->post_content;
        $slug = (string) $post->post_name;

        foreach (self::slots() as $def) {
            if ($slug === (string) $def['slug']) {
                return true;
            }
            if (has_shortcode($postContent, (string) $def['shortcode_tag'])) {
                return true;
            }
        }

        return has_shortcode($postContent, 'sosprescription_legal_cookies');
    }

        private static function render_mentions(array $state): string
    {
        $registry = is_array($state['registry'] ?? null) ? $state['registry'] : [];
        $operatorName = self::safe_or_default((string) ($registry['operator_name'] ?? ''), 'Digital Pacifika');
        $operatorIdentity = self::multiline_html((string) ($registry['operator_identity'] ?? ''));
        $publicationDirector = self::safe_or_default((string) ($registry['publication_director'] ?? ''), $operatorName);
        $mainContact = self::safe_or_default((string) ($registry['main_contact_email'] ?? ''), 'contact@sosprescription.fr');
        $hostSummary = self::safe_or_default((string) ($registry['public_host_summary'] ?? ''), 'Hostinger — offre Cloud Startup — hébergement du site public WordPress');
        $maintainerSummary = self::safe_or_default((string) ($registry['technical_maintainer_summary'] ?? ''), 'Digital Pacifika — maintenance technique du site');
        $technicalInterveners = self::lines((string) ($registry['technical_interveners_summary'] ?? ''));
        $doctorEnabled = !empty($registry['doctor_enabled']);
        $doctorIdentity = self::safe_or_default((string) ($registry['doctor_identity'] ?? ''), 'Dr Yves Burckel — Médecin urgentiste — RPPS 10000554302');
        $brandName = self::safe_or_default((string) ($registry['brand_name'] ?? ''), 'SOS Prescription');
        $brandNumber = self::safe_or_default((string) ($registry['brand_registration_number'] ?? ''), '5002143');
        $brandDate = self::format_date((string) ($registry['brand_registration_date'] ?? '2023-10-29'));

        $html = '<div class="sp-legal-document sp-legal-document--mentions">';
        $html .= self::render_meta_block('mentions', $state, 'Document public d’identification', 'Informations relatives à l’éditeur du site, à l’hébergement du site public, aux intervenants techniques déclarés et aux principaux liens de contact.');
        $html .= self::lead('Les présentes mentions légales identifient l’éditeur du site et du service SOS Prescription, l’hébergement du site public, les principaux intervenants techniques déclarés ainsi que les principaux contacts associés à la publication.');
        $html .= self::callout([
            'Service privé de continuité thérapeutique',
            'Service non urgent et asynchrone',
            'Aucune prescription n’est garantie',
        ]);

        $html .= '<section>';
        $html .= '<h2>Éditeur du site et du service</h2>';
        $html .= self::definition_list([
            'Marque exploitée' => esc_html($brandName),
            'Numéro de marque' => esc_html($brandNumber),
            'Date de dépôt indiquée' => esc_html($brandDate),
            'Exploitant' => esc_html($operatorName),
            'Identité juridique affichée' => $operatorIdentity,
            'Contact public' => '<a href="mailto:' . esc_attr($mainContact) . '">' . esc_html($mainContact) . '</a>',
        ]);
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Direction de la publication</h2>';
        $html .= self::paragraph('La direction de la publication du site est assurée par <strong>' . esc_html($publicationDirector) . '</strong>.');
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Hébergement et maintenance du site public</h2>';
        $html .= self::definition_list([
            'Hébergeur du site public' => esc_html($hostSummary),
            'Maintenance technique' => esc_html($maintainerSummary),
            'Architecture déclarée' => 'WordPress agit comme façade publique. Les traitements métier sensibles sont opérés dans une couche séparée et les données sensibles sont déclarées comme hébergées en France selon l’architecture de référence du service.',
        ]);
        if ($technicalInterveners !== []) {
            $html .= self::paragraph('Les intervenants techniques publiquement déclarés pour le service sont les suivants :');
            $html .= self::unordered_list(array_map(static fn(string $line): string => esc_html($line), $technicalInterveners));
        }
        $html .= '</section>';

        if ($doctorEnabled) {
            $html .= '<section>';
            $html .= '<h2>Médecin référent mentionné</h2>';
            $html .= self::paragraph('Lorsque la structure publique du service le requiert, la référence médicale affichée est la suivante : <strong>' . esc_html($doctorIdentity) . '</strong>.');
            $html .= '</section>';
        }

        $html .= '<section>';
        $html .= '<h2>Propriété intellectuelle</h2>';
        $html .= self::paragraph('Les contenus, signes distinctifs, marques, textes, éléments graphiques et éléments de présentation du site relèvent du droit applicable. Sauf autorisation préalable, toute reproduction, représentation ou réutilisation non autorisée est interdite.');
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Documents associés</h2>';
        $html .= self::paragraph('Les présentes mentions légales se lisent avec les conditions du service, tarifs et paiement ainsi qu’avec la page confidentialité, données de santé et cookies, qui détaillent respectivement le cadre du service et le traitement des données.');
        $html .= self::render_internal_links([
            [self::page_url('conditions', $state), 'Consulter les conditions du service, tarifs et paiement'],
            [self::page_url('privacy', $state), 'Consulter la page confidentialité, données de santé et cookies'],
        ]);
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Sources publiques</h2>';
        $html .= self::source_list((array) ($state['mentions']['sources_public'] ?? []));
        $html .= '</section>';
        $html .= '</div>';

        return $html;
    }



        private static function render_conditions(array $state): string
    {
        $registry = is_array($state['registry'] ?? null) ? $state['registry'] : [];
        $servicePositioning = self::safe_or_default((string) ($registry['service_positioning'] ?? ''), 'SOS Prescription est un service privé, non urgent et asynchrone de continuité thérapeutique. Il permet à un patient, dans un cadre strictement défini, de solliciter l’analyse de sa situation par un médecin afin de déterminer s’il y a lieu ou non d’émettre une ordonnance de relais.');
        $eligibility = self::safe_or_default((string) ($registry['eligibility_summary'] ?? ''), 'Le service est réservé aux demandes compatibles avec un besoin de continuité de traitement. Il ne remplace pas une prise en charge d’urgence, un diagnostic en temps réel, ni une consultation adaptée en cas de symptômes nouveaux, graves ou évolutifs.');
        $responseDelay = self::safe_or_default((string) ($registry['response_delay'] ?? ''), 'Les demandes sont traitées de manière asynchrone. Les délais peuvent varier selon la complétude du dossier, le volume de demandes et la disponibilité médicale.');
        $medicalDecisionSummary = self::safe_or_default((string) ($registry['medical_decision_summary'] ?? ''), 'Chaque dossier fait l’objet d’une analyse humaine par un médecin. La décision médicale demeure personnelle, indépendante et non automatisée.');
        $patientHonestyItems = self::lines((string) ($registry['patient_honesty_summary'] ?? ''));
        $prescriptionUsageParagraphs = self::lines((string) ($registry['prescription_usage_summary'] ?? ''));
        $reversibilityParagraphs = self::lines((string) ($registry['reversibility_summary'] ?? ''));
        $pricing = self::safe_or_default((string) ($registry['pricing_summary'] ?? ''), 'Le tarif applicable est affiché au patient avant validation finale de sa demande. Le paiement ne doit pas être compris comme l’achat automatique d’une ordonnance ou d’un médicament. Aucune prescription n’est garantie.');
        $paymentSummary = self::safe_or_default((string) ($registry['payment_summary'] ?? ''), 'La plateforme peut solliciter une préautorisation bancaire via Stripe avant l’analyse médicale du dossier. La capture effective ou l’annulation intervient ensuite selon l’issue du traitement médical.');
        $forceMajeureParagraphs = self::lines((string) ($registry['force_majeure_summary'] ?? ''));
        $liabilityParagraphs = self::lines((string) ($registry['liability_summary'] ?? ''));
        $disputesParagraphs = self::lines((string) ($registry['disputes_summary'] ?? ''));
        $complaintContact = self::safe_or_default((string) ($registry['complaint_contact'] ?? ''), self::safe_or_default((string) ($registry['main_contact_email'] ?? ''), 'contact@sosprescription.fr'));
        $paymentProvider = self::safe_or_default((string) ($registry['payment_provider'] ?? ''), 'Stripe');
        $doctorEnabled = !empty($registry['doctor_enabled']);
        $doctorIdentity = self::safe_or_default((string) ($registry['doctor_identity'] ?? ''), 'Dr Yves Burckel — Médecin urgentiste — RPPS 10000554302');

        if ($patientHonestyItems === []) {
            $patientHonestyItems = [
                'répondre honnêtement au questionnaire et aux demandes complémentaires, au mieux de sa connaissance ;',
                'ne pas soumettre une demande pour le compte d’un tiers ni utiliser l’identité d’un tiers ;',
                'signaler sans délai toute information nouvelle susceptible de modifier l’appréciation du dossier ;',
                'ne pas transmettre de documents falsifiés, trompeurs ou illicites ;',
                'conserver ses identifiants d’accès confidentiels et ne pas partager son compte ;',
                'ne pas utiliser le service dans une situation d’urgence ou hors de son périmètre normal.',
            ];
        }

        if ($prescriptionUsageParagraphs === []) {
            $prescriptionUsageParagraphs = [
                'Lorsqu’une ordonnance de relais est mise à disposition, elle est strictement personnelle. Elle ne doit pas être cédée, partagée, réutilisée pour un tiers ni utilisée en dehors du cadre fixé par le médecin.',
                'Le patient est invité à télécharger, lire et conserver sans attendre tout document mis à sa disposition dans son espace. Il lui appartient également de lire la notice du traitement, de respecter la prescription, ainsi que de vérifier la durée de validité applicable à l’ordonnance et aux médicaments concernés.',
                'Pour la première délivrance des médicaments en pharmacie, une ordonnance doit en principe être présentée dans les trois mois de sa rédaction, sous réserve des règles particulières applicables à certains produits, des mentions de renouvellement et des limites fixées par le prescripteur.',
                'Afin de favoriser la continuité et la sécurité des soins, il est fortement recommandé au patient d’informer son médecin traitant, ainsi que tout professionnel de santé qui le suit utilement, des traitements ou documents obtenus via le service.',
            ];
        }

        if ($reversibilityParagraphs === []) {
            $reversibilityParagraphs = [
                'L’accès à une ordonnance ou à un document mis à disposition peut être limité dans le temps pour des raisons de sécurité, d’archivage, de fermeture de compte ou d’organisation technique.',
                'Le patient est donc invité à conserver sans délai les documents qui lui sont remis, y compris lorsque l’accès à son compte est suspendu ou désactivé.',
            ];
        }

        if ($forceMajeureParagraphs === []) {
            $forceMajeureParagraphs = [
                'SOS Prescription s’efforce d’assurer un accès raisonnablement stable au service, sans garantir une disponibilité continue ni l’absence totale d’interruption.',
                'L’accès peut être suspendu, limité ou ralenti en cas de maintenance, de mise à jour, d’incident technique, de mesure de sécurité, de saturation ou d’événement échappant raisonnablement au contrôle du service.',
                'Aucune partie ne pourra être tenue responsable d’un retard ou d’une inexécution résultant d’un cas de force majeure ou d’un événement extérieur équivalent au sens du droit applicable.',
            ];
        }

        if ($liabilityParagraphs === []) {
            $liabilityParagraphs = [
                'SOS Prescription demeure tenu d’une obligation de moyens dans le fonctionnement de la plateforme et du parcours numérique.',
                'La responsabilité du service ne saurait être engagée à raison de l’utilisation du service en dehors de son périmètre, de l’urgence, d’informations inexactes, incomplètes ou trompeuses transmises par le patient, ou du non-respect des instructions médicales et de sécurité.',
                'Aucune stipulation de la présente page n’a pour effet d’écarter une responsabilité qui ne pourrait être légalement exclue, notamment en cas de faute intentionnelle ou de manquement qui ne peut être limité par la loi.',
            ];
        }

        if ($disputesParagraphs === []) {
            $disputesParagraphs = [
                'Toute réclamation non urgente doit être adressée en priorité au contact indiqué.',
                'Les contestations portant sur l’appréciation clinique relèvent du cadre propre au service de santé et de l’indépendance du médecin.',
                'Le service ne doit pas être lu comme un site de e-commerce standard pour sa composante strictement médicale.',
            ];
        }

        $html = '<div class="sp-legal-document sp-legal-document--conditions">';
        $html .= self::render_meta_block('conditions', $state, 'Document public — cadre du service', 'Conditions d’utilisation, principes de traitement du dossier, informations tarifaires et organisation du paiement.');
        $html .= self::lead($servicePositioning);
        $html .= self::callout([
            'Service privé et non urgent',
            'Analyse médicale asynchrone',
            'Décision médicale indépendante',
            'Aucune prescription n’est garantie',
        ]);

        $html .= '<section>';
        $html .= '<h2>Définitions utiles</h2>';
        $html .= self::unordered_list([
            '<strong>Service</strong> : le service SOS Prescription, accessible via le site, dans le cadre d’une demande de continuité thérapeutique.',
            '<strong>Patient</strong> : la personne qui soumet une demande pour elle-même dans les conditions prévues par le service.',
            '<strong>Dossier</strong> : l’ensemble des informations, déclarations, justificatifs et échanges transmis dans le cadre d’une demande.',
            '<strong>Médecin</strong> : le praticien qui examine le dossier et décide, en toute indépendance, de la suite à lui donner.',
            '<strong>Ordonnance de relais</strong> : lorsqu’elle est effectivement émise, l’ordonnance éventuellement délivrée à l’issue de l’analyse médicale du dossier.',
            '<strong>Préautorisation</strong> : l’opération par laquelle un moyen de paiement peut être sollicité avant la décision finale, sans que cela n’emporte automatiquement un débit définitif ni la délivrance d’une ordonnance.',
        ]);
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Objet du service et limites de périmètre</h2>';
        $html .= self::paragraph('Le service a pour objet de faciliter un parcours de <strong>continuité thérapeutique</strong> dans un cadre strictement défini. Il vise à permettre la transmission et l’examen d’une demande par un médecin lorsque la situation se prête à un traitement <strong>non urgent</strong> et <strong>asynchrone</strong>.');
        $html .= self::paragraph('Le service ne remplace pas une prise en charge en urgence, un examen clinique immédiat lorsque l’état du patient l’exige, ni une consultation adaptée en cas de symptômes nouveaux, graves, atypiques ou évolutifs.');
        $html .= self::render_textarea_as_paragraphs($eligibility);
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Déroulement d’une demande et décision médicale</h2>';
        $html .= self::paragraph('Le patient constitue un dossier et transmet les informations demandées ainsi que, le cas échéant, les justificatifs utiles à l’instruction du dossier. Le traitement du dossier intervient de manière <strong>asynchrone</strong> : le service ne promet ni réponse instantanée ni délai uniforme en toutes circonstances.');
        $html .= self::render_textarea_as_paragraphs($responseDelay);
        $html .= self::render_textarea_as_paragraphs($medicalDecisionSummary);
        $html .= self::unordered_list([
            'demander des informations complémentaires ;',
            'considérer que le cadre du service n’est pas adapté ;',
            'refuser de délivrer une ordonnance ;',
            'ou, lorsqu’il l’estime médicalement justifié, délivrer une ordonnance de relais.',
        ]);
        $html .= self::paragraph('Le recours au service, l’existence d’une demande complète, d’un paiement ou d’une préautorisation n’emportent jamais, à eux seuls, délivrance automatique d’une ordonnance.');
        if ($doctorEnabled) {
            $html .= self::paragraph('Référence médicale affichée : <strong>' . esc_html($doctorIdentity) . '</strong>.');
        }
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Obligations du patient, sincérité et sécurité du compte</h2>';
        $html .= self::paragraph('Le patient s’engage à utiliser le service de bonne foi et à transmettre des informations exactes, sincères et à jour. En cas de doute sur une question, il lui appartient de demander une précision plutôt que de répondre au hasard.');
        $html .= self::unordered_list(array_map(static fn(string $item): string => esc_html($item), $patientHonestyItems));
        $html .= self::paragraph('Le service peut suspendre l’accès à certaines fonctionnalités, bloquer ou clôturer un dossier en cas d’usage manifestement abusif, frauduleux, techniquement dangereux ou contraire à la finalité du service.');
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Ordonnance, usage personnel et coordination des soins</h2>';
        $html .= self::render_lines_as_paragraphs($prescriptionUsageParagraphs);
        $html .= self::render_lines_as_paragraphs($reversibilityParagraphs);
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Tarifs, préautorisation et particularité du service</h2>';
        $html .= self::render_textarea_as_paragraphs($pricing);
        $html .= self::render_textarea_as_paragraphs($paymentSummary);
        $html .= self::definition_list([
            'Prestataire de paiement déclaré' => esc_html($paymentProvider),
            'Régime de paiement' => 'Préautorisation puis capture, annulation ou opération cohérente avec l’issue du dossier',
            'Garantie de prescription' => 'Aucune',
        ]);
        $html .= self::paragraph('Le paiement ne doit pas être compris comme l’achat automatique d’un médicament, d’une ordonnance ou d’un résultat médical déterminé. Il rémunère l’accès au parcours et au traitement du dossier dans le cadre défini par le service.');
        $html .= self::paragraph('Le service relève d’un cadre de santé privé et ne doit pas être lu comme un site de e-commerce standard. Les blocs génériques de rétractation de quatorze jours ne sont pas activés par défaut pour la partie strictement médicale du service. Une fois l’analyse médicale effectivement commencée, la demande ne peut pas être annulée comme une simple commande de biens ou de services courants.');
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Disponibilité, maintenance et force majeure</h2>';
        $html .= self::render_lines_as_paragraphs($forceMajeureParagraphs);
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Responsabilité, réclamations, litiges et droit applicable</h2>';
        $html .= self::render_lines_as_paragraphs($liabilityParagraphs);
        $html .= self::render_lines_as_paragraphs($disputesParagraphs);
        $html .= self::paragraph('Toute réclamation non urgente relative au fonctionnement du service, à la facturation, à l’accès aux documents ou à la gestion du dossier peut être adressée à <a href="mailto:' . esc_attr($complaintContact) . '">' . esc_html($complaintContact) . '</a>.');
        $html .= self::paragraph('Le droit applicable est le droit français, sous réserve des règles impératives éventuellement applicables.');
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Documents associés</h2>';
        $html .= self::render_internal_links([
            [self::page_url('mentions', $state), 'Consulter les mentions légales'],
            [self::page_url('privacy', $state), 'Consulter la page confidentialité, données de santé et cookies'],
        ]);
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Sources publiques</h2>';
        $html .= self::source_list((array) ($state['conditions']['sources_public'] ?? []));
        $html .= '</section>';
        $html .= '</div>';

        return $html;
    }




        private static function render_privacy(array $state): string
    {
        $registry = is_array($state['registry'] ?? null) ? $state['registry'] : [];
        $operatorName = self::safe_or_default((string) ($registry['operator_name'] ?? ''), 'Digital Pacifika');
        $privacyContact = self::safe_or_default((string) ($registry['privacy_contact_email'] ?? ''), 'privacy@sosprescription.fr');
        $purposes = self::safe_or_default((string) ($registry['purposes_summary'] ?? ''), 'Gestion des demandes, analyse du dossier, échanges patient-médecin, continuité de traitement, sécurisation de la plateforme, gestion administrative et financière, prévention des abus, gestion des incidents et respect des obligations légales.');
        $dataCategories = self::lines((string) ($registry['data_categories_summary'] ?? ''));
        $processors = self::safe_or_default((string) ($registry['processor_summary'] ?? ''), 'Le site public WordPress est hébergé chez Hostinger. L’exécution métier sensible est opérée sur Scalingo France. Le stockage objet est assuré sur AWS Paris. Les opérations de paiement sont réalisées via Stripe. D’autres prestataires techniques peuvent intervenir pour l’email, la protection antispam/captcha et, si activée, l’assistance documentaire.');
        $subprocessorChain = self::lines((string) ($registry['subprocessor_chain_summary'] ?? ''));
        $hostingHdsSummary = self::safe_or_default((string) ($registry['hosting_hds_summary'] ?? ''), 'Lorsque des données de santé sont concernées, SOS Prescription publie une chaîne d’hébergement et de traitement structurée pour distinguer le site public, les traitements métier sensibles et les prestataires d’infrastructure ou de paiement intervenant dans leur périmètre. Les traitements sensibles sont publiquement déclarés comme opérés en France.');
        $securityItems = self::lines((string) ($registry['security_summary'] ?? ''));
        $incidentParagraphs = self::lines((string) ($registry['incident_management_summary'] ?? ''));
        $retentionParagraphs = self::lines((string) ($registry['retention_summary'] ?? ''));
        $archivalParagraphs = self::lines((string) ($registry['archival_vs_erasure_summary'] ?? ''));
        $rightsParagraphs = self::lines((string) ($registry['rights_assistance_summary'] ?? ''));
        $aiParagraphs = self::lines((string) ($registry['ai_summary'] ?? ''));
        $workerRuntime = self::safe_or_default((string) ($registry['worker_runtime'] ?? ''), 'Scalingo France');
        $objectStorage = self::safe_or_default((string) ($registry['object_storage'] ?? ''), 'AWS Paris');
        $paymentProvider = self::safe_or_default((string) ($registry['payment_provider'] ?? ''), 'Stripe');
        $dpoDeclared = !empty($registry['dpo_declared']);
        $dpoIdentity = self::safe_or_default((string) ($registry['dpo_identity'] ?? ''), '');

        if ($dataCategories === []) {
            $dataCategories = [
                'données d’identification et de contact nécessaires à l’ouverture et au suivi du dossier ;',
                'informations nécessaires à l’instruction d’une demande de continuité thérapeutique, y compris des informations pouvant révéler l’état de santé ;',
                'justificatifs, pièces transmises, échanges et messages liés au dossier ;',
                'informations techniques de sécurité, de journalisation, de prévention des abus et de fonctionnement du parcours ;',
                'informations liées au paiement, sans que SOS Prescription n’ait vocation à stocker lui-même les données complètes de carte bancaire.',
            ];
        }

        if ($subprocessorChain === []) {
            $subprocessorChain = [
                'Hostinger — hébergement du site public WordPress ;',
                'Scalingo France — exécution du worker métier séparé ;',
                'AWS Paris — stockage objet et infrastructure associée déclarée ;',
                'Stripe — paiement, préautorisation, capture, annulation et gestion des transactions ;',
                'Prestataires complémentaires éventuels — email, antispam/captcha, assistance documentaire et outils strictement nécessaires selon la configuration effectivement activée.',
            ];
        }

        if ($securityItems === []) {
            $securityItems = [
                'accès aux données limités aux personnes habilitées et dans la mesure nécessaire à leur mission ;',
                'séparation entre façade publique, traitements métier et composants de stockage ;',
                'journalisation, restrictions d’accès et mécanismes de sécurité adaptés au parcours ;',
                'obligations de confidentialité imposées aux personnes autorisées et aux prestataires intervenant dans leur périmètre.',
            ];
        }

        if ($incidentParagraphs === []) {
            $incidentParagraphs = [
                'Si SOS Prescription ou l’un de ses prestataires identifie un incident de sécurité susceptible d’affecter des données personnelles traitées pour le service, l’incident fait l’objet d’une analyse, d’une documentation interne et de mesures de remédiation adaptées.',
                'Lorsque la réglementation applicable l’exige, une notification est adressée à l’autorité compétente et, le cas échéant, aux personnes concernées dans les conditions prévues par la loi.',
            ];
        }

        if ($retentionParagraphs === []) {
            $retentionParagraphs = [
                'Les données sont conservées pendant la durée nécessaire à la gestion du dossier, à la mise à disposition éventuelle des documents, au traitement des réclamations, à la sécurité du service, à la prévention des abus et au respect des obligations légales, réglementaires ou probatoires applicables.',
                'Les durées précises peuvent dépendre de la nature des données, du dossier concerné, des obligations de conservation applicables et des contraintes de sécurité ou de preuve.',
            ];
        }

        if ($archivalParagraphs === []) {
            $archivalParagraphs = [
                'Demander l’arrêt du service, la fermeture ou la suspension d’un compte ne signifie pas l’effacement immédiat de toutes les données. Une suspension ou une désactivation du compte peut avoir pour effet de couper l’accès au compte et aux notifications, tout en laissant subsister un archivage sécurisé des éléments qui doivent être conservés.',
                'Lorsque le dossier contient des informations de santé, des échanges médicaux, des ordonnances, des justificatifs ou des éléments nécessaires à la continuité des soins, à la sécurité du service, au respect d’une obligation légale, à l’intérêt public dans le domaine de la santé ou à la défense de droits en justice, certaines données peuvent être archivées plutôt qu’effacées.',
                'Seules les données qui ne sont plus nécessaires ou qui peuvent légalement être supprimées peuvent être effacées ou anonymisées selon leur cycle de vie. Les sauvegardes et copies techniques suivent leur propre cycle d’extinction ou de suppression compatible avec les exigences de sécurité et de continuité.',
            ];
        }

        if ($rightsParagraphs === []) {
            $rightsParagraphs = [
                'Les demandes relatives aux droits des personnes concernées doivent être adressées au contact confidentialité indiqué sur cette page.',
                'Selon les cas et dans les limites prévues par la loi, ces droits peuvent inclure l’accès, la rectification, l’effacement lorsqu’il est applicable, la limitation, l’opposition, la portabilité et le retrait du consentement lorsqu’un traitement repose sur celui-ci.',
                'SOS Prescription demeure l’interlocuteur principal des personnes concernées pour l’exercice de leurs droits. Lorsque cela est nécessaire, le service peut solliciter l’assistance technique raisonnable de ses prestataires afin d’identifier les données concernées, d’extraire les informations utiles, de rectifier certaines données, de limiter certains traitements ou de supprimer les données lorsque cela est légalement possible.',
                'Toute personne concernée peut également introduire une réclamation auprès de la CNIL si elle estime que le traitement de ses données personnelles n’est pas conforme à la réglementation applicable.',
            ];
        }

        if ($aiParagraphs === []) {
            $aiParagraphs = [
                'Une assistance algorithmique peut être utilisée pour la reconnaissance de justificatifs ou l’aide à la lecture de documents transmis.',
                'Elle intervient comme aide au traitement documentaire et n’emporte pas de décision médicale automatisée. La décision finale reste humaine et médicale.',
            ];
        }

        $html = '<div class="sp-legal-document sp-legal-document--privacy">';
        $html .= self::render_meta_block('privacy', $state, 'Document public — confidentialité', 'Protection des données personnelles, données de santé, architecture déclarée et cookies utilisés par le site.');
        $html .= self::lead('Cette page décrit les principes de confidentialité applicables au service SOS Prescription, la manière dont les données personnelles — y compris les données concernant la santé — peuvent être traitées, la chaîne technique publiée du service, ainsi que les règles relatives aux cookies et autres traceurs.');
        $html .= self::callout([
            'Les données de santé sont des données sensibles',
            'Le site public WordPress agit comme façade',
            'Les traitements métier sensibles sont opérés dans une chaîne séparée',
            'La décision médicale reste humaine et non automatisée',
        ]);

        $html .= '<section>';
        $html .= '<h2>Responsable du traitement et contact dédié</h2>';
        $html .= self::paragraph('Le responsable du traitement affiché pour le service est <strong>' . esc_html($operatorName) . '</strong>. Les demandes relatives aux données personnelles peuvent être adressées à <a href="mailto:' . esc_attr($privacyContact) . '">' . esc_html($privacyContact) . '</a>.');
        if ($dpoDeclared && $dpoIdentity !== '') {
            $html .= self::paragraph('DPO affiché : <strong>' . esc_html($dpoIdentity) . '</strong>.');
        } else {
            $html .= self::paragraph('Aucun DPO formel n’est affiché à ce stade. Le point de contact confidentialité ci-dessus demeure l’entrée dédiée pour les demandes des personnes concernées.');
        }
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Données concernées et finalités principales</h2>';
        $html .= self::unordered_list(array_map(static fn(string $line): string => esc_html($line), $dataCategories));
        $html .= self::render_textarea_as_paragraphs($purposes);
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Chaîne technique, hébergement et sous-traitance publiée</h2>';
        $html .= self::paragraph('Le service publie une chaîne technique essentielle, structurée de façon à distinguer le <strong>site public</strong> des <strong>traitements métier sensibles</strong>.');
        $html .= self::definition_list([
            'Façade publique' => 'WordPress — site public hébergé chez Hostinger',
            'Exécution métier déclarée' => esc_html($workerRuntime),
            'Stockage objet déclaré' => esc_html($objectStorage),
            'Paiement' => esc_html($paymentProvider),
        ]);
        $html .= self::render_textarea_as_paragraphs($processors);
        $html .= self::unordered_list(array_map(static fn(string $line): string => esc_html($line), $subprocessorChain));
        $html .= self::render_textarea_as_paragraphs($hostingHdsSummary);
        $html .= self::paragraph('Le lecteur est ainsi informé que le site public n’a pas vocation, à lui seul, à constituer le dossier métier autoritatif. Les traitements sensibles sont opérés dans une architecture distincte et publiquement déclarée comme localisée en France pour les traitements concernés.');
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Sécurité, confidentialité et gestion des incidents</h2>';
        $html .= self::paragraph('SOS Prescription met en œuvre des mesures techniques et organisationnelles adaptées à la sensibilité des données traitées et aux risques encourus par les personnes concernées.');
        $html .= self::unordered_list(array_map(static fn(string $line): string => esc_html($line), $securityItems));
        $html .= self::render_lines_as_paragraphs($incidentParagraphs);
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Conservation, suspension du compte et limites du droit à l’effacement</h2>';
        $html .= self::render_lines_as_paragraphs($retentionParagraphs);
        $html .= self::render_lines_as_paragraphs($archivalParagraphs);
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Exercice des droits et assistance associée</h2>';
        $html .= self::render_lines_as_paragraphs($rightsParagraphs);
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Assistance algorithmique et absence de décision médicale automatisée</h2>';
        $html .= self::render_lines_as_paragraphs($aiParagraphs);
        $html .= '</section>';

        $html .= self::render_cookies_fragment($state, false);

        $html .= '<section>';
        $html .= '<h2>Documents associés</h2>';
        $html .= self::render_internal_links([
            [self::page_url('mentions', $state), 'Consulter les mentions légales'],
            [self::page_url('conditions', $state), 'Consulter les conditions du service, tarifs et paiement'],
        ]);
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Sources publiques</h2>';
        $html .= self::source_list((array) ($state['privacy']['sources_public'] ?? []));
        $html .= '</section>';
        $html .= '</div>';

        return $html;
    }



    private static function render_cookies_fragment(array $state, bool $standalone): string
    {
        $registry = is_array($state['registry'] ?? null) ? $state['registry'] : [];
        $cookieLines = self::lines((string) ($registry['cookies_list'] ?? ''));
        if ($cookieLines === []) {
            $cookieLines = [
                'Cookies strictement nécessaires au fonctionnement du site et à la sécurité des sessions.',
                'Cookies techniques permettant le maintien du parcours utilisateur.',
                'Traceurs complémentaires uniquement lorsqu’ils sont activés et, le cas échéant, soumis à un mécanisme de consentement.',
            ];
        }

        $html = $standalone ? '<div class="sp-legal-document sp-legal-document--cookies">' : '<section>';
        $html .= '<h2>Cookies et autres traceurs</h2>';
        $html .= self::paragraph('Le site peut utiliser des cookies ou autres traceurs strictement nécessaires à son fonctionnement, à la sécurité du parcours et, le cas échéant, des traceurs supplémentaires soumis au consentement lorsque la configuration technique du site le requiert.');
        $html .= self::unordered_list(array_map(static fn(string $line): string => esc_html($line), $cookieLines));
        $html .= self::paragraph('Lorsqu’un mécanisme de préférences est effectivement raccordé au site, il permet à l’utilisateur de choisir ses préférences pour les traceurs non strictement nécessaires. À défaut, seuls les traceurs strictement nécessaires doivent rester actifs.');

        if ($standalone) {
            $html .= '<section>';
            $html .= '<h2>Sources publiques</h2>';
            $html .= self::source_list([
                ['label' => 'CNIL', 'url' => 'https://www.cnil.fr/', 'note' => 'Référentiel public sur les cookies et autres traceurs.'],
                ['label' => 'Politique de confidentialité', 'url' => self::page_url('privacy', $state), 'note' => 'Page principale intégrant les règles cookies du service.'],
            ]);
            $html .= '</section>';
            $html .= '</div>';
        } else {
            $html .= '</section>';
        }

        return $html;
    }

    /**
     * @param array<string, mixed> $state
     */
    private static function render_meta_block(string $slot, array $state, string $eyebrow, string $subtitle): string
    {
        $slotState = is_array($state[$slot] ?? null) ? $state[$slot] : [];
        $version = self::normalize_version((string) ($slotState['version'] ?? '1.0.0'));
        $effectiveDate = self::format_date((string) ($slotState['effective_date'] ?? ''));
        $updatedAt = self::format_date((string) ($slotState['updated_at'] ?? ''));

        $html = '<div class="sp-legal-document__meta">';
        $html .= '<div class="sp-legal-document__eyebrow">' . esc_html($eyebrow) . '</div>';
        $html .= '<p class="sp-legal-document__subtitle">' . esc_html($subtitle) . '</p>';
        $html .= '<div class="sp-legal-document__meta-grid">';
        $html .= '<div><span>Version</span><strong>' . esc_html($version) . '</strong></div>';
        $html .= '<div><span>Date d’effet</span><strong>' . esc_html($effectiveDate) . '</strong></div>';
        $html .= '<div><span>Dernière mise à jour</span><strong>' . esc_html($updatedAt) . '</strong></div>';
        $html .= '</div>';
        $html .= '</div>';

        return $html;
    }

    private static function render_textarea_as_paragraphs(string $text): string
    {
        return self::render_lines_as_paragraphs(self::lines($text));
    }

    /**
     * @param array<int, string> $lines
     */
    private static function render_lines_as_paragraphs(array $lines): string
    {
        $html = '';
        foreach ($lines as $line) {
            if ($line === '') {
                continue;
            }
            $html .= self::paragraph($line);
        }

        return $html;
    }

    private static function lead(string $text): string
    {
        return '<p class="sp-legal-document__lead">' . esc_html($text) . '</p>';
    }

    /**
     * @param array<int, string> $items
     */
    private static function callout(array $items): string
    {
        $html = '<div class="sp-legal-document__callout"><ul class="sp-legal-document__callout-list">';
        foreach ($items as $item) {
            $html .= '<li>' . esc_html($item) . '</li>';
        }
        $html .= '</ul></div>';

        return $html;
    }

    /**
     * @param array<string, string> $rows
     */
    private static function definition_list(array $rows): string
    {
        $html = '<dl class="sp-legal-document__definitions">';
        foreach ($rows as $label => $value) {
            $html .= '<dt>' . esc_html((string) $label) . '</dt><dd>' . $value . '</dd>';
        }
        $html .= '</dl>';

        return $html;
    }

    /**
     * @param array<int, string> $items
     */
    private static function unordered_list(array $items): string
    {
        $html = '<ul class="sp-legal-document__list">';
        foreach ($items as $item) {
            $html .= '<li>' . $item . '</li>';
        }
        $html .= '</ul>';

        return $html;
    }

    /**
     * @param array<int, array{0:string,1:string}> $links
     */
    private static function render_internal_links(array $links): string
    {
        $html = '<ul class="sp-legal-document__links">';
        foreach ($links as $link) {
            $url = (string) ($link[0] ?? '#');
            $label = (string) ($link[1] ?? '');
            $html .= '<li><a href="' . esc_url($url) . '">' . esc_html($label) . '</a></li>';
        }
        $html .= '</ul>';

        return $html;
    }

    /**
     * @param array<int, array<string, string>> $sources
     */
    private static function source_list(array $sources): string
    {
        $html = '<ul class="sp-legal-document__sources">';
        foreach ($sources as $source) {
            $label = self::text($source['label'] ?? '');
            $url = esc_url((string) ($source['url'] ?? ''));
            $note = self::text($source['note'] ?? '');
            if ($label === '' || $url === '') {
                continue;
            }
            $html .= '<li><a href="' . $url . '" target="_blank" rel="noopener noreferrer">' . esc_html($label) . '</a>';
            if ($note !== '') {
                $html .= '<span> — ' . esc_html($note) . '</span>';
            }
            $html .= '</li>';
        }
        $html .= '</ul>';

        return $html;
    }

    private static function paragraph(string $html): string
    {
        return '<p>' . $html . '</p>';
    }


    /**
     * @return array<string, mixed>
     */
        /**
     * @return array<string, mixed>
     */
    private static function default_state(): array
    {
        $today = self::today();

        return [
            'corpus_version' => self::CORPUS_VERSION,
            'storage_version' => self::STORAGE_VERSION,
            'updated_at' => $today,
            'registry' => [
                'brand_name' => 'SOS Prescription',
                'brand_registration_number' => '5002143',
                'brand_registration_date' => '2023-10-29',
                'site_url' => home_url('/'),
                'operator_name' => 'Digital Pacifika',
                'operator_identity' => "Digital Pacifika
98600 Wallis-et-Futuna, South Pacific
N° CD : 2022.1.2573
N° RCS : 2020 A 0102
Capital social : 3.000.000 XPF
TVA : non applicable / non renseignée à ce stade",
                'publication_director' => 'Digital Pacifika',
                'main_contact_email' => 'contact@sosprescription.fr',
                'privacy_contact_email' => 'privacy@sosprescription.fr',
                'public_host_summary' => 'Hostinger — offre Cloud Startup — hébergement du site public WordPress',
                'technical_maintainer_summary' => 'Digital Pacifika — maintenance technique du site public et de son intégration WordPress.',
                'technical_interveners_summary' => "Hostinger — hébergement du site public WordPress.
Scalingo France — exécution du worker métier séparé.
AWS Paris — stockage objet déclaré pour les documents et fichiers associés.
Stripe — paiement, préautorisation, capture, annulation et gestion des transactions.",
                'doctor_enabled' => true,
                'doctor_identity' => 'Dr Yves Burckel — Médecin urgentiste — RPPS 10000554302',
                'service_positioning' => 'SOS Prescription est un service privé, non urgent et asynchrone de continuité thérapeutique. Il permet à un patient, dans un cadre strictement défini, de solliciter l’analyse de sa situation par un médecin afin de déterminer s’il y a lieu ou non d’émettre une ordonnance de relais.',
                'eligibility_summary' => "Le service est réservé aux demandes compatibles avec un besoin de continuité de traitement.
Il ne remplace pas une prise en charge d’urgence, un diagnostic en temps réel, ni une consultation adaptée en cas de symptômes nouveaux, graves ou évolutifs.",
                'response_delay' => "Les demandes sont traitées de manière asynchrone.
Les délais peuvent varier selon la complétude du dossier, le volume de demandes et la disponibilité médicale.
Des informations complémentaires peuvent être demandées avant toute décision.",
                'medical_decision_summary' => "Chaque dossier fait l’objet d’une analyse humaine par un médecin. La décision médicale demeure personnelle, indépendante et non automatisée.
Le médecin peut refuser ou réorienter une demande pour des raisons cliniques, de sécurité ou de conformité du dossier, notamment si les éléments transmis sont incomplets, incohérents, trompeurs, insuffisants pour une appréciation médicale prudente, ou s’ils justifient un examen en présentiel ou une orientation vers un autre circuit de soins.",
                'patient_honesty_summary' => "répondre honnêtement au questionnaire et aux demandes complémentaires, au mieux de sa connaissance ;
ne pas soumettre une demande pour le compte d’un tiers ni utiliser l’identité d’un tiers ;
signaler sans délai toute information nouvelle susceptible de modifier l’appréciation du dossier ;
ne pas transmettre de documents falsifiés, trompeurs ou illicites ;
conserver ses identifiants d’accès confidentiels et ne pas partager son compte ;
ne pas utiliser le service dans une situation d’urgence ou hors de son périmètre normal.",
                'prescription_usage_summary' => "Lorsqu’une ordonnance de relais est mise à disposition, elle est strictement personnelle. Elle ne doit pas être cédée, partagée, réutilisée pour un tiers ni utilisée en dehors du cadre fixé par le médecin.
Le patient est invité à télécharger, lire et conserver sans attendre tout document mis à sa disposition dans son espace. Il lui appartient également de lire la notice du traitement, de respecter la prescription, ainsi que de vérifier la durée de validité applicable à l’ordonnance et aux médicaments concernés.
Pour la première délivrance des médicaments en pharmacie, une ordonnance doit en principe être présentée dans les trois mois de sa rédaction, sous réserve des règles particulières applicables à certains produits, des mentions de renouvellement et des limites fixées par le prescripteur.
Afin de favoriser la continuité et la sécurité des soins, il est fortement recommandé au patient d’informer son médecin traitant, ainsi que tout professionnel de santé qui le suit utilement, des traitements ou documents obtenus via le service.",
                'reversibility_summary' => "L’accès à une ordonnance ou à un document mis à disposition peut être limité dans le temps pour des raisons de sécurité, d’archivage, de fermeture de compte ou d’organisation technique.
Le patient est donc invité à conserver sans délai les documents qui lui sont remis, y compris lorsque l’accès à son compte est suspendu ou désactivé.",
                'pricing_summary' => "Le tarif applicable est affiché au patient avant validation finale de sa demande.
Le paiement ne doit pas être compris comme l’achat automatique d’une ordonnance ou d’un médicament.
Aucune prescription n’est garantie.",
                'payment_summary' => "La plateforme peut solliciter une préautorisation bancaire via Stripe avant l’analyse médicale du dossier.
La capture effective ou l’annulation intervient ensuite selon l’issue du traitement médical.
La préautorisation ou le paiement n’emportent jamais, à eux seuls, validation médicale ni délivrance automatique d’une ordonnance.",
                'force_majeure_summary' => "SOS Prescription s’efforce d’assurer un accès raisonnablement stable au service, sans garantir une disponibilité continue ni l’absence totale d’interruption.
L’accès peut être suspendu, limité ou ralenti en cas de maintenance, de mise à jour, d’incident technique, de mesure de sécurité, de saturation ou d’événement échappant raisonnablement au contrôle du service.
Aucune partie ne pourra être tenue responsable d’un retard ou d’une inexécution résultant d’un cas de force majeure ou d’un événement extérieur équivalent au sens du droit applicable.",
                'liability_summary' => "SOS Prescription demeure tenu d’une obligation de moyens dans le fonctionnement de la plateforme et du parcours numérique.
La responsabilité du service ne saurait être engagée à raison de l’utilisation du service en dehors de son périmètre, de l’urgence, d’informations inexactes, incomplètes ou trompeuses transmises par le patient, ou du non-respect des instructions médicales et de sécurité.
Aucune stipulation de la présente page n’a pour effet d’écarter une responsabilité qui ne pourrait être légalement exclue, notamment en cas de faute intentionnelle ou de manquement qui ne peut être limité par la loi.",
                'disputes_summary' => "Toute réclamation non urgente doit être adressée en priorité au contact indiqué.
Les contestations portant sur l’appréciation clinique relèvent du cadre propre au service de santé et de l’indépendance du médecin.
Le service ne doit pas être lu comme un site de e-commerce standard pour sa composante strictement médicale.",
                'complaint_contact' => 'contact@sosprescription.fr',
                'dpo_declared' => false,
                'dpo_identity' => '',
                'purposes_summary' => "Gestion des demandes, analyse du dossier, continuité de traitement, échanges patient-médecin, sécurisation de la plateforme, gestion administrative et financière, prévention des abus, gestion des incidents, exercice des droits et respect des obligations légales.",
                'data_categories_summary' => "données d’identification et de contact nécessaires à l’ouverture et au suivi du dossier ;
informations nécessaires à l’instruction d’une demande de continuité thérapeutique, y compris des informations pouvant révéler l’état de santé ;
justificatifs, pièces transmises, échanges et messages liés au dossier ;
informations techniques de sécurité, de journalisation, de prévention des abus et de fonctionnement du parcours ;
informations liées au paiement, sans que SOS Prescription n’ait vocation à stocker lui-même les données complètes de carte bancaire.",
                'processor_summary' => "Le site public WordPress est hébergé chez Hostinger.
L’exécution métier sensible est opérée sur Scalingo France.
Le stockage objet est assuré sur AWS Paris.
Les opérations de paiement sont réalisées via Stripe.
D’autres prestataires techniques peuvent intervenir pour l’email, la protection antispam/captcha et, si activée, l’assistance documentaire.",
                'subprocessor_chain_summary' => "Hostinger — hébergement du site public WordPress ;
Scalingo France — exécution du worker métier séparé ;
AWS Paris — stockage objet et infrastructure associée déclarée ;
Stripe — paiement, préautorisation, capture, annulation et gestion des transactions ;
Prestataires complémentaires éventuels — email, antispam/captcha, assistance documentaire et outils strictement nécessaires selon la configuration effectivement activée.",
                'hosting_hds_summary' => "Lorsque des données de santé sont concernées, SOS Prescription publie une chaîne d’hébergement et de traitement structurée pour distinguer le site public, les traitements métier sensibles et les prestataires d’infrastructure ou de paiement intervenant dans leur périmètre.
Les traitements sensibles sont publiquement déclarés comme opérés en France.
Lorsque des prestations relevant du cadre HDS sont mobilisées, elles s’apprécient au niveau des prestataires concernés et dans les limites de leur périmètre de certification ou de conformité déclaré.",
                'security_summary' => "accès aux données limités aux personnes habilitées et dans la mesure nécessaire à leur mission ;
séparation entre façade publique, traitements métier et composants de stockage ;
journalisation, restrictions d’accès et mécanismes de sécurité adaptés au parcours ;
obligations de confidentialité imposées aux personnes autorisées et aux prestataires intervenant dans leur périmètre.",
                'incident_management_summary' => "Si SOS Prescription ou l’un de ses prestataires identifie un incident de sécurité susceptible d’affecter des données personnelles traitées pour le service, l’incident fait l’objet d’une analyse, d’une documentation interne et de mesures de remédiation adaptées.
Lorsque la réglementation applicable l’exige, une notification est adressée à l’autorité compétente et, le cas échéant, aux personnes concernées dans les conditions prévues par la loi.",
                'retention_summary' => "Les données sont conservées pendant la durée nécessaire à la gestion du dossier, à la mise à disposition éventuelle des documents, au traitement des réclamations, à la sécurité du service, à la prévention des abus et au respect des obligations légales, réglementaires ou probatoires applicables.
Les durées précises peuvent dépendre de la nature des données, du dossier concerné, des obligations de conservation applicables et des contraintes de sécurité ou de preuve.",
                'archival_vs_erasure_summary' => "Demander l’arrêt du service, la fermeture ou la suspension d’un compte ne signifie pas l’effacement immédiat de toutes les données. Une suspension ou une désactivation du compte peut avoir pour effet de couper l’accès au compte et aux notifications, tout en laissant subsister un archivage sécurisé des éléments qui doivent être conservés.
Lorsque le dossier contient des informations de santé, des échanges médicaux, des ordonnances, des justificatifs ou des éléments nécessaires à la continuité des soins, à la sécurité du service, au respect d’une obligation légale, à l’intérêt public dans le domaine de la santé ou à la défense de droits en justice, certaines données peuvent être archivées plutôt qu’effacées.
Seules les données qui ne sont plus nécessaires ou qui peuvent légalement être supprimées peuvent être effacées ou anonymisées selon leur cycle de vie. Les sauvegardes et copies techniques suivent leur propre cycle d’extinction ou de suppression compatible avec les exigences de sécurité et de continuité.",
                'rights_assistance_summary' => "Les demandes relatives aux droits des personnes concernées doivent être adressées au contact confidentialité indiqué sur cette page.
Selon les cas et dans les limites prévues par la loi, ces droits peuvent inclure l’accès, la rectification, l’effacement lorsqu’il est applicable, la limitation, l’opposition, la portabilité et le retrait du consentement lorsqu’un traitement repose sur celui-ci.
SOS Prescription demeure l’interlocuteur principal des personnes concernées pour l’exercice de leurs droits. Lorsque cela est nécessaire, le service peut solliciter l’assistance technique raisonnable de ses prestataires afin d’identifier les données concernées, d’extraire les informations utiles, de rectifier certaines données, de limiter certains traitements ou de supprimer les données lorsque cela est légalement possible.
Toute personne concernée peut également introduire une réclamation auprès de la CNIL si elle estime que le traitement de ses données personnelles n’est pas conforme à la réglementation applicable.",
                'cookies_list' => "Cookies strictement nécessaires au fonctionnement du site et à la sécurité des sessions
Cookies techniques permettant le maintien du parcours utilisateur et des choix de confidentialité
Traceurs complémentaires uniquement lorsqu’ils sont activés et, le cas échéant, soumis à un mécanisme de consentement",
                'ai_summary' => "Une assistance algorithmique peut être utilisée pour la reconnaissance de justificatifs ou l’aide à la lecture de documents transmis.
Elle intervient comme aide au traitement documentaire et n’emporte pas de décision médicale automatisée.
La décision finale reste humaine et médicale.",
                'consent_required' => true,
                'privacy_page_sync' => true,
                'worker_runtime' => 'Scalingo France',
                'object_storage' => 'AWS Paris',
                'payment_provider' => 'Stripe',
            ],
            'mentions' => [
                'page_id' => 0,
                'version' => self::CORPUS_VERSION,
                'effective_date' => $today,
                'updated_at' => $today,
                'sources_public' => [
                    ['label' => 'Digital Pacifika', 'url' => 'https://digitalpacifika.com', 'note' => 'Prestataire et exploitant juridique de travail affiché.'],
                    ['label' => 'Hostinger', 'url' => 'https://www.hostinger.fr/', 'note' => 'Hébergeur déclaré du site public WordPress.'],
                ],
            ],
            'conditions' => [
                'page_id' => 0,
                'version' => self::CORPUS_VERSION,
                'effective_date' => $today,
                'updated_at' => $today,
                'sources_public' => [
                    ['label' => 'Article L221-2 du code de la consommation', 'url' => 'https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000044563156', 'note' => 'Exclusion des services de santé du régime standard des contrats à distance.'],
                    ['label' => 'ameli — Bien lire et utiliser une ordonnance de médicaments', 'url' => 'https://www.ameli.fr/assure/sante/medicaments/utiliser-recycler-medicaments/lire-ordonnance-medicaments', 'note' => 'Repères publics sur l’usage personnel et la validité d’une ordonnance de médicaments.'],
                ],
            ],
            'privacy' => [
                'page_id' => 0,
                'version' => self::CORPUS_VERSION,
                'effective_date' => $today,
                'updated_at' => $today,
                'sources_public' => [
                    ['label' => 'CNIL — Santé', 'url' => 'https://www.cnil.fr/sante', 'note' => 'Référentiel public sur la protection des données de santé.'],
                    ['label' => 'CNIL — Le droit à l’effacement', 'url' => 'https://www.cnil.fr/le-droit-leffacement-supprimer-vos-donnees-en-ligne', 'note' => 'Rappel public des limites du droit à l’effacement.'],
                    ['label' => 'CNIL — Violations de données personnelles', 'url' => 'https://www.cnil.fr/fr/violations-de-donnees-personnelles-les-regles-suivre', 'note' => 'Référentiel public sur la gestion et la notification des violations de données.'],
                    ['label' => 'Service-Public.fr — Dossier médical', 'url' => 'https://www.service-public.fr/particuliers/vosdroits/F12210', 'note' => 'Repères publics sur la conservation du dossier médical.'],
                    ['label' => 'Agence du Numérique en Santé — HDS', 'url' => 'https://esante.gouv.fr/ens/offre/hds', 'note' => 'Référentiel public sur l’hébergement de données de santé.'],
                ],
            ],
        ];
    }



    /**
     * @param array<string, mixed> $state
     * @param array<string, array<string, mixed>> $bindings
     */
    private static function sync_compatibility(array $state, array $bindings): void
    {
        $registry = is_array($state['registry'] ?? null) ? $state['registry'] : [];
        $patch = [
            'consent_required' => !empty($registry['consent_required']),
        ];

        foreach (['conditions' => ['url' => 'cgu_url', 'version' => 'cgu_version'], 'privacy' => ['url' => 'privacy_url', 'version' => 'privacy_version']] as $slot => $keys) {
            $binding = $bindings[$slot] ?? null;
            if (!is_array($binding) || empty($binding['valid']) || (int) ($binding['page_id'] ?? 0) <= 0) {
                continue;
            }

            $patch[$keys['url']] = (string) get_permalink((int) $binding['page_id']);
            $patch[$keys['version']] = (string) ($state[$slot]['version'] ?? '1.0.0');
        }

        ComplianceConfig::update($patch);

        if (!empty($registry['privacy_page_sync'])) {
            $privacyBinding = $bindings['privacy'] ?? null;
            if (is_array($privacyBinding) && !empty($privacyBinding['valid']) && (int) ($privacyBinding['page_id'] ?? 0) > 0) {
                update_option('wp_page_for_privacy_policy', (int) $privacyBinding['page_id'], false);
            }
        }
    }

    /**
     * @return array{status_key:string,status_label:string,details:string,valid:bool}
     */
    private static function inspect_page(WP_Post $post, string $expectedSlug, string $shortcodeTag, string $canonicalShortcode): array
    {
        $content = trim((string) $post->post_content);
        $slugMatches = (string) $post->post_name === $expectedSlug;
        $containsShortcode = self::page_uses_shortcode($post, $shortcodeTag);
        $exactShortcode = $content === trim($canonicalShortcode);

        if ($slugMatches && $exactShortcode) {
            return [
                'status_key' => 'exists',
                'status_label' => 'Existe',
                'details' => 'Page publique canonique détectée et contenu conforme.',
                'valid' => true,
            ];
        }

        if ($slugMatches && $containsShortcode && !$exactShortcode) {
            return [
                'status_key' => 'modified_manually',
                'status_label' => 'À réparer',
                'details' => 'Le shortcode attendu est présent, mais la page a été modifiée manuellement autour de son contenu canonique.',
                'valid' => false,
            ];
        }

        if ($slugMatches && !$containsShortcode) {
            return [
                'status_key' => 'slug_conflict',
                'status_label' => 'Conflit',
                'details' => 'Le slug canonique existe déjà, mais le shortcode attendu est absent.',
                'valid' => false,
            ];
        }

        if (!$slugMatches && $exactShortcode) {
            return [
                'status_key' => 'incorrect_slug',
                'status_label' => 'À réparer',
                'details' => 'La page liée contient le bon shortcode, mais son slug ne correspond pas au slug canonique.',
                'valid' => false,
            ];
        }

        if (!$slugMatches && $containsShortcode) {
            return [
                'status_key' => 'incorrect_slug',
                'status_label' => 'À réparer',
                'details' => 'Le shortcode attendu est présent, mais la page n’est pas située au slug canonique.',
                'valid' => false,
            ];
        }

        return [
            'status_key' => 'incorrect_shortcode',
            'status_label' => 'À réparer',
            'details' => 'La page liée existe, mais le shortcode attendu est absent du contenu.',
            'valid' => false,
        ];
    }

    private static function page_url(string $slot, array $state): string
    {
        $pageId = (int) ($state[$slot]['page_id'] ?? 0);
        if ($pageId > 0) {
            $permalink = get_permalink($pageId);
            if (is_string($permalink) && $permalink !== '') {
                return $permalink;
            }
        }

        $slug = (string) (self::slots()[$slot]['slug'] ?? '');
        return home_url('/' . trim($slug, '/') . '/');
    }

    private static function get_page_by_slug(string $slug): ?WP_Post
    {
        $page = get_page_by_path($slug, OBJECT, 'page');
        return $page instanceof WP_Post ? $page : null;
    }

    private static function page_uses_shortcode(WP_Post $post, string $tag): bool
    {
        return has_shortcode((string) $post->post_content, $tag);
    }

    private static function slug_is_occupied(string $slug, int $ignoredPageId): bool
    {
        $page = self::get_page_by_slug($slug);
        return $page instanceof WP_Post && (int) $page->ID !== $ignoredPageId;
    }

    /**
     * @param mixed $raw
     * @param mixed $fallback
     * @return mixed
     */
    private static function sanitize_field(mixed $raw, string $type, mixed $fallback): mixed
    {
        return match ($type) {
            'checkbox' => !empty($raw),
            'email' => self::email($raw, is_string($fallback) ? $fallback : ''),
            'textarea' => self::textarea($raw),
            'date' => self::normalize_date_string(is_scalar($raw) ? (string) $raw : '', is_string($fallback) ? $fallback : self::today()),
            default => self::text($raw, is_string($fallback) ? $fallback : ''),
        };
    }

    /**
     * @param mixed $value
     */
    private static function text(mixed $value, string $fallback = ''): string
    {
        if (!is_scalar($value)) {
            return $fallback;
        }

        $sanitized = sanitize_text_field((string) $value);
        return $sanitized !== '' ? $sanitized : $fallback;
    }

    /**
     * @param mixed $value
     */
    private static function textarea(mixed $value, string $fallback = ''): string
    {
        if (!is_scalar($value)) {
            return $fallback;
        }

        $sanitized = sanitize_textarea_field((string) $value);
        return trim($sanitized) !== '' ? trim($sanitized) : $fallback;
    }

    /**
     * @param mixed $value
     */
    private static function email(mixed $value, string $fallback = ''): string
    {
        if (!is_scalar($value)) {
            return $fallback;
        }

        $sanitized = sanitize_email((string) $value);
        return $sanitized !== '' ? $sanitized : $fallback;
    }

    private static function normalize_version(string $value): string
    {
        $value = trim($value);
        return $value !== '' ? $value : '1.0.0';
    }

    private static function normalize_date_string(string $candidate, string $fallback): string
    {
        $candidate = trim($candidate);
        if ($candidate === '') {
            return $fallback;
        }

        $timestamp = strtotime($candidate);
        if ($timestamp === false) {
            return $fallback;
        }

        return gmdate('Y-m-d', $timestamp);
    }

    private static function format_date(string $date): string
    {
        $date = trim($date);
        if ($date === '') {
            return '—';
        }

        $timestamp = strtotime($date);
        if ($timestamp === false) {
            return $date;
        }

        return wp_date('j F Y', $timestamp);
    }

    private static function multiline_html(string $value): string
    {
        $value = trim($value);
        if ($value === '') {
            return '—';
        }

        return nl2br(esc_html($value));
    }

    private static function safe_or_default(string $value, string $fallback): string
    {
        $value = trim($value);
        return $value !== '' ? $value : $fallback;
    }

    /**
     * @return array<int, array<string, string>>
     */
    private static function normalize_sources(mixed $sources): array
    {
        if (!is_array($sources)) {
            return [];
        }

        $normalized = [];
        foreach ($sources as $source) {
            if (!is_array($source)) {
                continue;
            }
            $label = self::text($source['label'] ?? '');
            $url = esc_url_raw((string) ($source['url'] ?? ''));
            $note = self::text($source['note'] ?? '');
            if ($label === '' || $url === '') {
                continue;
            }
            $normalized[] = [
                'label' => $label,
                'url' => $url,
                'note' => $note,
            ];
        }

        return $normalized;
    }

    /**
     * @return array<int, string>
     */
    private static function lines(string $text): array
    {
        $lines = preg_split('/\R+/', trim($text)) ?: [];
        return array_values(array_filter(array_map(static fn(string $line): string => trim($line), $lines), static fn(string $line): bool => $line !== ''));
    }

    private static function today(): string
    {
        $today = current_time('Y-m-d');
        if (!is_string($today) || trim($today) === '') {
            $today = gmdate('Y-m-d');
        }

        return $today;
    }
}
