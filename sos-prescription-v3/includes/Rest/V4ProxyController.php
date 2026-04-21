<?php
// includes/Rest/V4ProxyController.php

declare(strict_types=1);

namespace SosPrescription\Rest;

use SosPrescription\Services\DraftRepository;
use SosPrescription\Services\PrescriptionProjectionStore;
use SosPrescription\Services\V4InputNormalizer;
use SosPrescription\Services\V4ProxyConfig;
use SosPrescription\Services\V4WorkerTransport;
use Throwable;
use WP_Error;
use WP_REST_Request;

final class V4ProxyController
{
    private const NAMESPACE_V4 = 'sosprescription/v4';

    public static function register(): void
    {
        register_rest_route(self::NAMESPACE_V4, '/medications/search', [
            'methods' => 'GET',
            'permission_callback' => '__return_true',
            'callback' => [self::class, 'medicationsSearchRoute'],
        ], true);

        register_rest_route(self::NAMESPACE_V4, '/messages/polish', [
            'methods' => 'POST',
            'permission_callback' => [self::class, 'messagesPolishPermission'],
            'callback' => [self::class, 'messagesPolishRoute'],
        ], true);
    }

    public static function medicationsSearchRoute(WP_REST_Request $request)
    {
        return self::performMedicationsSearch($request);
    }

    public function __construct(
        private V4InputNormalizer $input,
        private V4WorkerTransport $transport,
        private DraftRepository $drafts,
        private V4ProxyConfig $config,
        private PrescriptionProjectionStore $projectionStore
    ) {
    }

    public function twilioConfig(WP_REST_Request $request)
    {
        $reqId = $this->transport->buildReqId();
        $cfg = $this->config->getTwilioConfig();

        return $this->transport->toResponse([
            'ok' => true,
            'twilio_number' => $cfg['twilio_number'],
            'transfer_number' => $cfg['transfer_number'],
            'updated_at' => $cfg['updated_at'],
        ], 200, $reqId);
    }

    public function medicationsSearch(WP_REST_Request $request)
    {
        return self::performMedicationsSearch($request);
    }

    public function messagesPolish(WP_REST_Request $request)
    {
        return self::messagesPolishRoute($request);
    }

    public static function messagesPolishPermission(WP_REST_Request $request)
    {
        $controller = new MessagesV4Controller();
        return $controller->permissions_check_logged_in_nonce($request);
    }

    public static function messagesPolishRoute(WP_REST_Request $request)
    {
        $controller = new MessagesV4Controller();
        return $controller->polish($request);
    }

