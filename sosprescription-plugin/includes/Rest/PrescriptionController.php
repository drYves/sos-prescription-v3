<?php
declare(strict_types=1);

namespace SosPrescription\Rest;

use SosPrescription\Repositories\PrescriptionRepository;
use SosPrescription\Repositories\FileRepository;
use SosPrescription\Services\Logger;
use SosPrescription\Services\Audit;
use SosPrescription\Services\AccessPolicy;
use SosPrescription\Services\ComplianceConfig;
use SosPrescription\Services\RxPdfGenerator;
use SosPrescription\Services\RestGuard;
use SosPrescription\Services\Notifications;
use SosPrescription\Services\StripeClient;
use SosPrescription\Services\SandboxConfig;
use SosPrescription\Services\Turnstile;
use SosPrescription\Services\UidGenerator;
use SosPrescription\Services\Whitelist;
use SosPrescription\Utils\Date;
use WP_Error;
use WP_REST_Request;

final class PrescriptionController
{
    private PrescriptionRepository $repo;

    public function __construct()
    {
        $this->repo = new PrescriptionRepository();
    }
    public function permissions_check_logged_in_nonce(WP_REST_Request $request): bool|WP_Error
    {
        $ok = RestGuard::require_logged_in($request);
        if ($ok !== true) {
            return $ok;
        }

        // Durcissement : on exige désormais un nonce REST valide y compris en GET.
        // Si un cache sert une page avec nonce expiré, l’UX support est guidée via ReqID.
        $ok = RestGuard::require_wp_rest_nonce($request);
        if ($ok !== true) {
            return $ok;
        }

        // Anti-abus : throttling ciblé selon la route.
        $route = (string) $request->get_route();
        $method = strtoupper((string) $request->get_method());

        // Création d'une demande/ordonnance (POST /prescriptions)
        if ($method === 'POST' && preg_match('~/prescriptions$~', $route)) {
            $ok = RestGuard::throttle($request, 'prescriptions_create');
            if ($ok !== true) {
                return $ok;
            }
        }

        // Génération PDF (GET .../rx-pdf)
        if ($method === 'GET' && str_contains($route, '/rx-pdf')) {
            $ok = RestGuard::throttle($request, 'rx_pdf');
            if ($ok !== true) {
                return $ok;
            }
        }

        return true;
    }

    public function permissions_check_validate(WP_REST_Request $request): bool|WP_Error
    {
        $base = $this->permissions_check_logged_in_nonce($request);
        if ($base !== true) {
            return $base;
        }

        return RestGuard::require_cap($request, 'sosprescription_validate');
    }

