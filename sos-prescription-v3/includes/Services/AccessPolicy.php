<?php
declare(strict_types=1);

namespace SOSPrescription\Services;

/**
 * Centralise les règles d'accès aux objets sensibles (prescriptions, messages, fichiers).
 *
 * Objectif : appliquer le principe du moindre privilège.
 * - Admin (sosprescription_manage / manage_options): accès global.
 * - Médecin (sosprescription_validate): accès aux dossiers non assignés ou assignés à lui.
 * - Patient: accès uniquement à ses dossiers.
 */
final class AccessPolicy
{
    public static function is_admin(): bool
    {
        return current_user_can('sosprescription_manage') || current_user_can('manage_options');
    }

    public static function is_doctor(): bool
    {
        return current_user_can('sosprescription_validate');
    }

    /**
     * @param array<string, mixed> $rx
     */
    public static function can_current_user_access_prescription_row(array $rx): bool
    {
        $uid = (int) get_current_user_id();
        if ($uid < 1) {
            return false;
        }

        if (self::is_admin()) {
            return true;
        }

        $patient_id = isset($rx['patient_user_id']) ? (int) $rx['patient_user_id'] : 0;
        $doctor_id = array_key_exists('doctor_user_id', $rx) && $rx['doctor_user_id'] !== null ? (int) $rx['doctor_user_id'] : null;

        // Patient
        if (!self::is_doctor()) {
            return $patient_id > 0 && $patient_id === $uid;
        }

        // Doctor
        if ($doctor_id === null || $doctor_id < 1) {
            return true; // non assigné
        }

        return $doctor_id === $uid;
    }

    /**
     * @param array<string, mixed> $rx
     */
    public static function can_doctor_access_prescription_row(array $rx, int $doctor_user_id): bool
    {
        if ($doctor_user_id < 1) {
            return false;
        }
        if (self::is_admin()) {
            return true;
        }
        $assigned = array_key_exists('doctor_user_id', $rx) && $rx['doctor_user_id'] !== null ? (int) $rx['doctor_user_id'] : null;
        if ($assigned === null || $assigned < 1) {
            return true;
        }
        return $assigned === $doctor_user_id;
    }
}
