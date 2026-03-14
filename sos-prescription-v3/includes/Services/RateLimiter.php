<?php

namespace SosPrescription\Services;

use WP_REST_Request;

/**
 * Simple, storage-light REST rate limiter (shared hosting compatible).
 *
 * Implementation goals:
 * - No external storage (Redis/Memcached) required.
 * - Uses WP transients (options table) with fixed-window reset.
 * - No PII stored in keys (IP is hashed).
 */
final class RateLimiter
{
    /**
     * Default rules (can be overridden via filter `sosprescription_rate_limit_rules`).
     *
     * Limits are intentionally generous for UX (type-ahead, polling) and
     * stricter for expensive operations (uploads, PDF generation).
     */
    public static function default_rules(): array
    {
        return [
            // REST uploads (disk + CPU).
            'files_upload' => ['limit' => 10, 'window' => 60],

            // Type-ahead medication search.
            'med_search'   => ['limit' => 180, 'window' => 60],

            // Sending messages (prevent spam).
            'messages_send' => ['limit' => 30, 'window' => 60],

            // Patient creating a request (Turnstile already helps, but keep a safety net).
            'prescription_create' => ['limit' => 12, 'window' => 300],

            // Heavy: PDF generation.
            'rx_pdf' => ['limit' => 18, 'window' => 300],

            // Public verification (/v/{token}) : pharmacist delivery attempts (anti-bruteforce).
            'rx_delivery' => ['limit' => 5, 'window' => 3600],
        ];
    }

    /**
     * Build a stable transient key for a given REST request + bucket.
     */
    public static function build_key(WP_REST_Request $request, string $bucket): string
    {
        $user_id = (int) get_current_user_id();
        $route = (string) $request->get_route();
        $method = strtoupper((string) $request->get_method());

        // Avoid storing raw IP anywhere.
        $ip = isset($_SERVER['REMOTE_ADDR']) ? (string) $_SERVER['REMOTE_ADDR'] : '';
        $ip_hash = Logger::ip_hash($ip);

        // Keep keys short (option_name limit) and deterministic.
        $raw = implode('|', [
            'sp',
            'rl',
            $bucket,
            $method,
            $route,
            (string) $user_id,
            $ip_hash,
        ]);

        return 'sp_rl_' . substr(hash('sha256', $raw), 0, 32);
    }

    /**
     * Increment the counter and return state.
     *
     * @return array{allowed:bool,count:int,limit:int,window:int,retry_after:int,reset_at:int,key:string}
     */
    public static function hit(string $key, int $limit, int $window): array
    {
        $now = time();
        $window = max(1, (int) $window);
        $limit = max(1, (int) $limit);

        $state = get_transient($key);
        if (!is_array($state) || empty($state['reset_at']) || (int) $state['reset_at'] <= $now) {
            $state = [
                'count' => 0,
                'reset_at' => $now + $window,
            ];
        }

        $state['count'] = (int) ($state['count'] ?? 0) + 1;
        $state['reset_at'] = (int) ($state['reset_at'] ?? ($now + $window));

        $retry_after = max(1, $state['reset_at'] - $now);

        // Important: set remaining TTL (fixed window, does not extend).
        set_transient($key, $state, $retry_after);

        $allowed = $state['count'] <= $limit;

        return [
            'allowed' => $allowed,
            'count' => (int) $state['count'],
            'limit' => $limit,
            'window' => $window,
            'retry_after' => (int) $retry_after,
            'reset_at' => (int) $state['reset_at'],
            'key' => $key,
        ];
    }

    /**
     * Throttled logging guard: avoid filling disk if an attacker triggers 429s in a loop.
     *
     * @param string $key The counter key.
     * @param int $ttl Seconds to keep the "already logged" marker.
     */
    public static function should_log_denied(string $key, int $ttl): bool
    {
        $ttl = max(1, (int) $ttl);
        $log_key = $key . '_d';

        if (get_transient($log_key)) {
            return false;
        }

        set_transient($log_key, 1, min(120, $ttl));
        return true;
    }
}
