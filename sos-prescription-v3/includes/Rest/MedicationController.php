<?php
declare(strict_types=1);

namespace SOSPrescription\Rest;

use SOSPrescription\Repositories\MedicationRepository;
use SOSPrescription\Services\Logger;
use SOSPrescription\Services\RestGuard;
use SOSPrescription\Services\Whitelist;
use Throwable;
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
        if ($limit < 1) {
            $limit = 20;
        }
        if ($limit > 50) {
            $limit = 50;
        }

        if (self::str_len($q) < 2) {
            return rest_ensure_response([]);
        }

        $t0 = microtime(true);
        $this->safe_shortcode_log($scope, 'debug', 'api_medication_search', [
            'q' => self::str_sub($q, 0, 80),
            'q_len' => self::str_len($q),
            'limit' => $limit,
        ]);

        $meta = get_option('sosprescription_bdpm_meta');
        if (!is_array($meta) || empty($meta['imported_at'])) {
            $this->safe_shortcode_log($scope, 'warning', 'api_medication_search_bdpm_not_ready', [
                'q' => self::str_sub($q, 0, 80),
            ]);

            return new WP_Error(
                'sosprescription_bdpm_not_ready',
                'Référentiel médicaments indisponible (BDPM non importée).',
                ['status' => 503]
            );
        }

        try {
            $search = $this->repo->searchWithMeta($q, $limit);
            $items = $this->canonicalize_search_items(is_array($search['items'] ?? null) ? $search['items'] : []);
            $mode = isset($search['mode']) ? (string) $search['mode'] : 'exact';
            $rawCount = isset($search['raw_count']) ? (int) $search['raw_count'] : count($items);
            $candidateCount = isset($search['candidate_count']) ? (int) $search['candidate_count'] : count($items);

            if ($this->is_form_scope($scope)) {
                $flow_key = $this->resolve_flow_key($request);
                $wl = Whitelist::get();
                $modeWhitelist = isset($wl['mode']) && is_string($wl['mode']) ? (string) $wl['mode'] : 'off';

                if ($modeWhitelist === 'off') {
                    foreach ($items as &$item) {
                        if (!is_array($item)) {
                            continue;
                        }
                        $item['is_selectable'] = true;
                    }
                    unset($item);
                } else {
                    $enforce = $modeWhitelist === 'enforce';

                    $cis_list = [];
                    foreach ($items as $item) {
                        if (!is_array($item)) {
                            continue;
                        }

                        $cis = isset($item['cis']) ? (int) $item['cis'] : 0;
                        if ($cis > 0) {
                            $cis_list[] = $cis;
                        }
                    }
                    $cis_list = array_values(array_unique($cis_list));

                    $mitm_ready = Whitelist::is_mitm_ready();
                    $atc_map = [];
                    if ($cis_list !== [] && $mitm_ready) {
                        $atc_map = Whitelist::map_atc_codes_for_cis($cis_list);
                    }

                    $selectable = 0;
                    foreach ($items as &$item) {
                        if (!is_array($item)) {
                            continue;
                        }

                        $cis = isset($item['cis']) ? (int) $item['cis'] : 0;
                        $evaluation = Whitelist::evaluate_for_flow(
                            $cis,
                            $cis > 0 ? ($atc_map[$cis] ?? null) : null,
                            $flow_key
                        );

                        $allowed = (bool) ($evaluation['allowed'] ?? true);
                        $item['is_selectable'] = $enforce ? $allowed : true;

                        if (!empty($item['is_selectable'])) {
                            $selectable++;
                        }
                    }
                    unset($item);

                    if (count($items) > 0 && $selectable === 0 && $enforce) {
                        $this->safe_shortcode_log($scope, 'warning', 'api_medication_search_all_out_of_scope', [
                            'q' => self::str_sub($q, 0, 80),
                            'raw_count' => count($items),
                            'mode' => $modeWhitelist,
                            'flow' => $flow_key,
                            'mitm_ready' => $mitm_ready ? '1' : '0',
                        ]);
                    }
                }
            }
        } catch (Throwable $e) {
            $this->safe_runtime_log('error', 'api_medication_search_failed', [
                'scope' => $scope,
                'q' => self::str_sub($q, 0, 80),
                'limit' => $limit,
                'exception' => get_class($e),
                'message' => $e->getMessage(),
                'file' => $e->getFile(),
                'line' => $e->getLine(),
            ]);

            return new WP_Error(
                'sosprescription_medication_search_failed',
                'Erreur interne lors de la recherche de médicaments.',
                ['status' => 500]
            );
        }

        $this->safe_shortcode_log($scope, 'info', 'api_medication_search_done', [
            'q' => self::str_sub($q, 0, 80),
            'count' => count($items),
            'search_mode' => $mode,
            'raw_count' => $rawCount,
            'candidate_count' => $candidateCount,
            'ms' => (int) round((microtime(true) - $t0) * 1000),
        ]);

        return rest_ensure_response($items);
    }

    public function table(WP_REST_Request $request)
    {
        $scope = strtolower(trim((string) $request->get_header('X-Sos-Scope')));
        $q = trim((string) ($request->get_param('q') ?? ''));

        $page = (int) ($request->get_param('page') ?? 1);
        if ($page < 1) {
            $page = 1;
        }
        if ($page > 1000000) {
            $page = 1000000;
        }

        $per_page = (int) ($request->get_param('perPage') ?? 20);
        if ($per_page < 10) {
            $per_page = 10;
        }
        if ($per_page > 50) {
            $per_page = 50;
        }

        $q_ok = false;
        if ($q !== '') {
            if (preg_match('/^\d{7}$/', $q) === 1) {
                $q_ok = true;
            } elseif (preg_match('/^\d{13}$/', $q) === 1) {
                $q_ok = true;
            } elseif (preg_match('/^\d{6,9}$/', $q) === 1) {
                $q_ok = true;
            } elseif (self::str_len($q) >= 2) {
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
        $this->safe_shortcode_log($scope, 'debug', 'api_medication_table', [
            'q' => self::str_sub($q, 0, 80),
            'page' => $page,
            'perPage' => $per_page,
        ]);

        try {
            $res = $this->repo->table($q, $page, $per_page);
        } catch (Throwable $e) {
            $this->safe_runtime_log('error', 'api_medication_table_failed', [
                'scope' => $scope,
                'q' => self::str_sub($q, 0, 80),
                'page' => $page,
                'perPage' => $per_page,
                'exception' => get_class($e),
                'message' => $e->getMessage(),
                'file' => $e->getFile(),
                'line' => $e->getLine(),
            ]);

            return new WP_Error(
                'sosprescription_medication_table_failed',
                'Erreur interne lors de la lecture du référentiel médicaments.',
                ['status' => 500]
            );
        }

        $count = (is_array($res) && isset($res['items']) && is_array($res['items'])) ? count($res['items']) : 0;
        $total = (is_array($res) && isset($res['total'])) ? (int) $res['total'] : 0;

        $this->safe_shortcode_log($scope, 'info', 'api_medication_table_done', [
            'q' => self::str_sub($q, 0, 80),
            'count' => $count,
            'total' => $total,
            'ms' => (int) round((microtime(true) - $t0) * 1000),
        ]);

        return rest_ensure_response($res);
    }

    private function is_form_scope(string $scope): bool
    {
        return in_array($scope, ['form', 'sosprescription_form'], true);
    }

    private function resolve_flow_key(WP_REST_Request $request): string
    {
        $candidates = [
            $request->get_param('flow'),
            $request->get_param('flow_key'),
            $request->get_header('X-Sos-Flow'),
            $request->get_header('X-SOS-Flow'),
        ];

        foreach ($candidates as $candidate) {
            if (!is_string($candidate)) {
                continue;
            }

            $candidate = strtolower(trim($candidate));
            if ($candidate === '') {
                continue;
            }

            if (in_array($candidate, ['ro_proof', 'ro', 'renewal', 'renewal_with_proof', 'ro-with-proof'], true)) {
                return 'ro_proof';
            }

            if (in_array($candidate, ['depannage_no_proof', 'depannage', 'no_proof', 'without_proof', 'depannage-sans-preuve'], true)) {
                return 'depannage_no_proof';
            }
        }

        return 'ro_proof';
    }

    /**
     * @param array<int, array<string, mixed>> $items
     * @return array<int, array<string, mixed>>
     */
    private function canonicalize_search_items(array $items): array
    {
        $out = [];
        foreach ($items as $item) {
            if (!is_array($item)) {
                continue;
            }
            $out[] = $this->canonicalize_search_item($item);
        }

        return $out;
    }

    /**
     * @param array<string, mixed> $item
     * @return array<string, mixed>
     */
    private function canonicalize_search_item(array $item): array
    {
        $type = isset($item['type']) && $item['type'] === 'presentation' ? 'presentation' : 'specialite';

        $cis = isset($item['cis']) ? trim((string) $item['cis']) : '';
        $cip13 = isset($item['cip13']) ? trim((string) $item['cip13']) : '';
        $cip7 = isset($item['cip7']) ? trim((string) $item['cip7']) : '';

        $label = isset($item['label']) ? trim((string) $item['label']) : '';
        $specialite = isset($item['specialite']) ? trim((string) $item['specialite']) : '';

        if ($label === '' && $specialite !== '') {
            $label = $specialite;
        }
        if ($specialite === '' && $label !== '') {
            $specialite = $label;
        }
        if ($label === '') {
            $label = 'Médicament';
        }

        $tauxRemb = isset($item['tauxRemb']) ? trim((string) $item['tauxRemb']) : '';

        $prixTTC = null;
        if (array_key_exists('prixTTC', $item) && $item['prixTTC'] !== null && $item['prixTTC'] !== '') {
            $prixTTC = (float) $item['prixTTC'];
        }

        if (isset($item['is_selectable'])) {
            $isSelectable = (bool) $item['is_selectable'];
        } else {
            $isSelectable = true;
        }

        return [
            'type' => $type,
            'cis' => $cis,
            'cip13' => $cip13,
            'cip7' => $cip7,
            'label' => $label,
            'specialite' => $specialite,
            'tauxRemb' => $tauxRemb,
            'prixTTC' => $prixTTC,
            'is_selectable' => $isSelectable,
        ];
    }

    /**
     * @param array<string, mixed> $context
     */
    private function safe_shortcode_log(string $scope, string $level, string $message, array $context = []): void
    {
        if ($scope === '') {
            return;
        }

        try {
            Logger::log_shortcode($scope, $level, $message, $context);
        } catch (Throwable $e) {
            error_log('[SOSPrescription] MedicationController shortcode log failed: ' . $e->getMessage());
        }
    }

    /**
     * @param array<string, mixed> $context
     */
    private function safe_runtime_log(string $level, string $message, array $context = []): void
    {
        try {
            Logger::log('runtime', $level, $message, $context);
        } catch (Throwable $e) {
            error_log('[SOSPrescription] MedicationController runtime log failed: ' . $e->getMessage());
        }
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
