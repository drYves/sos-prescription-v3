<?php
declare(strict_types=1);

namespace SOSPrescription\Admin;

use SOSPrescription\Core\NdjsonLogger;
use SOSPrescription\Core\ReqId;
use SOSPrescription\Core\WorkerHealthService;

final class MedLabStatusAdmin
{
    public static function register(): void
    {
        add_action('admin_menu', [self::class, 'registerMenu']);
    }

    public static function registerMenu(): void
    {
        add_submenu_page(
            'tools.php',
            'SOS Prescription — État du Système',
            'État du Système',
            'manage_options',
            'sosprescription-system-status',
            [self::class, 'renderPage']
        );
    }

    public static function renderPage(): void
    {
        if (!current_user_can('manage_options')) {
            wp_die(esc_html__('Accès refusé', 'sos-prescription-v3'));
        }

        echo '<div class="wrap">';
        echo '<h1>' . esc_html__('État du Système — SOS Prescription v3', 'sos-prescription-v3') . '</h1>';
        self::renderMedLabTab();
        echo '</div>';
    }

    private static function renderMedLabTab(): void
    {
        $siteId = getenv('ML_SITE_ID') ?: 'unknown_site';
        $env = getenv('SOSPRESCRIPTION_ENV') ?: 'prod';
        $logger = new NdjsonLogger('web', $siteId, $env);
        $reqId = ReqId::new();

        echo '<h2 class="nav-tab-wrapper">';
        echo '<span class="nav-tab nav-tab-active">MedLab Status</span>';
        echo '</h2>';
        echo '<p>' . esc_html__('Diagnostic Brain ↔ Muscle (WordPress ↔ Worker). Aucun secret et aucune PII ne sont affichés.', 'sos-prescription-v3') . '</p>';

        try {
            $service = WorkerHealthService::fromEnv($logger);
            $result = $service->pingWorker($reqId, 2);
        } catch (\Throwable $e) {
            echo '<div class="notice notice-error"><p><strong>OFFLINE:</strong> Initialisation du health check impossible.</p></div>';
            return;
        }

        if (!is_array($result) || ($result['ok'] ?? false) !== true) {
            $errorCode = isset($result['error_code']) ? (string) $result['error_code'] : 'ML_PULSE_FAILED';
            echo '<div class="notice notice-error"><p><strong>OFFLINE:</strong> Worker indisponible (<code>' . esc_html($errorCode) . '</code>).</p></div>';
            echo '<p class="description">La défaillance du Worker n\'interrompt pas l\'interface WordPress ni le reste du site.</p>';
            return;
        }

        $metrics = is_array($result['metrics'] ?? null) ? $result['metrics'] : [];
        $workerState = isset($metrics['state']) ? (string) $metrics['state'] : 'UNKNOWN';
        $clockSkew = is_array($metrics['clock_skew'] ?? null) ? $metrics['clock_skew'] : ['skew_status' => 'UNKNOWN', 'delta_ms' => null];
        $clockStatus = isset($clockSkew['skew_status']) ? (string) $clockSkew['skew_status'] : 'UNKNOWN';

        $status = 'OK';
        if ($workerState === 'DEGRADED' || $clockStatus === 'DEGRADED') {
            $status = 'DEGRADED';
        }
        if ($workerState === 'OFFLINE' || $clockStatus === 'OFFLINE') {
            $status = 'OFFLINE';
        }

        $noticeClass = $status === 'OK' ? 'notice-success' : ($status === 'DEGRADED' ? 'notice-warning' : 'notice-error');
        echo '<div class="notice ' . esc_attr($noticeClass) . '"><p><strong>' . esc_html($status) . '</strong> — req_id <code>' . esc_html((string) ($result['req_id'] ?? '')) . '</code></p></div>';

        $queue = is_array($metrics['queue'] ?? null) ? $metrics['queue'] : ['pending' => null, 'claimed' => null];
        $signature = $result['signature_verified'] ?? null;
        $signatureText = $signature === true ? 'SIGNED' : ($signature === false ? 'INVALID' : 'UNSIGNED');

        echo '<table class="widefat striped" style="max-width:900px"><tbody>';
        echo '<tr><th>Global Status</th><td><code>' . esc_html($status) . '</code></td></tr>';
        echo '<tr><th>Worker State</th><td><code>' . esc_html($workerState) . '</code></td></tr>';
        echo '<tr><th>Latency</th><td><code>' . esc_html((string) ((int) ($result['latency_ms'] ?? 0))) . ' ms</code></td></tr>';
        echo '<tr><th>Clock Skew</th><td><code>' . esc_html($clockStatus) . '</code>';
        if (isset($clockSkew['delta_ms']) && $clockSkew['delta_ms'] !== null) {
            echo ' — <code>' . esc_html((string) ((int) $clockSkew['delta_ms'])) . ' ms</code>';
        }
        echo '</td></tr>';
        echo '<tr><th>RSS</th><td>' . (isset($metrics['rss_mb']) ? '<code>' . esc_html((string) ((int) $metrics['rss_mb'])) . ' MB</code>' : 'n/a') . '</td></tr>';
        echo '<tr><th>Queue</th><td>pending=<code>' . esc_html((string) ($queue['pending'] ?? 'n/a')) . '</code> — claimed=<code>' . esc_html((string) ($queue['claimed'] ?? 'n/a')) . '</code></td></tr>';
        echo '<tr><th>Signature</th><td><code>' . esc_html($signatureText) . '</code></td></tr>';
        echo '</tbody></table>';
    }
}