    public function create(WP_REST_Request $request)
    {
        $scope = strtolower(trim((string) $request->get_header('X-Sos-Scope')));
        $t0 = microtime(true);

        $params = $request->get_json_params();
        if (!is_array($params)) {
            $params = [];
        }

        $patient = isset($params['patient']) && is_array($params['patient']) ? $params['patient'] : [];
        $items = isset($params['items']) && is_array($params['items']) ? $params['items'] : [];
		$consent = isset($params['consent']) && is_array($params['consent']) ? $params['consent'] : [];

        // Champs V2 (optionnels)
        $flow = isset($params['flow']) ? trim((string) $params['flow']) : null;
        if ($flow === '') { $flow = null; }

        $priority = isset($params['priority']) ? trim((string) $params['priority']) : null;
        if ($priority === '') { $priority = null; }

        $client_request_id = isset($params['client_request_id']) ? trim((string) $params['client_request_id']) : null;
        if ($client_request_id === '') { $client_request_id = null; }

        $evidence_file_ids = null;
        if (isset($params['evidence_file_ids']) && is_array($params['evidence_file_ids'])) {
            $evidence_file_ids = array_values(array_filter(array_map('intval', $params['evidence_file_ids']), static fn ($v) => $v > 0));
        }

        // Attestation "sur l'honneur" (flux sans justificatif)
        $attestation_no_proof = false;
        if (isset($params['attestation_no_proof'])) {
            // Accepte bool / 0-1 / "0"-"1".
            $attestation_no_proof = (bool) $params['attestation_no_proof'];
        }

        $fullname = isset($patient['fullname']) ? trim((string) $patient['fullname']) : '';
        $birthdate_raw = isset($patient['birthdate']) ? trim((string) $patient['birthdate']) : '';
        $birthdate = $birthdate_raw !== '' ? (Date::normalize_birthdate($birthdate_raw) ?? '') : '';
        $birthdate_precision = Date::birthdate_precision($birthdate_raw);
        $note = isset($patient['note']) ? trim((string) $patient['note']) : '';

        if ($scope !== '') {
            Logger::log_shortcode($scope, 'info', 'api_prescription_create', [
                'patient_name_len' => mb_strlen($fullname),
                'patient_birthdate' => $birthdate_raw,
                'patient_birthdate_iso' => $birthdate,
                'patient_birthdate_precision' => $birthdate_precision,
                'items_count' => is_array($items) ? count($items) : 0,
                'flow' => $flow,
                'priority' => $priority,
                'evidence_files' => is_array($evidence_file_ids) ? count($evidence_file_ids) : 0,
                'attestation_no_proof' => $attestation_no_proof,
                'turnstile_token_present' => (
                    (isset($params['turnstileToken']) && (string) $params['turnstileToken'] !== '')
                    || (isset($params['turnstile_token']) && (string) $params['turnstile_token'] !== '')
                ) ? true : false,
            ]);
        }

        if (mb_strlen($fullname) < 2) {
            if ($scope !== '') {
                Logger::log_shortcode($scope, 'warning', 'api_prescription_create_validation_fail', [
                    'reason' => 'bad_fullname',
                ]);
            }
            return new WP_Error('sosprescription_bad_patient', 'Nom patient invalide.', ['status' => 400]);
        }
        if ($birthdate === '') {
            if ($scope !== '') {
                Logger::log_shortcode($scope, 'warning', 'api_prescription_create_validation_fail', [
                    'reason' => 'bad_birthdate',
                ]);
            }
            return new WP_Error('sosprescription_bad_patient', 'Date de naissance invalide. Format attendu : JJ/MM/AAAA.', ['status' => 400]);
        }
        if (count($items) < 1) {
            if ($scope !== '') {
                Logger::log_shortcode($scope, 'warning', 'api_prescription_create_validation_fail', [
                    'reason' => 'no_items',
                ]);
            }
            return new WP_Error('sosprescription_no_items', 'Ajoutez au moins un médicament.', ['status' => 400]);
        }

        // Compat: accepter turnstileToken (camelCase) et turnstile_token (snake_case)
        $turnstile_token = '';
        if (isset($params['turnstileToken']) && is_string($params['turnstileToken'])) {
            $turnstile_token = (string) $params['turnstileToken'];
        }
        if ($turnstile_token === '' && isset($params['turnstile_token']) && is_string($params['turnstile_token'])) {
            $turnstile_token = (string) $params['turnstile_token'];
        }
        $remote_ip = isset($_SERVER['REMOTE_ADDR']) ? (string) $_SERVER['REMOTE_ADDR'] : null;

        // ------------------------
        // Turnstile (anti-robot)
        // ------------------------
        // Si la clé site n'est pas configurée, le widget n'est pas affiché côté front :
        // on ne doit pas bloquer la soumission sur un token impossible à obtenir.
        if (Turnstile::is_enabled()) {
            $turn = Turnstile::verify_token($turnstile_token, $remote_ip);
            if (is_wp_error($turn)) {
                if ($scope !== '') {
                    Logger::log_shortcode($scope, 'warning', 'api_prescription_create_turnstile_fail', [
                        'code' => $turn->get_error_code(),
                        'message' => $turn->get_error_message(),
                    ]);
                }
                return $turn;
            }
        }

		// ------------------------
		// Consentement explicite (conformité)
		// ------------------------
		$comp = ComplianceConfig::get();
		$consent_required = !empty($comp['consent_required']);

		$consent_flags = [
			'telemedicine' => !empty($consent['telemedicine']),
			'truth' => !empty($consent['truth']),
			'cgu' => !empty($consent['cgu']),
			'privacy' => !empty($consent['privacy']),
		];

		if ($consent_required) {
			$missing = [];
			foreach ($consent_flags as $k => $v) {
				if (!$v) {
					$missing[] = $k;
				}
			}
			if (count($missing) > 0) {
				if ($scope !== '') {
					Logger::log_shortcode($scope, 'warning', 'api_prescription_create_consent_missing', [
						'missing' => $missing,
					]);
				}
				return new WP_Error(
					'sosprescription_consent_required',
					'Vous devez accepter les consentements requis avant de soumettre la demande.',
					['status' => 400]
				);
			}
		}

        // Payload sauvegardé en base (données patient + métadonnées)
        $payload = [
            'patient' => [
                'fullname' => $fullname,
                'birthdate' => $birthdate,
                'birthdate_precision' => $birthdate_precision,
                'note' => $note,
            ],
        ];

		// Trace consentement + versions (auditabilité)
		$ua = isset($_SERVER['HTTP_USER_AGENT']) ? (string) $_SERVER['HTTP_USER_AGENT'] : '';
		if (strlen($ua) > 250) {
			$ua = substr($ua, 0, 250);
		}
		$payload['consent'] = [
			'telemedicine' => (bool) ($consent_flags['telemedicine'] ?? false),
			'truth' => (bool) ($consent_flags['truth'] ?? false),
			'cgu' => (bool) ($consent_flags['cgu'] ?? false),
			'privacy' => (bool) ($consent_flags['privacy'] ?? false),
			'timestamp' => isset($consent['timestamp']) && is_string($consent['timestamp']) && trim($consent['timestamp']) !== ''
				? trim((string) $consent['timestamp'])
				: current_time('mysql'),
			'cgu_version' => (string) ($comp['cgu_version'] ?? ''),
			'privacy_version' => (string) ($comp['privacy_version'] ?? ''),
			'ip' => $remote_ip,
			'user_agent' => $ua,
		];

        // ------------------------
        // Whitelist / périmètre
        // ------------------------
        $wl = Whitelist::get();

        // Le flux a une implication technique : RO requiert un justificatif, tandis que
        // le flux "dépannage sans preuve" impose une attestation sur l'honneur.
        $flow_key = strtolower(trim((string) ($flow ?? '')));
        if ($flow_key === '') {
            $flow_key = 'renewal';
        }

        $is_ro_proof = ($flow_key === 'ro_proof');
        $is_no_proof = ($flow_key === 'depannage_no_proof');

        // Attestation requise pour le flux sans preuve.
        if ($is_no_proof) {
            if (!$attestation_no_proof) {
                if ($scope !== '') {
                    Logger::log_shortcode($scope, 'warning', 'api_prescription_create_validation_fail', [
                        'reason' => 'attestation_required',
                    ]);
                }
                return new WP_Error(
                    'sosprescription_attestation_required',
                    'Merci de cocher la case "Je certifie sur l’honneur…" avant de soumettre.',
                    ['status' => 400]
                );
            }
            $payload['attestation_no_proof'] = true;
        } else {
            $payload['attestation_no_proof'] = false;
        }

        // Justificatifs
        $requires_evidence = !empty($wl['require_evidence']);
        if ($is_ro_proof) {
            $requires_evidence = true;
        }
        if ($is_no_proof) {
            $requires_evidence = false;
        }

        if ($requires_evidence && (!is_array($evidence_file_ids) || count($evidence_file_ids) < 1)) {
            if ($scope !== '') {
                Logger::log_shortcode($scope, 'warning', 'api_prescription_create_whitelist_fail', [
                    'reason' => 'evidence_required',
                    'flow' => $flow_key,
                ]);
            }
            return new WP_Error(
                'sosprescription_evidence_required',
                'Justificatif médical obligatoire : importez une ordonnance ou une photo de boîte.',
                ['status' => 400]
            );
        }

        if ($wl['mode'] !== 'off') {
            $resolved_items = [];
            $cis_list = [];

            foreach ($items as $it) {
                if (!is_array($it)) { continue; }

                $cis = isset($it['cis']) && is_numeric($it['cis']) ? (int) $it['cis'] : 0;

                if ($cis < 1) {
                    $cip13 = isset($it['cip13']) ? (string) $it['cip13'] : '';
                    $cis_from_cip13 = $cip13 !== '' ? Whitelist::cis_from_cip13($cip13) : null;
                    if ($cis_from_cip13 !== null) {
                        $cis = $cis_from_cip13;
                        $it['cis'] = (string) $cis_from_cip13;
                    }
                }

                if ($cis > 0) {
                    $cis_list[] = $cis;
                }

                $resolved_items[] = $it;
            }

            $items = $resolved_items;

            $cis_list = array_values(array_unique(array_filter(array_map('intval', $cis_list), static fn ($v) => $v > 0)));
            $atc_map = Whitelist::map_atc_codes_for_cis($cis_list);

            $issues = [];
            foreach ($items as $idx => $it) {
                if (!is_array($it)) { continue; }
                $cis = isset($it['cis']) && is_numeric($it['cis']) ? (int) $it['cis'] : 0;
                $ev = Whitelist::evaluate_for_flow($cis, $cis > 0 ? ($atc_map[$cis] ?? null) : null, $flow_key);
                if (!$ev['allowed']) {
                    $issues[] = [
                        'index' => (int) $idx,
                        'cis' => $cis > 0 ? $cis : null,
                        'reason_code' => $ev['reason_code'],
                    ];
                }
            }

            if (count($issues) > 0) {
                if ($scope !== '') {
                    Logger::log_shortcode($scope, 'warning', 'api_prescription_create_whitelist_blocked', [
                        'mode' => $wl['mode'],
                        'issues' => $issues,
                    ]);
                }

                if ($wl['mode'] === 'enforce') {
                    return new WP_Error(
                        'sosprescription_out_of_scope',
                        'Un ou plusieurs médicaments ne sont pas pris en charge par SOS Prescription (périmètre restreint).',
                        ['status' => 400]
                    );
                }

                // Warn mode : on conserve une trace dans le payload pour le médecin.
                $payload['whitelist'] = [
                    'mode' => 'warn',
                    'issues' => $issues,
                ];
            }
        }

        $uid = UidGenerator::generate(10);

        $user_id = get_current_user_id();

        // Paiement : si Stripe est activé, la demande est créée en "payment_pending".
        // Elle ne doit pas entrer dans la file "pending" avant autorisation du paiement.
        $initial_status = StripeClient::is_enabled() ? 'payment_pending' : 'pending';

        $res = $this->repo->create(
            (int) $user_id,
            $uid,
            $payload,
            $items,
            $flow,
            $priority,
            $client_request_id,
            $evidence_file_ids,
            $initial_status
        );

        if (isset($res['error'])) {
            if ($scope !== '') {
                Logger::log_shortcode($scope, 'error', 'api_prescription_create_db_error', [
                    'uid' => $uid,
                    'message' => (string) ($res['message'] ?? 'Erreur DB'),
                    'ms' => (int) round((microtime(true) - $t0) * 1000),
                ]);
            }
            return new WP_Error('sosprescription_db_error', (string) ($res['message'] ?? 'Erreur DB'), ['status' => 500]);
        }

        if ($scope !== '') {
            Logger::log_shortcode($scope, 'info', 'api_prescription_create_done', [
                'uid' => $uid,
                'id' => isset($res['id']) ? (int) $res['id'] : null,
                'ms' => (int) round((microtime(true) - $t0) * 1000),
            ]);
        }

		$created_id = isset($res['id']) ? (int) $res['id'] : null;
		Audit::log('prescription_create', 'prescription', $created_id, $created_id, [
			'flow' => $flow,
			'priority' => $priority,
			'initial_status' => $initial_status,
			'evidence_files' => is_array($evidence_file_ids) ? count($evidence_file_ids) : 0,
		]);

        return rest_ensure_response($res);
    }

