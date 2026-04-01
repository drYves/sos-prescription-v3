<?php
declare(strict_types=1);

namespace SosPrescription\Rest;

use SosPrescription\Services\Logger;
use SosPrescription\Services\MagicLink;
use SosPrescription\Services\RestGuard;
use WP_Error;
use WP_REST_Request;
use WP_REST_Response;

final class AuthController
{
    private MagicLink $magicLink;

    public function __construct(?MagicLink $magicLink = null)
    {
        $this->magicLink = $magicLink instanceof MagicLink ? $magicLink : new MagicLink();
    }

    public function permissions_check_public(WP_REST_Request $request): bool
    {
        return true;
    }

    public function request_magic_link(WP_REST_Request $request)
    {
        $ok = RestGuard::throttle($request, 'prescription_create', ['limit' => 5, 'window' => 900]);
        if (is_wp_error($ok)) {
            return $ok;
        }

        $params = $this->request_data($request);
        $email = isset($params['email']) ? sanitize_email((string) $params['email']) : '';
        if ($email === '' || !is_email($email)) {
            return new WP_Error('sosprescription_bad_email', 'Adresse e-mail invalide.', ['status' => 400]);
        }

        $role = isset($params['role']) && is_string($params['role']) ? trim($params['role']) : 'patient';
        $redirectTo = isset($params['redirect_to']) && is_string($params['redirect_to']) ? trim($params['redirect_to']) : '';

        try {
            $result = $this->magicLink->request($email, [
                'role' => $role,
                'redirect_to' => $redirectTo,
            ]);
        } catch (\InvalidArgumentException $e) {
            return new WP_Error('sosprescription_bad_magic_request', $e->getMessage(), ['status' => 400]);
        } catch (\Throwable $e) {
            $this->logWarning('auth_magic_link_request_failed', [
                'message' => $e->getMessage(),
            ]);
            return new WP_Error('sosprescription_magic_link_send_failed', 'Impossible d’envoyer le lien magique.', ['status' => 502]);
        }

        return new WP_REST_Response([
            'ok' => true,
            'sent' => true,
            'expires_in' => isset($result['expires_in']) ? (int) $result['expires_in'] : MagicLink::TTL_SECONDS,
            'email_masked' => isset($result['email_masked']) ? (string) $result['email_masked'] : '',
        ], 200);
    }

    public function consume_magic_link(WP_REST_Request $request)
    {
        $ok = RestGuard::throttle($request, 'prescription_create', ['limit' => 10, 'window' => 900]);
        if (is_wp_error($ok)) {
            return $ok;
        }

        $params = $this->request_data($request);
        $token = isset($params['token']) ? trim((string) $params['token']) : '';
        if ($token === '') {
            return new WP_Error('sosprescription_bad_magic_token', 'Token manquant.', ['status' => 400]);
        }

        try {
            $result = $this->magicLink->consume($token);
        } catch (\InvalidArgumentException $e) {
            return new WP_Error('sosprescription_bad_magic_token', $e->getMessage(), ['status' => 400]);
        } catch (\Throwable $e) {
            $this->logWarning('auth_magic_link_consume_failed', [
                'message' => $e->getMessage(),
            ]);
            return new WP_Error('sosprescription_magic_link_invalid', 'Lien magique invalide ou expiré.', ['status' => 401]);
        }

        return rest_ensure_response($result);
    }

    private function request_data(WP_REST_Request $request): array
    {
        $body = $request->get_json_params();
        if (!is_array($body) || $body === []) {
            $body = $request->get_body_params();
        }
        if (!is_array($body) || $body === []) {
            $body = $request->get_params();
        }
        return is_array($body) ? $body : [];
    }

    private function logWarning(string $event, array $payload): void
    {
        try {
            Logger::ndjson_scoped('runtime', 'auth_magic_link', 'warning', $event, $payload);
        } catch (\Throwable $e) {
            error_log('[SOSPrescription] AuthController log failure: ' . $e->getMessage());
        }
    }
}
