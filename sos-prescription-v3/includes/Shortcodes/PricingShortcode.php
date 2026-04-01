<?php
declare(strict_types=1);

namespace SosPrescription\Shortcodes;

use SosPrescription\Services\Pricing;

final class PricingShortcode
{
    public static function register(): void
    {
        add_shortcode('sosprescription_pricing', [self::class, 'render']);
        add_shortcode('sosprescription_pricing_value', [self::class, 'render']);
    }

    public static function render(array|string $atts = []): string
    {
        $atts = shortcode_atts([
            'type'   => 'standard',
            'field'  => 'price',
            'approx' => '0',
            'prefix' => '',
            'suffix' => '',
        ], is_array($atts) ? $atts : [], 'sosprescription_pricing');

        $type  = sanitize_key((string) $atts['type']);
        $field = sanitize_key((string) $atts['field']);
        $data  = Pricing::get();

        $isExpress = in_array($type, ['express', 'sos', 'priority'], true);
        $priceCents = $isExpress ? (int) $data['express_cents'] : (int) $data['standard_cents'];
        $etaMinutes = $isExpress ? (int) $data['express_eta_minutes'] : (int) $data['standard_eta_minutes'];
        $currency   = (string) $data['currency'];
        $updatedAt  = (string) $data['updated_at'];

        $output = '';
        switch ($field) {
            case 'price_amount':
            case 'amount':
                $output = self::format_price_number($priceCents);
                break;
            case 'price':
                $output = Pricing::format_price($priceCents, $currency);
                break;
            case 'eta_value':
            case 'eta_minutes':
                $output = (string) $etaMinutes;
                break;
            case 'eta':
                $output = Pricing::format_eta($etaMinutes, self::truthy($atts['approx']));
                break;
            case 'currency':
                $output = $currency;
                break;
            case 'updated_at':
                $output = $updatedAt;
                break;
            case 'label':
                $output = $isExpress ? 'SOS prioritaire' : 'Standard';
                break;
            default:
                $output = Pricing::format_price($priceCents, $currency);
                break;
        }

        return $atts['prefix'] . $output . $atts['suffix'];
    }

    private static function truthy(mixed $value): bool
    {
        if (is_bool($value)) {
            return $value;
        }

        $value = strtolower(trim((string) $value));
        return in_array($value, ['1', 'true', 'yes', 'y', 'on'], true);
    }

    private static function format_price_number(int $cents): string
    {
        $amount = $cents / 100;
        $isWhole = abs($amount - round($amount)) < 0.00001;
        return number_format($amount, $isWhole ? 0 : 2, ',', ' ');
    }
}
