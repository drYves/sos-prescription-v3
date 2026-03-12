<?php
declare(strict_types=1);

namespace SOSPrescription\Services;

use SOSPrescription\Repositories\PrescriptionRepository;

/**
 * Service de notifications transactionnelles.
 *
 * Règle d'or : AUCUNE donnée de santé dans le contenu.
 * => uniquement des "pings" + lien vers l'espace sécurisé.
 */
final class Notifications
{
    public const EVENT_PAYMENT_CONFIRMED = 'payment_confirmed';
    public const EVENT_ASSIGNED = 'assigned';
    public const EVENT_DOCTOR_MESSAGE = 'doctor_message';
    public const EVENT_DECISION_APPROVED = 'decision_approved';
    public const EVENT_DECISION_REJECTED = 'decision_rejected';

    public const EVENT_DOCTOR_NEW_PATIENT_MESSAGE = 'doctor_new_patient_message';

    /**
     * Enregistrement des hooks WP Cron (SMS différés).
     */
    public static function register_hooks(): void
    {
        add_action('sosprescription_deferred_sms', [self::class, 'handle_deferred_sms'], 10, 5);
    }

    /**
     * Envoie un email de test (sans donnée de santé).
     */
    public static function send_test_email(string $to): bool
    {
        $subject = 'SOS Prescription — test notification';
        $body = "Bonjour,

Ceci est un message de test (aucun contenu médical).

— SOS Prescription";
        return self::send_email($to, $subject, $body);
    }

    /**
     * Envoie un SMS de test (sans donnée de santé).
     */
    public static function send_test_sms(string $to, bool $force_now = false): bool
    {
        $cfg = NotificationsConfig::get();
        if (!$force_now && !empty($cfg['sms_quiet_hours_enabled'])) {
            $start = (string) ($cfg['sms_quiet_start'] ?? '22:00');
            $end = (string) ($cfg['sms_quiet_end'] ?? '08:00');
            if (self::is_quiet_now($start, $end)) {
                return false;
            }
        }

        $msg = 'SOS Prescription : message de test (aucun contenu médical).';
        return self::send_sms($to, $msg, 'test', 0);
    }

    public static function patient_payment_confirmed(int $prescription_id, int $patient_user_id): void
    {
        $cfg = NotificationsConfig::get();
        if (!$cfg['send_on_payment_confirmed']) {
            return;
        }
        self::notify_user('patient', self::EVENT_PAYMENT_CONFIRMED, $prescription_id, $patient_user_id, null);
    }

    public static function patient_assigned(int $prescription_id, int $patient_user_id, int $doctor_user_id): void
    {
        $cfg = NotificationsConfig::get();
        if (!$cfg['send_on_assigned']) {
            return;
        }
        self::notify_user('patient', self::EVENT_ASSIGNED, $prescription_id, $patient_user_id, $doctor_user_id);
    }

    public static function patient_doctor_message(int $prescription_id, int $patient_user_id, int $doctor_user_id): void
    {
        $cfg = NotificationsConfig::get();
        if (!$cfg['send_on_doctor_message']) {
            return;
        }
        self::notify_user('patient', self::EVENT_DOCTOR_MESSAGE, $prescription_id, $patient_user_id, $doctor_user_id);
    }

    public static function patient_decision(int $prescription_id, int $patient_user_id, string $decision, ?int $doctor_user_id = null): void
    {
        $cfg = NotificationsConfig::get();
        if (!$cfg['send_on_decision']) {
            return;
        }

        $decision = strtolower(trim($decision));
        if ($decision === 'approved') {
            self::notify_user('patient', self::EVENT_DECISION_APPROVED, $prescription_id, $patient_user_id, $doctor_user_id);
            return;
        }
        if ($decision === 'rejected') {
            self::notify_user('patient', self::EVENT_DECISION_REJECTED, $prescription_id, $patient_user_id, $doctor_user_id);
            return;
        }
    }

    public static function doctor_patient_message(int $prescription_id, int $doctor_user_id, int $patient_user_id): void
    {
        $cfg = NotificationsConfig::get();
        if (!$cfg['send_doctor_on_patient_message']) {
            return;
        }
        self::notify_user('doctor', self::EVENT_DOCTOR_NEW_PATIENT_MESSAGE, $prescription_id, $doctor_user_id, $patient_user_id);
    }