    public function list(WP_REST_Request $request)
    {
        $scope = strtolower(trim((string) $request->get_header('X-Sos-Scope')));
        $t0 = microtime(true);

        $status = $request->get_param('status');
        $status = is_string($status) ? trim($status) : null;

        $limit = (int) ($request->get_param('limit') ?? 100);
        if ($limit < 1) { $limit = 100; }
        if ($limit > 200) { $limit = 200; }

        $offset = (int) ($request->get_param('offset') ?? 0);
        if ($offset < 0) { $offset = 0; }

		$current_user_id = (int) get_current_user_id();
		$is_admin = AccessPolicy::is_admin();
		$is_doctor = AccessPolicy::is_doctor();
		$can_staff = $is_admin || $is_doctor;

        if ($scope !== '') {
			Logger::log_shortcode($scope, 'debug', 'api_prescription_list', [
                'status' => $status,
                'limit' => $limit,
                'offset' => $offset,
				'is_admin' => $is_admin,
				'is_doctor' => $is_doctor,
            ]);
        }

		if ($is_admin) {
			$rows = $this->repo->list(null, $status, $limit, $offset);
		} elseif ($is_doctor) {
			$rows = $this->repo->list_for_doctor((int) $current_user_id, $status, $limit, $offset);
		} else {
			$rows = $this->repo->list((int) $current_user_id, $status, $limit, $offset);
		}

        if ($scope !== '') {
            Logger::log_shortcode($scope, 'info', 'api_prescription_list_done', [
                'count' => is_array($rows) ? count($rows) : 0,
                'ms' => (int) round((microtime(true) - $t0) * 1000),
            ]);
        }

        return rest_ensure_response($rows);
    }

