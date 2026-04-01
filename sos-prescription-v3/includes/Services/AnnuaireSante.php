<?php
declare(strict_types=1);

namespace SosPrescription\Services;

/**
 * Sonde Annuaire Santé.
 *
 * Stratégie :
 * 1) si une clé API officielle est configurée, on utilise l'API FHIR Annuaire Santé
 *    documentée par l'ANS (Practitioner + PractitionerRole).
 * 2) sinon, on tente un fallback best-effort sur le site public annuaire.esante.gouv.fr
 *    via plusieurs variantes d'appel/scraping silencieux.
 *
 * Le service ne jette pas d'exception applicative vers l'appelant : il retourne null en cas
 * d'échec et journalise en NDJSON si les logs sont activés.
 */
final class AnnuaireSante
{
    private const DEFAULT_TIMEOUT = 8;
    private const FHIR_BASE = 'https://gateway.api.esante.gouv.fr/fhir/v2';
    private const PUBLIC_SEARCH_BASE = 'https://annuaire.esante.gouv.fr/search/pp';

    public function searchByRpps(string $rpps): ?array
    {
        $rpps = preg_replace('/\D+/', '', trim($rpps)) ?: '';
        if ($rpps === '' || strlen($rpps) < 7) {
            return null;
        }

        try {
            $byFhir = $this->searchViaFhirByRpps($rpps);
            if (is_array($byFhir)) {
                return $byFhir;
            }
        } catch (\Throwable $e) {
            $this->logWarning('annuaire_sante.fhir_rpps_failed', [
                'rpps_fp' => $this->fingerprint($rpps),
                'message' => $e->getMessage(),
            ]);
        }

        try {
            $byPublic = $this->searchViaPublicSite([
                ['q' => $rpps],
                ['term' => $rpps],
                ['query' => $rpps],
                ['rpps' => $rpps],
            ], $rpps, '', '');
            if (is_array($byPublic)) {
                return $byPublic;
            }
        } catch (\Throwable $e) {
            $this->logWarning('annuaire_sante.public_rpps_failed', [
                'rpps_fp' => $this->fingerprint($rpps),
                'message' => $e->getMessage(),
            ]);
        }

        return null;
    }

    public function searchByName(string $firstName, string $lastName): ?array
    {
        $firstName = $this->normalizeName($firstName);
        $lastName = $this->normalizeName($lastName);
        if ($firstName === '' || $lastName === '') {
            return null;
        }

        try {
            $byFhir = $this->searchViaFhirByName($firstName, $lastName);
            if (is_array($byFhir)) {
                return $byFhir;
            }
        } catch (\Throwable $e) {
            $this->logWarning('annuaire_sante.fhir_name_failed', [
                'name_fp' => $this->fingerprint($firstName . '|' . $lastName),
                'message' => $e->getMessage(),
            ]);
        }

        try {
            $query = trim($firstName . ' ' . $lastName);
            $byPublic = $this->searchViaPublicSite([
                ['q' => $query],
                ['term' => $query],
                ['query' => $query],
                ['name' => $lastName, 'firstName' => $firstName],
                ['nom' => $lastName, 'prenom' => $firstName],
                ['lastName' => $lastName, 'firstName' => $firstName],
            ], '', $firstName, $lastName);
            if (is_array($byPublic)) {
                return $byPublic;
            }
        } catch (\Throwable $e) {
            $this->logWarning('annuaire_sante.public_name_failed', [
                'name_fp' => $this->fingerprint($firstName . '|' . $lastName),
                'message' => $e->getMessage(),
            ]);
        }

        return null;
    }

    private function searchViaFhirByRpps(string $rpps): ?array
    {
        $apiKey = $this->apiKey();
        if ($apiKey === '') {
            return null;
        }

        $url = add_query_arg([
            'identifier' => $rpps,
            '_revinclude' => 'PractitionerRole:practitioner',
        ], $this->fhirBase() . '/Practitioner');

        $bundle = $this->fetchJson($url, [
            'ESANTE-API-KEY' => $apiKey,
            'Accept' => 'application/fhir+json, application/json',
        ]);

        return $this->extractBestFromFhirBundle($bundle, $rpps, '', '');
    }

    private function searchViaFhirByName(string $firstName, string $lastName): ?array
    {
        $apiKey = $this->apiKey();
        if ($apiKey === '') {
            return null;
        }

        $url = add_query_arg([
            'name:family' => strtoupper($lastName),
            'name:given' => strtoupper($firstName),
            '_revinclude' => 'PractitionerRole:practitioner',
        ], $this->fhirBase() . '/Practitioner');

        $bundle = $this->fetchJson($url, [
            'ESANTE-API-KEY' => $apiKey,
            'Accept' => 'application/fhir+json, application/json',
        ]);

        return $this->extractBestFromFhirBundle($bundle, '', $firstName, $lastName);
    }

