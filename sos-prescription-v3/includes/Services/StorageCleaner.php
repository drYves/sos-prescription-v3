<?php
declare(strict_types=1);

namespace SosPrescription\Services;

use SosPrescription\Repositories\FileRepository;
use WP_Filesystem_Base;
use wpdb;

/**
 * Storage hygiene / garbage collector.
 *
 * Responsibilities:
 * - Delete temporary runtime files (OCR / PDF intermediates) older than 24 hours.
 * - Delete orphan PDFs (unreferenced) using DB metadata (failsafe).
 * - Provide storage metrics for the System Status page and the JSON system report.
 */
final class StorageCleaner
{
    public const CRON_HOOK = 'sosprescription_daily_storage_cleanup';
    public const ACTION_FORCE_CLEANUP = 'sosprescription_storage_cleanup_now';

    private const OPTION_LAST_RUN = 'sosprescription_storage_cleaner_last_run';

    /**
     * Register hooks (cron + admin-post).
     */
    public static function register_hooks(): void
    {
        add_action('init', [self::class, 'ensure_cron_scheduled']);
        add_action(self::CRON_HOOK, [self::class, 'run_scheduled']);
        add_action('admin_post_' . self::ACTION_FORCE_CLEANUP, [self::class, 'handle_force_cleanup']);
    }

    /**
     * Ensure daily cron exists.
     */
    public static function ensure_cron_scheduled(): void
    {
        if (!wp_next_scheduled(self::CRON_HOOK)) {
            // Spread executions a bit to avoid spikes at midnight.
            wp_schedule_event(time() + 120, 'daily', self::CRON_HOOK);
        }
    }

    /**
     * Cron entry point.
     */
    public static function run_scheduled(): void
    {
        self::run('cron');
    }

    /**
     * Admin entry point.
     */
    public static function handle_force_cleanup(): void
    {
        if (!current_user_can('manage_options')) {
            wp_die(esc_html__('Accès refusé.', 'sosprescription'));
        }

        check_admin_referer('sosprescription_storage_cleanup_now');

        $result = self::run('manual');

        $redirect = add_query_arg(
            [
                'page' => 'sosprescription-system-status',
                'sp_storage_cleanup' => '1',
                'sp_storage_cleanup_ok' => $result['ok'] ? '1' : '0',
            ],
            admin_url('admin.php')
        );

        wp_safe_redirect($redirect);
        exit;
    }

    /**
     * Run the garbage collector.
     *
     * Safe-fail: if DB is not reachable, deletion is suspended.
     *
     * @return array<string,mixed>
     */
    public static function run(string $trigger = 'manual'): array
    {
        $startedAt = time();

        $payload = [
            'ok' => false,
            'trigger' => $trigger,
            'started_at' => gmdate('c', $startedAt),
            'ended_at' => null,
            'db_ok' => false,
            'deleted' => [
                'tmp_files' => 0,
                'orphan_pdfs' => 0,
            ],
            'bytes_freed' => 0,
            'errors' => [],
        ];

        $rid = Logger::rid();

        Logger::ndjson_scoped('system', 'info', 'storage_cleanup_start', [
            'req_id' => $rid,
            'trigger' => $trigger,
        ]);

        $dbOk = self::db_is_available();
        $payload['db_ok'] = $dbOk;

        if (!$dbOk) {
            $payload['ended_at'] = gmdate('c');
            $payload['errors'][] = 'db_unavailable';
            self::persist_last_run($payload);

            Logger::ndjson_scoped('system', 'warning', 'storage_cleanup_skipped_db_unavailable', [
                'req_id' => $rid,
                'trigger' => $trigger,
            ]);

            return $payload;
        }

        $fs = self::get_filesystem();
        if (!$fs) {
            $payload['ended_at'] = gmdate('c');
            $payload['errors'][] = 'filesystem_unavailable';
            self::persist_last_run($payload);

            Logger::ndjson_scoped('system', 'error', 'storage_cleanup_failed_filesystem_unavailable', [
                'req_id' => $rid,
                'trigger' => $trigger,
            ]);

            return $payload;
        }

        // 1) TEMP files cleanup (older than 24 hours)
        $tmpResult = self::cleanup_temp_dirs($fs, 24 * 3600);
        $payload['deleted']['tmp_files'] = $tmpResult['deleted_files'];
        $payload['bytes_freed'] += $tmpResult['bytes_freed'];
        if (!empty($tmpResult['errors'])) {
            $payload['errors'] = array_merge($payload['errors'], $tmpResult['errors']);
        }

        // 2) Orphan PDFs cleanup (DB metadata)
        $orphansResult = self::cleanup_orphan_pdfs($fs);
        $payload['deleted']['orphan_pdfs'] = $orphansResult['deleted_files'];
        $payload['bytes_freed'] += $orphansResult['bytes_freed'];
        if (!empty($orphansResult['errors'])) {
            $payload['errors'] = array_merge($payload['errors'], $orphansResult['errors']);
        }

        $payload['ok'] = empty($payload['errors']);
        $payload['ended_at'] = gmdate('c');

        self::persist_last_run($payload);

        Logger::ndjson_scoped('system', $payload['ok'] ? 'info' : 'warning', 'storage_cleanup_end', [
            'req_id' => $rid,
            'trigger' => $trigger,
            'ok' => $payload['ok'],
            'deleted' => $payload['deleted'],
            'bytes_freed' => $payload['bytes_freed'],
            'duration_ms' => (int) max(0, (microtime(true) * 1000) - ($startedAt * 1000)),
        ]);

        return $payload;
    }

