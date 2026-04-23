<?php
// includes/api-v4-proxy.php

declare(strict_types=1);

defined('ABSPATH') || exit;

require_once __DIR__ . '/Services/PrescriptionProjectionStore.php';
require_once __DIR__ . '/Services/V4AuthGuard.php';
require_once __DIR__ . '/Services/DraftRepository.php';
require_once __DIR__ . '/Services/V4InputNormalizer.php';
require_once __DIR__ . '/Services/V4ProxyConfig.php';
require_once __DIR__ . '/Services/V4WorkerTransport.php';
require_once __DIR__ . '/Services/MedicationValidationBridge.php';
require_once __DIR__ . '/Rest/V4ProxyController.php';

add_action('rest_api_init', static function (): void {
    global $wpdb;
    if (!($wpdb instanceof wpdb)) {
        return;
    }

    $projectionStore = new \SosPrescription\Services\PrescriptionProjectionStore($wpdb);
    $input = new \SosPrescription\Services\V4InputNormalizer();
    $transport = new \SosPrescription\Services\V4WorkerTransport($input);
    $drafts = new \SosPrescription\Services\DraftRepository();
    $config = new \SosPrescription\Services\V4ProxyConfig();
    $authGuard = new \SosPrescription\Services\V4AuthGuard();
    $controller = new \SosPrescription\Rest\V4ProxyController(
        $input,
        $transport,
        $drafts,
        $config,
        $projectionStore
    );

    $medicationValidation = new \SOSPrescription\Services\MedicationValidationBridge();

    $validatedDraftCallback = static function (WP_REST_Request $request) use ($controller, $medicationValidation) {
        $validated = $medicationValidation->validateRequestItems($request, 'submission');
        if (is_wp_error($validated)) {
            return $validated;
        }

        return $controller->createSubmissionDraft($request);
    };

    $validatedDraftResendCallback = static function (WP_REST_Request $request) use ($controller, $medicationValidation) {
        $validated = $medicationValidation->validateRequestItems($request, 'submission_resend');
        if (is_wp_error($validated)) {
            return $validated;
        }

        return $controller->resendSubmissionDraft($request);
    };

    $requireLoggedInNonce = static function (WP_REST_Request $request) use ($authGuard) {
        return $authGuard->requireLoggedInNonce($request);
    };

    $requireDoctorNonce = static function (WP_REST_Request $request) use ($authGuard) {
        return $authGuard->requireDoctorNonce($request);
    };

    $requireWorkerSecret = static function (WP_REST_Request $request) use ($authGuard) {
        return $authGuard->requireWorkerSecret($request);
    };

    $requirePublicDraftAccess = static function (WP_REST_Request $request) {
        if (class_exists('\SosPrescription\\Services\\RestGuard')) {
            return \SosPrescription\Services\RestGuard::throttle($request, 'prescription_create', ['limit' => 5, 'window' => 900]);
        }

        return true;
    };

    register_rest_route('sosprescription/v4', '/twilio/config', [
        'methods' => 'GET',
        'permission_callback' => $requireWorkerSecret,
        'callback' => [$controller, 'twilioConfig'],
    ]);

    register_rest_route('sosprescription/v4', '/medications/search', [
        'methods' => 'GET',
        'permission_callback' => '__return_true',
        'callback' => [$controller, 'medicationsSearch'],
    ]);

    register_rest_route('sosprescription/v4', '/submissions/draft', [
        'methods' => 'POST',
        'permission_callback' => $requirePublicDraftAccess,
        'callback' => $validatedDraftCallback,
    ]);

    register_rest_route('sosprescription/v4', '/submissions/draft/resend', [
        'methods' => 'POST',
        'permission_callback' => $requirePublicDraftAccess,
        'callback' => $validatedDraftResendCallback,
    ]);

    register_rest_route('sosprescription/v4', '/submissions/draft/(?P<ref>[A-Za-z0-9_-]{8,128})', [
        'methods' => 'GET',
        'permission_callback' => $requireLoggedInNonce,
        'callback' => [$controller, 'getSubmissionDraft'],
    ]);

    register_rest_route('sosprescription/v4', '/prescriptions/(?P<id>\d+)/smart-replies', [
        'methods' => 'GET',
        'permission_callback' => $requireDoctorNonce,
        'callback' => [$controller, 'smartReplies'],
    ]);
});
