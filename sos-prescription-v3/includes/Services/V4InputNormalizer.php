<?php
// includes/Services/V4InputNormalizer.php

declare(strict_types=1);

namespace SosPrescription\Services;

use WP_REST_Request;

final class V4InputNormalizer
{
    /**
     * @return array<string, mixed>
     */
    public function normalizePayload(mixed $payload): array
    {
        if (is_array($payload) || is_object($payload)) {
            $encoded = wp_json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            if (is_string($encoded) && $encoded !== '') {
                $decoded = json_decode($encoded, true);
                if (is_array($decoded)) {
                    return $decoded;
                }
            }
        }

        if (is_string($payload)) {
            $trimmed = trim($payload);
            if ($trimmed !== '' && ($trimmed[0] === '{' || $trimmed[0] === '[')) {
                $decoded = json_decode($trimmed, true);
                if (is_array($decoded)) {
                    return $decoded;
                }
            }
        }

        return [];
    }

    /**
     * @return array<string, mixed>
     */
    public function requestData(WP_REST_Request $request): array
    {
        $json = $this->normalizePayload($request->get_json_params());
        if ($json !== []) {
            return $json;
        }

        $body = $this->normalizePayload($request->get_body_params());
        if ($body !== []) {
            return $body;
        }

        return $this->normalizePayload($request->get_params());
    }

    public function normalizeEmail(mixed $value): string
    {
        if (!is_scalar($value)) {
            return '';
        }

        $email = sanitize_email((string) $value);
        return is_email($email) ? strtolower($email) : '';
    }

    public function normalizeText(mixed $value, int $max = 4000): string
    {
        if (!is_scalar($value)) {
            return '';
        }

        $normalized = trim(preg_replace('/\s+/u', ' ', (string) $value) ?? '');
        if ($normalized === '') {
            return '';
        }

        return function_exists('mb_substr')
            ? mb_substr($normalized, 0, $max)
            : substr($normalized, 0, $max);
    }

    public function normalizeSlug(mixed $value, int $max = 64): string
    {
        if (!is_scalar($value)) {
            return '';
        }

        $normalized = strtolower(trim((string) $value));
        if ($normalized === '' || strlen($normalized) > $max || !preg_match('/^[a-z0-9][a-z0-9_-]*$/', $normalized)) {
            return '';
        }

        return $normalized;
    }

    public function normalizeRedirectTo(mixed $value): string
    {
        if (!is_scalar($value)) {
            return '';
        }

        $redirect = trim((string) $value);
        if ($redirect === '') {
            return '';
        }

        $sanitized = esc_url_raw($redirect);
        if ($sanitized === '' || strlen($sanitized) > 1024) {
            return '';
        }

        return $sanitized;
    }

    public function normalizeDraftRef(mixed $value): string
    {
        if (!is_scalar($value)) {
            return '';
        }

        $ref = trim((string) $value);
        if ($ref === '' || strlen($ref) > 128 || !preg_match('/^[A-Za-z0-9_-]{8,128}$/', $ref)) {
            return '';
        }

        return $ref;
    }

    public function generateDraftIdempotencyKey(): string
    {
        if (function_exists('wp_generate_uuid4')) {
            $uuid = strtolower((string) wp_generate_uuid4());
            if ($uuid !== '') {
                return $uuid;
            }
        }

        return 'draft_' . strtolower((string) wp_generate_password(24, false, false));
    }

    /**
     * @param array<string, mixed> $params
     * @return array<string, mixed>
     */
    public function normalizePatientPayload(array $params): array
    {
        $patient = isset($params['patient']) && is_array($params['patient']) ? $params['patient'] : [];

        $fullName = $this->normalizeText(
            $patient['fullname'] ?? ($patient['fullName'] ?? ($params['fullname'] ?? '')),
            160
        );
        $firstName = $this->normalizeText(
            $patient['firstName'] ?? ($patient['first_name'] ?? ''),
            100
        );
        $lastName = $this->normalizeText(
            $patient['lastName'] ?? ($patient['last_name'] ?? ''),
            120
        );
        $birthdate = $this->normalizeText(
            $patient['birthdate'] ?? ($patient['birthDate'] ?? ($params['birthdate'] ?? '')),
            20
        );
        $note = $this->normalizeText(
            $patient['note'] ?? ($patient['medical_notes'] ?? ($patient['medicalNotes'] ?? ($params['privateNotes'] ?? ''))),
            4000
        );

        $payload = [
            'fullname' => $fullName,
            'firstName' => $firstName,
            'lastName' => $lastName,
            'birthdate' => $birthdate,
            'birthDate' => $birthdate,
        ];

        if ($note !== '') {
            $payload['note'] = $note;
            $payload['medical_notes'] = $note;
            $payload['medicalNotes'] = $note;
        }

        return $payload;
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public function normalizeItemsPayload(mixed $value): array
    {
        if (!is_array($value)) {
            return [];
        }

        $items = [];
        foreach ($value as $entry) {
            if (!is_array($entry)) {
                continue;
            }

            $label = $this->normalizeText($entry['label'] ?? '', 200);
            if ($label === '') {
                continue;
            }

            $item = [
                'label' => $label,
                'schedule' => isset($entry['schedule']) && is_array($entry['schedule']) ? $entry['schedule'] : [],
            ];

            if (isset($entry['cis']) && is_scalar($entry['cis'])) {
                $item['cis'] = trim((string) $entry['cis']);
            }
            if (isset($entry['cip13']) && is_scalar($entry['cip13'])) {
                $item['cip13'] = trim((string) $entry['cip13']);
            }
            if (isset($entry['quantite']) && is_scalar($entry['quantite'])) {
                $item['quantite'] = trim((string) $entry['quantite']);
            }

            $items[] = $item;
        }

        return $items;
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public function normalizeFilesManifest(mixed $value): array
    {
        if (!is_array($value)) {
            return [];
        }

        $files = [];
        foreach ($value as $entry) {
            if (!is_array($entry)) {
                continue;
            }

            $originalName = $this->normalizeText(
                $entry['original_name'] ?? ($entry['originalName'] ?? ($entry['name'] ?? '')),
                255
            );
            if ($originalName === '') {
                continue;
            }

            $sizeBytes = isset($entry['size_bytes']) && is_numeric($entry['size_bytes'])
                ? max(0, (int) $entry['size_bytes'])
                : (isset($entry['size']) && is_numeric($entry['size']) ? max(0, (int) $entry['size']) : 0);

            $files[] = [
                'original_name' => $originalName,
                'mime_type' => $this->normalizeText($entry['mime_type'] ?? ($entry['mime'] ?? 'application/octet-stream'), 120),
                'size_bytes' => $sizeBytes,
                'kind' => 'PROOF',
                'status' => $this->normalizeText($entry['status'] ?? 'QUEUED', 32) ?: 'QUEUED',
            ];
        }

        return $files;
    }
}
