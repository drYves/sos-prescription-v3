# SOS Prescription V7.4 — Audit comparatif Zava et corpus éditorial enrichi

**Statut** : livrable de fermeture éditoriale  
**Périmètre** : substance juridique et clinique uniquement  
**Sortie attendue** : audit comparatif suivi du code PHP complet de `LegalPages.php`  
**Principe** : aucun changement d’UI, aucun changement de layout, aucun changement du moteur de binding

---

## 1. Objet du livrable

Ce document poursuit un objectif précis : **faire mûrir la partie “clinique et relation patient” du corpus légal SOS Prescription** à partir des documents Zava fournis, sans casser :

- la structure en 3 pages ;
- les `<h2>` qui nourrissent le layout documentaire ;
- le registre dynamique déjà utilisé par le générateur ;
- la logique de rendu public existante dans `LegalPages.php`.

Le fichier PHP complet fourni plus bas est donc pensé comme une **mise à niveau éditoriale ciblée** de la classe existante, et non comme une réécriture architecturale.

---

## 2. Référentiel comparé

### 2.1 Référentiel d’inspiration clinique utilisé
- **Zava — Termes et Conditions**
- **Zava — Charte des données personnelles**

### 2.2 Référentiel SOS Prescription conservé
- corpus actuel présent dans `LegalPages.php`
- architecture V4 zéro-PII
- doctrine V7 (pages légales = surfaces publiques, theme-owned)
- logique du générateur et du registre back-office déjà en place

### 2.3 Principe de transposition

Les textes Zava n’ont **pas** été copiés.  
Seuls les **concepts métier et relationnels transposables** ont été retenus, puis réécrits dans un ton :

- sobre ;
- prudent ;
- médical ;
- compatible avec un service privé, non urgent, asynchrone et de continuité thérapeutique.

---

## 3. Concepts Zava retenus, adaptés et injectés

## 3.1 Concepts transposés pour la page 2

### A. Obligation de sincérité du patient
Ajout explicite d’un bloc sur :
- l’exactitude, la sincérité et l’actualité des informations ;
- l’interdiction de répondre “au hasard” ;
- l’obligation de signaler toute information nouvelle utile au dossier.

### B. Interdiction de soumettre une demande pour un tiers
Ajout d’une clause claire :
- la demande doit être faite pour soi-même ;
- pas d’usage de l’identité d’un tiers ;
- pas de contournement du cadre du service.

### C. Refus ou réorientation pour motif clinique
Ajout d’une formulation robuste selon laquelle le médecin peut :
- demander des précisions ;
- juger que le cadre n’est pas adapté ;
- refuser toute ordonnance ;
- réorienter vers une consultation en présentiel ou un autre circuit de soins.

### D. Usage strictement personnel de l’ordonnance
Ajout d’une clause claire selon laquelle :
- l’ordonnance est nominative ;
- elle ne doit pas être cédée, partagée ni utilisée par un tiers ;
- le patient doit lire la notice et conserver les documents utiles.

### E. Coordination des soins
Ajout d’une incitation explicite à :
- informer le médecin traitant ;
- partager les traitements ou documents obtenus via le service lorsque cela est utile à la continuité des soins.

### F. Différence avec un site e-commerce standard
Renforcement de la clause existante :
- pas de lecture “achat classique” ;
- pas d’activation par défaut des blocs standard de rétractation 14 jours pour la partie strictement médicale ;
- une demande médicalement engagée ne s’annule pas comme une simple commande de biens.

### G. Validité pratique de l’ordonnance
Ajout d’une formulation prudente sur :
- l’usage dans le délai de validité applicable ;
- la règle de principe des trois mois pour une première délivrance de médicaments, avec réserve sur les régimes particuliers.

---

## 3.2 Concepts transposés pour la page 3

### A. Suspension du compte ≠ effacement immédiat
Ajout d’une distinction claire entre :
- arrêt / fermeture / suspension du compte ;
- conservation / archivage de certaines données.

### B. Exceptions au droit à l’effacement
Ajout d’une formulation plus précise sur les cas où l’effacement peut être limité, notamment lorsque les données sont nécessaires :
- au respect d’une obligation légale ;
- à l’intérêt public dans le domaine de la santé ;
- à la continuité des soins ;
- à la sécurité du service ;
- à la défense de droits en justice.