    public function get_one(WP_REST_Request $request)
    {
        $scope = strtolower(trim((string) $request->get_header('X-Sos-Scope')));
        $t0 = microtime(true);

        $id = (int) $request->get_param('id');
        if ($id < 1) {
            if ($scope !== '') {
                Logger::log_shortcode($scope, 'warning', 'api_prescription_get_bad_id', [
                    'id' => $id,
                ]);
            }
            return new WP_Error('sosprescription_bad_id', 'ID invalide.', ['status' => 400]);
        }

        $row = $this->repo->get($id);
        if (!$row) {
            if ($scope !== '') {
                Logger::log_shortcode($scope, 'warning', 'api_prescription_get_not_found', [
                    'id' => $id,
                ]);
            }
            return new WP_Error('sosprescription_not_found', 'Ordonnance introuvable.', ['status' => 404]);
        }

		$current_user_id = (int) get_current_user_id();
		if (!AccessPolicy::can_current_user_access_prescription_row($row)) {
            if ($scope !== '') {
                Logger::log_shortcode($scope, 'warning', 'api_prescription_get_forbidden', [
                    'id' => $id,
                    'user_id' => (int) $current_user_id,
                ]);
            }
            return new WP_Error('sosprescription_forbidden', 'Accès refusé.', ['status' => 403]);
        }

        if ($scope !== '') {
            Logger::log_shortcode($scope, 'info', 'api_prescription_get_done', [
                'id' => $id,
                'uid' => isset($row['uid']) ? (string) $row['uid'] : null,
                'ms' => (int) round((microtime(true) - $t0) * 1000),
            ]);
        }

		Audit::log('prescription_view', 'prescription', $id, $id, [
			'status' => isset($row['status']) ? (string) $row['status'] : null,
		]);

        return rest_ensure_response($row);
    }

