<?php
// includes/Services/V4ProxyConfig.php

declare(strict_types=1);

namespace SosPrescription\Services;

final class V4ProxyConfig
{
    /**
     * @return array{twilio_number:string,transfer_number:string,updated_at:string}
     */
    public function getTwilioConfig(): array
    {
        $twilioNumber = $this->normalizePhone(get_option('sosprescription_twilio_number', ''));

        if ($twilioNumber === '') {
            $legacy = get_option('sosprescription_twilio_settings', []);
            if (is_array($legacy)) {
                $legacyNumber = $this->normalizePhone($legacy['twilio_number'] ?? '');
                if ($legacyNumber !== '') {
                    update_option('sosprescription_twilio_number', $legacyNumber, false);
                    $twilioNumber = $legacyNumber;
                }
            }
        }

        return [
            'twilio_number' => $twilioNumber,
            'transfer_number' => '',
            'updated_at' => '',
        ];
    }

    public function magicRedirectUrl(): string
    {
        $url = esc_url_raw(home_url('/connexion-securisee/'));
        return is_string($url) && trim($url) !== '' ? trim($url) : home_url('/connexion-securisee/');
    }

    private function normalizePhone(mixed $value): string
    {
        if (!is_scalar($value)) {
            return '';
        }

        $normalized = trim(wp_strip_all_tags((string) $value));
        if ($normalized === '') {
            return '';
        }

        $normalized = preg_replace('/[\s\-\.\(\)]+/', '', $normalized) ?: $normalized;
        if (strpos($normalized, '00') === 0) {
            $normalized = '+' . substr($normalized, 2);
        }

        $normalized = preg_replace('/(?!^\+)[^0-9]/', '', $normalized) ?: $normalized;

        return $normalized;
    }
}
