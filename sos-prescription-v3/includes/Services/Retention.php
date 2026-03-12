<?php
declare(strict_types=1);

namespace SOSPrescription\Services;

use SOSPrescription\Repositories\AuditRepository;
use SOSPrescription\Repositories\FileRepository;

final class Retention
{
    public const CRON_HOOK = 'sosprescription_daily_retention';

    public static function register_hooks(): void
    {
        add_action(self::CRON_HOOK, [self::class, 'run_daily']);

        // Schedule daily if not already scheduled.
        if (!wp_next_scheduled(self::CRON_HOOK)) {
            // Start in ~10 minutes to avoid immediate spike on activation.
            wp_schedule_event(time() + 600, 'daily', self::CRON_HOOK);
        }
    }

    /**
     * Daily cron callback.
     */
    public static function run_daily(): void
    {
        self::run();
    }

    /**
     * Deletes old runtime log files from uploads/sosprescription-logs.
     *
     * Default retention is 30 days, override via:
     * - define('SOSPRESCRIPTION_LOG_RETENTION_DAYS', 30)
     * - filter 'sosprescription_log_retention_days'
     *
     * @return array{deleted:int,bytes:int,cutoff:int}
     */
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

    /**
     * Exécute les purges configurées.
     *
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

        // Purge audit
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

        // Purge fichiers orphelins (uploadés mais jamais rattachés à une demande)
        if (!empty($cfg['orphan_files_purge_enabled'])) {
            try {
                $days = (int) ($cfg['orphan_files_retention_days'] ?? 7);
                $repo = new FileRepository();

                // On boucle par batch pour éviter les timeouts.
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

                        // Supprime le fichier physique
                        FileStorage::delete_by_storage_key($storage_key);
                        // Supprime l'entrée DB
                        $repo->delete($id);
                        $total++;
                    }

                    // Par sécurité : max 2000 / run
                    if ($total >= 2000) {
                        break;
                    }
                }

                $out['orphan_files_purged'] = (int) $total;
            } catch (\Throwable $e) {
                // ignore
            }
        }



        // Purge runtime logs (prevents disk fill on shared hosting).
        try {
            $days_default = defined('SOSPRESCRIPTION_LOG_RETENTION_DAYS') ? (int) constant('SOSPRESCRIPTION_LOG_RETENTION_DAYS') : 30;
            $days = (int) apply_filters('sosprescription_log_retention_days', $days_default);

            // Allow disabling runtime log purge via filter/constant (return 0).
            if ($days > 0) {
                $days = max(1, min(3650, $days));

                $res = self::purge_runtime_logs($days);
                $out['logs_purged'] = (int) ($res['deleted'] ?? 0);
                $out['logs_bytes_freed'] = (int) ($res['bytes'] ?? 0);

                if ($out['logs_purged'] > 0) {
                    Logger::ndjson_scoped('retention', [
                        'event' => 'logs_purged',
                        'days' => $days,
                        'deleted' => $out['logs_purged'],
                        'bytes_freed' => $out['logs_bytes_freed'],
                    ]);
                }
            }
        } catch (\Throwable $e) {
            // Never block the request for retention issues.
        }

        return $out;
    }
}
