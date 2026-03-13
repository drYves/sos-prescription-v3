<?php
// includes/Services/Whitelist.php
declare(strict_types=1);

namespace SOSPrescription\Services;

use SOSPrescription\Db;

final class Whitelist
{
    public const OPTION_KEY = 'sosprescription_whitelist';

    public const FLOW_RO_PROOF = 'ro_proof';
    public const FLOW_DEPANNAGE_NO_PROOF = 'depannage_no_proof';

    private static ?bool $mitmReadyCache = null;
    private static bool $atcWarningLogged = false;

    /**
     * @return array{
     *  mode:string,
     *  allowed_atc_prefixes:array<int,string>,
     *  denied_atc_prefixes:array<int,string>,
     *  allowed_cis:array<int,int>,
     *  denied_cis:array<int,int>,
     *  require_evidence:bool,
     *  updated_at:string
     * }
     */
    public static function get(): array
    {
        $defaults = self::defaults();
        $raw = get_option(self::OPTION_KEY, null);

        if (!is_array($raw)) {
            return $defaults;
        }

        $mode = isset($raw['mode']) && is_string($raw['mode']) ? strtolower(trim($raw['mode'])) : $defaults['mode'];
        if (!in_array($mode, ['off', 'warn', 'enforce'], true)) {
            $mode = $defaults['mode'];
        }

        $allowedAtcRaw = $raw['allowed_atc_prefixes'] ?? $defaults['allowed_atc_prefixes'];
        $deniedAtcRaw = $raw['denied_atc_prefixes'] ?? $defaults['denied_atc_prefixes'];
        $allowedCisRaw = $raw['allowed_cis'] ?? $defaults['allowed_cis'];
        $deniedCisRaw = $raw['denied_cis'] ?? $defaults['denied_cis'];
        $requireEvidence = isset($raw['require_evidence']) ? (bool) $raw['require_evidence'] : (bool) $defaults['require_evidence'];
        $updatedAt = isset($raw['updated_at']) && is_string($raw['updated_at']) ? $raw['updated_at'] : $defaults['updated_at'];

        return [
            'mode' => $mode,
            'allowed_atc_prefixes' => self::normalize_prefixes(self::parse_list_input($allowedAtcRaw)),
            'denied_atc_prefixes' => self::normalize_prefixes(self::parse_list_input($deniedAtcRaw)),
            'allowed_cis' => self::normalize_cis_list(self::parse_list_input($allowedCisRaw)),
            'denied_cis' => self::normalize_cis_list(self::parse_list_input($deniedCisRaw)),
            'require_evidence' => $requireEvidence,
            'updated_at' => $updatedAt,
        ];
    }

    /**
     * @param array{
     *   mode?:string,
     *   allowed_atc_prefixes?:array<int,string>|string,
     *   denied_atc_prefixes?:array<int,string>|string,
     *   allowed_cis?:array<int,int|string>|string,
     *   denied_cis?:array<int,int|string>|string,
     *   require_evidence?:bool
     * } $in
     *
     * @return array{
     *  mode:string,
     *  allowed_atc_prefixes:array<int,string>,
     *  denied_atc_prefixes:array<int,string>,
     *  allowed_cis:array<int,int>,
     *  denied_cis:array<int,int>,
     *  require_evidence:bool,
     *  updated_at:string
     * }
     */
    public static function update(array $in): array
    {
        $current = self::get();

        $mode = isset($in['mode']) && is_string($in['mode']) ? strtolower(trim($in['mode'])) : $current['mode'];
        if (!in_array($mode, ['off', 'warn', 'enforce'], true)) {
            $mode = $current['mode'];
        }

        $out = [
            'mode' => $mode,
            'allowed_atc_prefixes' => self::normalize_prefixes(self::parse_list_input($in['allowed_atc_prefixes'] ?? $current['allowed_atc_prefixes'])),
            'denied_atc_prefixes' => self::normalize_prefixes(self::parse_list_input($in['denied_atc_prefixes'] ?? $current['denied_atc_prefixes'])),
            'allowed_cis' => self::normalize_cis_list(self::parse_list_input($in['allowed_cis'] ?? $current['allowed_cis'])),
            'denied_cis' => self::normalize_cis_list(self::parse_list_input($in['denied_cis'] ?? $current['denied_cis'])),
            'require_evidence' => isset($in['require_evidence']) ? (bool) $in['require_evidence'] : $current['require_evidence'],
            'updated_at' => gmdate('c'),
        ];

        update_option(self::OPTION_KEY, $out, false);

        return $out;
    }

    public static function needs_mitm_for_atc_rules(): bool
    {
        $cfg = self::get();

        return !empty($cfg['allowed_atc_prefixes']) || !empty($cfg['denied_atc_prefixes']);
    }

