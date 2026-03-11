<?php
declare(strict_types=1);

namespace SosPrescription\Services;

use SosPrescription\Db;
use WP_Error;

final class MedicationImporter
{
    private const OPTION = 'sosprescription_import_state';
    private const META_OPTION = 'sosprescription_bdpm_meta';
    private const META_HISTORY_OPTION = 'sosprescription_bdpm_meta_history';

    /** @var array<int, array{name:string, table:string}> */
    private array $import_order = [
        ['name' => 'CIS_bdpm.txt', 'table' => 'cis'],
        ['name' => 'CIS_CIP_bdpm.txt', 'table' => 'cip'],
        ['name' => 'CIS_COMPO_bdpm.txt', 'table' => 'compo'],
        ['name' => 'CIS_HAS_SMR_bdpm.txt', 'table' => 'has_smr'],
        ['name' => 'CIS_HAS_ASMR_bdpm.txt', 'table' => 'has_asmr'],
        ['name' => 'CIS_GENER_bdpm.txt', 'table' => 'gener'],
        ['name' => 'CIS_CPD_bdpm.txt', 'table' => 'cpd'],
        ['name' => 'CIS_InfoImportantes', 'table' => 'info'], // prefix match
        // Selon les versions, ces fichiers peuvent s'appeler :
        // - CIS_CIP_Dispo_Spec_bdpm.txt ou CIS_CIP_Dispo_Spec_<timestamp>_bdpm.txt
        // - CIS_MITM_bdpm.txt ou CIS_MITM_<timestamp>_bdpm.txt
        // La résolution se fait via un matching "smart" plus bas.
        ['name' => 'CIS_CIP_Dispo_Spec_bdpm.txt', 'table' => 'dispo'],
        ['name' => 'CIS_MITM_bdpm.txt', 'table' => 'mitm'],
    ];

    public function reset(): void
    {
        delete_option(self::OPTION);

        Logger::log('bdpm', 'info', 'import_session_reset', []);
    }

    /**
     * @return array<string, mixed>
     */
    public function get_state(): array
    {
        $state = get_option(self::OPTION);
        if (!is_array($state)) {
            $meta = get_option(self::META_OPTION);
            $history = get_option(self::META_HISTORY_OPTION);
            if (!is_array($history) || empty($history)) {
                $history = is_array($meta) ? [$meta] : null;
            }

            return [
                'idle' => true,
                'session_id' => null,
                'bdpm_version' => null,
                'done' => false,
                'progress' => 0,
                'current_file' => null,
                'current_file_progress' => 0,
                'files' => [],
                'meta' => is_array($meta) ? $meta : null,
                'meta_history' => is_array($history) ? $history : null,
            ];
        }

        return $this->state_with_progress($state);
    }

