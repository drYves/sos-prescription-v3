<?php
declare(strict_types=1);

namespace SOSPrescription\Rest;

use SOSPrescription\Repositories\PrescriptionRepository;
use SOSPrescription\Services\Logger;
use SOSPrescription\Services\RestGuard;
use WP_Error;
use WP_REST_Request;

final class VerificationController
{
    /**
     * Public endpoint used by /v/{token}.
     *
     * POST /wp-json/sosprescription/v1/verify/{token}/deliver
     * Body: {"code":"123456"}
     */
    public static function deliver(WP_REST_Request $request)
    {
        // Anti brute-force: 5 attempts / hour (token+IP).
        $throttle = RestGuard::throttle($request, 'rx_delivery', 5, 3600);
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
            Logger::ndjson_scoped('rx', 'rx_delivery_attempt', [
                'token_prefix' => substr($token, 0, 8),
                'found' => false,
                'code_ok' => false,
            ], 'warn');

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

        Logger::ndjson_scoped('rx', 'rx_delivery_attempt', [
            'rx_id' => $rx_id,
            'token_prefix' => substr($token, 0, 8),
            'already_dispensed' => $already_dispensed,
            'code_len' => strlen($code),
        ], 'info');

        if ($already_dispensed) {
            return rest_ensure_response([
                'ok' => true,
                'already_dispensed' => true,
                'dispensed_at' => (string) $rx['dispensed_at'],
                'req_id' => Logger::rid(),
            ]);
        }

        if ($expected === '') {
            Logger::ndjson_scoped('rx', 'rx_delivery_error', [
                'rx_id' => $rx_id,
                'token_prefix' => substr($token, 0, 8),
                'reason' => 'missing_verify_code',
            ], 'error');

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
            Logger::ndjson_scoped('rx', 'rx_delivery_attempt', [
                'rx_id' => $rx_id,
                'token_prefix' => substr($token, 0, 8),
                'code_ok' => false,
            ], 'warn');

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
            Logger::ndjson_scoped('rx', 'rx_delivery_error', [
                'rx_id' => $rx_id,
                'token_prefix' => substr($token, 0, 8),
                'reason' => 'db_update_failed',
            ], 'error');

            return new WP_Error(
                'rx_deliver_failed',
                'Erreur lors de la confirmation de délivrance.',
                [
                    'status' => 500,
                    'req_id' => Logger::rid(),
                ]
            );
        }

        // Refresh record to get final dispensed_at.
        $rx2 = $repo->get_by_verify_token($token);
        $dispensed_at = (is_array($rx2) && !empty($rx2['dispensed_at'])) ? (string) $rx2['dispensed_at'] : gmdate('c');

        Logger::ndjson_scoped('rx', 'rx_delivered', [
            'rx_id' => $rx_id,
            'token_prefix' => substr($token, 0, 8),
            'dispensed_at' => $dispensed_at,
        ], 'info');

        return rest_ensure_response([
            'ok' => true,
            'already_dispensed' => false,
            'dispensed_at' => $dispensed_at,
            'req_id' => Logger::rid(),
        ]);
    }
}
