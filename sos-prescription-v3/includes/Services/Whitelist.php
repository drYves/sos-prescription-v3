<?php
declare(strict_types=1);

namespace SOSPrescription\Services;

use SOSPrescription\Db;

final class Whitelist
{
    public const OPTION_KEY = 'sosprescription_whitelist';
    public const FLOW_RO_PROOF = 'ro_proof';
    public const FLOW_DEPANNAGE_NO_PROOF = 'depannage_no_proof';

    private static ?bool $mitm_ready_cache = null;

    private static bool $mitm_warning_logged = false;

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
        $raw = get_option(self::OPTION_KEY, null);
        if (!is_array($raw)) {
            return self::defaults();
        }

        $defaults = self::defaults();

        $mode = isset($raw['mode']) && is_string($raw['mode']) ? strtolower(trim($raw['mode'])) : $defaults['mode'];
        if (!in_array($mode, ['off', 'warn', 'enforce'], true)) {
            $mode = $defaults['mode'];
        }

        $allowedAtc = $raw['allowed_atc_prefixes'] ?? $defaults['allowed_atc_prefixes'];
        $deniedAtc = $raw['denied_atc_prefixes'] ?? $defaults['denied_atc_prefixes'];
        $allowedCis = $raw['allowed_cis'] ?? $defaults['allowed_cis'];
        $deniedCis = $raw['denied_cis'] ?? $defaults['denied_cis'];
        $requireEvidence = isset($raw['require_evidence']) ? (bool) $raw['require_evidence'] : (bool) $defaults['require_evidence'];
        $updated = isset($raw['updated_at']) && is_string($raw['updated_at']) ? (string) $raw['updated_at'] : $defaults['updated_at'];

