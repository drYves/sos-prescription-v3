<?php
// includes/Plugin.php
declare(strict_types=1);

namespace SOSPrescription;

use SOSPrescription\Core\UpgradeManager;
use SOSPrescription\Admin\ImportPage;
use SOSPrescription\Admin\LogsPage;
use SOSPrescription\Admin\RxPage;
use SOSPrescription\Admin\SandboxPage;
use SOSPrescription\Admin\PaymentsPage;
use SOSPrescription\Admin\PricingPage;
use SOSPrescription\Admin\WhitelistPage;
use SOSPrescription\Admin\OcrPage;
use SOSPrescription\Admin\NotificationsPage;
use SOSPrescription\Admin\NoticesPage;
use SOSPrescription\Admin\CompliancePage;
use SOSPrescription\Admin\SetupPage;
use SOSPrescription\Admin\VerificationTemplatePage;
use SOSPrescription\Admin\SystemStatusPage;
use SOSPrescription\Rest\Routes;
use SOSPrescription\Shortcodes\AdminShortcode;
use SOSPrescription\Shortcodes\BdpmTableShortcode;
use SOSPrescription\Shortcodes\DoctorAccountShortcode;
use SOSPrescription\Shortcodes\FormShortcode;
use SOSPrescription\Shortcodes\PatientShortcode;
use SOSPrescription\Frontend\VerificationPage;
use SOSPrescription\Services\Notifications;
use SOSPrescription\Services\NoCache;
use SOSPrescription\Services\NoIndex;
use SOSPrescription\Services\Retention;
use SOSPrescription\Services\StorageCleaner;
use SOSPrescription\Services\Logger;
use SOSPrescription\Services\PhpDebugTrace;
use SOSPrescription\Services\ThemeTrace;

final class Plugin
{
    public static function init(): void
    {
        UpgradeManager::register_hooks();
        UpgradeManager::maybe_upgrade();

        self::maybe_upgrade();
        Logger::register_fatal_handler();

        Notifications::register_hooks();
        NoIndex::register_hooks();
        NoCache::register_hooks();
        VerificationPage::register_hooks();
        ThemeTrace::register();
        PhpDebugTrace::register_hooks();

        add_action('plugins_loaded', [self::class, 'register_lifecycle_services'], 20);

        self::register_rest_diagnostics();

        add_action('init', [self::class, 'register_shortcodes']);
        add_action('rest_api_init', [Routes::class, 'register']);

        add_action('admin_enqueue_scripts', function (): void {
            if (!is_admin()) {
                return;
            }
            $page = isset($_GET['page']) ? sanitize_key((string) $_GET['page']) : '';
            if ($page === '' || strpos($page, 'sosprescription') !== 0) {
                return;
            }

            wp_enqueue_style('dashicons');
            wp_enqueue_style('sosprescription-ui-kit', SOSPRESCRIPTION_URL . 'assets/ui-kit.css', [], SOSPRESCRIPTION_VERSION);
        });

        add_action('admin_menu', [ImportPage::class, 'register_menu']);
        add_action('admin_init', [ImportPage::class, 'register_actions']);
        add_action('admin_init', [SetupPage::class, 'register_actions']);
        add_action('admin_init', [LogsPage::class, 'register_actions']);
        add_action('admin_init', [SystemStatusPage::class, 'register_actions']);
        add_action('admin_init', [RxPage::class, 'register_actions']);
        add_action('admin_init', [VerificationTemplatePage::class, 'register_actions']);
        add_action('admin_init', [SandboxPage::class, 'register_actions']);
        add_action('admin_init', [PricingPage::class, 'register_actions']);
        add_action('admin_init', [PaymentsPage::class, 'register_actions']);
        add_action('admin_init', [WhitelistPage::class, 'register_actions']);
        add_action('admin_init', [OcrPage::class, 'register_actions']);
        add_action('admin_init', [NotificationsPage::class, 'register_actions']);
        add_action('admin_init', [NoticesPage::class, 'register_actions']);
        add_action('admin_init', [CompliancePage::class, 'register_actions']);
    }

    public static function register_lifecycle_services(): void
    {
        Retention::register_hooks();
        StorageCleaner::register_hooks();
    }

    private static function maybe_upgrade(): void
    {
        $dbv = (string) get_option('sosprescription_db_version', '');
        if ($dbv === '' || version_compare($dbv, Installer::DB_VERSION, '<')) {
            Installer::install();
        }
    }

    private static function register_rest_diagnostics(): void
    {
        add_filter('rest_post_dispatch', function ($result, $server, $request) {
            $route = $request->get_route();
            if (!is_string($route) || strpos($route, '/sosprescription/v1/') !== 0) {
                return $result;
            }

            if ($result instanceof \WP_REST_Response) {
                $result->header('X-SOSPrescription-Request-ID', Logger::get_request_id());
                $result->header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
                $result->header('Pragma', 'no-cache');
                $result->header('Expires', '0');
            }

            return $result;
        }, 10, 3);

        add_filter('rest_pre_echo_response', function ($result, $server, $request) {
            $route = $request->get_route();
            if (!is_string($route) || strpos($route, '/sosprescription/v1/') !== 0) {
                return $result;
            }

            if (is_array($result) && isset($result['code'], $result['message'])) {
                $result['_request_id'] = Logger::get_request_id();
            }

            return $result;
        }, 10, 3);

        add_filter('rest_request_after_callbacks', function ($response, $handler, $request) {
            $route = $request->get_route();
            if (!is_string($route) || strpos($route, '/sosprescription/v1/') !== 0) {
                return $response;
            }

            if (is_wp_error($response)) {
                Logger::log_scoped('runtime', 'api', 'warning', 'api_error', [
                    'route' => $route,
                    'code' => $response->get_error_code(),
                    'message' => $response->get_error_message(),
                    'data' => $response->get_error_data(),
                    'user_id' => get_current_user_id(),
                    'req_id' => Logger::get_request_id(),
                ]);
            }

            return $response;
        }, 10, 3);
    }

    public static function register_shortcodes(): void
    {
        FormShortcode::register();
        PatientShortcode::register();
        AdminShortcode::register();
        DoctorAccountShortcode::register();
        BdpmTableShortcode::register();
    }
}
