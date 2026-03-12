<?php
declare(strict_types=1);

namespace SOSPrescription\Rest;

use SOSPrescription\Repositories\FileRepository;
use SOSPrescription\Repositories\MessageRepository;
use SOSPrescription\Repositories\PrescriptionRepository;
use SOSPrescription\Services\Logger;
use SOSPrescription\Services\Notifications;
use SOSPrescription\Services\AccessPolicy;
use SOSPrescription\Services\Audit;
use SOSPrescription\Services\RestGuard;
use WP_Error;
use WP_REST_Request;

final class MessagesController
{
    private MessageRepository $repo;
    private PrescriptionRepository $rx;
    private FileRepository $files;

    public function __construct()
    {
        $this->repo = new MessageRepository();
        $this->rx = new PrescriptionRepository();
        $this->files = new FileRepository();
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

        // Anti-abus : limiter l'envoi de messages (POST) sans impacter le polling GET.
        $route = (string) $request->get_route();
        $method = strtoupper((string) $request->get_method());
        if ($method === 'POST' && str_contains($route, '/messages')) {
            $ok = RestGuard::throttle($request, 'messages_post');
            if (is_wp_error($ok)) {
                return $ok;
            }
        }

        return true;
    }

	/**
	 * Récupère la prescription (row complet) ou null.
	 *
	 * @return array<string,mixed>|null
	 */
	private function get_prescription_row(int $prescription_id): ?array
	{
		$rx = $this->rx->get($prescription_id);
		return is_array($rx) ? $rx : null;
	}

    public function list(WP_REST_Request $request)
    {
        $id = (int) $request->get_param('id');
        if ($id < 1) {
            return new WP_Error('sosprescription_bad_id', 'ID invalide.', ['status' => 400]);
        }

		$rx_row = $this->get_prescription_row($id);
		if (!$rx_row) {
			return new WP_Error('sosprescription_not_found', 'Ordonnance introuvable.', ['status' => 404]);
		}
		if (!AccessPolicy::can_current_user_access_prescription_row($rx_row)) {
			return new WP_Error('sosprescription_forbidden', 'Accès refusé.', ['status' => 403]);
		}

        $limit = (int) ($request->get_param('limit') ?? 200);
        $offset = (int) ($request->get_param('offset') ?? 0);

		Audit::log('messages_view', 'prescription', $id, $id);
		return rest_ensure_response($this->repo->list_for_prescription($id, $limit, $offset));
    }

