<?php
declare(strict_types=1);

namespace SosPrescription\Services;

use WP_Error;
use WP_REST_Request;

/**
 * RestGuard
 *
 * Centralise les checks de permissions REST (auth + nonce + capability)
 * et trace systématiquement les refus (401/403) en NDJSON.
 */
final class RestGuard
{
    /**
     * Scope NDJSON utilisé pour les refus de permissions REST.
     * Visible dans Back-office > Logs.
     */
    public const SCOPE = 'rest_perm';

    /**
     * Throttle anti-abus pour les endpoints REST.
     *
     * Appeler ce check APRES les checks auth/nonce, dans le permission_callback.
     *
     * @param array $override Permet de surcharger limit/window (ex: ['limit'=>20,'window'=>60]).
     * @return bool|WP_Error
     */
    public static function throttle(WP_REST_Request $request, string $bucket, array $override = []): bool|WP_Error
    {
        // Bypass explicit (ex: batch internes).
        $default_bypass = current_user_can('manage_options');
        $bypass = (bool) apply_filters('sosprescription_rate_limit_bypass', $default_bypass, $request, $bucket);
        if ($bypass) {
            return true;
        }

        $rules = RateLimiter::default_rules();
        $rules = apply_filters('sosprescription_rate_limit_rules', $rules, $request);
        $rule  = $rules[$bucket] ?? null;
        if (!is_array($rule)) {
            // Bucket inconnu => pas de throttling (safe default).
            return true;
        }

        $limit  = isset($override['limit']) ? (int) $override['limit'] : (int) ($rule['limit'] ?? 60);
        $window = isset($override['window']) ? (int) $override['window'] : (int) ($rule['window'] ?? 60);

        // Sanity.
        if ($limit <= 0 || $window <= 0) {
            return true;
        }

        $key = RateLimiter::build_key($request, $bucket);
        $hit = RateLimiter::hit($key, $limit, $window);
        if ($hit['allowed'] === true) {
            return true;
        }

        // Log (anti-flood).
        if (RateLimiter::should_log_denied($key, (int) $hit['retry_after'])) {
            Logger::ndjson_scoped('security', 'rate_limited', [
                'bucket'      => $bucket,
                'route'       => (string) $request->get_route(),
                'method'      => (string) $request->get_method(),
                'limit'       => $limit,
                'window'      => $window,
                'count'       => (int) $hit['count'],
                'retry_after' => (int) $hit['retry_after'],
                'key_fp'      => substr(hash('sha256', $key), 0, 12),
            ]);
        }

        $rid = Logger::get_request_id($request);
        $retry = (int) $hit['retry_after'];
        $message = sprintf('Trop de requêtes. Veuillez réessayer dans %d s.', max(1, $retry));

        return new WP_Error(
            'sosprescription_rate_limited',
            $message,
            [
                'status'      => 429,
                'req_id'      => $rid,
                'retry_after' => max(1, $retry),
                'bucket'      => $bucket,
            ]
        );
    }

    /**
     * Exige un utilisateur authentifié.
     */
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

    /**
     * Exige un nonce REST valide (header X-WP-Nonce).
     *
     * NOTE: On applique volontairement ce check aussi sur les GET pour
     * durcir contre les usages inattendus et standardiser le support.
     */
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

    /**
     * Exige une capability WordPress.
     */
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
                'cap'    => $cap,
            ]
        );
    }

    /**
     * Exige au moins une capability parmi une liste.
     *
     * Utile quand une fonctionnalité doit être accessible soit via un cap custom
     * (ex: sosprescription_manage_data) soit via manage_options.
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
                'caps'   => array_values(array_filter($caps, 'is_string')),
            ]
        );
    }

    /**
     * Crée un WP_Error + log NDJSON (Permission Denied).
     *
     * IMPORTANT: on évite de logger toute PII (pas de noms, pas de payload).
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
                'status'  => $status,
                'route'   => (string) $request->get_route(),
                'method'  => (string) $request->get_method(),
                'user_id' => (int) get_current_user_id(),
            ],
            $extra_ctx
        );

        Logger::ndjson_scoped(self::SCOPE, 'REST Permission Denied', $ctx, 'warning');

        // On inclut req_id dans les data (le filter rest_post_dispatch le rajoute aussi).
        return new WP_Error($code, $message, [
            'status' => $status,
            'req_id' => $reqId,
        ]);
    }
}
