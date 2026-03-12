<?php
declare(strict_types=1);

namespace SOSPrescription\Rest;

use SOSPrescription\Repositories\MedicationRepository;
use SOSPrescription\Services\Logger;
use SOSPrescription\Services\RestGuard;
use SOSPrescription\Services\Whitelist;
use WP_Error;
use WP_REST_Request;

final class MedicationController
{
    private MedicationRepository $repo;

    public function __construct()
    {
        $this->repo = new MedicationRepository();
    }
    public function permissions_check_logged_in_nonce(WP_REST_Request $request): bool|WP_Error
    {
        $ok = RestGuard::require_logged_in($request);
        if (is_wp_error($ok)) {
            return $ok;
        }

        $ok = RestGuard::require_wp_rest_nonce($request);
        if (is_wp_error($ok)) {
            return $ok;
        }

        // Anti-abus : la recherche médicaments peut être appelée très fréquemment (autosuggest).
        $route = (string) $request->get_route();
        if (strpos($route, '/medications/search') !== false) {
            $ok = RestGuard::throttle($request, 'med_search');
            if (is_wp_error($ok)) {
                return $ok;
            }
        }

        return true;
    }

    public function search(WP_REST_Request $request)
    {
        $scope = strtolower(trim((string) $request->get_header('X-Sos-Scope')));

        $q = trim((string) $request->get_param('q'));
        $limit = (int) ($request->get_param('limit') ?? 20);
        if ($limit < 1) { $limit = 20; }
        if ($limit > 50) { $limit = 50; }

        if (mb_strlen($q) < 2) {
            return rest_ensure_response([]);
        }

        $t0 = microtime(true);
        if ($scope !== '') {
            Logger::log_shortcode($scope, 'debug', 'api_medication_search', [
                'q' => mb_substr($q, 0, 80),
                'q_len' => mb_strlen($q),
                'limit' => $limit,
            ]);
        }

        // Guardrail : si la BDPM n'a pas été importée, la recherche renverra systématiquement
        // une liste vide et l'UI ressemble à un "bug". On préfère un message clair.
        $meta = get_option('sosprescription_bdpm_meta');
        if (!is_array($meta) || empty($meta['imported_at'])) {
            if ($scope !== '') {
                Logger::log_shortcode($scope, 'warning', 'api_medication_search_bdpm_not_ready', [
                    'q' => mb_substr($q, 0, 80),
                ]);
            }
            return new WP_Error(
                'sosprescription_bdpm_not_ready',
                'Référentiel médicaments indisponible (BDPM non importée).',
                ['status' => 503]
            );
        }

        $items = $this->repo->search($q, $limit);
        $raw_count = is_array($items) ? count($items) : 0;

        // Recherche "mixte" whitelist + BDPM (parcours patient).
        // Objectif UX : afficher les résultats BDPM pour éviter l'effet "base vide",
        // mais rendre inactifs les médicaments hors périmètre (whitelist).
        //
        // NB: le front envoie un scope "sosprescription_form" (via le loader).
        // On accepte aussi "form" pour compatibilité.
        if ($scope === 'sosprescription_form' || $scope === 'form') {
            $flow_key = strtolower(trim((string) ($request->get_param('flow') ?? '')));

            $wl = Whitelist::get();
            $mode = isset($wl['mode']) && is_string($wl['mode']) ? (string) $wl['mode'] : 'off';

            // Si mode != enforce : la whitelist ne bloque pas la sélection côté patient.
            $enforce = ($mode === 'enforce');

            $cis_list = [];
            foreach ($items as $it) {
                if (!is_array($it)) { continue; }
                $cis = isset($it['cis']) ? (int) $it['cis'] : 0;
                if ($cis > 0) { $cis_list[] = $cis; }
            }
            $cis_list = array_values(array_unique($cis_list));

            $atc_map = ($mode !== 'off' && count($cis_list) > 0) ? Whitelist::map_atc_codes_for_cis($cis_list) : [];

            $selectable = 0;
            foreach ($items as &$it) {
                if (!is_array($it)) { continue; }
                $cis = isset($it['cis']) ? (int) $it['cis'] : 0;

                $allowed = true;
                if ($mode !== 'off') {
                    $ev = Whitelist::evaluate_for_flow($cis, $cis > 0 ? ($atc_map[$cis] ?? null) : null, $flow_key);
                    $allowed = (bool) ($ev['allowed'] ?? false);
                }

                // Champ utilisé par le front pour désactiver la ligne.
                $it['is_selectable'] = $enforce ? $allowed : true;
                if (!empty($it['is_selectable'])) {
                    $selectable++;
                }
            }
            unset($it);

            if ($raw_count > 0 && $selectable === 0 && $enforce) {
                if ($scope !== '') {
                    Logger::log_shortcode($scope, 'warning', 'api_medication_search_all_out_of_scope', [
                        'q' => mb_substr($q, 0, 80),
                        'raw_count' => $raw_count,
                        'mode' => $mode,
                    ]);
                }
            }
        }

        if ($scope !== '') {
            Logger::log_shortcode($scope, 'info', 'api_medication_search_done', [
                'q' => mb_substr($q, 0, 80),
                'count' => is_array($items) ? count($items) : 0,
                'ms' => (int) round((microtime(true) - $t0) * 1000),
            ]);
        }
        return rest_ensure_response($items);
    }

    public function table(WP_REST_Request $request)
    {
        $scope = strtolower(trim((string) $request->get_header('X-Sos-Scope')));

        $q = trim((string) ($request->get_param('q') ?? ''));

        $page = (int) ($request->get_param('page') ?? 1);
        if ($page < 1) { $page = 1; }
        if ($page > 1000000) { $page = 1000000; }

        $per_page = (int) ($request->get_param('perPage') ?? 20);
        if ($per_page < 10) { $per_page = 10; }
        if ($per_page > 50) { $per_page = 50; }

        // Empêche une lecture massive sans filtre : on exige au minimum 2 caractères, ou un code.
        $q_ok = false;
        if ($q !== '') {
            if (preg_match('/^\d{7}$/', $q) === 1) {
                $q_ok = true;
            } elseif (preg_match('/^\d{13}$/', $q) === 1) {
                $q_ok = true;
            } elseif (preg_match('/^\d{6,9}$/', $q) === 1) {
                $q_ok = true;
            } elseif (mb_strlen($q) >= 2) {
                $q_ok = true;
            }
        }

        if (!$q_ok) {
            return rest_ensure_response([
                'items' => [],
                'total' => 0,
                'page' => 1,
                'perPage' => $per_page,
            ]);
        }

        $t0 = microtime(true);
        if ($scope !== '') {
            Logger::log_shortcode($scope, 'debug', 'api_medication_table', [
                'q' => mb_substr($q, 0, 80),
                'page' => $page,
                'perPage' => $per_page,
            ]);
        }

        $res = $this->repo->table($q, $page, $per_page);

        if ($scope !== '') {
            $count = (is_array($res) && isset($res['items']) && is_array($res['items'])) ? count($res['items']) : 0;
            $total = (is_array($res) && isset($res['total'])) ? (int) $res['total'] : 0;
            Logger::log_shortcode($scope, 'info', 'api_medication_table_done', [
                'q' => mb_substr($q, 0, 80),
                'count' => $count,
                'total' => $total,
                'ms' => (int) round((microtime(true) - $t0) * 1000),
            ]);
        }
        return rest_ensure_response($res);
    }
}