    /**
     * Hook WP Cron : envoi SMS différé (respect quiet hours).
     */
    public static function handle_deferred_sms(string $event, int $prescription_id, int $recipient_user_id, string $recipient_role, int $other_user_id): void
    {
        // On reconstruit l'envoi mais en forçant "SMS only".
        self::notify_user($recipient_role, $event, $prescription_id, $recipient_user_id, $other_user_id, true);
    }

    /**
     * @param 'patient'|'doctor' $recipient_role
     * @param string $event
     * @param int $prescription_id
     * @param int $recipient_user_id
     * @param int|null $other_user_id doctor_id (si patient) ou patient_id (si doctor)
     * @param bool $sms_only
     */
    private static function notify_user(string $recipient_role, string $event, int $prescription_id, int $recipient_user_id, ?int $other_user_id, bool $sms_only = false): void
    {
        $recipient_role = strtolower(trim($recipient_role));
        if ($recipient_role !== 'patient' && $recipient_role !== 'doctor') {
            return;
        }

        $cfg = NotificationsConfig::get();

        // Debounce : évite les doubles notifications lors d'un même changement (ex: statut + message).
        $ttl = self::debounce_ttl_seconds($event);
        $debounce_key = 'sp_notif_' . md5($recipient_role . '|' . $event . '|' . (string) $prescription_id . '|' . (string) $recipient_user_id);
        if (get_transient($debounce_key)) {
            return;
        }
        set_transient($debounce_key, '1', $ttl);

        $user = get_userdata($recipient_user_id);
        if (!$user) {
            return;
        }

        $repo = new PrescriptionRepository();
        $p = $repo->get_payment_fields($prescription_id);
        $uid = is_array($p) && isset($p['uid']) ? (string) $p['uid'] : '';
        $ref = $uid !== '' ? $uid : (string) $prescription_id;

        $other_name = '';
        if ($other_user_id !== null && $other_user_id > 0) {
            $other = get_userdata($other_user_id);
            if ($other) {
                $other_name = (string) $other->display_name;
            }
        }

        $subject = '';
        $body = '';
        $sms = '';

        if ($recipient_role === 'patient') {
            $portal = NotificationsConfig::patient_portal_url();
            $link = add_query_arg(['rx' => (string) $prescription_id], $portal);

            [$subject, $body, $sms] = self::patient_template($event, $ref, $link, $other_name);
        } else {
            $console = NotificationsConfig::doctor_console_url();
            $link = add_query_arg(['rx' => (string) $prescription_id], $console);
            [$subject, $body, $sms] = self::doctor_template($event, $ref, $link, $other_name);
        }

        if ($subject === '' && $body === '') {
            return;
        }

        // EMAIL
        if (!$sms_only && $cfg['email_enabled']) {
            $to = (string) $user->user_email;
            if (is_email($to)) {
                $ok = self::send_email($to, $subject, $body);
                Logger::log('runtime', $ok ? 'info' : 'error', 'notif_email', [
                    'event' => $event,
                    'role' => $recipient_role,
                    'prescription_id' => $prescription_id,
                    'user_id' => $recipient_user_id,
                    'ok' => $ok,
                ]);
            }
        }

        // SMS
        if ($cfg['sms_enabled']) {
            $phone = self::user_phone($recipient_user_id, (string) $cfg['sms_phone_meta_key']);
            if ($phone !== '' && $sms !== '') {
                self::send_sms_maybe_deferred($phone, $sms, $event, $prescription_id, $recipient_user_id, $recipient_role, (int) ($other_user_id ?? 0));
            }
        }
    }

    private static function debounce_ttl_seconds(string $event): int
    {
        $event = strtolower(trim($event));

        // Message : on accepte plusieurs messages, mais on évite les doubles immédiats.
        if ($event === self::EVENT_DOCTOR_MESSAGE || $event === self::EVENT_DOCTOR_NEW_PATIENT_MESSAGE) {
            return 60; // 1 minute
        }

        if ($event === self::EVENT_PAYMENT_CONFIRMED) {
            return 15 * 60; // 15 minutes
        }

        if ($event === self::EVENT_ASSIGNED) {
            return 10 * 60; // 10 minutes
        }

        if ($event === self::EVENT_DECISION_APPROVED || $event === self::EVENT_DECISION_REJECTED) {
            return 60 * 60; // 1 heure
        }

        return 300;
    }

