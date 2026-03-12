<?php
declare(strict_types=1);

namespace SOSPrescription\Utils;

/**
 * Utilities autour des dates (DDN, âge) pour usage "médical".
 *
 * Objectifs :
 * - Accepter une DDN saisie en "JJ/MM/AAAA" (UX FR) ou ISO "AAAA-MM-JJ".
 * - Normaliser en ISO 8601 (AAAA-MM-JJ) pour stockage.
 * - Calculer un libellé d'âge adapté (jours / mois / ans+mois / ans).
 *
 * NB: on ne stocke jamais l'âge en base (calcul "on the fly").
 */
final class Date
{
    /**
     * Normalise une date de naissance vers ISO 8601 (Y-m-d).
     *
     * Formats acceptés :
     * - YYYY-MM-DD (ISO)
     * - DD/MM/YYYY (FR)
     * - DD-MM-YYYY
     * - YYYY/MM/DD
     *
     * @return string|null ISO "YYYY-MM-DD" ou null si invalide.
     */
    public static function normalize_birthdate(string $input): ?string
    {
        $raw = trim($input);
        if ($raw === '') {
            return null;
        }

        // ISO 8601
        if (preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $raw, $m)) {
            $y = (int) $m[1];
            $mo = (int) $m[2];
            $d = (int) $m[3];
            if (!checkdate($mo, $d, $y)) {
                return null;
            }
            if (!self::is_reasonable_year($y)) {
                return null;
            }
            return sprintf('%04d-%02d-%02d', $y, $mo, $d);
        }

        // FR "JJ/MM/AAAA" or "JJ-MM-AAAA"
        if (preg_match('/^(\d{2})[\/\-.](\d{2})[\/\-.](\d{4})$/', $raw, $m)) {
            $d = (int) $m[1];
            $mo = (int) $m[2];
            $y = (int) $m[3];
            if (!checkdate($mo, $d, $y)) {
                return null;
            }
            if (!self::is_reasonable_year($y)) {
                return null;
            }
            return sprintf('%04d-%02d-%02d', $y, $mo, $d);
        }

        // "YYYY/MM/DD" or "YYYY.MM.DD"
        if (preg_match('/^(\d{4})[\/\-.](\d{2})[\/\-.](\d{2})$/', $raw, $m)) {
            $y = (int) $m[1];
            $mo = (int) $m[2];
            $d = (int) $m[3];
            if (!checkdate($mo, $d, $y)) {
                return null;
            }
            if (!self::is_reasonable_year($y)) {
                return null;
            }
            return sprintf('%04d-%02d-%02d', $y, $mo, $d);
        }

