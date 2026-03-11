<?php
declare(strict_types=1);

namespace SosPrescription\Services;

/**
 * Stocke les réglages de notifications transactionnelles.
 *
 * IMPORTANT : aucune donnée de santé ne doit transiter dans les emails/SMS.
 * Les notifications sont des "pings" invitant l'utilisateur à se connecter.
 */
final class NotificationsConfig
{
    private const OPTION = 'sosprescription_notifications';

    /**
     * @return array<string, mixed>
     */
    public static function defaults(): array
    {
        $site = (string) get_bloginfo('name');
        if ($site === '') {
            $site = 'SOS Prescription';
        }

        // From email : fallback "wordpress@..." mais configurable.
        $host = (string) wp_parse_url((string) home_url('/'), PHP_URL_HOST);
        $from_email = $host !== '' ? ('noreply@' . $host) : 'noreply@example.com';

        return [
            'email_enabled' => true,
            'sms_enabled' => false,

            'from_name' => $site,
            'from_email' => $from_email,

            // Pages (optionnel) : si non configuré, les liens pointent sur home.
            'patient_portal_page_id' => 0,
            'doctor_console_page_id' => 0,

            // SMS via webhook (optionnel)
            'sms_provider' => 'webhook',
            'sms_webhook_url' => '',
            'sms_webhook_secret' => '',

            // Où trouver le téléphone côté WP User Meta (ex: billing_phone si WooCommerce)
            'sms_phone_meta_key' => 'sosprescription_phone',

            // Quiet hours (par défaut : pas de SMS entre 22:00 et 08:00)
            'sms_quiet_hours_enabled' => true,
            'sms_quiet_start' => '22:00',
            'sms_quiet_end' => '08:00',

            // Déclencheurs
            'send_on_payment_confirmed' => true,
            'send_on_assigned' => true,
            'send_on_doctor_message' => true,
            'send_on_decision' => true,

            // Notifications côté médecins
            'send_doctor_on_patient_message' => false,
        ];
    }

    /**
     * @return array<string, mixed>
     */
    public static function get(): array
    {
        $raw = get_option(self::OPTION, null);
        $cfg = is_array($raw) ? $raw : [];

        $out = array_merge(self::defaults(), $cfg);

        // Normalisation types
        $out['email_enabled'] = self::to_bool($out['email_enabled'] ?? false);
        $out['sms_enabled'] = self::to_bool($out['sms_enabled'] ?? false);

        $out['from_name'] = is_string($out['from_name'] ?? null) ? trim((string) $out['from_name']) : '';
        if ($out['from_name'] === '') {
            $out['from_name'] = (string) self::defaults()['from_name'];
        }

        $out['from_email'] = is_string($out['from_email'] ?? null) ? trim((string) $out['from_email']) : '';
        if ($out['from_email'] === '' || !is_email($out['from_email'])) {
            $out['from_email'] = (string) self::defaults()['from_email'];
        }

        $out['patient_portal_page_id'] = isset($out['patient_portal_page_id']) ? (int) $out['patient_portal_page_id'] : 0;
        $out['doctor_console_page_id'] = isset($out['doctor_console_page_id']) ? (int) $out['doctor_console_page_id'] : 0;

        $out['sms_provider'] = is_string($out['sms_provider'] ?? null) ? strtolower(trim((string) $out['sms_provider'])) : 'webhook';
        if ($out['sms_provider'] === '') {
            $out['sms_provider'] = 'webhook';
        }

        $out['sms_webhook_url'] = is_string($out['sms_webhook_url'] ?? null) ? esc_url_raw(trim((string) $out['sms_webhook_url'])) : '';
        $out['sms_webhook_secret'] = is_string($out['sms_webhook_secret'] ?? null) ? trim((string) $out['sms_webhook_secret']) : '';
        $out['sms_phone_meta_key'] = is_string($out['sms_phone_meta_key'] ?? null) ? sanitize_key((string) $out['sms_phone_meta_key']) : '';

        $out['sms_quiet_hours_enabled'] = self::to_bool($out['sms_quiet_hours_enabled'] ?? true);
        $out['sms_quiet_start'] = self::sanitize_time((string) ($out['sms_quiet_start'] ?? '22:00'));
        $out['sms_quiet_end'] = self::sanitize_time((string) ($out['sms_quiet_end'] ?? '08:00'));

        $out['send_on_payment_confirmed'] = self::to_bool($out['send_on_payment_confirmed'] ?? true);
        $out['send_on_assigned'] = self::to_bool($out['send_on_assigned'] ?? true);
        $out['send_on_doctor_message'] = self::to_bool($out['send_on_doctor_message'] ?? true);
        $out['send_on_decision'] = self::to_bool($out['send_on_decision'] ?? true);

        $out['send_doctor_on_patient_message'] = self::to_bool($out['send_doctor_on_patient_message'] ?? false);

        return $out;
    }

    /**
     * @param array<string, mixed> $patch
     * @return array<string, mixed>
     */
    public static function update(array $patch): array
    {
        $current = self::get();
        $next = array_merge($current, $patch);

        // On sauvegarde tel quel : get() re-normalise.
        update_option(self::OPTION, $next, false);

        return self::get();
    }

    public static function patient_portal_url(): string
    {
        $cfg = self::get();
        $pid = (int) ($cfg['patient_portal_page_id'] ?? 0);
        if ($pid > 0) {
            $link = get_permalink($pid);
            if (is_string($link) && $link !== '') {
                return $link;
            }
        }
        return (string) home_url('/');
    }

    public static function doctor_console_url(): string
    {
        $cfg = self::get();
        $pid = (int) ($cfg['doctor_console_page_id'] ?? 0);
        if ($pid > 0) {
            $link = get_permalink($pid);
            if (is_string($link) && $link !== '') {
                return $link;
            }
        }
        // Fallback wp-admin
        return (string) admin_url('admin.php');
    }

    private static function to_bool(mixed $v): bool
    {
        if (is_bool($v)) {
            return $v;
        }
        if (is_int($v)) {
            return $v === 1;
        }
        if (is_string($v)) {
            $s = strtolower(trim($v));
            return $s === '1' || $s === 'true' || $s === 'yes' || $s === 'on';
        }
        return false;
    }

    private static function sanitize_time(string $t): string
    {
        $t = trim($t);
        if ($t === '') {
            return '00:00';
        }
        if (preg_match('/^(\d{1,2}):(\d{2})$/', $t, $m) !== 1) {
            return '00:00';
        }
        $h = (int) $m[1];
        $min = (int) $m[2];
        if ($h < 0) { $h = 0; }
        if ($h > 23) { $h = 23; }
        if ($min < 0) { $min = 0; }
        if ($min > 59) { $min = 59; }
        return sprintf('%02d:%02d', $h, $min);
    }
}
