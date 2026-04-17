<?php

declare(strict_types=1);

namespace SosPrescription\Services;

use WP_Error;
use WP_Post;

final class LegalPages
{
    public const OPTION_KEY = 'sosprescription_legal_pages';

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
    public static function global_field_definitions(): array
    {
        return [
            'consent_required' => [
                'label' => 'Consentement requis dans le tunnel',
                'type' => 'checkbox',
                'description' => 'Conserve l’exigence de consentement dans le tunnel patient existant.',
            ],
            'main_contact_email' => [
                'label' => 'Email de contact public',
                'type' => 'email',
                'description' => 'Adresse affichée pour le contact général du service.',
            ],
            'privacy_contact_email' => [
                'label' => 'Email confidentialité',
                'type' => 'email',
                'description' => 'Point de contact dédié aux demandes relatives aux données personnelles.',
            ],
            'privacy_page_sync' => [
                'label' => 'Synchroniser la privacy page native WordPress',
                'type' => 'checkbox',
                'description' => 'Déclare la page 3 comme page de confidentialité native WordPress, sans lui donner l’autorité éditoriale.',
            ],
        ];
    }

    /**
     * @return array<string, array<string, mixed>>
     */
    public static function tab_definitions(): array
    {
        return [
            'mentions' => [
                'title' => 'Mentions légales',
                'description' => 'Identité de l’éditeur, hébergement du site public et publication éditoriale.',
                'fields' => [
                    'operator_name' => [
                        'label' => 'Éditeur / exploitant',
                        'type' => 'text',
                        'description' => 'Dénomination affichée publiquement comme exploitant du site et du service.',
                    ],
                    'operator_identity' => [
                        'label' => 'Identité juridique affichée',
                        'type' => 'textarea',
                        'description' => 'Adresse et références de l’exploitant, une ligne par information.',
                    ],
                    'publication_director' => [
                        'label' => 'Directeur de publication',
                        'type' => 'text',
                        'description' => 'Nom ou dénomination affiché comme responsable de la publication.',
                    ],
                    'public_host_summary' => [
                        'label' => 'Hébergeur du site public',
                        'type' => 'text',
                        'description' => 'Formulation courte affichée dans les mentions légales.',
                    ],
                    'technical_maintainer_summary' => [
                        'label' => 'Maintenance technique',
                        'type' => 'text',
                        'description' => 'Prestataire ou équipe affichée pour la maintenance du site.',
                    ],
                    'doctor_enabled' => [
                        'label' => 'Afficher le médecin référent',
                        'type' => 'checkbox',
                        'description' => 'Active la sous-section publique “médecin référent”.',
                    ],
                    'doctor_identity' => [
                        'label' => 'Médecin référent affiché',
                        'type' => 'text',
                        'description' => 'Affichage compact du médecin référent et de son RPPS.',
                    ],
                ],
            ],
            'conditions' => [
                'title' => 'Conditions du service',
                'description' => 'Cadre du service, délais, préautorisation et gestion des réclamations.',
                'fields' => [
                    'service_positioning' => [
                        'label' => 'Positionnement du service',
                        'type' => 'textarea',
                        'description' => 'Résumé public du service, de sa nature privée et non urgente.',
                    ],
                    'eligibility_summary' => [
                        'label' => 'Éligibilité et exclusions',
                        'type' => 'textarea',
                        'description' => 'Décrit le cadre d’usage et les cas exclus.',
                    ],
                    'pricing_summary' => [
                        'label' => 'Tarifs',
                        'type' => 'textarea',
                        'description' => 'Texte public sur le tarif, son affichage et l’absence de garantie de prescription.',
                    ],
                    'response_delay' => [
                        'label' => 'Délais',
                        'type' => 'text',
                        'description' => 'Promesse prudente sur le traitement asynchrone des demandes.',
                    ],
                    'payment_summary' => [
                        'label' => 'Paiement et préautorisation',
                        'type' => 'textarea',
                        'description' => 'Explique le fonctionnement Stripe sans présenter le service comme un achat standard.',
                    ],
                    'disputes_summary' => [
                        'label' => 'Litiges et réclamations',
                        'type' => 'textarea',
                        'description' => 'Formulation publique sur les réclamations et le traitement des contestations.',
                    ],
                    'complaint_contact' => [
                        'label' => 'Contact réclamations',
                        'type' => 'email',
                        'description' => 'Email affiché pour les réclamations non urgentes.',
                    ],
                ],
            ],
            'privacy' => [
                'title' => 'Confidentialité & cookies',
                'description' => 'Contact confidentialité, finalités, prestataires, IA d’assistance documentaire et cookies.',
                'fields' => [
                    'dpo_declared' => [
                        'label' => 'DPO formel déclaré',
                        'type' => 'checkbox',
                        'description' => 'À activer uniquement si un DPO est réellement formalisé.',
                    ],
                    'dpo_identity' => [
                        'label' => 'DPO affiché',
                        'type' => 'text',
                        'description' => 'Nom ou qualité du DPO, si la case précédente est activée.',
                    ],
                    'purposes_summary' => [
                        'label' => 'Finalités principales',
                        'type' => 'textarea',
                        'description' => 'Résumé public des finalités de traitement.',
                    ],
                    'processor_summary' => [
                        'label' => 'Sous-traitants et localisation',
                        'type' => 'textarea',
                        'description' => 'Résumé public de l’hébergement, de l’exécution métier, du paiement et des prestataires techniques.',
                    ],
                    'cookies_list' => [
                        'label' => 'Liste des cookies / traceurs',
                        'type' => 'textarea',
                        'description' => 'Une ligne par famille de cookies ou de traceurs.',
                    ],
                    'ai_summary' => [
                        'label' => 'IA / assistance documentaire',
                        'type' => 'textarea',
                        'description' => 'Décrit l’assistance algorithmique sans la présenter comme une décision médicale automatisée.',
                    ],
                ],
            ],
        ];
    }

