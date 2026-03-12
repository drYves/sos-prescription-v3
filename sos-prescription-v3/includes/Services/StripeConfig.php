<?php
declare(strict_types=1);

namespace SOSPrescription\Services;

/**
 * Stockage configuration Stripe.
 */
final class StripeConfig
{
    public const OPTION_KEY = 'sosprescription_stripe';

    /**
     * @return array{enabled:bool, publishable_key:string, secret_key:string, webhook_secret:string, updated_at:string}
     */
    public static function get(): array
    {
        $raw = get_option(self::OPTION_KEY, null);
        if (!is_array($raw)) {
            return self::defaults();
        }

        $enabled = isset($raw['enabled']) ? (bool) $raw['enabled'] : self::defaults()['enabled'];
        $pk = isset($raw['publishable_key']) && is_string($raw['publishable_key']) ? trim($raw['publishable_key']) : '';
        $sk = isset($raw['secret_key']) && is_string($raw['secret_key']) ? trim($raw['secret_key']) : '';
        $wh = isset($raw['webhook_secret']) && is_string($raw['webhook_secret']) ? trim($raw['webhook_secret']) : '';
        $updated = isset($raw['updated_at']) && is_string($raw['updated_at']) ? $raw['updated_at'] : self::defaults()['updated_at'];

        return [
            'enabled' => $enabled,
            'publishable_key' => $pk,
            'secret_key' => $sk,
            'webhook_secret' => $wh,
            'updated_at' => $updated,
        ];
    }

    /**
     * @param array{enabled?:bool, publishable_key?:string, secret_key?:string, webhook_secret?:string} $in
     * @return array{enabled:bool, publishable_key:string, secret_key:string, webhook_secret:string, updated_at:string}
     */
    public static function update(array $in): array
    {
        $cur = self::get();

        $enabled = array_key_exists('enabled', $in) ? (bool) $in['enabled'] : $cur['enabled'];
        $pk = array_key_exists('publishable_key', $in) ? (string) $in['publishable_key'] : $cur['publishable_key'];
        $sk = array_key_exists('secret_key', $in) ? (string) $in['secret_key'] : $cur['secret_key'];
        $wh = array_key_exists('webhook_secret', $in) ? (string) $in['webhook_secret'] : $cur['webhook_secret'];

        $out = [
            'enabled' => $enabled,
            'publishable_key' => trim($pk),
            'secret_key' => trim($sk),
            'webhook_secret' => trim($wh),
            'updated_at' => gmdate('c'),
        ];

        update_option(self::OPTION_KEY, $out, false);

        return $out;
    }

    /**
     * @return array{enabled:bool, publishable_key:string, secret_key:string, webhook_secret:string, updated_at:string}
     */
    private static function defaults(): array
    {
        return [
            'enabled' => false,
            'publishable_key' => '',
            'secret_key' => '',
            'webhook_secret' => '',
            'updated_at' => gmdate('c'),
        ];
    }
}