    /**
     * @return array{0:string,1:string,2:string} subject, email_body, sms_body
     */
    private static function patient_template(string $event, string $ref, string $portal_link, string $doctor_name): array
    {
        $event = strtolower(trim($event));

        $safe_doctor = $doctor_name !== '' ? (' (' . $doctor_name . ')') : '';

        if ($event === self::EVENT_PAYMENT_CONFIRMED) {
            $subject = 'SOS Prescription — Demande reçue';
            $body = "Bonjour,\n\nVotre demande SOS Prescription (#{$ref}) a bien été enregistrée et transmise au médecin.\n\nPour des raisons de confidentialité, aucune information médicale n'est envoyée par email.\nConnectez-vous à votre espace patient pour suivre votre dossier :\n{$portal_link}\n\n— SOS Prescription";
            $sms = "SOS Prescription : votre demande (#{$ref}) est reçue. Connectez-vous à votre espace patient : {$portal_link}";
            return [$subject, $body, $sms];
        }

        if ($event === self::EVENT_ASSIGNED) {
            $subject = 'SOS Prescription — Dossier en cours d’analyse';
            $body = "Bonjour,\n\nVotre demande SOS Prescription (#{$ref}) est désormais en cours d'analyse par un médecin{$safe_doctor}.\n\nPour des raisons de confidentialité, aucune information médicale n'est envoyée par email.\nAccédez à votre espace patient pour suivre l'avancement :\n{$portal_link}\n\n— SOS Prescription";
            $sms = "SOS Prescription : votre dossier (#{$ref}) est en cours d'analyse{$safe_doctor}. Espace patient : {$portal_link}";
            return [$subject, $body, $sms];
        }

        if ($event === self::EVENT_DOCTOR_MESSAGE) {
            $subject = 'SOS Prescription — Nouveau message';
            $body = "Bonjour,\n\nVous avez un nouveau message dans votre espace patient concernant la demande #{$ref}{$safe_doctor}.\n\nPour des raisons de confidentialité, le contenu du message n'est pas transmis par email.\nConnectez-vous pour le consulter :\n{$portal_link}\n\n— SOS Prescription";
            $sms = "SOS Prescription : nouveau message pour la demande #{$ref}{$safe_doctor}. Connectez-vous : {$portal_link}";
            return [$subject, $body, $sms];
        }

        if ($event === self::EVENT_DECISION_APPROVED) {
            $subject = 'SOS Prescription — Ordonnance disponible';
            $body = "Bonjour,\n\nUne mise à jour est disponible concernant votre demande SOS Prescription (#{$ref}).\n\nVotre ordonnance est disponible dans votre espace patient.\nPour des raisons de confidentialité, nous n'envoyons pas l'ordonnance par email.\n\nAccéder à l'espace patient :\n{$portal_link}\n\n— SOS Prescription";
            $sms = "SOS Prescription : ordonnance disponible pour la demande #{$ref}. Espace patient : {$portal_link}";
            return [$subject, $body, $sms];
        }

        if ($event === self::EVENT_DECISION_REJECTED) {
            $subject = 'SOS Prescription — Réponse disponible';
            $body = "Bonjour,\n\nUne réponse est disponible concernant votre demande SOS Prescription (#{$ref}).\n\nPour des raisons de confidentialité, aucun détail médical n'est transmis par email.\nConnectez-vous à votre espace patient pour consulter la décision :\n{$portal_link}\n\n— SOS Prescription";
            $sms = "SOS Prescription : réponse disponible pour la demande #{$ref}. Connectez-vous : {$portal_link}";
            return [$subject, $body, $sms];
        }

        return ['', '', ''];
    }