        return null;
    }

    /**
     * Détermine la précision de la DDN telle que saisie par l'utilisateur.
     *
     * Valeurs stockées (convention "humaine") :
     * - JJ/MM/AAAA : date complète
     * - MM/AAAA : mois + année (non supporté dans le MVP mais prévu)
     * - AAAA : année seule (non supporté dans le MVP mais prévu)
     * - INCONNUE : non reconnu
     */
    public static function birthdate_precision(string $input): string
    {
        $raw = trim($input);
        if ($raw === '') {
            return 'INCONNUE';
        }

        // Date complète (ISO ou FR)
        if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $raw) || preg_match('/^\d{2}[\/\-.]\d{2}[\/\-.]\d{4}$/', $raw)) {
            return 'JJ/MM/AAAA';
        }

        // Mois + année (prévu)
        if (preg_match('/^\d{2}[\/\-.]\d{4}$/', $raw) || preg_match('/^\d{4}-\d{2}$/', $raw)) {
            return 'MM/AAAA';
        }

        // Année seule (prévu)
        if (preg_match('/^\d{4}$/', $raw)) {
            return 'AAAA';
        }

        return 'INCONNUE';
    }

    /**
     * Affiche une date ISO (YYYY-MM-DD) en format FR (DD/MM/YYYY).
     */
    public static function iso_to_fr(?string $iso): string
    {
        $iso = $iso ? trim($iso) : '';
        if ($iso === '') {
            return '';
        }
        if (!preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $iso, $m)) {
            return $iso;
        }
        return $m[3] . '/' . $m[2] . '/' . $m[1];
    }

    /**
     * Calcule un libellé d'âge "médical".
     *
     * Règles :
     * - < 28 jours : "J3" ou "14 jours"
     * - 1 mois - 2 ans : "14 mois"
     * - 2 ans - 18 ans : "4 ans 6 mois"
     * - >= 18 ans : "45 ans"
     *
     * @param string $birth_iso YYYY-MM-DD
     */
    public static function age_label(string $birth_iso, ?\DateTimeInterface $ref = null): string
    {
        $ref = $ref ?: new \DateTimeImmutable('now', new \DateTimeZone('UTC'));

        // Defensive: if parsing fails, return empty.
        try {
            $birth = new \DateTimeImmutable($birth_iso, new \DateTimeZone('UTC'));
        } catch (\Throwable $e) {
            return '';
        }

        // Birthdate cannot be in the future.
        if ($birth > $ref) {
            return '';
        }

        // Compute exact days.
        $days = (int) $birth->diff($ref)->format('%a');

        if ($days < 28) {
            // Néonatologie: affichage en jours (voire heures si < 48h)
            if ($days < 2) {
                $seconds = max(0, (int) $ref->getTimestamp() - (int) $birth->getTimestamp());
                $hours = (int) floor($seconds / 3600);
                if ($hours > 0 && $hours < 48) {
                    return (string) $hours . ' h';
                }
            }

            return 'J' . (string) $days;
        }

        // Months and years using calendar diff.
        $diff = $birth->diff($ref);
        $years = (int) $diff->y;
        $months = (int) $diff->m;

        // Special case: 29 Feb birthdays – treat as 1 March on non-leap years.
        // DateTime diff can vary by platform; we enforce the "civil" rule requested.
        if (substr($birth_iso, 5) === '02-29') {
            $years = self::age_years_feb29_march1($birth, $ref);
            // Recompute months remainder from the last "birthday" (March 1 rule).
            $birthday = self::birthday_for_year_feb29_march1($birth, (int) $ref->format('Y'));
            if ($ref < $birthday) {
                $birthday = self::birthday_for_year_feb29_march1($birth, (int) $ref->format('Y') - 1);
            }
            $diff2 = $birthday->diff($ref);
            $months = (int) $diff2->m;
        }

        if ($years < 2) {
            $total_months = ($years * 12) + $months;
            return (string) $total_months . ' mois';
        }

        if ($years < 18) {
            if ($months > 0) {
                return $years . ' ans ' . $months . ' mois';
            }
            return $years . ' ans';
        }

        return $years . ' ans';
    }

    /**
     * Returns numeric years (revolute) according to the March 1 rule for Feb 29.
     */
    public static function age_years(string $birth_iso, ?\DateTimeInterface $ref = null): ?int
    {
        $ref = $ref ?: new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        try {
            $birth = new \DateTimeImmutable($birth_iso, new \DateTimeZone('UTC'));
        } catch (\Throwable $e) {
            return null;
        }
        if ($birth > $ref) {
            return null;
        }
        if (substr($birth_iso, 5) === '02-29') {
            return self::age_years_feb29_march1($birth, $ref);
        }
        $y = (int) $ref->format('Y') - (int) $birth->format('Y');
        $birthday_this_year = $birth->setDate((int) $ref->format('Y'), (int) $birth->format('m'), (int) $birth->format('d'));
        if ($ref < $birthday_this_year) {
            $y -= 1;
        }
        return $y;
    }

    private static function is_reasonable_year(int $y): bool
    {
        // Soft guard: avoid absurd years. The UI can still choose a stricter policy.
        $current = (int) gmdate('Y');
        if ($y < 1900) {
            return false;
        }
        if ($y > $current) {
            return false;
        }
        return true;
    }

    private static function is_leap(int $year): bool
    {
        return ($year % 4 === 0 && $year % 100 !== 0) || ($year % 400 === 0);
    }

    private static function birthday_for_year_feb29_march1(\DateTimeImmutable $birth, int $year): \DateTimeImmutable
    {
        if (self::is_leap($year)) {
            return $birth->setDate($year, 2, 29);
        }
        return $birth->setDate($year, 3, 1);
    }

    private static function age_years_feb29_march1(\DateTimeImmutable $birth, \DateTimeInterface $ref): int
    {
        $refYear = (int) $ref->format('Y');
        $years = $refYear - (int) $birth->format('Y');
        $birthday = self::birthday_for_year_feb29_march1($birth, $refYear);
        if ($ref < $birthday) {
            $years -= 1;
        }
        return $years;
    }

    /**
     * Calcule l'IMC (BMI) à partir du poids (kg) et de la taille (cm).
     *
     * @param mixed $weight_kg
     * @param mixed $height_cm
     *
     * @return float|null IMC arrondi à 1 décimale, ou null si non calculable.
     */
    public static function bmi_value(mixed $weight_kg, mixed $height_cm): ?float
    {
        // Normalise les entrées (strings HTML input, etc.)
        $w = is_numeric($weight_kg) ? (float) $weight_kg : null;
        $h = is_numeric($height_cm) ? (float) $height_cm : null;

        if ($w === null || $h === null) {
            return null;
        }

        // Garde-fous (valeurs réalistes) - non bloquants ailleurs.
        if ($w <= 0 || $w > 500) {
            return null;
        }
        if ($h <= 0 || $h > 300) {
            return null;
        }

        $hm = $h / 100.0;
        if ($hm <= 0) {
            return null;
        }

        $bmi = $w / ($hm * $hm);
        if (!is_finite($bmi) || $bmi <= 0) {
            return null;
        }

        return round($bmi, 1);
    }

    /**
     * Libellé d'IMC (BMI) pour affichage (non diagnostic).
     *
     * @param mixed $weight_kg
     * @param mixed $height_cm
     */
    public static function bmi_label(mixed $weight_kg, mixed $height_cm): string
    {
        $bmi = self::bmi_value($weight_kg, $height_cm);
        if ($bmi === null) {
            return '—';
        }

        // Seuils OMS (adultes). Pour pédiatrie : courbes spécifiques => non gérées ici.
        if ($bmi < 18.5) {
            return $bmi . ' • Insuffisance pondérale';
        }
        if ($bmi < 25.0) {
            return $bmi . ' • Corpulence normale';
        }
        if ($bmi < 30.0) {
            return $bmi . ' • Surpoids';
        }
        if ($bmi < 35.0) {
            return $bmi . ' • Obésité (classe I)';
        }
        if ($bmi < 40.0) {
            return $bmi . ' • Obésité (classe II)';
        }
        return $bmi . ' • Obésité (classe III)';
    }
}
