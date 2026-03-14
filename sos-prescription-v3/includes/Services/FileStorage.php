<?php
declare(strict_types=1);

namespace SosPrescription\Services;

use WP_Error;

/**
 * Stockage de fichiers "privés" (pièces justificatives, photos, PDF).
 *
 * IMPORTANT:
 * - On ne s'appuie PAS sur un lien public vers wp-content/uploads.
 * - Les fichiers sont servis via une route REST protégée (nonce + contrôle d'accès).
 * - On crée aussi des fichiers de protection (.htaccess, web.config, index.php)
 *   pour éviter l'accès direct si le serveur le permet.
 *
 * Note: pour une vraie production HDS, il faudra aussi une règle serveur Nginx/Apache
 * pour bloquer toute URL vers /uploads/sosprescription-private/.
 */
final class FileStorage
{
    /**
     * Taille max par défaut (5 Mo) – filtrable.
     */
    public const DEFAULT_MAX_BYTES = 5_000_000;

    /**
     * Dossier racine du stockage privé.
     */
    public static function base_dir(): string
    {
        $upload = wp_upload_dir(null, false);
        $basedir = isset($upload['basedir']) ? (string) $upload['basedir'] : '';
        $basedir = rtrim($basedir, '/');

        $dir = $basedir . '/sosprescription-private';

        /**
         * Permet de déplacer le stockage hors webroot (recommandé) si l'hébergeur le permet.
         *
         * @param string $dir
         */
        $dir = (string) apply_filters('sosprescription_storage_dir', $dir);

        return rtrim($dir, '/');
    }

    public static function max_bytes(): int
    {
        $max = self::DEFAULT_MAX_BYTES;
        /**
         * @param int $max
         */
        $max = (int) apply_filters('sosprescription_storage_max_bytes', $max);
        if ($max < 1_000_000) {
            $max = 1_000_000;
        }
        return $max;
    }

    /**
     * Extensions autorisées (filtrables).
     *
     * @return array<int, string>
     */
    public static function allowed_exts(): array
    {
        $exts = ['jpg', 'jpeg', 'png', 'pdf'];
        /**
         * @param array<int, string> $exts
         */
        $exts = (array) apply_filters('sosprescription_storage_allowed_exts', $exts);
        $out = [];
        foreach ($exts as $e) {
            $e = strtolower(trim((string) $e));
            if ($e !== '') {
                $out[] = $e;
            }
        }
        return array_values(array_unique($out));
    }

    public static function ensure_base_dir(): bool|WP_Error
    {
        $dir = self::base_dir();
        if ($dir === '') {
            return new WP_Error('sosprescription_storage_dir', 'Dossier de stockage invalide.', ['status' => 500]);
        }

        if (!wp_mkdir_p($dir)) {
            return new WP_Error('sosprescription_storage_mkdir', 'Impossible de créer le dossier de stockage.', ['status' => 500]);
        }

        // Protection (Apache)
        $ht = $dir . '/.htaccess';
        if (!is_file($ht)) {
            @file_put_contents($ht, "Deny from all\n");
        }

        // Protection (IIS)
        $webcfg = $dir . '/web.config';
        if (!is_file($webcfg)) {
            $content = '<?xml version="1.0" encoding="UTF-8"?>' . "\n";
            $content .= '<configuration><system.webServer><security><authorization>';
            $content .= '<remove users="*" roles="" verbs="" />';
            $content .= '<add accessType="Deny" users="*" />';
            $content .= '</authorization></security></system.webServer></configuration>';
            @file_put_contents($webcfg, $content);
        }

        // Protection: pas d'index
        $index = $dir . '/index.php';
        if (!is_file($index)) {
            @file_put_contents($index, "<?php\n// Silence is golden.\n");
        }

        return true;
    }

    /**
     * Stocke un fichier uploadé (depuis $_FILES) dans le stockage privé.
     *
     * @param array<string, mixed> $file
     * @return array<string, mixed>|WP_Error
     */
    public static function store_uploaded(array $file): array|WP_Error
    {
        $ok = self::ensure_base_dir();
        if (is_wp_error($ok)) {
            return $ok;
        }

        $tmp = isset($file['tmp_name']) ? (string) $file['tmp_name'] : '';
        $name = isset($file['name']) ? (string) $file['name'] : '';
        $size = isset($file['size']) ? (int) $file['size'] : 0;
        $err  = isset($file['error']) ? (int) $file['error'] : 0;

        if ($err !== UPLOAD_ERR_OK) {
            return new WP_Error('sosprescription_upload_error', 'Erreur upload (code ' . $err . ').', ['status' => 400]);
        }
        if ($tmp === '' || !is_uploaded_file($tmp)) {
            return new WP_Error('sosprescription_upload_tmp', 'Fichier temporaire invalide.', ['status' => 400]);
        }
        if ($size <= 0) {
            return new WP_Error('sosprescription_upload_empty', 'Fichier vide.', ['status' => 400]);
        }
        if ($size > self::max_bytes()) {
            return new WP_Error('sosprescription_upload_too_big', 'Fichier trop volumineux.', ['status' => 413]);
        }

        // Détection type/extension (WP)
        $check = wp_check_filetype_and_ext($tmp, $name);
        $ext = isset($check['ext']) ? strtolower((string) $check['ext']) : '';
        $type = isset($check['type']) ? (string) $check['type'] : '';

        if ($ext === '' || $type === '') {
            return new WP_Error('sosprescription_upload_type', 'Type de fichier non reconnu.', ['status' => 400]);
        }

        if (!in_array($ext, self::allowed_exts(), true)) {
            return new WP_Error('sosprescription_upload_forbidden_type', 'Type de fichier non autorisé.', ['status' => 400]);
        }

        // Vérification image (si image)
        if (str_starts_with($type, 'image/')) {
            $info = @getimagesize($tmp);
            if ($info === false) {
                return new WP_Error('sosprescription_upload_bad_image', 'Image invalide.', ['status' => 400]);
            }
        }

        $original_name = sanitize_file_name($name);
        if ($original_name === '') {
            $original_name = 'upload.' . $ext;
        }

        $subdir = gmdate('Y/m');
        $dir = self::base_dir() . '/' . $subdir;
        if (!wp_mkdir_p($dir)) {
            return new WP_Error('sosprescription_storage_mkdir_sub', 'Impossible de créer le dossier de stockage (subdir).', ['status' => 500]);
        }

        // Nom aléatoire (non devinable)
        try {
            $rand = bin2hex(random_bytes(16));
        } catch (\Throwable $e) {
            $rand = md5(uniqid('', true));
        }
        $filename = $rand . '.' . $ext;

        $dest = $dir . '/' . $filename;
        if (!@move_uploaded_file($tmp, $dest)) {
            return new WP_Error('sosprescription_storage_move', 'Impossible de déplacer le fichier uploadé.', ['status' => 500]);
        }

        // Permissions minimales
        @chmod($dest, 0640);

        return [
            'storage_key' => $subdir . '/' . $filename,
            'abs_path' => $dest,
            'mime' => $type,
            'original_name' => $original_name,
            'size_bytes' => $size,
            'ext' => $ext,
        ];
    }