    public static function is_mitm_ready(): bool
    {
        if (self::$mitmReadyCache !== null) {
            return self::$mitmReadyCache;
        }

        $table = Db::table('mitm');
        if (!self::table_exists($table) || !self::table_has_rows($table)) {
            self::$mitmReadyCache = false;
            return false;
        }

        self::$mitmReadyCache = true;
        return true;
    }

    /**
     * @param array<int, array<string,mixed>> $items
     * @return array<int, array<string,mixed>>
     */
    public static function filter_search_results(array $items): array
    {
        $cfg = self::get();
        if ($cfg['mode'] !== 'enforce') {
            return $items;
        }

        $cisList = [];
        foreach ($items as $item) {
            if (!is_array($item)) {
                continue;
            }

            $cis = isset($item['cis']) ? (int) $item['cis'] : 0;
            if ($cis > 0) {
                $cisList[] = $cis;
            }
        }

        $cisList = array_values(array_unique($cisList));
        $atcMap = self::map_atc_codes_for_cis($cisList);

        $out = [];
        foreach ($items as $item) {
            if (!is_array($item)) {
                continue;
            }

            $cis = isset($item['cis']) ? (int) $item['cis'] : 0;
            $evaluation = self::evaluate($cis, $cis > 0 ? ($atcMap[$cis] ?? null) : null);
            if (!empty($evaluation['allowed'])) {
                $out[] = $item;
            }
        }

        return $out;
    }

    /**
     * @param array<int,string>|null $atc_codes
     * @return array{allowed:bool,reason_code:string,reason:string,atc_codes:array<int,string>}
     */
    public static function evaluate(int $cis, ?array $atc_codes = null): array
    {
        $cfg = self::get();
        $cis = max(0, $cis);
        $atcCodes = self::normalize_prefixes($atc_codes ?? []);

        if ($cis < 1) {
            return [
                'allowed' => false,
                'reason_code' => 'missing_cis',
                'reason' => 'Code CIS manquant.',
                'atc_codes' => $atcCodes,
            ];
        }

        if (in_array($cis, $cfg['denied_cis'], true)) {
            return [
                'allowed' => false,
                'reason_code' => 'cis_denied',
                'reason' => 'Medicament explicitement exclu.',
                'atc_codes' => $atcCodes,
            ];
        }

        if (in_array($cis, $cfg['allowed_cis'], true)) {
            return [
                'allowed' => true,
                'reason_code' => 'cis_allowed',
                'reason' => 'Autorise par override CIS.',
                'atc_codes' => $atcCodes,
            ];
        }

        foreach ($cfg['denied_atc_prefixes'] as $prefix) {
            foreach ($atcCodes as $code) {
                if ($prefix !== '' && str_starts_with($code, $prefix)) {
                    return [
                        'allowed' => false,
                        'reason_code' => 'atc_denied',
                        'reason' => 'Classe ATC explicitement exclue.',
                        'atc_codes' => $atcCodes,
                    ];
                }
            }
        }

        $hasAllowList = !empty($cfg['allowed_cis']) || !empty($cfg['allowed_atc_prefixes']);
        if (!$hasAllowList) {
            return [
                'allowed' => true,
                'reason_code' => 'no_allowlist',
                'reason' => 'Aucune allowlist configuree.',
                'atc_codes' => $atcCodes,
            ];
        }

        foreach ($cfg['allowed_atc_prefixes'] as $prefix) {
            foreach ($atcCodes as $code) {
                if ($prefix !== '' && str_starts_with($code, $prefix)) {
                    return [
                        'allowed' => true,
                        'reason_code' => 'atc_allowed',
                        'reason' => 'Autorise par classe ATC.',
                        'atc_codes' => $atcCodes,
                    ];
                }
            }
        }

        if ($atcCodes === []) {
            return [
                'allowed' => true,
                'reason_code' => 'atc_missing_fallback_allow',
                'reason' => 'Aucun code ATC disponible : selection autorisee par defaut.',
                'atc_codes' => $atcCodes,
            ];
        }

        return [
            'allowed' => false,
            'reason_code' => 'not_in_allowlist',
            'reason' => 'Hors perimetre de la allowlist.',
            'atc_codes' => $atcCodes,
        ];
    }

    /**
     * @param array<int,string>|null $atc_codes
     * @return array{allowed:bool,reason_code:string,reason:string,atc_codes:array<int,string>}
     */
    public static function evaluate_for_flow(int $cis, ?array $atc_codes, string $flow_key): array
    {
        $flow = self::normalize_flow($flow_key);

        if ($flow === self::FLOW_DEPANNAGE_NO_PROOF) {
            return self::evaluate($cis, $atc_codes);
        }

        return self::evaluate_deny_only($cis, $atc_codes);
    }

