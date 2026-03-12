<?php
declare(strict_types=1);

namespace SOSPrescription\Rest;

use SOSPrescription\Repositories\FileRepository;
use SOSPrescription\Repositories\PrescriptionRepository;
use SOSPrescription\Services\FileStorage;
use SOSPrescription\Services\Ocr;
use SOSPrescription\Services\Logger;
use SOSPrescription\Services\AccessPolicy;
use SOSPrescription\Services\Audit;
use SOSPrescription\Services\RestGuard;
use WP_Error;
use WP_REST_Request;

final class FilesController
{
    private FileRepository $files;
    private PrescriptionRepository $rx;

    public function __construct()
    {
        $this->files = new FileRepository();
        $this->rx = new PrescriptionRepository();
    }
    public function permissions_check_logged_in_nonce(WP_REST_Request $request): bool|WP_Error
    {
        $ok = RestGuard::require_logged_in($request);
        if (is_wp_error($ok)) {
            return $ok;
        }

        $ok = RestGuard::require_wp_rest_nonce($request);
        if (is_wp_error($ok)) {
            return $ok;
        }

        // Anti-abus (rate limiting) : l'upload est l'opération la plus coûteuse.
        $route = (string) $request->get_route();
        $method = strtoupper((string) $request->get_method());
        if ($method === 'POST' && str_contains($route, '/files/upload')) {
            $ok = RestGuard::throttle($request, 'files_upload');
            if (is_wp_error($ok)) {
                return $ok;
            }
        }

        return true;
    }

    private function can_manage_all(): bool
    {
		return AccessPolicy::is_admin();
    }

	private function is_doctor(): bool
	{
		return AccessPolicy::is_doctor();
	}

    /**
     * Upload d'une pièce justificative.
     *
     * Requiert multipart/form-data avec champ "file" + champ "purpose".
     */
    public function upload(WP_REST_Request $request)
    {
        $scope = strtolower(trim((string) $request->get_header('X-Sos-Scope')));
        $t0 = microtime(true);

        $purpose = (string) ($request->get_param('purpose') ?? '');
        $purpose = strtolower(trim($purpose));

        if ($purpose === '' || !preg_match('/^[a-z0-9_-]{2,30}$/', $purpose)) {
            return new WP_Error('sosprescription_bad_purpose', 'Paramètre "purpose" invalide.', ['status' => 400]);
        }

        $prescription_id = $request->get_param('prescription_id');
        $prescription_id = $prescription_id !== null ? (int) $prescription_id : null;
        if ($prescription_id !== null && $prescription_id < 1) {
            $prescription_id = null;
        }

		$current_user_id = (int) get_current_user_id();

		// Si une prescription_id est donnée, vérifier l'accès.
		if ($prescription_id !== null && !$this->can_manage_all()) {
			if ($this->is_doctor()) {
				$rx_row = $this->rx->get((int) $prescription_id);
				if (!$rx_row) {
					return new WP_Error('sosprescription_not_found', 'Ordonnance introuvable.', ['status' => 404]);
				}
				if (!AccessPolicy::can_current_user_access_prescription_row($rx_row)) {
					return new WP_Error('sosprescription_forbidden', 'Accès refusé.', ['status' => 403]);
				}
			} else {
				$owner = $this->rx->get_owner_user_id($prescription_id);
				if ($owner === null) {
					return new WP_Error('sosprescription_not_found', 'Ordonnance introuvable.', ['status' => 404]);
				}
				if ((int) $owner !== (int) $current_user_id) {
					return new WP_Error('sosprescription_forbidden', 'Accès refusé.', ['status' => 403]);
				}
			}
		}

        $file_params = $request->get_file_params();
        $file = isset($file_params['file']) && is_array($file_params['file']) ? $file_params['file'] : null;
        if (!$file) {
            return new WP_Error('sosprescription_no_file', 'Aucun fichier reçu (champ "file").', ['status' => 400]);
        }

        $stored = FileStorage::store_uploaded($file);
        if (is_wp_error($stored)) {
            if ($scope !== '') {
                Logger::log_shortcode($scope, 'warning', 'api_file_upload_store_fail', [
                    'purpose' => $purpose,
                    'message' => $stored->get_error_message(),
                ]);
            }
            return $stored;
        }

        $res = $this->files->create(
            (int) $current_user_id,
            $prescription_id,
            $purpose,
            (string) ($stored['mime'] ?? 'application/octet-stream'),
            (string) ($stored['original_name'] ?? 'upload'),
            (string) ($stored['storage_key'] ?? ''),
            (int) ($stored['size_bytes'] ?? 0)
        );

        if (isset($res['error'])) {
            // Nettoyage du fichier sur disque si DB KO
            $abs = isset($stored['abs_path']) ? (string) $stored['abs_path'] : '';
            if ($abs !== '' && is_file($abs)) {
                @unlink($abs);
            }
            if ($scope !== '') {
                Logger::log_shortcode($scope, 'error', 'api_file_upload_db_error', [
                    'purpose' => $purpose,
                    'message' => (string) ($res['message'] ?? ''),
                    'ms' => (int) round((microtime(true) - $t0) * 1000),
                ]);
            }
            return new WP_Error('sosprescription_db_error', (string) ($res['message'] ?? 'Erreur DB'), ['status' => 500]);
        }

        $id = (int) ($res['id'] ?? 0);

        if ($scope !== '') {
            Logger::log_shortcode($scope, 'info', 'api_file_upload_done', [
                'file_id' => $id,
                'purpose' => $purpose,
                'prescription_id' => $prescription_id,
                'size_bytes' => (int) ($res['size_bytes'] ?? 0),
                'ms' => (int) round((microtime(true) - $t0) * 1000),
            ]);
        }

		Audit::log('file_upload', 'file', $id, $prescription_id !== null ? (int) $prescription_id : null, [
			'purpose' => (string) $purpose,
			'size_bytes' => (int) ($res['size_bytes'] ?? 0),
			'mime_type' => (string) ($res['mime_type'] ?? ''),
		]);

        return rest_ensure_response($this->format_public_file($res));
    }