    public function decision(WP_REST_Request $request)
    {
        $scope = strtolower(trim((string) $request->get_header('X-Sos-Scope')));
        $t0 = microtime(true);

        $id = (int) $request->get_param('id');
        if ($id < 1) {
            if ($scope !== '') {
                Logger::log_shortcode($scope, 'warning', 'api_prescription_decision_bad_id', [
                    'id' => $id,
                ]);
            }
            return new WP_Error('sosprescription_bad_id', 'ID invalide.', ['status' => 400]);
        }

        $params = $request->get_json_params();
        if (!is_array($params)) { $params = []; }

        $decision = isset($params['decision']) ? (string) $params['decision'] : '';
        if ($decision !== 'approved' && $decision !== 'rejected') {
            if ($scope !== '') {
                Logger::log_shortcode($scope, 'warning', 'api_prescription_decision_bad_decision', [
                    'id' => $id,
                    'decision' => $decision,
                ]);
            }
            return new WP_Error('sosprescription_bad_decision', 'Décision invalide.', ['status' => 400]);
        }

        $reason = isset($params['reason']) ? (string) $params['reason'] : null;

		$doctor_user_id = (int) get_current_user_id();
		$rx_row = $this->repo->get($id);
		if (!$rx_row) {
			return new WP_Error('sosprescription_not_found', 'Ordonnance introuvable.', ['status' => 404]);
		}
		if (!AccessPolicy::can_current_user_access_prescription_row($rx_row)) {
			return new WP_Error('sosprescription_forbidden', 'Accès refusé.', ['status' => 403]);
		}

		// Si assignée à un autre médecin, on bloque.
		$assigned_doctor_id = isset($rx_row['doctor_user_id']) && $rx_row['doctor_user_id'] !== null ? (int) $rx_row['doctor_user_id'] : null;
		if (!AccessPolicy::is_admin() && $assigned_doctor_id !== null && $assigned_doctor_id > 0 && $assigned_doctor_id !== $doctor_user_id) {
			return new WP_Error('sosprescription_forbidden', 'Demande assignée à un autre médecin.', ['status' => 403]);
		}

        if ($scope !== '') {
            Logger::log_shortcode($scope, 'info', 'api_prescription_decision', [
                'id' => $id,
                'decision' => $decision,
                'doctor_user_id' => (int) $doctor_user_id,
                'reason_present' => $reason !== null && trim((string) $reason) !== '' ? true : false,
            ]);
        }

        // État courant (statut + paiement)
        $p = $this->repo->get_payment_fields($id);
        if ($p === null) {
            return new WP_Error('sosprescription_not_found', 'Ordonnance introuvable.', ['status' => 404]);
        }

        $current_status = isset($p['status']) ? (string) $p['status'] : '';

        // Idempotence / sécurité : on n'écrase jamais une décision déjà prise.
        if (in_array($current_status, ['approved', 'rejected'], true)) {
            if ($current_status === $decision) {
                if ($scope !== '') {
                    Logger::log_shortcode($scope, 'info', 'api_prescription_decision_idempotent', [
                        'id' => $id,
                        'decision' => $decision,
                        'ms' => (int) round((microtime(true) - $t0) * 1000),
                    ]);
                }
                return rest_ensure_response(['ok' => true, 'already' => true]);
            }
            return new WP_Error('sosprescription_already_decided', 'Cette demande a déjà été décidée.', [
                'status' => 409,
                'current_status' => $current_status,
            ]);
        }

        // Sécurité / UX : on exige une ordonnance PDF attachée avant validation.
        // (Le patient doit pouvoir télécharger un document final.)
        if ($decision === 'approved') {
            $fileRepo = new FileRepository();
            $rxpdf = $fileRepo->find_latest_for_prescription_purpose($id, 'rx_pdf');
            if (!$rxpdf) {
                return new WP_Error('sosprescription_rx_pdf_required', 'Ordonnance PDF requise avant validation.', ['status' => 409]);
            }
        }

        // Paiement (Stripe) :
        // - le patient autorise (pré-autorisation)
        // - on capture UNIQUEMENT en cas d'approbation médicale
        // -> pour éviter un "approved" sans débit, on capture AVANT de persister la décision.
        $captured_pi_id = null;
        $pi_id = '';
        $pi_status = '';

        if ($decision === 'approved' && StripeClient::is_enabled()) {
            $pi_id = isset($p['payment_intent_id']) && is_string($p['payment_intent_id']) ? trim((string) $p['payment_intent_id']) : '';
            if ($pi_id === '') {
                return new WP_Error('sosprescription_payment_required', 'Paiement requis avant validation.', ['status' => 409]);
            }

            $pi = StripeClient::retrieve_payment_intent($pi_id);
            if (is_wp_error($pi)) {
                return $pi;
            }

            $pi_status = isset($pi['status']) ? (string) $pi['status'] : '';

            if ($pi_status !== 'requires_capture' && $pi_status !== 'succeeded') {
                return new WP_Error('sosprescription_payment_not_authorized', 'Paiement non autorisé (validation nécessaire).', [
                    'status' => 409,
                    'payment_status' => $pi_status,
                ]);
            }

            if ($pi_status === 'requires_capture') {
                $idem = 'sosprescription_capture_' . $id . '_' . $pi_id;
                $cap = StripeClient::capture_payment_intent($pi_id, $idem);
                if (is_wp_error($cap)) {
                    return $cap;
                }

                $captured_pi_id = $pi_id;

                $this->repo->update_payment_fields($id, [
                    'payment_provider' => 'stripe',
                    'payment_status' => isset($cap['status']) ? (string) $cap['status'] : 'succeeded',
                    'amount_cents' => isset($cap['amount_received']) ? (int) $cap['amount_received'] : null,
                    'currency' => isset($cap['currency']) ? strtoupper((string) $cap['currency']) : null,
                ]);
            } else {
                // déjà capturé (cas rare) : on synchronise les champs.
                $this->repo->update_payment_fields($id, [
                    'payment_provider' => 'stripe',
                    'payment_status' => $pi_status,
                    'amount_cents' => isset($pi['amount_received']) ? (int) $pi['amount_received'] : null,
                    'currency' => isset($pi['currency']) ? strtoupper((string) $pi['currency']) : null,
                ]);
            }
        } elseif (StripeClient::is_enabled()) {
            // pour rejected, on conserve l'ID pour la phase "void" après décision (si présent)
            $pi_id = isset($p['payment_intent_id']) && is_string($p['payment_intent_id']) ? trim((string) $p['payment_intent_id']) : '';
        }

        $ok = $this->repo->decide($id, (int) $doctor_user_id, $decision, $reason);

        if (!$ok) {
            // Si la décision n'a pas été appliquée, c'est soit :
            // - conflit (déjà décidée par ailleurs)
            // - ou erreur DB.
            $fresh = $this->repo->get_payment_fields($id);
            $fresh_status = $fresh !== null && isset($fresh['status']) ? (string) $fresh['status'] : '';

            // Cas rare : paiement capturé mais décision non persistée (conflit ou erreur).
            if ($decision === 'approved' && StripeClient::is_enabled() && $pi_id !== '') {
                // Si quelqu'un a rejeté entre-temps, on rembourse pour rester cohérent.
                if ($fresh_status === 'rejected') {
                    $refund_idem = 'sosprescription_refund_conflict_' . $id . '_' . $pi_id;
                    $refund = StripeClient::create_refund_for_payment_intent((string) $pi_id, null, $refund_idem);
                    if (!is_wp_error($refund)) {
                        $this->repo->update_payment_fields($id, [
                            'payment_status' => 'refunded',
                        ]);
                    } else {
                        Logger::log('runtime', 'error', 'stripe_refund_failed_after_conflict', [
                            'prescription_id' => $id,
                            'payment_intent_id' => $pi_id,
                            'error_code' => $refund->get_error_code(),
                            'error_message' => $refund->get_error_message(),
                        ]);
                    }
                } elseif ($fresh_status === 'approved') {
                    // Idempotence : déjà approuvée par ailleurs.
                    return rest_ensure_response(['ok' => true, 'already' => true]);
                } else {
                    // Erreur DB après capture : on tente un remboursement automatique.
                    if ($captured_pi_id !== null) {
                        $refund_idem = 'sosprescription_refund_db_' . $id . '_' . $captured_pi_id;
                        $refund = StripeClient::create_refund_for_payment_intent((string) $captured_pi_id, null, $refund_idem);
                        if (!is_wp_error($refund)) {
                            $this->repo->update_payment_fields($id, [
                                'payment_status' => 'refunded',
                            ]);
                        } else {
                            Logger::log('runtime', 'error', 'stripe_refund_failed_after_db_error', [
                                'prescription_id' => $id,
                                'payment_intent_id' => $captured_pi_id,
                                'error_code' => $refund->get_error_code(),
                                'error_message' => $refund->get_error_message(),
                            ]);
                        }
                    }
                }
            }

            if (in_array($fresh_status, ['approved', 'rejected'], true)) {
                return new WP_Error('sosprescription_already_decided', 'Cette demande a déjà été décidée.', [
                    'status' => 409,
                    'current_status' => $fresh_status,
                ]);
            }

            if ($scope !== '') {
                Logger::log_shortcode($scope, 'error', 'api_prescription_decision_db_error', [
                    'id' => $id,
                    'decision' => $decision,
                    'ms' => (int) round((microtime(true) - $t0) * 1000),
                ]);
            }
            return new WP_Error('sosprescription_db_error', 'Erreur DB (décision).', ['status' => 500]);
        }

        // Pour un refus (rejected), on annule l'autorisation si un PI existe.
        // Si (cas rare) le paiement est déjà capturé, on tente un remboursement.
        if ($decision === 'rejected' && StripeClient::is_enabled() && $pi_id !== '') {
            $pi = StripeClient::retrieve_payment_intent($pi_id);
            if (!is_wp_error($pi)) {
                $pi_status2 = isset($pi['status']) ? (string) $pi['status'] : '';
                if ($pi_status2 === 'requires_capture') {
                    $idem = 'sosprescription_cancel_' . $id . '_' . $pi_id;
                    $cancel = StripeClient::cancel_payment_intent($pi_id, $idem);
                    if (!is_wp_error($cancel)) {
                        $this->repo->update_payment_fields($id, [
                            'payment_provider' => 'stripe',
                            'payment_status' => isset($cancel['status']) ? (string) $cancel['status'] : 'canceled',
                            'currency' => isset($cancel['currency']) ? strtoupper((string) $cancel['currency']) : null,
                        ]);
                    } else {
                        Logger::log('runtime', 'error', 'stripe_cancel_failed', [
                            'prescription_id' => $id,
                            'payment_intent_id' => $pi_id,
                            'error_code' => $cancel->get_error_code(),
                            'error_message' => $cancel->get_error_message(),
                        ]);
                    }
                } elseif ($pi_status2 === 'succeeded') {
                    $idem = 'sosprescription_refund_' . $id . '_' . $pi_id;
                    $refund = StripeClient::create_refund_for_payment_intent($pi_id, null, $idem);
                    if (!is_wp_error($refund)) {
                        $this->repo->update_payment_fields($id, [
                            'payment_provider' => 'stripe',
                            'payment_status' => 'refunded',
                        ]);
                    } else {
                        // On log et on marque l'échec pour traitement manuel.
                        $this->repo->update_payment_fields($id, [
                            'payment_provider' => 'stripe',
                            'payment_status' => 'refund_failed',
                        ]);
                        Logger::log('runtime', 'error', 'stripe_refund_failed_after_reject', [
                            'prescription_id' => $id,
                            'payment_intent_id' => $pi_id,
                            'error_code' => $refund->get_error_code(),
                            'error_message' => $refund->get_error_message(),
                        ]);
                    }
                } else {
                    // Synchronisation best-effort
                    if ($pi_status2 !== '') {
                        $this->repo->update_payment_fields($id, [
                            'payment_provider' => 'stripe',
                            'payment_status' => $pi_status2,
                            'currency' => isset($pi['currency']) ? strtoupper((string) $pi['currency']) : null,
                        ]);
                    }
                }
            } else {
                Logger::log('runtime', 'error', 'stripe_retrieve_failed_after_reject', [
                    'prescription_id' => $id,
                    'payment_intent_id' => $pi_id,
                    'error_code' => $pi->get_error_code(),
                    'error_message' => $pi->get_error_message(),
                ]);
            }
        }

        if ($scope !== '') {
            Logger::log_shortcode($scope, 'info', 'api_prescription_decision_done', [
                'id' => $id,
                'decision' => $decision,
                'ms' => (int) round((microtime(true) - $t0) * 1000),
            ]);
        }

        // Notification patient : décision disponible (sans données de santé).
        $owner = $this->repo->get_owner_user_id($id);
        if ($owner !== null) {
            Notifications::patient_decision($id, (int) $owner, (string) $decision, (int) $doctor_user_id);
        }

		Audit::log('prescription_decision', 'prescription', $id, $id, [
			'decision' => (string) $decision,
			'reason_present' => $reason !== null && trim((string) $reason) !== '' ? true : false,
			'payment_provider' => StripeClient::is_enabled() ? 'stripe' : null,
			'payment_intent_id' => $pi_id !== '' ? $pi_id : null,
			'captured' => $captured_pi_id !== null ? true : false,
		]);

        return rest_ensure_response(['ok' => true]);
    }