    /**
     * @return array<string, mixed>|WP_Error
     */
    public function start_session_from_zip(string $zip_path): array|WP_Error
    {
        if (!class_exists('ZipArchive')) {
            return new WP_Error('sosprescription_zip_missing', 'ZipArchive non disponible sur le serveur.', ['status' => 500]);
        }

        if (!is_file($zip_path)) {
            return new WP_Error('sosprescription_zip_missing', 'Fichier ZIP introuvable.', ['status' => 400]);
        }

        $uploads = wp_upload_dir();
        $base_dir = rtrim((string) $uploads['basedir'], '/') . '/sosprescription-import/sessions';
        wp_mkdir_p($base_dir);

        $session_id = gmdate('Ymd_His') . '_' . bin2hex(random_bytes(4));
        $session_dir = $base_dir . '/' . $session_id;
        wp_mkdir_p($session_dir);

        $zip = new \ZipArchive();
        $opened = $zip->open($zip_path);
        if ($opened !== true) {
            return new WP_Error('sosprescription_zip_open', 'Impossible d’ouvrir le ZIP.', ['status' => 400]);
        }

        $zip->extractTo($session_dir);
        $zip->close();

        $paths = $this->scan_files($session_dir);

        $files = [];
        $total = 0;
        $bdpm_version = null;

        foreach ($this->import_order as $spec) {
            $wanted = $spec['name'];
            $table = $spec['table'];

            $path = null;

            if ($wanted === 'CIS_InfoImportantes') {
                foreach ($paths as $p) {
                    $bn = basename($p);
                    if (preg_match('/^CIS_InfoImportantes.*_bdpm\.txt$/i', $bn) === 1) {
                        $path = $p;
                        $wanted = $bn;

                        if ($bdpm_version === null && preg_match('/^CIS_InfoImportantes_(\d{14})_bdpm\.txt$/i', $bn, $m) === 1) {
                            $bdpm_version = $this->format_bdpm_version((string) $m[1]);
                        }

                        break;
                    }
                }
            } else {
                // 1) Match exact (anciens zips)
                foreach ($paths as $p) {
                    if (strcasecmp(basename($p), $wanted) === 0) {
                        $path = $p;
                        break;
                    }
                }

                // 2) Match "smart" (supporte les variantes officielles BDPM avec timestamp)
                // Ex: CIS_MITM_bdpm.txt OU CIS_MITM_20251231201928_bdpm.txt
                // Ex: CIS_CIP_Dispo_Spec_bdpm.txt OU CIS_CIP_Dispo_Spec_20251231201928_bdpm.txt
                if ($path === null) {
                    $found = $this->find_file_by_pattern($paths, (string) $wanted);
                    if (is_array($found)) {
                        $path = (string) $found['path'];
                        $wanted = (string) $found['name'];
                    }
                }
            }

            if ($path === null) {
                continue;
            }

            $size = filesize($path);
            $size_int = is_int($size) ? $size : 0;
            $total += $size_int;

            $files[] = [
                'name' => $wanted,
                'path' => $path,
                'table' => $table,
                'size' => $size_int,
                'offset' => 0,
                'done' => false,
                'truncated' => false,
                'rows' => 0,
            ];
        }

        if (count($files) < 1) {
            return new WP_Error('sosprescription_no_files', 'Aucun fichier BDPM reconnu dans le ZIP.', ['status' => 400]);
        }

        $state = [
            'session_id' => $session_id,
            'dir' => $session_dir,
            'zip_name' => basename($zip_path),
            'bdpm_version' => $bdpm_version,
            'files' => $files,
            'total_size' => $total,
            'done' => false,
            'meta_saved' => false,
            'started_at' => time(),
        ];

        update_option(self::OPTION, $state, false);

        Logger::log('bdpm', 'info', 'import_session_created', [
            'session_id' => $session_id,
            'bdpm_version' => $bdpm_version !== null ? $bdpm_version : '',
            'zip_name' => basename($zip_path),
            'files_count' => count($files),
        ]);

        return $this->state_with_progress($state);
    }

    /**
     * @return array<string, mixed>|WP_Error
     */
    public function step(): array|WP_Error
    {
        $state = get_option(self::OPTION);
        if (!is_array($state) || empty($state['files']) || !is_array($state['files'])) {
            return new WP_Error('sosprescription_no_session', 'Aucune session d’import active. Uploadez un ZIP.', ['status' => 400]);
        }

        if (!empty($state['done'])) {
            return $this->state_with_progress($state);
        }

        $files = $state['files'];

        $current_index = null;
        foreach ($files as $i => $f) {
            if (is_array($f) && empty($f['done'])) {
                $current_index = $i;
                break;
            }
        }

        if ($current_index === null) {
            $state['done'] = true;

            if (empty($state['meta_saved'])) {
                $this->persist_last_meta($state);
                $state['meta_saved'] = true;

                Logger::log('bdpm', 'info', 'import_session_finished', [
                    'session_id' => (string) ($state['session_id'] ?? ''),
                    'bdpm_version' => (string) ($state['bdpm_version'] ?? ''),
                ]);
            }

            update_option(self::OPTION, $state, false);
            return $this->state_with_progress($state);
        }

        $file = $files[$current_index];

        if (!is_array($file) || empty($file['path']) || empty($file['table'])) {
            Logger::log('bdpm', 'error', 'import_bad_state', [
                'session_id' => (string) ($state['session_id'] ?? ''),
                'current_index' => (int) $current_index,
            ]);

            return new WP_Error('sosprescription_bad_state', 'État import corrompu.', ['status' => 500]);
        }

        $table = (string) $file['table'];
        $full_table = Db::table($table);

        if (empty($file['truncated'])) {
            $this->truncate_table($full_table);
            $file['truncated'] = true;
            $file['offset'] = 0;
            $file['rows'] = 0;

            Logger::log('bdpm', 'info', 'import_file_truncated', [
                'session_id' => (string) ($state['session_id'] ?? ''),
                'file' => (string) ($file['name'] ?? ''),
                'table' => $table,
            ]);
        }

        $path = (string) $file['path'];

        $res = $this->process_file_step($file['name'] ?? basename($path), $path, $table, (int) ($file['offset'] ?? 0));
        if (is_wp_error($res)) {
            Logger::log('bdpm', 'error', 'import_step_error', [
                'session_id' => (string) ($state['session_id'] ?? ''),
                'file' => (string) ($file['name'] ?? ''),
                'table' => $table,
                'error' => (string) $res->get_error_message(),
            ]);

            return $res;
        }

        $prev_done = !empty($file['done']);

        $file['offset'] = (int) $res['offset'];
        $file['rows'] = (int) ($file['rows'] ?? 0) + (int) ($res['rows'] ?? 0);
        $file['done'] = (bool) ($res['done'] ?? false);

        $files[$current_index] = $file;
        $state['files'] = $files;

        if (!empty($file['done']) && !$prev_done) {
            Logger::log('bdpm', 'info', 'import_file_finished', [
                'session_id' => (string) ($state['session_id'] ?? ''),
                'file' => (string) ($file['name'] ?? ''),
                'table' => $table,
                'rows' => (int) ($file['rows'] ?? 0),
            ]);
        }

        // If all done, mark done.
        $all_done = true;
        foreach ($files as $f) {
            if (is_array($f) && empty($f['done'])) {
                $all_done = false;
                break;
            }
        }
        $state['done'] = $all_done;

        if ($all_done && empty($state['meta_saved'])) {
            $this->persist_last_meta($state);
            $state['meta_saved'] = true;

            Logger::log('bdpm', 'info', 'import_session_finished', [
                'session_id' => (string) ($state['session_id'] ?? ''),
                'bdpm_version' => (string) ($state['bdpm_version'] ?? ''),
            ]);
        }

        update_option(self::OPTION, $state, false);

        return $this->state_with_progress($state);
    }

