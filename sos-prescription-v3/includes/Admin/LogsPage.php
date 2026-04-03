<?php
declare(strict_types=1);

namespace SosPrescription\Admin;

use SosPrescription\Services\Logger;

final class LogsPage
{
    private const OPTION_ENABLED = 'sosprescription_logs_enabled';
    private const OPTION_SCOPES = 'sosprescription_logs_scopes';
    private const PAGE_SLUG = 'sosprescription-logs';

    /**
     * @return array<string, string>
     */
    private static function known_scopes(): array
    {
        return [
            'sosprescription_form' => 'sosprescription_form',
            'sosprescription_admin' => 'sosprescription_admin',
            'sosprescription_patient' => 'sosprescription_patient',
            'sosprescription_doctor_account' => 'sosprescription_doctor_account',
            'sosprescription_bdpm_table' => 'sosprescription_bdpm_table',
            'sosprescription_rxpdf' => 'sosprescription_rxpdf',
            'rest_errors' => 'rest_errors',
            'rest_perm' => 'rest_perm',
            'system' => 'system',
            'gp_theme' => 'gp_theme',
            'php_debug' => 'php_debug',
        ];
    }

    public static function register_actions(): void
    {
        add_action('admin_post_sosprescription_logs_save', [self::class, 'handle_save']);
        add_action('admin_post_sosprescription_logs_download', [self::class, 'handle_download']);
        add_action('admin_post_sosprescription_logs_download_zip', [self::class, 'handle_download_zip']);
        add_action('admin_post_sosprescription_logs_truncate_all', [self::class, 'handle_truncate_all']);
    }

    public static function render_page(): void
    {
        self::assert_permissions();

        $enabled = get_option(self::OPTION_ENABLED, '0') === '1';
        $scopes = self::current_scope_map();
        $logDir = self::logs_dir();
        $files = self::scan_log_files();

        $saveUrl = admin_url('admin-post.php');
        $zipUrl = wp_nonce_url(
            add_query_arg(['action' => 'sosprescription_logs_download_zip'], admin_url('admin-post.php')),
            'sosprescription_logs_download_zip'
        );

        echo '<div class="wrap">';
        echo '<h1>Logs SOS Prescription</h1>';
        echo '<p>Centre de pilotage des logs : activation globale, filtres de scope, téléchargement des fichiers et purge complète du dossier.</p>';

        if (isset($_GET['updated']) && (string) $_GET['updated'] === '1') {
            echo '<div class="notice notice-success is-dismissible"><p>Paramètres des logs enregistrés.</p></div>';
        }
        if (isset($_GET['cleared']) && (string) $_GET['cleared'] === '1') {
            echo '<div class="notice notice-success is-dismissible"><p>Tous les logs ont été vidés.</p></div>';
        }

        echo '<div style="display:grid;grid-template-columns:minmax(320px,420px) 1fr;gap:20px;align-items:start;max-width:1400px;">';

        echo '<div class="postbox" style="padding:16px;">';
        echo '<h2 style="margin-top:0;">Paramètres</h2>';
        echo '<form method="post" action="' . esc_url($saveUrl) . '">';
        echo '<input type="hidden" name="action" value="sosprescription_logs_save" />';
        wp_nonce_field('sosprescription_logs_save');

        echo '<p><label style="display:flex;align-items:center;gap:10px;font-weight:600;">';
        echo '<input type="checkbox" name="logs_enabled" value="1" ' . checked($enabled, true, false) . ' />';
        echo '<span>Activer / désactiver les logs globalement (<code>sosprescription_logs_enabled</code>)</span>';
        echo '</label></p>';

        echo '<div style="margin-top:16px;">';
        echo '<div style="font-weight:600;margin-bottom:8px;">Scopes filtrables</div>';
        foreach (self::known_scopes() as $scope => $label) {
            $checked = isset($scopes[$scope]) && $scopes[$scope] === '1';
            echo '<label style="display:flex;align-items:center;gap:10px;margin:6px 0;">';
            echo '<input type="checkbox" name="scopes[' . esc_attr($scope) . ']" value="1" ' . checked($checked, true, false) . ' />';
            echo '<span><code>' . esc_html($label) . '</code></span>';
            echo '</label>';
        }
        echo '</div>';

        echo '<p style="margin-top:16px;">';
        echo '<button type="submit" class="button button-primary">Sauvegarder les paramètres</button>';
        echo '</p>';
        echo '</form>';
        echo '</div>';

        echo '<div class="postbox" style="padding:16px;">';
        echo '<h2 style="margin-top:0;">Fichiers disponibles</h2>';
        echo '<p><strong>Dossier scanné :</strong> <code>' . esc_html($logDir) . '</code></p>';

        echo '<div style="display:flex;gap:10px;flex-wrap:wrap;margin:12px 0 16px;">';
        echo '<a class="button button-primary" href="' . esc_url($zipUrl) . '">Télécharger tout (ZIP)</a>';
        echo '<form method="post" action="' . esc_url($saveUrl) . '" style="margin:0;">';
        echo '<input type="hidden" name="action" value="sosprescription_logs_truncate_all" />';
        wp_nonce_field('sosprescription_logs_truncate_all');
        echo '<button type="submit" class="button" onclick="return confirm(\'Vider tous les logs ?\');">Vider tous les logs</button>';
        echo '</form>';
        echo '</div>';

        if ($files === []) {
            echo '<div class="notice notice-warning" style="margin:0;"><p>Aucun fichier trouvé dans <code>wp-content/uploads/sosprescription-logs/</code>.</p></div>';
        } else {
            echo '<table class="widefat striped">';
            echo '<thead><tr>';
            echo '<th style="width:120px;">Canal</th>';
            echo '<th>Fichier</th>';
            echo '<th style="width:120px;">Taille</th>';
            echo '<th style="width:180px;">Date de MàJ</th>';
            echo '<th style="width:180px;">Actions</th>';
            echo '</tr></thead>';
            echo '<tbody>';
            foreach ($files as $file) {
                $downloadUrl = wp_nonce_url(
                    add_query_arg([
                        'action' => 'sosprescription_logs_download',
                        'file' => rawurlencode($file['basename']),
                    ], admin_url('admin-post.php')),
                    'sosprescription_logs_download'
                );

                echo '<tr>';
                echo '<td><code>' . esc_html($file['channel']) . '</code></td>';
                echo '<td><code>' . esc_html($file['basename']) . '</code></td>';
                echo '<td>' . esc_html(size_format((int) $file['size'])) . '</td>';
                echo '<td>' . esc_html($file['modified']) . '</td>';
                echo '<td><a class="button" href="' . esc_url($downloadUrl) . '">Télécharger</a></td>';
                echo '</tr>';
            }
            echo '</tbody>';
            echo '</table>';
        }

        echo '</div>';
        echo '</div>';
        echo '</div>';
    }

