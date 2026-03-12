<?php
declare(strict_types=1);

namespace SOSPrescription\Services;

use SOSPrescription\Db;

/**
 * Whitelist / périmètre de médicaments.
 *
 * - Supporte une allowlist (ATC préfixes, CIS) et une denylist (ATC préfixes, CIS).
 * - Utilise la table BDPM "CIS_MITM" (importée dans wp_sosprescription_mitm) pour récupérer les codes ATC.
 * - Contrôle côté API :
 *   - filtrage des suggestions (autocomplete) quand mode = enforce
 *   - blocage à la création de demande quand mode = enforce
 *   - journalisation quand mode = warn
 */
final class Whitelist
{
    public const OPTION_KEY = 'sosprescription_whitelist';

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

        $mode = isset($raw['mode']) && is_string($raw['mode']) ? strtolower(trim($raw['mode'])) : self::defaults()['mode'];
        if (!in_array($mode, ['off', 'warn', 'enforce'], true)) {
            $mode = self::defaults()['mode'];
        }

        $allowed_atc = isset($raw['allowed_atc_prefixes']) && is_array($raw['allowed_atc_prefixes']) ? $raw['allowed_atc_prefixes'] : self::defaults()['allowed_atc_prefixes'];
        $denied_atc  = isset($raw['denied_atc_prefixes']) && is_array($raw['denied_atc_prefixes']) ? $raw['denied_atc_prefixes'] : self::defaults()['denied_atc_prefixes'];
        $allowed_cis = isset($raw['allowed_cis']) && is_array($raw['allowed_cis']) ? $raw['allowed_cis'] : self::defaults()['allowed_cis'];
        $denied_cis  = isset($raw['denied_cis']) && is_array($raw['denied_cis']) ? $raw['denied_cis'] : self::defaults()['denied_cis'];

        $require_evidence = isset($raw['require_evidence']) ? (bool) $raw['require_evidence'] : (bool) self::defaults()['require_evidence'];

        $updated = isset($raw['updated_at']) && is_string($raw['updated_at']) ? (string) $raw['updated_at'] : self::defaults()['updated_at'];

        return [
            'mode' => $mode,
            'allowed_atc_prefixes' => self::normalize_prefixes($allowed_atc),
            'denied_atc_prefixes' => self::normalize_prefixes($denied_atc),
            'allowed_cis' => self::normalize_cis_list($allowed_cis),
            'denied_cis' => self::normalize_cis_list($denied_cis),
            'require_evidence' => $require_evidence,
            'updated_at' => $updated,
        ];
    }

    /**
     * Met à jour la configuration.
     *
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
        $cur = self::get();

        $mode = isset($in['mode']) && is_string($in['mode']) ? strtolower(trim($in['mode'])) : $cur['mode'];
        if (!in_array($mode, ['off', 'warn', 'enforce'], true)) {
            $mode = $cur['mode'];
        }

        $allowed_atc_in = $in['allowed_atc_prefixes'] ?? $cur['allowed_atc_prefixes'];
        $denied_atc_in  = $in['denied_atc_prefixes'] ?? $cur['denied_atc_prefixes'];
        $allowed_cis_in = $in['allowed_cis'] ?? $cur['allowed_cis'];
        $denied_cis_in  = $in['denied_cis'] ?? $cur['denied_cis'];

        $require_evidence = isset($in['require_evidence']) ? (bool) $in['require_evidence'] : $cur['require_evidence'];

        $out = [
            'mode' => $mode,
            'allowed_atc_prefixes' => self::normalize_prefixes(self::parse_list_input($allowed_atc_in)),
            'denied_atc_prefixes' => self::normalize_prefixes(self::parse_list_input($denied_atc_in)),
            'allowed_cis' => self::normalize_cis_list(self::parse_list_input($allowed_cis_in)),
            'denied_cis' => self::normalize_cis_list(self::parse_list_input($denied_cis_in)),
            'require_evidence' => $require_evidence,
            'updated_at' => gmdate('c'),
        ];

        update_option(self::OPTION_KEY, $out, false);

        return $out;
    }

    /**
     * Filtre une liste de résultats de recherche médicament.
     *
     * @param array<int, array<string,mixed>> $items
     * @return array<int, array<string,mixed>>
     */

