<?php
// includes/Services/RestGuard.php
declare(strict_types=1);

namespace SosPrescription\Services;

use WP_Error;
use WP_REST_Request;

final class RestGuard
{
    public const SCOPE = 'rest_perm';

    /**
     * @param array<string,int> $override
     * @return bool|WP_Error
     */
    public static function throttle(WP_REST_Request $request, string $bucket, array $override = []): bool|WP_Error
    {
        $default_bypass = current_user_can('manage_options');
        $bypass = (bool) apply_filters('sosprescription_rate_limit_bypass', $default_bypass, $request, $bucket);
        if ($bypass) {
            return true;
        }

        $rules = RateLimiter::default_rules();
        $rules = apply_filters('sosprescription_rate_limit_rules', $rules, $request);
        $rule = $rules[$bucket] ?? null;

        if (!is_array($rule)) {
            return true;
        }

        $limit = isset($override['limit']) ? (int) $override['limit'] : (int) ($rule['limit'] ?? 60);
        $window = isset($override['window']) ? (int) $override['window'] : (int) ($rule['window'] ?? 60);

        if ($limit <= 0 || $window <= 0) {
            return true;
        }

        $key = RateLimiter::build_key($request, $bucket);
        $hit = RateLimiter::hit($key, $limit, $window);

        if (($hit['allowed'] ?? false) === true) {
            return true;
        }

        if (RateLimiter::should_log_denied($key, (int) ($hit['retry_after'] ?? 1))) {
            self::safe_ndjson('warning', 'rest_rate_limited', [
                'bucket' => $bucket,
                'route' => (string) $request->get_route(),
                'method' => (string) $request->get_method(),
                'limit' => $limit,
                'window' => $window,
                'count' => (int) ($hit['count'] ?? 0),
                'retry_after' => (int) ($hit['retry_after'] ?? 1),
                'key_fp' => substr(hash('sha256', $key), 0, 12),
            ]);
        }

        $rid = Logger::get_request_id();
        $retry = max(1, (int) ($hit['retry_after'] ?? 1));
        $message = sprintf('Trop de requêtes. Veuillez réessayer dans %d s.', $retry);

        return new WP_Error(
            'sosprescription_rate_limited',
            $message,
            [
                'status' => 429,
                'req_id' => $rid,
                'retry_after' => $retry,
                'bucket' => $bucket,
            ]
        );
    }

    public static function require_logged_in(WP_REST_Request $request): bool|WP_Error
    {
        if (is_user_logged_in()) {
            return true;
        }

        return self::deny(
            $request,
            'sosprescription_rest_auth_required',
            'Authentication required.',
            401,
            [
                'reason' => 'not_logged_in',
            ]
        );
    }

    public static function require_wp_rest_nonce(WP_REST_Request $request): bool|WP_Error
    {
        $nonce = (string) $request->get_header('X-WP-Nonce');
        if ($nonce !== '' && wp_verify_nonce($nonce, 'wp_rest')) {
            return true;
        }

        return self::deny(
            $request,
            'sosprescription_rest_bad_nonce',
            'Invalid or missing nonce.',
            403,
            [
                'reason' => 'bad_nonce',
            ]
        );
    }

    public static function require_cap(WP_REST_Request $request, string $cap): bool|WP_Error
    {
        if (current_user_can($cap)) {
            return true;
        }

        return self::deny(
            $request,
            'sosprescription_rest_forbidden',
            'Forbidden.',
            403,
            [
                'reason' => 'missing_cap',
                'cap' => $cap,
            ]
        );
    }

    /**
     * @param array<int,string> $caps
     */
    public static function require_any_cap(WP_REST_Request $request, array $caps): bool|WP_Error
    {
        foreach ($caps as $cap) {
            if (is_string($cap) && $cap !== '' && current_user_can($cap)) {
                return true;
            }
        }

        return self::deny(
            $request,
            'sosprescription_rest_forbidden',
            'Forbidden.',
            403,
            [
                'reason' => 'missing_cap',
                'caps' => array_values(array_filter($caps, 'is_string')),
            ]
        );
    }

    /**
     * @param array<string,mixed> $extra_ctx
     */
    private static function deny(
        WP_REST_Request $request,
        string $code,
        string $message,
        int $status,
        array $extra_ctx = []
    ): WP_Error {
        $reqId = Logger::get_request_id();

        $ctx = array_merge(
            [
                'status' => $status,
                'route' => (string) $request->get_route(),
                'method' => (string) $request->get_method(),
                'user_id' => (int) get_current_user_id(),
                'req_id' => $reqId,
            ],
            $extra_ctx
        );

        self::safe_ndjson('warning', 'rest_permission_denied', $ctx);

        return new WP_Error($code, $message, [
            'status' => $status,
            'req_id' => $reqId,
        ]);
    }

    /**
     * @param array<string,mixed> $payload
     */
    private static function safe_ndjson(string $level, string $event, array $payload = []): void
    {
        try {
            Logger::ndjson_scoped('runtime', self::SCOPE, $level, $event, $payload);
        } catch (\Throwable $e) {
            error_log('[SOSPrescription] RestGuard log failure: ' . $e->getMessage() . ' | event=' . $event);
        }
    }
}
