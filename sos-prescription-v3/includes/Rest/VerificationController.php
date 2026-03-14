<?php
// includes/Rest/VerificationController.php
declare(strict_types=1);

namespace SosPrescription\Rest;

use SosPrescription\Repositories\PrescriptionRepository;
use SosPrescription\Services\Logger;
use SosPrescription\Services\RestGuard;
use WP_Error;
use WP_REST_Request;

final class VerificationController
{
    public static function deliver(WP_REST_Request $request)
    {
        $throttle = RestGuard::throttle($request, 'rx_delivery', [
            'limit' => 5,
            'window' => 3600,
        ]);

        if ($throttle instanceof WP_Error) {
            $data = $throttle->get_error_data();
            if (!is_array($data)) {
                $data = [];
            }
            if (empty($data['req_id'])) {
                $data['req_id'] = Logger::rid();
            }

            return new WP_Error(
                $throttle->get_error_code(),
                $throttle->get_error_message(),
                $data
            );
        }

        $token = (string) $request->get_param('token');
        $code_raw = (string) $request->get_param('code');
        $code = preg_replace('/\D+/', '', $code_raw);
        $code = is_string($code) ? $code : '';

        if ($token === '' || !preg_match('/^[a-f0-9]{16,64}$/i', $token)) {
            return new WP_Error(
                'invalid_token',
                'Lien de vérification invalide.',
                [
                    'status' => 400,
                    'req_id' => Logger::rid(),
                ]
            );
        }

        if ($code === '' || !preg_match('/^\d{6}$/', $code)) {
            return new WP_Error(
                'invalid_code',
                'Code invalide. Veuillez saisir 6 chiffres.',
                [
                    'status' => 400,
                    'req_id' => Logger::rid(),
                ]
            );
        }

        $repo = new PrescriptionRepository();
        $rx = $repo->get_by_verify_token($token);
        if (!is_array($rx) || empty($rx['id'])) {
            self::safe_ndjson('warn', 'rx_delivery_attempt', [
                'token_prefix' => substr($token, 0, 8),
                'found' => false,
                'code_ok' => false,
            ]);

            return new WP_Error(
                'rx_not_found',
                'Ordonnance introuvable ou expirée.',
                [
                    'status' => 404,
                    'req_id' => Logger::rid(),
                ]
            );
        }

        $rx_id = (int) $rx['id'];
        $expected = isset($rx['verify_code']) ? (string) $rx['verify_code'] : '';
        $already_dispensed = !empty($rx['dispensed_at']);

        self::safe_ndjson('info', 'rx_delivery_attempt', [
            'rx_id' => $rx_id,
            'token_prefix' => substr($token, 0, 8),
            'already_dispensed' => $already_dispensed,
            'code_len' => strlen($code),
        ]);

        if ($already_dispensed) {
            return rest_ensure_response([
                'ok' => true,
                'already_dispensed' => true,
                'dispensed_at' => (string) $rx['dispensed_at'],
                'req_id' => Logger::rid(),
            ]);
        }

        if ($expected === '') {
            self::safe_ndjson('error', 'rx_delivery_error', [
                'rx_id' => $rx_id,
                'token_prefix' => substr($token, 0, 8),
                'reason' => 'missing_verify_code',
            ]);

            return new WP_Error(
                'rx_not_deliverable',
                'Ordonnance non délivrable (code manquant).',
                [
                    'status' => 409,
                    'req_id' => Logger::rid(),
                ]
            );
        }

        if (!hash_equals($expected, $code)) {
            self::safe_ndjson('warn', 'rx_delivery_attempt', [
                'rx_id' => $rx_id,
                'token_prefix' => substr($token, 0, 8),
                'code_ok' => false,
            ]);

            return new WP_Error(
                'invalid_code',
                'Code incorrect.',
                [
                    'status' => 403,
                    'req_id' => Logger::rid(),
                ]
            );
        }

        $ip = isset($_SERVER['REMOTE_ADDR']) ? (string) $_SERVER['REMOTE_ADDR'] : '';
        $ok = $repo->mark_dispensed($rx_id, $ip);
        if (!$ok) {
            self::safe_ndjson('error', 'rx_delivery_error', [
                'rx_id' => $rx_id,
                'token_prefix' => substr($token, 0, 8),
                'reason' => 'db_update_failed',
            ]);

            return new WP_Error(
                'rx_deliver_failed',
                'Erreur lors de la confirmation de délivrance.',
                [
                    'status' => 500,
                    'req_id' => Logger::rid(),
                ]
            );
        }

        $rx2 = $repo->get_by_verify_token($token);
        $dispensed_at = (is_array($rx2) && !empty($rx2['dispensed_at'])) ? (string) $rx2['dispensed_at'] : gmdate('c');

        self::safe_ndjson('info', 'rx_delivered', [
            'rx_id' => $rx_id,
            'token_prefix' => substr($token, 0, 8),
            'dispensed_at' => $dispensed_at,
        ]);

        return rest_ensure_response([
            'ok' => true,
            'already_dispensed' => false,
            'dispensed_at' => $dispensed_at,
            'req_id' => Logger::rid(),
        ]);
    }

    /**
     * @param array<string,mixed> $payload
     */
    private static function safe_ndjson(string $level, string $event, array $payload = []): void
    {
        try {
            Logger::ndjson_scoped('runtime', 'rx', $level, $event, $payload);
        } catch (\Throwable $e) {
            error_log('[SOSPrescription] VerificationController log failure: ' . $e->getMessage() . ' | event=' . $event);
        }
    }
}
