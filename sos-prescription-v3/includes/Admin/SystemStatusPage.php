<?php
// includes/Admin/SystemStatusPage.php
declare(strict_types=1);

namespace SOSPrescription\Admin;

use SOSPrescription\Services\DiagnosticProvider;
use SOSPrescription\Services\Logger;
use SOSPrescription\Services\StorageCleaner;

final class SystemStatusPage
{
    public static function register_actions(): void
    {
        add_action('admin_post_sosprescription_export_system_report', [self::class, 'handle_export_system_report']);
    }

    public static function render_page(): void
    {
        self::render();
    }

    public static function render(): void
    {
        if (!current_user_can('manage_options')) {
            wp_die(esc_html__('Acces refuse.', 'sosprescription'));
        }

        $report = DiagnosticProvider::collect();
        $checks = isset($report['checks']) && is_array($report['checks']) ? $report['checks'] : [];
        $site = isset($report['site']) && is_array($report['site']) ? $report['site'] : [];
        $plugin = isset($report['plugin']) && is_array($report['plugin']) ? $report['plugin'] : [];
        $errors = isset($report['errors']) && is_array($report['errors']) ? $report['errors'] : [];
        $configAudit = isset($report['config_audit']) && is_array($report['config_audit']) ? $report['config_audit'] : [];
        $storage = method_exists(StorageCleaner::class, 'get_storage_snapshot') ? StorageCleaner::get_storage_snapshot() : [];
        $summary = self::compute_summary($checks);
        $exportUrl = wp_nonce_url(
            admin_url('admin-post.php?action=sosprescription_export_system_report'),
            'sosprescription_export_system_report'
        );

        $labels = [
            'filesystem' => __('Filesystem', 'sosprescription'),
            'io_permissions' => __('I/O & Permissions', 'sosprescription'),
            'assets' => __('Integrite des assets', 'sosprescription'),
            'ocr_assets' => __('Integrite des assets OCR', 'sosprescription'),
            'runtime' => __('Environnement runtime', 'sosprescription'),
            'dependencies' => __('Dependances', 'sosprescription'),
        ];

        ?>
        <div class="wrap sp-ui">
            <h1><?php echo esc_html__('SOS Prescription - Statut systeme', 'sosprescription'); ?></h1>

            <?php if (isset($_GET['sp_storage_cleanup'])) : ?>
                <div class="notice notice-success is-dismissible">
                    <p><?php echo esc_html__('Nettoyage du stockage declenche.', 'sosprescription'); ?></p>
                </div>
            <?php endif; ?>

            <div class="sp-card" style="max-width:1100px;">
                <h2 style="margin-top:0;"><?php echo esc_html__('Resume', 'sosprescription'); ?></h2>
                <p class="sp-muted" style="margin-top:0;">
                    <?php
                    echo esc_html(
                        sprintf(
                            __('Plugin %1$s | WordPress %2$s | PHP %3$s', 'sosprescription'),
                            (string) ($plugin['version'] ?? '—'),
                            (string) ($site['wp_version'] ?? '—'),
                            (string) ($site['php_version'] ?? PHP_VERSION)
                        )
                    );
                    ?>
                </p>

                <div style="display:flex;gap:10px;flex-wrap:wrap;">
                    <?php echo wp_kses_post(self::summary_badge('pass', (int) $summary['pass'])); ?>
                    <?php echo wp_kses_post(self::summary_badge('warn', (int) $summary['warn'])); ?>
                    <?php echo wp_kses_post(self::summary_badge('fail', (int) $summary['fail'])); ?>
                </div>

                <p style="margin-top:14px;">
                    <a class="button button-primary" href="<?php echo esc_url($exportUrl); ?>">
                        <?php echo esc_html__('Exporter le rapport JSON', 'sosprescription'); ?>
                    </a>
                </p>

                <?php if (!empty($errors)) : ?>
                    <div class="sp-alert sp-alert-warn" style="margin-top:10px;">
                        <strong><?php echo esc_html__('Erreurs internes (failsafe)', 'sosprescription'); ?></strong>
                        <ul style="margin:8px 0 0 18px;">
                            <?php foreach ($errors as $error) : ?>
                                <li><?php echo esc_html(self::format_error($error)); ?></li>
                            <?php endforeach; ?>
                        </ul>
                    </div>
                <?php endif; ?>
            </div>

            <?php foreach ($labels as $key => $label) : ?>
                <?php if (isset($checks[$key]) && is_array($checks[$key])) : ?>
                    <?php self::render_check_card($label, $checks[$key]); ?>
                <?php endif; ?>
            <?php endforeach; ?>

            <?php self::render_storage_card($storage); ?>
            <?php self::render_config_audit($configAudit); ?>

            <?php if (defined('SOSPRESCRIPTION_URL')) : ?>
                <div class="sp-card" style="max-width:1100px;margin-top:16px;">
                    <h2 style="margin-top:0;"><?php echo esc_html__('Matrice QA', 'sosprescription'); ?></h2>
                    <p class="sp-muted"><?php echo esc_html__('Checklist QA embarquee du plugin.', 'sosprescription'); ?></p>
                    <p>
                        <a class="button button-secondary" href="<?php echo esc_url((string) SOSPRESCRIPTION_URL . 'assets/qa-checklist.json'); ?>" target="_blank" rel="noopener">
                            <?php echo esc_html__('Ouvrir le JSON de checklist QA', 'sosprescription'); ?>
                        </a>
                    </p>
                </div>
            <?php endif; ?>
        </div>
        <?php
    }