    /**
     * Get a snapshot for UI + JSON export.
     *
     * @return array<string,mixed>
     */
    public static function get_storage_snapshot(): array
    {
        $fs = self::get_filesystem();
        $baseDir = self::base_dir();
        $logsDir = trailingslashit($baseDir) . 'logs';

        $snapshot = [
            'paths' => [
                'base_dir' => $baseDir,
                'logs_dir' => $logsDir,
                'tmp_dirs' => [
                    trailingslashit($baseDir) . 'tmp',
                    trailingslashit($baseDir) . 'mpdf-tmp',
                ],
            ],
            'counts' => [
                'pdf_files' => 0,
                'log_files' => 0,
                'tmp_files' => 0,
                'total_files' => 0,
            ],
            'bytes' => [
                'total' => 0,
            ],
            'last_cleanup' => get_option(self::OPTION_LAST_RUN, null),
            'filesystem' => [
                'available' => (bool) $fs,
                'base_dir_exists' => $fs ? $fs->exists($baseDir) : false,
            ],
        ];

        if (!$fs || !$fs->exists($baseDir)) {
            return $snapshot;
        }

        $flat = self::flatten_dirlist($fs, $baseDir, $baseDir);

        foreach ($flat as $row) {
            if (($row['type'] ?? '') !== 'f') {
                continue;
            }

            $basename = (string) ($row['basename'] ?? '');
            if (in_array($basename, ['.htaccess', 'index.php'], true)) {
                continue;
            }

            $snapshot['counts']['total_files']++;
            $snapshot['bytes']['total'] += (int) ($row['size'] ?? 0);

            $path = (string) ($row['path'] ?? '');
            $lower = strtolower($path);

            if (str_contains($lower, '/logs/') && str_ends_with($lower, '.log')) {
                $snapshot['counts']['log_files']++;
                continue;
            }

            if (str_contains($lower, '/tmp/') || str_contains($lower, '/mpdf-tmp/')) {
                $snapshot['counts']['tmp_files']++;
                continue;
            }

            if (str_ends_with($lower, '.pdf')) {
                $snapshot['counts']['pdf_files']++;
            }
        }

        // Explicit total requested by the product (PDF + Logs).
        $snapshot['counts']['total_files'] = (int) ($snapshot['counts']['pdf_files'] + $snapshot['counts']['log_files']);

        return $snapshot;
    }

