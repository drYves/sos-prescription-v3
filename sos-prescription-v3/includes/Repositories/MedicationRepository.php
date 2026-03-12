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

    // Safety : limiter le volume (autocomplete).
    $limit = max(1, min(50, $limit));

    $cis_table = Db::table('cis');
    $cip_table = Db::table('cip');

    $has_cis = $this->table_exists($cis_table);
    $has_cip = $this->table_exists($cip_table);

    if (!$has_cis && !$has_cip) {
        return [];
    }

    $digits = ctype_digit($q);
    $len = strlen($q);

    $where = [];
    $params = [];

    $like = '%' . $wpdb->esc_like($q) . '%';

    // Requête texte : chercher dans libellé présentation + (si dispo) dénomination.
    if ($has_cip) {
        if ($has_cis) {
            $where[] = '(c.denomination LIKE %s OR p.libelle_presentation LIKE %s)';
            $params[] = $like;
            $params[] = $like;
        } else {
            $where[] = '(p.libelle_presentation LIKE %s)';
            $params[] = $like;
        }
    } else {
        // Fallback rare : pas de table CIP => recherche CIS uniquement.
        $where[] = '(c.denomination LIKE %s)';
        $params[] = $like;
    }

    // Requêtes code (CIP7/CIP13/CIS).
    if ($digits) {
        if ($len === 7 && $has_cip) {
            $where[] = 'p.cip7 = %s';
            $params[] = $q;
        } elseif ($len === 13 && $has_cip) {
            $where[] = 'p.cip13 = %s';
            $params[] = $q;
        } elseif ($len >= 6 && $len <= 9) {
            // CIS : si CIP existe on filtre sur p.cis (car base table CIP),
            // sinon fallback sur c.cis.
            if ($has_cip) {
                $where[] = 'p.cis = %d';
                $params[] = (int) $q;
            } else {
                $where[] = 'c.cis = %d';
                $params[] = (int) $q;
            }
        }
    }

    $where_sql = implode(' OR ', array_map(static fn($w) => '(' . $w . ')', $where));

    // On peut récupérer un peu plus que $limit (pour déduplication).
    $fetch_limit = min(200, $limit * 4);

    if ($has_cip) {
        $select_denom = $has_cis ? 'c.denomination' : 'NULL AS denomination';
        $join_cis = $has_cis ? "LEFT JOIN {$cis_table} c ON c.cis = p.cis" : '';
        $order_name = $has_cis ? 'COALESCE(c.denomination, p.libelle_presentation)' : 'p.libelle_presentation';

        $sql = "SELECT
                    p.cis,
                    {$select_denom},
                    p.cip13,
                    p.cip7,
                    p.libelle_presentation,
                    p.taux_remboursement,
                    p.prix_ttc
                FROM {$cip_table} p
                {$join_cis}
                WHERE {$where_sql}
                ORDER BY
                    CASE
                        WHEN p.cip13 IS NOT NULL AND p.cip13 <> '' THEN 0
                        ELSE 1
                    END,
                    {$order_name} ASC,
                    p.libelle_presentation ASC
                LIMIT %d";

        $params_query = array_merge($params, [$fetch_limit]);

        // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        $prepared = $wpdb->prepare($sql, $params_query);
        // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        $rows = $wpdb->get_results($prepared, ARRAY_A) ?: [];
    } else {
        // Fallback CIS (sans table CIP)
        $sql = "SELECT
                    c.cis,
                    c.denomination,
                    NULL AS cip13,
                    NULL AS cip7,
                    NULL AS libelle_presentation,
                    NULL AS taux_remboursement,
                    NULL AS prix_ttc
                FROM {$cis_table} c
                WHERE {$where_sql}
                ORDER BY c.denomination ASC
                LIMIT %d";

        $params_query = array_merge($params, [$fetch_limit]);

        // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        $prepared = $wpdb->prepare($sql, $params_query);
        // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        $rows = $wpdb->get_results($prepared, ARRAY_A) ?: [];
    }

    $out = [];

    foreach ($rows as $r) {
        $cis = (string) ($r['cis'] ?? '');
        $denom = (string) ($r['denomination'] ?? '');
        $cip13 = isset($r['cip13']) ? (string) $r['cip13'] : '';
        $cip7  = isset($r['cip7']) ? (string) $r['cip7'] : '';
        $lib = isset($r['libelle_presentation']) ? (string) $r['libelle_presentation'] : '';
        $taux = isset($r['taux_remboursement']) ? (string) $r['taux_remboursement'] : '';
        $prix = $r['prix_ttc'] !== null && $r['prix_ttc'] !== '' ? (float) $r['prix_ttc'] : null;

        // IMPORTANT UX : on veut afficher en priorité le nom de la spécialité
        // (ex: "DUPHASTON 10 mg, comprimé pelliculé").
        // Le libellé de présentation (packaging) est utile en sous-info.
        //
        // Côté front, l'app affiche :
        // - it.label en titre
        // - it.specialite en sous-titre
        // Donc :
        // - label = dénomination (spécialité) si disponible, sinon libellé présentation
        // - specialite = libellé présentation (si dispo) sinon dénomination
        $label = $denom !== '' ? $denom : ($lib !== '' ? $lib : 'Médicament');
        $type = ($cip13 !== '') ? 'presentation' : 'specialite';

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

    // Déduplication basique (cip13 ou label) pour l'autocomplétion.
    $seen = [];
    $uniq = [];
    foreach ($out as $it) {
        $k = ($it['cip13'] !== '') ? ('cip13:' . $it['cip13']) : ('label:' . mb_strtolower((string) $it['label']));
        if (isset($seen[$k])) {
            continue;
        }
        $seen[$k] = true;
        $uniq[] = $it;
        if (count($uniq) >= $limit) {
            break;
        }
    }

    return $uniq;
}


    /**
     * Recherche paginée pour le tableau BDPM.
     *
     * @return array{items:array<int, array<string,mixed>>, total:int, page:int, perPage:int}
     */
    public function table(string $q, int $page, int $perPage): array
    {
        global $wpdb;

        $q = trim($q);
        if ($q === '') {
            return ['items' => [], 'total' => 0, 'page' => 1, 'perPage' => $perPage];
        }

        $page = $page < 1 ? 1 : $page;
        $perPage = $perPage < 10 ? 10 : $perPage;
        if ($perPage > 50) { $perPage = 50; }

        $offset = ($page - 1) * $perPage;
        if ($offset < 0) { $offset = 0; }

        $cis_table = Db::table('cis');
        $cip_table = Db::table('cip');

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
            // Préfixe (performant avec index sur c.denomination).
            $like = $wpdb->esc_like($q) . '%';
            $where[] = '(c.denomination LIKE %s OR p.libelle_presentation LIKE %s)';
            $params[] = $like;
            $params[] = $like;
        }

        $where_sql = 'WHERE ' . implode(' AND ', $where);

        $count_sql = "SELECT COUNT(*)
                      FROM {$cip_table} p
                      LEFT JOIN {$cis_table} c ON c.cis = p.cis
                      {$where_sql}";

        // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        $total = (int) $wpdb->get_var($wpdb->prepare($count_sql, $params));

        // Ajuste page si hors bornes.
        if ($total > 0) {
            $maxPage = (int) ceil($total / $perPage);
            if ($page > $maxPage) {
                $page = $maxPage;
                $offset = ($page - 1) * $perPage;
                if ($offset < 0) { $offset = 0; }
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
                FROM {$cip_table} p
                LEFT JOIN {$cis_table} c ON c.cis = p.cis
                {$where_sql}
                ORDER BY c.denomination ASC, p.libelle_presentation ASC
                LIMIT %d OFFSET %d";

        $query_params = array_merge($params, [$perPage, $offset]);

        // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        $prepared = $wpdb->prepare($sql, $query_params);
        // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        $rows = $wpdb->get_results($prepared, ARRAY_A) ?: [];

        $items = [];
        foreach ($rows as $r) {
            $items[] = [
                'cis' => isset($r['cis']) ? (string) $r['cis'] : '',
                'denomination' => isset($r['denomination']) ? (string) $r['denomination'] : '',
                'libelle_presentation' => isset($r['libelle_presentation']) ? (string) $r['libelle_presentation'] : '',
                'cip13' => isset($r['cip13']) ? (string) $r['cip13'] : '',
                'cip7' => isset($r['cip7']) ? (string) $r['cip7'] : '',
                'taux_remboursement' => isset($r['taux_remboursement']) ? (string) $r['taux_remboursement'] : '',
                'prix_ttc' => $r['prix_ttc'] !== null && $r['prix_ttc'] !== '' ? (float) $r['prix_ttc'] : null,
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

        // Note: on préfère "SHOW TABLES LIKE" (portable MySQL/MariaDB) et on
        // garde une mise en cache (la liste des tables ne change pas pendant la requête).
        // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        $sql = $wpdb->prepare('SHOW TABLES LIKE %s', $table);
        // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        $found = $wpdb->get_var($sql);

        $exists = is_string($found) && $found !== '';
        $cache[$table] = $exists;
        return $exists;
    }
}