    public static function handle_save(): void
    {
        self::assert_permissions();
        check_admin_referer('sosprescription_logs_save');

        $enabled = isset($_POST['logs_enabled']) && (string) $_POST['logs_enabled'] === '1';
        update_option(self::OPTION_ENABLED, $enabled ? '1' : '0', false);

        $submittedScopes = isset($_POST['scopes']) && is_array($_POST['scopes']) ? $_POST['scopes'] : [];
        $cleanScopes = [];
        foreach (self::known_scopes() as $scope => $_label) {
            $cleanScopes[$scope] = (isset($submittedScopes[$scope]) && (string) $submittedScopes[$scope] === '1') ? '1' : '0';
        }
        update_option(self::OPTION_SCOPES, $cleanScopes, false);

        self::redirect(['updated' => '1']);
    }

    public static function handle_download(): void
    {
        self::assert_permissions();
        check_admin_referer('sosprescription_logs_download');

        $basename = isset($_GET['file']) ? rawurldecode((string) $_GET['file']) : '';
        $path = Logger::validate_log_file($basename);
        if ($path === null || !is_file($path) || !is_readable($path)) {
            wp_die('Fichier de log introuvable ou illisible.');
        }

        nocache_headers();
        header('Content-Type: text/plain; charset=utf-8');
        header('Content-Length: ' . (string) filesize($path));
        header('Content-Disposition: attachment; filename="' . rawurlencode(basename($path)) . '"');
        readfile($path);
        exit;
    }