/**
 * Indique si la configuration whitelist repose sur les codes ATC
 * (donc nécessite que la table CIS_MITM soit présente et remplie).
 */
public static function needs_mitm_for_atc_rules(): bool
{
    $cfg = self::get();
    return !empty($cfg['allowed_atc_prefixes']) || !empty($cfg['denied_atc_prefixes']);
}

/**
 * Vérifie rapidement la disponibilité du mapping CIS -> ATC (table CIS_MITM).
 */
public static function is_mitm_ready(): bool
{
    global $wpdb;

    $table = Db::table('mitm');

    // Vérifie l'existence de la table (certains hébergeurs renvoient NULL au SELECT si table absente).
    $like = str_replace(['\\', '_', '%'], ['\\\\', '\\_', '\\%'], $table);
    // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
    $exists = $wpdb->get_var($wpdb->prepare("SHOW TABLES LIKE %s", $like));

    if (!is_string($exists) || $exists === '') {
        return false;
    }

    // Vérifie qu'il y a au moins une ligne.
    // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
    $one = $wpdb->get_var("SELECT 1 FROM {$table} LIMIT 1");

    return $one !== null;
}

    public static function filter_search_results(array $items): array
    {
        $cfg = self::get();
        if ($cfg['mode'] !== 'enforce') {
            return $items;
        }

        $cis_list = [];
        foreach ($items as $it) {
            if (!is_array($it)) { continue; }
            $cis = isset($it['cis']) ? (int) $it['cis'] : 0;
            if ($cis > 0) { $cis_list[] = $cis; }
        }
        $cis_list = array_values(array_unique($cis_list));
        $atc_map = self::map_atc_codes_for_cis($cis_list);

        $out = [];
        foreach ($items as $it) {
            if (!is_array($it)) { continue; }
            $cis = isset($it['cis']) ? (int) $it['cis'] : 0;
            if ($cis < 1) {
                continue;
            }

            $ev = self::evaluate($cis, $atc_map[$cis] ?? null);
            if ($ev['allowed']) {
                $out[] = $it;
            }
        }

        return $out;
    }

    /**
     * Évalue un médicament (CIS) contre la whitelist.
     *
     * @param array<int,string>|null $atc_codes
     * @return array{allowed:bool, reason_code:string, reason:string, atc_codes:array<int,string>}
     */
    public static function evaluate(int $cis, ?array $atc_codes = null): array
    {
        $cfg = self::get();

        $cis = $cis > 0 ? $cis : 0;
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
                'reason' => 'Médicament explicitement exclu.',
                'atc_codes' => $atc_codes,
            ];
        }

        // Deny ATC (prend le dessus)
        foreach ($cfg['denied_atc_prefixes'] as $pref) {
            foreach ($atc_codes as $code) {
                if ($pref !== '' && str_starts_with($code, $pref)) {
                    return [
                        'allowed' => false,
                        'reason_code' => 'atc_denied',
                        'reason' => 'Classe ATC exclue du service.',
                        'atc_codes' => $atc_codes,
                    ];
                }
            }
        }

        // Allow CIS override
        if (in_array($cis, $cfg['allowed_cis'], true)) {
            return [
                'allowed' => true,
                'reason_code' => 'cis_allowed',
                'reason' => 'Autorisé par override CIS.',
                'atc_codes' => $atc_codes,
            ];
        }

        $has_allow = count($cfg['allowed_atc_prefixes']) > 0 || count($cfg['allowed_cis']) > 0;

        if (!$has_allow) {
            return [
                'allowed' => true,
                'reason_code' => 'no_allowlist',
                'reason' => 'Aucune allowlist configurée.',
                'atc_codes' => $atc_codes,
            ];
        }

        // Allow ATC
        foreach ($cfg['allowed_atc_prefixes'] as $pref) {
            foreach ($atc_codes as $code) {
                if ($pref !== '' && str_starts_with($code, $pref)) {
                    return [
                        'allowed' => true,
                        'reason_code' => 'atc_allowed',
                        'reason' => 'Autorisé par classe ATC.',
                        'atc_codes' => $atc_codes,
                    ];
                }
            }
        }

        return [
            'allowed' => false,
            'reason_code' => 'not_in_scope',
            'reason' => 'Hors périmètre au lancement.',
            'atc_codes' => $atc_codes,
        ];
    }

    /**
     * Récupère les codes ATC pour une liste de CIS.
     *
     * @param array<int,int> $cis_list
     * @return array<int, array<int,string>> map cis => atcCodes[]
     */
    

