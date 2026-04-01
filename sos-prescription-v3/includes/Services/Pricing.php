<?php
declare(strict_types=1);

namespace SosPrescription\Services;

/**
 * Stocke et renvoie les tarifs (standard / express).
 *
 * Objectif: permettre de configurer le prix depuis le backoffice, et de le
 * consommer via l'API (front patient / admin).
 */
final class Pricing
{
    public const OPTION_KEY = 'sosprescription_pricing';

    /**
     * @return array{standard_cents:int, express_cents:int, standard_eta_minutes:int, express_eta_minutes:int, currency:string, updated_at:string}
     */
    public static function get(): array
    {
        $raw = get_option(self::OPTION_KEY, null);
        if (!is_array($raw)) {
            return self::defaults();
        }

        $standard = isset($raw['standard_cents']) ? (int) $raw['standard_cents'] : self::defaults()['standard_cents'];
        $express  = isset($raw['express_cents']) ? (int) $raw['express_cents'] : self::defaults()['express_cents'];
        $standard_eta = isset($raw['standard_eta_minutes']) ? (int) $raw['standard_eta_minutes'] : self::defaults()['standard_eta_minutes'];
        $express_eta  = isset($raw['express_eta_minutes']) ? (int) $raw['express_eta_minutes'] : self::defaults()['express_eta_minutes'];
        $currency = isset($raw['currency']) && is_string($raw['currency']) ? strtoupper(trim($raw['currency'])) : self::defaults()['currency'];
        $updated  = isset($raw['updated_at']) && is_string($raw['updated_at']) ? $raw['updated_at'] : self::defaults()['updated_at'];

        if ($standard < 0) { $standard = 0; }
        if ($express < 0) { $express = 0; }
        if ($standard_eta < 1) { $standard_eta = self::defaults()['standard_eta_minutes']; }
        if ($express_eta < 1) { $express_eta = self::defaults()['express_eta_minutes']; }
        if ($currency === '') { $currency = 'EUR'; }

        return [
            'standard_cents' => $standard,
            'express_cents' => $express,
            'standard_eta_minutes' => $standard_eta,
            'express_eta_minutes' => $express_eta,
            'currency' => $currency,
            'updated_at' => $updated,
        ];
    }

    /**
     * @param array{standard_cents?:int, express_cents?:int, standard_eta_minutes?:int, express_eta_minutes?:int, currency?:string} $in
     * @return array{standard_cents:int, express_cents:int, standard_eta_minutes:int, express_eta_minutes:int, currency:string, updated_at:string}
     */
    public static function update(array $in): array
    {
        $cur = self::get();

        $standard = isset($in['standard_cents']) ? (int) $in['standard_cents'] : $cur['standard_cents'];
        $express  = isset($in['express_cents']) ? (int) $in['express_cents'] : $cur['express_cents'];
        $standard_eta = isset($in['standard_eta_minutes']) ? (int) $in['standard_eta_minutes'] : $cur['standard_eta_minutes'];
        $express_eta  = isset($in['express_eta_minutes']) ? (int) $in['express_eta_minutes'] : $cur['express_eta_minutes'];
        $currency = isset($in['currency']) && is_string($in['currency']) ? strtoupper(trim($in['currency'])) : $cur['currency'];

        if ($standard < 0) { $standard = 0; }
        if ($express < 0) { $express = 0; }
        if ($standard_eta < 1) { $standard_eta = self::defaults()['standard_eta_minutes']; }
        if ($express_eta < 1) { $express_eta = self::defaults()['express_eta_minutes']; }
        if ($currency === '') { $currency = 'EUR'; }

        $out = [
            'standard_cents' => $standard,
            'express_cents' => $express,
            'standard_eta_minutes' => $standard_eta,
            'express_eta_minutes' => $express_eta,
            'currency' => $currency,
            'updated_at' => gmdate('c'),
        ];

        update_option(self::OPTION_KEY, $out, false);

        return $out;
    }


    /**
     * Formate un prix stocké en cents pour affichage public.
     */
    public static function format_price(int $cents, ?string $currency = null): string
    {
        if ($cents < 0) {
            $cents = 0;
        }

        if ($currency === null || $currency === '') {
            $currency = self::get()['currency'];
        }

        $amount = $cents / 100;
        $isWhole = abs($amount - round($amount)) < 0.00001;
        $formatted = number_format($amount, $isWhole ? 0 : 2, ',', ' ');

        $currency = strtoupper(trim((string) $currency));

        if ($currency === 'EUR') {
            return $formatted . ' €';
        }

        return trim($formatted . ' ' . $currency);
    }

    /**
     * Formate un délai en minutes pour affichage public.
     */
    public static function format_eta(int $minutes, bool $approx = false): string
    {
        if ($minutes < 1) {
            $minutes = 1;
        }

        return ($approx ? '≈ ' : '') . $minutes . ' min';
    }

    /**
     * @return array{standard_cents:int, express_cents:int, standard_eta_minutes:int, express_eta_minutes:int, currency:string, updated_at:string}
     */
    private static function defaults(): array
    {
        return [
            // Valeurs par défaut (à ajuster en admin)
            'standard_cents' => 2500,
            'express_cents' => 4000,
            // SLA (estimations UX)
            'standard_eta_minutes' => 120,
            'express_eta_minutes' => 30,
            'currency' => 'EUR',
            'updated_at' => gmdate('c'),
        ];
    }
}
