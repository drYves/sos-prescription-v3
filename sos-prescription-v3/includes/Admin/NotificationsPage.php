<?php
declare(strict_types=1);

namespace SosPrescription\Admin;

use SosPrescription\Services\NotificationsConfig;
use SosPrescription\Services\Notifications;
use SosPrescription\Services\Audit;

final class NotificationsPage
{
    private const LEGACY_TWILIO_SETTINGS_OPTION_KEY = 'sosprescription_twilio_settings';
    private const TWILIO_NUMBER_OPTION_KEY = 'sosprescription_twilio_number';
    private const TWILIO_SETTINGS_GROUP = 'sosprescription_twilio_settings_group';
    private const TWILIO_SETTINGS_PAGE = 'sosprescription_twilio_settings_page';
    private const TWILIO_SETTINGS_SECTION = 'sosprescription_twilio_main';

    /** @var bool */
    private static $twilio_settings_registered = false;

    public static function register_actions(): void
    {
        add_action('admin_init', [self::class, 'register_settings']);
        add_filter('option_page_capability_' . self::TWILIO_SETTINGS_GROUP, [self::class, 'twilio_settings_capability']);
        add_action('admin_post_sosprescription_notifications_save', [self::class, 'handle_save']);
        add_action('admin_post_sosprescription_notifications_test', [self::class, 'handle_test']);
    }

    public static function twilio_settings_capability(string $capability = ''): string
    {
        return current_user_can('manage_options') ? 'manage_options' : 'sosprescription_manage';
    }

    public static function register_settings(): void
    {
        if (self::$twilio_settings_registered) {
            return;
        }

        self::$twilio_settings_registered = true;

        self::migrate_legacy_twilio_number_option();
        self::register_twilio_number_setting();

        add_settings_section(
            self::TWILIO_SETTINGS_SECTION,
            'Téléphonie / Twilio',
            [self::class, 'render_twilio_section_intro'],
            self::TWILIO_SETTINGS_PAGE
        );

        add_settings_field(
            self::TWILIO_NUMBER_OPTION_KEY,
            'Numéro Twilio',
            [self::class, 'render_twilio_number_field'],
            self::TWILIO_SETTINGS_PAGE,
            self::TWILIO_SETTINGS_SECTION,
            [
                'label_for' => self::TWILIO_NUMBER_OPTION_KEY,
            ]
        );
    }

    private static function register_twilio_number_setting(): void
    {
        // options.php n’accepte le POST que si ce groupe/nom d’option a été enregistré sur admin_init.
        register_setting(
            self::TWILIO_SETTINGS_GROUP,
            self::TWILIO_NUMBER_OPTION_KEY,
            [
                'type' => 'string',
                'sanitize_callback' => [self::class, 'sanitize_twilio_number'],
                'default' => self::get_twilio_number(),
            ]
        );
    }

    /**
     * @param mixed $input
     */
    public static function sanitize_twilio_number($input): string
    {
        $raw = is_scalar($input) ? trim((string) $input) : '';
        $normalized = self::normalize_phone_value($raw);

        if ($raw !== '' && $normalized === '') {
            add_settings_error(
                self::TWILIO_NUMBER_OPTION_KEY,
                'sosprescription_twilio_number_invalid',
                'Le numéro Twilio doit être saisi dans un format téléphonique valide.',
                'error'
            );

            return self::get_twilio_number();
        }

        add_settings_error(
            self::TWILIO_NUMBER_OPTION_KEY,
            'sosprescription_twilio_number_saved',
            'Numéro Twilio enregistré.',
            'updated'
        );

        return $normalized;
    }

    private static function migrate_legacy_twilio_number_option(): void
    {
        $current = get_option(self::TWILIO_NUMBER_OPTION_KEY, null);
        if (is_string($current) && self::normalize_phone_value($current) !== '') {
            return;
        }

        $legacy = get_option(self::LEGACY_TWILIO_SETTINGS_OPTION_KEY, []);
        if (!is_array($legacy)) {
            return;
        }

        $legacy_number = self::normalize_phone_value($legacy['twilio_number'] ?? '');
        if ($legacy_number === '') {
            return;
        }

        update_option(self::TWILIO_NUMBER_OPTION_KEY, $legacy_number);
    }

