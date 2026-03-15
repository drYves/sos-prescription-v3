<?php

declare(strict_types=1);

namespace SosPrescription\Admin;

use SosPrescription\Services\DiagnosticProvider;
use SosPrescription\Services\Logger;
use SosPrescription\Services\StorageCleaner;

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
        if (! current_user_can('manage_options')) {
            wp_die(esc_html__('Acces refuse.', 'sosprescription'));
        }

        $report    = DiagnosticProvider::collect();
        $checks    = isset($report['checks']) && is_array($report['checks']) ? $report['checks'] : [];
        $site      = isset($report['site']) && is_array($report['site']) ? $report['site'] : [];
        $plugin    = isset($report['plugin']) && is_array($report['plugin']) ? $report['plugin'] : [];
        $errors    = isset($report['errors']) && is_array($report['errors']) ? $report['errors'] : [];
        $exportUrl = wp_nonce_url(
            admin_url('admin-post.php?action=sosprescription_export_system_report'),
            'sosprescription_export_system_report'
        );

        $summary = self::compute_summary($checks);
        $storage = StorageCleaner::get_storage_snapshot();

        ?>
        <div class="wrap sp-ui">
            <h1><?php echo esc_html__('SOS Prescription - Statut Systeme', 'sosprescription'); ?></h1>

            <?php if (isset($_GET['sp_storage_cleaned'])) : ?>
                <div class="notice notice-success is-dismissible">
                    <p>
                        <?php echo esc_html__('Nettoyage du stockage declenche. Consultez la section "Hygiene du stockage" pour le resultat.', 'sosprescription'); ?>
                    </p>
                </div>
            <?php endif; ?>

            <div class="sp-card" style="max-width: 1100px;">
                <h2 style="margin-top:0;"><?php echo esc_html__('Resume', 'sosprescription'); ?></h2>
                <p class="sp-muted" style="margin-top:0;">
                    <?php
                    echo esc_html(
                        sprintf(
                            /* translators: 1: plugin version 2: wordpress version 3: php version */
                            __('Plugin %1$s | WordPress %2$s | PHP %3$s', 'sosprescription'),
                            (string) ($plugin['version'] ?? ''),
                            (string) ($site['wp_version'] ?? ''),
                            (string) ($site['php_version'] ?? '')
                        )
                    );
                    ?>
                </p>

                <div style="display:flex; gap:10px; flex-wrap:wrap;">
                    <div class="sp-badge" style="background:#e7f7ed; color:#116a2a;"><?php echo esc_html(sprintf(__('PASS: %d', 'sosprescription'), (int) $summary['pass'])); ?></div>
                    <div class="sp-badge" style="background:#fff7ed; color:#9a3412;"><?php echo esc_html(sprintf(__('WARN: %d', 'sosprescription'), (int) $summary['warn'])); ?></div>
                    <div class="sp-badge" style="background:#fee2e2; color:#991b1b;"><?php echo esc_html(sprintf(__('FAIL: %d', 'sosprescription'), (int) $summary['fail'])); ?></div>
                </div>

                <p style="margin-top: 14px;">
                    <a class="button button-primary" href="<?php echo esc_url($exportUrl); ?>">
                        <?php echo esc_html__('Exporter le rapport JSON', 'sosprescription'); ?>
                    </a>
                </p>

                <?php if (! empty($errors)) : ?>
                    <div class="sp-alert sp-alert-warn" style="margin-top: 10px;">
                        <strong><?php echo esc_html__('Erreurs internes (failsafe)', 'sosprescription'); ?></strong>
                        <ul style="margin: 8px 0 0 18px;">
                            <?php foreach ($errors as $err) : ?>
                                <li><code><?php echo esc_html((string) $err); ?></code></li>
                            <?php endforeach; ?>
                        </ul>
                    </div>
                <?php endif; ?>
            </div>

            <?php self::render_checks_table(__('I/O & Permissions', 'sosprescription'), $checks['io_permissions'] ?? []); ?>
            <?php self::render_checks_table(__('Integrite des assets OCR', 'sosprescription'), $checks['ocr_assets'] ?? []); ?>
            <?php self::render_checks_table(__('Environnement runtime', 'sosprescription'), $checks['runtime'] ?? []); ?>
            <?php self::render_checks_table(__('Dependances', 'sosprescription'), $checks['dependencies'] ?? []); ?>

            <?php
            $config_audit = isset($report['config_audit']) && is_array($report['config_audit']) ? $report['config_audit'] : [];
            self::render_config_audit($config_audit);

            $qa_url = SOSPRESCRIPTION_URL . 'assets/qa-checklist.json';
            echo '<h2>' . esc_html__('Matrice de tests QA (v1.9.1)', 'sosprescription') . '</h2>';
            echo '<p class="description">' . esc_html__('Checklist QA embarquee (JSON) avec les tests critiques patient / medecin / pharmacien / admin / systeme.', 'sosprescription') . '</p>';
            echo '<p><a class="button button-secondary" href="' . esc_url($qa_url) . '" target="_blank" rel="noopener">' . esc_html__('Ouvrir la matrice de tests QA (JSON)', 'sosprescription') . '</a></p>';
            ?>

            <div class="sp-card" style="max-width: 1100px; margin-top: 16px;">
                <h2 style="margin-top:0;"><?php echo esc_html__('Hygiene du stockage', 'sosprescription'); ?></h2>

                <table class="widefat striped" style="max-width: 1100px;">
                    <tbody>
                        <tr>
                            <th style="width: 280px;"><?php echo esc_html__('Dossier racine', 'sosprescription'); ?></th>
                            <td><code><?php echo esc_html((string) ($storage['paths']['base'] ?? '')); ?></code></td>
                        </tr>
                        <tr>
                            <th><?php echo esc_html__('Fichiers PDF', 'sosprescription'); ?></th>
                            <td><?php echo esc_html((string) (int) ($storage['counts']['pdf'] ?? 0)); ?></td>
                        </tr>
                        <tr>
                            <th><?php echo esc_html__('Fichiers Logs', 'sosprescription'); ?></th>
                            <td><?php echo esc_html((string) (int) ($storage['counts']['log'] ?? 0)); ?></td>
                        </tr>
                        <tr>
                            <th><?php echo esc_html__('Fichiers temporaires', 'sosprescription'); ?></th>
                            <td><?php echo esc_html((string) (int) ($storage['counts']['tmp'] ?? 0)); ?></td>
                        </tr>
                        <tr>
                            <th><?php echo esc_html__('Espace total utilise', 'sosprescription'); ?></th>
                            <td><code><?php echo esc_html((string) ($storage['human']['total'] ?? '')); ?></code></td>
                        </tr>
                        <tr>
                            <th><?php echo esc_html__('Dernier nettoyage', 'sosprescription'); ?></th>
                            <td>
                                <?php
                                $last = $storage['last_cleanup'] ?? [];
                                if (!is_array($last) || empty($last)) {
                                    echo esc_html__('Jamais execute', 'sosprescription');
                                } else {
                                    $ok = isset($last['ok']) ? (bool) $last['ok'] : false;
                                    $runAt = isset($last['ended_at']) ? (string) $last['ended_at'] : '';
                                    $trigger = isset($last['trigger']) ? (string) $last['trigger'] : '';
                                    $tmpDeleted = isset($last['deleted']['tmp_files']) ? (int) $last['deleted']['tmp_files'] : 0;
                                    $pdfDeleted = isset($last['deleted']['orphan_pdfs']) ? (int) $last['deleted']['orphan_pdfs'] : 0;
                                    $freed = isset($last['human_bytes_freed']) ? (string) $last['human_bytes_freed'] : '';

                                    echo esc_html(
                                        sprintf(
                                            /* translators: 1: ok/fail 2: trigger 3: date 4: tmp count 5: pdf count 6: bytes */
                                            __('%1$s | %2$s | %3$s | tmp:%4$d | pdf:%5$d | freed:%6$s', 'sosprescription'),
                                            $ok ? 'OK' : 'FAIL',
                                            $trigger,
                                            $runAt,
                                            $tmpDeleted,
                                            $pdfDeleted,
                                            $freed
                                        )
                                    );
                                }
                                ?>
                            </td>
                        </tr>
                    </tbody>
                </table>

                <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>" style="margin-top: 12px;">
                    <input type="hidden" name="action" value="sosprescription_storage_cleanup_now">
                    <?php wp_nonce_field('sosprescription_storage_cleanup_now'); ?>
                    <button class="button button-secondary" type="submit">
                        <?php echo esc_html__('Forcer le nettoyage maintenant', 'sosprescription'); ?>
                    </button>
                </form>

                <p class="sp-muted" style="margin: 10px 0 0 0;">
                    <?php echo esc_html__('Le nettoyage automatique est planifie 1 fois par jour (WP-Cron). Les suppressions sont journalisees en NDJSON (scope: system).', 'sosprescription'); ?>
                </p>
            </div>

            <p class="sp-muted" style="max-width: 1100px;">
                <?php echo esc_html__('Astuce support : joignez le rapport JSON a votre ticket. Il ne contient pas de donnees patient.', 'sosprescription'); ?>
            </p>
        </div>
        <?php
    }



    /**
     * @param array<string, mixed> $config
     */
    private static function render_config_audit(array $config): void
    {
        $templates = isset($config['templates']) && is_array($config['templates']) ? $config['templates'] : [];
        $options   = isset($config['options']) && is_array($config['options']) ? $config['options'] : [];
        $hooks     = isset($config['hooks']) && is_array($config['hooks']) ? $config['hooks'] : [];
        $routing   = isset($config['routing']) && is_array($config['routing']) ? $config['routing'] : [];

        $dirty_options = isset($options['dirty_count']) ? (int) $options['dirty_count'] : 0;
        $total_options = isset($options['count']) ? (int) $options['count'] : 0;

        $hook_items = isset($hooks['items']) && is_array($hooks['items']) ? $hooks['items'] : [];
        $hook_filtered = [];
        foreach ($hook_items as $item) {
            if (is_array($item) && !empty($item['has_filter'])) {
                $hook_filtered[] = (string) ($item['hook'] ?? '');
            }
        }

        $routing_conflicts = isset($routing['conflicts']) && is_array($routing['conflicts']) ? $routing['conflicts'] : [];
        $rewrite = isset($routing['rewrite_rules']) && is_array($routing['rewrite_rules']) ? $routing['rewrite_rules'] : [];
        $verification_rule_present = isset($rewrite['verification_rule_present']) ? (bool) $rewrite['verification_rule_present'] : false;

        ?>
        <div class="sp-card" style="max-width: 1100px; margin-top: 16px;">
            <h2 style="margin-top:0;">
                <?php echo esc_html__('Audit de configuration', 'sosprescription'); ?>
            </h2>

            <p class="sp-muted" style="margin-top:0;">
                <?php echo esc_html__('Ce bloc aide a detecter les overrides de templates, les options modifiees et les conflits potentiels (themes/plugins).', 'sosprescription'); ?>
            </p>

            <h3><?php echo esc_html__('Templates & Overrides', 'sosprescription'); ?></h3>

            <?php if (empty($templates)) : ?>
                <p class="sp-muted"><?php echo esc_html__('Aucun template detecte.', 'sosprescription'); ?></p>
            <?php else : ?>
                <table class="widefat striped" style="max-width: 1100px;">
                    <thead>
                        <tr>
                            <th><?php echo esc_html__('Fichier', 'sosprescription'); ?></th>
                            <th style="width: 160px;"><?php echo esc_html__('Source utilisee', 'sosprescription'); ?></th>
                            <th style="width: 120px;"><?php echo esc_html__('Override theme', 'sosprescription'); ?></th>
                            <th style="width: 130px;"><?php echo esc_html__('Override uploads', 'sosprescription'); ?></th>
                            <th><?php echo esc_html__('Chemin utilise', 'sosprescription'); ?></th>
                        </tr>
                    </thead>
                    <tbody>
                    <?php foreach ($templates as $tpl) :
                        if (!is_array($tpl)) { continue; }
                        $file = (string) ($tpl['file'] ?? '');
                        $used = isset($tpl['used']) && is_array($tpl['used']) ? $tpl['used'] : [];
                        $used_source = (string) ($used['source'] ?? '');
                        $used_path = (string) ($used['path'] ?? '');

                        $theme = isset($tpl['theme_override']) && is_array($tpl['theme_override']) ? $tpl['theme_override'] : [];
                        $theme_exists = !empty($theme['exists']);

                        $uploads = isset($tpl['upload_override']) && is_array($tpl['upload_override']) ? $tpl['upload_override'] : [];
                        $uploads_exists = !empty($uploads['exists']);
                        ?>
                        <tr>
                            <td><code><?php echo esc_html($file); ?></code></td>
                            <td><code><?php echo esc_html($used_source); ?></code></td>
                            <td>
                                <?php echo $theme_exists ? '<span class="sp-badge" style="background:#fff7ed; color:#9a3412;">OK</span>' : '<span class="sp-muted">-</span>'; ?>
                            </td>
                            <td>
                                <?php echo $uploads_exists ? '<span class="sp-badge" style="background:#e7f7ed; color:#116a2a;">OK</span>' : '<span class="sp-muted">-</span>'; ?>
                            </td>
                            <td style="word-break:break-all;"><code><?php echo esc_html($used_path); ?></code></td>
                        </tr>
                    <?php endforeach; ?>
                    </tbody>
                </table>
            <?php endif; ?>

            <h3 style="margin-top: 18px;">
                <?php echo esc_html__('Options (sosprescription_*)', 'sosprescription'); ?>
            </h3>

            <p class="sp-muted" style="margin-top: 0;">
                <?php
                echo esc_html(
                    sprintf(
                        /* translators: 1: dirty options 2: total options */
                        __('%1$d options modifiees / %2$d detectees.', 'sosprescription'),
                        $dirty_options,
                        $total_options
                    )
                );
                ?>
            </p>

            <?php
            $opt_items = isset($options['items']) && is_array($options['items']) ? $options['items'] : [];
            $dirty_list = [];
            foreach ($opt_items as $opt) {
                if (!is_array($opt) || empty($opt['is_dirty'])) {
                    continue;
                }
                $dirty_list[] = (string) ($opt['name'] ?? '');
            }
            ?>

            <?php if (!empty($dirty_list)) : ?>
                <details>
                    <summary><?php echo esc_html__('Voir les options modifiees', 'sosprescription'); ?></summary>
                    <ul style="margin: 10px 0 0 18px;">
                        <?php foreach ($dirty_list as $opt_name) : ?>
                            <li><code><?php echo esc_html($opt_name); ?></code></li>
                        <?php endforeach; ?>
                    </ul>
                </details>
            <?php endif; ?>

            <h3 style="margin-top: 18px;">
                <?php echo esc_html__('Hooks/Filters (interferences tierces)', 'sosprescription'); ?>
            </h3>

            <?php if (empty($hook_items)) : ?>
                <p class="sp-muted"><?php echo esc_html__('Aucun hook audite.', 'sosprescription'); ?></p>
            <?php else : ?>
                <table class="widefat striped" style="max-width: 1100px;">
                    <thead>
                        <tr>
                            <th><?php echo esc_html__('Hook', 'sosprescription'); ?></th>
                            <th style="width: 130px;"><?php echo esc_html__('Filtre actif', 'sosprescription'); ?></th>
                            <th style="width: 140px;"><?php echo esc_html__('Callbacks', 'sosprescription'); ?></th>
                        </tr>
                    </thead>
                    <tbody>
                    <?php foreach ($hook_items as $item) :
                        if (!is_array($item)) { continue; }
                        $hook = (string) ($item['hook'] ?? '');
                        $has = !empty($item['has_filter']);
                        $count = isset($item['callbacks_count']) ? (int) $item['callbacks_count'] : 0;
                        ?>
                        <tr>
                            <td><code><?php echo esc_html($hook); ?></code></td>
                            <td>
                                <?php echo $has ? '<span class="sp-badge" style="background:#fff7ed; color:#9a3412;">YES</span>' : '<span class="sp-muted">no</span>'; ?>
                            </td>
                            <td><?php echo esc_html((string) $count); ?></td>
                        </tr>
                    <?php endforeach; ?>
                    </tbody>
                </table>
            <?php endif; ?>

            <h3 style="margin-top: 18px;">
                <?php echo esc_html__('Routing & Slugs', 'sosprescription'); ?>
            </h3>

            <ul style="margin: 8px 0 0 18px;">
                <li>
                    <?php
                    echo esc_html(
                        sprintf(
                            /* translators: 1: yes/no */
                            __('Rewrite /v/{token} present: %1$s', 'sosprescription'),
                            $verification_rule_present ? 'yes' : 'no'
                        )
                    );
                    ?>
                </li>
            </ul>

            <?php if (!empty($routing_conflicts)) : ?>
                <div class="sp-alert sp-alert-warn" style="margin-top: 10px;">
                    <strong><?php echo esc_html__('Conflits detectes', 'sosprescription'); ?></strong>
                    <ul style="margin: 8px 0 0 18px;">
                        <?php foreach ($routing_conflicts as $c) :
                            if (!is_array($c)) { continue; }
                            $type = (string) ($c['type'] ?? '');
                            $slug = (string) ($c['slug'] ?? '');
                            $msg  = (string) ($c['message'] ?? '');
                            ?>
                            <li><code><?php echo esc_html($type . ' ' . $slug); ?></code> - <?php echo esc_html($msg); ?></li>
                        <?php endforeach; ?>
                    </ul>
                </div>
            <?php endif; ?>

            <p class="sp-muted" style="margin: 10px 0 0 0;">
                <?php echo esc_html__('En cas de doute, exportez le JSON et joignez-le a votre ticket de support.', 'sosprescription'); ?>
            </p>
        </div>
        <?php
    }

    public static function handle_export_system_report(): void
    {
        if (! current_user_can('manage_options')) {
            status_header(403);
            wp_die(esc_html__('Acces refuse.', 'sosprescription'));
        }

        check_admin_referer('sosprescription_export_system_report');

        // Clean any unexpected output buffers (notices, HTML, BOM) before JSON download.
        while (ob_get_level()) {
            ob_end_clean();
        }

        $report = DiagnosticProvider::collect();

        // Best-effort structured log (never fail export if logging fails).
        try {
            Logger::ndjson_scoped('diagnostics', 'admin', 'INFO', 'system_report_export', [
                'user_id' => get_current_user_id(),
            ]);
        } catch (\Throwable $e) {
            // no-op
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
     * @param array $check
     */
    private static function render_checks_table(string $title, array $check): void
    {
        $status  = isset($check['status']) ? (string) $check['status'] : 'unknown';
        $details = isset($check['details']) && is_array($check['details']) ? $check['details'] : [];

        ?>
        <div class="sp-card" style="max-width: 1100px; margin-top: 14px;">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
                <h2 style="margin:0;"><?php echo esc_html($title); ?></h2>
                <div><?php echo wp_kses_post(self::status_badge($status)); ?></div>
            </div>

            <?php if (! empty($details)) : ?>
                <table class="widefat striped" style="margin-top: 12px;">
                    <thead>
                        <tr>
                            <th><?php echo esc_html__('Cle', 'sosprescription'); ?></th>
                            <th><?php echo esc_html__('Valeur', 'sosprescription'); ?></th>
                        </tr>
                    </thead>
                    <tbody>
                        <?php foreach ($details as $k => $v) : ?>
                            <tr>
                                <td style="width: 260px;"><code><?php echo esc_html((string) $k); ?></code></td>
                                <td><?php echo wp_kses_post(self::format_detail_value($v)); ?></td>
                            </tr>
                        <?php endforeach; ?>
                    </tbody>
                </table>
            <?php else : ?>
                <p class="sp-muted" style="margin-top: 10px;">
                    <?php echo esc_html__('Aucun detail disponible.', 'sosprescription'); ?>
                </p>
            <?php endif; ?>
        </div>
        <?php
    }

    /**
     * @param mixed $value
     */
    private static function format_detail_value($value): string
    {
        if (is_array($value) || is_object($value)) {
            return '<pre style="margin:0; white-space:pre-wrap;">' . esc_html(wp_json_encode($value, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)) . '</pre>';
        }

        if (is_bool($value)) {
            return $value ? 'true' : 'false';
        }

        return esc_html((string) $value);
    }

    private static function status_badge(string $status): string
    {
        $status = strtolower($status);

        switch ($status) {
            case 'pass':
                return '<span class="sp-badge" style="background:#e7f7ed; color:#116a2a;">PASS</span>';
            case 'warn':
                return '<span class="sp-badge" style="background:#fff7ed; color:#9a3412;">WARN</span>';
            case 'fail':
                return '<span class="sp-badge" style="background:#fee2e2; color:#991b1b;">FAIL</span>';
            default:
                return '<span class="sp-badge" style="background:#e5e7eb; color:#111827;">' . esc_html(strtoupper($status)) . '</span>';
        }
    }

    /**
     * @param array $checks
     * @return array{pass:int, warn:int, fail:int}
     */
    private static function compute_summary(array $checks): array
    {
        $out = [
            'pass' => 0,
            'warn' => 0,
            'fail' => 0,
        ];

        foreach ($checks as $check) {
            if (! is_array($check)) {
                continue;
            }
            $status = isset($check['status']) ? strtolower((string) $check['status']) : '';
            if (isset($out[$status])) {
                $out[$status]++;
            }
        }

        return $out;
    }
}
