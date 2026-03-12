<?php
// includes/Rest/MedicationController.php
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
        if ($scope !== '') {
            Logger::log_shortcode($scope, 'debug', 'api_medication_search', [
                'q' => self::str_sub($q, 0, 80),
                'q_len' => self::str_len($q),
                'limit' => $limit,
            ]);
        }

        $meta = get_option('sosprescription_bdpm_meta');
        if (!is_array($meta) || empty($meta['imported_at'])) {
            if ($scope !== '') {
                Logger::log_shortcode($scope, 'warning', 'api_medication_search_bdpm_not_ready', [
                    'q' => self::str_sub($q, 0, 80),
                ]);
            }

            return new WP_Error(
                'sosprescription_bdpm_not_ready',
                'Referentiel medicaments indisponible (BDPM non importee).',
                ['status' => 503]
            );
        }

        try {
            $items = $this->repo->search($q, $limit);
            $rawCount = is_array($items) ? count($items) : 0;

            if ($scope === 'sosprescription_form' || $scope === 'form') {
                $flowKey = strtolower(trim((string) ($request->get_param('flow') ?? '')));

                $wl = Whitelist::get();
                $mode = isset($wl['mode']) && is_string($wl['mode']) ? (string) $wl['mode'] : 'off';
                $enforce = ($mode === 'enforce');

                $cisList = [];
                foreach ($items as $it) {
                    if (!is_array($it)) {
                        continue;
                    }

                    $cis = isset($it['cis']) ? (int) $it['cis'] : 0;
                    if ($cis > 0) {
                        $cisList[] = $cis;
                    }
                }
                $cisList = array_values(array_unique($cisList));

                $atcMap = ($mode !== 'off' && count($cisList) > 0)
                    ? Whitelist::map_atc_codes_for_cis($cisList)
                    : [];

                $selectable = 0;
                foreach ($items as &$it) {
                    if (!is_array($it)) {
                        continue;
                    }

                    $cis = isset($it['cis']) ? (int) $it['cis'] : 0;
                    $allowed = true;

                    if ($mode !== 'off') {
                        $evaluation = Whitelist::evaluate_for_flow(
                            $cis,
                            $cis > 0 ? ($atcMap[$cis] ?? null) : null,
                            $flowKey
                        );
                        $allowed = (bool) ($evaluation['allowed'] ?? false);
                    }

                    $it['is_selectable'] = $enforce ? $allowed : true;
                    if (!empty($it['is_selectable'])) {
                        $selectable++;
                    }
                }
                unset($it);

                if ($rawCount > 0 && $selectable === 0 && $enforce && $scope !== '') {
                    Logger::log_shortcode($scope, 'warning', 'api_medication_search_all_out_of_scope', [
                        'q' => self::str_sub($q, 0, 80),
                        'raw_count' => $rawCount,
                        'mode' => $mode,
                    ]);
                }
            }
        } catch (Throwable $e) {
            Logger::log('runtime', 'error', 'api_medication_search_failed', [
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
                'Erreur interne lors de la recherche de medicaments.',
                ['status' => 500]
            );
        }

        if ($scope !== '') {
            Logger::log_shortcode($scope, 'info', 'api_medication_search_done', [
                'q' => self::str_sub($q, 0, 80),
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
        if ($page < 1) {
            $page = 1;
        }
        if ($page > 1000000) {
            $page = 1000000;
        }

        $perPage = (int) ($request->get_param('perPage') ?? 20);
        if ($perPage < 10) {
            $perPage = 10;
        }
        if ($perPage > 50) {
            $perPage = 50;
        }

        $qOk = false;
        if ($q !== '') {
            if (preg_match('/^\d{7}$/', $q) === 1) {
                $qOk = true;
            } elseif (preg_match('/^\d{13}$/', $q) === 1) {
                $qOk = true;
            } elseif (preg_match('/^\d{6,9}$/', $q) === 1) {
                $qOk = true;
            } elseif (self::str_len($q) >= 2) {
                $qOk = true;
            }
        }

        if (!$qOk) {
            return rest_ensure_response([
                'items' => [],
                'total' => 0,
                'page' => 1,
                'perPage' => $perPage,
            ]);
        }

        $t0 = microtime(true);
        if ($scope !== '') {
            Logger::log_shortcode($scope, 'debug', 'api_medication_table', [
                'q' => self::str_sub($q, 0, 80),
                'page' => $page,
                'perPage' => $perPage,
            ]);
        }

        try {
            $res = $this->repo->table($q, $page, $perPage);
        } catch (Throwable $e) {
            Logger::log('runtime', 'error', 'api_medication_table_failed', [
                'scope' => $scope,
                'q' => self::str_sub($q, 0, 80),
                'page' => $page,
                'perPage' => $perPage,
                'exception' => get_class($e),
                'message' => $e->getMessage(),
                'file' => $e->getFile(),
                'line' => $e->getLine(),
            ]);

            return new WP_Error(
                'sosprescription_medication_table_failed',
                'Erreur interne lors de la lecture du referentiel medicaments.',
                ['status' => 500]
            );
        }

        if ($scope !== '') {
            $count = (is_array($res) && isset($res['items']) && is_array($res['items'])) ? count($res['items']) : 0;
            $total = (is_array($res) && isset($res['total'])) ? (int) $res['total'] : 0;
            Logger::log_shortcode($scope, 'info', 'api_medication_table_done', [
                'q' => self::str_sub($q, 0, 80),
                'count' => $count,
                'total' => $total,
                'ms' => (int) round((microtime(true) - $t0) * 1000),
            ]);
        }

        return rest_ensure_response($res);
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