    private static function get_twilio_number(): string
    {
        $current = get_option(self::TWILIO_NUMBER_OPTION_KEY, '');
        $normalized = self::normalize_phone_value($current);
        if ($normalized !== '') {
            return $normalized;
        }

        $legacy = get_option(self::LEGACY_TWILIO_SETTINGS_OPTION_KEY, []);
        if (!is_array($legacy)) {
            return '';
        }

        return self::normalize_phone_value($legacy['twilio_number'] ?? '');
    }

    /**
     * @param mixed $value
     */
    private static function normalize_phone_value($value): string
    {
        if (!is_scalar($value)) {
            return '';
        }

        $normalized = trim(wp_strip_all_tags((string) $value));
        if ($normalized === '') {
            return '';
        }

        $normalized = preg_replace('/[\s\-\.\(\)]+/', '', $normalized) ?: $normalized;
        if (strpos($normalized, '00') === 0) {
            $normalized = '+' . substr($normalized, 2);
        }

        $normalized = preg_replace('/(?!^\+)[^0-9]/', '', $normalized) ?: $normalized;

        return $normalized;
    }

    public static function render_twilio_section_intro(): void
    {
        echo '<p class="description">Configurez le numéro Twilio SOS Prescription affiché aux patients.</p>';
        echo '<p class="description">Les appels entrants sont ensuite routés dynamiquement vers le médecin concerné via le code de délivrance saisi sur la ligne médicale sécurisée.</p>';
    }

    public static function render_twilio_number_field(): void
    {
        $value = self::get_twilio_number();

        echo '<input class="regular-text" type="text" id="' . esc_attr(self::TWILIO_NUMBER_OPTION_KEY) . '" name="' . esc_attr(self::TWILIO_NUMBER_OPTION_KEY) . '" value="' . esc_attr($value) . '" placeholder="+33..." />';
        echo '<p class="description">Numéro attribué par la plateforme et affiché aux patients. Format international recommandé.</p>';
    }

