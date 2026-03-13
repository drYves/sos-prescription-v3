<?php
/** Lot B stateless deployment marker. */

declare(strict_types=1);

namespace SOSPrescription\Services;

use WP_Filesystem_Base;

/**
 * Production diagnostics provider (System Status).
 *
 * This class is designed to be "failsafe": it must always return a report,
 * even if some checks fail.
 */
final class DiagnosticProvider
{
    /**
     * Build a structured diagnostic report.
     *
     * @return array<string, mixed>
     */
    public static function collect(): array
    {
        $generatedAt = gmdate('c');

        $report = [
            'generated_at' => $generatedAt,
            'site' => [
                'home_url' => home_url('/'),
                'site_url' => site_url('/'),
                'wp_version' => get_bloginfo('version'),
                'php_version' => PHP_VERSION,
                'multisite' => is_multisite(),
            ],
            'plugin' => [
                'version' => defined('SOSPRESCRIPTION_VERSION') ? (string) SOSPRESCRIPTION_VERSION : 'unknown',
                'path' => defined('SOSPRESCRIPTION_PATH') ? (string) SOSPRESCRIPTION_PATH : '',
            ],
            'checks' => [],
            'errors' => [],
        ];

        // WP_Filesystem init (failsafe)
        [$fs, $fsError] = self::initFilesystem();
        $report['checks']['filesystem'] = [
            'status' => $fs ? 'pass' : 'fail',
            'details' => $fs ? 'WP_Filesystem initialized' : ($fsError ?: 'WP_Filesystem init failed'),
        ];
        if (!$fs) {
            $report['errors'][] = [
                'code' => 'filesystem_init_failed',
                'message' => $fsError ?: 'Unable to initialize WP_Filesystem',
            ];
        }

        try {
            $report['checks']['io_permissions'] = $fs ? self::checkIoPermissions($fs) : self::checkIoPermissionsFallback();
        } catch (\Throwable $e) {
            $report['checks']['io_permissions'] = [
                'status' => 'fail',
                'details' => 'Exception while checking I/O permissions',
                'exception' => $e->getMessage(),
            ];
            $report['errors'][] = [
                'code' => 'io_permissions_exception',
                'message' => $e->getMessage(),
            ];
        }

        try {
            $report['checks']['assets'] = $fs ? self::checkAssets($fs) : self::checkAssetsFallback();
        } catch (\Throwable $e) {
            $report['checks']['assets'] = [
                'status' => 'fail',
                'details' => 'Exception while checking assets',
                'exception' => $e->getMessage(),
            ];
            $report['errors'][] = [
                'code' => 'assets_exception',
                'message' => $e->getMessage(),
            ];
        }

        try {
            $report['checks']['runtime'] = self::checkRuntime();
        } catch (\Throwable $e) {
            $report['checks']['runtime'] = [
                'status' => 'fail',
                'details' => 'Exception while checking runtime',
                'exception' => $e->getMessage(),
            ];
            $report['errors'][] = [
                'code' => 'runtime_exception',
                'message' => $e->getMessage(),
            ];
        }

        try {
            $report['checks']['dependencies'] = $fs ? self::checkDependencies($fs) : self::checkDependenciesFallback();
        } catch (\Throwable $e) {
            $report['checks']['dependencies'] = [
                'status' => 'fail',
                'details' => 'Exception while checking dependencies',
                'exception' => $e->getMessage(),
            ];
            $report['errors'][] = [
                'code' => 'dependencies_exception',
                'message' => $e->getMessage(),
            ];
        }

        try {
            $report['checks']['sql_bridge'] = self::get_sql_bridge_snapshot();
        } catch (\Throwable $e) {
            $report['checks']['sql_bridge'] = [
                'status' => 'fail',
                'details' => [
                    'message' => 'Exception while checking SQL bridge',
                    'exception' => $e->getMessage(),
                ],
            ];
            $report['errors'][] = [
                'code' => 'sql_bridge_exception',
                'message' => $e->getMessage(),
            ];
        }

        try {
            $report['checks']['aws_s3_bridge'] = self::get_cached_bridge_result('aws_s3');
            $report['checks']['scalingo_bridge'] = self::get_cached_bridge_result('scalingo');
        } catch (\Throwable $e) {
            $report['errors'][] = [
                'code' => 'bridge_cache_exception',
                'message' => $e->getMessage(),
            ];
        }

        // Storage hygiene metrics (failsafe: export should still work even if this part fails).
        try {
            $report['storage'] = StorageCleaner::get_status_snapshot();
        } catch (\Throwable $e) {
            $report['storage'] = [
                'error' => 'storage_snapshot_exception',
                'message' => $e->getMessage(),
            ];
            $report['errors'][] = [
                'code' => 'storage_snapshot_exception',
                'message' => $e->getMessage(),
            ];
        }
        // Extended configuration audit (templates, options, hooks, routing).
        try {
            $report['config_audit'] = self::collect_config_audit($fs);
        } catch (\Throwable $e) {
            $report['config_audit'] = [
                'error' => 'config_audit_exception',
                'message' => $e->getMessage(),
            ];
            $report['errors'][] = [
                'code' => 'config_audit_exception',
                'message' => $e->getMessage(),
            ];
        }


        // Attach actionable advice to FAIL/WARN checks (safe for export + UI).
        if (isset($report['checks']) && is_array($report['checks'])) {
            $report['checks'] = self::addActionableAdvice($report['checks']);
        }

        return $report;
    }

    /**
     * @return array{0: ?WP_Filesystem_Base, 1: string}
     */
    private static function initFilesystem(): array
    {
        global $wp_filesystem;

        try {
            if (!function_exists('WP_Filesystem')) {
                require_once ABSPATH . 'wp-admin/includes/file.php';
            }

            if (empty($wp_filesystem)) {
                $ok = WP_Filesystem();
                if (!$ok) {
                    return [null, 'WP_Filesystem() returned false (check FS_METHOD/permissions)'];
                }
            }

            if (!$wp_filesystem instanceof WP_Filesystem_Base) {
                return [null, 'WP_Filesystem global is not a WP_Filesystem_Base instance'];
            }

            return [$wp_filesystem, ''];
        } catch (\Throwable $e) {
            return [null, $e->getMessage()];
        }
    }