    public static function handle_download_zip(): void
    {
        self::assert_permissions();
        check_admin_referer('sosprescription_logs_download_zip');

        $files = self::scan_log_files();
        if ($files === []) {
            wp_die('Aucun fichier de log à archiver.');
        }

        if (!class_exists('ZipArchive')) {
            wp_die('L’extension ZipArchive est indisponible sur ce serveur.');
        }

        $tmp = wp_tempnam('sosprescription-logs.zip');
        if (!is_string($tmp) || $tmp === '') {
            wp_die('Impossible de créer le fichier temporaire ZIP.');
        }

        $zip = new \ZipArchive();
        $opened = $zip->open($tmp, \ZipArchive::CREATE | \ZipArchive::OVERWRITE);
        if ($opened !== true) {
            @unlink($tmp);
            wp_die('Impossible de générer l’archive ZIP des logs.');
        }

        foreach ($files as $file) {
            $fullPath = $file['path'];
            if (!is_string($fullPath) || $fullPath === '' || !is_file($fullPath)) {
                continue;
            }
            $zip->addFile($fullPath, $file['basename']);
        }
        $zip->close();

        nocache_headers();
        header('Content-Type: application/zip');
        header('Content-Length: ' . (string) filesize($tmp));
        header('Content-Disposition: attachment; filename="sosprescription-logs-' . gmdate('Ymd-His') . '.zip"');
        readfile($tmp);
        @unlink($tmp);
        exit;
    }

    public static function handle_truncate_all(): void
    {
        self::assert_permissions();
        check_admin_referer('sosprescription_logs_truncate_all');

        $files = self::scan_log_files();
        foreach ($files as $file) {
            $fullPath = $file['path'];
            if (!is_string($fullPath) || $fullPath === '' || !is_file($fullPath) || !is_writable($fullPath)) {
                continue;
            }
            @file_put_contents($fullPath, '', LOCK_EX);
        }

        self::redirect(['cleared' => '1']);
    }

    private static function assert_permissions(): void
    {
        if (!current_user_can('sosprescription_manage') && !current_user_can('manage_options')) {
            wp_die('Accès refusé.');
        }
    }

    /**
     * @return array<string, string>
     */
    private static function current_scope_map(): array
    {
        $raw = get_option(self::OPTION_SCOPES, false);
        $out = [];
        foreach (self::known_scopes() as $scope => $_label) {
            if ($raw === false) {
                $out[$scope] = '1';
                continue;
            }
            $out[$scope] = (is_array($raw) && isset($raw[$scope]) && ((string) $raw[$scope] === '1' || $raw[$scope] === true)) ? '1' : '0';
        }

        return $out;
    }

    private static function logs_dir(): string
    {
        $uploads = wp_upload_dir();
        return rtrim((string) ($uploads['basedir'] ?? ''), '/\\') . '/sosprescription-logs';
    }

    /**
     * @return array<int, array{basename:string,path:string,channel:string,size:int,modified:string,mtime:int}>
     */
    private static function scan_log_files(): array
    {
        $dir = self::logs_dir();
        if ($dir === '' || !is_dir($dir)) {
            return [];
        }

        $paths = glob($dir . '/*.log');
        if (!is_array($paths)) {
            return [];
        }

        $files = [];
        foreach ($paths as $path) {
            if (!is_string($path) || $path === '' || !is_file($path)) {
                continue;
            }
            $basename = basename($path);
            $mtime = (int) (@filemtime($path) ?: 0);
            $size = (int) (@filesize($path) ?: 0);
            $channel = self::infer_channel($basename);
            $files[] = [
                'basename' => $basename,
                'path' => $path,
                'channel' => $channel,
                'size' => $size,
                'modified' => $mtime > 0 ? wp_date('Y-m-d H:i:s', $mtime) : '-',
                'mtime' => $mtime,
            ];
        }

        usort($files, static function (array $a, array $b): int {
            return $b['mtime'] <=> $a['mtime'];
        });

        return $files;
    }

    private static function infer_channel(string $basename): string
    {
        $basename = trim($basename);
        if ($basename === '') {
            return 'unknown';
        }

        $dashPos = strpos($basename, '-');
        if ($dashPos === false) {
            return 'unknown';
        }

        $channel = strtolower(substr($basename, 0, $dashPos));
        return $channel !== '' ? $channel : 'unknown';
    }

    /**
     * @param array<string, string> $args
     */
    private static function redirect(array $args = []): void
    {
        $url = add_query_arg(array_merge(['page' => self::PAGE_SLUG], $args), admin_url('admin.php'));
        wp_safe_redirect($url);
        exit;
    }
}
