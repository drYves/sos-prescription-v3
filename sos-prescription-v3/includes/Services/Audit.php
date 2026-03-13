<?php
// includes/Services/Audit.php
declare(strict_types=1);

namespace SOSPrescription\Services;

use SOSPrescription\Repositories\AuditRepository;

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
    private static ?string $failsafeFile = null;

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

        $actorUserId = null;
        $actorRole = null;
        $ip = null;
        $ua = null;

        try {
            $actorUserId = is_user_logged_in() ? (int) get_current_user_id() : null;

            if (is_user_logged_in()) {
                if (current_user_can('sosprescription_manage') || current_user_can('manage_options')) {
                    $actorRole = 'admin';
                } elseif (current_user_can('sosprescription_validate')) {
                    $actorRole = 'doctor';
                } else {
                    $actorRole = 'patient';
                }
            }

            $ip = isset($_SERVER['REMOTE_ADDR']) ? trim((string) wp_unslash($_SERVER['REMOTE_ADDR'])) : null;
            if ($ip === '') {
                $ip = null;
            }

            $ua = isset($_SERVER['HTTP_USER_AGENT']) ? trim((string) wp_unslash($_SERVER['HTTP_USER_AGENT'])) : null;
            if ($ua === '') {
                $ua = null;
            } elseif ($ua !== null && strlen($ua) > 250) {
                $ua = substr($ua, 0, 250);
            }
        } catch (\Throwable $e) {
            self::write_failsafe_log('audit_actor_resolution_failed', [
                'message' => $e->getMessage(),
                'file' => $e->getFile(),
                'line' => $e->getLine(),
                'action' => $action,
                'object_type' => $object_type,
            ], 'audit');
        }

        if (!is_array($meta)) {
            $meta = [];
        }

        foreach (['body', 'message', 'note', 'patient', 'items', 'attachments'] as $key) {
            if (array_key_exists($key, $meta)) {
                unset($meta[$key]);
            }
        }

        $metaJson = null;
        if ($meta !== []) {
            $tmp = wp_json_encode($meta, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR);
            if (is_string($tmp) && $tmp !== '') {
                if (strlen($tmp) > 5000) {
                    $tmp = substr($tmp, 0, 5000);
                }
                $metaJson = $tmp;
            }
        }

        try {
            $ok = self::repo()->insert([
                'event_at' => function_exists('current_time') ? (string) current_time('mysql') : gmdate('Y-m-d H:i:s'),
                'actor_user_id' => $actorUserId,
                'actor_role' => $actorRole,
                'actor_ip' => $ip,
                'actor_user_agent' => $ua,
                'action' => $action,
                'object_type' => $object_type,
                'object_id' => $object_id,
                'prescription_id' => $prescription_id,
                'meta_json' => $metaJson,
            ]);

            if ($ok !== true) {
                self::write_failsafe_log('audit_insert_returned_false', [
                    'action' => $action,
                    'object_type' => $object_type,
                    'object_id' => $object_id,
                    'prescription_id' => $prescription_id,
                ], 'audit');
            }
        } catch (\Throwable $e) {
            self::write_failsafe_log('audit_insert_exception', [
                'action' => $action,
                'object_type' => $object_type,
                'object_id' => $object_id,
                'prescription_id' => $prescription_id,
                'message' => $e->getMessage(),
                'file' => $e->getFile(),
                'line' => $e->getLine(),
            ], 'audit');
        }
    }

    /**
     * Failsafe logger ultra résilient.
     *
     * Ce logger ne dépend pas des tables SQL ni des options d'activation des logs.
     * Il écrit dans wp-content/uploads/sosprescription.log en best-effort.
     *
     * @param array<string, mixed> $context
     */
    public static function write_failsafe_log(string $message, array $context = [], string $source = 'audit'): void
    {
        try {
            $file = self::failsafe_file();
            if ($file === '') {
                return;
            }

            $source = preg_replace('/[^a-z0-9_\-]+/i', '_', strtolower(trim($source)));
            if (!is_string($source) || $source === '') {
                $source = 'audit';
            }

            $line = '[' . gmdate('c') . '] [' . $source . '] ' . trim($message);

            if ($context !== []) {
                $json = wp_json_encode(
                    self::sanitize_context($context),
                    JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR
                );

                if (is_string($json) && $json !== '') {
                    $line .= ' ' . $json;
                }
            }

            @file_put_contents($file, $line . PHP_EOL, FILE_APPEND | LOCK_EX);
        } catch (\Throwable $e) {
            // no-op by design
        }
    }

    private static function failsafe_file(): string
    {
        if (self::$failsafeFile !== null) {
            return self::$failsafeFile;
        }

        $baseDir = '';

        if (function_exists('wp_upload_dir')) {
            $uploads = wp_upload_dir();
            if (is_array($uploads) && !empty($uploads['basedir'])) {
                $baseDir = (string) $uploads['basedir'];
            }
        }

        if ($baseDir === '' && defined('WP_CONTENT_DIR')) {
            $baseDir = rtrim((string) WP_CONTENT_DIR, '/\\') . DIRECTORY_SEPARATOR . 'uploads';
        }

        if ($baseDir === '') {
            $baseDir = sys_get_temp_dir();
        }

        if (!is_dir($baseDir)) {
            @wp_mkdir_p($baseDir);
        }

        self::$failsafeFile = rtrim($baseDir, '/\\') . DIRECTORY_SEPARATOR . 'sosprescription.log';
        return self::$failsafeFile;
    }

    /**
     * @param array<string, mixed> $context
     * @return array<string, mixed>
     */
    private static function sanitize_context(array $context): array
    {
        $out = [];

        foreach ($context as $key => $value) {
            $safeKey = is_string($key) ? $key : (string) $key;
            $out[$safeKey] = self::sanitize_value($value);
        }

        return $out;
    }

    /**
     * @param mixed $value
     * @return mixed
     */
    private static function sanitize_value($value)
    {
        if ($value === null || is_bool($value) || is_int($value) || is_float($value)) {
            return $value;
        }

        if (is_string($value)) {
            if (strlen($value) > 1000) {
                return substr($value, 0, 1000) . '...';
            }
            return $value;
        }

        if (is_array($value)) {
            $out = [];
            foreach ($value as $key => $item) {
                $safeKey = is_string($key) ? $key : (string) $key;
                $out[$safeKey] = self::sanitize_value($item);
            }
            return $out;
        }

        if (is_object($value)) {
            if ($value instanceof \Throwable) {
                return [
                    'exception' => get_class($value),
                    'message' => $value->getMessage(),
                    'file' => $value->getFile(),
                    'line' => $value->getLine(),
                ];
            }

            if (method_exists($value, '__toString')) {
                return self::sanitize_value((string) $value);
            }

            return ['object' => get_class($value)];
        }

        return (string) $value;
    }
}
