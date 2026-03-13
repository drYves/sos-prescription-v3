<?php
// includes/Services/Retention.php
declare(strict_types=1);

namespace SOSPrescription\Services;

use SOSPrescription\Repositories\AuditRepository;
use SOSPrescription\Repositories\FileRepository;

final class Retention
{
    public const CRON_HOOK = 'sosprescription_daily_retention';

    private static bool $cronRegistered = false;
    private static bool $bootstrapped = false;

    public static function register_hooks(): void
    {
        if (self::$bootstrapped) {
            return;
        }

        self::$bootstrapped = true;

        add_action(self::CRON_HOOK, [self::class, 'run_daily']);

        add_action('wp_loaded', [self::class, 'ensure_cron_scheduled'], 20);
        add_action('action_scheduler_init', [self::class, 'ensure_cron_scheduled'], 20);

        if (did_action('wp_loaded') > 0) {
            self::ensure_cron_scheduled();
        }
    }

    public static function ensure_cron_scheduled(): void
    {
        if (self::$cronRegistered) {
            return;
        }

        if (!self::is_scheduling_ready()) {
            return;
        }

        try {
            if (!wp_next_scheduled(self::CRON_HOOK)) {
                wp_schedule_event(time() + 600, 'daily', self::CRON_HOOK);
            }

            self::$cronRegistered = true;
        } catch (\Throwable $e) {
            Audit::write_failsafe_log('retention_schedule_failed', [
                'message' => $e->getMessage(),
                'file' => $e->getFile(),
                'line' => $e->getLine(),
            ], 'retention');
        }
    }

    private static function is_scheduling_ready(): bool
    {
        if (function_exists('wp_installing') && wp_installing()) {
            return false;
        }

        if (did_action('wp_loaded') < 1) {
            return false;
        }

        if (!function_exists('wp_next_scheduled') || !function_exists('wp_schedule_event')) {
            return false;
        }

        if (function_exists('as_next_scheduled_action') && did_action('action_scheduler_init') < 1) {
            return false;
        }

        return true;
    }

    public static function run_daily(): void
    {
        self::run();
    }

    /**
     * @return array{deleted:int,bytes:int,cutoff:int}
     */
    private static function purge_runtime_logs(int $days): array
    {
        $dir = Logger::dir();
        if ($dir === '' || !is_dir($dir)) {
            return ['deleted' => 0, 'bytes' => 0, 'cutoff' => 0];
        }

        $cutoff = time() - ($days * DAY_IN_SECONDS);
        $deleted = 0;
        $bytes = 0;

        $files = glob($dir . '/*.log') ?: [];
        foreach ($files as $file) {
            $mtime = @filemtime($file);
            if ($mtime === false || $mtime >= $cutoff) {
                continue;
            }

            $bytes += (int) (@filesize($file) ?: 0);
            if (@unlink($file)) {
                $deleted++;
            }
        }

        return ['deleted' => $deleted, 'bytes' => $bytes, 'cutoff' => $cutoff];
    }

    /**
     * @return array<string, int>
     */
    public static function run(): array
    {
        $cfg = ComplianceConfig::get();

        $out = [
            'audit_purged' => 0,
            'orphan_files_purged' => 0,
            'logs_purged' => 0,
            'logs_bytes_freed' => 0,
        ];

        if (!empty($cfg['audit_purge_enabled'])) {
            try {
                $days = (int) ($cfg['audit_retention_days'] ?? 3650);
                $repo = new AuditRepository();
                $out['audit_purged'] = (int) $repo->purge_older_than_days(max(1, $days));
            } catch (\Throwable $e) {
                Audit::write_failsafe_log('retention_audit_purge_failed', [
                    'message' => $e->getMessage(),
                    'file' => $e->getFile(),
                    'line' => $e->getLine(),
                ], 'retention');
            }
        }

        if (!empty($cfg['orphan_files_purge_enabled'])) {
            try {
                $days = (int) ($cfg['orphan_files_retention_days'] ?? 7);
                $repo = new FileRepository();
                $total = 0;

                for ($i = 0; $i < 10; $i++) {
                    $batch = $repo->list_orphans_older_than_days(max(1, $days), 200);
                    if (count($batch) < 1) {
                        break;
                    }

                    foreach ($batch as $row) {
                        $id = isset($row['id']) ? (int) $row['id'] : 0;
                        $storageKey = isset($row['storage_key']) ? (string) $row['storage_key'] : '';
                        if ($id < 1 || $storageKey === '') {
                            continue;
                        }

                        FileStorage::delete_by_storage_key($storageKey);
                        $repo->delete($id);
                        $total++;
                    }

                    if ($total >= 2000) {
                        break;
                    }
                }

                $out['orphan_files_purged'] = $total;
            } catch (\Throwable $e) {
                Audit::write_failsafe_log('retention_orphan_files_purge_failed', [
                    'message' => $e->getMessage(),
                    'file' => $e->getFile(),
                    'line' => $e->getLine(),
                ], 'retention');
            }
        }

        try {
            $daysDefault = defined('SOSPRESCRIPTION_LOG_RETENTION_DAYS')
                ? (int) constant('SOSPRESCRIPTION_LOG_RETENTION_DAYS')
                : 30;

            $days = (int) apply_filters('sosprescription_log_retention_days', $daysDefault);

            if ($days > 0) {
                $days = max(1, min(3650, $days));
                $res = self::purge_runtime_logs($days);

                $out['logs_purged'] = (int) ($res['deleted'] ?? 0);
                $out['logs_bytes_freed'] = (int) ($res['bytes'] ?? 0);

                if ($out['logs_purged'] > 0) {
                    Logger::ndjson_scoped('runtime', 'retention', 'info', 'logs_purged', [
                        'days' => $days,
                        'deleted' => $out['logs_purged'],
                        'bytes_freed' => $out['logs_bytes_freed'],
                    ]);
                }
            }
        } catch (\Throwable $e) {
            Audit::write_failsafe_log('retention_runtime_log_purge_failed', [
                'message' => $e->getMessage(),
                'file' => $e->getFile(),
                'line' => $e->getLine(),
            ], 'retention');
        }

        return $out;
    }
}
