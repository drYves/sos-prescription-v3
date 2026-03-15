<?php // includes/Services/Retention.php
declare(strict_types=1);

namespace SosPrescription\Services;

use SosPrescription\Repositories\AuditRepository;
use SosPrescription\Repositories\FileRepository;

final class Retention
{
    public const CRON_HOOK = 'sosprescription_daily_retention';

    private static bool $hooks_registered = false;
    private static bool $cron_registered = false;

    public static function register_hooks(): void
    {
        if (self::$hooks_registered) {
            return;
        }

        self::$hooks_registered = true;

        add_action(self::CRON_HOOK, [self::class, 'run_daily']);

        add_action('action_scheduler_init', static function (): void {
            self::ensure_cron_scheduled();
        }, 20);

        if (did_action('action_scheduler_init') > 0) {
            self::ensure_cron_scheduled();
        }
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
            wp_schedule_event(time() + 600, 'daily', self::CRON_HOOK);
        }

        self::$cron_registered = true;
    }

    private static function scheduling_is_ready(): bool
    {
        if (function_exists('wp_installing') && wp_installing()) {
            return false;
        }

        if (did_action('action_scheduler_init') < 1) {
            return false;
        }

        if (!function_exists('wp_next_scheduled') || !function_exists('wp_schedule_event')) {
            return false;
        }

        return true;
    }

    public static function run_daily(): void
    {
        self::run();
    }

    private static function purge_runtime_logs(int $days): array
    {
        $dir = Logger::dir();
        if (empty($dir) || !is_dir($dir)) {
            return ['deleted' => 0, 'bytes' => 0, 'cutoff' => 0];
        }

        $cutoff = time() - ($days * DAY_IN_SECONDS);
        $deleted = 0;
        $bytes = 0;

        $files = glob($dir . '/*.log') ?: [];
        foreach ($files as $file) {
            $mtime = @filemtime($file);
            if ($mtime === false) {
                continue;
            }
            if ($mtime < $cutoff) {
                $bytes += (int) (@filesize($file) ?: 0);
                if (@unlink($file)) {
                    $deleted++;
                }
            }
        }

        return ['deleted' => $deleted, 'bytes' => $bytes, 'cutoff' => $cutoff];
    }

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
                $deleted = $repo->purge_older_than_days(max(1, $days));
                $out['audit_purged'] = (int) $deleted;
            } catch (\Throwable $e) {
                // ignore
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

                    foreach ($batch as $r) {
                        $id = isset($r['id']) ? (int) $r['id'] : 0;
                        $storage_key = isset($r['storage_key']) ? (string) $r['storage_key'] : '';
                        if ($id < 1 || $storage_key === '') {
                            continue;
                        }

                        FileStorage::delete_by_storage_key($storage_key);
                        $repo->delete($id);
                        $total++;
                    }

                    if ($total >= 2000) {
                        break;
                    }
                }

                $out['orphan_files_purged'] = (int) $total;
            } catch (\Throwable $e) {
                // ignore
            }
        }

        try {
            $days_default = defined('SOSPRESCRIPTION_LOG_RETENTION_DAYS') ? (int) constant('SOSPRESCRIPTION_LOG_RETENTION_DAYS') : 30;
            $days = (int) apply_filters('sosprescription_log_retention_days', $days_default);

            if ($days > 0) {
                $days = max(1, min(3650, $days));
                $res = self::purge_runtime_logs($days);
                $out['logs_purged'] = (int) ($res['deleted'] ?? 0);
                $out['logs_bytes_freed'] = (int) ($res['bytes'] ?? 0);

                if ($out['logs_purged'] > 0) {
                    try {
                        Logger::ndjson_scoped('runtime', 'retention', 'info', 'logs_purged', [
                            'days' => $days,
                            'deleted' => $out['logs_purged'],
                            'bytes_freed' => $out['logs_bytes_freed'],
                        ]);
                    } catch (\Throwable $e) {
                        // ignore
                    }
                }
            }
        } catch (\Throwable $e) {
            // Never block the request for retention issues.
        }

        return $out;
    }
}
