<?php
declare(strict_types=1);

namespace SOSPrescription\Repositories;

use SOSPrescription\Db;

final class MedicationRepository
{
    private const FUZZY_FETCH_LIMIT = 120;

    /**
     * @return array<int, array<string, mixed>>
     */
    public function search(string $q, int $limit = 20): array
    {
        $result = $this->searchWithMeta($q, $limit);
        return $result['items'];
    }

    /**
     * @return array{items:array<int, array<string, mixed>>, mode:string, raw_count:int, candidate_count:int}
     */
    public function searchWithMeta(string $q, int $limit = 20): array
    {
        $limit = max(1, min(50, $limit));
        $query = trim($q);
        if ($query === '') {
            return [
                'items' => [],
                'mode' => 'empty',
                'raw_count' => 0,
                'candidate_count' => 0,
            ];
        }

        $queryNorm = $this->normalizeSearchLabel($query);
        $digits = ctype_digit($query);

        $exactCandidates = $this->searchSqlCandidates($query, max($limit * 4, 40));
        $candidates = $exactCandidates;
        $mode = $digits ? 'exact-digit' : 'exact';

        if (!$digits && $queryNorm !== '' && self::str_len($queryNorm) >= 3) {
            if (count($candidates) < $limit || !$this->hasStrongExactCandidate($queryNorm, $candidates)) {
                $fuzzyCandidates = $this->searchGramCandidates($queryNorm, max($limit * 5, self::FUZZY_FETCH_LIMIT));
                if ($fuzzyCandidates !== []) {
                    $candidates = $this->mergeCandidates($candidates, $fuzzyCandidates);
                    $mode = $exactCandidates !== [] ? 'hybrid' : 'fuzzy';
                }
            }
        }

        $ranked = $this->rankCandidates($query, $queryNorm, $candidates, $limit);

        return [
            'items' => $ranked,
            'mode' => $mode,
            'raw_count' => count($exactCandidates),
            'candidate_count' => count($candidates),
        ];
    }