        return [
            'mode' => $mode,
            'allowed_atc_prefixes' => self::normalize_prefixes(self::parse_list_input($allowedAtc)),
            'denied_atc_prefixes' => self::normalize_prefixes(self::parse_list_input($deniedAtc)),
            'allowed_cis' => self::normalize_cis_list(self::parse_list_input($allowedCis)),
            'denied_cis' => self::normalize_cis_list(self::parse_list_input($deniedCis)),
            'require_evidence' => $requireEvidence,
            'updated_at' => $updated,
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
        $cur = self::get();

        $mode = isset($in['mode']) && is_string($in['mode']) ? strtolower(trim($in['mode'])) : $cur['mode'];
        if (!in_array($mode, ['off', 'warn', 'enforce'], true)) {
            $mode = $cur['mode'];
        }

        $out = [
            'mode' => $mode,
            'allowed_atc_prefixes' => self::normalize_prefixes(self::parse_list_input($in['allowed_atc_prefixes'] ?? $cur['allowed_atc_prefixes'])),
            'denied_atc_prefixes' => self::normalize_prefixes(self::parse_list_input($in['denied_atc_prefixes'] ?? $cur['denied_atc_prefixes'])),
            'allowed_cis' => self::normalize_cis_list(self::parse_list_input($in['allowed_cis'] ?? $cur['allowed_cis'])),
            'denied_cis' => self::normalize_cis_list(self::parse_list_input($in['denied_cis'] ?? $cur['denied_cis'])),
            'require_evidence' => isset($in['require_evidence']) ? (bool) $in['require_evidence'] : $cur['require_evidence'],
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
        if (self::$mitm_ready_cache !== null) {
            return self::$mitm_ready_cache;
        }

        global $wpdb;
        if (!($wpdb instanceof \wpdb)) {
            self::$mitm_ready_cache = false;
            self::log_mitm_warning('wpdb unavailable');
            return false;
        }

        $table = Db::table('mitm');
        $like = str_replace(['\\', '_', '%'], ['\\\\', '\\_', '\\%'], $table);
        $exists = $wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s', $like));
        if (!is_string($exists) || $exists === '') {
            self::$mitm_ready_cache = false;
            self::log_mitm_warning('table missing');
            return false;
        }

        $one = $wpdb->get_var("SELECT 1 FROM {$table} LIMIT 1");
        if ($one === null) {
            self::$mitm_ready_cache = false;
            self::log_mitm_warning('table empty');
            return false;
        }

        self::$mitm_ready_cache = true;
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
            if ($cis < 1) {
                continue;
            }

            $evaluation = self::evaluate($cis, $atcMap[$cis] ?? null);
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
        $atc_codes = is_array($atc_codes) ? self::normalize_prefixes($atc_codes) : [];

        if ($cis < 1) {
            return [
                'allowed' => false,
                'reason_code' => 'missing_cis',
                'reason' => 'Code CIS manquant.',
                'atc_codes' => $atc_codes,
            ];
        }

        if (in_array($cis, $cfg['denied_cis'], true)) {
            return [
                'allowed' => false,
                'reason_code' => 'cis_denied',
                'reason' => 'Médicament explicitement bloqué par la denylist CIS.',
                'atc_codes' => $atc_codes,
            ];
        }

        if (in_array($cis, $cfg['allowed_cis'], true)) {
            return [
                'allowed' => true,
                'reason_code' => 'cis_allowed',
                'reason' => 'Médicament explicitement autorisé par la allowlist CIS.',
                'atc_codes' => $atc_codes,
            ];
        }

        foreach ($cfg['denied_atc_prefixes'] as $prefix) {
            foreach ($atc_codes as $code) {
                if ($prefix !== '' && str_starts_with($code, $prefix)) {
                    return [
                        'allowed' => false,
                        'reason_code' => 'atc_denied',
                        'reason' => 'Classe ATC explicitement bloquée.',
                        'atc_codes' => $atc_codes,
                    ];
                }
            }
        }

        foreach ($cfg['allowed_atc_prefixes'] as $prefix) {
            foreach ($atc_codes as $code) {
                if ($prefix !== '' && str_starts_with($code, $prefix)) {
                    return [
                        'allowed' => true,
                        'reason_code' => 'atc_allowed',
                        'reason' => 'Classe ATC explicitement autorisée.',
                        'atc_codes' => $atc_codes,
                    ];
                }
            }
        }

        return [
            'allowed' => true,
            'reason_code' => $atc_codes === [] ? 'atc_missing_allow' : 'default_allow',
            'reason' => $atc_codes === []
                ? 'Aucun code ATC disponible : autorisé par défaut.'
                : 'Aucune règle d’interdiction ne correspond : autorisé par défaut.',
            'atc_codes' => $atc_codes,
        ];
    }

    /**
     * @param array<int,string>|null $atc_codes
     * @return array{allowed:bool,reason_code:string,reason:string,atc_codes:array<int,string>}
     */
    public static function evaluate_deny_only(int $cis, ?array $atc_codes = null): array
    {
        $cfg = self::get();
        $cis = max(0, $cis);
        $atc_codes = is_array($atc_codes) ? self::normalize_prefixes($atc_codes) : [];

        if ($cis < 1) {
            return [
                'allowed' => false,
                'reason_code' => 'missing_cis',
                'reason' => 'Code CIS manquant.',
                'atc_codes' => $atc_codes,
            ];
        }

        if (in_array($cis, $cfg['denied_cis'], true)) {
            return [
                'allowed' => false,
                'reason_code' => 'cis_denied',
                'reason' => 'Médicament explicitement bloqué par la denylist CIS.',
                'atc_codes' => $atc_codes,
            ];
        }

        if (in_array($cis, $cfg['allowed_cis'], true)) {
            return [
                'allowed' => true,
                'reason_code' => 'cis_allowed',
                'reason' => 'Médicament explicitement autorisé par la allowlist CIS.',
                'atc_codes' => $atc_codes,
            ];
        }

        foreach ($cfg['denied_atc_prefixes'] as $prefix) {
            foreach ($atc_codes as $code) {
                if ($prefix !== '' && str_starts_with($code, $prefix)) {
                    return [
                        'allowed' => false,
                        'reason_code' => 'atc_denied',
                        'reason' => 'Classe ATC explicitement bloquée.',
                        'atc_codes' => $atc_codes,
                    ];
                }
            }
        }

        return [
            'allowed' => true,
            'reason_code' => $atc_codes === [] ? 'deny_only_atc_missing_allow' : 'deny_only_default_allow',
            'reason' => $atc_codes === []
                ? 'Aucun code ATC disponible : autorisé par défaut.'
                : 'Autorisé par défaut (flow ro_proof).',
            'atc_codes' => $atc_codes,
        ];
    }

    /**
     * @param array<int,string>|null $atc_codes
     * @return array{allowed:bool,reason_code:string,reason:string,atc_codes:array<int,string>}
     */
    public static function evaluate_for_flow(int $cis, ?array $atc_codes, string $flow_key): array
    {
        $flow_key = self::normalize_flow($flow_key);

        if ($flow_key === self::FLOW_DEPANNAGE_NO_PROOF) {
            return self::evaluate($cis, $atc_codes);
        }

        return self::evaluate_deny_only($cis, $atc_codes);
    }

    /**
     * @param array<int,int> $cis_list
     * @return array<int, array<int,string>>
     */
    public static function map_atc_codes_for_cis(array $cis_list): array
    {
        global $wpdb;

        if (!($wpdb instanceof \wpdb)) {
            self::log_mitm_warning('wpdb unavailable');
            return [];
        }

        $cis_list = array_values(array_unique(array_filter(array_map('intval', $cis_list), static fn ($value): bool => $value > 0)));
        if ($cis_list === []) {
            return [];
        }

        if (!self::is_mitm_ready()) {
            return [];
        }

        $table = Db::table('mitm');
        $placeholders = implode(',', array_fill(0, count($cis_list), '%d'));
        $sql = $wpdb->prepare("SELECT cis, code_atc FROM {$table} WHERE cis IN ({$placeholders})", $cis_list);

        if (!is_string($sql) || $sql === '') {
            self::log_mitm_warning('prepare failed');
            return [];
        }

        $rows = $wpdb->get_results($sql, ARRAY_A);
        if (!is_array($rows)) {
            self::log_mitm_warning((string) $wpdb->last_error ?: 'query failed');
            return [];
        }

        if ((string) $wpdb->last_error !== '') {
            self::log_mitm_warning((string) $wpdb->last_error);
            return [];
        }

        $map = [];
        foreach ($rows as $row) {
            $cis = isset($row['cis']) ? (int) $row['cis'] : 0;
            $code = isset($row['code_atc']) ? strtoupper(trim((string) $row['code_atc'])) : '';

            if ($cis < 1 || $code === '') {
                continue;
            }

            if (!isset($map[$cis])) {
                $map[$cis] = [];
            }

            $map[$cis][] = $code;
        }

        foreach ($map as $key => $codes) {
            $map[$key] = array_values(array_unique(self::normalize_prefixes($codes)));
        }

        return $map;
    }

    public static function cis_from_cip13(string $cip13): ?int
    {
        global $wpdb;

        if (!($wpdb instanceof \wpdb)) {
            return null;
        }

        $cip13 = trim($cip13);
        if ($cip13 === '' || preg_match('/^\d{13}$/', $cip13) !== 1) {
            return null;
        }

        $table = Db::table('cip');
        $cis = $wpdb->get_var($wpdb->prepare("SELECT cis FROM {$table} WHERE cip13 = %s LIMIT 1", $cip13));

        if ($cis === null) {
            return null;
        }

        $value = (int) $cis;
        return $value > 0 ? $value : null;
    }

    /**
     * @param mixed $in
     * @return array<int,string>
     */
    private static function parse_list_input($in): array
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
            $string = is_int($value) ? (string) $value : (is_string($value) ? trim($value) : '');
            if ($string === '' || preg_match('/^\d{1,12}$/', $string) !== 1) {
                continue;
            }

            $int = (int) $string;
            if ($int > 0) {
                $out[] = $int;
            }
        }

        return array_values(array_unique($out));
    }

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
        $flow_key = strtolower(trim($flow_key));

        if ($flow_key === self::FLOW_DEPANNAGE_NO_PROOF || $flow_key === 'depannage' || $flow_key === 'no_proof') {
            return self::FLOW_DEPANNAGE_NO_PROOF;
        }

        if ($flow_key === self::FLOW_RO_PROOF || $flow_key === 'ro' || $flow_key === 'renewal') {
            return self::FLOW_RO_PROOF;
        }

        return self::FLOW_RO_PROOF;
    }

    private static function log_mitm_warning(string $detail = ''): void
    {
        if (self::$mitm_warning_logged) {
            return;
        }

        self::$mitm_warning_logged = true;

        $message = '[SOSPrescription] Warning: ATC table empty';
        if ($detail !== '') {
            $message .= ' (' . $detail . ')';
        }

        error_log($message);
    }
}
