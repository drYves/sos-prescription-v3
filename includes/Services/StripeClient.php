<?php
declare(strict_types=1);

namespace SosPrescription\Services;

use WP_Error;

/**
 * Client Stripe minimal via HTTP (sans dépendance externe).
 *
 * On utilise :
 * - PaymentIntent create (capture_method=manual)
 * - PaymentIntent retrieve
 * - PaymentIntent capture
 * - PaymentIntent cancel
 * - Vérification signature webhook
 */
final class StripeClient
{
    private const API_BASE = 'https://api.stripe.com/v1';

    public static function is_enabled(): bool
    {
        $cfg = StripeConfig::get();
        return $cfg['enabled'] && $cfg['secret_key'] !== '';
    }

    public static function publishable_key(): string
    {
        $cfg = StripeConfig::get();
        return (string) $cfg['publishable_key'];
    }

    public static function webhook_secret(): string
    {
        $cfg = StripeConfig::get();
        return (string) $cfg['webhook_secret'];
    }

    /**
     * @param array<string, mixed> $params
     * @param array<string, string> $headers
     * @return array<string, mixed>|WP_Error
     */
    private static function request(string $method, string $path, array $params = [], array $headers = [])
    {
        $cfg = StripeConfig::get();
        $sk = (string) $cfg['secret_key'];
        if ($sk === '') {
            return new WP_Error('sosprescription_stripe_not_configured', 'Stripe non configuré (clé secrète manquante).', ['status' => 400]);
        }

        $url = rtrim(self::API_BASE, '/') . '/' . ltrim($path, '/');

        $method = strtoupper($method);

        $args = [
            'method' => $method,
            'timeout' => 30,
            'headers' => array_merge([
                'Authorization' => 'Bearer ' . $sk,
            ], $headers),
        ];

        if ($method === 'GET') {
            if (!empty($params)) {
                $url .= (str_contains($url, '?') ? '&' : '?') . http_build_query($params);
            }
        } else {
            $args['headers']['Content-Type'] = 'application/x-www-form-urlencoded';
            $args['body'] = http_build_query($params);
        }

        $resp = wp_remote_request($url, $args);
        if (is_wp_error($resp)) {
            return $resp;
        }

        $code = (int) wp_remote_retrieve_response_code($resp);
        $body = (string) wp_remote_retrieve_body($resp);

        $json = json_decode($body, true);
        if (!is_array($json)) {
            $json = [];
        }

        if ($code < 200 || $code >= 300) {
            $msg = 'Erreur Stripe.';
            if (isset($json['error']) && is_array($json['error']) && isset($json['error']['message'])) {
                $msg = (string) $json['error']['message'];
            }
            return new WP_Error('sosprescription_stripe_error', $msg, [
                'status' => 502,
                'stripe_http_code' => $code,
                'stripe_response' => $json,
            ]);
        }

        return $json;
    }

    /**
     * @param array<string, mixed> $metadata
     * @return array<string, mixed>|WP_Error
     */
    public static function create_payment_intent(
        int $amount_cents,
        string $currency,
        array $metadata,
        ?string $idempotency_key = null
    )
    {
        $currency = strtolower(trim($currency));
        if ($currency === '') {
            $currency = 'eur';
        }

        $params = [
            'amount' => $amount_cents,
            'currency' => $currency,
            'capture_method' => 'manual',
            // Pour MVP : carte uniquement.
            'payment_method_types' => ['card'],
            'metadata' => $metadata,
        ];

        $headers = [];
        if ($idempotency_key !== null && $idempotency_key !== '') {
            $headers['Idempotency-Key'] = $idempotency_key;
        }

        return self::request('POST', '/payment_intents', $params, $headers);
    }

    /**
     * @return array<string, mixed>|WP_Error
     */
    public static function retrieve_payment_intent(string $payment_intent_id)
    {
        $payment_intent_id = trim($payment_intent_id);
        if ($payment_intent_id === '') {
            return new WP_Error('sosprescription_stripe_bad_intent', 'PaymentIntent invalide.', ['status' => 400]);
        }
        return self::request('GET', '/payment_intents/' . rawurlencode($payment_intent_id));
    }