    /**
     * Stocke un contenu généré (PDF, etc.) dans le stockage privé.
     *
     * IMPORTANT:
     * - Utilisé pour la génération serveur (ordonnance PDF, compte-rendu…).
     * - Ne dépend pas de $_FILES / is_uploaded_file.
     *
     * @return array<string, mixed>|WP_Error
     */
    public static function store_contents(string $contents, string $ext, string $mime, string $original_name): array|WP_Error
    {
        $ok = self::ensure_base_dir();
        if (is_wp_error($ok)) {
            return $ok;
        }

        $ext = strtolower(trim($ext));
        $mime = trim($mime);
        $original_name = sanitize_file_name($original_name);

        if ($ext === '' || !preg_match('/^[a-z0-9]{1,8}$/', $ext)) {
            return new WP_Error('sosprescription_storage_ext', 'Extension invalide.', ['status' => 400]);
        }

        if (!in_array($ext, self::allowed_exts(), true)) {
            return new WP_Error('sosprescription_storage_ext_forbidden', 'Extension non autorisée.', ['status' => 400]);
        }

        if ($mime === '') {
            $mime = 'application/octet-stream';
        }

        $size = strlen($contents);
        if ($size <= 0) {
            return new WP_Error('sosprescription_storage_empty', 'Contenu vide.', ['status' => 400]);
        }
        if ($size > self::max_bytes()) {
            return new WP_Error('sosprescription_storage_too_big', 'Fichier trop volumineux.', ['status' => 413]);
        }

        if ($original_name === '') {
            $original_name = 'document.' . $ext;
        }

        $subdir = gmdate('Y/m');
        $dir = self::base_dir() . '/' . $subdir;
        if (!wp_mkdir_p($dir)) {
            return new WP_Error('sosprescription_storage_mkdir_sub', 'Impossible de créer le dossier de stockage (subdir).', ['status' => 500]);
        }

        try {
            $rand = bin2hex(random_bytes(16));
        } catch (\Throwable $e) {
            $rand = md5(uniqid('', true));
        }
        $filename = $rand . '.' . $ext;

        $dest = $dir . '/' . $filename;
        $written = @file_put_contents($dest, $contents);
        if ($written === false) {
            return new WP_Error('sosprescription_storage_write', 'Impossible d\'écrire le fichier.', ['status' => 500]);
        }

        @chmod($dest, 0640);

        return [
            'storage_key' => $subdir . '/' . $filename,
            'abs_path' => $dest,
            'mime' => $mime,
            'original_name' => $original_name,
            'size_bytes' => (int) $size,
            'ext' => $ext,
        ];
    }

    public static function abs_path(string $storage_key): string
    {
        $storage_key = ltrim($storage_key, '/');
        return self::base_dir() . '/' . $storage_key;
    }

    /**
     * Renvoie un chemin absolu sûr (bloque les traversals).
     */
    public static function safe_abs_path(string $storage_key): string|WP_Error
    {
        $storage_key = ltrim((string) $storage_key, '/');
        if ($storage_key === '' || str_contains($storage_key, '..')) {
            return new WP_Error('sosprescription_storage_key', 'Clé de stockage invalide.', ['status' => 400]);
        }

        $base = realpath(self::base_dir());
        if ($base === false) {
            return new WP_Error('sosprescription_storage_base', 'Stockage non disponible.', ['status' => 500]);
        }

        $path = realpath(self::abs_path($storage_key));
        if ($path === false) {
            // Fichier absent
            return new WP_Error('sosprescription_file_missing', 'Fichier introuvable.', ['status' => 404]);
        }

        $base = rtrim($base, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR;
        if (!str_starts_with($path, $base)) {
            return new WP_Error('sosprescription_storage_escape', 'Chemin de stockage invalide.', ['status' => 400]);
        }

        return $path;
    }

    /**
     * Supprime un fichier du stockage privé (best effort).
     *
     * @return bool true si supprimé, false sinon.
     */
    public static function delete_by_storage_key(string $storage_key): bool
    {
        $storage_key = (string) $storage_key;
        if (trim($storage_key) === '') {
            return false;
        }

        $path = self::safe_abs_path($storage_key);
        if (is_wp_error($path)) {
            // Déjà absent ou invalide.
            return false;
        }

        if (!is_file($path)) {
            return false;
        }

        return @unlink($path);
    }
}