    /**
     * @return array{items:array<int, array<string, mixed>>, total:int, page:int, perPage:int}
     */
    public function table(string $q, int $page, int $perPage): array
    {
        global $wpdb;

        $query = trim($q);
        $page = max(1, $page);
        $perPage = max(10, min(50, $perPage));

        if ($query === '') {
            return ['items' => [], 'total' => 0, 'page' => 1, 'perPage' => $perPage];
        }

        $cisTable = Db::table('cis');
        $cipTable = Db::table('cip');

        if (!$this->table_exists($cipTable) || !$this->table_exists($cisTable)) {
            return ['items' => [], 'total' => 0, 'page' => 1, 'perPage' => $perPage];
        }

        $offset = max(0, ($page - 1) * $perPage);
        $params = [];
        $whereParts = [];
        $digits = ctype_digit($query);
        $len = strlen($query);

        if ($digits) {
            if ($len === 13) {
                $whereParts[] = 'p.cip13 = %s';
                $params[] = $query;
            } elseif ($len === 7) {
                $whereParts[] = 'p.cip7 = %s';
                $params[] = $query;
            } elseif ($len >= 6 && $len <= 9) {
                $whereParts[] = 'p.cis = %d';
                $params[] = (int) $query;
            }
        }

        if ($whereParts === []) {
            $like = '%' . $wpdb->esc_like($query) . '%';
            $whereParts[] = '(c.denomination LIKE %s OR p.libelle_presentation LIKE %s)';
            $params[] = $like;
            $params[] = $like;
        }

        $whereSql = 'WHERE ' . implode(' AND ', $whereParts);

        $countSql = "SELECT COUNT(*)
                     FROM {$cipTable} p
                     LEFT JOIN {$cisTable} c ON c.cis = p.cis
                     {$whereSql}";
        $total = (int) $wpdb->get_var($wpdb->prepare($countSql, $params));

        if ($total > 0) {
            $maxPage = (int) ceil($total / $perPage);
            if ($page > $maxPage) {
                $page = $maxPage;
                $offset = max(0, ($page - 1) * $perPage);
            }
        }

        $sql = "SELECT
                    p.cis,
                    c.denomination,
                    p.libelle_presentation,
                    p.cip13,
                    p.cip7,
                    p.taux_remboursement,
                    p.prix_ttc
                FROM {$cipTable} p
                LEFT JOIN {$cisTable} c ON c.cis = p.cis
                {$whereSql}
                ORDER BY c.denomination ASC, p.libelle_presentation ASC
                LIMIT %d OFFSET %d";

        $prepared = $wpdb->prepare($sql, array_merge($params, [$perPage, $offset]));
        $rows = $wpdb->get_results($prepared, ARRAY_A) ?: [];

        $items = [];
        foreach ($rows as $row) {
            $items[] = [
                'cis' => isset($row['cis']) ? (string) $row['cis'] : '',
                'denomination' => isset($row['denomination']) ? (string) $row['denomination'] : '',
                'libelle_presentation' => isset($row['libelle_presentation']) ? (string) $row['libelle_presentation'] : '',
                'cip13' => isset($row['cip13']) ? (string) $row['cip13'] : '',
                'cip7' => isset($row['cip7']) ? (string) $row['cip7'] : '',
                'taux_remboursement' => isset($row['taux_remboursement']) ? (string) $row['taux_remboursement'] : '',
                'prix_ttc' => $row['prix_ttc'] !== null && $row['prix_ttc'] !== '' ? (float) $row['prix_ttc'] : null,
            ];
        }

        return [
            'items' => $items,
            'total' => $total,
            'page' => $page,
            'perPage' => $perPage,
        ];
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private function searchSqlCandidates(string $query, int $limit): array
    {
        global $wpdb;

        $cisTable = Db::table('cis');
        $cipTable = Db::table('cip');

        $hasCis = $this->table_exists($cisTable);
        $hasCip = $this->table_exists($cipTable);
        if (!$hasCis && !$hasCip) {
            return [];
        }

        $digits = ctype_digit($query);
        $len = strlen($query);
        $where = [];
        $params = [];
        $like = '%' . $wpdb->esc_like($query) . '%';
        $prefix = $wpdb->esc_like($query) . '%';

        if ($hasCip) {
            if ($hasCis) {
                $where[] = '(c.denomination LIKE %s OR p.libelle_presentation LIKE %s OR c.denomination LIKE %s OR p.libelle_presentation LIKE %s)';
                array_push($params, $like, $like, $prefix, $prefix);
            } else {
                $where[] = '(p.libelle_presentation LIKE %s OR p.libelle_presentation LIKE %s)';
                array_push($params, $like, $prefix);
            }
        } else {
            $where[] = '(c.denomination LIKE %s OR c.denomination LIKE %s)';
            array_push($params, $like, $prefix);
        }

        if ($digits) {
            if ($len === 7 && $hasCip) {
                $where[] = 'p.cip7 = %s';
                $params[] = $query;
            } elseif ($len === 13 && $hasCip) {
                $where[] = 'p.cip13 = %s';
                $params[] = $query;
            } elseif ($len >= 6 && $len <= 9) {
                if ($hasCip) {
                    $where[] = 'p.cis = %d';
                    $params[] = (int) $query;
                } else {
                    $where[] = 'c.cis = %d';
                    $params[] = (int) $query;
                }
            }
        }

        $whereSql = implode(' OR ', array_map(static fn(string $clause): string => '(' . $clause . ')', $where));
        $fetchLimit = max(10, min(250, $limit));

        if ($hasCip) {
            $selectDenom = $hasCis ? 'c.denomination' : 'NULL AS denomination';
            $joinCis = $hasCis ? "LEFT JOIN {$cisTable} c ON c.cis = p.cis" : '';
            $orderName = $hasCis ? 'COALESCE(c.denomination, p.libelle_presentation)' : 'p.libelle_presentation';

            $sql = "SELECT
                        p.cis,
                        {$selectDenom},
                        p.cip13,
                        p.cip7,
                        p.libelle_presentation,
                        p.taux_remboursement,
                        p.prix_ttc
                    FROM {$cipTable} p
                    {$joinCis}
                    WHERE {$whereSql}
                    ORDER BY
                        CASE
                            WHEN p.cip13 = %s OR p.cip7 = %s THEN 0
                            WHEN {$orderName} LIKE %s THEN 1
                            ELSE 2
                        END,
                        {$orderName} ASC,
                        p.libelle_presentation ASC
                    LIMIT %d";

            $prepared = $wpdb->prepare($sql, array_merge($params, [$query, $query, $prefix, $fetchLimit]));
            $rows = $wpdb->get_results($prepared, ARRAY_A) ?: [];
        } else {
            $sql = "SELECT
                        c.cis,
                        c.denomination,
                        NULL AS cip13,
                        NULL AS cip7,
                        NULL AS libelle_presentation,
                        NULL AS taux_remboursement,
                        NULL AS prix_ttc
                    FROM {$cisTable} c
                    WHERE {$whereSql}
                    ORDER BY
                        CASE
                            WHEN c.cis = %d THEN 0
                            WHEN c.denomination LIKE %s THEN 1
                            ELSE 2
                        END,
                        c.denomination ASC
                    LIMIT %d";

            $prepared = $wpdb->prepare($sql, array_merge($params, [(int) $query, $prefix, $fetchLimit]));
            $rows = $wpdb->get_results($prepared, ARRAY_A) ?: [];
        }

        return $this->rowsToItems($rows);
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private function searchGramCandidates(string $queryNorm, int $limit): array
    {
        global $wpdb;

        $gramsTable = Db::table('medication_grams');
        if (!$this->table_exists($gramsTable)) {
            return [];
        }

        $grams = $this->buildTrigrams($queryNorm);
        if ($grams === []) {
            return [];
        }

        $placeholders = implode(',', array_fill(0, count($grams), '%s'));
        $sql = "SELECT
                    source_type,
                    cis,
                    cip13,
                    cip7,
                    label,
                    specialite,
                    taux_remboursement,
                    prix_ttc,
                    label_norm,
                    COUNT(*) AS gram_hits
                FROM {$gramsTable}
                WHERE gram IN ({$placeholders})
                GROUP BY source_type, cis, cip13, cip7, label, specialite, taux_remboursement, prix_ttc, label_norm
                ORDER BY gram_hits DESC, CHAR_LENGTH(label_norm) ASC, label ASC
                LIMIT %d";

        $prepared = $wpdb->prepare($sql, array_merge($grams, [max(10, min(250, $limit))]));
        $rows = $wpdb->get_results($prepared, ARRAY_A) ?: [];

        $items = [];
        foreach ($rows as $row) {
            $items[] = [
                'type' => isset($row['source_type']) && $row['source_type'] === 'presentation' ? 'presentation' : 'specialite',
                'cis' => isset($row['cis']) ? (string) $row['cis'] : '',
                'cip13' => isset($row['cip13']) ? (string) $row['cip13'] : '',
                'cip7' => isset($row['cip7']) ? (string) $row['cip7'] : '',
                'label' => isset($row['label']) && trim((string) $row['label']) !== '' ? (string) $row['label'] : 'Médicament',
                'specialite' => isset($row['specialite']) ? (string) $row['specialite'] : '',
                'tauxRemb' => isset($row['taux_remboursement']) ? (string) $row['taux_remboursement'] : '',
                'prixTTC' => $row['prix_ttc'] !== null && $row['prix_ttc'] !== '' ? (float) $row['prix_ttc'] : null,
                '_label_norm' => isset($row['label_norm']) ? (string) $row['label_norm'] : '',
                '_gram_hits' => isset($row['gram_hits']) ? (int) $row['gram_hits'] : 0,
            ];
        }

        return $items;
    }

    /**
     * @param array<int, array<string, mixed>> $rows
     * @return array<int, array<string, mixed>>
     */
    private function rowsToItems(array $rows): array
    {
        $out = [];
        foreach ($rows as $row) {
            $cis = (string) ($row['cis'] ?? '');
            $denom = (string) ($row['denomination'] ?? '');
            $cip13 = isset($row['cip13']) ? (string) $row['cip13'] : '';
            $cip7 = isset($row['cip7']) ? (string) $row['cip7'] : '';
            $lib = isset($row['libelle_presentation']) ? (string) $row['libelle_presentation'] : '';
            $taux = isset($row['taux_remboursement']) ? (string) $row['taux_remboursement'] : '';
            $prix = $row['prix_ttc'] !== null && $row['prix_ttc'] !== '' ? (float) $row['prix_ttc'] : null;

            $label = $denom !== '' ? $denom : ($lib !== '' ? $lib : 'Médicament');
            $type = $cip13 !== '' ? 'presentation' : 'specialite';

            $out[] = [
                'type' => $type,
                'cis' => $cis,
                'cip13' => $cip13,
                'cip7' => $cip7,
                'label' => $label,
                'specialite' => $lib !== '' ? $lib : $denom,
                'tauxRemb' => $taux,
                'prixTTC' => $prix,
                '_label_norm' => $this->normalizeSearchLabel($label . ' ' . ($lib !== '' ? $lib : $denom)),
                '_gram_hits' => 0,
            ];
        }

        return $out;
    }

    /**
     * @param array<int, array<string, mixed>> $left
     * @param array<int, array<string, mixed>> $right
     * @return array<int, array<string, mixed>>
     */
    private function mergeCandidates(array $left, array $right): array
    {
        $merged = [];
        $seen = [];

        foreach (array_merge($left, $right) as $item) {
            $key = $this->candidateKey($item);
            if (!isset($merged[$key])) {
                $merged[$key] = $item;
                $seen[$key] = true;
                continue;
            }

            $existingHits = isset($merged[$key]['_gram_hits']) ? (int) $merged[$key]['_gram_hits'] : 0;
            $incomingHits = isset($item['_gram_hits']) ? (int) $item['_gram_hits'] : 0;
            if ($incomingHits > $existingHits) {
                $merged[$key] = array_merge($merged[$key], $item);
            }
        }

        return array_values($merged);
    }

    /**
     * @param array<int, array<string, mixed>> $candidates
     * @return array<int, array<string, mixed>>
     */
    private function rankCandidates(string $query, string $queryNorm, array $candidates, int $limit): array
    {
        $scores = [];
        foreach ($candidates as $item) {
            $scores[] = [
                'score' => $this->scoreCandidate($query, $queryNorm, $item),
                'item' => $item,
            ];
        }

        usort($scores, static function (array $a, array $b): int {
            $delta = ($b['score'] <=> $a['score']);
            if ($delta !== 0) {
                return $delta;
            }

            $aLabel = mb_strtolower((string) (($a['item']['label'] ?? '') ?: ''), 'UTF-8');
            $bLabel = mb_strtolower((string) (($b['item']['label'] ?? '') ?: ''), 'UTF-8');
            return $aLabel <=> $bLabel;
        });

        $out = [];
        $seen = [];
        foreach ($scores as $entry) {
            $item = $entry['item'];
            $key = $this->candidateKey($item);
            if (isset($seen[$key])) {
                continue;
            }
            $seen[$key] = true;
            unset($item['_label_norm'], $item['_gram_hits']);
            $out[] = $item;
            if (count($out) >= $limit) {
                break;
            }
        }

        return $out;
    }

    /**
     * @param array<string, mixed> $item
     */
    private function scoreCandidate(string $query, string $queryNorm, array $item): int
    {
        $label = trim((string) ($item['label'] ?? ''));
        $specialite = trim((string) ($item['specialite'] ?? ''));
        $labelNorm = trim((string) ($item['_label_norm'] ?? $this->normalizeSearchLabel($label . ' ' . $specialite)));
        $bestNorm = $this->bestComparableNorm($labelNorm, $queryNorm);
        $gramHits = isset($item['_gram_hits']) ? (int) $item['_gram_hits'] : 0;
        $score = 0;

        $digits = ctype_digit($query);
        if ($digits) {
            $cis = trim((string) ($item['cis'] ?? ''));
            $cip13 = trim((string) ($item['cip13'] ?? ''));
            $cip7 = trim((string) ($item['cip7'] ?? ''));
            if ($query !== '' && ($query === $cip13 || $query === $cip7 || $query === $cis)) {
                $score += 5000;
            }
        }

        if ($queryNorm !== '') {
            if ($bestNorm === $queryNorm) {
                $score += 2200;
            }
            if (str_starts_with($bestNorm, $queryNorm)) {
                $score += 1200;
            }
            if (str_contains($bestNorm, $queryNorm)) {
                $score += 700;
            }

            $tokens = preg_split('/\s+/u', $bestNorm) ?: [];
            foreach ($tokens as $token) {
                if ($token !== '' && str_starts_with($token, $queryNorm)) {
                    $score += 180;
                    break;
                }
            }

            $lev = $this->safeLevenshtein($queryNorm, $bestNorm);
            if ($lev !== null) {
                $score += max(0, 500 - ($lev * 55));
            }

            if (self::str_len($queryNorm) >= 4 && soundex($queryNorm) === soundex($bestNorm)) {
                $score += 90;
            }
        }

        $score += max(0, $gramHits) * 40;
        if (($item['type'] ?? '') === 'presentation' && !empty($item['cip13'])) {
            $score += 20;
        }

        return $score;
    }

    /**
     * @param array<string, mixed> $item
     */
    private function candidateKey(array $item): string
    {
        $cip13 = trim((string) ($item['cip13'] ?? ''));
        if ($cip13 !== '') {
            return 'cip13:' . $cip13;
        }

        $cis = trim((string) ($item['cis'] ?? ''));
        $type = trim((string) ($item['type'] ?? 'specialite'));
        $label = mb_strtolower(trim((string) ($item['label'] ?? '')), 'UTF-8');
        return $type . ':' . $cis . ':' . $label;
    }

    /**
     * @param array<int, array<string, mixed>> $candidates
     */
    private function hasStrongExactCandidate(string $queryNorm, array $candidates): bool
    {
        foreach ($candidates as $candidate) {
            $label = $this->normalizeSearchLabel((string) (($candidate['label'] ?? '') . ' ' . ($candidate['specialite'] ?? '')));
            if ($label === $queryNorm || str_starts_with($label, $queryNorm)) {
                return true;
            }
        }
        return false;
    }

    private function bestComparableNorm(string $labelNorm, string $queryNorm): string
    {
        $tokens = preg_split('/\s+/u', $labelNorm) ?: [];
        $best = $labelNorm;
        $bestDistance = PHP_INT_MAX;

        foreach ($tokens as $token) {
            $token = trim($token);
            if ($token === '') {
                continue;
            }
            $distance = $this->safeLevenshtein($queryNorm, $token);
            if ($distance !== null && $distance < $bestDistance) {
                $bestDistance = $distance;
                $best = $token;
            }
        }

        return $best;
    }

    private function safeLevenshtein(string $left, string $right): ?int
    {
        $left = trim($left);
        $right = trim($right);
        if ($left === '' || $right === '') {
            return null;
        }

        $left = self::str_sub($left, 0, 80);
        $right = self::str_sub($right, 0, 80);

        if ($this->supportsLevenshtein()) {
            return levenshtein($left, $right);
        }

        return null;
    }

    private function supportsLevenshtein(): bool
    {
        static $supported = null;
        if ($supported !== null) {
            return $supported;
        }
        $supported = function_exists('levenshtein');
        return $supported;
    }

    /**
     * @return array<int, string>
     */
    private function buildTrigrams(string $normalizedLabel): array
    {
        $label = trim($normalizedLabel);
        if ($label === '') {
            return [];
        }

        $work = '  ' . $label . '  ';
        $grams = [];
        $len = self::str_len($work);
        if ($len < 3) {
            return [str_pad($work, 3, ' ', STR_PAD_RIGHT)];
        }

        for ($i = 0; $i <= $len - 3; $i += 1) {
            $gram = self::str_sub($work, $i, 3);
            if (trim($gram) === '') {
                continue;
            }
            $grams[$gram] = $gram;
        }

        return array_values($grams);
    }

    private function normalizeSearchLabel(string $value): string
    {
        $value = trim($value);
        if ($value === '') {
            return '';
        }

        if (function_exists('remove_accents')) {
            $value = remove_accents($value);
        }

        if (function_exists('mb_strtolower')) {
            $value = mb_strtolower($value, 'UTF-8');
        } else {
            $value = strtolower($value);
        }

        $value = preg_replace('/[^a-z0-9]+/u', ' ', $value) ?? $value;
        $value = preg_replace('/\s+/u', ' ', $value) ?? $value;
        return trim($value);
    }

    private function table_exists(string $table): bool
    {
        global $wpdb;

        static $cache = [];
        if (array_key_exists($table, $cache)) {
            return (bool) $cache[$table];
        }

        $sql = $wpdb->prepare('SHOW TABLES LIKE %s', $table);
        $found = $wpdb->get_var($sql);
        $exists = is_string($found) && $found !== '';
        $cache[$table] = $exists;

        return $exists;
    }

    private static function str_len(string $value): int
    {
        return function_exists('mb_strlen') ? (int) mb_strlen($value, 'UTF-8') : strlen($value);
    }

    private static function str_sub(string $value, int $start, int $length): string
    {
        if (function_exists('mb_substr')) {
            return (string) mb_substr($value, $start, $length, 'UTF-8');
        }

        return (string) substr($value, $start, $length);
    }
}
