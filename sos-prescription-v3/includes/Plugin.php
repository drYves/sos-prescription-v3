<?php // includes/Plugin.php · V10.1.1-beta2
declare(strict_types=1);

namespace SosPrescription;

use SosPrescription\Core\UpgradeManager;
use SosPrescription\Admin\ImportPage;
use SosPrescription\Admin\LogsPage;
use SosPrescription\Admin\RxPage;
use SosPrescription\Admin\SandboxPage;
use SosPrescription\Admin\PaymentsPage;
use SosPrescription\Admin\PricingPage;
use SosPrescription\Admin\WhitelistPage;
use SosPrescription\Admin\OcrPage;
use SosPrescription\Admin\NotificationsPage;
use SosPrescription\Admin\NoticesPage;
use SosPrescription\Admin\CompliancePage;
use SosPrescription\Admin\SetupPage;
use SosPrescription\Admin\VerificationTemplatePage;
use SosPrescription\Admin\SystemStatusPage;
use SosPrescription\Rest\Routes;
use SosPrescription\Rest\WorkerCallbackController;
use SosPrescription\Rest\WorkerClaimController;
use SosPrescription\Rest\WorkerRenderController;
use SosPrescription\Rest\SubmissionV4Controller;
use SosPrescription\Rest\ArtifactV4Controller;
use SosPrescription\Rest\PatientV4Controller;
use SosPrescription\Rest\DoctorV4Controller;
use SosPrescription\Rest\AuthV4Controller;
use SosPrescription\Rest\AccountV4Controller;
use SosPrescription\Rest\V4ProxyController;
use SosPrescription\Rest\MessagesController;
use SosPrescription\Rest\MessagesV4Controller;
use SosPrescription\Rest\ErrorResponder;
use SosPrescription\Shortcodes\AdminShortcode;
use SosPrescription\Shortcodes\BdpmTableShortcode;
use SosPrescription\Shortcodes\DoctorAccountShortcode;
use SosPrescription\Shortcodes\FormShortcode;
use SosPrescription\Shortcodes\LogoutShortcode;
use SosPrescription\Shortcodes\MagicRedirectShortcode;
use SosPrescription\Shortcodes\PatientShortcode;
use SosPrescription\Shortcodes\PricingShortcode;
use SosPrescription\Shortcodes\LegalMentionsShortcode;
use SosPrescription\Shortcodes\LegalCguShortcode;
use SosPrescription\Shortcodes\LegalPrivacyShortcode;
use SosPrescription\Shortcodes\LegalCookiesShortcode;
use SosPrescription\Frontend\VerificationPage;
use SosPrescription\Frontend\AuthVerifyPage;
use SosPrescription\Services\Notifications;
use SosPrescription\Services\NoCache;
use SosPrescription\Services\NoIndex;
use SosPrescription\Services\Retention;
use SosPrescription\Services\StorageCleaner;
use SosPrescription\Services\Logger;
use SosPrescription\Services\PhpDebugTrace;
use SosPrescription\Services\ThemeTrace;
use SosPrescription\Services\LegalPages;

final class Plugin
{
    private const VERSION = '10.1.1-beta2';

    private static bool $deferred_services_booted = false;

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
        AuthVerifyPage::register_hooks();
        ThemeTrace::register();
        PhpDebugTrace::register_hooks();

        if (did_action('wp_loaded') > 0) {
            self::boot_deferred_services();
        } else {
            add_action('wp_loaded', [self::class, 'boot_deferred_services'], 20);
        }

        self::register_rest_diagnostics();