    /**
     * Assigne une demande au médecin courant.
     *
     * - Passe le statut en "in_review".
     * - Refuse si la demande est déjà assignée à un autre médecin,
     *   ou si elle est dans un statut non compatible.
     */
    public function assign(WP_REST_Request $request)
    {
        $scope = strtolower(trim((string) $request->get_header('X-Sos-Scope')));
        $t0 = microtime(true);

        $id = (int) $request->get_param('id');
        if ($id < 1) {
            return new WP_Error('sosprescription_bad_id', 'ID invalide.', ['status' => 400]);
        }

        // Vérifie l'existence.
        $owner = $this->repo->get_owner_user_id($id);
        if ($owner === null) {
            return new WP_Error('sosprescription_not_found', 'Ordonnance introuvable.', ['status' => 404]);
        }

        $doctor_user_id = (int) get_current_user_id();

        $before = $this->repo->get_payment_fields($id);
        $before_status = is_array($before) && isset($before['status']) ? (string) $before['status'] : '';

        $ok = $this->repo->assign_to_doctor($id, $doctor_user_id);
        if (!$ok) {
            if ($scope !== '') {
                Logger::log_shortcode($scope, 'warning', 'api_prescription_assign_failed', [
                    'id' => $id,
                    'doctor_user_id' => $doctor_user_id,
                    'ms' => (int) round((microtime(true) - $t0) * 1000),
                ]);
            }
            return new WP_Error('sosprescription_assign_failed', 'Impossible d’assigner (déjà assignée ou statut incompatible).', ['status' => 409]);
        }

        if ($scope !== '') {
            Logger::log_shortcode($scope, 'info', 'api_prescription_assign_done', [
                'id' => $id,
                'doctor_user_id' => $doctor_user_id,
                'ms' => (int) round((microtime(true) - $t0) * 1000),
            ]);
        }

        // Notification patient : dossier passé en in_review (assigné).
        if ($before_status !== 'in_review') {
            Notifications::patient_assigned($id, (int) $owner, (int) $doctor_user_id);
        }
		Audit::log('prescription_assign', 'prescription', $id, $id, [
			'doctor_user_id' => (int) $doctor_user_id,
			'before_status' => (string) $before_status,
		]);
        return rest_ensure_response(['ok' => true]);
    }