### C. Archivage du dossier et des échanges médicaux
Ajout d’une clause plus mature sur :
- l’archivage sécurisé des éléments qui doivent être conservés ;
- la différence entre suppression, anonymisation, archivage et extinction des sauvegardes.

### D. Assistance à l’exercice des droits
Renforcement de la page 3 pour préciser que :
- SOS Prescription reste l’interlocuteur principal ;
- une assistance technique raisonnable de prestataires peut être sollicitée pour identifier, extraire, rectifier, limiter ou supprimer les données lorsque cela est légalement possible.

---

## 4. Concepts volontairement non transposés

Les éléments suivants des textes Zava n’ont pas été repris, car ils seraient inadaptés, trompeurs ou trop spécifiques :

- le droit irlandais et les autorités irlandaises ;
- les références corporate propres à Zava ;
- les seuils d’âge ou de territoire propres à Zava ;
- la promesse de réponse “24h ouvrées” formulée comme engagement standard ;
- la description détaillée de leur espace compte et de leur UX ;
- la logique newsletter / prospection marketing ;
- la procédure interne de réclamation “en sept étapes” ;
- les clauses de linking externe, d’iframe, de promotion et d’usage éditorial du site ;
- la mécanique exacte de suspension de compte via leurs paramètres utilisateurs.

---

## 5. Impact concret sur le corpus SOS Prescription

## 5.1 Page 1 — Mentions légales
**Impact faible.**  
Le référentiel Zava apporte peu d’éléments utiles ici.  
La page 1 est donc laissée **quasi stable**, afin d’éviter du bruit éditorial inutile.

## 5.2 Page 2 — Conditions du service, tarifs et paiement
**Impact fort.**  
La page gagne :
- des définitions plus nettes ;
- une logique de parcours clinique plus crédible ;
- des obligations patient plus explicites ;
- une meilleure distinction entre acte médical et achat standard ;
- une meilleure doctrine d’usage de l’ordonnance.

## 5.3 Page 3 — Confidentialité, données de santé et cookies
**Impact fort.**  
La page gagne :
- une meilleure pédagogie sur l’archivage ;
- une meilleure distinction suspension / suppression ;
- une meilleure lisibilité sur les limites du droit à l’effacement ;
- un meilleur ancrage santé / dossier / continuité de soins.

---

## 6. Choix d’implémentation dans `LegalPages.php`

Le fichier PHP ci-dessous respecte les choix suivants :

1. **Aucun changement de structure technique globale**
   - même classe ;
   - mêmes méthodes ;
   - même stockage ;
   - mêmes slots ;
   - même rendu documentaire.

2. **Aucune réouverture de l’UI admin**
   - aucun nouveau champ ;
   - aucun nouveau tab ;
   - aucune dépendance nouvelle côté back-office.

3. **Préservation de la logique dynamique**
   - les variables de registre restent injectées dynamiquement ;
   - le corpus continue de dépendre des valeurs registry existantes.

4. **Mise à jour éditoriale concentrée**
   - `render_conditions()` enrichi ;
   - `render_privacy()` enrichi ;
   - `default_state()` mis à niveau pour les valeurs initiales et les sources publiques ;
   - page 1 volontairement peu retouchée.

5. **Version éditoriale recommandée**
   - passage des 3 pages à `1.2.0` dans les valeurs par défaut du corpus.

---

## 7. Code PHP complet — `LegalPages.php`

> **Chemin cible recommandé** :  
> `sos-prescription-v3/includes/Services/LegalPages.php`

