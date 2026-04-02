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
        if (!self::is_configured()) {
            if (self::is_bypass_allowed()) {
                self::log('info', 'turnstile.bypass_local_not_configured', [
                    'environment' => self::environment(),
                ]);
                return true;
            }

            self::log('error', 'turnstile.not_configured', [
                'environment' => self::environment(),
                'site_key_configured' => self::site_key() !== '',
                'secret_key_configured' => self::secret_key() !== '',
            ]);

            return self::error(
                'ml_turnstile_not_configured',
                'La vérification anti-abus est temporairement indisponible. Veuillez réessayer plus tard.',
                503
            );
        }

        $token = trim($token);
        if ($token === '') {
            self::log('warning', 'turnstile.token_missing', [
                'environment' => self::environment(),
            ]);

            return self::error(
                'ml_turnstile_failed',
                'La vérification anti-abus a échoué. Veuillez réessayer.',
                400
            );
        }

        $body = [
            'secret' => self::secret_key(),
            'response' => $token,
        ];

        if ($remote_ip !== null && trim($remote_ip) !== '') {
            $body['remoteip'] = trim($remote_ip);
        }

        $res = wp_remote_post('https://challenges.cloudflare.com/turnstile/v0/siteverify', [
            'timeout' => 10,
            'body' => $body,
        ]);

        if (is_wp_error($res)) {
            self::log('error', 'turnstile.http_error', [
                'environment' => self::environment(),
                'wp_error_code' => $res->get_error_code(),
                'wp_error_message' => $res->get_error_message(),
            ]);

            return self::error(
                'ml_turnstile_unavailable',
                'La vérification anti-abus est temporairement indisponible. Veuillez réessayer plus tard.',
                502
            );
        }

        $code = (int) wp_remote_retrieve_response_code($res);
        $json = (string) wp_remote_retrieve_body($res);

        if ($code < 200 || $code >= 300) {
            self::log('error', 'turnstile.http_invalid_status', [
                'environment' => self::environment(),
                'http_status' => $code,
            ]);

            return self::error(
                'ml_turnstile_unavailable',
                'La vérification anti-abus est temporairement indisponible. Veuillez réessayer plus tard.',
                502
            );
        }

        $data = json_decode($json, true);
        if (!is_array($data)) {
            self::log('error', 'turnstile.bad_json', [
                'environment' => self::environment(),
                'http_status' => $code,
            ]);

            return self::error(
                'ml_turnstile_unavailable',
                'La vérification anti-abus est temporairement indisponible. Veuillez réessayer plus tard.',
                502
            );
        }

        if (!empty($data['success'])) {
            return true;
        }

        $errorCodes = [];
        if (isset($data['error-codes']) && is_array($data['error-codes'])) {
            foreach ($data['error-codes'] as $errorCode) {
                if (is_scalar($errorCode)) {
                    $errorCodes[] = (string) $errorCode;
                }
            }
        }

        self::log('warning', 'turnstile.validation_failed', [
            'environment' => self::environment(),
            'error_codes' => $errorCodes,
        ]);

        return self::error(
            'ml_turnstile_failed',
            'La vérification anti-abus a échoué. Veuillez réessayer.',
            400
        );
    }

    public static function is_enabled(): bool
    {
        return self::is_configured();
    }

    public static function should_enforce(): bool
    {
        return self::is_configured() || !self::is_bypass_allowed();
    }

    public static function is_bypass_allowed(): bool
    {
        return self::environment() === 'local';
    }

    public static function is_configured(): bool
    {
        return self::site_key() !== '' && self::secret_key() !== '';
    }

    public static function site_key(): string
    {
        if (function_exists('sosprescription_turnstile_site_key')) {
            $value = trim((string) sosprescription_turnstile_site_key());
            if ($value !== '') {
                return $value;
            }
        }

        if (defined('SOSPRESCRIPTION_TURNSTILE_SITE_KEY')) {
            return trim((string) SOSPRESCRIPTION_TURNSTILE_SITE_KEY);
        }

        return '';
    }

    public static function environment(): string
    {
        $candidates = [];

        if (defined('SOSPRESCRIPTION_ENV')) {
            $candidates[] = (string) SOSPRESCRIPTION_ENV;
        }

        $envValue = getenv('SOSPRESCRIPTION_ENV');
        if (is_string($envValue) && $envValue !== '') {
            $candidates[] = $envValue;
        }

        if (defined('WP_ENVIRONMENT_TYPE')) {
            $candidates[] = (string) WP_ENVIRONMENT_TYPE;
        }

        $wpEnv = getenv('WP_ENVIRONMENT_TYPE');
        if (is_string($wpEnv) && $wpEnv !== '') {
            $candidates[] = $wpEnv;
        }

        if (function_exists('wp_get_environment_type')) {
            $candidates[] = (string) wp_get_environment_type();
        }

        foreach ($candidates as $candidate) {
            $candidate = strtolower(trim($candidate));
            if ($candidate !== '') {
                return $candidate;
            }
        }

        return 'production';
    }

    private static function secret_key(): string
    {
        if (defined('SOSPRESCRIPTION_TURNSTILE_SECRET_KEY')) {
            return trim((string) SOSPRESCRIPTION_TURNSTILE_SECRET_KEY);
        }

        return '';
    }

    private static function error(string $code, string $message, int $status): WP_Error
    {
        return new WP_Error(
            $code,
            $message,
            ['status' => $status]
        );
    }

    /**
     * @param array<string, mixed> $context
     */
    private static function log(string $level, string $event, array $context = []): void
    {
        $record = [
            'service' => 'sosprescription',
            'component' => 'turnstile',
            'level' => $level,
            'event' => $event,
            'context' => $context,
        ];

        $json = wp_json_encode($record, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if (!is_string($json) || $json === '') {
            $json = '{"service":"sosprescription","component":"turnstile","level":"' . $level . '","event":"' . $event . '"}';
        }

        error_log('[SOSPrescription] ' . $json);
    }
}