/**
 * Évalue un médicament selon le "flow" (parcours patient).
 *
 * Objectif UX : la recherche affiche tous les résultats BDPM, mais seuls
 * certains sont sélectionnables selon le périmètre de lancement.
 *
 * Règles (V1.5.28) :
 * - ro_proof : denylist uniquement (on interdit les classes sensibles ; le reste est autorisé).
 * - depannage_no_proof : allowlist + denylist (périmètre plus strict).
 *
 * @param int $cis
 * @param array|null $atc_codes
 * @param string $flow_key
 * @return array{allowed:bool,reason_code:string,reason:string,atc_codes:array}
 */
public static function evaluate_for_flow(int $cis, ?array $atc_codes, string $flow_key): array
{
    $flow_key = strtolower(trim($flow_key));

    if ($flow_key === 'ro_proof') {
        return self::evaluate_deny_only($cis, $atc_codes);
    }

    // Dépannage (sans preuve) = plus strict par défaut
    if ($flow_key === 'depannage_no_proof') {
        return self::evaluate($cis, $atc_codes);
    }

    // Fallback (autres flows) : comportement standard
    return self::evaluate($cis, $atc_codes);
}

/**
 * Mode "denylist only" :
 * - on refuse si CIS explicitement interdit
 * - on refuse si ATC match une prefix denylist
 * - sinon, on autorise (sans exiger une allowlist)
 *
 * @param int $cis
 * @param array|null $atc_codes
 * @return array{allowed:bool,reason_code:string,reason:string,atc_codes:array}
 */