    public function createSubmissionDraft(WP_REST_Request $request)
    {
        $reqId = $this->transport->buildReqId();
        $params = $this->input->requestData($request);

        $email = $this->input->normalizeEmail($params['email'] ?? null);
        $flow = $this->input->normalizeSlug($params['flow'] ?? null, 64);
        $priority = $this->input->normalizeSlug($params['priority'] ?? 'standard', 32);
        $redirectTo = $this->input->normalizeRedirectTo($params['redirect_to'] ?? ($params['redirectTo'] ?? ''));
        $patient = $this->input->normalizePatientPayload($params);
        $items = $this->input->normalizeItemsPayload($params['items'] ?? []);
        $files = $this->input->normalizeFilesManifest($params['files'] ?? ($params['files_manifest'] ?? []));
        $privateNotes = $this->input->normalizeText($params['privateNotes'] ?? ($params['private_notes'] ?? ''), 4000);
        $attestationNoProof = !empty($params['attestation_no_proof']) || !empty($params['attestationNoProof']);
        $consentRaw = isset($params['consent']) && is_array($params['consent']) ? $params['consent'] : [];
        $consent = [
            'telemedicine' => !empty($consentRaw['telemedicine']),
            'truth' => !empty($consentRaw['truth']),
            'cgu' => !empty($consentRaw['cgu']),
            'privacy' => !empty($consentRaw['privacy']),
            'timestamp' => isset($consentRaw['timestamp']) && is_scalar($consentRaw['timestamp']) ? trim((string) $consentRaw['timestamp']) : '',
            'cgu_version' => isset($consentRaw['cgu_version']) && is_scalar($consentRaw['cgu_version']) ? trim((string) $consentRaw['cgu_version']) : '',
            'privacy_version' => isset($consentRaw['privacy_version']) && is_scalar($consentRaw['privacy_version']) ? trim((string) $consentRaw['privacy_version']) : '',
        ];
        $idempotencyKey = $this->input->normalizeSlug($params['idempotency_key'] ?? null, 96);
        if ($idempotencyKey === '') {
            $idempotencyKey = $this->input->generateDraftIdempotencyKey();
        }
        $verifyUrl = $this->config->magicRedirectUrl();

        if ($email === '' || $flow === '' || $priority === '') {
            return new WP_Error(
                'sosprescription_bad_body',
                'Informations de brouillon invalides.',
                ['status' => 400, 'req_id' => $reqId]
            );
        }

        try {
            $workerPayload = $this->transport->createSubmissionDraft(
                $email,
                $flow,
                $priority,
                $redirectTo,
                $verifyUrl,
                $idempotencyKey,
                $reqId
            );

            $normalizedWorkerPayload = $this->input->normalizePayload($workerPayload);
            $submissionRef = isset($normalizedWorkerPayload['submission_ref']) && is_scalar($normalizedWorkerPayload['submission_ref'])
                ? trim((string) $normalizedWorkerPayload['submission_ref'])
                : '';

            if ($submissionRef === '') {
                return new WP_Error(
                    'sosprescription_draft_ref_missing',
                    'Référence de brouillon introuvable.',
                    ['status' => 502, 'req_id' => $reqId]
                );
            }

            $draftPayload = [
                'ok' => true,
                'submission_ref' => $submissionRef,
                'email' => $email,
                'flow' => $flow,
                'priority' => $priority,
                'patient' => $patient,
                'items' => $items,
                'private_notes' => $privateNotes,
                'files' => $files,
                'redirect_to' => $redirectTo,
                'idempotency_key' => $idempotencyKey,
                'attestation_no_proof' => $attestationNoProof,
                'consent' => $consent,
                'expires_at' => $normalizedWorkerPayload['expires_at'] ?? null,
                'created_at' => gmdate('c'),
                'req_id' => $reqId,
            ];

            $this->drafts->store(
                $submissionRef,
                $draftPayload,
                $this->drafts->computeDraftTtl($normalizedWorkerPayload)
            );

            return $this->transport->toResponse(
                array_merge(
                    $normalizedWorkerPayload,
                    [
                        'submission_ref' => $submissionRef,
                        'message' => 'Lien de connexion envoyé',
                    ]
                ),
                201,
                $reqId
            );
        } catch (Throwable $e) {
            return new WP_Error(
                'sosprescription_draft_create_failed',
                'Le lien de connexion n’a pas pu être envoyé.',
                ['status' => 502, 'req_id' => $reqId]
            );
        }
    }

    public function resendSubmissionDraft(WP_REST_Request $request)
    {
        $reqId = $this->transport->buildReqId();
        $params = $this->input->requestData($request);

        $ref = $this->input->normalizeDraftRef($params['draft_ref'] ?? ($params['submission_ref'] ?? ''));
        $email = $this->input->normalizeEmail($params['email'] ?? null);

        if ($ref === '' || $email === '') {
            return new WP_Error(
                'sosprescription_bad_draft_resend',
                'Informations de reprise invalides.',
                ['status' => 400, 'req_id' => $reqId]
            );
        }

        $payload = $this->drafts->load($ref);
        if (!is_array($payload)) {
            return new WP_Error(
                'sosprescription_draft_not_found',
                'Brouillon introuvable ou expiré.',
                ['status' => 404, 'req_id' => $reqId]
            );
        }

        $storedEmail = $this->input->normalizeEmail($payload['email'] ?? null);
        if ($storedEmail === '' || $storedEmail !== $email) {
            return new WP_Error(
                'sosprescription_draft_not_found',
                'Brouillon introuvable ou expiré.',
                ['status' => 404, 'req_id' => $reqId]
            );
        }

        $flow = $this->input->normalizeSlug($payload['flow'] ?? null, 64);
        $priority = $this->input->normalizeSlug($payload['priority'] ?? 'standard', 32);
        $redirectTo = $this->input->normalizeRedirectTo($payload['redirect_to'] ?? '');
        $idempotencyKey = $this->input->normalizeSlug($payload['idempotency_key'] ?? '', 96);
        if ($idempotencyKey === '') {
            $idempotencyKey = $this->input->normalizeSlug($ref, 96);
            if ($idempotencyKey === '') {
                $idempotencyKey = $this->input->generateDraftIdempotencyKey();
            }
        }

        if ($flow === '' || $priority === '') {
            return new WP_Error(
                'sosprescription_draft_invalid',
                'Ce brouillon ne peut pas être repris pour le moment.',
                ['status' => 409, 'req_id' => $reqId]
            );
        }

        try {
            $workerPayload = $this->transport->createSubmissionDraft(
                $storedEmail,
                $flow,
                $priority,
                $redirectTo,
                $this->config->magicRedirectUrl(),
                $idempotencyKey,
                $reqId
            );

            $normalizedWorkerPayload = $this->input->normalizePayload($workerPayload);
            $submissionRef = isset($normalizedWorkerPayload['submission_ref']) && is_scalar($normalizedWorkerPayload['submission_ref'])
                ? trim((string) $normalizedWorkerPayload['submission_ref'])
                : $ref;

            $nextPayload = $payload;
            $nextPayload['submission_ref'] = $submissionRef;
            $nextPayload['email'] = $storedEmail;
            $nextPayload['idempotency_key'] = $idempotencyKey;
            $nextPayload['expires_at'] = $normalizedWorkerPayload['expires_at'] ?? ($payload['expires_at'] ?? null);
            $nextPayload['req_id'] = $reqId;

            $ttl = $this->drafts->computeDraftTtl($normalizedWorkerPayload);
            $this->drafts->store($ref, $nextPayload, $ttl);
            if ($submissionRef !== '' && $submissionRef !== $ref) {
                $this->drafts->store($submissionRef, $nextPayload, $ttl);
            }

            return $this->transport->toResponse(
                array_merge(
                    $normalizedWorkerPayload,
                    [
                        'submission_ref' => $submissionRef,
                        'message' => 'Lien de connexion envoyé',
                    ]
                ),
                200,
                $reqId
            );
        } catch (Throwable $e) {
            return new WP_Error(
                'sosprescription_draft_resend_failed',
                'Le lien de connexion n’a pas pu être envoyé.',
                ['status' => 502, 'req_id' => $reqId]
            );
        }
    }

