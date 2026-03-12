<?php
declare(strict_types=1);

namespace SOSPrescription\Rest;

use SOSPrescription\Services\Pricing;
use SOSPrescription\Services\RestGuard;
use WP_Error;
use WP_REST_Request;

final class PricingController
{
    public function permissions_check_public(WP_REST_Request $request): bool
    {
        // Info de prix publique (affichable sur landing page)
        return true;
    }

    public function permissions_check_manage(WP_REST_Request $request): bool|WP_Error
    {
        $ok = RestGuard::require_logged_in($request);
        if (is_wp_error($ok)) {
            return $ok;
        }

        $ok = RestGuard::require_wp_rest_nonce($request);
        if (is_wp_error($ok)) {
            return $ok;
        }

        $ok = RestGuard::require_any_cap($request, ['sosprescription_manage', 'manage_options']);
        if (is_wp_error($ok)) {
            return $ok;
        }

        return true;
    }

    public function get_public(WP_REST_Request $request)
    {
        $p = Pricing::get();

        // Public: ne renvoie que l'essentiel.
        return rest_ensure_response([
            'standard_cents' => $p['standard_cents'],
            'express_cents' => $p['express_cents'],
            'standard_eta_minutes' => $p['standard_eta_minutes'],
            'express_eta_minutes' => $p['express_eta_minutes'],
            'currency' => $p['currency'],
            'updated_at' => $p['updated_at'],
        ]);
    }

    public function get_admin(WP_REST_Request $request)
    {
        return rest_ensure_response(Pricing::get());
    }

    public function update_admin(WP_REST_Request $request)
    {
        $params = $request->get_json_params();
        if (!is_array($params)) {
            $params = [];
        }

        // On accepte soit *_cents (int), soit *_eur (string/number)
        $in = [];

        if (isset($params['standard_cents'])) {
            $in['standard_cents'] = (int) $params['standard_cents'];
        } elseif (isset($params['standard_eur'])) {
            $in['standard_cents'] = self::eur_to_cents($params['standard_eur']);
        }

        if (isset($params['express_cents'])) {
            $in['express_cents'] = (int) $params['express_cents'];
        } elseif (isset($params['express_eur'])) {
            $in['express_cents'] = self::eur_to_cents($params['express_eur']);
        }

        if (isset($params['currency']) && is_string($params['currency'])) {
            $in['currency'] = (string) $params['currency'];
        }

        if (isset($params['standard_eta_minutes'])) {
            $in['standard_eta_minutes'] = (int) $params['standard_eta_minutes'];
        }
        if (isset($params['express_eta_minutes'])) {
            $in['express_eta_minutes'] = (int) $params['express_eta_minutes'];
        }

        $out = Pricing::update($in);
        return rest_ensure_response($out);
    }

    private static function eur_to_cents(mixed $v): int
    {
        if (is_int($v)) {
            return $v * 100;
        }
        if (is_float($v)) {
            return (int) round($v * 100);
        }
        $s = is_string($v) ? trim($v) : '';
        if ($s === '') { return 0; }
        // "12,34" -> "12.34"
        $s = str_replace(',', '.', $s);
        if (!is_numeric($s)) { return 0; }
        return (int) round(((float) $s) * 100);
    }
}