    /**
     * @return array<string, mixed>
     */
    private function state_with_progress(array $state): array
    {
        $meta = get_option(self::META_OPTION);
        $history = get_option(self::META_HISTORY_OPTION);
        if (!is_array($history) || empty($history)) {
            $history = is_array($meta) ? [$meta] : null;
        }

        $files = isset($state['files']) && is_array($state['files']) ? $state['files'] : [];
        $total = isset($state['total_size']) ? (int) $state['total_size'] : 0;

        $processed = 0;
        $current_file = null;
        $current_file_progress = 0;

        foreach ($files as $f) {
            if (!is_array($f)) {
                continue;
            }
            $processed += (int) ($f['offset'] ?? 0);

            if ($current_file === null && empty($f['done'])) {
                $current_file = (string) ($f['name'] ?? '');
                $size = (int) ($f['size'] ?? 0);
                $off = (int) ($f['offset'] ?? 0);
                $current_file_progress = $size > 0 ? ($off / $size) * 100 : 0;
            }
        }

        $progress = $total > 0 ? ($processed / $total) * 100 : 0;
        if ($progress > 100) { $progress = 100; }
        if ($progress < 0) { $progress = 0; }

        return [
            'idle' => false,
            'session_id' => $state['session_id'] ?? null,
            'bdpm_version' => $state['bdpm_version'] ?? null,
            'done' => !empty($state['done']),
            'progress' => $progress,
            'current_file' => $current_file,
            'current_file_progress' => $current_file_progress,
            'files' => array_map(static function ($f) {
                if (!is_array($f)) { return $f; }
                return [
                    'name' => $f['name'] ?? '',
                    'table' => $f['table'] ?? '',
                    'size' => (int) ($f['size'] ?? 0),
                    'offset' => (int) ($f['offset'] ?? 0),
                    'done' => !empty($f['done']),
                    'rows' => (int) ($f['rows'] ?? 0),
                ];
            }, $files),
            'meta' => is_array($meta) ? $meta : null,
            'meta_history' => is_array($history) ? $history : null,
        ];
    }

    /**
     * @return array<string, mixed>|WP_Error
     */
    
    /**
     * Sauvegarde une meta "dernier import BDPM" (version, date, fichier source, récap lignes).
     *
     * @param array<string, mixed> $state
     */
    private function persist_last_meta(array $state): void
    {
        $files = isset($state['files']) && is_array($state['files']) ? $state['files'] : [];

        $file_summaries = [];
        $total_rows = 0;

        foreach ($files as $f) {
            if (!is_array($f)) {
                continue;
            }

            $rows = (int) ($f['rows'] ?? 0);
            $total_rows += $rows;

            $file_summaries[] = [
                'name' => (string) ($f['name'] ?? ''),
                'table' => (string) ($f['table'] ?? ''),
                'rows' => $rows,
                'size' => (int) ($f['size'] ?? 0),
            ];
        }

        $meta = [
            'bdpm_version' => isset($state['bdpm_version']) ? (string) $state['bdpm_version'] : '',
            'imported_at' => current_time('mysql'),
            'session_id' => (string) ($state['session_id'] ?? ''),
            'zip_name' => (string) ($state['zip_name'] ?? ''),
            'total_rows' => $total_rows,
            'files' => $file_summaries,
        ];

        update_option(self::META_OPTION, $meta, false);

        // Historique des imports (pilotage)
        $history = get_option(self::META_HISTORY_OPTION, []);
        if (!is_array($history)) {
            $history = [];
        }

        // Déduplique par session_id
        $history = array_values(array_filter($history, static function ($h) use ($meta): bool {
            if (!is_array($h)) {
                return false;
            }
            return (string) ($h['session_id'] ?? '') !== (string) ($meta['session_id'] ?? '');
        }));

        array_unshift($history, $meta);

        if (count($history) > 20) {
            $history = array_slice($history, 0, 20);
        }

        update_option(self::META_HISTORY_OPTION, $history, false);
    }