    /**
     * @return array<string, mixed>
     */
    public static function get_state(): array
    {
        $raw = get_option(self::OPTION_KEY, null);
        $state = is_array($raw) ? $raw : [];
        $defaults = self::default_state();

        $merged = array_merge($defaults, $state);
        $merged['registry'] = array_merge($defaults['registry'], is_array($state['registry'] ?? null) ? $state['registry'] : []);

        foreach (array_keys(self::slots()) as $slot) {
            $slotState = is_array($state[$slot] ?? null) ? $state[$slot] : [];
            $defaultsForSlot = is_array($defaults[$slot]) ? $defaults[$slot] : [];
            $merged[$slot] = array_merge($defaultsForSlot, $slotState);
            $merged[$slot]['page_id'] = max(0, (int) ($merged[$slot]['page_id'] ?? 0));
            $merged[$slot]['version'] = self::normalize_version((string) ($merged[$slot]['version'] ?? '1.0.0'));
            $merged[$slot]['effective_date'] = self::normalize_date_string((string) ($merged[$slot]['effective_date'] ?? ''), (string) $defaultsForSlot['effective_date']);
            $merged[$slot]['updated_at'] = self::normalize_date_string((string) ($merged[$slot]['updated_at'] ?? ''), (string) $merged[$slot]['effective_date']);
            $merged[$slot]['sources_public'] = self::normalize_sources($slotState['sources_public'] ?? $defaultsForSlot['sources_public'] ?? []);
        }

        $registry = $merged['registry'];
        $merged['registry'] = [
            'brand_name' => self::text($registry['brand_name'] ?? 'SOS Prescription'),
            'brand_registration_number' => self::text($registry['brand_registration_number'] ?? '5002143'),
            'brand_registration_date' => self::normalize_date_string((string) ($registry['brand_registration_date'] ?? ''), '2023-10-29'),
            'site_url' => esc_url_raw((string) ($registry['site_url'] ?? home_url('/'))),
            'operator_name' => self::text($registry['operator_name'] ?? 'Digital Pacifika'),
            'operator_identity' => self::textarea($registry['operator_identity'] ?? ''),
            'publication_director' => self::text($registry['publication_director'] ?? 'Digital Pacifika'),
            'main_contact_email' => self::email($registry['main_contact_email'] ?? 'contact@sosprescription.fr', 'contact@sosprescription.fr'),
            'privacy_contact_email' => self::email($registry['privacy_contact_email'] ?? 'privacy@sosprescription.fr', 'privacy@sosprescription.fr'),
            'public_host_summary' => self::text($registry['public_host_summary'] ?? ''),
            'technical_maintainer_summary' => self::text($registry['technical_maintainer_summary'] ?? ''),
            'doctor_enabled' => !empty($registry['doctor_enabled']),
            'doctor_identity' => self::text($registry['doctor_identity'] ?? ''),
            'service_positioning' => self::textarea($registry['service_positioning'] ?? ''),
            'eligibility_summary' => self::textarea($registry['eligibility_summary'] ?? ''),
            'pricing_summary' => self::textarea($registry['pricing_summary'] ?? ''),
            'response_delay' => self::text($registry['response_delay'] ?? ''),
            'payment_summary' => self::textarea($registry['payment_summary'] ?? ''),
            'disputes_summary' => self::textarea($registry['disputes_summary'] ?? ''),
            'complaint_contact' => self::email($registry['complaint_contact'] ?? ($registry['main_contact_email'] ?? 'contact@sosprescription.fr'), self::email($registry['main_contact_email'] ?? 'contact@sosprescription.fr', 'contact@sosprescription.fr')),
            'dpo_declared' => !empty($registry['dpo_declared']),
            'dpo_identity' => self::text($registry['dpo_identity'] ?? ''),
            'purposes_summary' => self::textarea($registry['purposes_summary'] ?? ''),
            'processor_summary' => self::textarea($registry['processor_summary'] ?? ''),
            'cookies_list' => self::textarea($registry['cookies_list'] ?? ''),
            'ai_summary' => self::textarea($registry['ai_summary'] ?? ''),
            'consent_required' => !empty($registry['consent_required']),
            'privacy_page_sync' => !empty($registry['privacy_page_sync']),
            'worker_runtime' => self::text($registry['worker_runtime'] ?? 'Scalingo France'),
            'object_storage' => self::text($registry['object_storage'] ?? 'AWS Paris'),
            'payment_provider' => self::text($registry['payment_provider'] ?? 'Stripe'),
        ];

        $merged['updated_at'] = is_string($merged['updated_at'] ?? null) ? trim((string) $merged['updated_at']) : '';

        return $merged;
    }