    /**
     * Mise à jour de statut (triage).
     *
     * Statuts autorisés : pending | in_review | needs_info
     */
    public function update_status(WP_REST_Request $request)
    {
        $scope = strtolower(trim((string) $request->get_header('X-Sos-Scope')));
        $t0 = microtime(true);

        $id = (int) $request->get_param('id');
        if ($id < 1) {
            return new WP_Error('sosprescription_bad_id', 'ID invalide.', ['status' => 400]);
        }

        // Vérifie l'existence.
        $owner = $this->repo->get_owner_user_id($id);
        if ($owner === null) {
            return new WP_Error('sosprescription_not_found', 'Ordonnance introuvable.', ['status' => 404]);
        }

        $params = $request->get_json_params();
        if (!is_array($params)) {
            $params = [];
        }

        $status = isset($params['status']) ? strtolower(trim((string) $params['status'])) : '';
        if (!in_array($status, ['pending', 'in_review', 'needs_info'], true)) {
            return new WP_Error('sosprescription_bad_status', 'Statut invalide.', ['status' => 400]);
        }

        $doctor_user_id = (int) get_current_user_id();

        $before = $this->repo->get_payment_fields($id);
        $before_status = is_array($before) && isset($before['status']) ? (string) $before['status'] : '';

        $ok = $this->repo->update_status_by_doctor($id, $doctor_user_id, $status);
        if (!$ok) {
            if ($scope !== '') {
                Logger::log_shortcode($scope, 'warning', 'api_prescription_update_status_failed', [
                    'id' => $id,
                    'doctor_user_id' => $doctor_user_id,
                    'status' => $status,
                    'ms' => (int) round((microtime(true) - $t0) * 1000),
                ]);
            }
            return new WP_Error('sosprescription_status_failed', 'Impossible de changer le statut (assignation/statut incompatible).', ['status' => 409]);
        }

        if ($scope !== '') {
            Logger::log_shortcode($scope, 'info', 'api_prescription_update_status_done', [
                'id' => $id,
                'doctor_user_id' => $doctor_user_id,
                'status' => $status,
                'ms' => (int) round((microtime(true) - $t0) * 1000),
            ]);
        }

        if ($status === 'in_review' && $before_status !== 'in_review') {
            Notifications::patient_assigned($id, (int) $owner, (int) $doctor_user_id);
        }
		Audit::log('prescription_status', 'prescription', $id, $id, [
			'status' => (string) $status,
			'before_status' => (string) $before_status,
			'doctor_user_id' => (int) $doctor_user_id,
		]);

        return rest_ensure_response(['ok' => true]);
    }

    /**
     * Génère et attache une ordonnance PDF (serveur) à la prescription.
     *
     * Retourne un objet de type UploadFileResponse (id, download_url, etc.).
     */
    public function generate_rx_pdf(WP_REST_Request $request)
    {
        $scope = strtolower(trim((string) $request->get_header('X-Sos-Scope')));
        $t0 = microtime(true);

        $id = (int) $request->get_param('id');
        if ($id < 1) {
            if ($scope !== '') {
                Logger::log_shortcode($scope, 'warning', 'api_rx_pdf_bad_id', ['id' => $id]);
            }
            return new WP_Error('sosprescription_bad_id', 'ID invalide.', ['status' => 400]);
        }

		$doctor_user_id = (int) get_current_user_id();
        if ($doctor_user_id < 1) {
            return new WP_Error('sosprescription_auth_required', 'Connexion requise.', ['status' => 401]);
        }

        $row = $this->repo->get($id);
        if (!$row) {
            return new WP_Error('sosprescription_not_found', 'Prescription introuvable.', ['status' => 404]);
        }

		$can_manage_all = AccessPolicy::is_admin();

        $assigned = isset($row['doctor_user_id']) && $row['doctor_user_id'] !== null ? (int) $row['doctor_user_id'] : null;
        if (!$can_manage_all && $assigned !== null && $assigned !== (int) $doctor_user_id) {
            return new WP_Error('sosprescription_forbidden', 'Accès refusé.', ['status' => 403]);
        }

        $status = isset($row['status']) ? (string) $row['status'] : '';
        if ($status === 'payment_pending') {
            return new WP_Error('sosprescription_payment_pending', 'Paiement non validé : génération refusée.', ['status' => 409]);
        }

        // Si pas encore assignée, on s'assigne (statut -> in_review) quand c'est possible.
        if (!$can_manage_all && $assigned === null && in_array($status, ['pending', 'needs_info', 'in_review'], true)) {
            $this->repo->assign_to_doctor($id, (int) $doctor_user_id);
        }

        $file = RxPdfGenerator::generate($id, (int) $doctor_user_id);
        if (is_wp_error($file)) {
            return $file;
        }

		if ($scope !== '') {
            Logger::log_shortcode($scope, 'info', 'api_rx_pdf_done', [
                'id' => $id,
                'doctor_user_id' => (int) $doctor_user_id,
                'file_id' => isset($file['id']) ? (int) $file['id'] : null,
                'ms' => (int) round((microtime(true) - $t0) * 1000),
            ]);
        }
		Audit::log('rx_pdf_generate', 'file', isset($file['id']) ? (int) $file['id'] : null, $id, [
			'doctor_user_id' => (int) $doctor_user_id,
		]);

        return rest_ensure_response($file);
    }