    /**
     * Internal: check DB availability.
     */
    private static function db_is_available(): bool
    {
        global $wpdb;
        if (!$wpdb instanceof wpdb) {
            return false;
        }

        try {
            // Lightweight ping.
            return (string) $wpdb->get_var('SELECT 1') === '1';
        } catch (\Throwable $e) {
            return false;
        }
    }

    /**
     * Cleanup temp directories.
     *
     * @return array{deleted_files:int,bytes_freed:int,errors:array<int,string>}
     */
    private static function cleanup_temp_dirs(WP_Filesystem_Base $fs, int $maxAgeSeconds): array
    {
        $baseDir = self::base_dir();
        $tmpDirs = [
            trailingslashit($baseDir) . 'tmp',
            trailingslashit($baseDir) . 'mpdf-tmp',
        ];

        $now = time();
        $deleted = 0;
        $bytesFreed = 0;
        $errors = [];

        foreach ($tmpDirs as $dir) {
            if (!$fs->exists($dir)) {
                continue;
            }

            $flat = self::flatten_dirlist($fs, $dir, $dir);
            foreach ($flat as $row) {
                if (($row['type'] ?? '') !== 'f') {
                    continue;
                }

                $basename = (string) ($row['basename'] ?? '');
                if (in_array($basename, ['.htaccess', 'index.php'], true)) {
                    continue;
                }

                $lastmod = (int) ($row['lastmodunix'] ?? 0);
                if ($lastmod <= 0) {
                    continue;
                }

                if (($now - $lastmod) < $maxAgeSeconds) {
                    continue;
                }

                $path = (string) ($row['path'] ?? '');
                $size = (int) ($row['size'] ?? 0);

                $ok = $fs->delete($path, false, 'f');
                if ($ok) {
                    $deleted++;
                    $bytesFreed += $size;
                } else {
                    $errors[] = 'delete_failed:' . $basename;
                }
            }
        }

        if ($deleted > 0) {
            Logger::ndjson_scoped('system', 'info', 'storage_tmp_cleanup', [
                'deleted_files' => $deleted,
                'bytes_freed' => $bytesFreed,
                'max_age_seconds' => $maxAgeSeconds,
            ]);
        }

        return [
            'deleted_files' => $deleted,
            'bytes_freed' => $bytesFreed,
            'errors' => $errors,
        ];
    }

    /**
     * Cleanup orphan PDFs using DB metadata.
     *
     * @return array{deleted_files:int,bytes_freed:int,errors:array<int,string>}
     */
    private static function cleanup_orphan_pdfs(WP_Filesystem_Base $fs): array
    {
        $deleted = 0;
        $bytesFreed = 0;
        $errors = [];

        $config = ComplianceConfig::get();
        $days = max(1, (int) ($config['orphan_files_retention_days'] ?? 7));

        $fileRepo = new FileRepository();
        $storage = new FileStorage();

        $orphans = $fileRepo->list_orphans_older_than_days($days);

        foreach ($orphans as $row) {
            $filename = (string) ($row['filename'] ?? '');
            $purpose = (string) ($row['purpose'] ?? '');

            // Only care about PDFs here.
            if (!str_ends_with(strtolower($filename), '.pdf') && !in_array($purpose, ['rx_pdf', 'pdf'], true)) {
                continue;
            }

            $id = (int) ($row['id'] ?? 0);
            $storageKey = (string) ($row['storage_key'] ?? '');
            if ($id <= 0 || $storageKey === '') {
                continue;
            }

            $path = $storage->path_for($storageKey);

            // Never delete our directory safety files.
            $basename = basename($path);
            if (in_array($basename, ['.htaccess', 'index.php'], true)) {
                continue;
            }

            if ($fs->exists($path)) {
                $size = (int) $fs->size($path);
                $ok = $fs->delete($path, false, 'f');
                if ($ok) {
                    $deleted++;
                    $bytesFreed += $size;
                    $fileRepo->delete_by_id($id);

                    Logger::ndjson_scoped('system', 'info', 'storage_orphan_pdf_deleted', [
                        'file_id' => $id,
                        'filename' => $filename,
                        'bytes' => $size,
                        'retention_days' => $days,
                    ]);
                } else {
                    $errors[] = 'delete_failed:' . $filename;
                }
            } else {
                // File missing on disk, still delete DB record.
                $fileRepo->delete_by_id($id);
            }
        }

        if ($deleted > 0) {
            Logger::ndjson_scoped('system', 'info', 'storage_orphan_pdfs_cleanup', [
                'deleted_files' => $deleted,
                'bytes_freed' => $bytesFreed,
                'retention_days' => $days,
            ]);
        }

        return [
            'deleted_files' => $deleted,
            'bytes_freed' => $bytesFreed,
            'errors' => $errors,
        ];
    }

