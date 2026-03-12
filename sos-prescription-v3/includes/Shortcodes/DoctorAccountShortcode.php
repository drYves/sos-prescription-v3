<?php
declare(strict_types=1);

namespace SOSPrescription\Shortcodes;

use SOSPrescription\Repositories\FileRepository;
use SOSPrescription\Services\FileStorage;
use SOSPrescription\Services\Logger;

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

    // "Premium" ordonnance
    public const META_DIPLOMA_LABEL = 'sosprescription_diploma_label';
    public const META_DIPLOMA_UNIVERSITY_LOCATION = 'sosprescription_diploma_university_location';
    public const META_DIPLOMA_HONORS = 'sosprescription_diploma_honors';
    public const META_ISSUE_PLACE = 'sosprescription_issue_place';

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

    /**
     * @param array<string, mixed> $atts
     */
    public static function render(array $atts = []): string
    {
        Logger::log_shortcode('sosprescription_doctor_account', 'info', 'shortcode_render', [
            'atts_count' => count($atts),
        ]);

        // Assets (UX upload signature)
        if (function_exists('wp_enqueue_style')) {
            wp_enqueue_style(
                'sosprescription-doctor-account',
                SOSPRESCRIPTION_URL . 'assets/doctor-account.css',
                [],
                SOSPRESCRIPTION_VERSION
            );

            wp_enqueue_script(
                'sosprescription-doctor-account',
                SOSPRESCRIPTION_URL . 'assets/doctor-account.js',
                [],
                SOSPRESCRIPTION_VERSION,
                true
            );
        }

        if (!is_user_logged_in()) {
            $url = wp_login_url((string) get_permalink());
            return '<div style="max-width:980px;margin:12px auto;padding:14px;border:1px solid #e5e7eb;background:#fff;border-radius:12px;">'
                . '<strong>Connexion requise.</strong> <a href="' . esc_url($url) . '">Se connecter</a>'
                . '</div>';
        }

        if (!self::can_access_doctor_area()) {
            return '<div style="max-width:980px;margin:12px auto;padding:14px;border:1px solid #fde68a;background:#fffbeb;border-radius:12px;">'
                . '<strong>Accès réservé.</strong> Cette page est destinée aux médecins et administrateurs.'
                . '</div>';
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
            return '<div style="max-width:980px;margin:12px auto;padding:14px;border:1px solid #fecaca;background:#fef2f2;border-radius:12px;">Utilisateur introuvable.</div>';
        }

        $is_admin_view = self::can_manage_doctors();
        $is_self = ((int) $user->ID === $current_id);

        $doctor_title = (string) get_user_meta((int) $user->ID, self::META_TITLE, true);
        $rpps = (string) get_user_meta((int) $user->ID, self::META_RPPS, true);
        $specialty = (string) get_user_meta((int) $user->ID, self::META_SPECIALTY, true);
        $diploma_label = (string) get_user_meta((int) $user->ID, self::META_DIPLOMA_LABEL, true);
        $diploma_university_location = (string) get_user_meta((int) $user->ID, self::META_DIPLOMA_UNIVERSITY_LOCATION, true);
        $diploma_honors = (string) get_user_meta((int) $user->ID, self::META_DIPLOMA_HONORS, true);
        $issue_place = (string) get_user_meta((int) $user->ID, self::META_ISSUE_PLACE, true);
        $address = (string) get_user_meta((int) $user->ID, self::META_ADDRESS, true);
        $phone = (string) get_user_meta((int) $user->ID, self::META_PHONE, true);
        $sig_file_id = (int) get_user_meta((int) $user->ID, self::META_SIG_FILE_ID, true);

        $updated = isset($_GET['updated']) && (string) $_GET['updated'] === '1';
        $created = isset($_GET['created']) && (string) $_GET['created'] === '1';
        $error = isset($_GET['error']) ? sanitize_text_field((string) $_GET['error']) : '';

        $notice_created = '';
        if ($is_admin_view) {
            $key = 'sosprescription_doctor_created_notice_' . $current_id;
            $payload = get_transient($key);
            if (is_array($payload)) {
                delete_transient($key);
                $login = isset($payload['login']) ? (string) $payload['login'] : '';
                $pass = isset($payload['pass']) ? (string) $payload['pass'] : '';
                $email = isset($payload['email']) ? (string) $payload['email'] : '';
                $notice_created = '<div class="notice notice-success" style="margin:14px 0;">'
                    . '<p><strong>Compte médecin créé.</strong> Pensez à transmettre ces informations en canal sécurisé.</p>'
                    . '<p><code>Login</code> : ' . esc_html($login) . '<br/><code>Email</code> : ' . esc_html($email) . '<br/><code>Mot de passe temporaire</code> : <code>' . esc_html($pass) . '</code></p>'
                    . '</div>';
            }
        }

        $title = $is_self ? 'Mon compte médecin' : ('Compte médecin : ' . (string) $user->display_name);

        ob_start();
        echo '<div class="wrap" style="max-width:980px; margin: 0 auto;">';
        echo '<h1 style="display:flex; align-items:center; gap:10px; margin: 22px 0 12px;">';
        echo '<img src="' . esc_url(SOSPRESCRIPTION_URL . 'assets/caduceus.svg') . '" alt="" style="width:26px;height:26px;" />';
        echo '<span>' . esc_html($title) . '</span>';
        echo '</h1>';

        echo '<p style="max-width:980px; color:#374151;">'
            . 'Complétez vos informations professionnelles (RPPS, spécialité, adresse) et ajoutez votre signature. '
            . 'Ces informations seront utilisées pour générer les documents médicaux (ordonnances, compte-rendus) dans les prochaines versions.'
            . '</p>';

        if ($updated) {
            echo '<div class="notice notice-success is-dismissible" style="margin:14px 0;"><p>Profil enregistré.</p></div>';
        }
        if ($created) {
            echo '<div class="notice notice-success is-dismissible" style="margin:14px 0;"><p>Compte médecin créé.</p></div>';
        }
        if ($error !== '') {
            echo '<div class="notice notice-error" style="margin:14px 0;"><p>' . esc_html($error) . '</p></div>';
        }
        if ($notice_created !== '') {
            echo $notice_created; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
        }

        // --- Profil médecin
        echo '<div style="background:#fff;border:1px solid #dcdcde;border-radius:12px;padding:16px;margin:14px 0;">';
        echo '<h2 style="margin-top:0;">Informations professionnelles</h2>';

        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '" enctype="multipart/form-data">';
        echo '<input type="hidden" name="action" value="sosprescription_doctor_profile_save" />';
        echo '<input type="hidden" name="user_id" value="' . esc_attr((string) $user->ID) . '" />';
        wp_nonce_field('sosprescription_doctor_profile_save');

        echo '<table class="form-table" role="presentation"><tbody>';

        echo '<tr><th scope="row">Email</th><td><code>' . esc_html((string) $user->user_email) . '</code></td></tr>';

        echo '<tr><th scope="row"><label for="sp_doc_title">Titre</label></th><td>';
        echo '<select id="sp_doc_title" name="doctor_title">';
        $title_value = $doctor_title !== '' ? $doctor_title : 'docteur';
        echo '<option value="docteur"' . selected($title_value, 'docteur', false) . '>Docteur (Dr)</option>';
        echo '<option value="professeur"' . selected($title_value, 'professeur', false) . '>Professeur (Pr)</option>';
        echo '</select>';
        echo '<p class="description">Affichage sur l’ordonnance (en-tête) : <code>Dr</code> ou <code>Pr</code>.</p>';
        echo '</td></tr>';

        echo '<tr><th scope="row"><label for="sp_doc_display_name">Nom affiché</label></th><td>';
        echo '<input class="regular-text" type="text" id="sp_doc_display_name" name="display_name" value="' . esc_attr((string) $user->display_name) . '" />';
        echo '<p class="description">Nom affiché dans la console et, plus tard, sur les documents.</p>';
        echo '</td></tr>';

        echo '<tr><th scope="row"><label for="sp_doc_rpps">RPPS</label></th><td>';
        echo '<input class="regular-text" type="text" id="sp_doc_rpps" name="rpps" value="' . esc_attr($rpps) . '" placeholder="Ex: 10001234567" />';
        echo '<p class="description">Identifiant RPPS du prescripteur. Recommandé (conformité).</p>';
        echo '</td></tr>';

        echo '<tr><th scope="row"><label for="sp_doc_specialty">Spécialité / qualification</label></th><td>';
        echo '<input class="regular-text" type="text" id="sp_doc_specialty" name="specialty" value="' . esc_attr($specialty) . '" placeholder="Ex: Médecin généraliste" />';
        echo '</td></tr>';

        // Ordonnance "Premium" : Diplôme + lieu de signature
        echo '<tr><th scope="row"><label for="sp_doc_diploma_label">Diplôme (libellé)</label></th><td>';
        echo '<input class="regular-text" type="text" id="sp_doc_diploma_label" name="diploma_label" value="' . esc_attr($diploma_label) . '" placeholder="Ex: Diplômé Faculté" />';
        echo '<p class="description">Texte affiché sur l’ordonnance (ex: <code>Diplômé Faculté</code>).</p>';
        echo '</td></tr>';

        echo '<tr><th scope="row"><label for="sp_doc_diploma_university">Université / lieu</label></th><td>';
        echo '<input class="regular-text" type="text" id="sp_doc_diploma_university" name="diploma_university_location" value="' . esc_attr($diploma_university_location) . '" placeholder="Ex: Paris XIII" />';
        echo '<p class="description">Exemple affichage : <code>Diplômé Faculté Paris XIII</code>.</p>';
        echo '</td></tr>';

        echo '<tr><th scope="row"><label for="sp_doc_diploma_honors">Distinctions (optionnel)</label></th><td>';
        echo '<input class="regular-text" type="text" id="sp_doc_diploma_honors" name="diploma_honors" value="' . esc_attr($diploma_honors) . '" placeholder="Ex: Lauréat de l\'Académie" />';
        echo '<p class="description">Ajouté après un séparateur • si renseigné.</p>';
        echo '</td></tr>';

        echo '<tr><th scope="row"><label for="sp_doc_issue_place">Lieu de signature</label></th><td>';
        echo '<input class="regular-text" type="text" id="sp_doc_issue_place" name="issue_place" value="' . esc_attr($issue_place) . '" placeholder="Ex: Saint-Laurent-du-Var" />';
        echo '<p class="description">Sera utilisé dans le footer : <code>Fait à …, le …</code>.</p>';
        echo '</td></tr>';

        echo '<tr><th scope="row"><label for="sp_doc_address">Adresse professionnelle</label></th><td>';
        echo '<textarea class="large-text" rows="4" id="sp_doc_address" name="address" placeholder="Adresse (cabinet / structure)">' . esc_textarea($address) . '</textarea>';
        echo '<p class="description">Cette adresse pourra apparaître sur l’ordonnance PDF.</p>';
        echo '</td></tr>';

        echo '<tr><th scope="row"><label for="sp_doc_phone">Téléphone professionnel</label></th><td>';
        echo '<input class="regular-text" type="text" id="sp_doc_phone" name="phone" value="' . esc_attr($phone) . '" placeholder="Ex: 01 23 45 67 89" />';
        echo '</td></tr>';

        // Signature
        echo '<tr><th scope="row">Signature</th><td>';
        if ($sig_file_id > 0) {
            $download_url = wp_nonce_url(
                admin_url('admin-post.php?action=sosprescription_doctor_file_download&file_id=' . $sig_file_id . '&inline=1'),
                'sosprescription_doctor_file_download'
            );
            echo '<div style="margin-bottom:10px;">✅ Signature enregistrée (fichier #' . esc_html((string) $sig_file_id) . ') — '
                . '<a href="' . esc_url($download_url) . '" target="_blank" rel="noopener">Prévisualiser</a>'
                . '</div>';
            echo '<label style="display:block; margin:8px 0;"><input type="checkbox" name="remove_signature" value="1" /> Supprimer la signature actuelle</label>';
        } else {
            echo '<div style="margin-bottom:10px; color:#6b7280;">Aucune signature enregistrée.</div>';
        }

        // Custom file input (label styled as a button) + real-time validation + preview + drag&drop + dimensions hint.
        echo '<div class="sp-signature-upload-wrap">';
        echo '<input type="file" id="signature_file" class="sp-hidden-file-input" name="signature_file" accept="image/png,image/jpeg" />';
        echo '<label for="signature_file" id="sp_signature_label" class="sp-custom-file-upload custom-file-upload" tabindex="0" role="button" aria-label="Choisir une signature (PNG/JPG) ou glisser-déposer">'
            . '<span class="sp-signature-upload-icon" aria-hidden="true">'
            . '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">'
            . '<path d="M12 3v10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
            . '<path d="M8 7l4-4 4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
            . '<path d="M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
            . '</svg>'
            . '</span>'
            . '<span class="sp-signature-upload-text">'
            . '<strong id="sp_signature_label_text">Cliquez ou glissez-déposez votre signature (PNG/JPG)</strong>'
            . '<span>Recommandé : 800×200 px • &lt; 1 Mo (idéal &lt; 200ko) • fond transparent ou blanc</span>'
            . '</span>'
            . '</label>';

        echo '<div id="sp_signature_error" class="sp-signature-error" style="display:none" role="alert" aria-live="polite"></div>';
        echo '<div id="sp_signature_meta" class="sp-signature-meta" style="display:none" aria-live="polite"></div>';
        echo '<div id="sp_signature_preview" class="sp-signature-preview" style="display:none">'
            . '<div class="sp-signature-preview-row">'
            . '<img id="sp_signature_preview_img" alt="Prévisualisation de la signature" />'
            . '<button type="button" id="sp_signature_clear" class="sp-signature-clear">Retirer</button>'
            . '</div>'
            . '</div>';
        echo '</div>';

        echo '<p class="description">Le fichier est stocké en privé (non public). <strong>Astuce :</strong> exportez votre signature en PNG (fond transparent) et recadrez-la au plus près (sans marges) pour un rendu premium sur l’ordonnance. <strong>Recommandé :</strong> <span style="white-space:nowrap;">800×200px</span> (ou largeur 600–1000px, hauteur 120–250px), idéalement <strong>&lt; 200ko</strong>.</p>';
        echo '</td></tr>';

        echo '</tbody></table>';

        echo '<p style="margin: 14px 0 0;">';
        echo '<button type="submit" class="button button-primary">Enregistrer</button>';
        if (!$is_self && $is_admin_view) {
            $back = remove_query_arg('doctor_user_id');
            echo ' <a class="button" href="' . esc_url($back) . '">Retour</a>';
        }
        echo '</p>';
        echo '</form>';
        echo '</div>';

        // --- Admin : liste & création médecins
        if ($is_admin_view) {
            echo '<div style="background:#fff;border:1px solid #dcdcde;border-radius:12px;padding:16px;margin:14px 0;">';
            echo '<h2 style="margin-top:0;">Gestion des médecins</h2>';
            echo '<p class="description">Création rapide + accès à l’édition du profil (RPPS, signature…).</p>';

            // Create form
            echo '<h3>Créer un compte médecin</h3>';
            echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
            echo '<input type="hidden" name="action" value="sosprescription_doctor_create" />';
            wp_nonce_field('sosprescription_doctor_create');
            echo '<table class="form-table" role="presentation"><tbody>';
            echo '<tr><th scope="row"><label for="sp_new_doc_email">Email</label></th><td><input class="regular-text" type="email" id="sp_new_doc_email" name="email" required /></td></tr>';
            echo '<tr><th scope="row"><label for="sp_new_doc_name">Nom affiché</label></th><td><input class="regular-text" type="text" id="sp_new_doc_name" name="display_name" placeholder="Dr …" /></td></tr>';
            echo '<tr><th scope="row"><label for="sp_new_doc_rpps">RPPS</label></th><td><input class="regular-text" type="text" id="sp_new_doc_rpps" name="rpps" placeholder="1000…" /></td></tr>';
            echo '</tbody></table>';
            echo '<p><button type="submit" class="button">Créer</button></p>';
            echo '</form>';

            // List doctors
            echo '<h3 style="margin-top:22px;">Comptes médecins existants</h3>';
            $doctors = get_users([
                'role__in' => ['sosprescription_doctor'],
                'orderby' => 'display_name',
                'order' => 'ASC',
                'number' => 200,
            ]);

            if (empty($doctors)) {
                echo '<div class="notice notice-info"><p>Aucun compte médecin (rôle <code>sosprescription_doctor</code>) trouvé.</p></div>';
            } else {
                echo '<div style="overflow:auto;">';
                echo '<table class="widefat striped">';
                echo '<thead><tr><th>Nom</th><th>Email</th><th>RPPS</th><th style="text-align:right;">Action</th></tr></thead><tbody>';
                foreach ($doctors as $d) {
                    $d_id = (int) $d->ID;
                    $d_rpps = (string) get_user_meta($d_id, self::META_RPPS, true);
                    $edit_url = add_query_arg(['doctor_user_id' => $d_id], (string) get_permalink());
                    echo '<tr>';
                    echo '<td>' . esc_html((string) $d->display_name) . '</td>';
                    echo '<td><code>' . esc_html((string) $d->user_email) . '</code></td>';
                    echo '<td><code>' . esc_html($d_rpps !== '' ? $d_rpps : '—') . '</code></td>';
                    echo '<td style="text-align:right;"><a class="button button-small" href="' . esc_url($edit_url) . '">Éditer</a></td>';
                    echo '</tr>';
                }
                echo '</tbody></table>';
                echo '</div>';
            }

            echo '</div>';
        }

        echo '</div>';

        $html = (string) ob_get_clean();
        return $html;
    }

    public static function handle_profile_save(): void
    {
        if (!is_user_logged_in()) {
            wp_die('Connexion requise.');
        }
        if (!self::can_access_doctor_area()) {
            wp_die('Accès refusé.');
        }

        check_admin_referer('sosprescription_doctor_profile_save');

        $current_id = (int) get_current_user_id();
        $target_id = isset($_POST['user_id']) ? (int) $_POST['user_id'] : $current_id;
        if ($target_id < 1) {
            $target_id = $current_id;
        }

        if ($target_id !== $current_id && !self::can_manage_doctors()) {
            wp_die('Accès refusé.');
        }

        $display_name = isset($_POST['display_name']) ? sanitize_text_field((string) wp_unslash($_POST['display_name'])) : '';
        $rpps = isset($_POST['rpps']) ? preg_replace('/[^0-9]/', '', (string) wp_unslash($_POST['rpps'])) : '';
        $specialty = isset($_POST['specialty']) ? sanitize_text_field((string) wp_unslash($_POST['specialty'])) : '';
        $address = isset($_POST['address']) ? sanitize_textarea_field((string) wp_unslash($_POST['address'])) : '';
        $phone = isset($_POST['phone']) ? sanitize_text_field((string) wp_unslash($_POST['phone'])) : '';

        // "Premium" ordonnance
        $diploma_label = isset($_POST['diploma_label']) ? sanitize_text_field((string) wp_unslash($_POST['diploma_label'])) : '';
        $diploma_university_location = isset($_POST['diploma_university_location']) ? sanitize_text_field((string) wp_unslash($_POST['diploma_university_location'])) : '';
        $diploma_honors = isset($_POST['diploma_honors']) ? sanitize_text_field((string) wp_unslash($_POST['diploma_honors'])) : '';
        $issue_place = isset($_POST['issue_place']) ? sanitize_text_field((string) wp_unslash($_POST['issue_place'])) : '';

        // Titre (Docteur / Professeur)
        $doctor_title = isset($_POST['doctor_title']) ? sanitize_text_field((string) wp_unslash($_POST['doctor_title'])) : '';
        $allowed_titles = ['docteur', 'professeur'];
        if (!in_array($doctor_title, $allowed_titles, true)) {
            $doctor_title = 'docteur';
        }

        // display_name (WP user)
        if ($display_name !== '') {
            wp_update_user([
                'ID' => $target_id,
                'display_name' => $display_name,
            ]);
        }

        // user meta
        update_user_meta($target_id, self::META_TITLE, (string) $doctor_title);
        update_user_meta($target_id, self::META_RPPS, (string) $rpps);
        update_user_meta($target_id, self::META_SPECIALTY, (string) $specialty);
        update_user_meta($target_id, self::META_ADDRESS, (string) $address);
        update_user_meta($target_id, self::META_PHONE, (string) $phone);

        update_user_meta($target_id, self::META_DIPLOMA_LABEL, (string) $diploma_label);
        update_user_meta($target_id, self::META_DIPLOMA_UNIVERSITY_LOCATION, (string) $diploma_university_location);
        update_user_meta($target_id, self::META_DIPLOMA_HONORS, (string) $diploma_honors);
        update_user_meta($target_id, self::META_ISSUE_PLACE, (string) $issue_place);

        // Remove signature
        $remove_signature = isset($_POST['remove_signature']) && (string) wp_unslash($_POST['remove_signature']) === '1';
        if ($remove_signature) {
            delete_user_meta($target_id, self::META_SIG_FILE_ID);
        }

        // Upload signature if provided
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
                update_user_meta($target_id, self::META_SIG_FILE_ID, $file_id);
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

        // Génère un login à partir de l'email (unique)
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

        update_user_meta((int) $user_id, self::META_RPPS, (string) $rpps);

        // Tente d'envoyer un email WordPress standard (si configuré)
        if (function_exists('wp_new_user_notification')) {
            // Notify user only
            @wp_new_user_notification((int) $user_id, null, 'user');
        }

        // Notice one-shot pour l'admin
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
}