    public function print_view(WP_REST_Request $request)
    {
        $id = (int) $request->get_param('id');
        if ($id < 1) {
            return new WP_Error('sosprescription_bad_id', 'ID invalide.', ['status' => 400]);
        }

        $row = $this->repo->get($id);
        if (!$row) {
            return new WP_Error('sosprescription_not_found', 'Ordonnance introuvable.', ['status' => 404]);
        }

		if (!AccessPolicy::can_current_user_access_prescription_row($row)) {
            return new WP_Error('sosprescription_forbidden', 'Accès refusé.', ['status' => 403]);
        }

        $payload = isset($row['payload']) && is_array($row['payload']) ? $row['payload'] : [];
        $patient = isset($payload['patient']) && is_array($payload['patient']) ? $payload['patient'] : [];

        $patient_name = esc_html((string) ($patient['fullname'] ?? ''));
        $patient_birth = esc_html((string) ($patient['birthdate'] ?? ''));
        $patient_note = esc_html((string) ($patient['note'] ?? ''));

        $uid = esc_html((string) ($row['uid'] ?? ''));
        $status = esc_html((string) ($row['status'] ?? ''));
        $created = esc_html((string) ($row['created_at'] ?? ''));

        $items = isset($row['items']) && is_array($row['items']) ? $row['items'] : [];

        $html = '<!doctype html><html><head><meta charset="utf-8"/><title>Ordonnance ' . $uid . '</title>';
        $html .= '<style>
            body{font-family: Arial, sans-serif; color:#111; margin:24px;}
            .h{display:flex; justify-content:space-between; align-items:flex-start;}
            .box{border:1px solid #ddd; border-radius:10px; padding:12px; margin-top:12px;}
            .title{font-size:20px; font-weight:bold;}
            .muted{color:#555; font-size:12px;}
            .item{padding:10px 0; border-bottom:1px solid #eee;}
            .item:last-child{border-bottom:none;}
            .label{font-weight:bold;}
            .small{font-size:12px; color:#444;}
            @media print{ .no-print{display:none;} }
        </style>';
        $html .= '</head><body>';

        $html .= '<div class="h">';
        $html .= '<div><div class="title">Ordonnance</div><div class="muted">Référence: <strong>' . $uid . '</strong></div></div>';
        $html .= '<div class="muted">Créée: ' . $created . '<br/>Statut: ' . $status . '</div>';
        $html .= '</div>';

        $html .= '<div class="box">';
        $html .= '<div class="label">Patient</div>';
        $html .= '<div>' . $patient_name . '</div>';
        $html .= '<div class="small">Naissance: ' . $patient_birth . '</div>';
        if ($patient_note !== '') {
            $html .= '<div class="small" style="margin-top:6px;">Note: ' . nl2br($patient_note) . '</div>';
        }
        $html .= '</div>';

        $html .= '<div class="box">';
        $html .= '<div class="label">Médicaments</div>';

        if (count($items) < 1) {
            $html .= '<div class="muted">Aucun</div>';
        } else {
            foreach ($items as $it) {
                if (!is_array($it)) { continue; }

                $denom = esc_html((string) ($it['denomination'] ?? ''));
                $poso = esc_html((string) ($it['posologie'] ?? ''));
                $qty  = esc_html((string) ($it['quantite'] ?? ''));
                $cis  = isset($it['cis']) ? esc_html((string) $it['cis']) : '';
                $cip13= isset($it['cip13']) ? esc_html((string) $it['cip13']) : '';

                $html .= '<div class="item">';
                $html .= '<div class="label">' . $denom . '</div>';
                $meta = [];
                if ($cis !== '') { $meta[] = 'CIS ' . $cis; }
                if ($cip13 !== '') { $meta[] = 'CIP13 ' . $cip13; }
                if (count($meta) > 0) {
                    $html .= '<div class="small">' . implode(' • ', $meta) . '</div>';
                }
                if ($poso !== '') {
                    $html .= '<div style="margin-top:6px;"><span class="small">Posologie:</span> ' . $poso . '</div>';
                }
                if ($qty !== '') {
                    $html .= '<div><span class="small">Quantité:</span> ' . $qty . '</div>';
                }
                $html .= '</div>';
            }
        }

        $html .= '</div>';

        $html .= '<div class="no-print" style="margin-top:16px;"><button onclick="window.print()">Imprimer</button></div>';

        $html .= '</body></html>';

		Audit::log('prescription_print_view', 'prescription', $id, $id);
		return new \WP_REST_Response($html, 200, [
			'Content-Type' => 'text/html; charset=utf-8',
			'X-Robots-Tag' => 'noindex, nofollow',
			'Cache-Control' => 'no-store, no-cache, must-revalidate, max-age=0',
			'Pragma' => 'no-cache',
			'Referrer-Policy' => 'no-referrer',
		]);
    }
}