    private function format_bdpm_version(string $yyyymmddhhmmss): string
    {
        if (preg_match('/^\d{14}$/', $yyyymmddhhmmss) !== 1) {
            return $yyyymmddhhmmss;
        }

        $y = substr($yyyymmddhhmmss, 0, 4);
        $m = substr($yyyymmddhhmmss, 4, 2);
        $d = substr($yyyymmddhhmmss, 6, 2);
        $h = substr($yyyymmddhhmmss, 8, 2);
        $i = substr($yyyymmddhhmmss, 10, 2);
        $s = substr($yyyymmddhhmmss, 12, 2);

        return $y . '-' . $m . '-' . $d . ' ' . $h . ':' . $i . ':' . $s;
    }

private function process_file_step(string $name, string $path, string $table, int $offset): array|WP_Error
    {
        if (!is_file($path)) {
            return new WP_Error('sosprescription_file_missing', 'Fichier introuvable: ' . $name, ['status' => 400]);
        }

        $max_rows = 250;
        if ($table === 'info') {
            $max_rows = 40;
        } elseif ($table === 'cip') {
            $max_rows = 200;
        }

        $handle = fopen($path, 'rb');
        if ($handle === false) {
            return new WP_Error('sosprescription_file_open', 'Impossible d’ouvrir le fichier: ' . $name, ['status' => 500]);
        }

        if ($offset > 0) {
            fseek($handle, $offset);
        }

        $rows = [];
        $read_lines = 0;

        while (!feof($handle) && count($rows) < $max_rows) {
            $line = fgets($handle);
            if ($line === false) {
                break;
            }
            $read_lines++;

            $line = rtrim($line, "\r\n");
            if ($line === '') {
                continue;
            }

            $parsed = $this->parse_line($name, $line, $table);
            if (is_array($parsed)) {
                $rows[] = $parsed;
            }

            if ($read_lines > $max_rows * 3) {
                // hard stop to avoid very long malformed lines loops
                break;
            }
        }

        $new_offset = ftell($handle);
        if (!is_int($new_offset)) {
            $new_offset = $offset;
        }

        $done = feof($handle);
        fclose($handle);

        if (count($rows) > 0) {
            $inserted = $this->insert_rows($table, $rows);
            if (is_wp_error($inserted)) {
                return $inserted;
            }
        }

        return [
            'offset' => $new_offset,
            'done' => $done,
            'rows' => count($rows),
        ];
    }

    /**
     * @return array<string, mixed>|null
     */
    private function parse_line(string $file_name, string $line, string $table): ?array
    {
        // Convert to UTF-8 early for MySQL utf8mb4 safety
        $line_utf8 = $this->to_utf8($line);

        $parts = explode("\t", $line_utf8);

        switch ($table) {
            case 'cis':
                return $this->parse_cis($parts, $line_utf8);
            case 'cip':
                return $this->parse_cip($parts, $line_utf8);
            case 'compo':
                return $this->parse_compo($parts, $line_utf8);
            case 'has_smr':
                return $this->parse_smr($parts, $line_utf8);
            case 'has_asmr':
                return $this->parse_asmr($parts, $line_utf8);
            case 'gener':
                return $this->parse_gener($parts, $line_utf8);
            case 'cpd':
                return $this->parse_cpd($parts, $line_utf8);
            case 'info':
                return $this->parse_info($parts, $line_utf8);
            case 'dispo':
                return $this->parse_dispo($parts, $line_utf8);
            case 'mitm':
                return $this->parse_mitm($parts, $line_utf8);
            default:
                return null;
        }
    }