    public function create(WP_REST_Request $request)
    {
        $scope = strtolower(trim((string) $request->get_header('X-Sos-Scope')));
        $t0 = microtime(true);

        $id = (int) $request->get_param('id');
        if ($id < 1) {
            return new WP_Error('sosprescription_bad_id', 'ID invalide.', ['status' => 400]);
        }

		$current_user_id = (int) get_current_user_id();
		$rx_row = $this->get_prescription_row($id);
		if (!$rx_row) {
			return new WP_Error('sosprescription_not_found', 'Ordonnance introuvable.', ['status' => 404]);
		}
		if (!AccessPolicy::can_current_user_access_prescription_row($rx_row)) {
			return new WP_Error('sosprescription_forbidden', 'Accès refusé.', ['status' => 403]);
		}
		$owner = isset($rx_row['patient_user_id']) ? (int) $rx_row['patient_user_id'] : 0;
		if ($owner < 1) {
			return new WP_Error('sosprescription_not_found', 'Ordonnance introuvable.', ['status' => 404]);
		}
		$is_staff = AccessPolicy::is_admin() || AccessPolicy::is_doctor();

        $params = $request->get_json_params();
        if (!is_array($params)) {
            $params = [];
        }

        $body = isset($params['body']) ? trim((string) $params['body']) : '';
        if ($body === '' || mb_strlen($body) < 1) {
            return new WP_Error('sosprescription_bad_body', 'Message vide.', ['status' => 400]);
        }
        if (mb_strlen($body) > 8000) {
            return new WP_Error('sosprescription_body_too_long', 'Message trop long.', ['status' => 400]);
        }

        $attachments = null;
        if (isset($params['attachments']) && is_array($params['attachments'])) {
            $attachments = array_values(array_filter(array_map('intval', $params['attachments']), static fn ($v) => $v > 0));
            if (count($attachments) > 10) {
                return new WP_Error('sosprescription_too_many_attachments', 'Trop de pièces jointes.', ['status' => 400]);
            }
        }

		// Rôle auteur
		$author_role = $is_staff ? 'doctor' : 'patient';
		$author_user_id = (int) $current_user_id;

        // Validation + rattachement des pièces jointes
        if (is_array($attachments) && count($attachments) > 0) {
            foreach ($attachments as $fid) {
                $f = $this->files->get((int) $fid);
                if (!$f) {
                    return new WP_Error('sosprescription_attachment_missing', 'Pièce jointe introuvable.', ['status' => 404]);
                }

                $f_presc = $f['prescription_id'] !== null ? (int) $f['prescription_id'] : null;
                $f_owner = (int) ($f['owner_user_id'] ?? 0);

                // Si déjà rattachée, elle doit correspondre à la prescription.
                if ($f_presc !== null && $f_presc !== $id) {
                    return new WP_Error('sosprescription_attachment_forbidden', 'Pièce jointe non autorisée.', ['status' => 403]);
                }

				// Patient: doit être propriétaire.
				if (!$is_staff && $f_owner !== (int) $current_user_id) {
                    return new WP_Error('sosprescription_attachment_forbidden', 'Pièce jointe non autorisée.', ['status' => 403]);
                }

                // Staff:
                // - autorise les pièces du patient (owner) même si non rattachées (elles seront attachées)
                // - autorise aussi une pièce uploadée par le médecin SI elle est déjà rattachée à cette prescription
                //   (ex: PDF d'ordonnance, document de réponse), afin d'éviter toute fuite inter-dossiers.
				if ($is_staff) {
                    $is_patient_file = $f_owner === (int) $owner;
                    $is_doctor_file_attached_here = ($f_presc !== null && $f_presc === $id);

                    if (!$is_patient_file && !$is_doctor_file_attached_here) {
                        return new WP_Error('sosprescription_attachment_forbidden', 'Pièce jointe non autorisée.', ['status' => 403]);
                    }
                }
            }

            // Rattache les fichiers non rattachés (staff peut rattacher pour le patient).
            $this->files->attach_to_prescription($id, (int) $owner, $attachments);
        }

        $res = $this->repo->create($id, $author_role, $author_user_id, $body, $attachments);
        if (isset($res['error'])) {
            if ($scope !== '') {
                Logger::log_shortcode($scope, 'error', 'api_message_create_db_error', [
                    'prescription_id' => $id,
                    'message' => (string) ($res['message'] ?? ''),
                    'ms' => (int) round((microtime(true) - $t0) * 1000),
                ]);
            }
            return new WP_Error('sosprescription_db_error', (string) ($res['message'] ?? 'Erreur DB'), ['status' => 500]);
        }

        // Activité
        $this->rx->touch_last_activity($id);

		// Si un médecin envoie un message sur un dossier non assigné, on l'assigne implicitement.
		if ($author_role === 'doctor' && AccessPolicy::is_doctor()) {
			$assigned = isset($rx_row['doctor_user_id']) && $rx_row['doctor_user_id'] !== null ? (int) $rx_row['doctor_user_id'] : null;
			if ($assigned === null) {
				$before_status = isset($rx_row['status']) ? (string) $rx_row['status'] : '';
				$assign = $this->rx->assign_to_doctor($id, (int) $author_user_id);
				if (!isset($assign['error']) && $before_status !== 'in_review') {
					Notifications::patient_assigned($id, (int) $owner, (int) $author_user_id);
				}
			}
		}

        // Workflow : si le dossier était en "needs_info" et que le patient répond,
        // on le remet automatiquement en file "pending".
        if ($author_role === 'patient') {
            $this->rx->set_status_if_current($id, 'needs_info', 'pending');
        }

        // Notifications (sans données de santé)
        if ($author_role === 'doctor') {
            // Ping patient
            Notifications::patient_doctor_message($id, (int) $owner, (int) $author_user_id);
        } else {
            // Ping médecin assigné (optionnel, configurable)
            $doctor_id = $this->rx->get_doctor_user_id($id);
            if ($doctor_id !== null) {
                Notifications::doctor_patient_message($id, (int) $doctor_id, (int) $owner);
            }
        }

        if ($scope !== '') {
            Logger::log_shortcode($scope, 'info', 'api_message_create_done', [
                'prescription_id' => $id,
                'message_id' => (int) ($res['id'] ?? 0),
                'author_role' => $author_role,
                'attachments_count' => is_array($attachments) ? count($attachments) : 0,
                'ms' => (int) round((microtime(true) - $t0) * 1000),
            ]);
        }

		Audit::log('message_create', 'message', isset($res['id']) ? (int) $res['id'] : null, $id, [
			'author_role' => (string) $author_role,
			'attachments_count' => is_array($attachments) ? count($attachments) : 0,
		]);

        return rest_ensure_response($res);
    }
}