    /**
     * Persist last run payload.
     *
     * @param array<string,mixed> $payload
     */
    private static function persist_last_run(array $payload): void
    {
        // Keep it small; no binary blobs.
        $safe = [
            'ok' => (bool) ($payload['ok'] ?? false),
            'trigger' => (string) ($payload['trigger'] ?? 'unknown'),
            'started_at' => (string) ($payload['started_at'] ?? ''),
            'ended_at' => (string) ($payload['ended_at'] ?? ''),
            'db_ok' => (bool) ($payload['db_ok'] ?? false),
            'deleted' => (array) ($payload['deleted'] ?? []),
            'bytes_freed' => (int) ($payload['bytes_freed'] ?? 0),
            'errors' => array_slice((array) ($payload['errors'] ?? []), 0, 25),
        ];

        update_option(self::OPTION_LAST_RUN, $safe, false);
    }

    /**
     * Get WP_Filesystem.
     */
    private static function get_filesystem(): ?WP_Filesystem_Base
    {
        global $wp_filesystem;
        if ($wp_filesystem instanceof WP_Filesystem_Base) {
            return $wp_filesystem;
        }

        if (!function_exists('WP_Filesystem')) {
            require_once ABSPATH . 'wp-admin/includes/file.php';
        }

        // nosemgrep: php.lang.security.filesystem.wp-filesystem
        WP_Filesystem();

        global $wp_filesystem;
        return $wp_filesystem instanceof WP_Filesystem_Base ? $wp_filesystem : null;
    }

    /**
     * Base private directory.
     */
    private static function base_dir(): string
    {
        $uploads = wp_upload_dir();
        $base = isset($uploads['basedir']) ? (string) $uploads['basedir'] : WP_CONTENT_DIR . '/uploads';
        return trailingslashit($base) . 'sosprescription-private';
    }

    /**
     * Flatten WP_Filesystem dirlist (recursive) into a flat list.
     *
     * @return array<int,array<string,mixed>>
     */
    private static function flatten_dirlist(WP_Filesystem_Base $fs, string $dir, string $root): array
    {
        $list = $fs->dirlist($dir, true, true);
        if (!is_array($list)) {
            return [];
        }

        return self::flatten_dirlist_from_list($list, $dir, $root);
    }

    /**
     * @param array<string,mixed> $list
     * @return array<int,array<string,mixed>>
     */
    private static function flatten_dirlist_from_list(array $list, string $dir, string $root): array
    {
        $out = [];

        foreach ($list as $name => $entry) {
            $type = is_array($entry) && isset($entry['type']) ? (string) $entry['type'] : '';
            $path = trailingslashit($dir) . $name;

            $out[] = [
                'path' => $path,
                'basename' => basename($path),
                'type' => $type,
                'size' => is_array($entry) && isset($entry['size']) ? (int) $entry['size'] : 0,
                'lastmodunix' => is_array($entry) && isset($entry['lastmodunix']) ? (int) $entry['lastmodunix'] : 0,
                'rel' => ltrim(str_replace($root, '', $path), '/'),
            ];

            if ($type === 'd' && is_array($entry) && isset($entry['files']) && is_array($entry['files'])) {
                $out = array_merge($out, self::flatten_dirlist_from_list($entry['files'], $path, $root));
            }
        }

        return $out;
    }
}