```php
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
        $html .= self::lead('Les présentes mentions légales identifient l’éditeur du site et du service SOS Prescription, l’hébergement du site public ainsi que les principaux contacts associés à la publication.');
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
        $pricing = self::safe_or_default((string) ($registry['pricing_summary'] ?? ''), 'Le tarif applicable est affiché au patient avant validation finale de sa demande. Le paiement ne doit pas être compris comme l’achat automatique d’une ordonnance ou d’un médicament. Aucune prescription n’est garantie.');
        $responseDelay = self::safe_or_default((string) ($registry['response_delay'] ?? ''), 'Les demandes sont traitées de manière asynchrone. Les délais peuvent varier selon la complétude du dossier, le volume de demandes et la disponibilité médicale.');
        $paymentSummary = self::safe_or_default((string) ($registry['payment_summary'] ?? ''), 'La plateforme peut solliciter une préautorisation bancaire via Stripe avant l’analyse médicale du dossier. La capture effective ou l’annulation intervient ensuite selon l’issue du traitement médical.');
        $disputesSummary = self::safe_or_default((string) ($registry['disputes_summary'] ?? ''), 'Toute réclamation non urgente doit être adressée en priorité au contact indiqué. Les contestations portant sur l’appréciation clinique relèvent du cadre propre au service de santé et de l’indépendance du médecin.');
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
        $html .= self::paragraph(esc_html($eligibility));
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Déroulement d’une demande et décision médicale</h2>';
        $html .= self::paragraph('Le patient constitue un dossier et transmet les informations demandées ainsi que, le cas échéant, les justificatifs utiles à l’instruction du dossier. Le traitement du dossier intervient de manière <strong>asynchrone</strong> : le service ne promet ni réponse instantanée ni délai uniforme en toutes circonstances.');
        $html .= self::paragraph(esc_html($responseDelay));
        $html .= self::paragraph('Chaque dossier fait l’objet d’une <strong>analyse humaine</strong> par un médecin. La décision médicale demeure <strong>personnelle, indépendante et non automatisée</strong>.');
        $html .= self::unordered_list([
            'demander des informations complémentaires ;',
            'considérer que le cadre du service n’est pas adapté ;',
            'refuser de délivrer une ordonnance ;',
            'ou, lorsqu’il l’estime médicalement justifié, délivrer une ordonnance de relais.',
        ]);
        $html .= self::paragraph('Le médecin peut refuser ou réorienter une demande pour des raisons cliniques, de sécurité ou de conformité du dossier, notamment si les éléments transmis sont incomplets, incohérents, trompeurs, insuffisants pour une appréciation médicale prudente, ou s’ils justifient un examen en présentiel ou une orientation vers un autre circuit de soins.');
        $html .= self::paragraph('Le recours au service, l’existence d’une demande complète, d’un paiement ou d’une préautorisation n’emportent jamais, à eux seuls, délivrance automatique d’une ordonnance.');
        if ($doctorEnabled) {
            $html .= self::paragraph('Référence médicale affichée : <strong>' . esc_html($doctorIdentity) . '</strong>.');
        }
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Obligations du patient, sincérité et sécurité du compte</h2>';
        $html .= self::paragraph('Le patient s’engage à utiliser le service de bonne foi et à transmettre des informations exactes, sincères et à jour. En cas de doute sur une question, il lui appartient de demander une précision plutôt que de répondre au hasard.');
        $html .= self::unordered_list([
            'répondre honnêtement au questionnaire et aux demandes complémentaires, au mieux de sa connaissance ;',
            'ne pas soumettre une demande pour le compte d’un tiers ni utiliser l’identité d’un tiers ;',
            'signaler sans délai toute information nouvelle susceptible de modifier l’appréciation du dossier ;',
            'ne pas transmettre de documents falsifiés, trompeurs ou illicites ;',
            'conserver ses identifiants d’accès confidentiels et ne pas partager son compte ;',
            'ne pas utiliser le service dans une situation d’urgence ou hors de son périmètre normal.',
        ]);
        $html .= self::paragraph('Le service peut suspendre l’accès à certaines fonctionnalités, bloquer ou clôturer un dossier en cas d’usage manifestement abusif, frauduleux, techniquement dangereux ou contraire à la finalité du service.');
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Ordonnance, usage personnel et coordination des soins</h2>';
        $html .= self::paragraph('Lorsqu’une ordonnance de relais est mise à disposition, elle est <strong>strictement personnelle</strong>. Elle ne doit pas être cédée, partagée, réutilisée pour un tiers ni utilisée en dehors du cadre fixé par le médecin.');
        $html .= self::paragraph('Le patient est invité à télécharger, lire et conserver sans attendre tout document mis à sa disposition dans son espace. Il lui appartient également de lire la notice du traitement, de respecter la prescription, ainsi que de vérifier la durée de validité applicable à l’ordonnance et aux médicaments concernés.');
        $html .= self::paragraph('Pour la première délivrance des médicaments en pharmacie, une ordonnance doit en principe être présentée dans les trois mois de sa rédaction, sous réserve des règles particulières applicables à certains produits, des mentions de renouvellement et des limites fixées par le prescripteur.');
        $html .= self::paragraph('Afin de favoriser la continuité et la sécurité des soins, il est fortement recommandé au patient d’informer son médecin traitant, ainsi que tout professionnel de santé qui le suit utilement, des traitements ou documents obtenus via le service.');
        $html .= self::paragraph('L’accès à une ordonnance ou à un document mis à disposition peut être limité dans le temps pour des raisons de sécurité, d’archivage, de fermeture de compte ou d’organisation technique. Le patient est donc invité à conserver sans délai les documents qui lui sont remis.');
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Tarifs, préautorisation et particularité du service</h2>';
        $html .= self::paragraph(esc_html($pricing));
        $html .= self::paragraph(esc_html($paymentSummary));
        $html .= self::definition_list([
            'Prestataire de paiement déclaré' => esc_html($paymentProvider),
            'Régime de paiement' => 'Préautorisation puis capture, annulation ou opération cohérente avec l’issue du dossier',
            'Garantie de prescription' => 'Aucune',
        ]);
        $html .= self::paragraph('Le paiement ne doit pas être compris comme l’achat automatique d’un médicament, d’une ordonnance ou d’un résultat médical déterminé. Il rémunère l’accès au parcours et au traitement du dossier dans le cadre défini par le service.');
        $html .= self::paragraph('Le service relève d’un cadre de santé privé et ne doit pas être lu comme un site de e-commerce standard. Les blocs génériques de rétractation de quatorze jours ne sont pas activés par défaut pour la partie strictement médicale du service. Une fois l’analyse médicale effectivement commencée, la demande ne peut pas être annulée comme une simple commande de biens ou de services courants.');
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Réclamations, litiges et droit applicable</h2>';
        $html .= self::paragraph(esc_html($disputesSummary));
        $html .= self::paragraph('Toute réclamation non urgente relative au fonctionnement du service, à la facturation, à l’accès aux documents ou à la gestion du dossier peut être adressée à <a href="mailto:' . esc_attr($complaintContact) . '">' . esc_html($complaintContact) . '</a>.');
        $html .= self::paragraph('Le droit applicable est le droit français, sous réserve des règles impératives éventuellement applicables. Rien dans la présente page n’a pour effet d’écarter une responsabilité qui ne pourrait être légalement exclue.');
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
        $processors = self::safe_or_default((string) ($registry['processor_summary'] ?? ''), 'Le site public WordPress est hébergé chez Hostinger. L’exécution métier sensible est opérée sur Scalingo France. Le stockage objet est assuré sur AWS Paris. Les opérations de paiement sont réalisées via Stripe. D’autres prestataires techniques peuvent intervenir pour l’email, la protection antispam/captcha et, si activée, l’assistance documentaire.');
        $aiSummary = self::safe_or_default((string) ($registry['ai_summary'] ?? ''), 'Une assistance algorithmique peut être utilisée pour la reconnaissance de justificatifs ou l’aide à la lecture de documents transmis. Elle n’emporte pas de décision médicale automatisée. La décision finale reste humaine et médicale.');
        $workerRuntime = self::safe_or_default((string) ($registry['worker_runtime'] ?? ''), 'Scalingo France');
        $objectStorage = self::safe_or_default((string) ($registry['object_storage'] ?? ''), 'AWS Paris');
        $paymentProvider = self::safe_or_default((string) ($registry['payment_provider'] ?? ''), 'Stripe');
        $dpoDeclared = !empty($registry['dpo_declared']);
        $dpoIdentity = self::safe_or_default((string) ($registry['dpo_identity'] ?? ''), '');

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
        $html .= self::unordered_list([
            'données d’identification et de contact nécessaires à l’ouverture et au suivi du dossier ;',
            'informations nécessaires à l’instruction d’une demande de continuité thérapeutique, y compris des informations pouvant révéler l’état de santé ;',
            'justificatifs, pièces transmises, échanges et messages liés au dossier ;',
            'informations techniques de sécurité, de journalisation, de prévention des abus et de fonctionnement du parcours ;',
            'informations liées au paiement, sans que SOS Prescription n’ait vocation à stocker lui-même les données complètes de carte bancaire.',
        ]);
        $html .= self::paragraph(esc_html($purposes));
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
        $html .= self::paragraph(esc_html($processors));
        $html .= self::paragraph('Le lecteur est ainsi informé que le site public n’a pas vocation, à lui seul, à constituer le dossier métier autoritatif. Les traitements sensibles sont opérés dans une architecture distincte et publiquement déclarée comme localisée en France pour les traitements concernés.');
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Sécurité, confidentialité et gestion des incidents</h2>';
        $html .= self::paragraph('SOS Prescription met en œuvre des mesures techniques et organisationnelles adaptées à la sensibilité des données traitées et aux risques encourus par les personnes concernées.');
        $html .= self::unordered_list([
            'accès aux données limités aux personnes habilitées et dans la mesure nécessaire à leur mission ;',
            'séparation entre façade publique, traitements métier et composants de stockage ;',
            'journalisation, restrictions d’accès et mécanismes de sécurité adaptés au parcours ;',
            'obligations de confidentialité imposées aux personnes autorisées et aux prestataires intervenant dans leur périmètre.',
        ]);
        $html .= self::paragraph('Si SOS Prescription ou l’un de ses prestataires identifie un incident de sécurité susceptible d’affecter des données personnelles traitées pour le service, l’incident fait l’objet d’une analyse, d’une documentation interne et de mesures de remédiation adaptées. Lorsque la réglementation applicable l’exige, une notification est adressée à l’autorité compétente et, le cas échéant, aux personnes concernées.');
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Conservation, suspension du compte et limites du droit à l’effacement</h2>';
        $html .= self::paragraph('Les données sont conservées pendant la durée nécessaire à la gestion du dossier, à la mise à disposition éventuelle des documents, au traitement des réclamations, à la sécurité du service, à la prévention des abus et au respect des obligations légales, réglementaires ou probatoires applicables.');
        $html .= self::paragraph('Demander l’arrêt du service, la fermeture ou la suspension d’un compte ne signifie pas l’effacement immédiat de toutes les données. Une suspension ou une désactivation du compte peut avoir pour effet de couper l’accès au compte et aux notifications, tout en laissant subsister un archivage sécurisé des éléments qui doivent être conservés.');
        $html .= self::paragraph('Lorsque le dossier contient des informations de santé, des échanges médicaux, des ordonnances, des justificatifs ou des éléments nécessaires à la continuité des soins, à la sécurité du service, au respect d’une obligation légale, à l’intérêt public dans le domaine de la santé ou à la défense de droits en justice, certaines données peuvent être archivées plutôt qu’effacées.');
        $html .= self::paragraph('Seules les données qui ne sont plus nécessaires ou qui peuvent légalement être supprimées peuvent être effacées ou anonymisées selon leur cycle de vie. Les sauvegardes et copies techniques suivent leur propre cycle d’extinction ou de suppression compatible avec les exigences de sécurité et de continuité.');
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Exercice des droits et assistance associée</h2>';
        $html .= self::paragraph('Les demandes relatives aux droits des personnes concernées doivent être adressées à <a href="mailto:' . esc_attr($privacyContact) . '">' . esc_html($privacyContact) . '</a>. Selon les cas et dans les limites prévues par la loi, ces droits peuvent inclure l’accès, la rectification, l’effacement lorsqu’il est applicable, la limitation, l’opposition, la portabilité et le retrait du consentement lorsqu’un traitement repose sur celui-ci.');
        $html .= self::paragraph('SOS Prescription demeure l’interlocuteur principal des personnes concernées pour l’exercice de leurs droits. Lorsque cela est nécessaire, le service peut solliciter l’assistance technique raisonnable de ses prestataires afin d’identifier les données concernées, d’extraire les informations utiles, de rectifier certaines données, de limiter certains traitements ou de supprimer les données lorsque cela est légalement possible.');
        $html .= self::paragraph('Toute personne concernée peut également introduire une réclamation auprès de la CNIL si elle estime que le traitement de ses données personnelles n’est pas conforme à la réglementation applicable.');
        $html .= '</section>';

        $html .= '<section>';
        $html .= '<h2>Assistance algorithmique et absence de décision médicale automatisée</h2>';
        $html .= self::paragraph(esc_html($aiSummary));
        $html .= self::paragraph('L’assistance algorithmique éventuellement utilisée intervient comme outil d’aide au traitement ou à la lecture de certains justificatifs. Elle ne constitue pas une décision médicale automatisée. La décision médicale finale, lorsqu’elle existe, reste prise par un médecin.');
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
                'operator_identity' => "98600 Wallis-et-Futuna, South Pacific
N° CD : 2022.1.2573
N° RCS : 2020 A 0102
Capital social : 3.000.000 XPF
TVA : non applicable / non renseignée à ce stade",
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
                'response_delay' => 'Les demandes sont traitées de manière asynchrone. Les délais peuvent varier selon la complétude du dossier, le volume de demandes et la disponibilité médicale. Des informations complémentaires peuvent être demandées avant toute décision.',
                'payment_summary' => 'La plateforme peut solliciter une préautorisation bancaire via Stripe avant l’analyse médicale du dossier. La capture effective ou l’annulation intervient ensuite selon l’issue du traitement médical. La préautorisation ou le paiement n’emportent jamais, à eux seuls, validation médicale ni délivrance automatique d’une ordonnance.',
                'disputes_summary' => 'Toute réclamation non urgente doit être adressée en priorité au contact indiqué. Les contestations portant sur l’appréciation clinique relèvent du cadre propre au service de santé et de l’indépendance du médecin. Le service ne doit pas être lu comme un site de e-commerce standard pour sa composante strictement médicale.',
                'complaint_contact' => 'contact@sosprescription.fr',
                'dpo_declared' => false,
                'dpo_identity' => '',
                'purposes_summary' => 'Gestion des demandes, analyse du dossier, continuité de traitement, échanges patient-médecin, sécurisation de la plateforme, gestion administrative et financière, prévention des abus, gestion des incidents, exercice des droits et respect des obligations légales.',
                'processor_summary' => 'Le site public WordPress est hébergé chez Hostinger. L’exécution métier sensible est opérée sur Scalingo France. Le stockage objet est assuré sur AWS Paris. Les opérations de paiement sont réalisées via Stripe. D’autres prestataires techniques peuvent intervenir pour l’email, la protection antispam ou captcha et, si activée, l’assistance documentaire.',
                'cookies_list' => "Cookies strictement nécessaires au fonctionnement du site et à la sécurité des sessions
Cookies techniques permettant le maintien du parcours utilisateur et des choix de confidentialité
Traceurs complémentaires uniquement lorsqu’ils sont activés et, le cas échéant, soumis à un mécanisme de consentement",
                'ai_summary' => 'Une assistance algorithmique peut être utilisée pour la reconnaissance de justificatifs ou l’aide à la lecture de documents transmis. Elle intervient comme aide au traitement documentaire et n’emporte pas de décision médicale automatisée. La décision finale reste humaine et médicale.',
                'consent_required' => true,
                'privacy_page_sync' => true,
                'worker_runtime' => 'Scalingo France',
                'object_storage' => 'AWS Paris',
                'payment_provider' => 'Stripe',
            ],
            'mentions' => [
                'page_id' => 0,
                'version' => '1.2.0',
                'effective_date' => $today,
                'updated_at' => $today,
                'sources_public' => [
                    ['label' => 'Digital Pacifika', 'url' => 'https://digitalpacifika.com', 'note' => 'Prestataire et exploitant juridique de travail affiché.'],
                    ['label' => 'Hostinger', 'url' => 'https://www.hostinger.fr/', 'note' => 'Hébergeur déclaré du site public WordPress.'],
                ],
            ],
            'conditions' => [
                'page_id' => 0,
                'version' => '1.2.0',
                'effective_date' => $today,
                'updated_at' => $today,
                'sources_public' => [
                    ['label' => 'Article L221-2 du code de la consommation', 'url' => 'https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000044563156', 'note' => 'Exclusion des services de santé du régime standard des contrats à distance.'],
                    ['label' => 'ameli — Bien lire et utiliser une ordonnance de médicaments', 'url' => 'https://www.ameli.fr/assure/sante/medicaments/utiliser-recycler-medicaments/lire-ordonnance-medicaments', 'note' => 'Repères publics sur l’usage personnel et la validité d’une ordonnance de médicaments.'],
                ],
            ],
            'privacy' => [
                'page_id' => 0,
                'version' => '1.2.0',
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

```
