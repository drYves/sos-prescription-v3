<?php
declare(strict_types=1);

namespace SosPrescription\Services;

final class Posology
{
    /**
     * Transforme une structure "schedule" (frontend) en texte lisible.
     *
     * @param array<string, mixed> $schedule
     */
    public static function schedule_to_text(array $schedule): string
    {
        $nb = isset($schedule['nb']) ? (int) $schedule['nb'] : 1;
        if ($nb < 1) { $nb = 1; }
        if ($nb > 12) { $nb = 12; }

        $freq = isset($schedule['freqUnit']) ? (string) $schedule['freqUnit'] : 'jour';
        if (!in_array($freq, ['jour', 'semaine', 'mois'], true)) {
            $freq = 'jour';
        }

        $duration_val = isset($schedule['durationVal']) ? (int) $schedule['durationVal'] : 1;
        if ($duration_val < 1) { $duration_val = 1; }
        if ($duration_val > 3650) { $duration_val = 3650; }

        $duration_unit = isset($schedule['durationUnit']) ? (string) $schedule['durationUnit'] : 'jour';
        if (!in_array($duration_unit, ['jour', 'semaine', 'mois'], true)) {
            $duration_unit = 'jour';
        }

        $base = ($nb > 1 ? $nb . ' fois' : '1 fois') . ' par ' . $freq;
        $base .= ' pendant ' . $duration_val . ' ' . self::pluralize($duration_unit, $duration_val);

        $times = isset($schedule['times']) && is_array($schedule['times']) ? $schedule['times'] : [];
        $doses = isset($schedule['doses']) && is_array($schedule['doses']) ? $schedule['doses'] : [];

        $details = [];
        for ($i = 0; $i < $nb; $i++) {
            $time = isset($times[$i]) ? trim((string) $times[$i]) : '';
            $dose = isset($doses[$i]) ? trim((string) $doses[$i]) : '';

            if ($time === '' && $dose === '') {
                continue;
            }

            if ($dose === '') { $dose = '1'; }
            if ($time === '') { $time = '--:--'; }

            $details[] = $dose . '@' . $time;
        }

        $note = isset($schedule['note']) ? trim((string) $schedule['note']) : '';

        $out = $base;
        if (count($details) > 0) {
            $out .= ' (' . implode(', ', $details) . ')';
        }
        if ($note !== '') {
            $out .= '. ' . $note;
        }

        return $out;
    }

    private static function pluralize(string $unit, int $val): string
    {
        if ($val <= 1) {
            return $unit;
        }

        if ($unit === 'mois') {
            return 'mois';
        }

        return $unit . 's';
    }
}
