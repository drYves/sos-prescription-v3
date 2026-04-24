<?php
declare(strict_types=1);

namespace SOSPrescription\Rest;

use SOSPrescription\Repositories\MedicationRepository;
use SOSPrescription\Services\Logger;
use SOSPrescription\Services\RestGuard;
use SOSPrescription\Services\V4InputNormalizer;
use SOSPrescription\Services\V4WorkerTransport;
use Throwable;
use WP_Error;
use WP_REST_Request;
use WP_REST_Response;

final class MedicationController
{
    private const LEGACY_HOMEOPATHIC_PRODUCT_MARKERS = [
        'oscillococcinum',
        'stodal',
        'sedatif pc',
        'cocculine',
        'homeomunyl',
    ];

    private const LEGACY_HOMEOPATHIC_HOLDER_MARKERS = [
        'boiron',
        'weleda',
        'lehning',
    ];

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
        $backend = 'worker';
        $this->safe_shortcode_log($scope, 'debug', 'api_medication_search', [
            'q' => self::str_sub($q, 0, 80),
            'q_len' => self::str_len($q),
            'limit' => $limit,
        ]);

        try {
            try {
                $items = $this->search_worker_items($q, $limit, $scope);
                $mode = 'worker';
                $rawCount = count($items);
                $candidateCount = count($items);
            } catch (Throwable $workerError) {
                if (!$this->should_allow_legacy_search_fallback()) {
                    throw $workerError;
                }

                if (!$this->is_local_bdpm_search_ready()) {
                    $this->safe_runtime_log('error', 'api_medication_search_worker_failed_without_legacy_fallback', [
                        'scope' => $scope,
                        'q' => self::str_sub($q, 0, 80),
                        'limit' => $limit,
                        'backend' => $backend,
                        'exception' => get_class($workerError),
                        'message' => $workerError->getMessage(),
                    ]);

                    return new WP_Error(
                        'sosprescription_medication_search_failed',
                        'Recherche médicaments momentanément indisponible.',
                        ['status' => 502]
                    );
                }

                $backend = 'legacy_mysql_fallback';
                $search = $this->repo->searchWithMeta($q, $limit);
                $legacyItems = is_array($search['items'] ?? null) ? $search['items'] : [];
                $legacyFilter = $this->filter_legacy_homeopathic_search_items($legacyItems);
                $items = $this->mark_legacy_search_items_non_selectable(
                    $this->canonicalize_search_items($legacyFilter['items'])
                );
                $mode = isset($search['mode']) ? (string) $search['mode'] : 'exact';
                $rawCount = isset($search['raw_count']) ? (int) $search['raw_count'] : count($items);
                $candidateCount = isset($search['candidate_count']) ? (int) $search['candidate_count'] : count($items);

                if ($legacyFilter['filtered_count'] > 0) {
                    $this->safe_runtime_log('warning', 'api_medication_search_legacy_homeopathy_filtered', [
                        'scope' => $scope,
                        'q' => self::str_sub($q, 0, 80),
                        'filtered_count' => $legacyFilter['filtered_count'],
                        'remaining_count' => count($items),
                    ]);
                }
            }

            if ($backend === 'legacy_mysql_fallback') {
                $this->safe_shortcode_log($scope, 'warning', 'api_medication_search_legacy_results_non_selectable', [
                    'q' => self::str_sub($q, 0, 80),
                    'count' => count($items),
                ]);
            }
        } catch (Throwable $e) {
            $this->safe_runtime_log('error', 'api_medication_search_failed', [
                'scope' => $scope,
                'q' => self::str_sub($q, 0, 80),
                'limit' => $limit,
                'backend' => $backend,
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
            'backend' => $backend,
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
     * @return array<int, array<string, mixed>>
     */
    private function search_worker_items(string $query, int $limit, string $scope): array
    {
        $transport = new V4WorkerTransport(new V4InputNormalizer());
        $response = $transport->medicationsSearch($query, $limit);

        if (is_wp_error($response)) {
            throw new \RuntimeException(trim((string) $response->get_error_message()) ?: 'Worker medication search failed.');
        }

        if (!$response instanceof WP_REST_Response) {
            throw new \RuntimeException('Worker medication search returned an invalid response type.');
        }

        $status = (int) $response->get_status();
        if ($status < 200 || $status >= 300) {
            throw new \RuntimeException('Worker medication search returned HTTP ' . $status . '.');
        }

        $data = $response->get_data();
        if (!is_array($data)) {
            throw new \RuntimeException('Worker medication search returned an invalid payload.');
        }

        $items = [];
        if (isset($data['items']) && is_array($data['items'])) {
            $items = $data['items'];
        } elseif (array_keys($data) === range(0, count($data) - 1)) {
            $items = $data;
        }

        $this->safe_shortcode_log($scope, 'debug', 'api_medication_search_worker_done', [
            'q' => self::str_sub($query, 0, 80),
            'count' => count($items),
            'limit' => $limit,
        ]);

        return $this->canonicalize_search_items($items);
    }

    private function should_allow_legacy_search_fallback(): bool
    {
        return self::read_config_bool('SOSPRESCRIPTION_MEDICATION_WORKER_LEGACY_FALLBACK', false);
    }

    private function is_local_bdpm_search_ready(): bool
    {
        $meta = get_option('sosprescription_bdpm_meta');
        return is_array($meta) && !empty($meta['imported_at']);
    }

    private static function read_config_string(string $name, string $default = ''): string
    {
        if (defined($name)) {
            $value = constant($name);
            if (is_string($value)) {
                $trimmed = trim($value);
                if ($trimmed !== '') {
                    return $trimmed;
                }
            } elseif (is_scalar($value)) {
                $trimmed = trim((string) $value);
                if ($trimmed !== '') {
                    return $trimmed;
                }
            }
        }

        $value = getenv($name);
        if (is_string($value)) {
            $trimmed = trim($value);
            if ($trimmed !== '') {
                return $trimmed;
            }
        }

        return $default;
    }

    private static function read_config_bool(string $name, bool $default = false): bool
    {
        $value = self::read_config_string($name, $default ? '1' : '0');
        $normalized = strtolower(trim($value));

        return in_array($normalized, ['1', 'true', 'yes', 'on'], true);
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
        $sublabel = isset($item['sublabel']) ? trim((string) $item['sublabel']) : '';

        if ($specialite === '' && $sublabel !== '') {
            $specialite = $sublabel;
        }
        if ($sublabel === '' && $specialite !== '') {
            $sublabel = $specialite;
        }

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

        $validationCode = isset($item['validation_code']) && is_scalar($item['validation_code'])
            ? trim((string) $item['validation_code'])
            : '';
        $validationReason = isset($item['validation_reason']) && is_scalar($item['validation_reason'])
            ? trim((string) $item['validation_reason'])
            : '';
        $matchCode = isset($item['match_code']) && is_scalar($item['match_code'])
            ? trim((string) $item['match_code'])
            : '';

        if ($validationCode === '' && !$isSelectable) {
            $validationCode = 'worker_rejected';
        }

        return [
            'type' => $type,
            'cis' => $cis,
            'cip13' => $cip13,
            'cip7' => $cip7,
            'label' => $label,
            'specialite' => $specialite,
            'sublabel' => $sublabel,
            'tauxRemb' => $tauxRemb,
            'prixTTC' => $prixTTC,
            'is_selectable' => $isSelectable,
            'validation_code' => $validationCode,
            'validation_reason' => $validationReason,
            'match_code' => $matchCode,
        ];
    }

    /**
     * @param array<int, array<string, mixed>> $items
     * @return array<int, array<string, mixed>>
     */
    private function mark_legacy_search_items_non_selectable(array $items): array
    {
        foreach ($items as &$item) {
            if (!is_array($item)) {
                continue;
            }

            $item['is_selectable'] = false;
            if (!isset($item['validation_code']) || trim((string) $item['validation_code']) === '') {
                $item['validation_code'] = 'legacy_unvalidated';
            }
            if (!isset($item['validation_reason']) || trim((string) $item['validation_reason']) === '') {
                $item['validation_reason'] = 'Validation canonique Worker indisponible.';
            }
        }
        unset($item);

        return $items;
    }

    /**
     * @param array<int, array<string, mixed>> $items
     * @return array{items:array<int, array<string, mixed>>, filtered_count:int}
     */
    private function filter_legacy_homeopathic_search_items(array $items): array
    {
        $filtered = [];
        $filteredCount = 0;

        foreach ($items as $item) {
            if (!is_array($item)) {
                continue;
            }

            if ($this->is_legacy_homeopathic_search_item($item)) {
                $filteredCount += 1;
                continue;
            }

            $filtered[] = $item;
        }

        return [
            'items' => $filtered,
            'filtered_count' => $filteredCount,
        ];
    }

    /**
     * @param array<string, mixed> $item
     */
    private function is_legacy_homeopathic_search_item(array $item): bool
    {
        $label = isset($item['label']) && is_scalar($item['label']) ? (string) $item['label'] : '';
        $specialite = isset($item['specialite']) && is_scalar($item['specialite']) ? (string) $item['specialite'] : '';
        $sublabel = isset($item['sublabel']) && is_scalar($item['sublabel']) ? (string) $item['sublabel'] : '';

        $haystack = $this->normalize_legacy_medication_search_text(implode(' ', [$label, $specialite, $sublabel]));
        if ($haystack === '') {
            return false;
        }

        if (str_contains($haystack, 'homeo') || str_contains($haystack, 'degre de dilution')) {
            return true;
        }

        foreach (self::LEGACY_HOMEOPATHIC_PRODUCT_MARKERS as $marker) {
            if (str_contains($haystack, $marker)) {
                return true;
            }
        }

        $hasGranules = str_contains($haystack, 'granules');
        if ($hasGranules) {
            foreach (self::LEGACY_HOMEOPATHIC_HOLDER_MARKERS as $marker) {
                if (str_contains($haystack, $marker)) {
                    return true;
                }
            }
        }

        return false;
    }

    private function normalize_legacy_medication_search_text(string $value): string
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
