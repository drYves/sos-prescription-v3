<?php
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
use SosPrescription\Shortcodes\AdminShortcode;
use SosPrescription\Shortcodes\BdpmTableShortcode;
use SosPrescription\Shortcodes\DoctorAccountShortcode;
use SosPrescription\Shortcodes\FormShortcode;
use SosPrescription\Shortcodes\PatientShortcode;
use SosPrescription\Frontend\VerificationPage;
use SosPrescription\Services\Notifications;
use SosPrescription\Services\NoCache;
use SosPrescription\Services\NoIndex;
use SosPrescription\Services\Retention;
use SosPrescription\Services\StorageCleaner;
use SosPrescription\Services\Logger;
use SosPrescription\Services\PhpDebugTrace;
use SosPrescription\Services\ThemeTrace;

final class Plugin
{
    public static function init(): void
    {
        // Release readiness: handle code upgrades (version tracking + rewrite flush)
        UpgradeManager::register_hooks();
        UpgradeManager::maybe_upgrade();

        self::maybe_upgrade();

        // Enregistre un handler "best-effort" pour journaliser les erreurs fatales PHP
        // (utile quand WordPress affiche "Il y a eu une erreur critique sur ce site").
        Logger::register_fatal_handler();

        Notifications::register_hooks();
		Retention::register_hooks();
		StorageCleaner::register_hooks();
        NoIndex::register_hooks();
        NoCache::register_hooks();
        VerificationPage::register_hooks();
        ThemeTrace::register();
        PhpDebugTrace::register_hooks();

        // Ajoute un Request-ID sur les réponses REST + logs plus explicites en cas d'erreur API.
        self::register_rest_diagnostics();

        add_action('init', [self::class, 'register_shortcodes']);
        add_action('rest_api_init', [Routes::class, 'register']);

        // Unified UI kit for WP Admin pages (only SOS Prescription screens).
        add_action('admin_enqueue_scripts', function (): void {
            if (!is_admin()) {
                return;
            }
            $page = isset($_GET['page']) ? sanitize_key((string) $_GET['page']) : '';
            if ($page === '' || strpos($page, 'sosprescription') !== 0) {
                return;
            }
            // Dashicons for compact admin action icons.
            wp_enqueue_style('dashicons');

            wp_enqueue_style(
                'sosprescription-ui-kit',
                SOSPRESCRIPTION_URL . 'assets/ui-kit.css',
                [],
                SOSPRESCRIPTION_VERSION
            );
        });

        // Back-office
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

    /**
     * Exécute dbDelta sur update du plugin (sans nécessiter une réactivation).
     */
    private static function maybe_upgrade(): void
    {
        $dbv = (string) get_option('sosprescription_db_version', '');
        if ($dbv !== SOSPRESCRIPTION_VERSION) {
            Installer::install();
        }
    }


    private static function register_rest_diagnostics(): void
    {
        // 1) Ajoute des headers de diagnostic + anti-cache sur les réponses de notre namespace
        add_filter('rest_post_dispatch', function ($result, $server, $request) {
            $route = $request->get_route();
            if (!is_string($route) || strpos($route, '/sosprescription/v1/') !== 0) {
                return $result;
            }

            if ($result instanceof \WP_REST_Response) {
                $result->header('X-SOSPrescription-Request-ID', Logger::get_request_id());
                // IMPORTANT: éviter les caches agressifs (CDN/host) sur wp-json,
                // sinon la console médecin peut ne pas voir les nouvelles demandes.
                $result->header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
                $result->header('Pragma', 'no-cache');
                $result->header('Expires', '0');
            }
            return $result;
        }, 10, 3);

        // 2) Ajoute un champ _request_id dans les payloads JSON (utile pour corréler UI <-> logs).
        add_filter('rest_pre_echo_response', function ($result, $server, $request) {
            $route = $request->get_route();
            if (!is_string($route) || strpos($route, '/sosprescription/v1/') !== 0) {
                return $result;
            }

            // ATTENTION: ne pas casser les tableaux numériques (ex: liste de médicaments).
            // On injecte le request_id uniquement sur les payloads d'erreur (format standard WP REST).
            if (is_array($result) && isset($result['code'], $result['message'])) {
                $result['_request_id'] = Logger::get_request_id();
            }
            return $result;
        }, 10, 3);

        // 3) Log serveur : si une route REST renvoie WP_Error, on log avec contexte (route, code, user, reqId).
        add_filter('rest_request_after_callbacks', function ($response, $handler, $request) {
            $route = $request->get_route();
            if (!is_string($route) || strpos($route, '/sosprescription/v1/') !== 0) {
                return $response;
            }

            if (is_wp_error($response)) {
                Logger::warning('api_error', [
                    'route' => $route,
                    'code' => $response->get_error_code(),
                    'message' => $response->get_error_message(),
                    'data' => $response->get_error_data(),
                    'user_id' => get_current_user_id(),
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