    public static function render_page(): void
    {
        if (!current_user_can('sosprescription_manage') && !current_user_can('manage_options')) {
            wp_die('Accès refusé.');
        }

        self::register_settings();

        $cfg = NotificationsConfig::get();
        $updated = isset($_GET['updated']) && (string) $_GET['updated'] === '1';

        echo '<div class="wrap">';
        echo '<h1 style="display:flex; align-items:center; gap:10px;">';
        echo '<img src="' . esc_url(SOSPRESCRIPTION_URL . 'assets/caduceus.svg') . '" alt="" style="width:26px;height:26px;" />';
        echo '<span>Notifications</span>';
        echo '</h1>';

        echo '<p style="max-width:980px;">';
        echo '<strong>Objectif :</strong> informer patient/médecin par email, et configurer la téléphonie Twilio de la ligne médicale sécurisée, <strong>sans aucune donnée de santé</strong> dans les notifications.';
        echo '</p>';

        settings_errors(self::TWILIO_NUMBER_OPTION_KEY);

        if ($updated) {
            echo '<div class="notice notice-success is-dismissible"><p>Paramètres enregistrés.</p></div>';
        }

        echo '<div style="max-width:980px;background:#fff;border:1px solid #dcdcde;border-radius:12px;padding:16px;margin:14px 0;">';
        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        echo '<input type="hidden" name="action" value="sosprescription_notifications_save" />';
        wp_nonce_field('sosprescription_notifications_save');

        echo '<h2 style="margin-top:0;">Email</h2>';

        echo '<label style="display:flex; align-items:center; gap:8px; margin:10px 0;">';
        echo '<input type="checkbox" name="email_enabled" value="1" ' . checked((bool) $cfg['email_enabled'], true, false) . ' />';
        echo '<strong>Activer les notifications email</strong>';
        echo '</label>';

        echo '<table class="form-table" role="presentation"><tbody>';

        echo '<tr><th scope="row"><label for="sp_from_name">Nom expéditeur</label></th><td>';
        echo '<input class="regular-text" type="text" id="sp_from_name" name="from_name" value="' . esc_attr((string) $cfg['from_name']) . '" />';
        echo '<p class="description">Ex: SOS Prescription</p>';
        echo '</td></tr>';

        echo '<tr><th scope="row"><label for="sp_from_email">Email expéditeur</label></th><td>';
        echo '<input class="regular-text" type="email" id="sp_from_email" name="from_email" value="' . esc_attr((string) $cfg['from_email']) . '" />';
        echo '<p class="description">Ex: noreply@votredomaine.fr (doit être valide / idéalement sur votre domaine)</p>';
        echo '</td></tr>';

        echo '</tbody></table>';

        echo '<hr style="margin:18px 0;" />';

        echo '<h2>Liens des espaces</h2>';
        echo '<div class="notice notice-info inline" style="margin:0 0 16px 0;"><p>Les pages <em>Espace patient</em> et <em>Console médecin</em> sont désormais gérées exclusivement dans <a href="' . esc_url(admin_url('admin.php?page=sosprescription')) . '">Installation &amp; statut</a>.</p></div>';

        echo '<hr style="margin:18px 0;" />';

        echo '<h2>Déclencheurs</h2>';
        echo '<p class="description">Vous pouvez activer/désactiver chaque type de notification.</p>';

        echo '<div style="display:grid; grid-template-columns: 1fr; gap:8px; max-width:720px;">';

        self::checkbox_row('send_on_payment_confirmed', 'Paiement autorisé / demande transmise au médecin', (bool) $cfg['send_on_payment_confirmed']);
        self::checkbox_row('send_on_assigned', 'Médecin en cours d\'analyse (assignation)', (bool) $cfg['send_on_assigned']);
        self::checkbox_row('send_on_doctor_message', 'Nouveau message du médecin', (bool) $cfg['send_on_doctor_message']);
        self::checkbox_row('send_on_decision', 'Décision (approuvée / refusée)', (bool) $cfg['send_on_decision']);

        echo '<hr style="margin:10px 0;" />';
        self::checkbox_row('send_doctor_on_patient_message', 'Médecin : nouveau message du patient (optionnel)', (bool) $cfg['send_doctor_on_patient_message']);

        echo '</div>';

        echo '<p style="margin-top:16px;"><button type="submit" class="button button-primary">Enregistrer</button></p>';

        echo '</form>';
        echo '</div>';

        echo '<div style="max-width:980px;background:#fff;border:1px solid #dcdcde;border-radius:12px;padding:16px;margin:14px 0;">';
        echo '<h2 style="margin-top:0;">Téléphonie / Twilio</h2>';
        echo '<p class="description">Le numéro Twilio est affiché aux patients. Le routage réel des appels est déterminé dynamiquement par le code de délivrance saisi dans l’assistant vocal.</p>';
        echo '<form method="post" action="' . esc_url(admin_url('options.php')) . '">';
        // Doit rester strictement aligné avec le groupe passé à register_setting().
        settings_fields(self::TWILIO_SETTINGS_GROUP);
        do_settings_sections(self::TWILIO_SETTINGS_PAGE);
        echo '<p style="margin-top:16px;">';
        submit_button('Enregistrer la téléphonie', 'primary', 'submit', false);
        echo '</p>';
        echo '</form>';
        echo '</div>';

        $test = isset($_GET['test']) ? (string) $_GET['test'] : '';
        $test_channel = isset($_GET['channel']) ? (string) $_GET['channel'] : '';

        if ($test === 'ok') {
            echo '<div class="notice notice-success is-dismissible"><p>Test ' . esc_html($test_channel) . ' : envoyé.</p></div>';
        } elseif ($test === 'fail') {
            echo '<div class="notice notice-error is-dismissible"><p>Test ' . esc_html($test_channel) . ' : échec. Vérifiez la configuration SMTP et les logs.</p></div>';
        }

        $user = wp_get_current_user();
        $default_email = $user && $user->user_email ? (string) $user->user_email : '';

        echo '<div style="max-width:980px;background:#fff;border:1px solid #dcdcde;border-radius:12px;padding:16px;margin:14px 0;">';
        echo '<h2 style="margin-top:0;">Tester l’envoi</h2>';
        echo '<p class="description">Envoie un message de test <strong>sans donnée de santé</strong>. Utile pour valider le canal email existant ; la téléphonie Twilio se valide via le webhook d’appel et le code de délivrance.</p>';

        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        echo '<input type="hidden" name="action" value="sosprescription_notifications_test" />';
        wp_nonce_field('sosprescription_notifications_test');

        echo '<input type="hidden" name="channel" value="email" />';
        echo '<div style="display:flex; gap:18px; flex-wrap:wrap; align-items:flex-end;">';

        echo '<div style="min-width:320px;">';
        echo '<label for="sp_test_to" style="display:block; font-weight:600; margin-bottom:6px;">Email destinataire</label>';
        echo '<input id="sp_test_to" class="regular-text" type="email" name="to" value="' . esc_attr($default_email) . '" placeholder="email@domaine.fr" />';
        echo '<div class="description">Ce test couvre uniquement l’envoi email.</div>';
        echo '</div>';

        echo '<div>';
        echo '<button type="submit" class="button">Envoyer un test email</button>';
        echo '</div>';

        echo '</div>';
        echo '</form>';
        echo '</div>';

        echo '</div>';
    }