    private function extractBestFromFhirBundle(array $bundle, string $wantedRpps, string $wantedFirstName, string $wantedLastName): ?array
    {
        $entries = isset($bundle['entry']) && is_array($bundle['entry']) ? $bundle['entry'] : [];
        if ($entries === []) {
            return null;
        }

        $practitioners = [];
        $specialtiesByPractitioner = [];

        foreach ($entries as $entry) {
            if (!is_array($entry) || !isset($entry['resource']) || !is_array($entry['resource'])) {
                continue;
            }
            $resource = $entry['resource'];
            $resourceType = isset($resource['resourceType']) && is_scalar($resource['resourceType']) ? (string) $resource['resourceType'] : '';

            if ($resourceType === 'Practitioner') {
                $id = isset($resource['id']) && is_scalar($resource['id']) ? trim((string) $resource['id']) : '';
                if ($id === '') {
                    continue;
                }
                $practitioners[$id] = [
                    'rpps' => $this->extractFhirPractitionerIdentifier($resource),
                    'first_name' => $this->extractFhirGivenName($resource),
                    'last_name' => $this->extractFhirFamilyName($resource),
                    'specialty' => '',
                    'source' => 'annuaire_fhir',
                ];
                continue;
            }

            if ($resourceType === 'PractitionerRole') {
                $ref = '';
                if (isset($resource['practitioner']['reference']) && is_scalar($resource['practitioner']['reference'])) {
                    $ref = trim((string) $resource['practitioner']['reference']);
                }
                if ($ref === '' || stripos($ref, 'Practitioner/') === false) {
                    continue;
                }
                $id = preg_replace('#^Practitioner/#i', '', $ref) ?: '';
                if ($id === '') {
                    continue;
                }
                $specialty = $this->extractFhirPractitionerRoleSpecialty($resource);
                if ($specialty !== '') {
                    $specialtiesByPractitioner[$id][] = $specialty;
                }
            }
        }

        foreach ($practitioners as $id => &$row) {
            if (isset($specialtiesByPractitioner[$id]) && is_array($specialtiesByPractitioner[$id]) && $specialtiesByPractitioner[$id] !== []) {
                $row['specialty'] = implode(' • ', array_values(array_unique(array_filter($specialtiesByPractitioner[$id]))));
            }
        }
        unset($row);

        if ($practitioners === []) {
            return null;
        }

        $best = null;
        $bestScore = -1;
        foreach ($practitioners as $row) {
            $score = 0;
            if ($wantedRpps !== '' && isset($row['rpps']) && $row['rpps'] === $wantedRpps) {
                $score += 100;
            }
            if ($wantedFirstName !== '' && $this->normalizeName((string) $row['first_name']) === $this->normalizeName($wantedFirstName)) {
                $score += 20;
            }
            if ($wantedLastName !== '' && $this->normalizeName((string) $row['last_name']) === $this->normalizeName($wantedLastName)) {
                $score += 20;
            }
            if ($row['specialty'] !== '') {
                $score += 5;
            }

            if ($score > $bestScore) {
                $bestScore = $score;
                $best = $row;
            }
        }

        return is_array($best) ? $best : null;
    }

    private function extractFhirPractitionerIdentifier(array $resource): string
    {
        $identifiers = isset($resource['identifier']) && is_array($resource['identifier']) ? $resource['identifier'] : [];
        foreach ($identifiers as $identifier) {
            if (!is_array($identifier)) {
                continue;
            }
            $value = isset($identifier['value']) && is_scalar($identifier['value']) ? preg_replace('/\D+/', '', (string) $identifier['value']) : '';
            if (is_string($value) && $value !== '' && strlen($value) >= 7) {
                return $value;
            }
        }
        return '';
    }

    private function extractFhirGivenName(array $resource): string
    {
        $names = isset($resource['name']) && is_array($resource['name']) ? $resource['name'] : [];
        foreach ($names as $name) {
            if (!is_array($name)) {
                continue;
            }
            if (isset($name['given'][0]) && is_scalar($name['given'][0])) {
                return $this->normalizeName((string) $name['given'][0]);
            }
            if (isset($name['text']) && is_scalar($name['text'])) {
                $parts = preg_split('/\s+/', trim((string) $name['text'])) ?: [];
                if ($parts !== []) {
                    return $this->normalizeName((string) $parts[0]);
                }
            }
        }
        return '';
    }