    /**
     * @return array<string, mixed>
     */
    private static function checkIoPermissions(WP_Filesystem_Base $fs): array
    {
        $uploads = wp_upload_dir();
        $base = rtrim((string) ($uploads['basedir'] ?? ''), '/');

        $dirs = [
            'uploads_base' => $base,
            'uploads_sosprescription' => $base . '/sosprescription',
            'logs_dir' => Logger::logs_dir(),
            'private_dir' => FileStorage::private_dir(),
            'templates_override_dir' => $base . '/sosprescription-templates',
        ];

        $checks = [];
        $worst = 'pass';

        foreach ($dirs as $key => $path) {
            $checks[$key] = self::checkDirTreeWritable($fs, (string) $path, 300);
            $worst = self::worstStatus($worst, (string) ($checks[$key]['status'] ?? 'fail'));
        }

        return [
            'status' => $worst,
            'directories' => $checks,
        ];
    }

    /**
     * Fallback without WP_Filesystem.
     *
     * @return array<string, mixed>
     */
    private static function checkIoPermissionsFallback(): array
    {
        $uploads = wp_upload_dir();
        $base = rtrim((string) ($uploads['basedir'] ?? ''), '/');

        $dirs = [
            'uploads_base' => $base,
            'uploads_sosprescription' => $base . '/sosprescription',
            'logs_dir' => Logger::logs_dir(),
            'private_dir' => FileStorage::private_dir(),
            'templates_override_dir' => $base . '/sosprescription-templates',
        ];

        $checks = [];
        $worst = 'pass';

        foreach ($dirs as $key => $path) {
            $exists = file_exists((string) $path);
            $writable = $exists ? wp_is_writable((string) $path) : false;
            $status = ($exists && $writable) ? 'pass' : 'fail';
            $checks[$key] = [
                'path' => (string) $path,
                'exists' => $exists,
                'writable' => $writable,
                'status' => $status,
                'note' => 'Fallback (no WP_Filesystem)',
            ];
            $worst = self::worstStatus($worst, $status);
        }

        return [
            'status' => $worst,
            'directories' => $checks,
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private static function checkDirTreeWritable(WP_Filesystem_Base $fs, string $path, int $maxDirs): array
    {
        $path = rtrim($path, '/');

        $exists = $fs->exists($path);
        if (!$exists) {
            return [
                'path' => $path,
                'exists' => false,
                'writable' => false,
                'status' => 'fail',
                'details' => 'Directory does not exist',
            ];
        }

        $writable = $fs->is_writable($path);
        $nonWritable = [];
        $checkedDirs = 0;
        $truncated = false;

        // Only perform recursive check on directories (not files) to keep it fast.
        $dirlist = $fs->dirlist($path, true, true);
        if (is_array($dirlist)) {
            $walk = function (array $entries, string $parent) use (&$walk, $fs, &$nonWritable, &$checkedDirs, $maxDirs, &$truncated): void {
                foreach ($entries as $entry) {
                    if ($checkedDirs >= $maxDirs) {
                        $truncated = true;
                        return;
                    }

                    if (!is_array($entry)) {
                        continue;
                    }

                    $type = (string) ($entry['type'] ?? '');
                    $name = (string) ($entry['name'] ?? '');
                    if ($name === '') {
                        continue;
                    }

                    $full = rtrim($parent, '/') . '/' . $name;

                    if ($type === 'd') {
                        $checkedDirs++;
                        if (!$fs->is_writable($full)) {
                            $nonWritable[] = $full;
                        }

                        if (!empty($entry['files']) && is_array($entry['files'])) {
                            $walk($entry['files'], $full);
                        }
                    }
                }
            };

            $walk($dirlist, $path);
        }

        $status = ($writable && empty($nonWritable)) ? 'pass' : 'fail';
        if ($status === 'pass' && $truncated) {
            $status = 'warn';
        }

        return [
            'path' => $path,
            'exists' => true,
            'writable' => $writable,
            'status' => $status,
            'checked_dirs' => $checkedDirs,
            'truncated' => $truncated,
            'non_writable_dirs' => $nonWritable,
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private static function checkAssets(WP_Filesystem_Base $fs): array
    {
        $pluginRoot = defined('SOSPRESCRIPTION_PATH') ? rtrim((string) SOSPRESCRIPTION_PATH, '/') : '';

        $assets = [
            'tesseract_min_js' => $pluginRoot . '/assets/js/libs/tesseract/tesseract.min.js',
            'tesseract_worker_js' => $pluginRoot . '/assets/js/libs/tesseract/worker.min.js',
            'tesseract_core_wasm' => $pluginRoot . '/assets/js/libs/tesseract/tesseract-core.wasm',
            'tesseract_core_wasm_js' => $pluginRoot . '/assets/js/libs/tesseract/tesseract-core.wasm.js',
            'tesseract_lang_fra' => $pluginRoot . '/assets/lang/fra.traineddata.gz',
        ];

        $results = [];
        $worst = 'pass';

        foreach ($assets as $key => $path) {
            $exists = $path !== '' ? $fs->exists($path) : false;
            $size = $exists ? (int) $fs->size($path) : 0;
            $status = $exists ? 'pass' : 'fail';
            $results[$key] = [
                'path' => $path,
                'exists' => $exists,
                'size_bytes' => $size,
                'status' => $status,
            ];
            $worst = self::worstStatus($worst, $status);
        }

        return [
            'status' => $worst,
            'files' => $results,
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private static function checkAssetsFallback(): array
    {
        $pluginRoot = defined('SOSPRESCRIPTION_PATH') ? rtrim((string) SOSPRESCRIPTION_PATH, '/') : '';

        $assets = [
            'tesseract_min_js' => $pluginRoot . '/assets/js/libs/tesseract/tesseract.min.js',
            'tesseract_worker_js' => $pluginRoot . '/assets/js/libs/tesseract/worker.min.js',
            'tesseract_core_wasm' => $pluginRoot . '/assets/js/libs/tesseract/tesseract-core.wasm',
            'tesseract_core_wasm_js' => $pluginRoot . '/assets/js/libs/tesseract/tesseract-core.wasm.js',
            'tesseract_lang_fra' => $pluginRoot . '/assets/lang/fra.traineddata.gz',
        ];

        $results = [];
        $worst = 'pass';

        foreach ($assets as $key => $path) {
            $exists = $path !== '' ? file_exists($path) : false;
            $size = $exists ? (int) filesize($path) : 0;
            $status = $exists ? 'pass' : 'fail';
            $results[$key] = [
                'path' => $path,
                'exists' => $exists,
                'size_bytes' => $size,
                'status' => $status,
                'note' => 'Fallback (no WP_Filesystem)',
            ];
            $worst = self::worstStatus($worst, $status);
        }

        return [
            'status' => $worst,
            'files' => $results,
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private static function checkRuntime(): array
    {
        $phpOk = version_compare(PHP_VERSION, '7.4.0', '>=');

        $memoryLimit = (string) ini_get('memory_limit');
        $memoryBytes = self::iniToBytes($memoryLimit);
        $memoryOk = $memoryBytes >= (256 * 1024 * 1024);

        $maxExec = (int) ini_get('max_execution_time');
        // Some environments set 0 = unlimited.
        $maxExecOk = ($maxExec === 0) ? true : ($maxExec >= 60);

        $status = 'pass';
        if (!$phpOk) {
            $status = 'fail';
        }
        if ($phpOk && (!$memoryOk || !$maxExecOk)) {
            $status = 'warn';
        }

        return [
            'status' => $status,
            'php' => [
                'version' => PHP_VERSION,
                'min_required' => '7.4.0',
                'ok' => $phpOk,
            ],
            'memory_limit' => [
                'raw' => $memoryLimit,
                'bytes' => $memoryBytes,
                'recommended_bytes' => 268435456,
                'ok' => $memoryOk,
            ],
            'max_execution_time' => [
                'seconds' => $maxExec,
                'recommended_min_seconds' => 60,
                'ok' => $maxExecOk,
            ],
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private static function checkDependencies(WP_Filesystem_Base $fs): array
    {
        $pluginRoot = defined('SOSPRESCRIPTION_PATH') ? rtrim((string) SOSPRESCRIPTION_PATH, '/') : '';
        $autoload = $pluginRoot . '/vendor/autoload.php';

        $autoloadExists = $pluginRoot !== '' ? $fs->exists($autoload) : false;
        $mpdfOk = class_exists('Mpdf\\Mpdf');

        $status = ($autoloadExists && $mpdfOk) ? 'pass' : 'fail';

        return [
            'status' => $status,
            'vendor_autoload' => [
                'path' => $autoload,
                'exists' => $autoloadExists,
            ],
            'mpdf' => [
                'class_exists' => $mpdfOk,
            ],
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private static function checkDependenciesFallback(): array
    {
        $pluginRoot = defined('SOSPRESCRIPTION_PATH') ? rtrim((string) SOSPRESCRIPTION_PATH, '/') : '';
        $autoload = $pluginRoot . '/vendor/autoload.php';

        $autoloadExists = $pluginRoot !== '' ? file_exists($autoload) : false;
        $mpdfOk = class_exists('Mpdf\\Mpdf');

        $status = ($autoloadExists && $mpdfOk) ? 'pass' : 'fail';

        return [
            'status' => $status,
            'vendor_autoload' => [
                'path' => $autoload,
                'exists' => $autoloadExists,
                'note' => 'Fallback (no WP_Filesystem)',
            ],
            'mpdf' => [
                'class_exists' => $mpdfOk,
            ],
        ];
    }

    private static function iniToBytes(string $value): int
    {
        $value = trim($value);
        if ($value === '' || $value === '-1') {
            return PHP_INT_MAX;
        }

        $last = strtolower($value[strlen($value) - 1]);
        $num = (int) $value;

        switch ($last) {
            case 'g':
                $num *= 1024;
                // no break
            case 'm':
                $num *= 1024;
                // no break
            case 'k':
                $num *= 1024;
                break;
            default:
                break;
        }

        return $num;
    }

    /**
     * @return array<string, mixed>
     */
    public static function get_bridge_dashboard(): array
    {
        return [
            'sql' => self::get_sql_bridge_snapshot(),
            'aws_s3' => self::get_cached_bridge_result('aws_s3'),
            'scalingo' => self::get_cached_bridge_result('scalingo'),
        ];
    }

    /**
     * @return array<string, mixed>
     */
    public static function test_sql_bridge(): array
    {
        return self::get_sql_bridge_snapshot();
    }

    /**
     * @return array<string, mixed>
     */
    public static function test_s3_bridge(): array
    {
        $config = self::resolve_s3_config();
        if ($config['bucket'] === '' || $config['region'] === '' || $config['access_key'] === '' || $config['secret_key'] === '') {
            $result = [
                'status' => 'fail',
                'tested_at' => gmdate('c'),
                'details' => [
                    'message' => 'Configuration S3 incomplete.',
                    'bucket' => $config['bucket'],
                    'region' => $config['region'],
                    'endpoint' => $config['endpoint'],
                ],
            ];

            self::store_bridge_result('aws_s3', $result);
            return $result;
        }

        $key = 'diagnostics/ping-' . gmdate('Ymd-His') . '-' . wp_generate_password(8, false, false) . '.txt';
        $payload = 'sosprescription-s3-bridge-ping';
        $putUrl = self::build_presigned_s3_url('PUT', $config, $key, 120);
        $getUrl = self::build_presigned_s3_url('GET', $config, $key, 120);
        $deleteUrl = self::build_presigned_s3_url('DELETE', $config, $key, 120);

        if (is_wp_error($putUrl) || is_wp_error($getUrl) || is_wp_error($deleteUrl)) {
            $error = is_wp_error($putUrl) ? $putUrl : (is_wp_error($getUrl) ? $getUrl : $deleteUrl);
            $result = [
                'status' => 'fail',
                'tested_at' => gmdate('c'),
                'details' => [
                    'message' => $error->get_error_message(),
                    'bucket' => $config['bucket'],
                    'region' => $config['region'],
                    'endpoint' => $config['endpoint'],
                ],
            ];
            self::store_bridge_result('aws_s3', $result);
            return $result;
        }

        $start = microtime(true);
        $put = wp_remote_request($putUrl, [
            'method' => 'PUT',
            'timeout' => 10,
            'headers' => [
                'Content-Type' => 'text/plain; charset=utf-8',
            ],
            'body' => $payload,
        ]);
        $putMs = (int) round((microtime(true) - $start) * 1000);

        if (is_wp_error($put)) {
            $result = [
                'status' => 'fail',
                'tested_at' => gmdate('c'),
                'details' => [
                    'message' => 'Echec ecriture S3.',
                    'error' => $put->get_error_message(),
                    'latency_ms' => $putMs,
                    'bucket' => $config['bucket'],
                    'region' => $config['region'],
                ],
            ];
            self::store_bridge_result('aws_s3', $result);
            return $result;
        }

        $putCode = (int) wp_remote_retrieve_response_code($put);
        $readStart = microtime(true);
        $get = wp_remote_get($getUrl, ['timeout' => 10]);
        $getMs = (int) round((microtime(true) - $readStart) * 1000);
        $delete = wp_remote_request($deleteUrl, ['method' => 'DELETE', 'timeout' => 10]);

        $getCode = is_wp_error($get) ? 0 : (int) wp_remote_retrieve_response_code($get);
        $getBody = is_wp_error($get) ? '' : (string) wp_remote_retrieve_body($get);
        $deleteCode = is_wp_error($delete) ? 0 : (int) wp_remote_retrieve_response_code($delete);

        $ok = $putCode >= 200 && $putCode < 300
            && $getCode >= 200 && $getCode < 300
            && hash_equals($payload, $getBody);

        $result = [
            'status' => $ok ? 'pass' : 'fail',
            'tested_at' => gmdate('c'),
            'details' => [
                'bucket' => $config['bucket'],
                'region' => $config['region'],
                'endpoint' => $config['endpoint'] !== '' ? $config['endpoint'] : 'aws',
                'write_http_status' => $putCode,
                'read_http_status' => $getCode,
                'delete_http_status' => $deleteCode,
                'write_latency_ms' => $putMs,
                'read_latency_ms' => $getMs,
                'round_trip_ok' => $ok,
                'cleanup_ok' => $deleteCode === 0 || ($deleteCode >= 200 && $deleteCode < 300) || $deleteCode === 204,
            ],
        ];

        self::store_bridge_result('aws_s3', $result);
        return $result;
    }

    /**
     * @return array<string, mixed>
     */
    public static function test_scalingo_bridge(): array
    {
        $baseUrl = self::get_env_or_constant('ML_WORKER_BASE_URL');
        if ($baseUrl === '') {
            $result = [
                'status' => 'fail',
                'tested_at' => gmdate('c'),
                'details' => [
                    'message' => 'ML_WORKER_BASE_URL manquante.',
                ],
            ];
            self::store_bridge_result('scalingo', $result);
            return $result;
        }

        $target = rtrim($baseUrl, '/') . '/pulse';
        $headers = ['Accept' => 'application/json'];
        $hmacSecret = self::get_env_or_constant('ML_HMAC_SECRET');
        if ($hmacSecret !== '') {
            $tsMs = (int) floor(microtime(true) * 1000);
            $nonce = rtrim(strtr(base64_encode(wp_generate_password(16, true, true)), '+/', '-_'), '=');
            $canonicalPayload = sprintf('GET|%s|%d|%s', '/pulse', $tsMs, $nonce);
            $payloadB64 = rtrim(strtr(base64_encode($canonicalPayload), '+/', '-_'), '=');
            $sigHex = hash_hmac('sha256', $canonicalPayload, $hmacSecret, false);
            $headers['X-MedLab-Signature'] = sprintf('mls1.%s.%s', $payloadB64, $sigHex);

            $kid = self::get_env_or_constant('ML_HMAC_KID');
            if ($kid !== '') {
                $headers['X-MedLab-Kid'] = $kid;
            }
        }

        $start = microtime(true);
        $response = wp_remote_get($target, [
            'timeout' => 5,
            'redirection' => 0,
            'headers' => $headers,
        ]);
        $latency = (int) round((microtime(true) - $start) * 1000);

        if (is_wp_error($response)) {
            $result = [
                'status' => 'fail',
                'tested_at' => gmdate('c'),
                'details' => [
                    'message' => 'Moteur PDF indisponible.',
                    'url' => $target,
                    'latency_ms' => $latency,
                    'error' => $response->get_error_message(),
                ],
            ];
            self::store_bridge_result('scalingo', $result);
            return $result;
        }

        $code = (int) wp_remote_retrieve_response_code($response);
        $body = (string) wp_remote_retrieve_body($response);
        $data = json_decode($body, true);
        $ok = $code >= 200 && $code < 300;

        $result = [
            'status' => $ok ? 'pass' : 'fail',
            'tested_at' => gmdate('c'),
            'details' => [
                'url' => $target,
                'http_status' => $code,
                'latency_ms' => $latency,
                'state' => is_array($data) && isset($data['state']) ? (string) $data['state'] : null,
                'worker_id' => is_array($data) && isset($data['worker_id']) ? (string) $data['worker_id'] : null,
            ],
        ];

        self::store_bridge_result('scalingo', $result);
        return $result;
    }

    /**
     * @return array<string, mixed>
     */
    public static function get_sql_bridge_snapshot(): array
    {
        global $wpdb;

        $required = [
            'jobs' => $wpdb->prefix . 'sosprescription_jobs',
            'audit_log' => $wpdb->prefix . 'sosprescription_audit_log',
            'medications' => $wpdb->prefix . 'sosprescription_medications',
            'mitm' => $wpdb->prefix . 'sosprescription_mitm',
        ];

        $details = [];
        $status = 'pass';

        foreach ($required as $label => $table) {
            $exists = self::table_exists($table);
            $rows = $exists ? self::safe_count_table($table) : null;
            $tableStatus = $exists ? 'pass' : 'fail';
            $details[$label] = [
                'table' => $table,
                'exists' => $exists,
                'rows' => $rows,
                'status' => $tableStatus,
            ];
            $status = self::worstStatus($status, $tableStatus);
        }

        return [
            'status' => $status,
            'details' => $details,
            'tested_at' => gmdate('c'),
        ];
    }

    /**
     * @return array<string, mixed>
     */
    public static function get_cached_bridge_result(string $bridge): array
    {
        $all = get_option('sosprescription_bridge_results', []);
        if (!is_array($all)) {
            $all = [];
        }

        $result = isset($all[$bridge]) && is_array($all[$bridge]) ? $all[$bridge] : [];
        if ($result === []) {
            return [
                'status' => 'warn',
                'details' => [
                    'message' => 'Test non execute.',
                ],
                'tested_at' => null,
            ];
        }

        return $result;
    }

    /**
     * @param array<string, mixed> $result
     */
    private static function store_bridge_result(string $bridge, array $result): void
    {
        $all = get_option('sosprescription_bridge_results', []);
        if (!is_array($all)) {
            $all = [];
        }

        $all[$bridge] = $result;
        update_option('sosprescription_bridge_results', $all, false);
    }

    private static function table_exists(string $table): bool
    {
        global $wpdb;

        $sql = $wpdb->prepare('SHOW TABLES LIKE %s', $table);
        return (string) $wpdb->get_var($sql) === $table;
    }

    private static function safe_count_table(string $table): ?int
    {
        global $wpdb;

        try {
            $value = $wpdb->get_var("SELECT COUNT(*) FROM `{$table}`");
            return $value === null ? null : (int) $value;
        } catch (\Throwable $e) {
            return null;
        }
    }

    /**
     * @return array{bucket:string,region:string,endpoint:string,access_key:string,secret_key:string,session_token:string}
     */
    private static function resolve_s3_config(): array
    {
        return [
            'bucket' => self::get_env_or_constant('SOSPRESCRIPTION_S3_BUCKET', self::get_env_or_constant('S3_BUCKET_PDF')),
            'region' => self::get_env_or_constant('SOSPRESCRIPTION_S3_REGION', self::get_env_or_constant('AWS_REGION', self::get_env_or_constant('S3_REGION'))),
            'endpoint' => self::get_env_or_constant('SOSPRESCRIPTION_S3_ENDPOINT', self::get_env_or_constant('AWS_ENDPOINT_URL_S3', self::get_env_or_constant('S3_ENDPOINT'))),
            'access_key' => self::get_env_or_constant('SOSPRESCRIPTION_S3_ACCESS_KEY', self::get_env_or_constant('AWS_ACCESS_KEY_ID', self::get_env_or_constant('S3_ACCESS_KEY_ID'))),
            'secret_key' => self::get_env_or_constant('SOSPRESCRIPTION_S3_SECRET_KEY', self::get_env_or_constant('AWS_SECRET_ACCESS_KEY', self::get_env_or_constant('S3_SECRET_ACCESS_KEY'))),
            'session_token' => self::get_env_or_constant('SOSPRESCRIPTION_S3_SESSION_TOKEN', self::get_env_or_constant('AWS_SESSION_TOKEN')),
        ];
    }

    /**
     * @param array{bucket:string,region:string,endpoint:string,access_key:string,secret_key:string,session_token:string} $config
     * @return string|\WP_Error
     */
    private static function build_presigned_s3_url(string $method, array $config, string $key, int $ttl)
    {
        $bucket = $config['bucket'];
        $region = $config['region'];
        $endpoint = $config['endpoint'];
        $accessKey = $config['access_key'];
        $secretKey = $config['secret_key'];
        $sessionToken = $config['session_token'];

        if ($bucket === '' || $region === '' || $accessKey === '' || $secretKey === '') {
            return new \WP_Error('sosprescription_s3_config_missing', 'Configuration S3 incomplete.');
        }

        $ttl = max(1, min(604800, $ttl));
        $amzDate = gmdate('Ymd\THis\Z');
        $date = gmdate('Ymd');
        $scope = $date . '/' . $region . '/s3/aws4_request';
        $usePathStyle = ($endpoint !== '' || strpos($bucket, '.') !== false);

        if ($endpoint !== '') {
            $parsed = wp_parse_url($endpoint);
            $scheme = !empty($parsed['scheme']) ? (string) $parsed['scheme'] : 'https';
            $host = !empty($parsed['host']) ? (string) $parsed['host'] : '';
            $basePath = !empty($parsed['path']) ? rtrim((string) $parsed['path'], '/') : '';

            if ($host === '') {
                return new \WP_Error('sosprescription_s3_endpoint_invalid', 'Endpoint S3 invalide.');
            }

            $canonicalUri = $basePath . '/' . self::aws_uri_encode($bucket) . '/' . self::aws_uri_encode_path($key);
            $urlBase = $scheme . '://' . $host;
        } elseif ($usePathStyle) {
            $host = 's3.' . $region . '.amazonaws.com';
            $canonicalUri = '/' . self::aws_uri_encode($bucket) . '/' . self::aws_uri_encode_path($key);
            $urlBase = 'https://' . $host;
        } else {
            $host = $bucket . '.s3.' . $region . '.amazonaws.com';
            $canonicalUri = '/' . self::aws_uri_encode_path($key);
            $urlBase = 'https://' . $host;
        }

        $query = [
            'X-Amz-Algorithm' => 'AWS4-HMAC-SHA256',
            'X-Amz-Credential' => $accessKey . '/' . $scope,
            'X-Amz-Date' => $amzDate,
            'X-Amz-Expires' => (string) $ttl,
            'X-Amz-SignedHeaders' => 'host',
        ];

        if ($sessionToken !== '') {
            $query['X-Amz-Security-Token'] = $sessionToken;
        }

        $canonicalQuery = self::aws_build_query($query);
        $canonicalHeaders = 'host:' . $host . "\n";
        $canonicalRequest = strtoupper($method) . "\n{$canonicalUri}\n{$canonicalQuery}\n{$canonicalHeaders}\nhost\nUNSIGNED-PAYLOAD";
        $stringToSign = "AWS4-HMAC-SHA256\n{$amzDate}\n{$scope}\n" . hash('sha256', $canonicalRequest);
        $signingKey = self::aws_signing_key($secretKey, $date, $region, 's3');
        $signature = hash_hmac('sha256', $stringToSign, $signingKey);

        return $urlBase . $canonicalUri . '?' . $canonicalQuery . '&X-Amz-Signature=' . $signature;
    }

    private static function aws_signing_key(string $secret, string $date, string $region, string $service): string
    {
        $kDate = hash_hmac('sha256', $date, 'AWS4' . $secret, true);
        $kRegion = hash_hmac('sha256', $region, $kDate, true);
        $kService = hash_hmac('sha256', $service, $kRegion, true);

        return hash_hmac('sha256', 'aws4_request', $kService, true);
    }

    /**
     * @param array<string, string> $params
     */
    private static function aws_build_query(array $params): string
    {
        ksort($params);
        $pairs = [];
        foreach ($params as $key => $value) {
            $pairs[] = self::aws_uri_encode($key) . '=' . self::aws_uri_encode($value);
        }

        return implode('&', $pairs);
    }

    private static function aws_uri_encode_path(string $value): string
    {
        $segments = explode('/', ltrim($value, '/'));
        $encoded = [];
        foreach ($segments as $segment) {
            $encoded[] = self::aws_uri_encode($segment);
        }

        return implode('/', $encoded);
    }

    private static function aws_uri_encode(string $value): string
    {
        return str_replace('%7E', '~', rawurlencode($value));
    }

    private static function get_env_or_constant(string $name, string $default = ''): string
    {
        if (defined($name)) {
            $value = constant($name);
            if (is_string($value) && $value !== '') {
                return $value;
            }
        }

        $env = getenv($name);
        if (is_string($env) && $env !== '') {
            return $env;
        }

        return $default;
    }



    /**
     * Extended configuration audit: templates overrides, active options, hooks interference, routing conflicts.
     *
     * @return array<string, mixed>
     */
    private static function collect_config_audit(?WP_Filesystem_Base $fs): array
    {
        $fsOk = ($fs instanceof WP_Filesystem_Base);

        return [
            'templates' => $fsOk ? self::audit_templates($fs) : self::audit_templates_fallback(),
            'options' => self::audit_options(),
            'hooks' => self::audit_hooks(),
            'routing' => self::audit_routing(),
        ];
    }

    /**
     * Detect whether plugin templates are overridden in uploads or in the active theme.
     *
     * @return array<int, array<string, mixed>>
     */
    private static function audit_templates(WP_Filesystem_Base $fs): array
    {
        $templatesDir = trailingslashit(SOSPRESCRIPTION_PATH) . 'templates';
        $uploads = wp_upload_dir();
        $overrideDir = trailingslashit((string) ($uploads['basedir'] ?? '')) . 'sosprescription-templates';

        $items = [];

        $dirlist = $fs->dirlist($templatesDir, false, false);
        if (!is_array($dirlist)) {
            $dirlist = [];
        }

        foreach ($dirlist as $name => $meta) {
            if (!is_string($name) || !str_ends_with($name, '.html')) {
                continue;
            }

            if (is_array($meta) && isset($meta['type']) && $meta['type'] !== 'f') {
                continue;
            }

            $pluginPath = trailingslashit($templatesDir) . $name;
            $uploadPath = trailingslashit($overrideDir) . $name;
            $themeOverridePath = self::locate_theme_override($name);

            $usedPath = $pluginPath;
            $usedSource = 'plugin_default';

            // Upload override (official override mechanism).
            if (self::fs_exists($fs, $uploadPath)) {
                $usedPath = $uploadPath;
                $usedSource = 'upload_override';
            }

            // Optional filter override for the Rx PDF template.
            if ($name === 'rx-ordonnance-mpdf.html') {
                $filteredPath = apply_filters('sosprescription_rx_template_path', $usedPath, $name);
                if (is_string($filteredPath) && $filteredPath !== '' && $filteredPath !== $usedPath) {
                    if (self::fs_exists($fs, $filteredPath)) {
                        $usedPath = $filteredPath;
                        $usedSource = self::guess_path_source($filteredPath);
                    }
                }
            }

            $items[] = [
                'file' => $name,
                'used' => [
                    'source' => $usedSource,
                    'path' => $usedPath,
                    'exists' => self::fs_exists($fs, $usedPath),
                    'hash_sha256' => self::maybe_hash_sha256($fs, $usedPath),
                ],
                'plugin_default' => [
                    'path' => $pluginPath,
                    'exists' => self::fs_exists($fs, $pluginPath),
                    'hash_sha256' => self::maybe_hash_sha256($fs, $pluginPath),
                ],
                'upload_override' => [
                    'path' => $uploadPath,
                    'exists' => self::fs_exists($fs, $uploadPath),
                    'hash_sha256' => self::maybe_hash_sha256($fs, $uploadPath),
                ],
                'theme_override' => [
                    'exists' => ($themeOverridePath !== ''),
                    'path' => ($themeOverridePath !== '' ? $themeOverridePath : null),
                    'source' => ($themeOverridePath !== '' ? self::guess_path_source($themeOverridePath) : null),
                ],
            ];
        }

        usort($items, static function (array $a, array $b): int {
            return strcmp((string) ($a['file'] ?? ''), (string) ($b['file'] ?? ''));
        });

        return $items;
    }

    /**
     * Fallback templates audit if WP_Filesystem is not available.
     *
     * @return array<int, array<string, mixed>>
     */
    private static function audit_templates_fallback(): array
    {
        $templatesDir = trailingslashit(SOSPRESCRIPTION_PATH) . 'templates';
        $uploads = wp_upload_dir();
        $overrideDir = trailingslashit((string) ($uploads['basedir'] ?? '')) . 'sosprescription-templates';

        $items = [];
        if (!is_dir($templatesDir)) {
            return $items;
        }

        $names = @scandir($templatesDir);
        if (!is_array($names)) {
            return $items;
        }

        foreach ($names as $name) {
            if (!is_string($name) || $name === '.' || $name === '..' || !str_ends_with($name, '.html')) {
                continue;
            }

            $pluginPath = trailingslashit($templatesDir) . $name;
            $uploadPath = trailingslashit($overrideDir) . $name;
            $themeOverridePath = self::locate_theme_override($name);

            $usedPath = $pluginPath;
            $usedSource = 'plugin_default';

            if (file_exists($uploadPath)) {
                $usedPath = $uploadPath;
                $usedSource = 'upload_override';
            }

            if ($name === 'rx-ordonnance-mpdf.html') {
                $filteredPath = apply_filters('sosprescription_rx_template_path', $usedPath, $name);
                if (is_string($filteredPath) && $filteredPath !== '' && $filteredPath !== $usedPath && file_exists($filteredPath)) {
                    $usedPath = $filteredPath;
                    $usedSource = self::guess_path_source($filteredPath);
                }
            }

            $items[] = [
                'file' => $name,
                'used' => [
                    'source' => $usedSource,
                    'path' => $usedPath,
                    'exists' => file_exists($usedPath),
                    'hash_sha256' => (file_exists($usedPath) ? @hash_file('sha256', $usedPath) : null),
                ],
                'plugin_default' => [
                    'path' => $pluginPath,
                    'exists' => file_exists($pluginPath),
                    'hash_sha256' => (file_exists($pluginPath) ? @hash_file('sha256', $pluginPath) : null),
                ],
                'upload_override' => [
                    'path' => $uploadPath,
                    'exists' => file_exists($uploadPath),
                    'hash_sha256' => (file_exists($uploadPath) ? @hash_file('sha256', $uploadPath) : null),
                ],
                'theme_override' => [
                    'exists' => ($themeOverridePath !== ''),
                    'path' => ($themeOverridePath !== '' ? $themeOverridePath : null),
                    'source' => ($themeOverridePath !== '' ? self::guess_path_source($themeOverridePath) : null),
                ],
            ];
        }

        usort($items, static function (array $a, array $b): int {
            return strcmp((string) ($a['file'] ?? ''), (string) ($b['file'] ?? ''));
        });

        return $items;
    }

    /**
     * Locate a template in the active theme/child theme.
     */
    private static function locate_theme_override(string $fileName): string
    {
        $candidates = [
            'sosprescription/' . $fileName,
            'sosprescription/templates/' . $fileName,
            'templates/' . $fileName,
            $fileName,
        ];

        $found = locate_template($candidates, false, false);
        if (is_string($found) && $found !== '') {
            return $found;
        }

        return '';
    }

    /**
     * Guess which source a path comes from (theme parent/child/uploads).
     */
    private static function guess_path_source(string $path): string
    {
        $p = wp_normalize_path($path);
        $child = wp_normalize_path((string) get_stylesheet_directory());
        $parent = wp_normalize_path((string) get_template_directory());
        $uploads = wp_upload_dir();
        $uploadsBase = wp_normalize_path((string) ($uploads['basedir'] ?? ''));

        if ($child !== '' && str_starts_with($p, $child . '/')) {
            return 'theme_child_override';
        }
        if ($parent !== '' && str_starts_with($p, $parent . '/')) {
            return 'theme_parent_override';
        }
        if ($uploadsBase !== '' && str_starts_with($p, $uploadsBase . '/')) {
            return 'upload_override';
        }

        return 'filter_override';
    }

    private static function fs_exists(WP_Filesystem_Base $fs, string $path): bool
    {
        try {
            if ($fs->exists($path)) {
                return true;
            }
        } catch (\Throwable $e) {
            // Ignore.
        }

        return file_exists($path);
    }

    private static function maybe_hash_sha256(WP_Filesystem_Base $fs, string $path): ?string
    {
        if (!self::fs_exists($fs, $path)) {
            return null;
        }

        try {
            $contents = $fs->get_contents($path);
            if (is_string($contents) && $contents !== '') {
                return hash('sha256', $contents);
            }
        } catch (\Throwable $e) {
            // Ignore.
        }

        if (is_file($path)) {
            $hash = @hash_file('sha256', $path);
            if (is_string($hash) && $hash !== '') {
                return $hash;
            }
        }

        return null;
    }

    /**
     * Audit all WordPress options owned by SOSPrescription (prefix sosprescription_*).
     * Values are intentionally not exported to avoid leaking secrets/PII.
     *
     * @return array<string, mixed>
     */
    private static function audit_options(): array
    {
        global $wpdb;

        if (!isset($wpdb) || !($wpdb instanceof \wpdb)) {
            return [
                'ok' => false,
                'error' => 'wpdb_unavailable',
            ];
        }

        $defaults = self::option_defaults();

        $prefix = 'sosprescription_';
        $like = $wpdb->esc_like($prefix) . '%';

        $rows = $wpdb->get_results(
            $wpdb->prepare(
                "SELECT option_name, option_value, autoload FROM {$wpdb->options} WHERE option_name LIKE %s ORDER BY option_name ASC",
                $like
            ),
            ARRAY_A
        );

        if (!is_array($rows)) {
            return [
                'ok' => false,
                'error' => 'options_query_failed',
            ];
        }

        $items = [];
        $dirtyCount = 0;

        foreach ($rows as $row) {
            if (!is_array($row)) {
                continue;
            }

            $name = (string) ($row['option_name'] ?? '');
            if ($name === '') {
                continue;
            }

            $raw = (string) ($row['option_value'] ?? '');
            $autoload = (string) ($row['autoload'] ?? '');

            $current = maybe_unserialize($raw);
            $type = gettype($current);

            $defaultDefined = array_key_exists($name, $defaults);
            $default = $defaultDefined ? $defaults[$name] : null;
            $defaultType = $defaultDefined ? gettype($default) : null;

            $isDirty = $defaultDefined ? ($current != $default) : true; // phpcs:ignore WordPress.PHP.StrictComparisons.LooseComparison
            if ($isDirty) {
                $dirtyCount++;
            }

            $items[] = [
                'name' => $name,
                'autoload' => $autoload,
                'type' => $type,
                'value_size_bytes' => strlen($raw),
                'default_defined' => $defaultDefined,
                'default_type' => $defaultType,
                'is_dirty' => $isDirty,
                'is_sensitive' => self::is_sensitive_option_name($name),
            ];
        }

        return [
            'ok' => true,
            'count' => count($items),
            'dirty_count' => $dirtyCount,
            'items' => $items,
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private static function option_defaults(): array
    {
        return [
            'sosprescription_purge_on_uninstall' => 'no',
            'sosprescription_logs_retention_days' => 30,
            'sosprescription_logs_scopes' => '',
            'sosprescription_logs_bdpm_enabled' => '',
            'sosprescription_ocr_client_enabled' => '',
            'sosprescription_ocr_client_debug' => '',
            'sosprescription_ocr_client_keywords' => '',
        ];
    }

    private static function is_sensitive_option_name(string $optionName): bool
    {
        $n = strtolower($optionName);

        $keywords = [
            'secret',
            'token',
            'password',
            'apikey',
            'api_key',
            'private',
            'stripe',
            'turnstile',
            'captcha',
        ];

        foreach ($keywords as $k) {
            if (str_contains($n, $k)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Detect if third-party code hooks into the plugin's main filters.
     *
     * @return array<string, mixed>
     */
    private static function audit_hooks(): array
    {
        $hooks = [
            'sosprescription_rx_template_path',
            'sosprescription_storage_base_dir',
            'sosprescription_storage_dir',
            'sosprescription_storage_allowed_exts',
            'sosprescription_storage_max_bytes',
            'sosprescription_rate_limit_rules',
            'sosprescription_rate_limit_bypass',
            'sosprescription_log_retention_days',
            'sosprescription_logs_retention_days',
            'sosprescription_logger_is_sensitive_key',
            'sosprescription_logger_redact_value',
            'sosprescription_logger_redact_keys',
        ];

        $items = [];

        global $wp_filter;

        foreach ($hooks as $hook) {
            $has = has_filter($hook) ? true : false; // has_filter() returns bool when callback not provided.

            $count = 0;
            $priorities = [];

            if (isset($wp_filter[$hook]) && $wp_filter[$hook] instanceof \WP_Hook) {
                foreach ($wp_filter[$hook]->callbacks as $prio => $callbacks) {
                    if (!is_array($callbacks)) {
                        continue;
                    }
                    $priorities[] = (int) $prio;
                    $count += count($callbacks);
                }
            }

            sort($priorities);

            $items[] = [
                'hook' => $hook,
                'has_filter' => $has,
                'callbacks_count' => $count,
                'priorities' => $priorities,
            ];
        }

        return [
            'count' => count($items),
            'items' => $items,
        ];
    }

    /**
     * Validate routing bases and slugs for potential conflicts.
     *
     * @return array<string, mixed>
     */
    private static function audit_routing(): array
    {
        $items = [];

        // Reserved route base for /v/{token}.
        $reserved = 'v';
        $conflict = get_page_by_path($reserved);
        $items[] = [
            'slug' => $reserved,
            'type' => 'reserved_verification_route',
            'status' => ($conflict ? 'conflict' : 'ok'),
            'conflict_post_id' => ($conflict ? (int) $conflict->ID : null),
            'conflict_post_type' => ($conflict ? (string) $conflict->post_type : null),
            'conflict_post_status' => ($conflict ? (string) $conflict->post_status : null),
        ];

        // Check if our rewrite rule is present.
        $ruleKey = '^v/([A-Za-z0-9_-]{16,64})/?$';
        $rewriteRules = get_option('rewrite_rules', []);
        $hasRule = (is_array($rewriteRules) && array_key_exists($ruleKey, $rewriteRules));

        // Configured key pages (setup + notifications).
        $pagesOpt = get_option('sosprescription_pages', []);
        if (!is_array($pagesOpt)) {
            $pagesOpt = [];
        }

        $notif = NotificationsConfig::get();

        $configuredPages = [
            'form_page_id' => (int) ($pagesOpt['form_page_id'] ?? 0),
            'doctor_account_page_id' => (int) ($pagesOpt['doctor_account_page_id'] ?? 0),
            'bdpm_table_page_id' => (int) ($pagesOpt['bdpm_table_page_id'] ?? 0),
            'patient_portal_page_id' => (int) ($notif['patient_portal_page_id'] ?? 0),
            'doctor_console_page_id' => (int) ($notif['doctor_console_page_id'] ?? 0),
        ];

        $configuredPageIds = [
            $configuredPages['form_page_id'],
            $configuredPages['doctor_account_page_id'],
            $configuredPages['bdpm_table_page_id'],
            $configuredPages['patient_portal_page_id'],
            $configuredPages['doctor_console_page_id'],
        ];
        $configuredPageIds = array_values(array_filter($configuredPageIds));

        // Recommended slugs (must match SetupPage definition).
        $recommended = [
            [
                'key' => 'patient_request',
                'slug' => 'demande-ordonnance',
            ],
            [
                'key' => 'patient_portal',
                'slug' => 'espace-patient',
            ],
            [
                'key' => 'doctor_console',
                'slug' => 'console-medecin',
            ],
            [
                'key' => 'doctor_account',
                'slug' => 'medecin',
            ],
            [
                'key' => 'bdpm_table',
                'slug' => 'bdpm-table',
            ],
        ];

        foreach ($recommended as $r) {
            $slug = (string) ($r['slug'] ?? '');
            $key = (string) ($r['key'] ?? '');
            if ($slug === '') {
                continue;
            }

            $found = get_page_by_path($slug);
            $foundId = $found ? (int) $found->ID : 0;

            $status = 'missing';
            if ($foundId > 0) {
                $status = in_array($foundId, $configuredPageIds, true) ? 'ok' : 'mismatch';
            }

            $items[] = [
                'slug' => $slug,
                'type' => 'recommended_page',
                'key' => $key,
                'status' => $status,
                'post_id' => ($foundId > 0 ? $foundId : null),
                'post_status' => ($found ? (string) $found->post_status : null),
            ];
        }

        return [
            'rewrite' => [
                'verification_rule_key' => $ruleKey,
                'verification_rule_present' => $hasRule,
            ],
            'configured_pages' => $configuredPages,
            'slugs' => $items,
        ];
    }



    /**
     * Adds a human-friendly actionable advice message to each FAIL/WARN check.
     *
     * The goal is to keep the export JSON self-explanatory and to help admins fix issues
     * quickly on shared hosting environments.
     *
     * @param array<string,array<string,mixed>> $checks
     * @return array<string,array<string,mixed>>
     */
    private static function addActionableAdvice(array $checks): array
    {
        foreach ($checks as $key => $check) {
            if (!is_array($check)) {
                continue;
            }

            $status = strtolower((string) ($check['status'] ?? ''));
            if ($status === '' || $status === 'pass') {
                continue;
            }

            $advice = self::buildAdviceForCheck((string) $key, $check);
            if ($advice === '') {
                continue;
            }

            $checks[$key]['advice'] = $advice;

            // Optional: also surface advice inside details, so the current UI table (key/value)
            // can display it without further changes.
            if (!isset($checks[$key]['details']) || !is_array($checks[$key]['details'])) {
                $checks[$key]['details'] = [];
            }
            if (!isset($checks[$key]['details']['advice'])) {
                $checks[$key]['details']['advice'] = $advice;
            }
        }

        return $checks;
    }

    /**
     * @param array<string,mixed> $check
     */
    private static function buildAdviceForCheck(string $checkKey, array $check): string
    {
        $status = strtolower((string) ($check['status'] ?? ''));
        $details = is_array($check['details'] ?? null) ? (array) $check['details'] : [];

        switch ($checkKey) {
            case 'io_permissions':
                if ($status === 'fail') {
                    return (string) __(
                        'Veuillez appliquer les droits d\'écriture (chmod 755 ou 770) sur les dossiers listés en échec, puis réessayer.',
                        'sosprescription'
                    );
                }
                return (string) __(
                    'Vérifiez les permissions et/ou les restrictions de l\'hébergeur (open_basedir). Assurez-vous que WordPress peut écrire dans les dossiers listés.',
                    'sosprescription'
                );

            case 'dependencies':
                return (string) __(
                    'Le dossier /vendor semble incomplet (mPDF). Réinstallez le plugin (upload d\'un ZIP complet) pour restaurer les dépendances.',
                    'sosprescription'
                );

            case 'assets_integrity':
                return (string) __(
                    'Des assets OCR (Tesseract.js / langue FR) sont manquants. Réinstallez le plugin ou vérifiez que les fichiers du dossier assets/ sont bien présents.',
                    'sosprescription'
                );

            case 'runtime':
                $parts = [];

                $php = is_array($details['php'] ?? null) ? (array) $details['php'] : [];
                if (($php['ok'] ?? true) === false) {
                    $parts[] = (string) __(
                        'Votre version PHP est trop ancienne. Passez à PHP 7.4+ (recommandé 8.1+).',
                        'sosprescription'
                    );
                }

                $memory = is_array($details['memory_limit'] ?? null) ? (array) $details['memory_limit'] : [];
                if (($memory['ok'] ?? true) === false) {
                    $parts[] = (string) __(
                        'Augmentez la limite mémoire à 256M (wp-config.php, php.ini ou panneau d\'hébergement).',
                        'sosprescription'
                    );
                }

                $maxExec = is_array($details['max_execution_time'] ?? null) ? (array) $details['max_execution_time'] : [];
                if (($maxExec['ok'] ?? true) === false) {
                    $parts[] = (string) __(
                        'Augmentez max_execution_time à 60s+ pour éviter les timeouts lors des imports ou générations.',
                        'sosprescription'
                    );
                }

                return implode(' ', array_filter($parts));

            default:
                // Fallback (generic guidance)
                if ($status === 'fail') {
                    return (string) __(
                        'Ce contrôle est en échec. Corrigez les paramètres ou permissions indiqués dans le détail, puis relancez le diagnostic.',
                        'sosprescription'
                    );
                }
                if ($status === 'warn') {
                    return (string) __(
                        'Ce contrôle a détecté un avertissement. Une correction est recommandée pour éviter des incidents en production.',
                        'sosprescription'
                    );
                }
                return '';
        }
    }



    private static function worstStatus(string $a, string $b): string
    {
        $rank = [
            'pass' => 0,
            'warn' => 1,
            'fail' => 2,
        ];

        $ra = $rank[$a] ?? 2;
        $rb = $rank[$b] ?? 2;

        return ($rb > $ra) ? $b : $a;
    }
}