        add_action('parse_request', [self::class, 'maybe_render_debug_json'], 0);
        add_filter('show_admin_bar', [self::class, 'filter_show_admin_bar'], 999);
        add_action('admin_post_sosprescription_logout', [self::class, 'handle_logout']);
        add_action('admin_post_nopriv_sosprescription_logout', [self::class, 'handle_logout']);
        add_action('init', [self::class, 'register_shortcodes']);
        add_action('wp_enqueue_scripts', [self::class, 'enqueue_legal_document_assets']);
        add_action('rest_api_init', [Routes::class, 'register']);
        add_action('rest_api_init', [SubmissionV4Controller::class, 'register']);
        add_action('rest_api_init', [ArtifactV4Controller::class, 'register']);
        add_action('rest_api_init', [PatientV4Controller::class, 'register']);
        add_action('rest_api_init', [DoctorV4Controller::class, 'register']);
        add_action('rest_api_init', [AuthV4Controller::class, 'register']);
        add_action('rest_api_init', [AccountV4Controller::class, 'register']);
        add_action('rest_api_init', [MessagesController::class, 'register']);
        add_action('rest_api_init', [MessagesV4Controller::class, 'register']);
        add_action('rest_api_init', [V4ProxyController::class, 'register']);
        ErrorResponder::register_hooks();

        // Routes worker v3 (signed claim + render + callback) + BFF v4.
        WorkerClaimController::register();
        WorkerRenderController::register();
        WorkerCallbackController::register();

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

    public static function boot_deferred_services(): void
    {
        if (self::$deferred_services_booted) {
            return;
        }

        self::$deferred_services_booted = true;

        try {
            Retention::register_hooks();
            if (method_exists(Retention::class, 'ensure_cron_scheduled')) {
                Retention::ensure_cron_scheduled();
            }
        } catch (\Throwable $e) {
            error_log('[SOSPrescription] Failed to boot Retention: ' . $e->getMessage());
        }

        try {
            StorageCleaner::register_hooks();
            if (method_exists(StorageCleaner::class, 'ensure_cron_scheduled')) {
                StorageCleaner::ensure_cron_scheduled();
            }
        } catch (\Throwable $e) {
            error_log('[SOSPrescription] Failed to boot StorageCleaner: ' . $e->getMessage());
        }
    }

    private static function maybe_upgrade(): void
    {
        $currentVersion = defined('SOSPRESCRIPTION_VERSION') ? (string) SOSPRESCRIPTION_VERSION : self::VERSION;
        if ($currentVersion === '') {
            return;
        }

        $dbVersion = (string) get_option('sosprescription_db_version', '');
        $pluginVersion = (string) get_option('sosprescription_plugin_version', '');

        if ($dbVersion === $currentVersion && $pluginVersion === $currentVersion) {
            return;
        }

        // Prod est déjà sur le schéma moderne : on verrouille les options de version
        // pour empêcher le legacy Installer de se relancer en boucle.
        if (self::has_modern_worker_schema()) {
            self::pin_version_options($currentVersion);
            return;
        }

        Installer::install();

        if (self::has_modern_worker_schema()) {
            self::pin_version_options($currentVersion);
        }
    }