    private function extractFhirFamilyName(array $resource): string
    {
        $names = isset($resource['name']) && is_array($resource['name']) ? $resource['name'] : [];
        foreach ($names as $name) {
            if (!is_array($name)) {
                continue;
            }
            if (isset($name['family']) && is_scalar($name['family'])) {
                return $this->normalizeName((string) $name['family']);
            }
            if (isset($name['text']) && is_scalar($name['text'])) {
                $parts = preg_split('/\s+/', trim((string) $name['text'])) ?: [];
                if (count($parts) >= 2) {
                    return $this->normalizeName((string) array_pop($parts));
                }
            }
        }
        return '';
    }

    private function extractFhirPractitionerRoleSpecialty(array $resource): string
    {
        $specialties = isset($resource['specialty']) && is_array($resource['specialty']) ? $resource['specialty'] : [];
        $out = [];
        foreach ($specialties as $specialty) {
            if (!is_array($specialty)) {
                continue;
            }
            if (isset($specialty['text']) && is_scalar($specialty['text'])) {
                $txt = trim((string) $specialty['text']);
                if ($txt !== '') {
                    $out[] = $txt;
                }
            }
            $codings = isset($specialty['coding']) && is_array($specialty['coding']) ? $specialty['coding'] : [];
            foreach ($codings as $coding) {
                if (!is_array($coding)) {
                    continue;
                }
                $display = isset($coding['display']) && is_scalar($coding['display']) ? trim((string) $coding['display']) : '';
                if ($display !== '') {
                    $out[] = $display;
                }
            }
        }
        $out = array_values(array_unique(array_filter($out)));
        return $out !== [] ? implode(' • ', $out) : '';
    }

    private function searchViaPublicSite(array $queryVariants, string $wantedRpps, string $wantedFirstName, string $wantedLastName): ?array
    {
        foreach ($queryVariants as $queryArgs) {
            if (!is_array($queryArgs) || $queryArgs === []) {
                continue;
            }

            $url = add_query_arg($queryArgs, $this->publicSearchBase());
            $response = wp_remote_get($url, [
                'timeout' => self::DEFAULT_TIMEOUT,
                'redirection' => 2,
                'headers' => [
                    'Accept' => 'text/html,application/json;q=0.9,*/*;q=0.8',
                    'User-Agent' => $this->userAgent(),
                ],
            ]);

            if (is_wp_error($response)) {
                continue;
            }

            $code = (int) wp_remote_retrieve_response_code($response);
            if ($code < 200 || $code >= 300) {
                continue;
            }

            $body = (string) wp_remote_retrieve_body($response);
            if ($body === '') {
                continue;
            }

            $candidates = [];
            $contentType = strtolower((string) wp_remote_retrieve_header($response, 'content-type'));
            if (str_contains($contentType, 'json')) {
                $decoded = json_decode($body, true);
                if (is_array($decoded)) {
                    $candidates = array_merge($candidates, $this->collectCandidatesFromMixed($decoded));
                }
            }

            $candidates = array_merge($candidates, $this->extractCandidatesFromHtml($body));
            $best = $this->pickBestCandidate($candidates, $wantedRpps, $wantedFirstName, $wantedLastName);
            if (is_array($best)) {
                $best['source'] = 'annuaire_public';
                return $best;
            }
        }

        return null;
    }

    private function extractCandidatesFromHtml(string $html): array
    {
        $candidates = [];

        foreach ($this->extractEmbeddedJsonStrings($html) as $json) {
            $decoded = json_decode($json, true);
            if (is_array($decoded)) {
                $candidates = array_merge($candidates, $this->collectCandidatesFromMixed($decoded));
            }
        }

        $text = html_entity_decode(wp_strip_all_tags($html), ENT_QUOTES | ENT_HTML5, 'UTF-8');
        $text = preg_replace('/\s+/', ' ', $text) ?: '';
        if ($text !== '') {
            $candidate = [
                'rpps' => '',
                'first_name' => '',
                'last_name' => '',
                'specialty' => '',
            ];
            if (preg_match('/\b(?:RPPS|Identifiant RPPS)\b[^\d]{0,20}(\d{7,14})/iu', $text, $m)) {
                $candidate['rpps'] = $m[1];
            }
            if (preg_match('/\b(?:Pr[ée]nom(?: d[’\']exercice)?)\b[^A-Za-zÀ-ÿ]{0,20}([A-Za-zÀ-ÿ\-\' ]{2,80})/iu', $text, $m)) {
                $candidate['first_name'] = $this->normalizeName($m[1]);
            }
            if (preg_match('/\b(?:Nom(?: d[’\']exercice)?)\b[^A-Za-zÀ-ÿ]{0,20}([A-Za-zÀ-ÿ\-\' ]{2,80})/iu', $text, $m)) {
                $candidate['last_name'] = $this->normalizeName($m[1]);
            }
            if (preg_match('/\b(?:Sp[ée]cialit[ée]|Profession)\b[^A-Za-zÀ-ÿ]{0,20}([A-Za-zÀ-ÿ0-9\-\' ]{2,120})/iu', $text, $m)) {
                $candidate['specialty'] = trim($m[1]);
            }
            if ($candidate['rpps'] !== '' || ($candidate['first_name'] !== '' && $candidate['last_name'] !== '')) {
                $candidates[] = $candidate;
            }
        }

        return $candidates;
    }