    /**
     * @return array{0:string,1:string,2:string} subject, email_body, sms_body
     */
    private static function doctor_template(string $event, string $ref, string $console_link, string $patient_name): array
    {
        $event = strtolower(trim($event));

        if ($event === self::EVENT_DOCTOR_NEW_PATIENT_MESSAGE) {
            $subject = 'SOS Prescription — Nouveau message patient';
            $safe_patient = $patient_name !== '' ? (' (' . $patient_name . ')') : '';
            $body = "Bonjour,\n\nUn patient vous a envoyé un nouveau message concernant la demande #{$ref}{$safe_patient}.\n\nPour des raisons de confidentialité, le contenu du message n'est pas transmis par email.\nAccéder à la console :\n{$console_link}\n\n— SOS Prescription";
            $sms = "SOS Prescription : nouveau message patient pour la demande #{$ref}{$safe_patient}. Console : {$console_link}";
            return [$subject, $body, $sms];
        }

        return ['', '', ''];
    }

    private static function send_email(string $to, string $subject, string $body): bool
    {
        $cfg = NotificationsConfig::get();
        $from_email = (string) ($cfg['from_email'] ?? '');
        $from_name = (string) ($cfg['from_name'] ?? '');

        $filter_from = static function (string $orig) use ($from_email): string {
            return $from_email !== '' ? $from_email : $orig;
        };

        $filter_name = static function (string $orig) use ($from_name): string {
            return $from_name !== '' ? $from_name : $orig;
        };

        add_filter('wp_mail_from', $filter_from, 20, 1);
        add_filter('wp_mail_from_name', $filter_name, 20, 1);

        $headers = [
            'Content-Type: text/plain; charset=UTF-8',
        ];

        $ok = wp_mail($to, $subject, $body, $headers);

        remove_filter('wp_mail_from', $filter_from, 20);
        remove_filter('wp_mail_from_name', $filter_name, 20);

        return (bool) $ok;
    }

    private static function user_phone(int $user_id, string $meta_key): string
    {
        $meta_key = sanitize_key($meta_key);
        if ($meta_key === '') {
            return '';
        }
        $raw = (string) get_user_meta($user_id, $meta_key, true);
        $raw = trim($raw);
        if ($raw === '') {
            return '';
        }

        // Normalisation légère (on conserve +)
        $raw = preg_replace('/[^0-9+]/', '', $raw);
        if (!is_string($raw)) {
            return '';
        }
        if (mb_strlen($raw) < 8) {
            return '';
        }

        return $raw;
    }

    private static function send_sms_maybe_deferred(string $to, string $message, string $event, int $prescription_id, int $recipient_user_id, string $recipient_role, int $other_user_id): void
    {
        $cfg = NotificationsConfig::get();

        // Respect quiet hours
        if ($cfg['sms_quiet_hours_enabled']) {
            $start = (string) ($cfg['sms_quiet_start'] ?? '22:00');
            $end = (string) ($cfg['sms_quiet_end'] ?? '08:00');

            if (self::is_quiet_now($start, $end)) {
                $ts = self::next_allowed_timestamp($start, $end);
                if ($ts !== null) {
                    // On programme un envoi "SMS only".
                    wp_schedule_single_event(
                        $ts,
                        'sosprescription_deferred_sms',
                        [$event, $prescription_id, $recipient_user_id, $recipient_role, $other_user_id]
                    );

                    Logger::log('runtime', 'info', 'notif_sms_deferred', [
                        'event' => $event,
                        'prescription_id' => $prescription_id,
                        'user_id' => $recipient_user_id,
                        'send_at' => (int) $ts,
                    ]);
                    return;
                }
            }
        }

        $ok = self::send_sms($to, $message, $event, $prescription_id);

        Logger::log('runtime', $ok ? 'info' : 'error', 'notif_sms', [
            'event' => $event,
            'prescription_id' => $prescription_id,
            'user_id' => $recipient_user_id,
            'ok' => $ok,
        ]);
    }

    private static function is_quiet_now(string $start, string $end): bool
    {
        $now_ts = (int) current_time('timestamp');
        $h = (int) gmdate('G', $now_ts + (int) (get_option('gmt_offset') * 3600));
        $m = (int) gmdate('i', $now_ts + (int) (get_option('gmt_offset') * 3600));

        // Correction : current_time('timestamp') renvoie déjà local time, on peut faire plus simple.
        // Mais on garde cette approche prudente pour des hébergements au gmt_offset exotique.
        $local = (int) current_time('timestamp');
        $h = (int) date('G', $local);
        $m = (int) date('i', $local);

        $now_min = $h * 60 + $m;
        [$s_min, $e_min] = self::parse_start_end_minutes($start, $end);

        if ($s_min === null || $e_min === null) {
            return false;
        }

        if ($s_min < $e_min) {
            return $now_min >= $s_min && $now_min < $e_min;
        }

        // Période qui traverse minuit (ex: 22:00 -> 08:00)
        return $now_min >= $s_min || $now_min < $e_min;
    }