    public function get_one(WP_REST_Request $request)
    {
        $id = (int) $request->get_param('id');
        if ($id < 1) {
            return new WP_Error('sosprescription_bad_id', 'ID invalide.', ['status' => 400]);
        }

        $row = $this->files->get($id);
        if (!$row) {
            return new WP_Error('sosprescription_not_found', 'Fichier introuvable.', ['status' => 404]);
        }

        $current_user_id = get_current_user_id();
        if (!$this->can_access_file_row($row, (int) $current_user_id)) {
            return new WP_Error('sosprescription_forbidden', 'Accès refusé.', ['status' => 403]);
        }

        return rest_ensure_response($this->format_public_file($row));
    }

    public function download(WP_REST_Request $request)
    {
        $id = (int) $request->get_param('id');
        if ($id < 1) {
            return new WP_Error('sosprescription_bad_id', 'ID invalide.', ['status' => 400]);
        }

        $row = $this->files->get($id);
        if (!$row) {
            return new WP_Error('sosprescription_not_found', 'Fichier introuvable.', ['status' => 404]);
        }

        $current_user_id = get_current_user_id();
        if (!$this->can_access_file_row($row, (int) $current_user_id)) {
            return new WP_Error('sosprescription_forbidden', 'Accès refusé.', ['status' => 403]);
        }

        $storage_key = (string) ($row['storage_key'] ?? '');
        $path = FileStorage::safe_abs_path($storage_key);
        if (is_wp_error($path)) {
            return $path;
        }

        $mime = (string) ($row['mime'] ?? 'application/octet-stream');
        $name = (string) ($row['original_name'] ?? 'download');
        $size = is_file($path) ? (int) (@filesize($path) ?: 0) : 0;

        // Inline uniquement si explicitement demandé (et si image)
        $inline = (string) ($request->get_param('inline') ?? '0');
        $disposition = ($inline === '1' && str_starts_with($mime, 'image/')) ? 'inline' : 'attachment';

        // Evite toute sortie parasite
        while (ob_get_level()) {
            @ob_end_clean();
        }

        nocache_headers();
        header('Content-Type: ' . $mime);
        header('X-Content-Type-Options: nosniff');
		header('X-Robots-Tag: noindex, nofollow');
		header('Referrer-Policy: no-referrer');
        header('Cache-Control: private, no-store, no-cache, must-revalidate, max-age=0');
        header('Pragma: no-cache');

        // filename*=UTF-8''...
        $fallback = preg_replace('/[^A-Za-z0-9._-]/', '_', $name);
        $fallback = is_string($fallback) && $fallback !== '' ? $fallback : 'download';
        $encoded = rawurlencode($name);
        header("Content-Disposition: {$disposition}; filename=\"{$fallback}\"; filename*=UTF-8''{$encoded}");
        if ($size > 0) {
            header('Content-Length: ' . (string) $size);
        }

		$prescription_id = isset($row['prescription_id']) && $row['prescription_id'] !== null ? (int) $row['prescription_id'] : null;
		Audit::log('file_download', 'file', $id, $prescription_id, [
			'purpose' => (string) ($row['purpose'] ?? ''),
			'mime' => (string) $mime,
			'inline' => $disposition === 'inline',
		]);

        // Stream
        $fp = fopen($path, 'rb');
        if ($fp === false) {
            return new WP_Error('sosprescription_file_open', 'Impossible d’ouvrir le fichier.', ['status' => 500]);
        }
        fpassthru($fp);
        fclose($fp);
        exit;
    }


    /**
     * @param array<string, mixed> $row
     */
    private function can_access_file_row(array $row, int $current_user_id): bool
    {
        if ($this->can_manage_all()) {
            return true;
        }

        $owner_user_id = (int) ($row['owner_user_id'] ?? 0);
        if ($owner_user_id === $current_user_id) {
            return true;
        }

        $prescription_id = $row['prescription_id'] !== null ? (int) $row['prescription_id'] : null;
        if ($prescription_id !== null && $prescription_id > 0) {
			if ($this->is_doctor()) {
				$rx_row = $this->rx->get($prescription_id);
				if ($rx_row && AccessPolicy::can_current_user_access_prescription_row($rx_row)) {
					return true;
				}
			} else {
				$owner = $this->rx->get_owner_user_id($prescription_id);
				if ($owner !== null && (int) $owner === (int) $current_user_id) {
					return true;
				}
			}
        }

        return false;
    }

    /**
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    private function format_public_file(array $row): array
    {
        $id = (int) ($row['id'] ?? 0);
        $out = [
            'id' => $id,
            'prescription_id' => isset($row['prescription_id']) && $row['prescription_id'] !== null ? (int) $row['prescription_id'] : null,
            'purpose' => (string) ($row['purpose'] ?? ''),
            'mime' => (string) ($row['mime'] ?? ''),
            'original_name' => (string) ($row['original_name'] ?? ''),
            'size_bytes' => (int) ($row['size_bytes'] ?? 0),
            'created_at' => (string) ($row['created_at'] ?? ''),
            'download_url' => add_query_arg('_wpnonce', wp_create_nonce('wp_rest'), rest_url('sosprescription/v1/files/' . $id . '/download')),
        ];

        if ($this->can_manage_all()) {
            $out['owner_user_id'] = isset($row['owner_user_id']) ? (int) $row['owner_user_id'] : null;
        }

        return $out;
    }
}
