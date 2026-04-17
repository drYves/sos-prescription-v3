<?php
declare(strict_types=1);

namespace SosPrescription\Services;

use WP_Post;
use WP_Error;

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
                'label' => 'Conditions du service',
                'title' => 'Conditions du service',
                'slug' => 'conditions-du-service',
                'shortcode_tag' => 'sosprescription_legal_cgu',
                'shortcode' => '[sosprescription_legal_cgu]',
            ],
            'privacy' => [
                'label' => 'Politique de confidentialité',
                'title' => 'Politique de confidentialité',
                'slug' => 'politique-de-confidentialite',
                'shortcode_tag' => 'sosprescription_legal_privacy',
                'shortcode' => '[sosprescription_legal_privacy]',
            ],
        ];
    }

    /**
     * @return array<string, mixed>
     */
    public static function registry(): array
    {
        return [
            'brand_name' => 'SOS Prescription',
            'brand_registration_number' => '5002143',
            'brand_registration_date' => '2023-10-29',
            'site_url' => 'https://sosprescription.fr',

            'operator_name' => 'Digital Pacifika',
            'operator_address' => '98600 Wallis-et-Futuna, South Pacific',
            'operator_cd' => '2022.1.2573',
            'operator_rcs' => '2020 A 0102',
            'operator_capital' => '3.000.000 XPF',
            'operator_vat' => 'non applicable / non renseignée à ce stade',

            'publication_director' => '[À confirmer avant publication]',
            'publication_director_title' => '[À confirmer si nécessaire]',
            'main_contact_email' => '[À confirmer avant publication]',
            'main_contact_phone' => '[Non renseigné]',
            'privacy_contact_email' => '[À confirmer avant publication]',
            'complaint_contact' => '[À confirmer avant publication]',

            'doctor_enabled' => '1',
            'doctor_name' => 'Dr Yves Burckel',
            'doctor_title' => 'Médecin urgentiste',
            'doctor_rpps' => '10000554302',

            'public_host_name' => 'Hostinger',
            'public_host_offer' => 'Cloud Startup',
            'public_host_contact' => '[À confirmer avant publication]',
            'technical_maintainer_name' => 'Digital Pacifika',
            'technical_maintainer_url' => 'https://digitalpacifika.com',
            'technical_maintainer_address' => '98600 Wallis-et-Futuna, South Pacific',

            'worker_runtime' => 'Scalingo France',
            'object_storage' => 'AWS Paris',
            'payment_provider' => 'Stripe',
            'ai_provider' => '[À confirmer avant publication]',
            'payment_amount' => '[À confirmer avant publication]',
            'payment_currency' => 'EUR',
            'payment_tax_note' => '[À confirmer selon régime]',
        ];
    }

    /**
     * @return array<string, mixed>
     */
    public static function get_state(): array
    {
        $raw = get_option(self::OPTION_KEY, null);
        $state = is_array($raw) ? $raw : [];
        $today = current_time('Y-m-d');
        if (!is_string($today) || trim($today) === '') {
            $today = gmdate('Y-m-d');
        }

        $defaults = [
            'updated_at' => '',
            'mentions' => [
                'page_id' => 0,
                'version' => '1.0.0',
                'effective_date' => $today,
                'updated_at' => $today,
            ],
            'conditions' => [
                'page_id' => 0,
                'version' => '1.0.0',
                'effective_date' => $today,
                'updated_at' => $today,
            ],
            'privacy' => [
                'page_id' => 0,
                'version' => '1.0.0',
                'effective_date' => $today,
                'updated_at' => $today,
            ],
        ];

        $state = array_merge($defaults, $state);

        foreach (array_keys(self::slots()) as $slot) {
            $slotState = isset($state[$slot]) && is_array($state[$slot]) ? $state[$slot] : [];
            $slotState = array_merge($defaults[$slot], $slotState);
            $slotState['page_id'] = max(0, (int) ($slotState['page_id'] ?? 0));
            $slotState['version'] = is_string($slotState['version']) && trim($slotState['version']) !== '' ? trim((string) $slotState['version']) : '1.0.0';
            $slotState['effective_date'] = self::normalize_date_string((string) ($slotState['effective_date'] ?? $today), $today);
            $slotState['updated_at'] = self::normalize_date_string((string) ($slotState['updated_at'] ?? $today), $slotState['effective_date']);
            $state[$slot] = $slotState;
        }

        $state['updated_at'] = is_string($state['updated_at']) ? trim((string) $state['updated_at']) : '';

        return $state;
    }

    /**
     * @param array<string, mixed> $state
     */
    public static function update_state(array $state): void
    {
        $current = self::get_state();
        $next = array_merge($current, $state);
        $next['updated_at'] = current_time('mysql');
        update_option(self::OPTION_KEY, $next, false);
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
            $configuredPageId = isset($state[$slot]['page_id']) ? (int) $state[$slot]['page_id'] : 0;
            $configuredPost = $configuredPageId > 0 ? get_post($configuredPageId) : null;
            $slugPost = self::get_page_by_slug($slug);

            $statusKey = 'missing';
            $statusLabel = 'Manquante';
            $details = 'Aucune page publique liée n’a été détectée.';
            $page = null;
            $source = 'missing';
            $valid = false;

            if ($slugPost instanceof WP_Post) {
                $page = $slugPost;
                $source = 'slug';
                if (self::page_has_shortcode($slugPost, $shortcodeTag)) {
                    $statusKey = 'exists';
                    $statusLabel = 'Existe';
                    $details = 'Page publique canonique détectée et shortcode conforme.';
                    $valid = true;
                } else {
                    $statusKey = 'slug_conflict';
                    $statusLabel = 'Existe';
                    $details = 'Le slug canonique existe déjà, mais le shortcode attendu est absent.';
                }
            }

            if (!$valid && $configuredPost instanceof WP_Post) {
                $page = $configuredPost;
                $source = 'binding';
                if ((string) $configuredPost->post_name !== $slug) {
                    $statusKey = 'incorrect_slug';
                    $statusLabel = 'Existe';
                    $details = 'Une page liée existe, mais son slug ne correspond pas au slug canonique attendu.';
                } elseif (self::page_has_shortcode($configuredPost, $shortcodeTag)) {
                    $statusKey = 'exists';
                    $statusLabel = 'Existe';
                    $details = 'Page liée détectée et shortcode conforme.';
                    $valid = true;
                } else {
                    $statusKey = 'incorrect_shortcode';
                    $statusLabel = 'Existe';
                    $details = 'La page liée existe, mais le shortcode attendu est absent du contenu.';
                }
            }

            $rows[$slot] = [
                'slot' => $slot,
                'label' => (string) $def['label'],
                'title' => (string) $def['title'],
                'slug' => $slug,
                'shortcode_tag' => $shortcodeTag,
                'shortcode' => (string) $def['shortcode'],
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
                'effective_date' => (string) ($state[$slot]['effective_date'] ?? ''),
                'updated_at' => (string) ($state[$slot]['updated_at'] ?? ''),
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
        $bound = [];
        $errors = [];
        $touchedSlots = [];
        $today = current_time('Y-m-d');
        if (!is_string($today) || trim($today) === '') {
            $today = gmdate('Y-m-d');
        }

        foreach (self::slots() as $slot => $def) {
            $binding = $bindings[$slot] ?? null;
            if (!is_array($binding)) {
                $errors[] = sprintf('Impossible de résoudre le binding pour « %s ».', (string) $def['title']);
                continue;
            }

            if (!empty($binding['valid']) && (int) ($binding['page_id'] ?? 0) > 0) {
                $pageId = (int) $binding['page_id'];
                if ((int) ($state[$slot]['page_id'] ?? 0) !== $pageId) {
                    $state[$slot]['page_id'] = $pageId;
                    $touchedSlots[] = $slot;
                }
                $bound[$slot] = $pageId;
                continue;
            }

            if ((string) ($binding['status_key'] ?? '') !== 'missing') {
                $errors[] = sprintf(
                    'Le document « %s » n’a pas été généré automatiquement : %s',
                    (string) $def['title'],
                    (string) ($binding['details'] ?? 'état non résolu')
                );
                continue;
            }

            $newId = wp_insert_post([
                'post_type' => 'page',
                'post_status' => 'publish',
                'post_title' => (string) $def['title'],
                'post_content' => (string) $def['shortcode'],
                'post_name' => (string) $def['slug'],
            ], true);

            if ($newId instanceof WP_Error) {
                $errors[] = sprintf(
                    'Création impossible pour « %s » : %s',
                    (string) $def['title'],
                    $newId->get_error_message()
                );
                continue;
            }

            $state[$slot]['page_id'] = (int) $newId;
            $state[$slot]['effective_date'] = self::normalize_date_string((string) ($state[$slot]['effective_date'] ?? ''), $today);
            $state[$slot]['updated_at'] = $today;
            $created[$slot] = (int) $newId;
            $bound[$slot] = (int) $newId;
            $touchedSlots[] = $slot;
        }

        if (!empty($touchedSlots)) {
            self::update_state($state);
        }

        $bindingsAfter = self::get_dashboard_bindings();
        self::sync_compatibility($bindingsAfter, $state, $touchedSlots, $created);

        return [
            'created' => $created,
            'bound' => $bound,
            'errors' => $errors,
            'bindings' => $bindingsAfter,
        ];
    }

    /**
     * @param array<string, array<string, mixed>> $bindings
     * @param array<string, mixed> $state
     * @param array<int, string> $touchedSlots
     * @param array<string, int> $createdSlots
     */
    private static function sync_compatibility(array $bindings, array $state, array $touchedSlots, array $createdSlots): void
    {
        $compliancePatch = [];

        foreach (['conditions' => ['url' => 'cgu_url', 'version' => 'cgu_version'], 'privacy' => ['url' => 'privacy_url', 'version' => 'privacy_version']] as $slot => $compat) {
            $binding = $bindings[$slot] ?? null;
            if (!is_array($binding) || empty($binding['valid']) || (int) ($binding['page_id'] ?? 0) <= 0) {
                continue;
            }

            $pageId = (int) $binding['page_id'];
            $permalink = (string) get_permalink($pageId);
            if ($permalink === '') {
                continue;
            }

            $currentCompliance = ComplianceConfig::get();
            $currentVersion = isset($currentCompliance[$compat['version']]) ? (string) $currentCompliance[$compat['version']] : '';
            $slotVersion = isset($state[$slot]['version']) ? (string) $state[$slot]['version'] : '1.0.0';

            if (in_array($slot, $touchedSlots, true) || array_key_exists($slot, $createdSlots)) {
                $slotVersion = $currentVersion !== '' ? self::bump_version($currentVersion) : $slotVersion;
                $state[$slot]['version'] = $slotVersion;
                $state[$slot]['updated_at'] = current_time('Y-m-d');
            }

            $compliancePatch[$compat['url']] = $permalink;
            $compliancePatch[$compat['version']] = $slotVersion;
        }

        if (!empty($compliancePatch)) {
            ComplianceConfig::update($compliancePatch);
        }

        if (!empty($touchedSlots)) {
            self::update_state($state);
        }

        $privacyBinding = $bindings['privacy'] ?? null;
        if (is_array($privacyBinding) && !empty($privacyBinding['valid']) && (int) ($privacyBinding['page_id'] ?? 0) > 0) {
            update_option('wp_page_for_privacy_policy', (int) $privacyBinding['page_id'], false);
        }
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
        return self::render_cookies_fragment(true);
    }

    /**
     * @param array<string, mixed> $state
     */
    private static function render_mentions(array $state): string
    {
        $registry = self::registry();
        $meta = self::render_meta_block('mentions', $state, 'Document d’information juridique', 'Les informations ci-dessous constituent la base éditoriale V7.1 du générateur de pages légales SOS Prescription.');
        $links = self::render_internal_links([
            [self::page_url('conditions'), 'Consulter les conditions du service'],
            [self::page_url('privacy'), 'Consulter la politique de confidentialité'],
        ]);

        $html = '<div class="sp-legal-document sp-legal-document--mentions">';
        $html .= $meta;
        $html .= self::paragraph('Le présent site internet et le service SOS Prescription sont exploités dans le cadre décrit ci-dessous. Les présentes mentions permettent d’identifier l’exploitant, les responsables de publication ainsi que les intervenants techniques déclarés.');

        $html .= '<h2>Exploitant du site et du service</h2>';
        $html .= self::definition_list([
            'Dénomination' => (string) $registry['operator_name'],
            'Adresse' => (string) $registry['operator_address'],
            'N° CD' => (string) $registry['operator_cd'],
            'N° RCS' => (string) $registry['operator_rcs'],
            'Capital social' => (string) $registry['operator_capital'],
            'TVA' => (string) $registry['operator_vat'],
            'Site principal' => '<a href="' . esc_url((string) $registry['site_url']) . '" target="_blank" rel="noopener noreferrer">' . esc_html((string) $registry['site_url']) . '</a>',
        ]);
        $html .= self::paragraph('Digital Pacifika est retenu comme exploitant juridique de travail du site et du service, sauf validation contraire ultérieure.');

        $html .= '<h2>Contact</h2>';
        $html .= self::definition_list([
            'Email principal' => self::escape_or_placeholder((string) $registry['main_contact_email']),
            'Téléphone' => self::escape_or_placeholder((string) $registry['main_contact_phone']),
            'Adresse de contact' => esc_html((string) $registry['operator_address']),
        ]);
        $html .= self::paragraph('Les coordonnées ci-dessus doivent être relues avant publication définitive si un placeholder bloquant est encore affiché.');

        $html .= '<h2>Publication</h2>';
        $html .= self::definition_list([
            'Directeur de la publication' => self::escape_or_placeholder((string) $registry['publication_director']),
            'Qualité' => self::escape_or_placeholder((string) $registry['publication_director_title']),
        ]);
        $html .= self::paragraph('Le directeur de la publication et, le cas échéant, le responsable éditorial distinct doivent être confirmés avant publication définitive.');

        $html .= '<h2>Hébergement du site public</h2>';
        $html .= self::definition_list([
            'Hébergeur' => esc_html((string) $registry['public_host_name']),
            'Offre' => esc_html((string) $registry['public_host_offer']),
            'Coordonnées déclarées' => self::escape_or_placeholder((string) $registry['public_host_contact']),
        ]);
        $html .= self::paragraph('Le site public WordPress constitue la façade applicative visible du service. Les traitements métier sensibles et les données de santé ne doivent pas être confondus avec le seul hébergement du site public.');

        $html .= '<h2>Maintenance technique</h2>';
        $html .= self::definition_list([
            'Prestataire' => esc_html((string) $registry['technical_maintainer_name']),
            'Site' => '<a href="' . esc_url((string) $registry['technical_maintainer_url']) . '" target="_blank" rel="noopener noreferrer">' . esc_html((string) $registry['technical_maintainer_url']) . '</a>',
            'Adresse' => esc_html((string) $registry['technical_maintainer_address']),
        ]);
        $html .= self::paragraph('La maintenance technique du site est assurée par le prestataire ci-dessus. Cette maintenance ne préjuge ni du rôle du médecin, ni du traitement des données de santé dans le périmètre métier séparé.');

        if ((string) $registry['doctor_enabled'] === '1') {
            $html .= '<h2>Activité réglementée et médecin référent</h2>';
            $html .= self::paragraph('Le service permet au patient de solliciter une analyse médicale asynchrone dans un cadre de continuité thérapeutique. La décision finale, lorsqu’elle intervient, relève d’un médecin et ne constitue jamais une décision automatisée.');
            $html .= self::definition_list([
                'Médecin référent de travail' => esc_html((string) $registry['doctor_name']),
                'Qualité' => esc_html((string) $registry['doctor_title']),
                'RPPS' => esc_html((string) $registry['doctor_rpps']),
            ]);
            $html .= self::paragraph('La mention de ce médecin référent reste une donnée de travail activable ; elle ne crée pas à elle seule une promesse de prise en charge ni une garantie de prescription.');
        }

        $html .= '<h2>Marque et propriété intellectuelle</h2>';
        $html .= self::definition_list([
            'Marque' => esc_html((string) $registry['brand_name']),
            'N° de dépôt' => esc_html((string) $registry['brand_registration_number']),
            'Date de dépôt' => esc_html(self::format_date((string) $registry['brand_registration_date'])),
        ]);
        $html .= self::paragraph('La marque SOS Prescription et les éléments du site sont protégés dans les conditions prévues par les textes applicables. Toute reproduction, représentation, adaptation ou extraction substantielle non autorisée est interdite.');

        $html .= '<h2>Liens utiles</h2>';
        $html .= self::paragraph('Pour comprendre le cadre du service, le traitement des données personnelles, les données de santé, l’hébergement et les cookies, consultez également les pages suivantes :');
        $html .= $links;

        $html .= '<h2>Sources publiques</h2>';
        $html .= self::source_list([
            ['label' => 'Service-Public.fr', 'url' => 'https://www.service-public.fr/', 'note' => 'Informations générales sur les obligations d’information des sites professionnels.'],
            ['label' => 'Légifrance', 'url' => 'https://www.legifrance.gouv.fr/', 'note' => 'Référentiel officiel des textes applicables.'],
            ['label' => 'Hostinger', 'url' => 'https://www.hostinger.fr/', 'note' => 'Hébergeur déclaré pour la façade WordPress.'],
            ['label' => 'Digital Pacifika', 'url' => 'https://digitalpacifika.com', 'note' => 'Prestataire déclaré pour la maintenance technique.'],
        ]);

        $html .= '</div>';
        return $html;
    }

    /**
     * @param array<string, mixed> $state
     */
    private static function render_conditions(array $state): string
    {
        $registry = self::registry();
        $meta = self::render_meta_block('conditions', $state, 'Service privé · non urgent · continuité de traitement', 'Les présentes conditions encadrent le fonctionnement du service, le rôle du médecin, les situations exclues, les tarifs et le mécanisme de paiement.');

        $html = '<div class="sp-legal-document sp-legal-document--conditions">';
        $html .= $meta;
        $html .= self::paragraph('SOS Prescription est un service privé, non urgent et asynchrone, destiné à la continuité de traitement. La transmission d’une demande n’emporte aucune garantie de délivrance d’ordonnance. La décision finale relève d’un médecin.');
        $html .= self::paragraph('Le parcours financier repose sur un mécanisme de préautorisation avant décision, puis de capture ou d’annulation selon l’issue du dossier. Le paiement ne doit pas être présenté comme l’achat standard d’un produit grand public.');

        $html .= '<h2>Objet et périmètre du service</h2>';
        $html .= self::paragraph('Le service permet au patient de soumettre une demande dans un cadre de continuité thérapeutique. Il ne constitue pas un service d’urgence, ne remplace pas la prise en charge d’une situation aiguë et ne doit pas être utilisé lorsqu’une consultation immédiate, un appel au SAMU ou une orientation en structure d’urgence est nécessaire.');
        $html .= self::paragraph('Le service repose sur une analyse médicale asynchrone. Les informations et justificatifs transmis sont examinés selon le dossier, sans garantie de délai immédiat ni de réponse favorable.');

        $html .= '<h2>Éligibilité et exclusions</h2>';
        $html .= self::unordered_list([
            '<strong>Admis — continuité de traitement :</strong> demandes s’inscrivant dans un besoin de relais thérapeutique ou de continuité de traitement, lorsque le dossier transmis est suffisamment documenté.',
            '<strong>Admis — cadre privé :</strong> service privé hors urgence, avec analyse asynchrone et décision médicale humaine.',
            '<strong>Alerte — dossier incomplet :</strong> un justificatif insuffisant, incohérent ou inexploitable peut conduire à une absence de suite favorable.',
            '<strong>Exclu — urgence :</strong> toute situation laissant penser à une urgence vitale, une détresse respiratoire, une douleur thoracique, un trouble neurologique aigu, un risque suicidaire ou toute situation nécessitant une prise en charge immédiate.',
            '<strong>Exclu — hors périmètre :</strong> demandes incompatibles avec la continuité thérapeutique, avec le cadre privé du service, ou ne permettant pas une évaluation médicale prudente.',
        ]);

        $html .= '<h2>Déroulé du service</h2>';
        $html .= self::ordered_list([
            'Le patient soumet sa demande et transmet les informations et justificatifs nécessaires via la façade WordPress sécurisée.',
            'Le mécanisme de paiement effectue, le cas échéant, une préautorisation du montant annoncé, sans débit immédiat.',
            'Le dossier est transmis dans le périmètre métier séparé pour analyse médicale asynchrone.',
            'Le médecin apprécie le dossier de manière indépendante et décide s’il y a lieu de délivrer une ordonnance de relais.',
            'Selon l’issue du dossier, les fonds peuvent être capturés, ne pas être capturés ou faire l’objet du traitement correspondant au scénario de paiement retenu.',
        ]);

        $html .= '<h2>Rôle du médecin et absence de garantie de prescription</h2>';
        $html .= self::paragraph('La décision finale relève d’un médecin. Aucune ordonnance n’est garantie. L’utilisation du service, le dépôt d’un dossier ou la préautorisation d’un paiement ne valent jamais promesse de délivrance.');
        $html .= self::paragraph('Lorsque le bloc médecin référent est activé, le médecin de travail mentionné à titre informatif est ' . esc_html((string) $registry['doctor_name']) . ', ' . esc_html((string) $registry['doctor_title']) . ', RPPS ' . esc_html((string) $registry['doctor_rpps']) . '. Cette mention informative ne retire rien à l’indépendance de la décision médicale.');

        $html .= '<h2>Tarifs, paiement et préautorisation</h2>';
        $html .= self::definition_list([
            'Prestataire de paiement' => esc_html((string) $registry['payment_provider']),
            'Libellé tarifaire' => 'Montant de la demande',
            'Montant' => self::escape_or_placeholder((string) $registry['payment_amount']) . ' ' . esc_html((string) $registry['payment_currency']),
            'Mention fiscale' => self::escape_or_placeholder((string) $registry['payment_tax_note']),
        ]);
        $html .= self::paragraph('La préautorisation permet de réserver le montant sans le débiter immédiatement. La capture intervient seulement dans le scénario prévu par le service après décision favorable. En cas de non-rétention de la délivrance, le montant ne doit pas être présenté comme un achat standard automatiquement consommé.');
        $html .= self::paragraph('Le paiement repose sur un mécanisme de préautorisation avant décision, puis de capture ou d’annulation selon l’issue du dossier. Le patient doit vérifier auprès de son établissement bancaire les effets pratiques d’une préautorisation selon sa carte et son compte.');

        $html .= '<h2>Régime contractuel et présentation prudente du service</h2>';
        $html .= self::paragraph('Le service est conçu comme un service privé de santé relevant d’un cadre contractuel spécifique. Il ne doit pas être présenté comme un achat standard de produit ou de service grand public, notamment pour la partie strictement médicale.');
        $html .= self::paragraph('Aucune clause de rétractation de type e-commerce ou de médiation de consommation générique n’est affichée par défaut dans la présente version éditoriale tant que la qualification exacte des composantes accessoires n’a pas été confirmée.');

        $html .= '<h2>Obligations de l’utilisateur</h2>';
        $html .= self::unordered_list([
            'Transmettre des informations sincères, complètes et compréhensibles.',
            'Ne pas utiliser le service en cas d’urgence ou pour contourner une prise en charge médicale immédiate nécessaire.',
            'Ne pas transmettre des documents faux, altérés ou appartenant à un tiers sans droit ni autorisation.',
            'Respecter les instructions, limites et exclusions de périmètre rappelées sur le site et dans le parcours de demande.',
        ]);

        $html .= '<h2>Réclamations, litiges et mise à jour des conditions</h2>';
        $html .= self::definition_list([
            'Contact réclamations' => self::escape_or_placeholder((string) $registry['complaint_contact']),
        ]);
        $html .= self::paragraph('Toute réclamation doit être adressée en premier lieu au contact indiqué ci-dessus. Les présentes conditions peuvent être mises à jour ; la version applicable est celle affichée avec sa date d’effet.');
        $html .= self::paragraph('Pour les éléments relatifs aux données personnelles, aux données de santé, à l’hébergement et aux cookies, la page de politique de confidentialité doit être consultée conjointement aux présentes conditions.');

        $html .= '<h2>Sources publiques</h2>';
        $html .= self::source_list([
            ['label' => 'Légifrance', 'url' => 'https://www.legifrance.gouv.fr/', 'note' => 'Référentiel officiel des textes applicables au service et à la consommation.'],
            ['label' => 'Service-Public.fr', 'url' => 'https://www.service-public.fr/', 'note' => 'Informations générales sur les obligations d’information précontractuelle.'],
            ['label' => 'Stripe', 'url' => 'https://stripe.com/fr', 'note' => 'Prestataire de paiement déclaré pour la préautorisation et la capture.'],
            ['label' => 'Mentions légales', 'url' => self::page_url('mentions'), 'note' => 'Page d’identification de l’exploitant et des intervenants déclarés.'],
            ['label' => 'Politique de confidentialité', 'url' => self::page_url('privacy'), 'note' => 'Page détaillant les données personnelles, les données de santé, l’hébergement et les cookies.'],
        ]);

        $html .= '</div>';
        return $html;
    }

    /**
     * @param array<string, mixed> $state
     */
    private static function render_privacy(array $state): string
    {
        $registry = self::registry();
        $meta = self::render_meta_block('privacy', $state, 'Données personnelles · données de santé · hébergement · cookies', 'La présente politique décrit le traitement des données personnelles, y compris les données relatives à la santé, dans le cadre du service SOS Prescription.');

        $html = '<div class="sp-legal-document sp-legal-document--privacy">';
        $html .= $meta;
        $html .= self::paragraph('Cette page explique comment SOS Prescription traite les données personnelles, y compris les données relatives à la santé, dans le cadre du service. Le site public WordPress agit comme une façade applicative ; les traitements sensibles sont opérés dans un périmètre séparé.');
        $html .= self::unordered_list([
            '<strong>Qui traite vos données&nbsp;?</strong> Digital Pacifika est retenu comme exploitant de travail du service ; le point de contact confidentialité est distinct du contact marketing ou support général.',
            '<strong>Quelles données&nbsp;?</strong> Données d’identité, de contact, données nécessaires à la demande, justificatifs transmis, informations de paiement et journaux techniques.',
            '<strong>Pourquoi&nbsp;?</strong> Instruire la demande, sécuriser le parcours, permettre l’analyse médicale et gérer la relation opérationnelle.',
            '<strong>Où&nbsp;?</strong> Le site public est hébergé chez Hostinger ; les traitements sensibles sont opérés en France avec ' . esc_html((string) $registry['worker_runtime']) . ' et ' . esc_html((string) $registry['object_storage']) . '.',
            '<strong>Combien de temps&nbsp;?</strong> Les durées dépendent des catégories de données et doivent être relues juridiquement avant publication définitive si un placeholder reste affiché.',
            '<strong>Quels droits&nbsp;?</strong> Vous pouvez exercer vos droits via le contact confidentialité indiqué ci-dessous et, si nécessaire, saisir la CNIL.',
        ]);

        $html .= '<h2>Responsable du traitement et point de contact confidentialité</h2>';
        $html .= self::definition_list([
            'Responsable de travail' => esc_html((string) $registry['operator_name']),
            'Adresse' => esc_html((string) $registry['operator_address']),
            'Contact données personnelles' => self::escape_or_placeholder((string) $registry['privacy_contact_email']),
        ]);
        $html .= self::paragraph('Aucun DPO formel n’est affiché par défaut dans cette version tant que cette fonction n’a pas été juridiquement et organisationnellement formalisée.');

        $html .= '<h2>Catégories de données traitées</h2>';
        $html .= self::unordered_list([
            '<strong>Données d’identité et de contact :</strong> nom, prénom, coordonnées de contact et éléments nécessaires à l’ouverture du dossier.',
            '<strong>Données relatives à la demande :</strong> informations communiquées par le patient pour permettre l’analyse de la situation et la continuité thérapeutique.',
            '<strong>Données relatives à la santé :</strong> justificatifs, documents et éléments nécessaires à l’instruction médicale de la demande.',
            '<strong>Données de paiement :</strong> informations de préautorisation et références techniques utiles à la gestion du parcours de paiement, sans stockage de la carte dans WordPress.',
            '<strong>Données techniques et de sécurité :</strong> journaux, traces, identifiants techniques, éléments nécessaires à la prévention des abus et à la sécurité du service.',
        ]);

        $html .= '<h2>Finalités et bases générales de traitement</h2>';
        $html .= self::unordered_list([
            '<strong>Instruction et suivi de la demande :</strong> permettre la réception, l’analyse et le suivi de la demande dans le cadre du service privé.',
            '<strong>Organisation du parcours patient :</strong> assurer les échanges, notifications, statuts et accès au dossier lorsque cela est nécessaire au fonctionnement du service.',
            '<strong>Sécurisation du service :</strong> prévenir les abus, sécuriser les accès, tracer les actions sensibles et protéger l’intégrité des traitements.',
            '<strong>Gestion du paiement :</strong> préparer, sécuriser et traiter le mécanisme de préautorisation puis, selon l’issue du dossier, la capture ou l’absence de capture correspondante.',
            '<strong>Traceurs non exemptés :</strong> lorsqu’ils existent, les cookies ou traceurs non strictement nécessaires reposent sur le consentement de l’utilisateur.',
        ]);
        $html .= self::paragraph('Les données relatives à la santé ne sont traitées que dans la mesure strictement nécessaire à l’instruction du dossier dans le cadre applicable aux traitements de santé concernés.');

        $html .= '<h2>Caractère obligatoire ou facultatif des données</h2>';
        $html .= self::unordered_list([
            '<strong>Obligatoire :</strong> certaines données sont nécessaires pour recevoir la demande, identifier le dossier, joindre le patient et permettre une analyse médicale prudente.',
            '<strong>Facultatif ou contextuel :</strong> certaines informations complémentaires peuvent être fournies pour améliorer la compréhension du dossier, sans être toujours requises.',
            '<strong>Conséquence d’une absence :</strong> un dossier incomplet, illisible ou incohérent peut empêcher la poursuite du traitement ou conduire à une absence de suite favorable.',
        ]);

        $html .= '<h2>Destinataires, sous-traitants et localisation</h2>';
        $html .= self::definition_list([
            'Façade applicative publique' => esc_html((string) $registry['public_host_name']) . ' — ' . esc_html((string) $registry['public_host_offer']),
            'Exécution métier' => esc_html((string) $registry['worker_runtime']),
            'Stockage objet' => esc_html((string) $registry['object_storage']),
            'Paiement' => esc_html((string) $registry['payment_provider']),
            'Prestataire email' => '[À confirmer avant publication]',
            'Prestataire antispam / captcha' => '[À confirmer avant publication]',
        ]);
        $html .= self::paragraph('Le site public WordPress sert de façade applicative. Les traitements métier sensibles sont opérés dans un worker séparé. Les données sensibles sont déclarées comme hébergées en France dans le cadre de l’architecture de travail retenue.');

        $html .= '<h2>Mesures générales de sécurité et architecture</h2>';
        $html .= self::unordered_list([
            '<strong>Séparation stricte des couches :</strong> WordPress agit comme façade et n’a pas vocation à redevenir la source de vérité des données métier sensibles.',
            '<strong>Accès restreints :</strong> les accès applicatifs et d’administration sont limités aux personnes habilitées selon leur rôle.',
            '<strong>Traçabilité :</strong> des journaux techniques et d’audit sont conservés dans les limites prévues par la configuration et les exigences applicables.',
            '<strong>Protection des artefacts :</strong> les pièces et documents sont gérés via des mécanismes d’accès restreint et de liens temporaires lorsque cela est applicable.',
        ]);
        $html .= self::paragraph('Cette présentation est volontairement publique et prudente. Elle ne décrit ni secrets techniques, ni mécanismes de sécurité détaillés susceptibles de fragiliser le service.');

        $html .= '<h2>Durées de conservation</h2>';
        $html .= self::definition_list([
            'Dossier de demande' => '[À confirmer juridiquement] à compter de la clôture du dossier',
            'Justificatifs et pièces associées' => '[À confirmer juridiquement] selon la nature de la pièce et le dossier concerné',
            'Journaux techniques et d’audit' => '[À confirmer juridiquement] selon les obligations de traçabilité et de sécurité',
            'Éléments de paiement' => '[À confirmer juridiquement] selon le scénario de traitement et les obligations associées',
        ]);
        $html .= self::paragraph('Tant qu’un placeholder bloquant subsiste dans cette section, une validation humaine doit intervenir avant publication définitive en environnement public.');

        $html .= '<h2>Vos droits</h2>';
        $html .= self::paragraph('Vous pouvez demander l’accès à vos données, leur rectification, leur effacement lorsque cela est applicable, la limitation de certains traitements ou l’exercice de tout autre droit prévu par le cadre applicable. Les demandes doivent être adressées via le contact confidentialité indiqué sur cette page.');
        $html .= self::paragraph('Vous pouvez également introduire une réclamation auprès de la CNIL si vous estimez que vos droits ne sont pas respectés.');

        $html .= '<h2>Assistance algorithmique et absence de décision médicale automatisée</h2>';
        $html .= self::paragraph('Une assistance algorithmique peut être utilisée pour aider à la lecture, à l’extraction ou à la reconnaissance de justificatifs transmis. Elle n’émet pas seule de décision médicale. La décision finale reste humaine et médicale.');
        $html .= self::definition_list([
            'Fournisseur principal déclaré' => self::escape_or_placeholder((string) $registry['ai_provider']),
            'Usages déclarés' => 'Aide à la lecture, extraction et reconnaissance de justificatifs ou de documents transmis.',
            'Décision médicale automatisée' => 'Non',
        ]);

        $html .= self::render_cookies_fragment(false);

        $html .= '<h2>Sources publiques</h2>';
        $html .= self::source_list([
            ['label' => 'CNIL', 'url' => 'https://www.cnil.fr/', 'note' => 'Référentiel public de protection des données personnelles et cookies.'],
            ['label' => 'Agence du Numérique en Santé', 'url' => 'https://esante.gouv.fr/', 'note' => 'Référentiel public sur le cadre HDS et l’écosystème numérique en santé.'],
            ['label' => 'Hostinger', 'url' => 'https://www.hostinger.fr/', 'note' => 'Hébergeur déclaré pour le site public WordPress.'],
            ['label' => 'Scalingo', 'url' => 'https://scalingo.com/fr', 'note' => 'Périmètre d’exécution métier déclaré.'],
            ['label' => 'AWS Paris', 'url' => 'https://aws.amazon.com/fr/local/paris/', 'note' => 'Région d’hébergement déclarée pour le stockage objet.'],
            ['label' => 'Stripe', 'url' => 'https://stripe.com/fr', 'note' => 'Prestataire de paiement déclaré.'],
        ]);

        $html .= '</div>';
        return $html;
    }

    private static function render_cookies_fragment(bool $standalone): string
    {
        $html = $standalone ? '<div class="sp-legal-document sp-legal-document--cookies">' : '';

        if ($standalone) {
            $html .= self::paragraph('Le présent bloc cookies constitue un fragment réutilisable du générateur légal V7.1. En V1, il est destiné à être embarqué dans la politique de confidentialité et peut être appelé séparément à des fins d’intégration.');
        }

        $html .= '<h2>Cookies et autres traceurs</h2>';
        $html .= self::paragraph('Le site peut utiliser des cookies ou autres traceurs strictement nécessaires à son fonctionnement, à la sécurité du parcours et, le cas échéant, des traceurs supplémentaires soumis au consentement lorsque la configuration technique du site le requiert.');
        $html .= self::unordered_list([
            '<strong>Traceurs strictement nécessaires :</strong> fonctionnement technique du site, sécurisation de session, prévention des abus et maintien du parcours utilisateur.',
            '<strong>Traceurs de mesure ou confort :</strong> à n’activer que si leur qualification et leur régime ont été vérifiés.',
            '<strong>Traceurs soumis au consentement :</strong> à n’activer que via un mécanisme de préférences conforme lorsque des traceurs non exemptés sont effectivement utilisés.',
        ]);
        $html .= self::paragraph('Lorsque des traceurs non strictement nécessaires sont activés, un centre de préférences doit permettre à l’utilisateur de choisir ses préférences. Tant que ce centre n’est pas raccordé techniquement, aucune promesse fonctionnelle supplémentaire ne doit être affichée.');

        if ($standalone) {
            $html .= '<h2>Sources publiques</h2>';
            $html .= self::source_list([
                ['label' => 'CNIL', 'url' => 'https://www.cnil.fr/', 'note' => 'Référentiel public sur les cookies et autres traceurs.'],
                ['label' => 'Politique de confidentialité', 'url' => self::page_url('privacy'), 'note' => 'Page publique principale intégrant le bloc cookies en V1.'],
            ]);
            $html .= '</div>';
        }

        return $html;
    }

    /**
     * @param array<string, mixed> $state
     */
    private static function render_meta_block(string $slot, array $state, string $eyebrow, string $subtitle): string
    {
        $slotState = isset($state[$slot]) && is_array($state[$slot]) ? $state[$slot] : [];
        $version = isset($slotState['version']) ? (string) $slotState['version'] : '1.0.0';
        $effectiveDate = self::format_date((string) ($slotState['effective_date'] ?? ''));
        $updatedAt = self::format_date((string) ($slotState['updated_at'] ?? ''));

        $html = '<div class="sp-legal-document__meta">';
        $html .= self::paragraph('<strong>' . esc_html($eyebrow) . '</strong>');
        $html .= self::paragraph(esc_html($subtitle));
        $html .= self::paragraph('<strong>Version :</strong> ' . esc_html($version));
        $html .= self::paragraph('<strong>Date d’effet :</strong> ' . esc_html($effectiveDate));
        $html .= self::paragraph('Dernière mise à jour : ' . esc_html($updatedAt));
        $html .= '</div>';

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
     * @param array<int, string> $items
     */
    private static function ordered_list(array $items): string
    {
        $html = '<ol class="sp-legal-document__list sp-legal-document__list--ordered">';
        foreach ($items as $item) {
            $html .= '<li>' . esc_html($item) . '</li>';
        }
        $html .= '</ol>';
        return $html;
    }

    private static function paragraph(string $html): string
    {
        return '<p>' . $html . '</p>';
    }

    /**
     * @param array<int, array{0:string,1:string}> $links
     */
    private static function render_internal_links(array $links): string
    {
        $html = '<ul class="sp-legal-document__links">';
        foreach ($links as $link) {
            $url = isset($link[0]) ? (string) $link[0] : '#';
            $label = isset($link[1]) ? (string) $link[1] : '';
            $html .= '<li><a href="' . esc_url($url) . '">' . esc_html($label) . '</a></li>';
        }
        $html .= '</ul>';
        return $html;
    }

    /**
     * @param array<int, array{label:string,url:string,note:string}> $sources
     */
    private static function source_list(array $sources): string
    {
        $html = '<ul class="sp-legal-document__sources">';
        foreach ($sources as $source) {
            $label = isset($source['label']) ? (string) $source['label'] : '';
            $url = isset($source['url']) ? (string) $source['url'] : '';
            $note = isset($source['note']) ? (string) $source['note'] : '';
            $html .= '<li><a href="' . esc_url($url) . '" target="_blank" rel="noopener noreferrer">' . esc_html($label) . '</a>';
            if ($note !== '') {
                $html .= ' — ' . esc_html($note);
            }
            $html .= '</li>';
        }
        $html .= '</ul>';
        return $html;
    }

    private static function page_url(string $slot): string
    {
        $def = self::slots()[$slot] ?? null;
        if (!is_array($def)) {
            return home_url('/');
        }

        return home_url('/' . trim((string) $def['slug'], '/') . '/');
    }

    private static function get_page_by_slug(string $slug): ?WP_Post
    {
        $page = get_page_by_path($slug, OBJECT, 'page');
        return $page instanceof WP_Post ? $page : null;
    }

    private static function page_has_shortcode(WP_Post $post, string $tag): bool
    {
        return has_shortcode((string) $post->post_content, $tag);
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

    private static function escape_or_placeholder(string $value): string
    {
        $value = trim($value);
        if ($value === '') {
            return '<strong>[À confirmer avant publication]</strong>';
        }

        return esc_html($value);
    }

    private static function bump_version(string $version): string
    {
        $version = trim($version);
        if ($version === '') {
            return '1.0.0';
        }

        if (preg_match('/^(\d+)\.(\d+)\.(\d+)$/', $version, $matches) === 1) {
            return sprintf('%d.%d.%d', (int) $matches[1], (int) $matches[2], (int) $matches[3] + 1);
        }

        if (preg_match('/^v?(\d+)$/i', $version, $matches) === 1) {
            return 'v' . ((int) $matches[1] + 1);
        }

        return $version . '.1';
    }
}
