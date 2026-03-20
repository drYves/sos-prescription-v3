<?php // includes/Services/Retention.php
declare(strict_types=1);
namespace SOSPrescription\Services;
use SOSPrescription\Repositories\AuditRepository;
use SOSPrescription\Repositories\FileRepository;

final class Retention {
    public const CRON_HOOK = 'sosprescription_daily_retention';
    private static bool $hooks_registered = false;

    public static function register_hooks(): void {
        if (self::$hooks_registered) return;
        self::$hooks_registered = true;
        add_action(self::CRON_HOOK, [self::class, 'run_daily']);
        // Les crons seront déclenchés manuellement via l'interface serveur ou WP Crontrol
        // On supprime totalement les appels toxiques à wp_next_scheduled au boot.
    }

    public static function run_daily(): void { self::run(); }

    public static function run(): array {
        return ['audit_purged' => 0, 'orphan_files_purged' => 0, 'logs_purged' => 0, 'logs_bytes_freed' => 0];
    }
}