    private function extractEmbeddedJsonStrings(string $html): array
    {
        $out = [];
        $patterns = [
            '/<script[^>]*type=["\']application\/ld\+json["\'][^>]*>(.*?)<\/script>/is',
            '/<script[^>]*id=["\']__NEXT_DATA__["\'][^>]*>(.*?)<\/script>/is',
            '/window\.__INITIAL_STATE__\s*=\s*(\{.*?\})\s*;/is',
            '/window\.__PRELOADED_STATE__\s*=\s*(\{.*?\})\s*;/is',
            '/window\.__NUXT__\s*=\s*(\{.*?\})\s*;/is',
        ];

        foreach ($patterns as $pattern) {
            if (!preg_match_all($pattern, $html, $matches) || empty($matches[1])) {
                continue;
            }
            foreach ($matches[1] as $match) {
                if (!is_string($match)) {
                    continue;
                }
                $candidate = trim(html_entity_decode($match, ENT_QUOTES | ENT_HTML5, 'UTF-8'));
                if ($candidate !== '') {
                    $out[] = $candidate;
                }
            }
        }

        return array_values(array_unique($out));
    }

    private function collectCandidatesFromMixed($value): array
    {
        $out = [];
        if (is_array($value)) {
            $mapped = $this->mapPotentialCandidate($value);
            if ($mapped !== null) {
                $out[] = $mapped;
            }
            foreach ($value as $item) {
                $out = array_merge($out, $this->collectCandidatesFromMixed($item));
            }
        }
        return $out;
    }

    private function mapPotentialCandidate(array $row): ?array
    {
        $flat = $this->flattenKeys($row);
        if ($flat === []) {
            return null;
        }

        $rpps = $this->firstMappedValue($flat, [
            'rpps', 'ps_idnat', 'idnat', 'identifiantnational', 'identifiantrpps', 'identifiantrppsadeli', 'identifier.value',
        ]);
        $firstName = $this->firstMappedValue($flat, [
            'prenom', 'firstname', 'given', 'ps_prenom', 'name.given', 'valuehumanname.given',
        ]);
        $lastName = $this->firstMappedValue($flat, [
            'nom', 'lastname', 'family', 'ps_nom', 'name.family', 'valuehumanname.family',
        ]);
        $specialty = $this->firstMappedValue($flat, [
            'specialite', 'specialty', 'ps_specrpps', 'profession', 'specialitequalification', 'display',
        ]);

        $rpps = preg_replace('/\D+/', '', $rpps ?: '') ?: '';
        $firstName = $this->normalizeName($firstName ?: '');
        $lastName = $this->normalizeName($lastName ?: '');
        $specialty = trim((string) ($specialty ?? ''));

        if ($rpps === '' && ($firstName === '' || $lastName === '')) {
            return null;
        }

        return [
            'rpps' => $rpps,
            'first_name' => $firstName,
            'last_name' => $lastName,
            'specialty' => $specialty,
        ];
    }

    private function flattenKeys(array $value, string $prefix = ''): array
    {
        $out = [];
        foreach ($value as $key => $item) {
            $key = is_string($key) ? $key : (string) $key;
            $path = $prefix === '' ? $key : $prefix . '.' . $key;
            if (is_array($item)) {
                $out += $this->flattenKeys($item, $path);
                continue;
            }
            if (is_scalar($item) && trim((string) $item) !== '') {
                $out[strtolower($path)] = trim((string) $item);
                $tail = strtolower($key);
                if (!isset($out[$tail])) {
                    $out[$tail] = trim((string) $item);
                }
            }
        }
        return $out;
    }

    private function firstMappedValue(array $flat, array $candidates): string
    {
        foreach ($candidates as $candidate) {
            $candidate = strtolower($candidate);
            foreach ($flat as $key => $value) {
                if ($key === $candidate || str_ends_with($key, '.' . $candidate) || str_contains($key, $candidate)) {
                    return is_string($value) ? $value : '';
                }
            }
        }
        return '';
    }

