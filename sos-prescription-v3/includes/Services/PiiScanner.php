<?php

namespace SosPrescription\Services;

/**
 * PII Scanner / Masker
 *
 * Objectif : fournir un "filet de sécurité" supplémentaire au-dessus des règles de redaction par clé.
 * - Détecte des patterns PII classiques (email, téléphone FR, NIR FR, IBAN FR)
 * - Permet de les masquer dans les chaînes avant écriture en logs
 * - Utilisé par Logger (masquage) et par l'Admin (audit des logs existants)
 */
final class PiiScanner
{
    /**
     * Liste des patterns PII détectés.
     *
     * IMPORTANT : Les regex doivent être conservatrices pour minimiser les faux positifs.
     */
    public static function patterns(): array
    {
        return [
            // Ex: jean.dupont@example.com
            'email' => '/\b([A-Z0-9._%+\-]+)@([A-Z0-9.\-]+\.[A-Z]{2,})\b/i',

            // FR phones: 0612345678, 06 12 34 56 78, +33 6 12 34 56 78, etc.
            'phone_fr' => '/\b(?:\+33\s?(?:\(0\)\s?)?|0)\s*[1-9](?:[\s.\-]*\d{2}){4}\b/',

            // NIR (FR) : pattern volontairement conservateur
            // 15 caractères (souvent avec espaces). On capture surtout les formats numériques.
            // Ex: 1 84 12 75 123 456 78 (espaces optionnels)
            'nir_fr' => '/\b[12]\s*\d{2}\s*(?:0[1-9]|1[0-2])\s*\d{2}\s*(?:\d{2}|2A|2B|97|98|99)\s*\d{3}\s*\d{3}\s*\d{2}\b/i',

            // IBAN FR (si jamais un paiement/SEPA apparaît dans un log, on masque)
            'iban_fr' => '/\bFR\s*\d{2}(?:\s*\d{4}){5}\b/i',
        ];
    }

    /**
     * Retourne la liste des clés de patterns détectés dans un texte.
     */
    public static function scan_text(string $text): array
    {
        $hits = [];
        foreach (self::patterns() as $key => $regex) {
            if (@preg_match($regex, $text)) {
                $hits[] = $key;
            }
        }
        return $hits;
    }

    /**
     * Masque les patterns PII dans une chaîne.
     *
     * IMPORTANT : doit être UTF-8 safe et ne jamais lever d'exception.
     */
    public static function mask_text(string $text): string
    {
        // Email
        $text = preg_replace_callback(self::patterns()['email'], function (array $m): string {
            return self::mask_email($m[0]);
        }, $text);

        // Téléphone
        $text = preg_replace_callback(self::patterns()['phone_fr'], function (array $m): string {
            return self::mask_phone($m[0]);
        }, $text);

        // NIR
        $text = preg_replace_callback(self::patterns()['nir_fr'], function (array $m): string {
            return self::mask_nir($m[0]);
        }, $text);

        // IBAN
        $text = preg_replace_callback(self::patterns()['iban_fr'], function (array $m): string {
            return self::mask_iban($m[0]);
        }, $text);

        return (string) $text;
    }

    /**
     * Masque une adresse email.
     */
    public static function mask_email(string $email): string
    {
        $email = trim($email);
        if ($email === '' || strpos($email, '@') === false) {
            return '[EMAIL]';
        }
        [$local, $domain] = array_pad(explode('@', $email, 2), 2, '');
        $local = trim($local);
        $domain = trim($domain);
        if ($local === '' || $domain === '') {
            return '[EMAIL]';
        }
        $first = mb_substr($local, 0, 1);
        return $first . '***@' . $domain;
    }

    /**
     * Masque un numéro de téléphone (FR).
     */
    public static function mask_phone(string $raw): string
    {
        $digits = preg_replace('/\D+/', '', $raw);
        if (!is_string($digits) || strlen($digits) < 8) {
            return '[PHONE]';
        }
        $prefix = substr($digits, 0, 2);
        $suffix = substr($digits, -2);
        $middle = str_repeat('•', max(0, strlen($digits) - 4));
        return $prefix . $middle . $suffix;
    }

    /**
     * Masque un NIR.
     */
    public static function mask_nir(string $raw): string
    {
        $digits = preg_replace('/\s+/', '', strtoupper($raw));
        $digits = preg_replace('/[^0-9A-Z]/', '', (string) $digits);
        if ($digits === '' || strlen($digits) < 10) {
            return '[NIR]';
        }
        $prefix = substr($digits, 0, 2);
        $suffix = substr($digits, -2);
        $middle = str_repeat('•', max(0, strlen($digits) - 4));
        return $prefix . $middle . $suffix;
    }

