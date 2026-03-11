<?php
declare(strict_types=1);

namespace SosPrescription\Rest;

use SosPrescription\Services\MedicationImporter;
use SosPrescription\Services\RestGuard;
use WP_Error;
use WP_REST_Request;

final class ImportController
{
    private MedicationImporter $importer;

    public function __construct()
    {
        $this->importer = new MedicationImporter();
    }

    public function permissions_check_manage_data(WP_REST_Request $request): bool|WP_Error
    {
        $ok = RestGuard::require_logged_in($request);
        if (is_wp_error($ok)) {
            return $ok;
        }

        $ok = RestGuard::require_wp_rest_nonce($request);
        if (is_wp_error($ok)) {
            return $ok;
        }

        $ok = RestGuard::require_any_cap($request, ['sosprescription_manage_data', 'manage_options']);
        if (is_wp_error($ok)) {
            return $ok;
        }

        return true;
    }

    public function upload_zip(WP_REST_Request $request)
    {
        if (!isset($_FILES['file']) || !is_array($_FILES['file'])) {
            return new WP_Error('sosprescription_missing_file', 'Fichier manquant (champ "file").', ['status' => 400]);
        }

        $file = $_FILES['file'];

        if (!isset($file['tmp_name'], $file['name'], $file['error'])) {
            return new WP_Error('sosprescription_bad_file', 'Fichier invalide.', ['status' => 400]);
        }

        if ((int) $file['error'] !== UPLOAD_ERR_OK) {
            return new WP_Error('sosprescription_upload_error', 'Erreur upload (code ' . (int) $file['error'] . ').', ['status' => 400]);
        }

        $tmp = (string) $file['tmp_name'];
        if (!is_uploaded_file($tmp)) {
            return new WP_Error('sosprescription_upload_error', 'Upload non valide.', ['status' => 400]);
        }

        $uploads = wp_upload_dir();
        $dir = rtrim((string) $uploads['basedir'], '/') . '/sosprescription-import/uploads';
        wp_mkdir_p($dir);

        $name = sanitize_file_name((string) $file['name']);
        if ($name === '') {
            $name = 'bdpm.zip';
        }

        $dest = $dir . '/' . gmdate('Ymd_His') . '_' . $name;

        if (!move_uploaded_file($tmp, $dest)) {
            return new WP_Error('sosprescription_upload_error', 'Impossible de déplacer le fichier uploadé.', ['status' => 500]);
        }

        $session = $this->importer->start_session_from_zip($dest);
        if (is_wp_error($session)) {
            return $session;
        }

        return rest_ensure_response($session);
    }

    public function step(WP_REST_Request $request)
    {
        $res = $this->importer->step();
        return is_wp_error($res) ? $res : rest_ensure_response($res);
    }

    public function status(WP_REST_Request $request)
    {
        $res = $this->importer->get_state();
        return rest_ensure_response($res);
    }

    public function reset(WP_REST_Request $request)
    {
        $this->importer->reset();
        return rest_ensure_response(['ok' => true]);
    }
}
