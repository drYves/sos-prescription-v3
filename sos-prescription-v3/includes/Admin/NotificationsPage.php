<?php
declare(strict_types=1);

namespace SOSPrescription\Admin;

use SOSPrescription\Services\NotificationsConfig;
use SOSPrescription\Services\Notifications;
use SOSPrescription\Services\Audit;

final class NotificationsPage
{
    public static function register_actions(): void
    {
        add_action('admin_post_sosprescription_notifications_save', [self::class, 'handle_save']);
        add_action('admin_post_sosprescription_notifications_test', [self::class, 'handle_test']);
    }

    public static function render_page(): void
    {
        if (!current_user_can('sosprescription_manage') && !current_user_can('manage_options')) {
            wp_die('Accès refusé.');
        }

        $cfg = NotificationsConfig::get();

        $updated = isset($_GET['updated']) && (string) $_GET['updated'] === '1';

        echo '<div class="wrap">';
        echo '<h1 style="display:flex; align-items:center; gap:10px;">';
        echo '<img src="' . esc_url(SOSPRESCRIPTION_URL . 'assets/caduceus.svg') . '" alt="" style="width:26px;height:26px;" />';
        echo '<span>Notifications</span>';
        echo '</h1>';

        echo '<p style="max-width:980px;">';
        echo '<strong>Objectif :</strong> informer patient/médecin qu\'une mise à jour existe, <strong>sans aucune donnée de santé</strong> dans les emails/SMS.';
        echo '</p>';

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
        echo '<table class="form-table" role="presentation"><tbody>';

        echo '<tr><th scope="row">Page <em>Espace patient</em></th><td>';
        wp_dropdown_pages([
            'name' => 'patient_portal_page_id',
            'selected' => (int) $cfg['patient_portal_page_id'],
            'show_option_none' => '— Non configuré (home) —',
            'option_none_value' => '0',
        ]);
        echo '<p class="description">Cette page doit contenir le shortcode <code>[sosprescription_patient]</code>.</p>';
        echo '</td></tr>';

        echo '<tr><th scope="row">Page <em>Console médecin</em> (optionnel)</th><td>';
        wp_dropdown_pages([
            'name' => 'doctor_console_page_id',
            'selected' => (int) $cfg['doctor_console_page_id'],
            'show_option_none' => '— Non configuré (wp-admin) —',
            'option_none_value' => '0',
        ]);
        echo '<p class="description">Optionnel. Utilisé pour les notifications médecin. Cette page doit contenir <code>[sosprescription_admin]</code>.</p>';
        echo '</td></tr>';

        echo '</tbody></table>';

        echo '<hr style="margin:18px 0;" />';

        echo '<h2>SMS (optionnel)</h2>';
        echo '<p class="description">Recommandation MVP : commencer par l\'email. Le SMS peut être activé ensuite (webhook interne / prestataire).</p>';

        echo '<label style="display:flex; align-items:center; gap:8px; margin:10px 0;">';
        echo '<input type="checkbox" name="sms_enabled" value="1" ' . checked((bool) $cfg['sms_enabled'], true, false) . ' />';
        echo '<strong>Activer les notifications SMS (via webhook)</strong>';
        echo '</label>';

        echo '<table class="form-table" role="presentation"><tbody>';

        echo '<tr><th scope="row"><label for="sp_sms_phone_meta_key">Clé meta WP du téléphone</label></th><td>';
        echo '<input class="regular-text" type="text" id="sp_sms_phone_meta_key" name="sms_phone_meta_key" value="' . esc_attr((string) $cfg['sms_phone_meta_key']) . '" />';
        echo '<p class="description">Ex: <code>billing_phone</code> (WooCommerce) ou <code>sosprescription_phone</code> (à définir).</p>';
        echo '</td></tr>';

        echo '<tr><th scope="row"><label for="sp_sms_webhook_url">Webhook URL</label></th><td>';
        echo '<input class="large-text" type="url" id="sp_sms_webhook_url" name="sms_webhook_url" value="' . esc_attr((string) $cfg['sms_webhook_url']) . '" placeholder="https://..." />';
        echo '<p class="description">Le plugin enverra un POST JSON {to, message, event, prescription_id}.</p>';
        echo '</td></tr>';

        echo '<tr><th scope="row"><label for="sp_sms_webhook_secret">Secret (Bearer)</label></th><td>';
        echo '<input class="regular-text" type="text" id="sp_sms_webhook_secret" name="sms_webhook_secret" value="' . esc_attr((string) $cfg['sms_webhook_secret']) . '" />';
        echo '<p class="description">Optionnel. Ajouté en header <code>Authorization: Bearer ...</code>.</p>';
        echo '</td></tr>';

        echo '<tr><th scope="row">Quiet hours SMS</th><td>';
        echo '<label style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">';
        echo '<input type="checkbox" name="sms_quiet_hours_enabled" value="1" ' . checked((bool) $cfg['sms_quiet_hours_enabled'], true, false) . ' />';
        echo '<span>Ne pas envoyer de SMS la nuit (envoi différé via WP-Cron)</span>';
        echo '</label>';
        echo '<div style="display:flex; gap:10px; align-items:center;">';
        echo '<input type="text" name="sms_quiet_start" value="' . esc_attr((string) $cfg['sms_quiet_start']) . '" style="width:90px;" />';
        echo '<span>→</span>';
        echo '<input type="text" name="sms_quiet_end" value="' . esc_attr((string) $cfg['sms_quiet_end']) . '" style="width:90px;" />';
        echo '<span class="description">Format HH:MM (ex: 22:00 → 08:00)</span>';
        echo '</div>';
        echo '</td></tr>';

        echo '</tbody></table>';

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

        // --- Test notifications
        $test = isset($_GET['test']) ? (string) $_GET['test'] : '';
        $test_channel = isset($_GET['channel']) ? (string) $_GET['channel'] : '';

        if ($test === 'ok') {
            echo '<div class="notice notice-success is-dismissible"><p>Test ' . esc_html($test_channel) . ' : envoyé.</p></div>';
        } elseif ($test === 'fail') {
            echo '<div class="notice notice-error is-dismissible"><p>Test ' . esc_html($test_channel) . ' : échec. Vérifiez la configuration (SMTP / webhook) et les logs.</p></div>';
        }

        $user = wp_get_current_user();
        $default_email = $user && $user->user_email ? (string) $user->user_email : '';
        $default_phone = '';
        $meta_key = isset($cfg['sms_phone_meta_key']) ? (string) $cfg['sms_phone_meta_key'] : '';
        if ($meta_key !== '') {
            $maybe = get_user_meta((int) get_current_user_id(), $meta_key, true);
            if (is_string($maybe) && trim($maybe) !== '') {
                $default_phone = trim($maybe);
            }
        }

        echo '<div style="max-width:980px;background:#fff;border:1px solid #dcdcde;border-radius:12px;padding:16px;margin:14px 0;">';
        echo '<h2 style="margin-top:0;">Tester l’envoi</h2>';
        echo '<p class="description">Envoie un message de test <strong>sans donnée de santé</strong> vers une adresse email ou un numéro. Utile pour valider SMTP / webhook SMS.</p>';

        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        echo '<input type="hidden" name="action" value="sosprescription_notifications_test" />';
        wp_nonce_field('sosprescription_notifications_test');

        echo '<div style="display:flex; gap:18px; flex-wrap:wrap; align-items:flex-end;">';

        echo '<div>';
        echo '<label style="display:block; font-weight:600; margin-bottom:6px;">Canal</label>';
        echo '<label style="margin-right:12px;"><input type="radio" name="channel" value="email" checked /> Email</label>';
        echo '<label><input type="radio" name="channel" value="sms" /> SMS</label>';
        echo '</div>';

        echo '<div style="min-width:320px;">';
        echo '<label for="sp_test_to" style="display:block; font-weight:600; margin-bottom:6px;">Destinataire</label>';
        echo '<input id="sp_test_to" class="regular-text" type="text" name="to" value="' . esc_attr($default_email) . '" placeholder="email@domaine.fr ou +336..." />';
        echo '<div class="description">Astuce : pour SMS, mettez un numéro au format international (+33...).</div>';
        echo '</div>';

        echo '<div>';
        echo '<label style="display:block; font-weight:600; margin-bottom:6px;">Options</label>';
        echo '<label><input type="checkbox" name="force_now" value="1" /> Forcer l’envoi SMS (ignorer quiet hours)</label>';
        echo '</div>';

        echo '<div>';
        echo '<button type="submit" class="button">Envoyer un test</button>';
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
        $sms_enabled = isset($_POST['sms_enabled']);

        $from_name = isset($_POST['from_name']) ? (string) wp_unslash($_POST['from_name']) : '';
        $from_email = isset($_POST['from_email']) ? (string) wp_unslash($_POST['from_email']) : '';

        $patient_page_id = isset($_POST['patient_portal_page_id']) ? (int) $_POST['patient_portal_page_id'] : 0;
        $doctor_page_id = isset($_POST['doctor_console_page_id']) ? (int) $_POST['doctor_console_page_id'] : 0;

        $sms_phone_meta_key = isset($_POST['sms_phone_meta_key']) ? sanitize_key((string) wp_unslash($_POST['sms_phone_meta_key'])) : '';
        $sms_webhook_url = isset($_POST['sms_webhook_url']) ? esc_url_raw((string) wp_unslash($_POST['sms_webhook_url'])) : '';
        $sms_webhook_secret = isset($_POST['sms_webhook_secret']) ? trim((string) wp_unslash($_POST['sms_webhook_secret'])) : '';

        $sms_quiet_hours_enabled = isset($_POST['sms_quiet_hours_enabled']);
        $sms_quiet_start = isset($_POST['sms_quiet_start']) ? (string) wp_unslash($_POST['sms_quiet_start']) : '22:00';
        $sms_quiet_end = isset($_POST['sms_quiet_end']) ? (string) wp_unslash($_POST['sms_quiet_end']) : '08:00';

        $send_on_payment_confirmed = isset($_POST['send_on_payment_confirmed']);
        $send_on_assigned = isset($_POST['send_on_assigned']);
        $send_on_doctor_message = isset($_POST['send_on_doctor_message']);
        $send_on_decision = isset($_POST['send_on_decision']);

        $send_doctor_on_patient_message = isset($_POST['send_doctor_on_patient_message']);

        NotificationsConfig::update([
            'email_enabled' => $email_enabled,
            'sms_enabled' => $sms_enabled,
            'from_name' => $from_name,
            'from_email' => $from_email,
            'patient_portal_page_id' => $patient_page_id,
            'doctor_console_page_id' => $doctor_page_id,
            'sms_provider' => 'webhook',
            'sms_phone_meta_key' => $sms_phone_meta_key,
            'sms_webhook_url' => $sms_webhook_url,
            'sms_webhook_secret' => $sms_webhook_secret,
            'sms_quiet_hours_enabled' => $sms_quiet_hours_enabled,
            'sms_quiet_start' => $sms_quiet_start,
            'sms_quiet_end' => $sms_quiet_end,
            'send_on_payment_confirmed' => $send_on_payment_confirmed,
            'send_on_assigned' => $send_on_assigned,
            'send_on_doctor_message' => $send_on_doctor_message,
            'send_on_decision' => $send_on_decision,
            'send_doctor_on_patient_message' => $send_doctor_on_patient_message,
        ]);

        Audit::log('config_notifications_update', 'config', null, null, [
            'email_enabled' => (bool) $email_enabled,
            'sms_enabled' => (bool) $sms_enabled,
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

        $channel = isset($_POST['channel']) ? (string) wp_unslash($_POST['channel']) : 'email';
        $to = isset($_POST['to']) ? trim((string) wp_unslash($_POST['to'])) : '';
        $force_now = isset($_POST['force_now']);

        $ok = false;
        if ($channel === 'sms') {
            // Format libre (validation minimale).
            if (strlen($to) < 6) {
                $ok = false;
            } else {
                $ok = Notifications::send_test_sms($to, $force_now);
            }
        } else {
            $channel = 'email';
            if (!is_email($to)) {
                $ok = false;
            } else {
                $ok = Notifications::send_test_email($to);
            }
        }

        Audit::log('notifications_test', 'config', null, null, [
            'channel' => $channel,
            'ok' => (bool) $ok,
        ]);

        $url = add_query_arg([
            'page' => 'sosprescription-notifications',
            'test' => $ok ? 'ok' : 'fail',
            'channel' => $channel,
        ], admin_url('admin.php'));

        wp_safe_redirect($url);
        exit;
    }

}
