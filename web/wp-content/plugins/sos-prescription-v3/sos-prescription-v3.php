<?php
/**
 * Plugin Name:       SOS Prescription v3
 * Plugin URI:        https://github.com/
 * Description:       MedLab v2026.5 WordPress Brain connector (stateless, medical-grade).
 * Version:           2026.5.0
 * Requires at least: 6.5
 * Requires PHP:      8.2
 * Author:            SOS Engineering
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       sos-prescription-v3
 */

declare(strict_types=1);

if (!defined('ABSPATH')) {
    exit;
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

\SosPrescription\Rest\WorkerCallbackController::register();
\SosPrescription\Rest\WorkerRenderController::register();

\SosPrescription\Admin\MedLabStatusAdmin::register();
