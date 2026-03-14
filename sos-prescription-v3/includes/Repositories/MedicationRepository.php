<?php
declare(strict_types=1);

namespace SOSPrescription\Repositories;

use SOSPrescription\Db;

final class MedicationRepository
{
    /**
     * @return array<int, array<string, mixed>>
     */
    public function search(string $q, int $limit = 20): array
    {
        global $wpdb;

        $q = trim($q);
        if ($q === '') {
            return [];
        }

        $limit = max(1, min(50, $limit));

        $cisTable = Db::table('cis');
        $cipTable = Db::table('cip');

        $hasCis = $this->table_exists($cisTable);
        $hasCip = $this->table_exists($cipTable);

        if (!$hasCis && !$hasCip) {
            return [];
        }

        $digits = ctype_digit($q);
        $len = strlen($q);
        $where = [];
        $params = [];
        $like = '%' . $wpdb->esc_like($q) . '%';

        if ($hasCip) {
            if ($hasCis) {
                $where[] = '(c.denomination LIKE %s OR p.libelle_presentation LIKE %s)';
                $params[] = $like;
                $params[] = $like;
            } else {
                $where[] = '(p.libelle_presentation LIKE %s)';
                $params[] = $like;
            }
        } else {
            $where[] = '(c.denomination LIKE %s)';
            $params[] = $like;
        }

        if ($digits) {
            if ($len === 7 && $hasCip) {
                $where[] = 'p.cip7 = %s';
                $params[] = $q;
            } elseif ($len === 13 && $hasCip) {
                $where[] = 'p.cip13 = %s';
                $params[] = $q;
            } elseif ($len >= 6 && $len <= 9) {
                if ($hasCip) {
                    $where[] = 'p.cis = %d';
                    $params[] = (int) $q;
                } else {
                    $where[] = 'c.cis = %d';
                    $params[] = (int) $q;
                }
            }
        }

        $whereSql = implode(' OR ', array_map(static fn ($w) => '(' . $w . ')', $where));
        $fetchLimit = min(200, $limit * 4);

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
                            WHEN p.cip13 IS NOT NULL AND p.cip13 <> '' THEN 0
                            ELSE 1
                        END,
                        {$orderName} ASC,
                        p.libelle_presentation ASC
                    LIMIT %d";

            $prepared = $wpdb->prepare($sql, array_merge($params, [$fetchLimit]));
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
                    ORDER BY c.denomination ASC
                    LIMIT %d";

            $prepared = $wpdb->prepare($sql, array_merge($params, [$fetchLimit]));
            $rows = $wpdb->get_results($prepared, ARRAY_A) ?: [];
        }

        $out = [];
        foreach ($rows as $row) {
            $cis = (string) ($row['cis'] ?? '');
            $denom = (string) ($row['denomination'] ?? '');
            $cip13 = isset($row['cip13']) ? (string) $row['cip13'] : '';
            $cip7 = isset($row['cip7']) ? (string) $row['cip7'] : '';
            $lib = isset($row['libelle_presentation']) ? (string) $row['libelle_presentation'] : '';
            $taux = isset($row['taux_remboursement']) ? (string) $row['taux_remboursement'] : '';
            $prix = $row['prix_ttc'] !== null && $row['prix_ttc'] !== '' ? (float) $row['prix_ttc'] : null;

            $label = $denom !== '' ? $denom : ($lib !== '' ? $lib : 'Medicement');
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
            ];
        }

        $seen = [];
        $uniq = [];
        foreach ($out as $item) {
            $key = $item['cip13'] !== '' ? ('cip13:' . $item['cip13']) : ('label:' . mb_strtolower((string) $item['label']));
            if (isset($seen[$key])) {
                continue;
            }
            $seen[$key] = true;
            $uniq[] = $item;
            if (count($uniq) >= $limit) {
                break;
            }
        }

        return $uniq;
    }

    /**
     * @return array{items:array<int, array<string, mixed>>, total:int, page:int, perPage:int}
     */
    public function table(string $q, int $page, int $perPage): array
    {
        global $wpdb;

        $q = trim($q);
        if ($q === '') {
            return ['items' => [], 'total' => 0, 'page' => 1, 'perPage' => $perPage];
        }

        $page = $page < 1 ? 1 : $page;
        $perPage = max(10, min(50, $perPage));
        $offset = max(0, ($page - 1) * $perPage);

        $cisTable = Db::table('cis');
        $cipTable = Db::table('cip');

        $where = [];
        $params = [];
        $digits = ctype_digit($q);
        $len = strlen($q);

        if ($digits) {
            if ($len === 13) {
                $where[] = 'p.cip13 = %s';
                $params[] = $q;
            } elseif ($len === 7) {
                $where[] = 'p.cip7 = %s';
                $params[] = $q;
            } elseif ($len >= 6 && $len <= 9) {
                $where[] = 'p.cis = %d';
                $params[] = (int) $q;
            }
        }

        if (empty($where)) {
            $like = $wpdb->esc_like($q) . '%';
            $where[] = '(c.denomination LIKE %s OR p.libelle_presentation LIKE %s)';
            $params[] = $like;
            $params[] = $like;
        }

        $whereSql = 'WHERE ' . implode(' AND ', $where);

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
}
