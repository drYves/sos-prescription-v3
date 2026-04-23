<?php
declare(strict_types=1);

namespace SOSPrescription\Services;

use RuntimeException;
use Throwable;
use WP_Error;
use WP_REST_Request;
use WP_REST_Response;

final class MedicationValidationBridge
{
    /**
     * @param array<int, mixed> $items
     * @return array<int, array<string, mixed>>|WP_Error
     */
    public function validateItems(array $items, string $flowKey = 'ro_proof', string $stage = 'submission'): array|WP_Error
    {
        if ($items === []) {
            return new WP_Error(
                'sosprescription_items_required',
                'Au moins un médicament est requis.',
                ['status' => 400, 'stage' => $stage]
            );
        }

        $normalized = [];
        foreach (array_values($items) as $index => $item) {
            if (!is_array($item)) {
                return new WP_Error(
                    'sosprescription_medication_item_invalid',
                    'Un médicament transmis est invalide.',
                    ['status' => 422, 'stage' => $stage, 'index' => $index]
                );
            }

            $validated = $this->validateSingleItem($item, $flowKey, $stage, $index);
            if (is_wp_error($validated)) {
                return $validated;
            }

            $normalized[] = $validated;
        }

        return $normalized;
    }

    public function validateRequestItems(WP_REST_Request $request, string $stage = 'submission'): true|WP_Error
    {
        $topLevelItems = $request->get_param('items');
        if (is_array($topLevelItems)) {
            $flowKey = $this->resolveFlowKeyFromRequest($request, []);
            $validated = $this->validateItems(array_values($topLevelItems), $flowKey, $stage);
            if (is_wp_error($validated)) {
                return $validated;
            }

            $request->set_param('items', $validated);
            return true;
        }

        $prescription = $request->get_param('prescription');
        if (is_array($prescription) && isset($prescription['items']) && is_array($prescription['items'])) {
            $flowKey = $this->resolveFlowKeyFromRequest($request, $prescription);
            $validated = $this->validateItems(array_values($prescription['items']), $flowKey, $stage);
            if (is_wp_error($validated)) {
                return $validated;
            }

            $prescription['items'] = $validated;
            $request->set_param('prescription', $prescription);
            return true;
        }

        return true;
    }

    /**
     * @param array<string, mixed> $item
     * @return array<string, mixed>|WP_Error
     */
    private function validateSingleItem(array $item, string $flowKey, string $stage, int $index): array|WP_Error
    {
        $cis = isset($item['cis']) ? trim((string) $item['cis']) : '';
        $cip13 = isset($item['cip13']) ? trim((string) $item['cip13']) : '';
        $label = trim((string) ($item['label'] ?? $item['denomination'] ?? $item['name'] ?? ''));

        if ($cis === '' && $cip13 === '' && $label === '') {
            return new WP_Error(
                'sosprescription_medication_identity_missing',
                'Un médicament transmis ne contient aucun identifiant exploitable.',
                ['status' => 422, 'stage' => $stage, 'flow' => $flowKey, 'index' => $index]
            );
        }

        $queries = [];
        if ($cip13 !== '') {
            $queries[] = $cip13;
        }
        if ($cis !== '' && !in_array($cis, $queries, true)) {
            $queries[] = $cis;
        }
        if ($label !== '' && !in_array($label, $queries, true)) {
            $queries[] = $label;
        }

        $candidates = [];
        foreach ($queries as $query) {
            try {
                $rows = $this->searchWorkerItems($query, 20, 'medication_validation_' . $stage);
            } catch (Throwable $e) {
                return new WP_Error(
                    'sosprescription_medication_validation_worker_failed',
                    'Validation canonique des médicaments momentanément indisponible.',
                    [
                        'status' => 502,
                        'stage' => $stage,
                        'flow' => $flowKey,
                        'index' => $index,
                        'bridge_error' => $e->getMessage(),
                        'bridge_exception_class' => get_class($e),
                    ]
                );
            }

            foreach ($rows as $row) {
                if (!is_array($row)) {
                    continue;
                }
                $key = ($row['cis'] ?? '') . '|' . ($row['cip13'] ?? '') . '|' . ($row['label'] ?? '');
                $candidates[$key] = $row;
            }
        }

        $matched = $this->findCanonicalCandidate($item, array_values($candidates));
        if ($matched === null) {
            return new WP_Error(
                'sosprescription_medication_not_found',
                'Médicament introuvable dans le référentiel canonique.',
                ['status' => 422, 'stage' => $stage, 'flow' => $flowKey, 'index' => $index, 'cis' => $cis, 'cip13' => $cip13]
            );
        }

        if (empty($matched['is_selectable'])) {
            return new WP_Error(
                'sosprescription_medication_not_selectable',
                'Ce médicament n’est pas éligible à la prescription en ligne pour ce flux.',
                [
                    'status' => 422,
                    'stage' => $stage,
                    'flow' => $flowKey,
                    'index' => $index,
                    'cis' => (string) ($matched['cis'] ?? ''),
                    'cip13' => (string) ($matched['cip13'] ?? ''),
                    'validation_code' => isset($matched['validation_code']) ? (string) $matched['validation_code'] : 'worker_rejected',
                ]
            );
        }

        $normalized = $item;
        $normalized['cis'] = (string) ($matched['cis'] ?? $cis);
        $normalized['cip13'] = ($matched['cip13'] ?? '') !== '' ? (string) $matched['cip13'] : ($cip13 !== '' ? $cip13 : null);
        $normalized['label'] = (string) ($matched['label'] ?? ($label !== '' ? $label : 'Médicament'));
        if (isset($matched['sublabel']) && is_string($matched['sublabel']) && trim($matched['sublabel']) !== '') {
            $normalized['sublabel'] = trim($matched['sublabel']);
        }
        $normalized['is_selectable'] = true;
        $normalized['validation_code'] = isset($matched['validation_code']) && is_scalar($matched['validation_code'])
            ? (string) $matched['validation_code']
            : 'allowed';

        return $normalized;
    }

