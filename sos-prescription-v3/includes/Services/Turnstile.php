<?php
declare(strict_types=1);

namespace SOSPrescription\Services;

use WP_Error;

final class Turnstile
{
    /**
     * @return true|WP_Error
     */
    public static function verify_token(string $token, ?string $remote_ip = null): true|WP_Error
    {
        $token = trim($token);

        if ($token === '') {
            return new WP_Error('sosprescription_turnstile_missing', 'Turnstile: token manquant.', ['status' => 400]);
        }

        if (!defined('SOSPRESCRIPTION_TURNSTILE_SECRET_KEY') || (string) SOSPRESCRIPTION_TURNSTILE_SECRET_KEY === '') {
            return new WP_Error('sosprescription_turnstile_not_configured', 'Turnstile: secret non configuré.', ['status' => 500]);
        }

        $secret = (string) SOSPRESCRIPTION_TURNSTILE_SECRET_KEY;

        $body = [
            'secret' => $secret,
            'response' => $token,
        ];

        if ($remote_ip) {
            $body['remoteip'] = $remote_ip;
        }

        $res = wp_remote_post('https://challenges.cloudflare.com/turnstile/v0/siteverify', [
            'timeout' => 10,
            'body' => $body,
        ]);

        if (is_wp_error($res)) {
            return new WP_Error('sosprescription_turnstile_http', 'Turnstile: erreur réseau.', ['status' => 502]);
        }

        $code = (int) wp_remote_retrieve_response_code($res);
        $json = (string) wp_remote_retrieve_body($res);

        if ($code < 200 || $code >= 300) {
            return new WP_Error('sosprescription_turnstile_http', 'Turnstile: réponse invalide.', ['status' => 502]);
        }

        $data = json_decode($json, true);
        if (!is_array($data)) {
            return new WP_Error('sosprescription_turnstile_bad_json', 'Turnstile: réponse illisible.', ['status' => 502]);
        }

        if (!empty($data['success'])) {
            return true;
        }

        return new WP_Error('sosprescription_turnstile_failed', 'Turnstile: échec de validation.', ['status' => 400, 'turnstile' => $data]);
    }

    /**
     * Côté front, on considère Turnstile "activé" dès qu'une clé site est définie.
     * (Le secret est vérifié lors de la validation serveur.)
     */
    public static function is_enabled(): bool
    {
        return trim(self::site_key()) !== '';
    }

    private static function site_key(): string
    {
        if (function_exists('sosprescription_turnstile_site_key')) {
            $val = (string) sosprescription_turnstile_site_key();
            return trim($val);
        }

        if (defined('SOSPRESCRIPTION_TURNSTILE_SITE_KEY')) {
            return trim((string) SOSPRESCRIPTION_TURNSTILE_SITE_KEY);
        }

        return '';
    }
}
