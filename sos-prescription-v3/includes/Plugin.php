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
use SOSPrescription\Frontend\VerificationPage;
use SOSPrescription\Rest\Routes;
use SOSPrescription\Shortcodes\AdminShortcode;
use SOSPrescription\Shortcodes\BdpmTableShortcode;
use SOSPrescription\Shortcodes\DoctorAccountShortcode;
use SOSPrescription\Shortcodes\FormShortcode;
use SOSPrescription\Shortcodes\PatientShortcode;
use SOSPrescription\Services\Audit;
use SOSPrescription\Services\Logger;
use SOSPrescription\Services\NoCache;
use SOSPrescription\Services\NoIndex;
use SOSPrescription\Services\Notifications;
use SOSPrescription\Services\PhpDebugTrace;
use SOSPrescription\Services\Retention;
use SOSPrescription\Services\StorageCleaner;
use SOSPrescription\Services\ThemeTrace;

final class Plugin
{
    private static bool $wpLoadedBootstrapDone = false;

    public static function init(): void
    {
        UpgradeManager::register_hooks();
        UpgradeManager::maybe_upgrade();

        try {
            Logger::register_fatal_handler();
        } catch (\Throwable $e) {
            self::failsafe_log('logger_register_fatal_handler_failed', [
                'message' => $e->getMessage(),
                'file' => $e->getFile(),
                'line' => $e->getLine(),
            ]);
        }

        Notifications::register_hooks();
        NoIndex::register_hooks();
        NoCache::register_hooks();
        VerificationPage::register_hooks();
        ThemeTrace::register();
        PhpDebugTrace::register_hooks();

        if (did_action('wp_loaded') > 0) {
            self::bootstrap_after_wp_loaded();
        } else {
            add_action('wp_loaded', [self::class, 'bootstrap_after_wp_loaded'], 20);
        }

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
            wp_enqueue_style(
                'sosprescription-ui-kit',
                SOSPRESCRIPTION_URL . 'assets/ui-kit.css',
                [],
                SOSPRESCRIPTION_VERSION
            );
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

    public static function bootstrap_after_wp_loaded(): void
    {
        if (self::$wpLoadedBootstrapDone) {
            return;
        }

        self::$wpLoadedBootstrapDone = true;

        self::maybe_upgrade_safely();
        self::register_lifecycle_services();
    }

    public static function register_lifecycle_services(): void
    {
        try {
            Retention::register_hooks();
            if (method_exists(Retention::class, 'ensure_cron_scheduled')) {
                Retention::ensure_cron_scheduled();
            }
        } catch (\Throwable $e) {
            self::failsafe_log('retention_bootstrap_failed', [
                'message' => $e->getMessage(),
                'file' => $e->getFile(),
                'line' => $e->getLine(),
            ]);
        }

        try {
            StorageCleaner::register_hooks();
            if (method_exists(StorageCleaner::class, 'ensure_cron_scheduled')) {
                StorageCleaner::ensure_cron_scheduled();
            }
        } catch (\Throwable $e) {
            self::failsafe_log('storage_cleaner_bootstrap_failed', [
                'message' => $e->getMessage(),
                'file' => $e->getFile(),
                'line' => $e->getLine(),
            ]);
        }
    }

    private static function maybe_upgrade_safely(): void
    {
        try {
            self::maybe_upgrade();
        } catch (\Throwable $e) {
            self::failsafe_log('schema_upgrade_failed', [
                'message' => $e->getMessage(),
                'file' => $e->getFile(),
                'line' => $e->getLine(),
            ]);
        }
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
                try {
                    Logger::log_scoped('runtime', 'api', 'warning', 'api_error', [
                        'route' => $route,
                        'code' => $response->get_error_code(),
                        'message' => $response->get_error_message(),
                        'data' => $response->get_error_data(),
                        'user_id' => get_current_user_id(),
                        'req_id' => Logger::get_request_id(),
                    ]);
                } catch (\Throwable $e) {
                    self::failsafe_log('rest_diagnostics_logger_failed', [
                        'route' => $route,
                        'wp_error_code' => $response->get_error_code(),
                        'message' => $e->getMessage(),
                        'file' => $e->getFile(),
                        'line' => $e->getLine(),
                    ]);
                }
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

    /**
     * @param array<string, mixed> $context
     */
    private static function failsafe_log(string $event, array $context = []): void
    {
        try {
            Audit::write_failsafe_log($event, $context, 'plugin');
        } catch (\Throwable $e) {
            $uploads = function_exists('wp_upload_dir') ? wp_upload_dir() : ['basedir' => sys_get_temp_dir()];
            $baseDir = is_array($uploads) && !empty($uploads['basedir'])
                ? (string) $uploads['basedir']
                : sys_get_temp_dir();

            if (!is_dir($baseDir)) {
                @wp_mkdir_p($baseDir);
            }

            $file = rtrim($baseDir, '/\\') . DIRECTORY_SEPARATOR . 'sosprescription.log';
            $line = '[' . gmdate('c') . '] [plugin] ' . $event;

            if ($context !== []) {
                $json = wp_json_encode($context, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR);
                if (is_string($json) && $json !== '') {
                    $line .= ' ' . $json;
                }
            }

            @file_put_contents($file, $line . PHP_EOL, FILE_APPEND | LOCK_EX);
        }
    }
}