    /**
     * @param array<string, mixed> $state
     */
    public static function save_state(array $state): void
    {
        $current = self::get_state();
        $next = array_merge($current, $state);
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
     * @return array<string, array<string, mixed>>
     */
    public static function get_dashboard_bindings(): array
    {
        $state = self::get_state();
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
                'version' => (string) ($state[$slot]['version'] ?? '1.0.0'),
                'effective_date' => (string) ($state[$slot]['effective_date'] ?? self::today()),
                'updated_at' => (string) ($state[$slot]['updated_at'] ?? self::today()),
            ];
        }

        return $rows;
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
        $operatorName = (string) ($registry['operator_name'] ?? 'Digital Pacifika');
        $operatorIdentity = self::multiline_html((string) ($registry['operator_identity'] ?? ''));
        $publicationDirector = self::safe_or_default((string) ($registry['publication_director'] ?? ''), $operatorName);
        $mainContact = self::safe_or_default((string) ($registry['main_contact_email'] ?? ''), 'contact@sosprescription.fr');
        $hostSummary = self::safe_or_default((string) ($registry['public_host_summary'] ?? ''), 'Hostinger — offre Cloud Startup — hébergement du site public WordPress');
        $maintainerSummary = self::safe_or_default((string) ($registry['technical_maintainer_summary'] ?? ''), 'Digital Pacifika — maintenance technique du site');
        $doctorEnabled = !empty($registry['doctor_enabled']);
        $doctorIdentity = self::safe_or_default((string) ($registry['doctor_identity'] ?? ''), 'Dr Yves Burckel — Médecin urgentiste — RPPS 10000554302');
        $brandName = self::safe_or_default((string) ($registry['brand_name'] ?? ''), 'SOS Prescription');
        $brandNumber = self::safe_or_default((string) ($registry['brand_registration_number'] ?? ''), '5002143');
        $brandDate = self::format_date((string) ($registry['brand_registration_date'] ?? '2023-10-29'));