    public function getSubmissionDraft(WP_REST_Request $request)
    {
        $reqId = $this->transport->buildReqId();
        $ref = is_scalar($request->get_param('ref')) ? trim((string) $request->get_param('ref')) : '';
        if ($ref === '') {
            return new WP_Error(
                'sosprescription_bad_submission_ref',
                'Référence de brouillon invalide.',
                ['status' => 400, 'req_id' => $reqId]
            );
        }

        $payload = $this->drafts->load($ref);
        if (!is_array($payload)) {
            return new WP_Error(
                'sosprescription_draft_not_found',
                'Brouillon introuvable ou expiré.',
                ['status' => 404, 'req_id' => $reqId]
            );
        }

        if (!$this->drafts->currentUserMatches($payload)) {
            return new WP_Error(
                'sosprescription_forbidden',
                'Accès refusé.',
                ['status' => 403, 'req_id' => $reqId]
            );
        }

        return $this->transport->toResponse($payload, 200, $reqId);
    }

    public function smartReplies(WP_REST_Request $request)
    {
        $localId = (int) $request->get_param('id');
        if ($localId < 1) {
            return new WP_Error(
                'sosprescription_bad_id',
                'ID invalide.',
                ['status' => 400]
            );
        }

        $row = $this->projectionStore->findLocalPrescriptionRowById($localId);
        if (!is_array($row)) {
            return new WP_Error(
                'sosprescription_not_found',
                'Ordonnance introuvable.',
                ['status' => 404]
            );
        }

        if (!$this->canAccessPrescriptionRow($row)) {
            return new WP_Error(
                'sosprescription_forbidden',
                'Accès refusé.',
                ['status' => 403]
            );
        }

        $workerPrescriptionId = $this->projectionStore->extractWorkerPrescriptionIdFromLocalRow($row);
        if ($workerPrescriptionId === '') {
            return new WP_Error(
                'sosprescription_worker_reference_missing',
                'Référence Worker introuvable.',
                ['status' => 409]
            );
        }

        $reqId = $this->transport->buildReqId();
        try {
            $payload = $this->transport->fetchSmartReplies($workerPrescriptionId, $reqId);
            return $this->transport->toResponse($payload, 200, $reqId);
        } catch (Throwable $e) {
            return new WP_Error(
                'sosprescription_smart_replies_failed',
                'Suggestions de réponse momentanément indisponibles.',
                [
                    'status' => 502,
                    'req_id' => $reqId,
                ]
            );
        }
    }

    private static function performMedicationsSearch(WP_REST_Request $request)
    {
        $input = new V4InputNormalizer();
        $transport = new V4WorkerTransport($input);
        $query = trim((string) $request->get_param('q'));
        $limit = (int) ($request->get_param('limit') ?? 20);

        return $transport->medicationsSearch($query, $limit);
    }

    /**
     * @param array<string, mixed> $row
     */
    private function canAccessPrescriptionRow(array $row): bool
    {
        if (class_exists('\SosPrescription\\Services\\AccessPolicy') && method_exists('\SosPrescription\\Services\\AccessPolicy', 'can_current_user_access_prescription_row')) {
            return (bool) \SosPrescription\Services\AccessPolicy::can_current_user_access_prescription_row($row);
        }

        return current_user_can('manage_options') || current_user_can('edit_others_posts');
    }
}