    private static function next_allowed_timestamp(string $start, string $end): ?int
    {
        $local_ts = (int) current_time('timestamp');
        $todayYmd = (string) date('Y-m-d', $local_ts);

        [$s_min, $e_min] = self::parse_start_end_minutes($start, $end);
        if ($s_min === null || $e_min === null) {
            return null;
        }

        $now_min = ((int) date('G', $local_ts)) * 60 + (int) date('i', $local_ts);

        // Calcule le timestamp local de fin de quiet hours (end)
        $end_h = intdiv($e_min, 60);
        $end_m = $e_min % 60;

        // Si quiet hours ne traversent pas minuit
        if ($s_min < $e_min) {
            // Si on est dans la fenêtre, next = aujourd'hui à end
            $target = strtotime(sprintf('%s %02d:%02d:00', $todayYmd, $end_h, $end_m));
            if (!is_int($target)) {
                return null;
            }
            if ($now_min >= $s_min && $now_min < $e_min) {
                return $target;
            }
            return null;
        }

        // Traverse minuit (ex: 22:00 -> 08:00)
        if ($now_min >= $s_min) {
            // Après start (ex: 23h) : next = demain à end
            $tomorrow = (string) date('Y-m-d', $local_ts + 86400);
            $target = strtotime(sprintf('%s %02d:%02d:00', $tomorrow, $end_h, $end_m));
            return is_int($target) ? $target : null;
        }
        if ($now_min < $e_min) {
            // Avant end (ex: 02h) : next = aujourd'hui à end
            $target = strtotime(sprintf('%s %02d:%02d:00', $todayYmd, $end_h, $end_m));
            return is_int($target) ? $target : null;
        }

        return null;
    }

    /**
     * @return array{0:?int,1:?int}
     */
    private static function parse_start_end_minutes(string $start, string $end): array
    {
        $start = trim($start);
        $end = trim($end);

        if (preg_match('/^(\d{1,2}):(\d{2})$/', $start, $m) !== 1) {
            return [null, null];
        }
        $sh = (int) $m[1];
        $sm = (int) $m[2];
        if (preg_match('/^(\d{1,2}):(\d{2})$/', $end, $m2) !== 1) {
            return [null, null];
        }
        $eh = (int) $m2[1];
        $em = (int) $m2[2];

        if ($sh < 0 || $sh > 23 || $sm < 0 || $sm > 59) {
            return [null, null];
        }
        if ($eh < 0 || $eh > 23 || $em < 0 || $em > 59) {
            return [null, null];
        }

        return [$sh * 60 + $sm, $eh * 60 + $em];
    }

    private static function send_sms(string $to, string $message, string $event, int $prescription_id): bool
    {
        $cfg = NotificationsConfig::get();

        if (!$cfg['sms_enabled']) {
            return false;
        }

        $provider = (string) ($cfg['sms_provider'] ?? 'webhook');
        if ($provider !== 'webhook') {
            $provider = 'webhook';
        }

        $url = (string) ($cfg['sms_webhook_url'] ?? '');
        if ($url === '') {
            return false;
        }

        $payload = [
            'to' => $to,
            'message' => $message,
            'event' => $event,
            'prescription_id' => $prescription_id,
            'site' => (string) home_url('/'),
        ];

        $json = wp_json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if (!is_string($json)) {
            $json = '{}';
        }

        $args = [
            'timeout' => 10,
            'headers' => [
                'Content-Type' => 'application/json',
            ],
            'body' => $json,
        ];

        $secret = (string) ($cfg['sms_webhook_secret'] ?? '');
        if ($secret !== '') {
            $args['headers']['Authorization'] = 'Bearer ' . $secret;
        }

        $res = wp_remote_post($url, $args);
        if (is_wp_error($res)) {
            return false;
        }

        $code = (int) wp_remote_retrieve_response_code($res);
        return $code >= 200 && $code < 300;
    }
}