    public static function handle_export_system_report(): void
    {
        if (!current_user_can('manage_options')) {
            status_header(403);
            wp_die(esc_html__('Acces refuse.', 'sosprescription'));
        }

        check_admin_referer('sosprescription_export_system_report');

        while (ob_get_level() > 0) {
            ob_end_clean();
        }

        $report = DiagnosticProvider::collect();

        if (method_exists(Logger::class, 'ndjson_scoped')) {
            try {
                Logger::ndjson_scoped('diagnostics', 'admin', 'info', 'system_report_export', [
                    'user_id' => (int) get_current_user_id(),
                ]);
            } catch (\Throwable $e) {
            }
        }

        $filename = 'sosprescription-system-report-' . gmdate('Ymd-His') . '.json';

        nocache_headers();
        header('Content-Type: application/json; charset=utf-8');
        header('Content-Disposition: attachment; filename=' . $filename);
        header('X-Content-Type-Options: nosniff');

        echo wp_json_encode($report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
        exit;
    }

    /**
     * @param array<string, mixed> $check
     */
    private static function render_check_card(string $title, array $check): void
    {
        $status = isset($check['status']) ? (string) $check['status'] : 'unknown';
        $details = self::extract_details($check);
        ?>
        <div class="sp-card" style="max-width:1100px;margin-top:14px;">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
                <h2 style="margin:0;"><?php echo esc_html($title); ?></h2>
                <div><?php echo wp_kses_post(self::status_badge($status)); ?></div>
            </div>

            <?php if (!empty($details)) : ?>
                <table class="widefat striped" style="margin-top:12px;">
                    <thead>
                        <tr>
                            <th style="width:260px;"><?php echo esc_html__('Cle', 'sosprescription'); ?></th>
                            <th><?php echo esc_html__('Valeur', 'sosprescription'); ?></th>
                        </tr>
                    </thead>
                    <tbody>
                        <?php foreach ($details as $key => $value) : ?>
                            <tr>
                                <td><code><?php echo esc_html((string) $key); ?></code></td>
                                <td><?php echo wp_kses_post(self::format_value($value)); ?></td>
                            </tr>
                        <?php endforeach; ?>
                    </tbody>
                </table>
            <?php else : ?>
                <p class="sp-muted" style="margin-top:10px;"><?php echo esc_html__('Aucun detail disponible.', 'sosprescription'); ?></p>
            <?php endif; ?>
        </div>
        <?php
    }

    /**
     * @param array<string, mixed> $storage
     */
    private static function render_storage_card(array $storage): void
    {
        $paths = isset($storage['paths']) && is_array($storage['paths']) ? $storage['paths'] : [];
        $counts = isset($storage['counts']) && is_array($storage['counts']) ? $storage['counts'] : [];
        $bytes = isset($storage['bytes']) && is_array($storage['bytes']) ? $storage['bytes'] : [];
        $last = $storage['last_cleanup'] ?? null;

        $baseDir = (string) ($paths['base_dir'] ?? $paths['base'] ?? '');
        $logsDir = (string) ($paths['logs_dir'] ?? '');
        $pdfCount = (int) ($counts['pdf_files'] ?? $counts['pdf'] ?? 0);
        $logCount = (int) ($counts['log_files'] ?? $counts['log'] ?? 0);
        $tmpCount = (int) ($counts['tmp_files'] ?? $counts['tmp'] ?? 0);
        $total = (int) ($counts['total_files'] ?? ($pdfCount + $logCount));
        $size = (int) ($bytes['total'] ?? 0);
        ?>
        <div class="sp-card" style="max-width:1100px;margin-top:16px;">
            <h2 style="margin-top:0;"><?php echo esc_html__('Hygiene du stockage', 'sosprescription'); ?></h2>
            <table class="widefat striped">
                <tbody>
                    <tr><th style="width:280px;"><?php echo esc_html__('Dossier racine', 'sosprescription'); ?></th><td><code><?php echo esc_html($baseDir !== '' ? $baseDir : '—'); ?></code></td></tr>
                    <tr><th><?php echo esc_html__('Dossier logs', 'sosprescription'); ?></th><td><code><?php echo esc_html($logsDir !== '' ? $logsDir : '—'); ?></code></td></tr>
                    <tr><th><?php echo esc_html__('Fichiers PDF', 'sosprescription'); ?></th><td><?php echo esc_html((string) $pdfCount); ?></td></tr>
                    <tr><th><?php echo esc_html__('Fichiers logs', 'sosprescription'); ?></th><td><?php echo esc_html((string) $logCount); ?></td></tr>
                    <tr><th><?php echo esc_html__('Fichiers temporaires', 'sosprescription'); ?></th><td><?php echo esc_html((string) $tmpCount); ?></td></tr>
                    <tr><th><?php echo esc_html__('Total fichiers comptes', 'sosprescription'); ?></th><td><?php echo esc_html((string) $total); ?></td></tr>
                    <tr><th><?php echo esc_html__('Espace total utilise', 'sosprescription'); ?></th><td><code><?php echo esc_html(size_format((float) $size)); ?></code></td></tr>
                    <tr><th><?php echo esc_html__('Dernier nettoyage', 'sosprescription'); ?></th><td><?php echo wp_kses_post(self::format_last_cleanup($last)); ?></td></tr>
                </tbody>
            </table>

            <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>" style="margin-top:12px;">
                <input type="hidden" name="action" value="sosprescription_storage_cleanup_now">
                <?php wp_nonce_field('sosprescription_storage_cleanup_now'); ?>
                <button class="button button-secondary" type="submit"><?php echo esc_html__('Forcer le nettoyage maintenant', 'sosprescription'); ?></button>
            </form>
        </div>
        <?php
    }

    /**
     * @param array<string, mixed> $config
     */
    private static function render_config_audit(array $config): void
    {
        if ($config === []) {
            return;
        }
        ?>
        <div class="sp-card" style="max-width:1100px;margin-top:16px;">
            <h2 style="margin-top:0;"><?php echo esc_html__('Audit de configuration', 'sosprescription'); ?></h2>
            <p class="sp-muted"><?php echo esc_html__('Vue brute et sure du rapport d audit de configuration.', 'sosprescription'); ?></p>
            <pre style="white-space:pre-wrap;overflow:auto;max-height:520px;margin:0;"><?php echo esc_html(wp_json_encode($config, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)); ?></pre>
        </div>
        <?php
    }

    /**
     * @param array<string, mixed> $checks
     * @return array{pass:int,warn:int,fail:int}
     */
    private static function compute_summary(array $checks): array
    {
        $summary = ['pass' => 0, 'warn' => 0, 'fail' => 0];

        foreach ($checks as $check) {
            if (!is_array($check)) {
                continue;
            }

            $status = strtolower((string) ($check['status'] ?? 'unknown'));
            if ($status === 'pass' || $status === 'good') {
                $summary['pass']++;
            } elseif ($status === 'warn' || $status === 'warning' || $status === 'recommended') {
                $summary['warn']++;
            } else {
                $summary['fail']++;
            }
        }

        return $summary;
    }

    /**
     * @param array<string, mixed> $check
     * @return array<string, mixed>
     */
    private static function extract_details(array $check): array
    {
        if (isset($check['details']) && is_array($check['details'])) {
            return $check['details'];
        }

        $details = [];
        foreach ($check as $key => $value) {
            if ($key === 'status') {
                continue;
            }
            $details[(string) $key] = $value;
        }

        return $details;
    }

    /**
     * @param mixed $value
     */
    private static function format_value($value): string
    {
        if (is_array($value) || is_object($value)) {
            return '<pre style="margin:0;white-space:pre-wrap;">' . esc_html(wp_json_encode($value, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)) . '</pre>';
        }

        if (is_bool($value)) {
            return $value ? 'true' : 'false';
        }

        if ($value === null) {
            return 'null';
        }

        return esc_html((string) $value);
    }

    /**
     * @param mixed $error
     */
    private static function format_error($error): string
    {
        if (is_array($error)) {
            $code = isset($error['code']) ? (string) $error['code'] : 'error';
            $message = isset($error['message']) ? (string) $error['message'] : wp_json_encode($error);
            return $code . ' - ' . $message;
        }

        return (string) $error;
    }

    /**
     * @param mixed $last
     */
    private static function format_last_cleanup($last): string
    {
        if (!is_array($last) || $last === []) {
            return esc_html__('Jamais execute', 'sosprescription');
        }

        $ok = isset($last['ok']) ? (bool) $last['ok'] : false;
        $trigger = isset($last['trigger']) ? (string) $last['trigger'] : 'manual';
        $endedAt = isset($last['ended_at']) ? (string) $last['ended_at'] : '—';
        $tmpDeleted = isset($last['deleted']['tmp_files']) ? (int) $last['deleted']['tmp_files'] : 0;
        $pdfDeleted = isset($last['deleted']['orphan_pdfs']) ? (int) $last['deleted']['orphan_pdfs'] : 0;
        $bytesFreed = isset($last['bytes_freed']) ? size_format((float) ((int) $last['bytes_freed'])) : '0 B';

        return esc_html(
            sprintf(
                __('%1$s | %2$s | %3$s | tmp:%4$d | pdf:%5$d | freed:%6$s', 'sosprescription'),
                $ok ? 'OK' : 'FAIL',
                $trigger,
                $endedAt,
                $tmpDeleted,
                $pdfDeleted,
                $bytesFreed
            )
        );
    }

    private static function status_badge(string $status): string
    {
        $normalized = strtolower($status);
        $color = '#64748b';
        $background = '#f1f5f9';

        if (in_array($normalized, ['pass', 'good'], true)) {
            $color = '#116a2a';
            $background = '#e7f7ed';
        } elseif (in_array($normalized, ['warn', 'warning', 'recommended'], true)) {
            $color = '#9a3412';
            $background = '#fff7ed';
        } elseif (in_array($normalized, ['fail', 'error', 'critical'], true)) {
            $color = '#991b1b';
            $background = '#fee2e2';
        }

        return sprintf(
            '<span class="sp-badge" style="background:%s;color:%s;">%s</span>',
            esc_attr($background),
            esc_attr($color),
            esc_html(strtoupper($normalized))
        );
    }

    private static function summary_badge(string $type, int $count): string
    {
        $labelMap = ['pass' => 'PASS', 'warn' => 'WARN', 'fail' => 'FAIL'];
        return self::status_badge($type) . ' <span class="sp-muted">' . esc_html($labelMap[$type] . ': ' . $count) . '</span>';
    }
}