        $html = '<div class="sp-legal-document sp-legal-document--mentions">';
        $html .= self::render_meta_block('mentions', $state, 'Document public d’identification', 'Informations relatives à l’éditeur du site, à l’hébergement du site public et aux principaux liens de contact.');
        $html .= self::lead('Les présentes mentions légales ont pour objet d’identifier l’éditeur du site et du service SOS Prescription, les principaux intervenants techniques publiquement déclarés, ainsi que les documents de référence accessibles depuis le site.');
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
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Cadre public du service et documents associés</h2>';
        $html .= self::paragraph('Le site public constitue une façade d’information, d’accès au parcours et de publication documentaire. Les conditions du service, les règles de confidentialité et les informations relatives aux cookies sont détaillées dans les pages juridiques associées.');
        $html .= self::render_internal_links([
            [self::page_url('conditions', $state), 'Consulter les conditions du service, tarifs et paiement'],
            [self::page_url('privacy', $state), 'Consulter la page confidentialité, données de santé et cookies'],
        ]);
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
        $pricing = self::safe_or_default((string) ($registry['pricing_summary'] ?? ''), 'Le tarif applicable est présenté au patient avant validation finale de sa demande. Le paiement ne doit pas être compris comme l’achat automatique d’une ordonnance ou d’un médicament.');
        $responseDelay = self::safe_or_default((string) ($registry['response_delay'] ?? ''), 'Les demandes sont traitées de manière asynchrone. Les délais peuvent varier selon la complétude du dossier, le volume de demandes et la disponibilité médicale.');
        $paymentSummary = self::safe_or_default((string) ($registry['payment_summary'] ?? ''), 'Une préautorisation bancaire peut être sollicitée via Stripe avant l’analyse du dossier. La capture effective ou l’annulation intervient ensuite selon l’issue du traitement médical du dossier.');
        $disputesSummary = self::safe_or_default((string) ($registry['disputes_summary'] ?? ''), 'Toute réclamation non urgente doit être adressée en priorité au contact indiqué ci-dessous. Les contestations portant sur l’appréciation clinique relèvent du cadre propre au service de santé et de l’indépendance du médecin.');
        $complaintContact = self::safe_or_default((string) ($registry['complaint_contact'] ?? ''), self::safe_or_default((string) ($registry['main_contact_email'] ?? ''), 'contact@sosprescription.fr'));
        $paymentProvider = self::safe_or_default((string) ($registry['payment_provider'] ?? ''), 'Stripe');
        $doctorEnabled = !empty($registry['doctor_enabled']);
        $doctorIdentity = self::safe_or_default((string) ($registry['doctor_identity'] ?? ''), 'Dr Yves Burckel — Médecin urgentiste — RPPS 10000554302');

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
        $html .= '<h2>Définitions</h2>';
        $html .= self::unordered_list([
            '<strong>Service</strong> : désigne le service SOS Prescription, accessible via le site, dans le cadre d’une demande de continuité thérapeutique.',
            '<strong>Patient</strong> : désigne la personne qui soumet une demande pour elle-même dans les conditions prévues par le service.',
            '<strong>Dossier</strong> : désigne l’ensemble des informations, déclarations, justificatifs et échanges transmis dans le cadre d’une demande.',
            '<strong>Médecin</strong> : désigne le praticien qui examine le dossier et décide, en toute indépendance, de la suite à lui donner.',
            '<strong>Ordonnance de relais</strong> : désigne, lorsqu’elle est effectivement émise, l’ordonnance établie par le médecin à l’issue de son analyse.',
        ]);
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Déroulement d’une demande</h2>';
        $html .= self::paragraph('La plateforme a pour objet de faciliter un parcours de continuité thérapeutique dans un cadre non urgent. Elle ne constitue pas un service d’urgence, n’assure pas de consultation instantanée et ne remplace pas l’orientation vers une prise en charge adaptée lorsque l’état du patient l’exige.');
        $html .= self::paragraph(esc_html($eligibility));
        $html .= self::paragraph('Le patient doit transmettre des informations exactes, à jour et sincères. Le service peut refuser, suspendre ou interrompre le traitement d’un dossier manifestement incomplet, incohérent, trompeur, inadapté au périmètre du service ou incompatible avec la sécurité du patient.');
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Analyse médicale et indépendance du médecin</h2>';
        $html .= self::paragraph('Chaque dossier fait l’objet d’une analyse humaine par un médecin. La décision médicale reste indépendante et ne peut être automatisée ni garantie à l’avance.');
        if ($doctorEnabled) {
            $html .= self::paragraph('Référence médicale affichée : <strong>' . esc_html($doctorIdentity) . '</strong>.');
        }
        $html .= self::paragraph('L’existence d’un paiement, d’une préautorisation ou d’une demande complète n’emporte jamais, à elle seule, délivrance automatique d’une ordonnance.');
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Tarifs, paiement et préautorisation</h2>';
        $html .= self::paragraph(esc_html($pricing));
        $html .= self::paragraph(esc_html($paymentSummary));
        $html .= self::definition_list([
            'Prestataire de paiement déclaré' => esc_html($paymentProvider),
            'Régime de paiement' => 'Préautorisation puis capture ou annulation selon l’issue du dossier',
            'Garantie de prescription' => 'Aucune',
        ]);
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Délais de traitement</h2>';
        $html .= self::paragraph(esc_html($responseDelay));
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Accès aux documents, ordonnances et réversibilité d’accès</h2>';
        $html .= self::paragraph('Lorsqu’un document ou une ordonnance est effectivement émis dans le cadre du service, il est mis à disposition du patient selon les modalités techniques prévues par la plateforme. L’accès peut être limité dans le temps pour des raisons de sécurité, d’organisation technique ou de conformité documentaire.');
        $html .= self::paragraph('Le patient est invité à conserver les documents qui lui sont remis. La plateforme n’a pas vocation à garantir un archivage permanent, illimité et autonome des documents au-delà des durées de conservation et des contraintes techniques ou légales applicables.');
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Responsabilité, disponibilité et force majeure</h2>';
        $html .= self::paragraph('Le service est fourni dans le cadre d’une obligation de moyens, compatible avec un traitement asynchrone, non urgent et dépendant notamment de la disponibilité du médecin, de la complétude du dossier et des contraintes techniques. Aucune disponibilité absolue ni aucun temps de réponse fixe ne sont garantis.');
        $html .= self::paragraph('Le service peut être temporairement interrompu, limité ou ralenti pour maintenance, sécurité, mise à jour, incident technique ou événement extérieur raisonnablement hors du contrôle de l’exploitant. La responsabilité du service ne saurait être engagée lorsque l’interruption résulte d’un cas de force majeure, d’une indisponibilité d’un prestataire critique, d’un incident réseau, d’une attaque informatique, d’un acte d’un tiers, d’un comportement fautif de l’utilisateur ou d’une situation incompatible avec le périmètre du service.');
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Réclamations, litiges et droit applicable</h2>';
        $html .= self::paragraph(esc_html($disputesSummary));
        $html .= self::paragraph('Contact réclamations : <a href="mailto:' . esc_attr($complaintContact) . '">' . esc_html($complaintContact) . '</a>.');
        $html .= self::paragraph('Le service ne doit pas être assimilé à une prestation standard de commerce électronique. Lorsque la demande relève d’un acte ou d’une appréciation médicale, la décision clinique demeure distincte d’une logique de vente automatisée. Le droit applicable demeure le droit français, sous réserve des dispositions impératives éventuellement applicables.');
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Modification des conditions</h2>';
        $html .= self::paragraph('Les présentes conditions peuvent être mises à jour afin de tenir compte d’évolutions légales, réglementaires, techniques, organisationnelles ou médicales. La version publiée sur le site à la date de consultation fait foi pour l’information générale du public.');
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
        $purposes = self::safe_or_default((string) ($registry['purposes_summary'] ?? ''), 'Gestion des demandes, analyse du dossier, échanges patient-médecin, continuité de traitement, sécurisation de la plateforme, gestion administrative et financière, prévention des abus et respect des obligations légales.');
        $processors = self::safe_or_default((string) ($registry['processor_summary'] ?? ''), 'Le site public WordPress est hébergé chez Hostinger. L’exécution métier sensible est opérée sur Scalingo France. Le stockage objet est assuré sur AWS Paris. Les opérations de paiement sont réalisées via Stripe. D’autres prestataires techniques peuvent intervenir pour l’email, la protection antispam/captcha et, si activée, l’assistance documentaire.');
        $aiSummary = self::safe_or_default((string) ($registry['ai_summary'] ?? ''), 'Une assistance algorithmique peut être utilisée pour la reconnaissance de justificatifs ou l’aide à la lecture de documents transmis. Elle n’emporte pas de décision médicale automatisée. La décision finale reste humaine et médicale.');
        $workerRuntime = self::safe_or_default((string) ($registry['worker_runtime'] ?? ''), 'Scalingo France');
        $objectStorage = self::safe_or_default((string) ($registry['object_storage'] ?? ''), 'AWS Paris');
        $dpoDeclared = !empty($registry['dpo_declared']);
        $dpoIdentity = self::safe_or_default((string) ($registry['dpo_identity'] ?? ''), '');

