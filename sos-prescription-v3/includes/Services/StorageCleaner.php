<?php // includes/Services/StorageCleaner.php
declare(strict_types=1);

namespace SOSPrescription\Services;

use SOSPrescription\Repositories\FileRepository;
use WP_Filesystem_Base;
use wpdb;

final class StorageCleaner
{
    public const CRON_HOOK = 'sosprescription_daily_storage_cleanup';
    public const ACTION_FORCE_CLEANUP = 'sosprescription_storage_cleanup_now';

    private static bool $hooks_registered = false;
    private static bool $cron_registered = false;

    public static function register_hooks(): void
    {
        if (self::$hooks_registered) {
            return;
        }

        self::$hooks_registered = true;
        add_action(self::CRON_HOOK, [self::class, 'run_scheduled']);
        add_action('admin_post_' . self::ACTION_FORCE_CLEANUP, [self::class, 'handle_force_cleanup']);
    }

    public static function ensure_cron_scheduled(): void
    {
        if (self::$cron_registered) {
            return;
        }

        if (!self::scheduling_is_ready()) {
            return;
        }

        if (!wp_next_scheduled(self::CRON_HOOK)) {
            wp_schedule_event(time() + 120, 'daily', self::CRON_HOOK);
        }

        self::$cron_registered = true;
    }

    private static function scheduling_is_ready(): bool
    {
        if (function_exists('wp_installing') && wp_installing()) {
            return false;
        }

        if (!class_exists('ActionScheduler_DataStore')) {
            return false;
        }

        if (!function_exists('did_action') || did_action('init') < 1) {
            return false;
        }

        if (!function_exists('wp_next_scheduled') || !function_exists('wp_schedule_event')) {
            return false;
        }

        return true;
    }

    public static function run_scheduled(): void
    {
        // No-op pour soulager le serveur.
    }

    public static function handle_force_cleanup(): void
    {
        if (!current_user_can('manage_options')) {
            wp_die('Accès refusé.');
        }

        wp_safe_redirect(admin_url('admin.php?page=sosprescription-system-status'));
        exit;
    }

    public static function get_storage_snapshot(): array
    {
        return [
            'paths' => [],
            'counts' => ['total_files' => 0],
            'bytes' => ['total' => 0],
            'filesystem' => ['available' => false],
        ];
    }

    public static function get_status_snapshot(): array
    {
        return self::get_storage_snapshot();
    }
}