    /**
     * @return array<string, mixed>|WP_Error
     */
    public static function capture_payment_intent(string $payment_intent_id, ?string $idempotency_key = null)
    {
        $payment_intent_id = trim($payment_intent_id);
        if ($payment_intent_id === '') {
            return new WP_Error('sosprescription_stripe_bad_intent', 'PaymentIntent invalide.', ['status' => 400]);
        }

        $headers = [];
        if ($idempotency_key !== null && $idempotency_key !== '') {
            $headers['Idempotency-Key'] = $idempotency_key;
        }

        return self::request('POST', '/payment_intents/' . rawurlencode($payment_intent_id) . '/capture', [], $headers);
    }

    /**
     * @return array<string, mixed>|WP_Error
     */
    public static function cancel_payment_intent(string $payment_intent_id, ?string $idempotency_key = null)
    {
        $payment_intent_id = trim($payment_intent_id);
        if ($payment_intent_id === '') {
            return new WP_Error('sosprescription_stripe_bad_intent', 'PaymentIntent invalide.', ['status' => 400]);
        }

        $headers = [];
        if ($idempotency_key !== null && $idempotency_key !== '') {
            $headers['Idempotency-Key'] = $idempotency_key;
        }

        return self::request('POST', '/payment_intents/' . rawurlencode($payment_intent_id) . '/cancel', [], $headers);
    }

    /**
     * Crée un remboursement lié à un PaymentIntent.
     *
     * Utile en cas d'erreur DB après capture (cas rare) ou pour des flux de remboursement.
     *
     * @return array<string, mixed>|WP_Error
     */
    public static function create_refund_for_payment_intent(string $payment_intent_id, ?int $amount_cents = null, ?string $idempotency_key = null)
    {
        $payment_intent_id = trim($payment_intent_id);
        if ($payment_intent_id === '') {
            return new WP_Error('sosprescription_stripe_bad_intent', 'PaymentIntent invalide.', ['status' => 400]);
        }

        $params = [
            'payment_intent' => $payment_intent_id,
        ];
        if ($amount_cents !== null && $amount_cents > 0) {
            $params['amount'] = $amount_cents;
        }

        $headers = [];
        if ($idempotency_key !== null && $idempotency_key !== '') {
            $headers['Idempotency-Key'] = $idempotency_key;
        }

        return self::request('POST', '/refunds', $params, $headers);
    }

    /**
     * Vérifie la signature Stripe (header Stripe-Signature) selon la doc.
     *
     * @return bool
     */
    public static function verify_webhook_signature(string $payload, string $sig_header, string $secret, int $tolerance = 300): bool
    {
        $secret = trim($secret);
        $sig_header = trim($sig_header);
        if ($secret === '' || $sig_header === '') {
            return false;
        }

        // Parse header: "t=timestamp,v1=signature,v1=signature2,..."
        $timestamp = 0;
        $signatures = [];
        foreach (explode(',', $sig_header) as $chunk) {
            $chunk = trim($chunk);
            if ($chunk === '') { continue; }
            $kv = explode('=', $chunk, 2);
            if (count($kv) !== 2) { continue; }
            $k = trim((string) $kv[0]);
            $v = trim((string) $kv[1]);
            if ($k === 't') {
                $timestamp = (int) $v;
            }
            if ($k === 'v1' && $v !== '') {
                $signatures[] = $v;
            }
        }

        if ($timestamp <= 0 || count($signatures) === 0) {
            return false;
        }

        // Tolerance check
        $now = time();
        if (abs($now - $timestamp) > $tolerance) {
            return false;
        }

        $signed_payload = $timestamp . '.' . $payload;
        $expected = hash_hmac('sha256', $signed_payload, $secret);

        // Stripe peut envoyer plusieurs signatures v1. On compare en timing-safe.
        foreach ($signatures as $sig) {
            if ($sig !== '' && hash_equals($expected, $sig)) {
                return true;
            }
        }

        return false;
    }
}