    private static function register_rest_diagnostics(): void
    {
        add_filter('rest_post_dispatch', function ($result, $server, $request) {
            $route = $request->get_route();
            if (!self::is_sosprescription_rest_route($route)) {
                return $result;
            }

            if ($result instanceof \WP_REST_Response) {
                $data = $result->get_data();
                $responseReqId = Logger::get_request_id();
                if (is_array($data) && isset($data['req_id']) && is_scalar($data['req_id'])) {
                    $candidateReqId = trim((string) $data['req_id']);
                    if ($candidateReqId !== '') {
                        $responseReqId = $candidateReqId;
                    }
                }

                $result->header('X-SOSPrescription-Request-ID', $responseReqId);
                $result->header('Cache-Control', 'no-store, no-cache, must-revalidate');
                $result->header('Pragma', 'no-cache');
                $result->header('Expires', '0');
            }

            return $result;
        }, 10, 3);

        add_filter('rest_pre_echo_response', function ($result, $server, $request) {
            $route = $request->get_route();
            if (!self::is_sosprescription_rest_route($route)) {
                return $result;
            }

            if (is_array($result) && isset($result['code'], $result['message']) && !isset($result['req_id'])) {
                $result['req_id'] = Logger::get_request_id();
            }

            return $result;
        }, 10, 3);

        add_filter('rest_request_after_callbacks', function ($response, $handler, $request) {
            $route = $request->get_route();
            if (!self::is_sosprescription_rest_route($route)) {
                return $response;
            }

            if (is_wp_error($response)) {
                $errorData = $response->get_error_data();
                if (is_array($errorData) && isset($errorData['req_id']) && is_scalar($errorData['req_id']) && trim((string) $errorData['req_id']) !== '') {
                    return $response;
                }

                try {
                    Logger::log_scoped('runtime', 'api', 'warning', 'api_error', [
                        'route' => $route,
                        'code' => $response->get_error_code(),
                        'message' => $response->get_error_message(),
                        'data' => $errorData,
                        'user_id' => get_current_user_id(),
                        'req_id' => Logger::get_request_id(),
                    ]);
                } catch (\Throwable $e) {
                    error_log('[SOSPrescription] Failed to log REST API error: ' . $e->getMessage() . ' | route=' . $route . ' | code=' . $response->get_error_code());
                }
            }

            return $response;
        }, 10, 3);
    }

    public static function enqueue_legal_document_assets(): void
    {
        if (is_admin() || !is_singular('page')) {
            return;
        }

        global $post;
        if (!$post instanceof \WP_Post) {
            return;
        }

        if (!LegalPages::should_enqueue_public_assets($post)) {
            return;
        }

        wp_enqueue_style(
            'sosprescription-legal-documents',
            SOSPRESCRIPTION_URL . 'assets/legal-documents.css',
            [],
            defined('SOSPRESCRIPTION_VERSION') ? (string) SOSPRESCRIPTION_VERSION : self::VERSION
        );
    }

    public static function maybe_render_debug_json($wp = null): void
    {
        $debug = isset($_GET['sp_debug']) && is_scalar($_GET['sp_debug'])
            ? strtolower(trim(wp_unslash((string) $_GET['sp_debug'])))
            : '';

        if ($debug !== 'json') {
            return;
        }

        $payload = [
            'version' => defined('SOSPRESCRIPTION_VERSION') ? (string) SOSPRESCRIPTION_VERSION : self::VERSION,
            'status' => 'ok',
            'php_version' => PHP_VERSION,
            'logs_dir' => Logger::dir(),
        ];

        if (!headers_sent()) {
            status_header(200);
            header('Content-Type: application/json; charset=' . get_option('blog_charset'));
            header('Cache-Control: no-store, no-cache, must-revalidate');
            header('Pragma: no-cache');
            header('Expires: 0');
        }

        echo (string) wp_json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }

