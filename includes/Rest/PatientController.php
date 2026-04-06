<?php

declare(strict_types=1);

namespace SosPrescription\Rest;

use SosPrescription\Services\RestGuard;
use WP_Error;
use WP_REST_Request;
use WP_REST_Response;

/**
 * Legacy V1 compatibility bridge.
 *
 * This controller intentionally avoids writing any patient health data in
 * WordPress user meta. The Worker remains the source of truth and the V1 route
 * delegates to the V4 proxy controller for backward compatibility.
 */
class PatientController extends \WP_REST_Controller
{
    public function permissions_check_logged_in_nonce(WP_REST_Request $request): bool|WP_Error
    {
        $ok = RestGuard::require_logged_in($request);
        if (is_wp_error($ok)) {
            return $ok;
        }

        return RestGuard::require_wp_rest_nonce($request);
    }

    public function update_profile(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $controller = new PatientV4Controller();
        return $controller->update_profile($request);
    }
}