    /**
     * @return int|WP_Error
     */
    private function insert_rows(string $table, array $rows): int|WP_Error
    {
        $full_table = Db::table($table);

        switch ($table) {
            case 'cis':
                $cols = ['cis','denomination','forme_pharmaceutique','voie_administration','statut_admin','type_procedure','etat_commercialisation','date_amm','statut_bdm','num_autorisation','titulaires','surveillance_renforcee','row_hash'];
                return $this->bulk_upsert($full_table, $cols, $rows, $cols);

            case 'cip':
                $cols = ['cis','cip7','cip13','libelle_presentation','statut_admin','date_declaration','date_commercialisation','agrement_collectivites','taux_remboursement','prix_ttc','prix_honoraires','row_hash'];
                return $this->bulk_upsert($full_table, $cols, $rows, $cols);

            case 'compo':
                $cols = ['cis','designation_element_pharmaceutique','code_substance','substance','dosage','unite_dosage','reference_dosage','nature_composant','row_hash'];
                return $this->bulk_upsert($full_table, $cols, $rows, $cols);

            case 'has_smr':
                $cols = ['cis','code_has','date_avis','valeur_smr','libelle','row_hash'];
                return $this->bulk_upsert($full_table, $cols, $rows, $cols);

            case 'has_asmr':
                $cols = ['cis','code_has','date_avis','valeur_asmr','libelle','row_hash'];
                return $this->bulk_upsert($full_table, $cols, $rows, $cols);

            case 'gener':
                $cols = ['cis','groupe_generique_id','libelle_groupe','type_generique','numero_tri','row_hash'];
                return $this->bulk_upsert($full_table, $cols, $rows, $cols);

            case 'cpd':
                $cols = ['cis','condition_prescription','row_hash'];
                return $this->bulk_upsert($full_table, $cols, $rows, $cols);

            case 'info':
                $cols = ['cis','type_info','date_debut','date_fin','texte','row_hash'];
                return $this->bulk_upsert($full_table, $cols, $rows, $cols);

            case 'dispo':
                $cols = ['cis','cip13','etat_dispo','date_debut','date_fin','row_hash'];
                return $this->bulk_upsert($full_table, $cols, $rows, $cols);

            case 'mitm':
                $cols = ['cis','code_atc','libelle_atc','row_hash'];
                return $this->bulk_upsert($full_table, $cols, $rows, $cols);

            default:
                return 0;
        }
    }

    private function truncate_table(string $table): void
    {
        global $wpdb;
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
        $wpdb->query("TRUNCATE TABLE {$table}");
    }

    /**
     * @return int|WP_Error
     */
    private function bulk_upsert(string $table, array $columns, array $rows, array $update_columns): int|WP_Error
    {
        global $wpdb;

        if (count($rows) < 1) {
            return 0;
        }

        $col_sql = implode(',', array_map(static fn(string $c) => '`' . $c . '`', $columns));

        $values_sql_parts = [];
        foreach ($rows as $r) {
            if (!is_array($r)) {
                continue;
            }
            $vals = [];
            foreach ($columns as $c) {
                $vals[] = $this->sql_value($r[$c] ?? null);
            }
            $values_sql_parts[] = '(' . implode(',', $vals) . ')';
        }

        if (count($values_sql_parts) < 1) {
            return 0;
        }

        $update_parts = [];
        foreach ($update_columns as $c) {
            $update_parts[] = '`' . $c . '`=VALUES(`' . $c . '`)';
        }

        $values_sql = implode(',', $values_sql_parts);
        $update_sql = implode(',', $update_parts);

        $sql = "INSERT INTO {$table} ({$col_sql}) VALUES {$values_sql} ON DUPLICATE KEY UPDATE {$update_sql}";

        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
        $ok = $wpdb->query($sql);
        if ($ok === false) {
            return new WP_Error('sosprescription_db_error', 'Erreur SQL import: ' . (string) $wpdb->last_error, ['status' => 500]);
        }

        return (int) $ok;
    }

    private function sql_value(mixed $v): string
    {
        if ($v === null) {
            return 'NULL';
        }

        if (is_bool($v)) {
            return $v ? '1' : '0';
        }

        if (is_int($v) || is_float($v)) {
            return (string) $v;
        }

        $s = (string) $v;
        // esc_sql uses wpdb real escape and expects current connection charset
        $s = esc_sql($s);

        return "'{$s}'";
    }

    private function to_utf8(string $s): string
    {
        if ($s === '') {
            return $s;
        }
        if (function_exists('mb_check_encoding') && mb_check_encoding($s, 'UTF-8')) {
            return $s;
        }
        if (function_exists('mb_convert_encoding')) {
            return (string) mb_convert_encoding($s, 'UTF-8', 'Windows-1252');
        }
        // Fallback: keep bytes (may break if non-utf8)
        return $s;
    }