    /**
     * @param array<int,string>|null $atc_codes
     * @return array{allowed:bool,reason_code:string,reason:string,atc_codes:array<int,string>}
     */
    public static function evaluate_deny_only(int $cis, ?array $atc_codes = null): array
    {
        $cfg = self::get();
        $cis = max(0, (int) $cis);
        $atcCodes = self::normalize_prefixes($atc_codes ?? []);

        if ($cis < 1) {
            return [
                'allowed' => false,
                'reason_code' => 'missing_cis',
                'reason' => 'Code CIS manquant.',
                'atc_codes' => $atcCodes,
            ];
        }

        if (in_array($cis, $cfg['denied_cis'], true)) {
            return [
                'allowed' => false,
                'reason_code' => 'cis_denied',
                'reason' => 'Medicament explicitement exclu.',
                'atc_codes' => $atcCodes,
            ];
        }

        if (in_array($cis, $cfg['allowed_cis'], true)) {
            return [
                'allowed' => true,
                'reason_code' => 'cis_allowed',
                'reason' => 'Autorise par override CIS.',
                'atc_codes' => $atcCodes,
            ];
        }

        foreach ($cfg['denied_atc_prefixes'] as $prefix) {
            foreach ($atcCodes as $code) {
                if ($prefix !== '' && str_starts_with($code, $prefix)) {
                    return [
                        'allowed' => false,
                        'reason_code' => 'atc_denied',
                        'reason' => 'Classe ATC explicitement exclue.',
                        'atc_codes' => $atcCodes,
                    ];
                }
            }
        }

        return [
            'allowed' => true,
            'reason_code' => 'deny_only_default_allow',
            'reason' => 'Autorise par defaut (flow ro_proof / fallback).',
            'atc_codes' => $atcCodes,
        ];
    }

    /**
     * @param array<int,int> $cis_list
     * @return array<int, array<int,string>>
     */
    public static function map_atc_codes_for_cis(array $cis_list): array
    {
        global $wpdb;

        if (!isset($wpdb) || !($wpdb instanceof \wpdb)) {
            self::log_atc_table_warning('wpdb unavailable');
            return [];
        }

        $cisList = array_values(array_unique(array_filter(array_map('intval', $cis_list), static fn (int $v): bool => $v > 0)));
        if ($cisList === []) {
            return [];
        }

        $table = Db::table('mitm');
        if (!self::table_exists($table) || !self::table_has_rows($table)) {
            self::log_atc_table_warning();
            return [];
        }

        $placeholders = implode(',', array_fill(0, count($cisList), '%d'));
        $sql = $wpdb->prepare(
            "SELECT cis, code_atc FROM {$table} WHERE cis IN ({$placeholders})",
            $cisList
        );

        if (!is_string($sql) || $sql === '') {
            self::log_atc_table_warning('prepare failed');
            return [];
        }

        $rows = $wpdb->get_results($sql, ARRAY_A);
        if (!is_array($rows)) {
            self::log_atc_table_warning($wpdb->last_error !== '' ? $wpdb->last_error : 'query failed');
            return [];
        }

        if ($wpdb->last_error !== '') {
            self::log_atc_table_warning($wpdb->last_error);
            return [];
        }

        $map = [];
        foreach ($rows as $row) {
            $cis = isset($row['cis']) ? (int) $row['cis'] : 0;
            $code = isset($row['code_atc']) ? strtoupper(trim((string) $row['code_atc'])) : '';
            if ($cis < 1 || $code === '') {
                continue;
            }

            $map[$cis] ??= [];
            $map[$cis][] = $code;
        }

        foreach ($map as $cis => $codes) {
            $map[$cis] = array_values(array_unique(self::normalize_prefixes($codes)));
        }

        return $map;
    }

    public static function cis_from_cip13(string $cip13): ?int
    {
        global $wpdb;

        if (!isset($wpdb) || !($wpdb instanceof \wpdb)) {
            return null;
        }

        $cip13 = trim($cip13);
        if ($cip13 === '' || preg_match('/^\d{13}$/', $cip13) !== 1) {
            return null;
        }

        $table = Db::table('cip');
        if (!self::table_exists($table)) {
            return null;
        }

        $cis = $wpdb->get_var($wpdb->prepare("SELECT cis FROM {$table} WHERE cip13 = %s LIMIT 1", $cip13));
        if ($cis === null) {
            return null;
        }

        $value = (int) $cis;
        return $value > 0 ? $value : null;
    }

