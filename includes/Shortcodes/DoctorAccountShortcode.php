<?php

declare(strict_types=1);

namespace SOSPrescription\Shortcodes;

use SOSPrescription\Repositories\FileRepository;
use SOSPrescription\Services\FileStorage;
use SOSPrescription\Services\Logger;
use SOSPrescription\UI\ScreenFrame;
use SosPrescription\UI\AuthMagicLinkUi;

/**
 * Shortcode : interface "Compte médecin" (profil, RPPS, signature).
 *
 * Objectif MVP :
 * - permettre au médecin de compléter ses infos pro (RPPS, spécialité, adresse),
 * - permettre d'uploader une signature (image) qui sera utilisée plus tard pour la génération PDF,
 * - fournir à l'admin une liste des médecins + création rapide (sans accès wp-admin si souhaité).
 */
final class DoctorAccountShortcode
{
    public const META_TITLE = 'sosprescription_doctor_title';
    public const META_RPPS = 'sosprescription_rpps';
    public const META_SPECIALTY = 'sosprescription_specialty';
    public const META_ADDRESS = 'sosprescription_professional_address';
    public const META_PHONE = 'sosprescription_professional_phone';
    public const META_SIG_FILE_ID = 'sosprescription_signature_file_id';
    public const META_RPPS_VERIFIED = 'sosprescription_rpps_verified';
    public const META_RPPS_DATA = 'sosprescription_rpps_data';

    // "Premium" ordonnance
    public const META_DIPLOMA_LABEL = 'sosprescription_diploma_label';
    public const META_DIPLOMA_UNIVERSITY_LOCATION = 'sosprescription_diploma_university_location';
    public const META_DIPLOMA_HONORS = 'sosprescription_diploma_honors';
    public const META_ISSUE_PLACE = 'sosprescription_issue_place';
    public const LEGACY_META_RPPS = 'sosprescription_doctor_rpps';
    public const LEGACY_META_SPECIALTY = 'sosprescription_doctor_specialty';
    public const LEGACY_META_DIPLOMA_LINE = 'sosprescription_doctor_diploma_line';
    public const LEGACY_META_ISSUE_PLACE = 'sosprescription_doctor_issue_place';

    public static function register(): void
    {
        add_shortcode('sosprescription_doctor_account', [self::class, 'render']);

        // Form handlers (front) via admin-post
        add_action('admin_post_sosprescription_doctor_profile_save', [self::class, 'handle_profile_save']);
        add_action('admin_post_sosprescription_doctor_create', [self::class, 'handle_doctor_create']);
        add_action('admin_post_sosprescription_doctor_file_download', [self::class, 'handle_doctor_file_download']);
    }

    private static function can_access_doctor_area(): bool
    {
        return current_user_can('sosprescription_validate')
            || current_user_can('sosprescription_manage')
            || current_user_can('manage_options');
    }

    private static function can_manage_doctors(): bool
    {
        return current_user_can('sosprescription_manage') || current_user_can('manage_options');
    }

    private static function can_self_delete_account(): bool
    {
        return current_user_can('sosprescription_validate');
    }

