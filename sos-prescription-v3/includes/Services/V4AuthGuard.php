<?php
// includes/Services/V4AuthGuard.php

declare(strict_types=1);

namespace SosPrescription\Services;

use WP_Error;
use WP_REST_Request;

final class V4AuthGuard
{
    /**
     * @return true|WP_Error
     */
    public function requireLoggedInNonce(WP_REST_Request $request)
    {
        if (!is_user_logged_in()) {
            return new WP_Error(
                'sosprescription_auth_required',
                'Connexion requise.',
                ['status' => 401]
            );
        }

        $nonce = $this->extractRestNonce($request);
        if ($nonce === '' || !wp_verify_nonce($nonce, 'wp_rest')) {
            return new WP_Error(
                'sosprescription_bad_nonce',
                'Nonce REST invalide.',
                ['status' => 403]
            );
        }

        return true;
    }


    /**
     * @return true|WP_Error
     */
    public function requireDoctorNonce(WP_REST_Request $request)
    {
        $ok = $this->requireLoggedInNonce($request);
        if (is_wp_error($ok)) {
            return $ok;
        }

        if (!$this->isDoctorLike()) {
            return new WP_Error(
                'sosprescription_forbidden',
                'Accès refusé.',
                ['status' => 403]
            );
        }

        return true;
    }

    /**
     * @return true|WP_Error
     */
    public function requireWorkerSecret(WP_REST_Request $request)
    {
        $secrets = $this->workerSharedSecrets();
        if ($secrets === []) {
            return new WP_Error(
                'sosprescription_worker_secret_missing',
                'Secret worker absent.',
                ['status' => 503]
            );
        }

        $authorization = (string) ($request->get_header('Authorization') ?: $request->get_header('authorization'));
        $provided = '';
        if ($authorization !== '' && preg_match('/Bearer\s+(.+)$/i', $authorization, $matches)) {
            $provided = trim((string) $matches[1]);
        }

        if ($provided === '') {
            $provided = trim((string) ($request->get_header('X-SOSPrescription-Worker-Secret') ?: $request->get_header('x-sosprescription-worker-secret')));
        }

        if ($provided === '') {
            return new WP_Error(
                'sosprescription_forbidden',
                'Accès refusé.',
                ['status' => 403]
            );
        }

        foreach ($secrets as $secret) {
            if (hash_equals($secret, $provided)) {
                return true;
            }
        }

        return new WP_Error(
            'sosprescription_forbidden',
            'Accès refusé.',
            ['status' => 403]
        );
    }

    private function extractRestNonce(WP_REST_Request $request): string
    {
        $headerNonce = $request->get_header('X-WP-Nonce');
        if (!is_scalar($headerNonce) || trim((string) $headerNonce) === '') {
            $headerNonce = $request->get_header('x-wp-nonce');
        }

        if (is_scalar($headerNonce) && trim((string) $headerNonce) !== '') {
            return trim((string) $headerNonce);
        }

        $paramNonce = $request->get_param('_wpnonce');
        if (is_scalar($paramNonce) && trim((string) $paramNonce) !== '') {
            return trim((string) $paramNonce);
        }

        return '';
    }

    private function isDoctorLike(): bool
    {
        if (class_exists('\SosPrescription\\Services\\AccessPolicy')) {
            $accessPolicy = '\\SosPrescription\\Services\\AccessPolicy';
            $isDoctor = method_exists($accessPolicy, 'is_doctor') ? (bool) $accessPolicy::is_doctor() : false;
            $isAdmin = method_exists($accessPolicy, 'is_admin') ? (bool) $accessPolicy::is_admin() : false;
            if ($isDoctor || $isAdmin) {
                return true;
            }
        }

        return current_user_can('manage_options') || current_user_can('edit_others_posts');
    }

    /**
     * @return array<int, string>
     */
    private function workerSharedSecrets(): array
    {
        $candidates = [
            trim((string) $this->readConfigString('ML_TWILIO_WORKER_SECRET', '')),
            trim((string) $this->readConfigString('ML_HMAC_SECRET', '')),
            trim((string) $this->readConfigString('ML_HMAC_SECRET_PREVIOUS', '')),
        ];

        $secrets = [];
        foreach ($candidates as $candidate) {
            if ($candidate === '') {
                continue;
            }
            $secrets[] = $candidate;
        }

        return array_values(array_unique($secrets));
    }

    private function readConfigString(string $name, string $default = ''): string
    {
        if (defined($name)) {
            $value = constant($name);
            if (is_string($value)) {
                return $value;
            }

            if (is_scalar($value)) {
                return (string) $value;
            }
        }

        $value = getenv($name);
        if (is_string($value)) {
            return $value;
        }

        return $default;
    }
}
