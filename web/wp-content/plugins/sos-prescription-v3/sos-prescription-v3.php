<?php
/**
 * Plugin Name:       SOS Prescription v3
 * Description:       MedLab v2026.5 WordPress Brain connector (stateless, medical-grade).
 * Version:           2026.5.0
 * Requires at least: 6.5
 * Requires PHP:      8.2
 * Text Domain:       sos-prescription-v3
 */

declare(strict_types=1);

if (!defined('ABSPATH')) {
    exit;
}

$rootAutoload = dirname(__DIR__, 4) . '/vendor/autoload.php';
if (file_exists($rootAutoload)) {
    require_once $rootAutoload;
}

require_once __DIR__ . '/includes/Core/Base64Url.php';
require_once __DIR__ . '/includes/Core/ReqId.php';
require_once __DIR__ . '/includes/Core/NdjsonLogger.php';
require_once __DIR__ . '/includes/Core/MedLabConnector.php';
require_once __DIR__ . '/includes/Core/WorkerHealthService.php';
require_once __DIR__ . '/includes/Core/NonceStore.php';
require_once __DIR__ . '/includes/Core/Mls1Verifier.php';
require_once __DIR__ . '/includes/Core/JobDispatcher.php';
require_once __DIR__ . '/includes/Core/S3DeliveryService.php';
require_once __DIR__ . '/includes/Core/PdfAccessService.php';
require_once __DIR__ . '/includes/Rest/WorkerCallbackController.php';
require_once __DIR__ . '/includes/Rest/WorkerRenderController.php';
require_once __DIR__ . '/includes/Admin/MedLabStatusAdmin.php';
require_once __DIR__ . '/includes/Install.php';

register_activation_hook(__FILE__, ['SosPrescription\Install', 'activate']);

\SosPrescription\Rest\WorkerCallbackController::register();
\SosPrescription\Rest\WorkerRenderController::register();
\SosPrescription\Admin\MedLabStatusAdmin::register();