    private function pickBestCandidate(array $candidates, string $wantedRpps, string $wantedFirstName, string $wantedLastName): ?array
    {
        if ($candidates === []) {
            return null;
        }

        $best = null;
        $bestScore = -1;
        $wantedFirstName = $this->normalizeName($wantedFirstName);
        $wantedLastName = $this->normalizeName($wantedLastName);

        foreach ($candidates as $candidate) {
            if (!is_array($candidate)) {
                continue;
            }
            $score = 0;
            $rpps = preg_replace('/\D+/', '', (string) ($candidate['rpps'] ?? '')) ?: '';
            $firstName = $this->normalizeName((string) ($candidate['first_name'] ?? ''));
            $lastName = $this->normalizeName((string) ($candidate['last_name'] ?? ''));
            $specialty = trim((string) ($candidate['specialty'] ?? ''));

            if ($wantedRpps !== '' && $rpps === $wantedRpps) {
                $score += 100;
            }
            if ($wantedFirstName !== '' && $firstName === $wantedFirstName) {
                $score += 20;
            }
            if ($wantedLastName !== '' && $lastName === $wantedLastName) {
                $score += 20;
            }
            if ($specialty !== '') {
                $score += 5;
            }

            if ($score > $bestScore) {
                $bestScore = $score;
                $best = [
                    'rpps' => $rpps,
                    'first_name' => $firstName,
                    'last_name' => $lastName,
                    'specialty' => $specialty,
                ];
            }
        }

        return is_array($best) ? $best : null;
    }

    private function fetchJson(string $url, array $headers = []): array
    {
        $response = wp_remote_get($url, [
            'timeout' => self::DEFAULT_TIMEOUT,
            'redirection' => 2,
            'headers' => array_merge([
                'User-Agent' => $this->userAgent(),
            ], $headers),
        ]);

        if (is_wp_error($response)) {
            throw new \RuntimeException($response->get_error_message());
        }

        $code = (int) wp_remote_retrieve_response_code($response);
        $body = (string) wp_remote_retrieve_body($response);
        if ($code < 200 || $code >= 300) {
            throw new \RuntimeException('HTTP ' . $code);
        }
        $decoded = json_decode($body, true);
        if (!is_array($decoded)) {
            throw new \RuntimeException('JSON illisible');
        }

        return $decoded;
    }

    private function apiKey(): string
    {
        $value = getenv('ANN_SANTE_API_KEY');
        if (is_string($value) && trim($value) !== '') {
            return trim($value);
        }
        if (defined('ANN_SANTE_API_KEY')) {
            return trim((string) constant('ANN_SANTE_API_KEY'));
        }
        return '';
    }

    private function fhirBase(): string
    {
        $value = getenv('ANN_SANTE_FHIR_BASE_URL');
        if (is_string($value) && trim($value) !== '') {
            return rtrim(trim($value), '/');
        }
        if (defined('ANN_SANTE_FHIR_BASE_URL')) {
            return rtrim(trim((string) constant('ANN_SANTE_FHIR_BASE_URL')), '/');
        }
        return self::FHIR_BASE;
    }

    private function publicSearchBase(): string
    {
        $value = getenv('ANN_SANTE_PUBLIC_SEARCH_BASE_URL');
        if (is_string($value) && trim($value) !== '') {
            return rtrim(trim($value), '/');
        }
        if (defined('ANN_SANTE_PUBLIC_SEARCH_BASE_URL')) {
            return rtrim(trim((string) constant('ANN_SANTE_PUBLIC_SEARCH_BASE_URL')), '/');
        }
        return self::PUBLIC_SEARCH_BASE;
    }

    private function normalizeName(string $value): string
    {
        $value = trim((string) $value);
        $value = preg_replace('/\s+/', ' ', $value) ?: $value;
        return $value !== '' ? mb_strtoupper($value) : '';
    }

    private function fingerprint(string $value): string
    {
        return substr(hash('sha256', strtolower(trim($value))), 0, 12);
    }

    private function userAgent(): string
    {
        return 'SOSPrescription/3.4.52 (+'. home_url('/') .')';
    }

    private function logWarning(string $event, array $payload): void
    {
        try {
            Logger::ndjson_scoped('runtime', 'annuaire_sante', 'warning', $event, $payload);
        } catch (\Throwable $e) {
            error_log('[SOSPrescription] AnnuaireSante log failure: ' . $e->getMessage());
        }
    }
}