    private static function checkbox_row(string $name, string $label, bool $checked): void
    {
        echo '<label style="display:flex; align-items:flex-start; gap:8px; padding:8px 10px; border:1px solid #e5e7eb; border-radius:10px; background:#fafafa;">';
        echo '<input type="checkbox" name="' . esc_attr($name) . '" value="1" ' . checked($checked, true, false) . ' />';
        echo '<span>' . esc_html($label) . '</span>';
        echo '</label>';
    }

    public static function handle_save(): void
    {
        if (!current_user_can('sosprescription_manage') && !current_user_can('manage_options')) {
            wp_die('Accès refusé.');
        }

        check_admin_referer('sosprescription_notifications_save');

        $email_enabled = isset($_POST['email_enabled']);

        $from_name = isset($_POST['from_name']) ? (string) wp_unslash($_POST['from_name']) : '';
        $from_email = isset($_POST['from_email']) ? (string) wp_unslash($_POST['from_email']) : '';

        $send_on_payment_confirmed = isset($_POST['send_on_payment_confirmed']);
        $send_on_assigned = isset($_POST['send_on_assigned']);
        $send_on_doctor_message = isset($_POST['send_on_doctor_message']);
        $send_on_decision = isset($_POST['send_on_decision']);
        $send_doctor_on_patient_message = isset($_POST['send_doctor_on_patient_message']);

        NotificationsConfig::update([
            'email_enabled' => $email_enabled,
            'sms_enabled' => false,
            'from_name' => $from_name,
            'from_email' => $from_email,
            'sms_provider' => '',
            'sms_phone_meta_key' => '',
            'sms_webhook_url' => '',
            'sms_webhook_secret' => '',
            'sms_quiet_hours_enabled' => false,
            'sms_quiet_start' => '22:00',
            'sms_quiet_end' => '08:00',
            'send_on_payment_confirmed' => $send_on_payment_confirmed,
            'send_on_assigned' => $send_on_assigned,
            'send_on_doctor_message' => $send_on_doctor_message,
            'send_on_decision' => $send_on_decision,
            'send_doctor_on_patient_message' => $send_doctor_on_patient_message,
        ]);

        Audit::log('config_notifications_update', 'config', null, null, [
            'email_enabled' => (bool) $email_enabled,
            'sms_enabled' => false,
        ]);

        $url = add_query_arg([
            'page' => 'sosprescription-notifications',
            'updated' => '1',
        ], admin_url('admin.php'));

        wp_safe_redirect($url);
        exit;
    }

    public static function handle_test(): void
    {
        if (!current_user_can('sosprescription_manage') && !current_user_can('manage_options')) {
            wp_die('Accès refusé.');
        }

        check_admin_referer('sosprescription_notifications_test');

        $to = isset($_POST['to']) ? trim((string) wp_unslash($_POST['to'])) : '';
        $ok = is_email($to) ? Notifications::send_test_email($to) : false;

        Audit::log('notifications_test', 'config', null, null, [
            'channel' => 'email',
            'ok' => (bool) $ok,
        ]);

        $url = add_query_arg([
            'page' => 'sosprescription-notifications',
            'test' => $ok ? 'ok' : 'fail',
            'channel' => 'email',
        ], admin_url('admin.php'));

        wp_safe_redirect($url);
        exit;
    }
}