    /**
     * Masque un IBAN.
     */
    public static function mask_iban(string $raw): string
    {
        $compact = preg_replace('/\s+/', '', strtoupper($raw));
        if (!is_string($compact) || strlen($compact) < 8) {
            return '[IBAN]';
        }
        $prefix = substr($compact, 0, 4);
        $suffix = substr($compact, -2);
        return $prefix . '…' . $suffix;
    }

    /**
     * Scanne récursivement une structure (array/string/scalar) et retourne la liste des patterns détectés.
     */
    public static function scan_mixed($value): array
    {
        $hits = [];

        if (is_string($value)) {
            return self::scan_text($value);
        }

        if (is_array($value)) {
            foreach ($value as $k => $v) {
                $hits = array_merge($hits, self::scan_mixed($k));
                $hits = array_merge($hits, self::scan_mixed($v));
            }
            return array_values(array_unique($hits));
        }

        // scalars -> cast
        if (is_scalar($value) && $value !== null) {
            return self::scan_text((string) $value);
        }

        return [];
    }

    /**
     * Audit d'un répertoire de logs .log (NDJSON ou texte).
     *
     * - Retourne un rapport JSON "safe" (aucune donnée PII en clair) : extraits redacts.
     * - Prévoit un plafond de résultats pour éviter les timeouts / gros fichiers.
     */
    public static function audit_logs_dir(string $dir, array $opts = []): array
    {
        $max_findings = isset($opts['max_findings']) ? (int) $opts['max_findings'] : 200;
        $max_lines_per_file = isset($opts['max_lines_per_file']) ? (int) $opts['max_lines_per_file'] : 20000;

        $files = glob(rtrim($dir, '/\\') . '/*.log') ?: [];
        sort($files);

        $report = [
            'meta' => [
                'generated_at' => gmdate('c'),
                'dir' => $dir,
                'patterns' => array_keys(self::patterns()),
                'limits' => [
                    'max_findings' => $max_findings,
                    'max_lines_per_file' => $max_lines_per_file,
                ],
            ],
            'summary' => [
                'files_scanned' => 0,
                'lines_scanned' => 0,
                'hits_total' => 0,
                'hits_by_pattern' => [
                    'email' => 0,
                    'phone_fr' => 0,
                    'nir_fr' => 0,
                    'iban_fr' => 0,
                ],
                'truncated' => false,
            ],
            'findings' => [],
            'warnings' => [],
        ];

        $findings_count = 0;

        foreach ($files as $file) {
            if (!is_readable($file)) {
                $report['warnings'][] = [
                    'file' => basename($file),
                    'warning' => 'not_readable',
                ];
                continue;
            }

            $report['summary']['files_scanned']++;

            $fh = new \SplFileObject($file, 'r');
            $line_no = 0;

            while (!$fh->eof()) {
                $line = (string) $fh->fgets();
                $line_no++;
                if ($line_no > $max_lines_per_file) {
                    $report['warnings'][] = [
                        'file' => basename($file),
                        'warning' => 'max_lines_per_file_reached',
                        'max_lines_per_file' => $max_lines_per_file,
                    ];
                    break;
                }

                $line_trim = trim($line);
                if ($line_trim === '') {
                    continue;
                }

                $report['summary']['lines_scanned']++;

                // Try NDJSON
                $decoded = json_decode($line_trim, true);
                $hits = [];
                if (is_array($decoded)) {
                    $hits = self::scan_mixed($decoded);
                } else {
                    $hits = self::scan_text($line_trim);
                }

                if (!empty($hits)) {
                    $findings_count++;
                    $report['summary']['hits_total'] += count($hits);
                    foreach ($hits as $h) {
                        if (isset($report['summary']['hits_by_pattern'][$h])) {
                            $report['summary']['hits_by_pattern'][$h]++;
                        }
                    }

                    $report['findings'][] = [
                        'file' => basename($file),
                        'line' => $line_no,
                        'patterns' => $hits,
                        // Extrait safe (PII masquée)
                        'excerpt' => mb_substr(self::mask_text($line_trim), 0, 420),
                    ];

                    if ($findings_count >= $max_findings) {
                        $report['summary']['truncated'] = true;
                        $report['warnings'][] = [
                            'warning' => 'max_findings_reached',
                            'max_findings' => $max_findings,
                        ];
                        break 2;
                    }
                }
            }
        }

        return $report;
    }
}