    /**
     * @param array<string, mixed> $item
     * @param array<int, array<string, mixed>> $candidates
     * @return array<string, mixed>|null
     */
    private function findCanonicalCandidate(array $item, array $candidates): ?array
    {
        $cis = isset($item['cis']) ? trim((string) $item['cis']) : '';
        $cip13 = isset($item['cip13']) ? trim((string) $item['cip13']) : '';
        $label = trim((string) ($item['label'] ?? $item['denomination'] ?? $item['name'] ?? ''));

        if ($cip13 !== '') {
            foreach ($candidates as $candidate) {
                if (!is_array($candidate)) {
                    continue;
                }
                if (($candidate['cip13'] ?? '') !== $cip13) {
                    continue;
                }
                if ($cis !== '' && ($candidate['cis'] ?? '') !== $cis) {
                    continue;
                }
                return $candidate;
            }
        }

        if ($cis !== '') {
            $cisMatches = [];
            foreach ($candidates as $candidate) {
                if (is_array($candidate) && ($candidate['cis'] ?? '') === $cis) {
                    $cisMatches[] = $candidate;
                }
            }

            if ($label !== '') {
                $labelNorm = $this->normalizeLabel($label);
                foreach ($cisMatches as $candidate) {
                    if ($this->normalizeLabel((string) ($candidate['label'] ?? '')) === $labelNorm) {
                        return $candidate;
                    }
                }
            }

            if ($cisMatches !== []) {
                return $cisMatches[0];
            }
        }

        if ($label !== '') {
            $labelNorm = $this->normalizeLabel($label);
            foreach ($candidates as $candidate) {
                if (!is_array($candidate)) {
                    continue;
                }
                if ($this->normalizeLabel((string) ($candidate['label'] ?? '')) === $labelNorm) {
                    return $candidate;
                }
            }
        }

        return null;
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private function searchWorkerItems(string $query, int $limit, string $scope): array
    {
        $transport = new V4WorkerTransport(new V4InputNormalizer());
        $response = $transport->medicationsSearch($query, $limit);

        if (is_wp_error($response)) {
            throw new RuntimeException(trim((string) $response->get_error_message()) ?: 'Worker medication search failed.');
        }

        if (!$response instanceof WP_REST_Response) {
            throw new RuntimeException('Worker medication search returned an invalid response type.');
        }

        $status = (int) $response->get_status();
        if ($status < 200 || $status >= 300) {
            throw new RuntimeException('Worker medication search returned HTTP ' . $status . '.');
        }

        $data = $response->get_data();
        if (!is_array($data)) {
            throw new RuntimeException('Worker medication search returned an invalid payload.');
        }

        $items = [];
        if (isset($data['items']) && is_array($data['items'])) {
            $items = $data['items'];
        } elseif (array_keys($data) === range(0, count($data) - 1)) {
            $items = $data;
        }

        return $this->canonicalizeSearchItems($items);
    }

    private function resolveFlowKeyFromRequest(WP_REST_Request $request, array $payload): string
    {
        $candidates = [
            $request->get_param('flow'),
            $request->get_param('flow_key'),
            $request->get_param('flowKey'),
            $payload['flow'] ?? null,
            $payload['flow_key'] ?? null,
            $payload['flowKey'] ?? null,
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
    private function canonicalizeSearchItems(array $items): array
    {
        $out = [];
        foreach ($items as $item) {
            if (!is_array($item)) {
                continue;
            }
            $out[] = $this->canonicalizeSearchItem($item);
        }

        return $out;
    }

    /**
     * @param array<string, mixed> $item
     * @return array<string, mixed>
     */
    private function canonicalizeSearchItem(array $item): array
    {
        return [
            'cis' => isset($item['cis']) ? trim((string) $item['cis']) : '',
            'cip13' => isset($item['cip13']) ? trim((string) $item['cip13']) : '',
            'label' => isset($item['label']) ? trim((string) $item['label']) : '',
            'sublabel' => isset($item['sublabel']) ? trim((string) $item['sublabel']) : '',
            'is_selectable' => isset($item['is_selectable']) ? (bool) $item['is_selectable'] : false,
            'validation_code' => isset($item['validation_code']) && is_scalar($item['validation_code']) ? trim((string) $item['validation_code']) : '',
            'validation_reason' => isset($item['validation_reason']) && is_scalar($item['validation_reason']) ? trim((string) $item['validation_reason']) : '',
            'match_code' => isset($item['match_code']) && is_scalar($item['match_code']) ? trim((string) $item['match_code']) : '',
        ];
    }

    private function normalizeLabel(string $value): string
    {
        $value = strtolower(trim($value));
        $transliterated = @iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $value);
        if (is_string($transliterated) && $transliterated !== '') {
            $value = $transliterated;
        }
        $value = preg_replace('/[^a-z0-9]+/', ' ', $value) ?: '';
        return trim($value);
    }
}
