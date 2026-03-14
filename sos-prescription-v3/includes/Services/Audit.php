<?php
declare(strict_types=1);

namespace SosPrescription\Services;

use SosPrescription\Repositories\AuditRepository;

/**
 * Journal d'audit (actions sensibles + accès).
 *
 * NB: On évite d'y stocker des données de santé (contenu des messages, posologies...).
 * On log principalement: qui (user_id/role), quand, quel objet (prescription_id, file_id, ...),
 * et des métadonnées techniques (status, ...).
 */
final class Audit
{
    private static ?AuditRepository $repo = null;

    private static function repo(): AuditRepository
    {
        if (self::$repo === null) {
            self::$repo = new AuditRepository();
        }
        return self::$repo;
    }

    /**
     * @param array<string, mixed> $meta
     */
    public static function log(string $action, string $object_type, ?int $object_id = null, ?int $prescription_id = null, array $meta = []): void
    {
        $action = strtolower(trim($action));
        $object_type = strtolower(trim($object_type));

        if ($action === '' || $object_type === '') {
            return;
        }

        // Déterminer l'acteur
        $actor_user_id = is_user_logged_in() ? (int) get_current_user_id() : null;

        $actor_role = null;
        if (is_user_logged_in()) {
            if (current_user_can('sosprescription_manage') || current_user_can('manage_options')) {
                $actor_role = 'admin';
            } elseif (current_user_can('sosprescription_validate')) {
                $actor_role = 'doctor';
            } else {
                $actor_role = 'patient';
            }
        }

        $ip = isset($_SERVER['REMOTE_ADDR']) ? (string) $_SERVER['REMOTE_ADDR'] : null;
        if ($ip !== null) {
            $ip = trim($ip);
            if ($ip === '') {
                $ip = null;
            }
        }

        $ua = isset($_SERVER['HTTP_USER_AGENT']) ? (string) $_SERVER['HTTP_USER_AGENT'] : null;
        if ($ua !== null) {
            $ua = trim($ua);
            if ($ua === '') {
                $ua = null;
            } elseif (strlen($ua) > 250) {
                $ua = substr($ua, 0, 250);
            }
        }

        // Nettoyage meta : limite taille & évite les blobs.
        if (!is_array($meta)) {
            $meta = [];
        }

        // Supprime des clés fréquentes qui pourraient contenir des données sensibles.
        foreach (['body', 'message', 'note', 'patient', 'items', 'attachments'] as $k) {
            if (array_key_exists($k, $meta)) {
                unset($meta[$k]);
            }
        }

        $meta_json = null;
        if (count($meta) > 0) {
            $tmp = wp_json_encode($meta, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            if (is_string($tmp) && $tmp !== '') {
                // Limite raisonnable
                if (strlen($tmp) > 5000) {
                    $tmp = substr($tmp, 0, 5000);
                }
                $meta_json = $tmp;
            }
        }

        try {
            self::repo()->insert([
                'event_at' => current_time('mysql'),
                'actor_user_id' => $actor_user_id,
                'actor_role' => $actor_role,
                'actor_ip' => $ip,
                'actor_user_agent' => $ua,
                'action' => $action,
                'object_type' => $object_type,
                'object_id' => $object_id,
                'prescription_id' => $prescription_id,
                'meta_json' => $meta_json,
            ]);
        } catch (\Throwable $e) {
            // Ne jamais casser le flux métier.
        }
    }
}