    /**
     * @param mixed $in
     * @return array<int, string>
     */
    private static function parse_list_input(mixed $in): array
    {
        if (is_array($in)) {
            $out = [];
            foreach ($in as $value) {
                if (is_string($value) || is_numeric($value)) {
                    $out[] = (string) $value;
                }
            }
            return array_values($out);
        }

        if (!is_string($in)) {
            return [];
        }

        $normalized = str_replace(["\r\n", "\r"], "\n", $in);
        $parts = preg_split('/[\n,;\t]+/', $normalized);
        if (!is_array($parts)) {
            return [];
        }

        $out = [];
        foreach ($parts as $part) {
            $part = trim((string) $part);
            if ($part !== '') {
                $out[] = $part;
            }
        }

        return $out;
    }

    /**
     * @param array<int,string> $arr
     * @return array<int,string>
     */
    private static function normalize_prefixes(array $arr): array
    {
        $out = [];
        foreach ($arr as $value) {
            if (!is_string($value)) {
                continue;
            }

            $normalized = strtoupper(trim($value));
            $normalized = str_replace([' ', '.', '-'], '', $normalized);
            if ($normalized === '') {
                continue;
            }

            if (preg_match('/^[A-Z0-9]{1,10}$/', $normalized) !== 1) {
                continue;
            }

            $out[] = $normalized;
        }

        return array_values(array_unique($out));
    }

    /**
     * @param array<int,int|string> $arr
     * @return array<int,int>
     */
    private static function normalize_cis_list(array $arr): array
    {
        $out = [];
        foreach ($arr as $value) {
            $stringValue = is_int($value) ? (string) $value : (is_string($value) ? trim($value) : '');
            if ($stringValue === '' || preg_match('/^\d{1,12}$/', $stringValue) !== 1) {
                continue;
            }

            $cis = (int) $stringValue;
            if ($cis > 0) {
                $out[] = $cis;
            }
        }

        return array_values(array_unique($out));
    }

    /**
     * @return array{mode:string, allowed_atc_prefixes:array<int,string>, denied_atc_prefixes:array<int,string>, allowed_cis:array<int,int>, denied_cis:array<int,int>, require_evidence:bool, updated_at:string}
     */
    private static function defaults(): array
    {
        return [
            'mode' => 'enforce',
            'allowed_atc_prefixes' => ['G03A', 'H03A', 'R06', 'R03', 'A02BC', 'C10AA', 'C09', 'N02BE'],
            'denied_atc_prefixes' => ['N02A', 'N05B', 'N05C', 'N06B'],
            'allowed_cis' => [],
            'denied_cis' => [],
            'require_evidence' => true,
            'updated_at' => gmdate('c'),
        ];
    }

    private static function normalize_flow(string $flow_key): string
    {
        $flow = strtolower(trim($flow_key));
        if ($flow === '') {
            return self::FLOW_RO_PROOF;
        }

        if (in_array($flow, [
            self::FLOW_RO_PROOF,
            'ro',
            'renewal',
            'renewal_with_proof',
            'ro-with-proof',
            'ro_proof_with_evidence',
        ], true)) {
            return self::FLOW_RO_PROOF;
        }

        if (in_array($flow, [
            self::FLOW_DEPANNAGE_NO_PROOF,
            'depannage',
            'depannage_no_proof_strict',
            'no_proof',
            'without_proof',
            'depannage-sans-preuve',
        ], true)) {
            return self::FLOW_DEPANNAGE_NO_PROOF;
        }

        return self::FLOW_RO_PROOF;
    }

    private static function table_exists(string $table): bool
    {
        global $wpdb;

        if (!isset($wpdb) || !($wpdb instanceof \wpdb) || $table === '') {
            return false;
        }

        static $cache = [];
        if (array_key_exists($table, $cache)) {
            return (bool) $cache[$table];
        }

        $like = str_replace(['\\', '_', '%'], ['\\\\', '\\_', '\\%'], $table);
        $sql = $wpdb->prepare('SHOW TABLES LIKE %s', $like);
        $found = $wpdb->get_var($sql);

        $exists = is_string($found) && $found !== '';
        $cache[$table] = $exists;

        return $exists;
    }

    private static function table_has_rows(string $table): bool
    {
        global $wpdb;

        if (!isset($wpdb) || !($wpdb instanceof \wpdb) || $table === '') {
            return false;
        }

        static $cache = [];
        if (array_key_exists($table, $cache)) {
            return (bool) $cache[$table];
        }

        $one = $wpdb->get_var("SELECT 1 FROM {$table} LIMIT 1");
        $hasRows = $one !== null;
        $cache[$table] = $hasRows;

        return $hasRows;
    }

    private static function log_atc_table_warning(string $detail = ''): void
    {
        if (self::$atcWarningLogged) {
            return;
        }

        self::$atcWarningLogged = true;

        $message = '[SOSPrescription] Warning: ATC table empty';
        if ($detail !== '') {
            $message .= ' (' . $detail . ')';
        }

        error_log($message);
    }
}