        $html = '<div class="sp-legal-document sp-legal-document--privacy">';
        $html .= self::render_meta_block('privacy', $state, 'Document public — confidentialité', 'Protection des données personnelles, données de santé, architecture déclarée et cookies utilisés par le site.');
        $html .= self::lead('Cette page décrit les principes de confidentialité applicables au service SOS Prescription, la manière dont les données personnelles — y compris les données concernant la santé — peuvent être traitées, la chaîne technique publiée du service, ainsi que les règles relatives aux cookies et autres traceurs.');
        $html .= self::callout([
            'Les données de santé sont des données sensibles',
            'Le site public WordPress agit comme façade',
            'Les traitements métier sensibles sont opérés dans une couche séparée',
            'La décision médicale reste humaine et non automatisée',
        ]);

        $html .= '<section>';
        $html .= '<h2>Responsable du traitement et contact</h2>';
        $html .= self::paragraph('Le responsable du traitement affiché pour le service est <strong>' . esc_html($operatorName) . '</strong>. Les demandes relatives aux données personnelles peuvent être adressées à <a href="mailto:' . esc_attr($privacyContact) . '">' . esc_html($privacyContact) . '</a>.');
        if ($dpoDeclared && $dpoIdentity !== '') {
            $html .= self::paragraph('DPO affiché : <strong>' . esc_html($dpoIdentity) . '</strong>.');
        } else {
            $html .= self::paragraph('Aucun DPO formel n’est affiché à ce stade. Le point de contact confidentialité ci-dessus reste l’entrée dédiée pour les demandes des personnes concernées.');
        }
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Données traitées et finalités principales</h2>';
        $html .= self::unordered_list([
            'Données d’identification et de contact nécessaires à l’ouverture et au suivi du dossier.',
            'Informations fournies dans le cadre de la demande de continuité thérapeutique, y compris des éléments potentiellement médicaux ou sensibles.',
            'Justificatifs, échanges, informations techniques de sécurité et éléments utiles à la gestion administrative du dossier.',
        ]);
        $html .= self::paragraph(esc_html($purposes));
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Sous-traitants déclarés, hébergement et localisation</h2>';
        $html .= self::paragraph(esc_html($processors));
        $html .= self::definition_list([
            'Façade publique' => 'WordPress — site public hébergé chez Hostinger',
            'Exécution métier déclarée' => esc_html($workerRuntime),
            'Stockage objet déclaré' => esc_html($objectStorage),
            'Paiement' => 'Stripe',
        ]);
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Sécurité et architecture déclarée</h2>';
        $html .= self::paragraph('Le site public sert de façade applicative et ne doit pas redevenir la source de vérité de la donnée métier sensible. Les traitements métier, la gestion des artefacts et les opérations financières critiques sont opérés dans une couche dédiée.');
        $html .= self::unordered_list([
            'Séparation stricte entre façade WordPress et moteur métier.',
            'Contrôles d’accès limités aux personnes habilitées.',
            'Accès aux artefacts et documents gérés via des mécanismes restreints et temporaires lorsque cela est applicable.',
            'Traçabilité technique et sécurisation du parcours utilisateur.',
        ]);
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Violation de données, incidents et continuité</h2>';
        $html .= self::paragraph('En cas d’incident de sécurité ou de violation de données personnelles, SOS Prescription agit avec ses prestataires techniques pour qualifier l’incident, le contenir, en mesurer l’impact, restaurer le service et satisfaire, le cas échéant, aux obligations d’information ou de notification prévues par le cadre applicable.');
        $html .= self::paragraph('Des mesures de continuité, de restauration et de sécurisation peuvent être activées afin de préserver l’intégrité des traitements, la disponibilité raisonnable du service et la protection des données concernées.');
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Conservation, suppression et droits des personnes</h2>';
        $html .= self::paragraph('Les données sont conservées pendant la durée nécessaire à la gestion du dossier, au respect des obligations légales, à la sécurité du service et au traitement des réclamations, selon la nature des données concernées.');
        $html .= self::paragraph('Vous pouvez demander l’accès à vos données, leur rectification, l’effacement lorsque cela est applicable, la limitation de certains traitements ou l’exercice de tout autre droit prévu par le cadre applicable. SOS Prescription peut, lorsque cela est nécessaire, s’appuyer sur ses prestataires techniques pour traiter correctement ces demandes. Vous pouvez également introduire une réclamation auprès de la CNIL.');
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Assistance algorithmique</h2>';
        $html .= self::paragraph(esc_html($aiSummary));
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
    private static function default_state(): array
    {
        $today = self::today();

        return [
            'updated_at' => '',
            'registry' => [
                'brand_name' => 'SOS Prescription',
                'brand_registration_number' => '5002143',
                'brand_registration_date' => '2023-10-29',
                'site_url' => home_url('/'),
                'operator_name' => 'Digital Pacifika',
                'operator_identity' => "98600 Wallis-et-Futuna, South Pacific\nN° CD : 2022.1.2573\nN° RCS : 2020 A 0102\nCapital social : 3.000.000 XPF\nTVA : non applicable / non renseignée à ce stade",
                'publication_director' => 'Digital Pacifika',
                'main_contact_email' => 'contact@sosprescription.fr',
                'privacy_contact_email' => 'privacy@sosprescription.fr',
                'public_host_summary' => 'Hostinger — offre Cloud Startup — hébergement du site public WordPress',
                'technical_maintainer_summary' => 'Digital Pacifika — maintenance et support technique du site',
                'doctor_enabled' => true,
                'doctor_identity' => 'Dr Yves Burckel — Médecin urgentiste — RPPS 10000554302',
                'service_positioning' => 'SOS Prescription est un service privé, non urgent et asynchrone de continuité thérapeutique. Il permet à un patient, dans un cadre strictement défini, de solliciter l’analyse de sa situation par un médecin afin de déterminer s’il y a lieu ou non d’émettre une ordonnance de relais.',
                'eligibility_summary' => 'Le service est réservé aux demandes compatibles avec un besoin de continuité de traitement. Il ne remplace pas une prise en charge d’urgence, un diagnostic en temps réel, ni une consultation adaptée en cas de symptômes nouveaux, graves ou évolutifs.',
                'pricing_summary' => 'Le tarif applicable est affiché au patient avant validation finale de sa demande. Le paiement ne doit pas être compris comme l’achat automatique d’une ordonnance ou d’un médicament. Aucune prescription n’est garantie.',
                'response_delay' => 'Les demandes sont traitées de manière asynchrone. Les délais peuvent varier selon la complétude du dossier, le volume de demandes et la disponibilité médicale.',
                'payment_summary' => 'La plateforme peut solliciter une préautorisation bancaire via Stripe avant l’analyse médicale du dossier. La capture effective ou l’annulation intervient ensuite selon l’issue du traitement médical.',
                'disputes_summary' => 'Toute réclamation non urgente doit être adressée en priorité au contact indiqué. Les contestations portant sur l’appréciation clinique relèvent du cadre propre au service de santé et de l’indépendance du médecin.',
                'complaint_contact' => 'contact@sosprescription.fr',
                'dpo_declared' => false,
                'dpo_identity' => '',
                'purposes_summary' => 'Gestion des demandes, analyse du dossier, continuité de traitement, échanges patient-médecin, sécurisation de la plateforme, gestion administrative et financière, prévention des abus et respect des obligations légales.',
                'processor_summary' => 'Le site public WordPress est hébergé chez Hostinger. L’exécution métier sensible est opérée sur Scalingo France. Le stockage objet est assuré sur AWS Paris. Les opérations de paiement sont réalisées via Stripe. D’autres prestataires techniques peuvent intervenir pour l’email, la protection antispam/captcha et, si activée, l’assistance documentaire.',
                'cookies_list' => "Cookies strictement nécessaires au fonctionnement du site et à la sécurité des sessions\nCookies techniques permettant le maintien du parcours utilisateur\nCookies ou traceurs complémentaires uniquement lorsqu’ils sont effectivement activés et, le cas échéant, soumis à un mécanisme de consentement conforme",
                'ai_summary' => 'Une assistance algorithmique peut être utilisée pour la reconnaissance de justificatifs, la lecture de documents transmis ou l’assistance documentaire. Elle n’emporte pas de décision médicale automatisée. La décision finale reste humaine et médicale.',
                'consent_required' => true,
                'privacy_page_sync' => true,
                'worker_runtime' => 'Scalingo France',
                'object_storage' => 'AWS Paris',
                'payment_provider' => 'Stripe',
            ],
            'mentions' => [
                'page_id' => 0,
                'version' => '1.1.0',
                'effective_date' => $today,
                'updated_at' => $today,
                'sources_public' => [
                    ['label' => 'Digital Pacifika', 'url' => 'https://digitalpacifika.com', 'note' => 'Exploitant public déclaré du service.'],
                    ['label' => 'Hostinger', 'url' => 'https://www.hostinger.fr/', 'note' => 'Hébergeur déclaré du site public WordPress.'],
                ],
            ],
            'conditions' => [
                'page_id' => 0,
                'version' => '1.1.0',
                'effective_date' => $today,
                'updated_at' => $today,
                'sources_public' => [
                    ['label' => 'Article L221-2 du code de la consommation — Légifrance', 'url' => 'https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000044563156', 'note' => 'Référence publique utile pour le cadrage du service et de son régime juridique.'],
                    ['label' => 'DGCCRF — facturation des professionnels et établissements de santé', 'url' => 'https://www.economie.gouv.fr/dgccrf/les-fiches-pratiques/facturation-des-professionnels-et-etablissements-de-sante-quest-ce-qui-peut-vous-etre-facture', 'note' => 'Référence publique sur litiges et médiation de la consommation dans le secteur de la santé.'],
                    ['label' => 'Stripe', 'url' => 'https://stripe.com/fr', 'note' => 'Prestataire de paiement déclaré pour la préautorisation et la capture.'],
                ],
            ],
            'privacy' => [
                'page_id' => 0,
                'version' => '1.1.0',
                'effective_date' => $today,
                'updated_at' => $today,
                'sources_public' => [
                    ['label' => 'CNIL — Santé', 'url' => 'https://www.cnil.fr/sante', 'note' => 'Référence publique relative aux données personnelles dans le domaine de la santé.'],
                    ['label' => 'CNIL — Violations de données personnelles', 'url' => 'https://www.cnil.fr/fr/violations-de-donnees-personnelles-les-regles-suivre', 'note' => 'Référence publique sur la gestion des violations de données.'],
                    ['label' => 'CNIL — Cookies et traceurs : que dit la loi ?', 'url' => 'https://www.cnil.fr/cookies-et-traceurs-que-dit-la-loi', 'note' => 'Référence publique sur le cadre applicable aux traceurs.'],
                    ['label' => 'CNIL — Les règles à suivre pour les cookies', 'url' => 'https://www.cnil.fr/fr/cookies-et-autres-traceurs/regles/cookies', 'note' => 'Référence publique complémentaire sur les règles cookies.'],
                    ['label' => 'Agence du Numérique en Santé — certification HDS', 'url' => 'https://esante.gouv.fr/ens/offre/hds', 'note' => 'Référence publique sur le cadre HDS.'],
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
