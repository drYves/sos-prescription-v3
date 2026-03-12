<?php
declare(strict_types=1);

namespace SOSPrescription\Rest;

use SOSPrescription\Services\Logger;
use WP_Error;
use WP_REST_Request;

final class LogController
{
    public function permissions_check_logged_in_nonce(WP_REST_Request $request): bool|WP_Error
    {
        if (!is_user_logged_in()) {
            return new WP_Error('sosprescription_not_logged_in', 'Connexion requise.', ['status' => 401]);
        }

        $method = strtoupper($request->get_method());
        // Pour les endpoints en lecture (GET), on n’exige pas de nonce :
        // cela évite les erreurs 403 si la page est cachée / nonce expiré.
        if (in_array($method, ['GET', 'HEAD', 'OPTIONS'], true)) {
            return true;
        }

        $nonce = (string) $request->get_header('X-WP-Nonce');
        if (!$nonce) {
            return new WP_Error('sosprescription_bad_nonce', 'Nonce manquant.', ['status' => 403]);
        }
        if (!wp_verify_nonce($nonce, 'wp_rest')) {
            return new WP_Error('sosprescription_bad_nonce', 'Nonce invalide.', ['status' => 403]);
        }

        return true;
    }

    public function frontend(WP_REST_Request $request)
    {
        $params = $request->get_json_params();
        if (!is_array($params)) {
            $params = [];
        }

        $shortcode = isset($params['shortcode']) ? strtolower(trim((string) $params['shortcode'])) : '';
        $event = isset($params['event']) ? trim((string) $params['event']) : '';
        $level = isset($params['level']) ? strtolower(trim((string) $params['level'])) : 'info';

        if ($shortcode === '') {
            return new WP_Error('sosprescription_bad_shortcode', 'Shortcode manquant.', ['status' => 400]);
        }

        // Normaliser le nom de shortcode/scope.
        $shortcode = preg_replace('/[^a-z0-9_]+/', '_', $shortcode);
        if (!is_string($shortcode) || $shortcode === '') {
            return new WP_Error('sosprescription_bad_shortcode', 'Shortcode invalide.', ['status' => 400]);
        }

        if ($event === '') {
            $event = 'frontend_event';
        }
        $event = preg_replace('/[^a-zA-Z0-9_\-\.]+/', '_', $event);
        if (!is_string($event) || $event === '') {
            $event = 'frontend_event';
        }
        if (strlen($event) > 80) {
            $event = substr($event, 0, 80);
        }

        if ($level !== 'debug' && $level !== 'info' && $level !== 'warning' && $level !== 'error') {
            $level = 'info';
        }

        $meta = isset($params['meta']) && is_array($params['meta']) ? $params['meta'] : [];

        // Sanitize meta : scalaires only, taille limitée.
        $meta_clean = [];
        $i = 0;
        foreach ($meta as $k => $v) {
            if ($i >= 25) {
                break;
            }
            $key = is_string($k) ? $k : (string) $k;
            $key = preg_replace('/[^a-zA-Z0-9_\-\.]+/', '_', $key);
            if (!is_string($key) || $key === '') {
                continue;
            }

            if (is_scalar($v) || $v === null) {
                $val = $v;
                if (is_string($val) && strlen($val) > 500) {
                    $val = substr($val, 0, 500) . '…';
                }
                $meta_clean[$key] = $val;
                $i++;
                continue;
            }

            if (is_object($v)) {
                $meta_clean[$key] = get_class($v);
                $i++;
                continue;
            }

            $meta_clean[$key] = gettype($v);
            $i++;
        }

        $msg = 'frontend_' . $event;
        $ctx = $meta_clean;
        $ctx['event'] = $event;

        Logger::log_shortcode($shortcode, $level, $msg, $ctx);

        return rest_ensure_response(['ok' => true]);
    }
}