    public static function register_shortcodes(): void
    {
        FormShortcode::register();
        PatientShortcode::register();
        AdminShortcode::register();
        DoctorAccountShortcode::register();
        BdpmTableShortcode::register();
        PricingShortcode::register();
        LogoutShortcode::register();
        MagicRedirectShortcode::register();
        LegalMentionsShortcode::register();
        LegalCguShortcode::register();
        LegalPrivacyShortcode::register();
        LegalCookiesShortcode::register();
    }


public static function handle_logout(): void
{
    $redirect = isset($_REQUEST['redirect_to']) && is_scalar($_REQUEST['redirect_to'])
        ? trim((string) wp_unslash((string) $_REQUEST['redirect_to']))
        : '';

    if ($redirect === '' || !wp_validate_redirect($redirect, false)) {
        $redirect = home_url('/');
    }

    $method = isset($_SERVER['REQUEST_METHOD']) ? strtoupper((string) $_SERVER['REQUEST_METHOD']) : 'GET';
    if ($method !== 'POST') {
        self::logout_safe_redirect($redirect);
    }

    if (is_user_logged_in()) {
        $nonce = isset($_REQUEST['_wpnonce']) ? (string) wp_unslash((string) $_REQUEST['_wpnonce']) : '';
        if ($nonce === '' || !wp_verify_nonce($nonce, 'sosprescription_logout')) {
            self::logout_safe_redirect($redirect);
        }

        wp_logout();
    }

    self::logout_safe_redirect($redirect);
}

public static function filter_show_admin_bar($show): bool
{
    unset($show);

    if (!is_user_logged_in()) {
        return false;
    }

    $user = wp_get_current_user();
    if (!($user instanceof \WP_User) || (int) $user->ID <= 0) {
        return false;
    }

    if (function_exists('is_super_admin') && is_super_admin((int) $user->ID)) {
        return true;
    }

    return in_array('administrator', (array) $user->roles, true);
}

private static function logout_safe_redirect(string $redirect): void
{
    if (!headers_sent()) {
        wp_safe_redirect($redirect);
        exit;
    }

    $escapedUrl = esc_url($redirect);
    $escapedJs = wp_json_encode($redirect, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    echo '<!doctype html><html lang="fr"><head><meta charset="' . esc_attr((string) get_option('blog_charset')) . '"><meta http-equiv="refresh" content="0;url=' . $escapedUrl . '"><title>Redirection…</title></head><body>';
    echo '<p>Redirection sécurisée… <a href="' . $escapedUrl . '">Continuer</a></p>';
    echo '<script>window.location.replace(' . $escapedJs . ');</script>';
    echo '</body></html>';
    exit;
}

    private static function is_sosprescription_rest_route($route): bool
    {
        if (!is_string($route) || $route === '') {
            return false;
        }

        return strpos($route, '/sosprescription/v1/') === 0
            || strpos($route, '/sosprescription/v3/') === 0
            || strpos($route, '/sosprescription/v4/') === 0;
    }

    private static function pin_version_options(string $version): void
    {
        update_option('sosprescription_db_version', $version, false);
        update_option('sosprescription_plugin_version', $version, false);
        update_option('sosprescription_version', $version, true);
    }

    private static function has_modern_worker_schema(): bool
    {
        global $wpdb;

        if (!($wpdb instanceof \wpdb)) {
            return false;
        }

        $jobsTable = $wpdb->prefix . 'sosprescription_jobs';
        $noncesTable = $wpdb->prefix . 'sosprescription_nonces';

        if (!self::table_exists($wpdb, $jobsTable) || !self::table_exists($wpdb, $noncesTable)) {
            return false;
        }

        $requiredColumns = [
            'site_id',
            'job_id',
            'job_type',
            'payload',
            'payload_sha256',
            'mls1_token',
            'req_id',
            'rx_id',
            'completed_at',
            'artifact_size_bytes',
            'artifact_content_type',
            'last_error_message_safe',
        ];

        $columns = self::table_columns($wpdb, $jobsTable);
        foreach ($requiredColumns as $column) {
            if (!isset($columns[$column])) {
                return false;
            }
        }

        $nonceColumns = self::table_columns($wpdb, $noncesTable);
        foreach (['site_id', 'scope', 'nonce', 'ts_ms', 'expires_at'] as $column) {
            if (!isset($nonceColumns[$column])) {
                return false;
            }
        }

        return true;
    }

    /**
     * @return array<string, true>
     */
    private static function table_columns(\wpdb $wpdb, string $table): array
    {
        $rows = $wpdb->get_results('SHOW COLUMNS FROM `' . esc_sql($table) . '`', ARRAY_A);
        if (!is_array($rows)) {
            return [];
        }

        $out = [];
        foreach ($rows as $row) {
            if (!is_array($row) || empty($row['Field'])) {
                continue;
            }
            $out[(string) $row['Field']] = true;
        }

        return $out;
    }

    private static function table_exists(\wpdb $wpdb, string $table): bool
    {
        $found = $wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s', $table));
        return is_string($found) && $found === $table;
    }
}