    /**
     * @return array<int, string>
     */
    private function scan_files(string $dir): array
    {
        $out = [];
        $it = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS));
        foreach ($it as $file) {
            /** @var \SplFileInfo $file */
            if ($file->isFile()) {
                $out[] = $file->getPathname();
            }
        }
        return $out;
    }

    /**
     * Recherche un fichier BDPM dans un ZIP en étant tolérant aux variantes de nommage.
     *
     * Exemples rencontrés (selon versions) :
     * - CIS_MITM_bdpm.txt
     * - CIS_MITM_20251231201928_bdpm.txt
     * - CIS_CIP_Dispo_Spec_bdpm.txt
     * - CIS_CIP_Dispo_Spec_20251231201928_bdpm.txt
     *
     * @param array<int, string> $paths
     * @return array{path:string,name:string}|null
     */
    private function find_file_by_pattern(array $paths, string $wanted): ?array
    {
        $wanted = basename($wanted);
        if ($wanted === '') {
            return null;
        }

        $re = $this->build_bdpm_filename_regex($wanted);
        if ($re === null) {
            return null;
        }

        foreach ($paths as $p) {
            $bn = basename($p);
            if ($bn === '') {
                continue;
            }
            if (preg_match($re, $bn) === 1) {
                return ['path' => $p, 'name' => $bn];
            }
        }

        return null;
    }

    /**
     * Construit un regex tolérant :
     * - si le nom attendu finit par "_bdpm.txt" => supporte "<prefix>_bdpm.txt" et "<prefix>_<timestamp>_bdpm.txt".
     * - sinon => supporte "<base>.txt", "<base>_bdpm.txt" et leurs variantes avec timestamp.
     */
    private function build_bdpm_filename_regex(string $wanted): ?string
    {
        $w = trim($wanted);
        if ($w === '') {
            return null;
        }

        if (preg_match('/\.txt$/i', $w) !== 1) {
            return null;
        }

        $base = preg_replace('/\.txt$/i', '', $w);
        if (!is_string($base) || $base === '') {
            return null;
        }

        // Si on attend déjà un suffixe _bdpm, on supporte :
        // - <prefix>_bdpm.txt
        // - <prefix>_<timestamp>_bdpm.txt
        // - (compat) <prefix>.txt
        if (preg_match('/_bdpm$/i', $base) === 1) {
            $prefix = preg_replace('/_bdpm$/i', '', $base);
            if (!is_string($prefix) || $prefix === '') {
                return null;
            }
            $prefixQ = preg_quote($prefix, '/');
            return '/^' . $prefixQ . '(?:_\\d{14})?(?:_bdpm)?\\.txt$/i';
        }

        // Sinon : tolère la présence (ou non) de _bdpm, + timestamp optionnel.
        $prefixQ = preg_quote($base, '/');
        return '/^' . $prefixQ . '(?:_\\d{14})?(?:_bdpm)?\\.txt$/i';
    }

    // ---------------- Parsers ----------------

    private function parse_cis(array $p, string $line): ?array
    {
        // 12 colonnes
        if (count($p) < 8) {
            return null;
        }

        $cis = isset($p[0]) ? (int) trim($p[0]) : 0;
        if ($cis < 1) { return null; }

        $denom = $this->t($p[1] ?? '');
        $forme = $this->t($p[2] ?? '');
        $voie  = $this->t($p[3] ?? '');
        $statut = $this->t($p[4] ?? '');
        $proc   = $this->t($p[5] ?? '');
        $etat   = $this->t($p[6] ?? '');
        $date_amm = $this->parse_date_fr($p[7] ?? '');
        $statut_bdm = $this->t($p[8] ?? '');
        $num_aut = $this->t($p[9] ?? '');
        $titulaires = $this->t($p[10] ?? '');
        $surv = $this->t($p[11] ?? '');

        return [
            'cis' => $cis,
            'denomination' => $denom,
            'forme_pharmaceutique' => $forme !== '' ? $forme : null,
            'voie_administration' => $voie !== '' ? $voie : null,
            'statut_admin' => $statut !== '' ? $statut : null,
            'type_procedure' => $proc !== '' ? $proc : null,
            'etat_commercialisation' => $etat !== '' ? $etat : null,
            'date_amm' => $date_amm,
            'statut_bdm' => $statut_bdm !== '' ? $statut_bdm : null,
            'num_autorisation' => $num_aut !== '' ? $num_aut : null,
            'titulaires' => $titulaires !== '' ? $titulaires : null,
            'surveillance_renforcee' => (mb_strtolower($surv) === 'oui') ? 1 : 0,
            'row_hash' => md5($line),
        ];
    }

    private function parse_cip(array $p, string $line): ?array
    {
        // 13 colonnes
        if (count($p) < 7) {
            return null;
        }

        $cis = isset($p[0]) ? (int) trim($p[0]) : 0;
        if ($cis < 1) { return null; }

        $cip7 = $this->t($p[1] ?? '');
        $lib  = $this->t($p[2] ?? '');
        $statut = $this->t($p[3] ?? '');
        $etat = $this->t($p[4] ?? '');
        $date_decl = $this->parse_date_fr($p[5] ?? '');
        $cip13 = $this->t($p[6] ?? '');
        $agr = $this->t($p[7] ?? '');
        $taux = $this->t($p[8] ?? '');
        $prix = $this->parse_decimal($p[9] ?? '');
        $prix_h = $this->parse_decimal($p[10] ?? '');

        return [
            'cis' => $cis,
            'cip7' => $cip7 !== '' ? $cip7 : null,
            'cip13' => $cip13 !== '' ? $cip13 : null,
            'libelle_presentation' => $lib !== '' ? $lib : null,
            'statut_admin' => ($statut !== '' ? $statut : null),
            'date_declaration' => $date_decl,
            'date_commercialisation' => null,
            'agrement_collectivites' => $agr !== '' ? $agr : null,
            'taux_remboursement' => $taux !== '' ? $taux : null,
            'prix_ttc' => $prix,
            'prix_honoraires' => $prix_h,
            'row_hash' => md5($line),
        ];
    }

    private function parse_compo(array $p, string $line): ?array
    {
        if (count($p) < 4) {
            return null;
        }

        $cis = isset($p[0]) ? (int) trim($p[0]) : 0;
        if ($cis < 1) { return null; }

        $elem = $this->t($p[1] ?? '');
        $code = $this->t($p[2] ?? '');
        $sub  = $this->t($p[3] ?? '');
        $dosage_raw = $this->t($p[4] ?? '');
        $ref = $this->t($p[5] ?? '');
        $nature = $this->t($p[6] ?? '');

        $unite = null;
        $dosage = $dosage_raw !== '' ? $dosage_raw : null;

        // tentative extraction unité si format simple "1,00 mg"
        if ($dosage_raw !== '' && preg_match('/^([0-9]+([\.,][0-9]+)?)\s*(.+)$/u', $dosage_raw, $m) === 1) {
            $dosage = str_replace(',', '.', $m[1]);
            $unite = $this->t($m[3]);
        }

        return [
            'cis' => $cis,
            'designation_element_pharmaceutique' => $elem !== '' ? $elem : null,
            'code_substance' => $code !== '' ? $code : null,
            'substance' => $sub !== '' ? $sub : null,
            'dosage' => $dosage,
            'unite_dosage' => $unite,
            'reference_dosage' => $ref !== '' ? $ref : null,
            'nature_composant' => $nature !== '' ? $nature : null,
            'row_hash' => md5($line),
        ];
    }

    private function parse_smr(array $p, string $line): ?array
    {
        if (count($p) < 6) {
            return null;
        }

        $cis = isset($p[0]) ? (int) trim($p[0]) : 0;
        if ($cis < 1) { return null; }

        $code = $this->t($p[1] ?? '');
        $date = $this->parse_date_yyyymmdd($p[3] ?? '');
        $val  = $this->t($p[4] ?? '');
        $lib  = $this->t($p[5] ?? '');

        return [
            'cis' => $cis,
            'code_has' => $code !== '' ? $code : null,
            'date_avis' => $date,
            'valeur_smr' => $val !== '' ? $val : null,
            'libelle' => $lib !== '' ? $lib : null,
            'row_hash' => md5($line),
        ];
    }

    private function parse_asmr(array $p, string $line): ?array
    {
        if (count($p) < 6) {
            return null;
        }

        $cis = isset($p[0]) ? (int) trim($p[0]) : 0;
        if ($cis < 1) { return null; }

        $code = $this->t($p[1] ?? '');
        $date = $this->parse_date_yyyymmdd($p[3] ?? '');
        $val  = $this->t($p[4] ?? '');
        $lib  = $this->t($p[5] ?? '');

        return [
            'cis' => $cis,
            'code_has' => $code !== '' ? $code : null,
            'date_avis' => $date,
            'valeur_asmr' => $val !== '' ? $val : null,
            'libelle' => $lib !== '' ? $lib : null,
            'row_hash' => md5($line),
        ];
    }

    private function parse_gener(array $p, string $line): ?array
    {
        if (count($p) < 3) {
            return null;
        }

        $gid = $this->t($p[0] ?? '');
        $lib = $this->t($p[1] ?? '');
        $cis = isset($p[2]) ? (int) trim($p[2]) : 0;
        if ($cis < 1) { return null; }

        $type = $this->t($p[3] ?? '');
        $tri  = isset($p[4]) && is_numeric($p[4]) ? (int) $p[4] : null;

        return [
            'cis' => $cis,
            'groupe_generique_id' => $gid !== '' ? $gid : null,
            'libelle_groupe' => $lib !== '' ? $lib : null,
            'type_generique' => $type !== '' ? $type : null,
            'numero_tri' => $tri,
            'row_hash' => md5($line),
        ];
    }

    private function parse_cpd(array $p, string $line): ?array
    {
        if (count($p) < 2) {
            return null;
        }

        $cis = isset($p[0]) ? (int) trim($p[0]) : 0;
        if ($cis < 1) { return null; }

        $txt = $this->t($p[1] ?? '');

        return [
            'cis' => $cis,
            'condition_prescription' => $txt !== '' ? $txt : null,
            'row_hash' => md5($line),
        ];
    }

    private function parse_info(array $p, string $line): ?array
    {
        if (count($p) < 2) {
            return null;
        }

        $cis = isset($p[0]) ? (int) trim($p[0]) : 0;
        if ($cis < 1) { return null; }

        $date_debut = $this->parse_date_iso($p[1] ?? '');
        $date_fin   = $this->parse_date_iso($p[2] ?? '');
        $texte      = $this->t($p[3] ?? '');

        return [
            'cis' => $cis,
            'type_info' => null,
            'date_debut' => $date_debut,
            'date_fin' => $date_fin,
            'texte' => $texte !== '' ? $texte : null,
            'row_hash' => md5($line),
        ];
    }

    private function parse_dispo(array $p, string $line): ?array
    {
        if (count($p) < 4) {
            return null;
        }

        $cis = isset($p[0]) ? (int) trim($p[0]) : 0;
        if ($cis < 1) { return null; }

        $cip13 = $this->t($p[1] ?? '');
        $etat  = $this->t($p[3] ?? '');
        $date_debut = $this->parse_date_fr($p[4] ?? '');
        $date_fin   = $this->parse_date_fr($p[5] ?? '');

        return [
            'cis' => $cis,
            'cip13' => $cip13 !== '' ? $cip13 : null,
            'etat_dispo' => $etat !== '' ? $etat : null,
            'date_debut' => $date_debut,
            'date_fin' => $date_fin,
            'row_hash' => md5($line),
        ];
    }

    private function parse_mitm(array $p, string $line): ?array
    {
        if (count($p) < 2) {
            return null;
        }

        $cis = isset($p[0]) ? (int) trim($p[0]) : 0;
        if ($cis < 1) { return null; }

        $atc = $this->t($p[1] ?? '');
        $lib = $this->t($p[2] ?? '');

        return [
            'cis' => $cis,
            'code_atc' => $atc !== '' ? $atc : null,
            'libelle_atc' => $lib !== '' ? $lib : null,
            'row_hash' => md5($line),
        ];
    }

    // ---------------- Helpers ----------------

    private function t(string $s): string
    {
        $s = trim($s);
        // normalize spaces
        $s = preg_replace('/\s+/u', ' ', $s) ?? $s;
        return trim($s);
    }

    private function parse_date_fr(string $s): ?string
    {
        $s = trim($s);
        if ($s === '') { return null; }
        if (preg_match('/^(\d{2})\/(\d{2})\/(\d{4})$/', $s, $m) !== 1) {
            return null;
        }
        return $m[3] . '-' . $m[2] . '-' . $m[1];
    }

    private function parse_date_iso(string $s): ?string
    {
        $s = trim($s);
        if ($s === '') { return null; }
        if (preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $s, $m) !== 1) {
            return null;
        }
        return $m[1] . '-' . $m[2] . '-' . $m[3];
    }

    private function parse_date_yyyymmdd(string $s): ?string
    {
        $s = trim($s);
        if ($s === '') { return null; }
        if (preg_match('/^(\d{4})(\d{2})(\d{2})$/', $s, $m) !== 1) {
            return null;
        }
        return $m[1] . '-' . $m[2] . '-' . $m[3];
    }

    private function parse_decimal(string $s): ?string
    {
        $s = trim($s);
        if ($s === '') { return null; }
        $s = str_replace(',', '.', $s);
        if (!is_numeric($s)) {
            return null;
        }
        return $s;
    }
}