public static function evaluate_deny_only(int $cis, ?array $atc_codes = null): array
{
    $cfg = self::get();

    $cis = max(0, (int) $cis);

    if ($cis < 1) {
        return [
            'allowed' => false,
            'reason_code' => 'missing_cis',
            'reason' => "CIS manquant (impossible d'évaluer le périmètre).",
            'atc_codes' => [],
        ];
    }

    $denied_cis = array_map('intval', $cfg['denied_cis'] ?? []);
    $denied_atc_prefixes = self::normalize_prefixes($cfg['denied_atc_prefixes'] ?? []);

    if (in_array($cis, $denied_cis, true)) {
        return [
            'allowed' => false,
            'reason_code' => 'cis_denied',
            'reason' => 'Médicament interdit (denylist CIS).',
            'atc_codes' => self::normalize_prefixes($atc_codes ?? []),
        ];
    }

    $norm_atc = self::normalize_prefixes($atc_codes ?? []);
    foreach ($denied_atc_prefixes as $p) {
        foreach ($norm_atc as $code) {
            if ($p !== '' && str_starts_with($code, $p)) {
                return [
                    'allowed' => false,
                    'reason_code' => 'atc_denied',
                    'reason' => 'Médicament interdit (denylist ATC).',
                    'atc_codes' => $norm_atc,
                ];
            }
        }
    }

    return [
        'allowed' => true,
        'reason_code' => 'deny_only_ok',
        'reason' => 'Autorisé (RO avec preuve : denylist uniquement).',
        'atc_codes' => $norm_atc,
    ];
}
public static function map_atc_codes_for_cis(array $cis_list): array
    {
        global $wpdb;

        $cis_list = array_values(array_unique(array_filter(array_map('intval', $cis_list), static fn ($v) => $v > 0)));
        if (count($cis_list) < 1) {
            return [];
        }

        $table = Db::table('mitm');
        $placeholders = implode(',', array_fill(0, count($cis_list), '%d'));

        // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        $sql = $wpdb->prepare(
            "SELECT cis, code_atc FROM {$table} WHERE cis IN ({$placeholders})",
            $cis_list
        );

        // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        $rows = $wpdb->get_results($sql, ARRAY_A) ?: [];

        $map = [];
        foreach ($rows as $r) {
            $cis = isset($r['cis']) ? (int) $r['cis'] : 0;
            $code = isset($r['code_atc']) ? strtoupper(trim((string) $r['code_atc'])) : '';
            if ($cis < 1 || $code === '') {
                continue;
            }
            if (!isset($map[$cis])) {
                $map[$cis] = [];
            }
            $map[$cis][] = $code;
        }

        // dédup
        foreach ($map as $k => $codes) {
            $map[$k] = array_values(array_unique(self::normalize_prefixes($codes)));
        }

        return $map;
    }

    /**
     * Résout CIS depuis un CIP13 (si besoin).
     */
    public static function cis_from_cip13(string $cip13): ?int
    {
        global $wpdb;
        $cip13 = trim($cip13);
        if ($cip13 === '' || preg_match('/^\d{13}$/', $cip13) !== 1) {
            return null;
        }

        $table = Db::table('cip');
        // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        $cis = $wpdb->get_var($wpdb->prepare("SELECT cis FROM {$table} WHERE cip13 = %s LIMIT 1", $cip13));
        if ($cis === null) {
            return null;
        }
        $v = (int) $cis;
        return $v > 0 ? $v : null;
    }

    /**
     * Parse une entrée (textarea) ou array en liste.
     *
     * @param mixed $in
     * @return array<int, string>
     */
    private static function parse_list_input(mixed $in): array
    {
        if (is_array($in)) {
            return array_values(array_map(static fn ($v) => is_string($v) || is_numeric($v) ? (string) $v : '', $in));
        }
        if (!is_string($in)) {
            return [];
        }

        $s = str_replace(["\r\n", "\r"], "\n", $in);
        // Split on new lines + common separators.
        $parts = preg_split('/[\n,;\t]+/', $s);
        if (!is_array($parts)) {
            return [];
        }

        $out = [];
        foreach ($parts as $p) {
            $p = trim((string) $p);
            if ($p === '') { continue; }
            $out[] = $p;
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
        foreach ($arr as $v) {
            if (!is_string($v)) { continue; }
            $s = strtoupper(trim($v));
            $s = str_replace([' ', '.', '-'], '', $s);
            if ($s === '') { continue; }
            if (preg_match('/^[A-Z0-9]{1,10}$/', $s) !== 1) {
                continue;
            }
            $out[] = $s;
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
        foreach ($arr as $v) {
            $s = is_int($v) ? (string) $v : (is_string($v) ? trim($v) : '');
            if ($s === '' || preg_match('/^\d{1,12}$/', $s) !== 1) {
                continue;
            }
            $n = (int) $s;
            if ($n > 0) {
                $out[] = $n;
            }
        }
        return array_values(array_unique($out));
    }

    /**
     * @return array{mode:string, allowed_atc_prefixes:array<int,string>, denied_atc_prefixes:array<int,string>, allowed_cis:array<int,int>, denied_cis:array<int,int>, require_evidence:bool, updated_at:string}
     */
    private static function defaults(): array
    {
        // Par défaut : périmètre restreint (enforce) et preuve obligatoire.
        // Les préfixes ATC ci-dessous sont des suggestions "safe" pour un lancement RO/continuité.
        return [
            'mode' => 'enforce',

            // Allowlist (à affiner) :
            // - G03A : contraceptifs hormonaux systémiques
            // - H03A : hormones thyroïdiennes
            // - R06 : antihistaminiques
            // - R03 : asthme/BPCO (inhalateurs)
            // - A02BC : inhibiteurs de la pompe à protons
            // - C10AA : statines
            // - C09 : IEC/ARA2 (à valider selon votre politique médicale)
            // - N02BE : paracétamol (utile pour tests et prescriptions de confort remboursables)
            //   NB: on exclut volontairement les opioïdes (N02A) et les classes à risque.
            'allowed_atc_prefixes' => ['G03A', 'H03A', 'R06', 'R03', 'A02BC', 'C10AA', 'C09', 'N02BE'],

            // Denylist indicative (prioritaire) :
            // - N02A : opioïdes
            // - N05B : anxiolytiques
            // - N05C : hypnotiques/sédatifs
            // - N06B : psychostimulants
            'denied_atc_prefixes' => ['N02A', 'N05B', 'N05C', 'N06B'],

            'allowed_cis' => [],
            'denied_cis' => [],
            'require_evidence' => true,
            'updated_at' => gmdate('c'),
        ];
    }
}
