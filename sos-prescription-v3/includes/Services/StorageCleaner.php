<?php // includes/Services/StorageCleaner.php
declare(strict_types=1);

namespace SosPrescription\Services;

use SosPrescription\Repositories\FileRepository;
use WP_Filesystem_Base;
use wpdb;

final class StorageCleaner
{
    public const CRON_HOOK = 'sosprescription_daily_storage_cleanup';
    public const ACTION_FORCE_CLEANUP = 'sosprescription_storage_cleanup_now';

    private const OPTION_LAST_RUN = 'sosprescription_storage_cleaner_last_run';

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

        add_action('wp_loaded', static function (): void {
            self::ensure_cron_scheduled();
        }, 20);

        add_action('action_scheduler_init', static function (): void {
            self::ensure_cron_scheduled();
        }, 20);

        if (did_action('action_scheduler_init') > 0 || did_action('wp_loaded') > 0) {
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
            wp_schedule_event(time() + 120, 'daily', self::CRON_HOOK);
        }

        self::$cron_registered = true;
    }

    private static function scheduling_is_ready(): bool
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

        return true;
    }

    public static function run_scheduled(): void
    {
        self::run('cron');
    }

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

        self::safe_ndjson('info', 'storage_cleanup_start', [
            'req_id' => $rid,
            'trigger' => $trigger,
        ]);

        $dbOk = self::db_is_available();
        $payload['db_ok'] = $dbOk;

        if (!$dbOk) {
            $payload['ended_at'] = gmdate('c');
            $payload['errors'][] = 'db_unavailable';
            self::persist_last_run($payload);

            self::safe_ndjson('warning', 'storage_cleanup_skipped_db_unavailable', [
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

            self::safe_ndjson('error', 'storage_cleanup_failed_filesystem_unavailable', [
                'req_id' => $rid,
                'trigger' => $trigger,
            ]);

            return $payload;
        }

        $tmpResult = self::cleanup_temp_dirs($fs, 24 * 3600);
        $payload['deleted']['tmp_files'] = $tmpResult['deleted_files'];
        $payload['bytes_freed'] += $tmpResult['bytes_freed'];
        if (!empty($tmpResult['errors'])) {
            $payload['errors'] = array_merge($payload['errors'], $tmpResult['errors']);
        }

        $orphansResult = self::cleanup_orphan_pdfs($fs);
        $payload['deleted']['orphan_pdfs'] = $orphansResult['deleted_files'];
        $payload['bytes_freed'] += $orphansResult['bytes_freed'];
        if (!empty($orphansResult['errors'])) {
            $payload['errors'] = array_merge($payload['errors'], $orphansResult['errors']);
        }

        $payload['ok'] = empty($payload['errors']);
        $payload['ended_at'] = gmdate('c');

        self::persist_last_run($payload);

        self::safe_ndjson($payload['ok'] ? 'info' : 'warning', 'storage_cleanup_end', [
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

        $snapshot['counts']['total_files'] = (int) ($snapshot['counts']['pdf_files'] + $snapshot['counts']['log_files']);

        return $snapshot;
    }

    private static function db_is_available(): bool
    {
        global $wpdb;
        if (!$wpdb instanceof wpdb) {
            return false;
        }

        try {
            return (string) $wpdb->get_var('SELECT 1') === '1';
        } catch (\Throwable $e) {
            return false;
        }
    }

    /**
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
            self::safe_ndjson('info', 'storage_tmp_cleanup', [
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

            if (!str_ends_with(strtolower($filename), '.pdf') && !in_array($purpose, ['rx_pdf', 'pdf'], true)) {
                continue;
            }

            $id = (int) ($row['id'] ?? 0);
            $storageKey = (string) ($row['storage_key'] ?? '');
            if ($id <= 0 || $storageKey === '') {
                continue;
            }

            $path = $storage->path_for($storageKey);

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

                    self::safe_ndjson('info', 'storage_orphan_pdf_deleted', [
                        'file_id' => $id,
                        'filename' => $filename,
                        'bytes' => $size,
                        'retention_days' => $days,
                    ]);
                } else {
                    $errors[] = 'delete_failed:' . $filename;
                }
            } else {
                $fileRepo->delete_by_id($id);
            }
        }

        if ($deleted > 0) {
            self::safe_ndjson('info', 'storage_orphan_pdfs_cleanup', [
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
     * @param array<string,mixed> $payload
     */
    private static function persist_last_run(array $payload): void
    {
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

    private static function get_filesystem(): ?WP_Filesystem_Base
    {
        global $wp_filesystem;
        if ($wp_filesystem instanceof WP_Filesystem_Base) {
            return $wp_filesystem;
        }

        if (!function_exists('WP_Filesystem')) {
            require_once ABSPATH . 'wp-admin/includes/file.php';
        }

        WP_Filesystem();

        global $wp_filesystem;
        return $wp_filesystem instanceof WP_Filesystem_Base ? $wp_filesystem : null;
    }

    private static function base_dir(): string
    {
        $uploads = wp_upload_dir();
        $base = isset($uploads['basedir']) ? (string) $uploads['basedir'] : WP_CONTENT_DIR . '/uploads';
        return trailingslashit($base) . 'sosprescription-private';
    }

    /**
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

    /**
     * @param array<string,mixed> $payload
     */
    private static function safe_ndjson(string $level, string $event, array $payload = []): void
    {
        try {
            Logger::ndjson_scoped('runtime', 'storage', $level, $event, $payload);
        } catch (\Throwable $e) {
            error_log('[SOSPrescription] StorageCleaner log failure: ' . $e->getMessage() . ' | event=' . $event);
        }
    }
}
