<?php
// includes/Services/RateLimiter.php
declare(strict_types=1);

namespace SOSPrescription\Services;

use WP_REST_Request;

final class RateLimiter
{
    /**
     * @return array<string, array{limit:int,window:int}>
     */
    public static function default_rules(): array
    {
        return [
            'files_upload' => ['limit' => 10, 'window' => 60],
            'med_search' => ['limit' => 180, 'window' => 60],
            'messages_send' => ['limit' => 30, 'window' => 60],
            'prescription_create' => ['limit' => 12, 'window' => 300],
            'rx_pdf' => ['limit' => 18, 'window' => 300],
            'rx_delivery' => ['limit' => 5, 'window' => 3600],
        ];
    }

    public static function build_key(WP_REST_Request $request, string $bucket): string
    {
        $userId = (int) get_current_user_id();
        $route = (string) $request->get_route();
        $method = strtoupper((string) $request->get_method());
        $ip = self::resolve_ip();
        $ipHash = self::hash_ip($ip);

        $raw = implode('|', [
            'sp',
            'rl',
            $bucket,
            $method,
            $route,
            (string) $userId,
            $ipHash,
        ]);

        return 'sp_rl_' . substr(hash('sha256', $raw), 0, 32);
    }

    /**
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

        $retryAfter = max(1, $state['reset_at'] - $now);
        set_transient($key, $state, $retryAfter);

        $allowed = $state['count'] <= $limit;

        return [
            'allowed' => $allowed,
            'count' => (int) $state['count'],
            'limit' => $limit,
            'window' => $window,
            'retry_after' => (int) $retryAfter,
            'reset_at' => (int) $state['reset_at'],
            'key' => $key,
        ];
    }

    public static function should_log_denied(string $key, int $ttl): bool
    {
        $ttl = max(1, (int) $ttl);
        $logKey = $key . '_d';

        if (get_transient($logKey)) {
            return false;
        }

        set_transient($logKey, 1, min(120, $ttl));
        return true;
    }

    private static function resolve_ip(): string
    {
        foreach (['HTTP_X_FORWARDED_FOR', 'REMOTE_ADDR'] as $serverKey) {
            if (empty($_SERVER[$serverKey])) {
                continue;
            }

            $raw = (string) wp_unslash($_SERVER[$serverKey]);
            $candidate = trim(explode(',', $raw)[0]);

            if ($candidate !== '') {
                return $candidate;
            }
        }

        return '';
    }

    private static function hash_ip(string $ip): string
    {
        $ip = trim($ip);
        if ($ip === '') {
            return '';
        }

        $salt = function_exists('wp_salt')
            ? (string) wp_salt('auth')
            : 'sosprescription';

        return substr(hash('sha256', $salt . '|' . $ip), 0, 16);
    }
}