    /**
     * @param array<string, mixed> $atts
     */
    public static function render(array $atts = []): string
    {
        Logger::log_shortcode('sosprescription_doctor_account', 'info', 'shortcode_render', [
            'atts_count' => count($atts),
        ]);

        if (!is_user_logged_in()) {
            AuthMagicLinkUi::enqueue_assets();

            return AuthMagicLinkUi::render_request_screen(
                'doctor-account',
                'Connexion médecin',
                'Saisissez votre adresse e-mail professionnelle pour recevoir un lien de connexion sécurisé vers votre compte médecin.'
            );
        }

        if (function_exists('wp_enqueue_script')) {
            wp_enqueue_script(
                'sosprescription-doctor-profile-enhancements',
                SOSPRESCRIPTION_URL . 'assets/doctor-profile-enhancements.js',
                [],
                SOSPRESCRIPTION_VERSION,
                true
            );
        }

        if (!self::can_access_doctor_area()) {
            return ScreenFrame::guard(
                'doctor-account',
                'access',
                'Accès réservé',
                'Cette page est accessible uniquement aux médecins connectés à leur compte professionnel sécurisé.'
            );
        }

        $current_id = (int) get_current_user_id();
        $target_id = $current_id;

        if (self::can_manage_doctors() && isset($_GET['doctor_user_id'])) {
            $maybe = (int) $_GET['doctor_user_id'];
            if ($maybe > 0) {
                $target_id = $maybe;
            }
        }

        $user = get_userdata($target_id);
        if (!$user) {
            $target_id = $current_id;
            $user = get_userdata($target_id);
        }
        if (!$user) {
            return ScreenFrame::guard(
                'doctor-account',
                'error',
                'Utilisateur introuvable',
                'Le profil demandé est introuvable ou n’est plus accessible.'
            );
        }

        $is_admin_view = self::can_manage_doctors();
        $is_self = ((int) $user->ID === $current_id);

        $doctor_title = self::read_user_meta_bridge((int) $user->ID, [self::META_TITLE], '');
        $rpps = self::read_user_meta_bridge((int) $user->ID, [self::META_RPPS, self::LEGACY_META_RPPS], '');
        $specialty = self::read_user_meta_bridge((int) $user->ID, [self::META_SPECIALTY, self::LEGACY_META_SPECIALTY], '');
        $diploma_label = self::read_user_meta_bridge((int) $user->ID, [self::META_DIPLOMA_LABEL], '');
        $diploma_university_location = self::read_user_meta_bridge((int) $user->ID, [self::META_DIPLOMA_UNIVERSITY_LOCATION], '');
        $diploma_honors = self::read_user_meta_bridge((int) $user->ID, [self::META_DIPLOMA_HONORS], '');
        $issue_place = self::read_user_meta_bridge((int) $user->ID, [self::META_ISSUE_PLACE, self::LEGACY_META_ISSUE_PLACE], '');
        $address = self::read_user_meta_bridge((int) $user->ID, [self::META_ADDRESS], '');
        $phone = self::read_user_meta_bridge((int) $user->ID, [self::META_PHONE], '');
        $sig_file_id = (int) self::read_user_meta_bridge((int) $user->ID, [self::META_SIG_FILE_ID], '0');
        $rpps_verified = self::read_user_meta_bool((int) $user->ID, [self::META_RPPS_VERIFIED], false);
        $rpps_data = self::read_user_meta_json((int) $user->ID, [self::META_RPPS_DATA], []);

        $updated = isset($_GET['updated']) && (string) $_GET['updated'] === '1';
        $created = isset($_GET['created']) && (string) $_GET['created'] === '1';
        $error = isset($_GET['error']) ? sanitize_text_field((string) $_GET['error']) : '';

        $notice_created = '';
        if ($is_admin_view) {
            $key = 'sosprescription_doctor_created_notice_' . $current_id;
            $payload = get_transient($key);
            if (is_array($payload)) {
                delete_transient($key);
                $email = isset($payload['email']) ? (string) $payload['email'] : '';
                $notice_created = self::render_alert(
                    'success',
                    'Compte médecin créé',
                    $email !== ''
                        ? 'Le praticien peut désormais se connecter via Magic Link avec l’adresse ' . $email . '.'
                        : 'Le praticien peut désormais se connecter via Magic Link à son compte médecin.'
                );
            }
        }

        $screen_title = $is_self ? 'Mon compte médecin' : ('Compte médecin : ' . (string) $user->display_name);
        $profile_values = [
            'email' => (string) $user->user_email,
            'doctor_title' => $doctor_title,
            'rpps' => $rpps,
            'specialty' => $specialty,
            'diploma_label' => $diploma_label,
            'diploma_university_location' => $diploma_university_location,
            'diploma_honors' => $diploma_honors,
            'issue_place' => $issue_place,
            'address' => $address,
            'phone' => $phone,
            'sig_file_id' => $sig_file_id,
            'rpps_verified' => $rpps_verified,
            'rpps_data' => $rpps_data,
        ];

        if (function_exists('wp_add_inline_script')) {
            $doctor_profile_front_config = [
                'profileEndpoint' => esc_url_raw(rest_url('sosprescription/v4/doctor/profile')),
                'verifyRppsEndpoint' => esc_url_raw(rest_url('sosprescription/v4/doctor/verify-rpps')),
                'deleteAccountEndpoint' => esc_url_raw(rest_url('sosprescription/v4/account/delete')),
                'restNonce' => wp_create_nonce('wp_rest'),
                'targetUserId' => (int) $user->ID,
                'initialProfile' => [
                    'email' => (string) $user->user_email,
                    'rpps_verified' => $rpps_verified,
                    'rpps_data' => $rpps_data,
                ],
                'strings' => [
                    'verifyLabel' => 'Vérifier',
                    'verifyingLabel' => 'Vérification…',
                    'saveLabel' => 'Enregistrer les modifications',
                    'savingLabel' => 'Enregistrement…',
                    'saveSuccess' => 'Les modifications ont été enregistrées.',
                    'saveError' => 'Les modifications n\'ont pas pu être enregistrées.',
                    'invalidLength' => 'Identifiant RPPS inconnu ou invalide. Veuillez vérifier votre saisie ou consulter l\'Annuaire Santé officiel.',
                    'invalidLookup' => 'Identifiant RPPS inconnu ou invalide. Veuillez vérifier votre saisie ou consulter l\'Annuaire Santé officiel.',
                    'serviceUnavailable' => 'La vérification RPPS est temporairement indisponible.',
                    'initialHelp' => 'Saisissez votre identifiant RPPS pour certifier votre profil. Cette étape est indispensable pour la conformité légale de vos prescriptions.',
                    'verifiedTitle' => '✓ Identité professionnelle certifiée',
                    'verifiedFooterPrefix' => 'Vérification effectuée avec succès via l\'Annuaire Santé le ',
                    'deleteAccountConfirm' => 'Action irréversible. Votre accès sera immédiatement détruit et vous ne pourrez plus vous connecter. Vos données médicales strictement nécessaires seront conservées sous forme d\'archives inactives pour répondre aux obligations légales de traçabilité. Confirmer la suppression ?',
                    'deleteAccountBusy' => 'Suppression…',
                    'deleteAccountError' => 'La suppression du compte a échoué. Merci de réessayer.',
                    'signatureInvalidType' => 'Format non supporté. Merci d\'utiliser JPG ou PNG uniquement.',
                    'signatureTooLarge' => 'Fichier trop lourd. La limite est de 1 Mo.',
                ],
            ];

            wp_add_inline_script(
                'sosprescription-doctor-profile-enhancements',
                'window.SOSPrescriptionDoctorProfile = ' . wp_json_encode($doctor_profile_front_config, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . ';',
                'before'
            );
        }

        $content = '';
        $content .= ScreenFrame::toolbarMeta(
            'doctor-account',
            self::render_session_toolbar($current_id, $user, $is_admin_view, $is_self)
        );

        $alerts = self::render_status_alerts($updated, $created, $error, $notice_created);
        if ($alerts !== '') {
            $content .= ScreenFrame::statusSurface('doctor-account', $alerts);
        }

        $content .= ScreenFrame::mount(
            'doctor-account',
            self::render_profile_section($screen_title, $user, $profile_values, $is_self, $is_admin_view),
            [],
            ['sp-ui']
        );

        if ($is_admin_view) {
            $management = self::render_management_section();
            if ($management !== '') {
                $content .= ScreenFrame::mount(
                    'doctor-account',
                    $management,
                    [],
                    ['sp-ui']
                );
            }
        }

        if ($is_self && self::can_self_delete_account()) {
            $content .= ScreenFrame::mount(
                'doctor-account',
                self::render_delete_account_section(),
                [],
                ['sp-ui']
            );
        }

        return ScreenFrame::screen('doctor-account', $content, [], ['sp-ui']);
    }

    private static function render_session_toolbar(int $current_id, \WP_User $target_user, bool $is_admin_view, bool $is_self): string
    {
        $current_user = wp_get_current_user();
        $current_label = self::resolve_doctor_label($current_user instanceof \WP_User ? $current_user : null, $current_id);
        $target_label = self::resolve_doctor_label($target_user, (int) $target_user->ID);

        $html = '';
        $html .= '<div class="sp-card sp-doctor-account__session-card">';
        $html .= '<div class="sp-stack">';
        $html .= ScreenFrame::badge('Connecté : ' . $current_label, 'success', true);

        if ($is_admin_view && !$is_self) {
            $html .= ScreenFrame::badge('Profil affiché : ' . $target_label, 'info', false);
        }

        $html .= self::render_logout_form();
        $html .= '</div>';
        $html .= '</div>';

        return $html;
    }

    private static function render_logout_form(): string
    {
        $html = '';
        $html .= '<form class="sp-form sp-doctor-account__form" method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        $html .= '<input type="hidden" name="action" value="sosprescription_logout" />';
        $html .= wp_nonce_field('sosprescription_logout', '_wpnonce', true, false);
        $html .= '<button type="submit" class="sp-button sp-button--secondary">Se déconnecter</button>';
        $html .= '</form>';

        return $html;
    }

    private static function render_status_alerts(bool $updated, bool $created, string $error, string $notice_created): string
    {
        $html = '';

        if ($updated) {
            $html .= self::render_alert('success', 'Profil enregistré', 'Vos informations professionnelles ont été enregistrées.');
        }
        if ($created && $notice_created === '') {
            $html .= self::render_alert('success', 'Compte médecin créé', 'Le praticien peut désormais se connecter avec son adresse e-mail professionnelle.');
        }
        if ($error !== '') {
            $html .= self::render_alert('error', 'Action impossible', $error);
        }
        if ($notice_created !== '') {
            $html .= $notice_created;
        }

        return $html;
    }

    private static function render_alert(string $variant, string $title, string $body): string
    {
        return '<div class="sp-alert sp-alert--' . esc_attr(sanitize_html_class($variant)) . '" role="status" aria-live="polite">'
            . '<p class="sp-alert__title">' . esc_html($title) . '</p>'
            . '<p class="sp-alert__body">' . esc_html($body) . '</p>'
            . '</div>';
    }

    private static function render_delete_account_section(): string
    {
        $html = '';
        $html .= '<div class="sp-card sp-doctor-account__section sp-doctor-account__section--danger">';
        $html .= '<div class="sp-stack sp-doctor-account__section-stack">';
        $html .= '<div class="sp-doctor-account__section-heading">';
        $html .= '<h2>Suppression de compte</h2>';
        $html .= '<p class="sp-field__help">Votre accès sera immédiatement détruit. Vos données strictement nécessaires seront conservées sous forme d’archives inactives pour répondre aux obligations légales de traçabilité.</p>';
        $html .= '</div>';
        $html .= '<div id="sp-delete-account-feedback" class="sp-alert sp-alert--error" hidden role="alert" aria-live="polite"></div>';
        $html .= '<button type="button" class="sp-button sp-button--secondary" style="color: var(--sp-color-warning, #c2410c); border-color: currentColor;" id="sp-delete-account-btn">Supprimer mon compte</button>';
        $html .= '</div>';
        $html .= '</div>';

        return $html;
    }

    /**
     * @param array<string, mixed> $profile_values
     */
    private static function render_profile_section(string $screen_title, \WP_User $user, array $profile_values, bool $is_self, bool $is_admin_view): string
    {
        $email = isset($profile_values['email']) ? (string) $profile_values['email'] : (string) $user->user_email;
        $doctor_title = isset($profile_values['doctor_title']) ? (string) $profile_values['doctor_title'] : '';
        $rpps = isset($profile_values['rpps']) ? (string) $profile_values['rpps'] : '';
        $specialty = isset($profile_values['specialty']) ? (string) $profile_values['specialty'] : '';
        $diploma_label = isset($profile_values['diploma_label']) ? (string) $profile_values['diploma_label'] : '';
        $diploma_university_location = isset($profile_values['diploma_university_location']) ? (string) $profile_values['diploma_university_location'] : '';
        $diploma_honors = isset($profile_values['diploma_honors']) ? (string) $profile_values['diploma_honors'] : '';
        $issue_place = isset($profile_values['issue_place']) ? (string) $profile_values['issue_place'] : '';
        $address = isset($profile_values['address']) ? (string) $profile_values['address'] : '';
        $phone = isset($profile_values['phone']) ? (string) $profile_values['phone'] : '';
        $sig_file_id = isset($profile_values['sig_file_id']) ? (int) $profile_values['sig_file_id'] : 0;
        $rpps_verified = !empty($profile_values['rpps_verified']);
        $rpps_data = isset($profile_values['rpps_data']) && is_array($profile_values['rpps_data']) ? $profile_values['rpps_data'] : [];
        $rpps_data_json = wp_json_encode($rpps_data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if (!is_string($rpps_data_json)) {
            $rpps_data_json = '{}';
        }

        $html = '';
        $html .= '<div class="sp-card sp-doctor-account__section sp-doctor-account__section--profile">';
        $html .= '<div class="sp-stack sp-doctor-account__section-stack">';
        $html .= '<div class="sp-doctor-account__hero">';
        $html .= '<p class="sp-doctor-account__eyebrow">Compte professionnel sécurisé</p>';
        $html .= '<h1>' . esc_html($screen_title) . '</h1>';
        $html .= '<p class="sp-field__help sp-doctor-account__intro">Complétez vos informations professionnelles et votre signature. Ces données sont utilisées pour générer vos ordonnances et comptes-rendus sécurisés.</p>';
        $html .= '</div>';

        if ($is_admin_view && !$is_self) {
            $html .= self::render_alert(
                'info',
                'Gestion du compte médecin',
                'Vous consultez actuellement le compte professionnel de ' . self::resolve_doctor_label($user, (int) $user->ID) . '.'
            );
        }

        $html .= '<form id="sp_doc_profile_form" class="sp-form sp-doctor-account__form" method="post" action="' . esc_url(admin_url('admin-post.php')) . '" enctype="multipart/form-data">';
        $html .= '<input type="hidden" name="action" value="sosprescription_doctor_profile_save" />';
        $html .= wp_nonce_field('sosprescription_doctor_profile_save', '_wpnonce', true, false);
        $html .= '<input type="hidden" id="sp_doc_rpps_verified" name="rpps_verified" value="' . esc_attr($rpps_verified ? '1' : '0') . '" />';
        $html .= '<input type="hidden" id="sp_doc_rpps_data" name="rpps_data" value="' . esc_attr($rpps_data_json) . '" />';

        if ($is_admin_view && !$is_self) {
            $html .= '<input type="hidden" name="target_user_id" value="' . esc_attr((string) $user->ID) . '" />';
        }

        $html .= '<div class="sp-stack sp-doctor-account__fields">';

        $html .= '<div class="sp-field">';
        $html .= '<label class="sp-field__label" for="sp_doc_email_current">Adresse e-mail de connexion</label>';
        $html .= '<input class="sp-input" type="email" id="sp_doc_email_current" name="email_current" value="' . esc_attr($email) . '" autocomplete="email" />';
        $html .= '<p class="sp-field__help">Cette adresse est utilisée pour vos notifications et votre connexion sécurisée par Magic Link.</p>';
        $html .= '</div>';

        $html .= '<div class="sp-field">';
        $html .= '<label class="sp-field__label" for="sp_doc_display_name">Nom affiché</label>';
        $html .= '<input class="sp-input" type="text" id="sp_doc_display_name" name="display_name" value="' . esc_attr((string) $user->display_name) . '" placeholder="Ex : Dr Marie Dupont" />';
        $html .= '<p class="sp-field__help">Nom affiché dans votre espace sécurisé et sur vos documents.</p>';
        $html .= '</div>';

        $html .= '<div class="sp-field">';
        $html .= '<label class="sp-field__label" for="sp_doc_title">Titre professionnel</label>';
        $html .= '<select class="sp-select" id="sp_doc_title" name="doctor_title">';
        $html .= '<option value="docteur"' . selected($doctor_title, 'docteur', false) . '>Docteur</option>';
        $html .= '<option value="professeur"' . selected($doctor_title, 'professeur', false) . '>Professeur</option>';
        $html .= '</select>';
        $html .= '</div>';

        $html .= '<div class="sp-field">';
        $html .= '<label class="sp-field__label" for="sp_doc_rpps">Numéro RPPS</label>';
        $html .= '<input class="sp-input" type="text" id="sp_doc_rpps" name="rpps" value="' . esc_attr($rpps) . '" placeholder="Ex : 10001234567" inputmode="numeric" maxlength="11" autocomplete="off" data-sp-rpps-managed="1" />';
        $html .= '<div class="sp-stack" data-sp-rpps-actions="1"></div>';
        $html .= '<div id="sp_doc_rpps_verify_feedback" class="sp-alert sp-alert--success" hidden role="status" aria-live="polite"></div>';
        $html .= '<p id="sp_doc_rpps_verify_footer" class="sp-field__help">Saisissez votre identifiant RPPS pour certifier votre profil. Cette étape est indispensable pour la conformité légale de vos prescriptions.</p>';
        $html .= '</div>';

        $html .= '<div class="sp-field">';
        $html .= '<label class="sp-field__label" for="sp_doc_specialty">Spécialité / qualification</label>';
        $html .= '<input class="sp-input" type="text" id="sp_doc_specialty" name="specialty" value="' . esc_attr($specialty) . '" placeholder="Ex : Médecin généraliste" />';
        $html .= '</div>';

        $html .= '<div class="sp-field">';
        $html .= '<label class="sp-field__label" for="sp_doc_diploma_label">Diplôme (libellé)</label>';
        $html .= '<input class="sp-input" type="text" id="sp_doc_diploma_label" name="diploma_label" value="' . esc_attr($diploma_label) . '" placeholder="Ex : Diplômé Faculté" />';
        $html .= '<p class="sp-field__help">Texte affiché sur l’ordonnance, par exemple « Diplômé Faculté ».</p>';
        $html .= '</div>';

        $html .= '<div class="sp-field">';
        $html .= '<label class="sp-field__label" for="sp_doc_diploma_university">Université / lieu</label>';
        $html .= '<input class="sp-input" type="text" id="sp_doc_diploma_university" name="diploma_university_location" value="' . esc_attr($diploma_university_location) . '" placeholder="Ex : Paris XIII" />';
        $html .= '<p class="sp-field__help">Exemple d’affichage : « Diplômé Faculté Paris XIII ».</p>';
        $html .= '</div>';

        $html .= '<div class="sp-field">';
        $html .= '<label class="sp-field__label" for="sp_doc_diploma_honors">Distinctions (optionnel)</label>';
        $html .= '<input class="sp-input" type="text" id="sp_doc_diploma_honors" name="diploma_honors" value="' . esc_attr($diploma_honors) . '" placeholder="Ex : Lauréat de l’Académie" />';
        $html .= '<p class="sp-field__help">Ajouté sur le document uniquement si vous le renseignez.</p>';
        $html .= '</div>';

        $html .= '<div class="sp-field">';
        $html .= '<label class="sp-field__label" for="sp_doc_issue_place">Lieu de signature</label>';
        $html .= '<input class="sp-input" type="text" id="sp_doc_issue_place" name="issue_place" value="' . esc_attr($issue_place) . '" placeholder="Ex : Saint-Laurent-du-Var" />';
        $html .= '<p class="sp-field__help">Utilisé dans la mention « Fait à …, le … ».</p>';
        $html .= '</div>';

        $html .= '<div class="sp-field">';
        $html .= '<label class="sp-field__label" for="sp_doc_address">Adresse professionnelle</label>';
        $html .= '<textarea class="sp-textarea" rows="4" id="sp_doc_address" name="address" placeholder="Adresse du cabinet ou de la structure">' . esc_textarea($address) . '</textarea>';
        $html .= '<p class="sp-field__help">Cette adresse peut apparaître sur vos ordonnances et comptes-rendus sécurisés.</p>';
        $html .= '</div>';

        $html .= '<div class="sp-field">';
        $html .= '<label class="sp-field__label" for="sp_doc_phone">Numéro de transfert (masqué)</label>';
        $html .= '<input class="sp-input" type="text" id="sp_doc_phone" name="phone" value="' . esc_attr($phone) . '" placeholder="Ex : 06 12 34 56 78" />';
        $html .= '<p class="sp-field__help">Pour protéger votre vie privée, ce numéro ne sera jamais imprimé sur vos ordonnances. La plateforme génèrera un numéro de standard sécurisé (09) qui redirigera les appels des pharmaciens vers cette ligne.</p>';
        $html .= '</div>';

        $html .= self::render_signature_field($sig_file_id);

        $html .= '<div id="sp_doc_profile_feedback" class="sp-alert sp-alert--success" hidden role="status" aria-live="polite"></div>';

        $html .= '<div class="sp-stack sp-doctor-account__form-actions">';
        $html .= '<button type="submit" id="sp_doc_profile_save" class="sp-button sp-button--primary">Enregistrer les modifications</button>';
        if (!$is_self && $is_admin_view) {
            $back = remove_query_arg('doctor_user_id');
            $html .= '<a class="sp-button sp-button--secondary" href="' . esc_url($back) . '">Retour à la liste des médecins</a>';
        }
        $html .= '</div>';

        $html .= '</div>';
        $html .= '</form>';
        $html .= '</div>';
        $html .= '</div>';

        return $html;
    }

    private static function render_signature_field(int $sig_file_id): string
    {
        $html = '';
        $html .= '<div class="sp-field sp-doctor-account__subsection sp-doctor-account__signature-field">';
        $html .= '<span class="sp-field__label">Signature</span>';

        if ($sig_file_id > 0) {
            $download_url = wp_nonce_url(
                admin_url('admin-post.php?action=sosprescription_doctor_file_download&file_id=' . $sig_file_id . '&inline=1'),
                'sosprescription_doctor_file_download'
            );

            $html .= '<div class="sp-alert sp-alert--info" role="status" aria-live="polite">';
            $html .= '<p class="sp-alert__title">Signature enregistrée</p>';
            $html .= '<p class="sp-alert__body">Une signature privée est déjà associée à votre profil. <a href="' . esc_url($download_url) . '" target="_blank" rel="noopener">Prévisualiser la signature actuelle</a>.</p>';
            $html .= '</div>';
            $html .= '<label class="sp-choice">';
            $html .= '<input class="sp-choice__input" type="checkbox" name="remove_signature" value="1" />';
            $html .= '<span class="sp-choice__label">Supprimer la signature actuelle lors de l’enregistrement</span>';
            $html .= '</label>';
        } else {
            $html .= '<div class="sp-alert sp-alert--info" role="status" aria-live="polite">';
            $html .= '<p class="sp-alert__title">Aucune signature enregistrée</p>';
            $html .= '<p class="sp-alert__body">Ajoutez une signature PNG ou JPG pour préparer vos futurs documents médicaux sécurisés.</p>';
            $html .= '</div>';
        }

        $html .= '<input class="sp-input" type="file" id="signature_file" name="signature_file" accept="image/png,image/jpeg" />';
        $html .= '<p class="sp-field__help">Le fichier reste stocké en privé. Recommandé : PNG ou JPG, largeur 600 à 1000 px, hauteur 120 à 250 px, idéalement moins de 200 ko.</p>';
        $html .= '<div id="sp_signature_feedback" class="sp-alert sp-alert--info" hidden role="status" aria-live="polite"></div>';
        $html .= '<p id="sp_signature_meta" class="sp-field__help" hidden></p>';
        $html .= '<div id="sp_signature_preview" class="sp-card" hidden>';
        $html .= '<div class="sp-stack sp-doctor-account__fields">';
        $html .= '<p class="sp-field__help">Prévisualisation locale avant enregistrement.</p>';
        $html .= '<img id="sp_signature_preview_img" alt="Prévisualisation de la signature" />';
        $html .= '<div class="sp-stack">';
        $html .= '<button type="button" id="sp_signature_clear" class="sp-button sp-button--secondary">Retirer le fichier sélectionné</button>';
        $html .= '</div>';
        $html .= '</div>';
        $html .= '</div>';
        $html .= '</div>';

        return $html;
    }

    private static function render_management_section(): string
    {
        $doctors = get_users([
            'role__in' => ['sosprescription_doctor'],
            'orderby' => 'display_name',
            'order' => 'ASC',
            'number' => 200,
        ]);

        if (!empty($doctors)) {
            return '';
        }

        $html = '';
        $html .= '<div class="sp-card sp-doctor-account__section sp-doctor-account__section--management">';
        $html .= '<div class="sp-stack sp-doctor-account__section-stack">';
        $html .= '<div class="sp-doctor-account__section-heading">';
        $html .= '<h2>Ajouter un médecin ultérieurement</h2>';
        $html .= '<p class="sp-field__help">Cet espace pourra servir plus tard à préparer l’ajout d’un autre praticien si l’organisation évolue. Il reste volontairement discret tant qu’aucun second compte n’est nécessaire.</p>';
        $html .= '</div>';

        $html .= '<div class="sp-stack sp-doctor-account__subsection">';
        $html .= '<h3>Préparer un compte médecin</h3>';
        $html .= '<form class="sp-form sp-doctor-account__form" method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        $html .= '<input type="hidden" name="action" value="sosprescription_doctor_create" />';
        $html .= wp_nonce_field('sosprescription_doctor_create', '_wpnonce', true, false);
        $html .= '<div class="sp-stack">';

        $html .= '<div class="sp-field">';
        $html .= '<label class="sp-field__label" for="sp_new_doc_email">Adresse e-mail</label>';
        $html .= '<input class="sp-input" type="email" id="sp_new_doc_email" name="email" required />';
        $html .= '<p class="sp-field__help">Cette adresse servira à la connexion Magic Link du praticien.</p>';
        $html .= '</div>';

        $html .= '<div class="sp-field">';
        $html .= '<label class="sp-field__label" for="sp_new_doc_name">Nom affiché</label>';
        $html .= '<input class="sp-input" type="text" id="sp_new_doc_name" name="display_name" placeholder="Dr Marie Dupont" />';
        $html .= '</div>';

        $html .= '<div class="sp-field">';
        $html .= '<label class="sp-field__label" for="sp_new_doc_rpps">Numéro RPPS</label>';
        $html .= '<input class="sp-input" type="text" id="sp_new_doc_rpps" name="rpps" placeholder="10001234567" />';
        $html .= '<div class="sp-stack" data-sp-rpps-actions="1"></div>';
        $html .= '</div>';

        $html .= '<div class="sp-stack sp-doctor-account__form-actions">';
        $html .= '<button type="submit" class="sp-button sp-button--primary">Préparer le compte médecin</button>';
        $html .= '</div>';

        $html .= '</div>';
        $html .= '</form>';
        $html .= '</div>';

        $html .= '</div>';
        $html .= '</div>';

        return $html;
    }

    /**
     * @param array<int, \WP_User> $doctors
     */
    private static function render_doctors_table(array $doctors): string
    {
        $base_url = is_singular() ? (string) get_permalink() : (string) home_url('/compte-medecin/');

        $html = '';
        $html .= '<div class="sp-data-grid sp-doctor-account__table">';
        $html .= '<table class="sp-data-table">';
        $html .= '<thead><tr><th>Nom</th><th>E-mail</th><th>RPPS</th><th>Action</th></tr></thead>';
        $html .= '<tbody>';

        foreach ($doctors as $doctor) {
            $doctor_id = (int) $doctor->ID;
            $doctor_rpps = self::read_user_meta_bridge($doctor_id, [self::META_RPPS, self::LEGACY_META_RPPS], '');
            $edit_url = add_query_arg(['doctor_user_id' => $doctor_id], $base_url);

            $html .= '<tr>';
            $html .= '<td>' . esc_html(self::resolve_doctor_label($doctor, $doctor_id)) . '</td>';
            $html .= '<td>' . esc_html((string) $doctor->user_email) . '</td>';
            $html .= '<td>' . esc_html($doctor_rpps !== '' ? $doctor_rpps : '—') . '</td>';
            $html .= '<td><a class="sp-button sp-button--secondary" href="' . esc_url($edit_url) . '">Éditer</a></td>';
            $html .= '</tr>';
        }

        $html .= '</tbody>';
        $html .= '</table>';
        $html .= '</div>';

        return $html;
    }

    private static function resolve_doctor_label(?\WP_User $user, int $user_id): string
    {
        if (!$user instanceof \WP_User) {
            return 'Utilisateur';
        }

        $title_meta = strtolower(trim((string) self::read_user_meta_bridge($user_id, [self::META_TITLE], '')));
        $title_prefix = '';
        if ($title_meta === 'professeur') {
            $title_prefix = 'Pr';
        } elseif ($title_meta === 'docteur') {
            $title_prefix = 'Dr';
        }

        $display_name = trim((string) $user->display_name);
        if ($display_name === '') {
            $display_name = trim((string) $user->user_email);
        }

        return trim($title_prefix . ' ' . $display_name);
    }

    public static function handle_profile_save(): void
    {
        if (!is_user_logged_in()) {
            wp_die('Connexion requise.');
        }
        check_admin_referer('sosprescription_doctor_profile_save');

        $current_id = (int) get_current_user_id();
        $target_id = $current_id;

        if (self::can_manage_doctors() && isset($_POST['target_user_id'])) {
            $maybe = (int) $_POST['target_user_id'];
            if ($maybe > 0) {
                $target_id = $maybe;
            }
        }

        if (!$target_id || (!self::can_manage_doctors() && $target_id !== $current_id)) {
            wp_die('Accès refusé.');
        }

        $display_name = isset($_POST['display_name']) ? sanitize_text_field((string) wp_unslash($_POST['display_name'])) : '';
        $email_current = isset($_POST['email_current']) ? sanitize_email((string) wp_unslash($_POST['email_current'])) : '';
        $doctor_title = isset($_POST['doctor_title']) ? sanitize_text_field((string) wp_unslash($_POST['doctor_title'])) : 'docteur';
        $rpps = isset($_POST['rpps']) ? preg_replace('/[^0-9]/', '', (string) wp_unslash($_POST['rpps'])) : '';
        $specialty = isset($_POST['specialty']) ? sanitize_text_field((string) wp_unslash($_POST['specialty'])) : '';
        $address = isset($_POST['address']) ? wp_kses_post((string) wp_unslash($_POST['address'])) : '';
        $phone = isset($_POST['phone']) ? sanitize_text_field((string) wp_unslash($_POST['phone'])) : '';

        $diploma_label = isset($_POST['diploma_label']) ? sanitize_text_field((string) wp_unslash($_POST['diploma_label'])) : '';
        $diploma_university_location = isset($_POST['diploma_university_location']) ? sanitize_text_field((string) wp_unslash($_POST['diploma_university_location'])) : '';
        $diploma_honors = isset($_POST['diploma_honors']) ? sanitize_text_field((string) wp_unslash($_POST['diploma_honors'])) : '';
        $issue_place = isset($_POST['issue_place']) ? sanitize_text_field((string) wp_unslash($_POST['issue_place'])) : '';

        $allowed_titles = ['docteur', 'professeur'];
        if (!in_array($doctor_title, $allowed_titles, true)) {
            $doctor_title = 'docteur';
        }

        if ($email_current !== '') {
            if (!is_email($email_current)) {
                $url = add_query_arg([
                    'error' => rawurlencode('Adresse e-mail invalide.'),
                ], wp_get_referer() ?: home_url('/'));
                wp_safe_redirect($url);
                exit;
            }

            $email_owner = email_exists($email_current);
            if ($email_owner && (int) $email_owner !== $target_id) {
                $url = add_query_arg([
                    'error' => rawurlencode('Cette adresse e-mail est déjà utilisée par un autre compte.'),
                ], wp_get_referer() ?: home_url('/'));
                wp_safe_redirect($url);
                exit;
            }
        }

        $user_update = [
            'ID' => $target_id,
        ];
        $has_user_update = false;

        if ($display_name !== '') {
            $user_update['display_name'] = $display_name;
            $has_user_update = true;
        }

        if ($email_current !== '') {
            $user_update['user_email'] = $email_current;
            $has_user_update = true;
        }

        if ($has_user_update) {
            $updated_user = wp_update_user($user_update);
            if (is_wp_error($updated_user)) {
                $url = add_query_arg([
                    'error' => rawurlencode($updated_user->get_error_message()),
                ], wp_get_referer() ?: home_url('/'));
                wp_safe_redirect($url);
                exit;
            }
        }

        self::write_user_meta_bridge($target_id, [self::META_TITLE], (string) $doctor_title);
        self::write_user_meta_bridge($target_id, [self::META_RPPS, self::LEGACY_META_RPPS], (string) $rpps);
        self::write_user_meta_bridge($target_id, [self::META_SPECIALTY, self::LEGACY_META_SPECIALTY], (string) $specialty);
        self::write_user_meta_bridge($target_id, [self::META_ADDRESS], (string) $address);
        self::write_user_meta_bridge($target_id, [self::META_PHONE], (string) $phone);

        self::write_user_meta_bridge($target_id, [self::META_DIPLOMA_LABEL], (string) $diploma_label);
        self::write_user_meta_bridge($target_id, [self::META_DIPLOMA_UNIVERSITY_LOCATION], (string) $diploma_university_location);
        self::write_user_meta_bridge($target_id, [self::META_DIPLOMA_HONORS], (string) $diploma_honors);
        self::write_user_meta_bridge($target_id, [self::META_ISSUE_PLACE, self::LEGACY_META_ISSUE_PLACE], (string) $issue_place);

        $rpps_verified = isset($_POST['rpps_verified']) && (string) wp_unslash($_POST['rpps_verified']) === '1';
        $rpps_data = self::sanitize_rpps_data_payload(isset($_POST['rpps_data']) ? wp_unslash((string) $_POST['rpps_data']) : null);
        $rpps_payload_rpps = isset($rpps_data['rpps']) && is_scalar($rpps_data['rpps'])
            ? preg_replace('/\D+/', '', (string) $rpps_data['rpps'])
            : '';
        if (!$rpps_verified || $rpps_payload_rpps === '' || $rpps_payload_rpps !== (string) $rpps) {
            $rpps_verified = false;
            $rpps_data = [];
        }

        self::write_user_meta_bridge($target_id, [self::META_RPPS_VERIFIED], $rpps_verified ? '1' : '0');
        if ($rpps_verified && $rpps_data !== []) {
            self::write_user_meta_json($target_id, self::META_RPPS_DATA, $rpps_data);
        } else {
            delete_user_meta($target_id, self::META_RPPS_DATA);
        }

        $remove_signature = isset($_POST['remove_signature']) && (string) wp_unslash($_POST['remove_signature']) === '1';
        if ($remove_signature) {
            delete_user_meta($target_id, self::META_SIG_FILE_ID);
        }

        if (isset($_FILES['signature_file']) && is_array($_FILES['signature_file']) && isset($_FILES['signature_file']['tmp_name']) && (string) $_FILES['signature_file']['tmp_name'] !== '') {
            $stored = FileStorage::store_uploaded($_FILES['signature_file']);
            if (is_wp_error($stored)) {
                $url = add_query_arg([
                    'error' => rawurlencode($stored->get_error_message()),
                ], wp_get_referer() ?: home_url('/'));
                wp_safe_redirect($url);
                exit;
            }

            $repo = new FileRepository();
            $created = $repo->create(
                $target_id,
                null,
                'doctor_signature',
                (string) ($stored['mime'] ?? 'application/octet-stream'),
                (string) ($stored['original_name'] ?? 'signature'),
                (string) ($stored['storage_key'] ?? ''),
                (int) ($stored['size_bytes'] ?? 0)
            );

            if (isset($created['error'])) {
                $abs = isset($stored['abs_path']) ? (string) $stored['abs_path'] : '';
                if ($abs !== '' && is_file($abs)) {
                    @unlink($abs);
                }
                $url = add_query_arg([
                    'error' => rawurlencode('Erreur lors de l\'enregistrement de la signature.'),
                ], wp_get_referer() ?: home_url('/'));
                wp_safe_redirect($url);
                exit;
            }

            $file_id = (int) ($created['id'] ?? 0);
            if ($file_id > 0) {
                self::write_user_meta_bridge($target_id, [self::META_SIG_FILE_ID], (string) $file_id);
            }
        }

        $redirect = wp_get_referer();
        if (!$redirect) {
            $redirect = home_url('/');
        }
        $redirect = add_query_arg(['updated' => '1'], $redirect);
        wp_safe_redirect($redirect);
        exit;
    }

    public static function handle_doctor_create(): void
    {
        if (!is_user_logged_in()) {
            wp_die('Connexion requise.');
        }
        if (!self::can_manage_doctors()) {
            wp_die('Accès refusé.');
        }
        check_admin_referer('sosprescription_doctor_create');

        $email = isset($_POST['email']) ? sanitize_email((string) wp_unslash($_POST['email'])) : '';
        $display_name = isset($_POST['display_name']) ? sanitize_text_field((string) wp_unslash($_POST['display_name'])) : '';
        $rpps = isset($_POST['rpps']) ? preg_replace('/[^0-9]/', '', (string) wp_unslash($_POST['rpps'])) : '';

        if ($email === '' || !is_email($email)) {
            $url = add_query_arg(['error' => rawurlencode('Email invalide.')], wp_get_referer() ?: home_url('/'));
            wp_safe_redirect($url);
            exit;
        }

        $base = preg_replace('/@.*/', '', $email);
        $login = sanitize_user((string) $base, true);
        if ($login === '') {
            $login = 'doctor';
        }
        $try = $login;
        $i = 0;
        while (username_exists($try)) {
            $i++;
            $try = $login . (string) random_int(1000, 9999);
            if ($i > 5) {
                $try = $login . '-' . (string) time();
                break;
            }
        }
        $login = $try;

        $pass = wp_generate_password(18, true, true);

        $user_id = wp_insert_user([
            'user_login' => $login,
            'user_pass' => $pass,
            'user_email' => $email,
            'display_name' => $display_name !== '' ? $display_name : $login,
            'role' => 'sosprescription_doctor',
        ]);

        if (is_wp_error($user_id)) {
            $url = add_query_arg(['error' => rawurlencode($user_id->get_error_message())], wp_get_referer() ?: home_url('/'));
            wp_safe_redirect($url);
            exit;
        }

        self::write_user_meta_bridge((int) $user_id, [self::META_RPPS, self::LEGACY_META_RPPS], (string) $rpps);

        if (function_exists('wp_new_user_notification')) {
            @wp_new_user_notification((int) $user_id, null, 'user');
        }

        $admin_id = (int) get_current_user_id();
        set_transient('sosprescription_doctor_created_notice_' . $admin_id, [
            'login' => $login,
            'email' => $email,
            'pass' => $pass,
        ], 5 * MINUTE_IN_SECONDS);

        $redirect = wp_get_referer();
        if (!$redirect) {
            $redirect = home_url('/');
        }
        $redirect = add_query_arg(['created' => '1'], $redirect);
        wp_safe_redirect($redirect);
        exit;
    }

    public static function handle_doctor_file_download(): void
    {
        if (!is_user_logged_in()) {
            wp_die('Connexion requise.');
        }
        check_admin_referer('sosprescription_doctor_file_download');

        $file_id = isset($_GET['file_id']) ? (int) $_GET['file_id'] : 0;
        if ($file_id < 1) {
            wp_die('Fichier invalide.');
        }

        $repo = new FileRepository();
        $row = $repo->get($file_id);
        if (!$row) {
            wp_die('Fichier introuvable.');
        }

        $purpose = isset($row['purpose']) ? (string) $row['purpose'] : '';
        if (!in_array($purpose, ['doctor_signature', 'doctor_stamp'], true)) {
            wp_die('Accès refusé.');
        }

        $current_id = (int) get_current_user_id();
        $owner_id = isset($row['owner_user_id']) ? (int) $row['owner_user_id'] : 0;

        if (!self::can_manage_doctors() && $owner_id !== $current_id) {
            wp_die('Accès refusé.');
        }

        $storage_key = isset($row['storage_key']) ? (string) $row['storage_key'] : '';
        $path = FileStorage::safe_abs_path($storage_key);
        if (is_wp_error($path)) {
            wp_die(esc_html($path->get_error_message()));
        }

        $mime = isset($row['mime']) ? (string) $row['mime'] : 'application/octet-stream';
        $name = isset($row['original_name']) ? (string) $row['original_name'] : 'download';
        $size = is_file($path) ? (int) (@filesize($path) ?: 0) : 0;

        $inline = isset($_GET['inline']) ? (string) $_GET['inline'] : '0';
        $disposition = ($inline === '1' && str_starts_with($mime, 'image/')) ? 'inline' : 'attachment';

        while (ob_get_level()) {
            @ob_end_clean();
        }

        nocache_headers();
        header('Content-Type: ' . $mime);
        header('X-Content-Type-Options: nosniff');
        header('Cache-Control: private, no-store, no-cache, must-revalidate, max-age=0');
        header('Pragma: no-cache');

        $fallback = preg_replace('/[^A-Za-z0-9._-]/', '_', $name);
        $fallback = is_string($fallback) && $fallback !== '' ? $fallback : 'download';
        $encoded = rawurlencode($name);
        header("Content-Disposition: {$disposition}; filename=\"{$fallback}\"; filename*=UTF-8''{$encoded}");
        if ($size > 0) {
            header('Content-Length: ' . (string) $size);
        }

        $fp = fopen($path, 'rb');
        if ($fp === false) {
            wp_die('Impossible d\'ouvrir le fichier.');
        }
        fpassthru($fp);
        fclose($fp);
        exit;
    }

    /**
     * @param array<int, string> $keys
     */
    private static function read_user_meta_bool(int $user_id, array $keys, bool $default = false): bool
    {
        foreach ($keys as $key) {
            if (!is_string($key) || $key === '') {
                continue;
            }

            $value = get_user_meta($user_id, $key, true);
            if ($value === '' || $value === null) {
                continue;
            }

            if (is_bool($value)) {
                return $value;
            }

            if (is_scalar($value)) {
                $normalized = strtolower(trim((string) $value));
                if (in_array($normalized, ['1', 'true', 'yes', 'on'], true)) {
                    return true;
                }
                if (in_array($normalized, ['0', 'false', 'no', 'off'], true)) {
                    return false;
                }
            }
        }

        return $default;
    }

    /**
     * @param array<int, string> $keys
     * @return array<string, mixed>
     */
    private static function read_user_meta_json(int $user_id, array $keys, array $default = []): array
    {
        foreach ($keys as $key) {
            if (!is_string($key) || $key === '') {
                continue;
            }

            $value = get_user_meta($user_id, $key, true);
            if (is_array($value)) {
                return $value;
            }

            if (is_string($value) && trim($value) !== '') {
                $decoded = json_decode($value, true);
                if (is_array($decoded)) {
                    return $decoded;
                }
            }
        }

        return $default;
    }

    /**
     * @param array<string, mixed> $value
     */
    private static function write_user_meta_json(int $user_id, string $key, array $value): void
    {
        $json = wp_json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        update_user_meta($user_id, $key, is_string($json) ? $json : '{}');
    }

    /**
     * @return array<string, mixed>
     */
    private static function sanitize_rpps_data_payload(?string $raw): array
    {
        if (!is_string($raw) || trim($raw) === '') {
            return [];
        }

        $decoded = json_decode($raw, true);
        if (!is_array($decoded)) {
            return [];
        }

        $payload = [];
        foreach ([
            'valid',
            'rpps',
            'firstName',
            'lastName',
            'profession',
            'specialty',
            'city',
            'locationLabel',
            'verified_at',
        ] as $key) {
            if (!array_key_exists($key, $decoded)) {
                continue;
            }

            if ($key === 'valid') {
                $payload[$key] = (bool) $decoded[$key];
                continue;
            }

            if (is_scalar($decoded[$key])) {
                $value = trim((string) $decoded[$key]);
                if ($key === 'rpps') {
                    $value = preg_replace('/\D+/', '', $value) ?: '';
                }
                $payload[$key] = $value;
            }
        }

        return $payload;
    }

    /**
     * @param array<int, string> $keys
     */
    private static function read_user_meta_bridge(int $user_id, array $keys, string $default = ''): string
    {
        foreach ($keys as $key) {
            if (!is_string($key) || $key === '') {
                continue;
            }

            $value = get_user_meta($user_id, $key, true);
            if (is_scalar($value)) {
                $value = trim((string) $value);
                if ($value !== '') {
                    return $value;
                }
            }
        }

        return $default;
    }

    /**
     * @param array<int, string> $keys
     */
    private static function write_user_meta_bridge(int $user_id, array $keys, string $value): void
    {
        foreach ($keys as $key) {
            if (!is_string($key) || $key === '') {
                continue;
            }

            update_user_meta($user_id, $key, $value);
        }
    }
}
