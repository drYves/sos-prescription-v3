<?php // includes/Core/JobDispatcher.php

declare(strict_types=1);

namespace SOSPrescription\Core;

use RuntimeException;
use SOSPrescription\Repositories\FileRepository;
use wpdb;

final class JobDispatcher
{
    private const DEFAULT_INGEST_PATH = '/api/v1/prescriptions';
    private const DEFAULT_TIMEOUT_S = 30;

    private string $ingestPath;
    private WorkerApiClient $workerApiClient;

    public function __construct(
        private wpdb $db,
        private NdjsonLogger $logger,
        private string $siteId,
        private string $hmacSecret,
        private ?string $kid = null,
        ?string $workerBaseUrl = null,
        ?string $ingestPath = null,
        ?int $timeoutS = null,
        ?string $hmacSecretPrevious = null,
        ?WorkerApiClient $workerApiClient = null
    ) {
        $this->ingestPath = self::normalizeApiPath($ingestPath ?? self::readConfigString('ML_WORKER_INGEST_PATH', self::DEFAULT_INGEST_PATH));

        $resolvedBaseUrl = trim((string) ($workerBaseUrl !== null ? $workerBaseUrl : self::readConfigString('ML_WORKER_BASE_URL')));
        $resolvedTimeoutS = max(2, (int) ($timeoutS ?? (int) self::readConfigString('ML_WORKER_INGEST_TIMEOUT_S', (string) self::DEFAULT_TIMEOUT_S)));
        $previous = trim((string) ($hmacSecretPrevious !== null ? $hmacSecretPrevious : self::readConfigString('ML_HMAC_SECRET_PREVIOUS')));
        $resolvedPrevious = $previous !== '' ? $previous : null;

        $this->workerApiClient = $workerApiClient ?? new WorkerApiClient(
            $this->logger,
            $this->siteId,
            $this->hmacSecret,
            $this->kid,
            $resolvedBaseUrl !== '' ? $resolvedBaseUrl : null,
            $resolvedTimeoutS,
            $resolvedPrevious
        );
    }

    public static function fromEnv(wpdb $db, NdjsonLogger $logger): self
    {
        $secret = self::readConfigString('ML_HMAC_SECRET');
        if ($secret === '') {
            throw new RuntimeException('La clé ML_HMAC_SECRET est manquante.');
        }

        $siteId = self::readConfigString('ML_SITE_ID', 'unknown_site');
        $kid = self::readConfigString('ML_HMAC_KID');
        $workerBaseUrl = self::readConfigString('ML_WORKER_BASE_URL');
        $ingestPath = self::readConfigString('ML_WORKER_INGEST_PATH', self::DEFAULT_INGEST_PATH);
        $timeoutS = (int) self::readConfigString('ML_WORKER_INGEST_TIMEOUT_S', (string) self::DEFAULT_TIMEOUT_S);
        $previous = self::readConfigString('ML_HMAC_SECRET_PREVIOUS');

        return new self(
            $db,
            $logger,
            $siteId,
            $secret,
            $kid !== '' ? $kid : null,
            $workerBaseUrl !== '' ? $workerBaseUrl : null,
            $ingestPath !== '' ? $ingestPath : self::DEFAULT_INGEST_PATH,
            $timeoutS > 0 ? $timeoutS : self::DEFAULT_TIMEOUT_S,
            $previous !== '' ? $previous : null
        );
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    public function submitPrescription(array $payload, ?string $reqId = null): array
    {
        $reqId = ReqId::coalesce($reqId);

        return $this->workerApiClient->postSignedJson($this->ingestPath, $payload, $reqId, 'ingest');
    }

    /**
     * @param array<string, mixed> $actorPayload
     * @param array<string, mixed> $artifactPayload
     * @return array<string, mixed>
     */
    public function initArtifactUpload(array $actorPayload, array $artifactPayload, ?string $reqId = null): array
    {
        $reqId = ReqId::coalesce($reqId);

        return $this->workerApiClient->postSignedJson(
            '/api/v1/artifacts/upload/init',
            [
                'actor' => $actorPayload,
                'artifact' => $artifactPayload,
            ],
            $reqId,
            'artifact_upload_init'
        );
    }

    /**
     * @param array<string, mixed> $actorPayload
     * @return array<string, mixed>
     */
    public function queryPrescriptionMessages(string $workerPrescriptionId, array $actorPayload, int $afterSeq = 0, int $limit = 50, ?string $reqId = null): array
    {
        $reqId = ReqId::coalesce($reqId);
        $prescriptionId = trim($workerPrescriptionId);
        if ($prescriptionId === '') {
            throw new RuntimeException('ID de prescription Worker manquant.');
        }

        $actor = $this->normalizeActorPayload($actorPayload);
        $afterSeq = max(0, $afterSeq);
        $limit = max(1, min(200, $limit));

        $params = [
            'actor_role' => $actor['role'],
        ];
        if ($actor['wp_user_id'] !== null) {
            $params['actor_wp_user_id'] = (string) $actor['wp_user_id'];
        }
        $params['after_seq'] = (string) $afterSeq;
        $params['limit'] = (string) $limit;

        $path = '/api/v1/prescriptions/' . rawurlencode($prescriptionId) . '/messages?' . http_build_query($params, '', '&', PHP_QUERY_RFC3986);
        return $this->workerApiClient->getSignedJson($path, $reqId, 'messages_query');
    }

    /**
     * @param array<string, mixed> $actorPayload
     * @param array<int, string>|null $attachmentArtifactIds
     * @return array<string, mixed>
     */
    public function createPrescriptionMessage(string $workerPrescriptionId, array $actorPayload, string $body, ?array $attachmentArtifactIds = null, ?string $reqId = null): array
    {
        $reqId = ReqId::coalesce($reqId);
        $prescriptionId = trim($workerPrescriptionId);
        if ($prescriptionId === '') {
            throw new RuntimeException('ID de prescription Worker manquant.');
        }

        $messageBody = trim($body);
        if ($messageBody === '') {
            throw new RuntimeException('Le message est vide.');
        }

        $payload = [
            'actor' => $this->normalizeActorPayload($actorPayload),
            'message' => [
                'body' => $messageBody,
            ],
        ];

        $normalizedIds = $this->normalizeStringIdArray($attachmentArtifactIds ?? []);
        if ($normalizedIds !== []) {
            $payload['message']['attachment_artifact_ids'] = $normalizedIds;
        }

        $path = '/api/v1/prescriptions/' . rawurlencode($prescriptionId) . '/messages';
        return $this->workerApiClient->postSignedJson($path, $payload, $reqId, 'messages_create');
    }

    /**
     * @param array<string, mixed> $actorPayload
     * @return array<string, mixed>
     */
    public function markPrescriptionMessagesRead(string $workerPrescriptionId, array $actorPayload, int $readUptoSeq, ?string $reqId = null): array
    {
        $reqId = ReqId::coalesce($reqId);
        $prescriptionId = trim($workerPrescriptionId);
        if ($prescriptionId === '') {
            throw new RuntimeException('ID de prescription Worker manquant.');
        }

        $path = '/api/v1/prescriptions/' . rawurlencode($prescriptionId) . '/messages/read';
        return $this->workerApiClient->postSignedJson(
            $path,
            [
                'actor' => $this->normalizeActorPayload($actorPayload),
                'read_upto_seq' => max(0, $readUptoSeq),
            ],
            $reqId,
            'messages_read'
        );
    }

    /**
     * @param array<string, mixed> $actorPayload
     * @return array<string, mixed>
     */
    public function createArtifactAccess(string $artifactId, array $actorPayload, string $disposition = 'inline', ?string $reqId = null): array
    {
        $reqId = ReqId::coalesce($reqId);
        $artifactId = trim($artifactId);
        if ($artifactId === '') {
            throw new RuntimeException('ID artefact Worker manquant.');
        }

        $normalizedDisposition = strtolower(trim($disposition)) === 'attachment' ? 'attachment' : 'inline';
        $path = '/api/v1/artifacts/' . rawurlencode($artifactId) . '/access';
        return $this->workerApiClient->postSignedJson(
            $path,
            [
                'actor' => $this->normalizeActorPayload($actorPayload),
                'disposition' => $normalizedDisposition,
            ],
            $reqId,
            'artifact_access'
        );
    }

    /**
     * @param array<string, mixed> $actorPayload
     * @return array<string, mixed>
     */
    public function analyzeArtifact(string $artifactId, array $actorPayload, ?string $reqId = null): array
    {
        $reqId = ReqId::coalesce($reqId);
        $artifactId = trim($artifactId);
        if ($artifactId === '') {
            throw new RuntimeException('ID artefact Worker manquant.');
        }

        $path = '/api/v1/artifacts/' . rawurlencode($artifactId) . '/analyze';
        return $this->workerApiClient->postSignedJson(
            $path,
            [
                'actor' => $this->normalizeActorPayload($actorPayload),
            ],
            $reqId,
            'artifact_analyze'
        );
    }

    /**
     * @param array<string, mixed> $doctorPayload
     * @param array<int, mixed>|null $items
     * @return array<string, mixed>
     */
    public function approvePrescription(string $workerPrescriptionId, array $doctorPayload, ?string $reqId = null, ?array $items = null): array
    {
        $reqId = ReqId::coalesce($reqId);
        $prescriptionId = trim($workerPrescriptionId);
        if ($prescriptionId === '') {
            throw new RuntimeException('ID de prescription Worker manquant.');
        }

        $payload = [
            'doctor' => $doctorPayload,
        ];
        if ($items !== null && $items !== []) {
            $payload['items'] = array_values($items);
        }

        $path = '/api/v1/prescriptions/' . rawurlencode($prescriptionId) . '/approve';
        return $this->workerApiClient->postSignedJson($path, $payload, $reqId, 'approve');
    }

    /**
     * @return array<string, mixed>
     */
    public function rejectPrescription(string $workerPrescriptionId, ?string $reason = null, ?string $reqId = null): array
    {
        $reqId = ReqId::coalesce($reqId);
        $prescriptionId = trim($workerPrescriptionId);
        if ($prescriptionId === '') {
            throw new RuntimeException('ID de prescription Worker manquant.');
        }

        $path = '/api/v1/prescriptions/' . rawurlencode($prescriptionId) . '/reject';
        return $this->workerApiClient->postSignedJson(
            $path,
            [
                'reason' => $reason !== null && trim($reason) !== '' ? trim($reason) : null,
            ],
            $reqId,
            'reject'
        );
    }

    public function buildDoctorPayloadFromUserId(int $doctorUserId): array
    {
        if ($doctorUserId <= 0) {
            throw new RuntimeException('ID de docteur invalide');
        }

        $doctorUser = get_userdata($doctorUserId);
        $name = $this->resolveHumanName(
            $doctorUser,
            ['first_name', 'billing_first_name'],
            ['last_name', 'billing_last_name'],
            true
        );

        $title = $this->readUserMetaFirst($doctorUserId, [
            'sosprescription_doctor_title',
            'doctor_title',
            'title',
        ]);
        if ($title === '') {
            $title = $this->inferDoctorTitleFromNameSource($doctorUser);
        }

        $specialty = $this->readUserMetaFirst($doctorUserId, [
            'sosprescription_specialty',
            'sosprescription_doctor_specialty',
            'specialty',
            'doctor_specialty',
        ]);

        $rpps = $this->sanitizeDigits($this->readUserMetaFirst($doctorUserId, [
            'sosprescription_rpps',
            'sosprescription_doctor_rpps',
            'rpps',
            'doctor_rpps',
        ]));

        $phone = $this->readUserMetaFirst($doctorUserId, [
            'sosprescription_professional_phone',
            'sosprescription_doctor_phone',
            'sosprescription_phone',
            'billing_phone',
            'professional_phone',
            'phone',
            'telephone',
            'tel',
        ]);

        $addressLine1 = $this->readUserMetaFirst($doctorUserId, [
            'sosprescription_professional_address',
            'sosprescription_doctor_address',
            'professional_address',
            'address',
            'billing_address_1',
        ]);
        $addressLine2 = $this->readUserMetaFirst($doctorUserId, [
            'billing_address_2',
            'address_2',
        ]);
        $address = trim($addressLine1 . ($addressLine2 !== '' ? "\n" . $addressLine2 : ''));

        $city = $this->readUserMetaFirst($doctorUserId, [
            'sosprescription_professional_city',
            'sosprescription_city',
            'professional_city',
            'billing_city',
            'city',
            'ville',
        ]);
        $zipCode = $this->readUserMetaFirst($doctorUserId, [
            'sosprescription_professional_zip',
            'sosprescription_zip',
            'professional_zip',
            'billing_postcode',
            'zip_code',
            'postal_code',
            'postcode',
            'code_postal',
        ]);

        if ($address !== '' && ($city === '' || $zipCode === '')) {
            $parsedAddress = $this->splitAddressCityZip($address);
            if ($zipCode === '' && $parsedAddress['zip_code'] !== '') {
                $zipCode = $parsedAddress['zip_code'];
            }
            if ($city === '' && $parsedAddress['city'] !== '') {
                $city = $parsedAddress['city'];
            }
        }

        $amNumber = $this->readUserMetaFirst($doctorUserId, [
            'sosprescription_am_number',
            'sosprescription_doctor_am_number',
            'doctor_am_number',
            'am_number',
            'numero_assurance_maladie',
            'assurance_maladie_number',
        ]);

        $email = '';
        if ($doctorUser instanceof \WP_User && isset($doctorUser->user_email) && is_string($doctorUser->user_email)) {
            $email = sanitize_email($doctorUser->user_email);
        }

        return [
            'wpUserId' => $doctorUserId,
            'firstName' => $name['first_name'],
            'lastName' => $name['last_name'],
            'email' => $email !== '' ? $email : null,
            'phone' => $phone !== '' ? $phone : null,
            'title' => $title !== '' ? $title : null,
            'specialty' => $specialty !== '' ? $specialty : null,
            'rpps' => $rpps !== '' ? $rpps : null,
            'amNumber' => $amNumber !== '' ? $amNumber : null,
            'address' => $address !== '' ? $address : null,
            'city' => $city !== '' ? $city : null,
            'zipCode' => $zipCode !== '' ? $zipCode : null,
            'signatureS3Key' => $this->resolveDoctorSignatureS3Key($doctorUserId),
        ];
    }


    /**
     * @return array<string, mixed>
     */
    public function buildPatientPayloadFromUserId(int $patientUserId): array
    {
        if ($patientUserId <= 0) {
            throw new RuntimeException('ID de patient invalide');
        }

        $patientUser = get_userdata($patientUserId);
        $name = $this->resolveHumanName(
            $patientUser,
            ['first_name', 'billing_first_name'],
            ['last_name', 'billing_last_name'],
            false
        );

        $birthDate = $this->normalizeBirthdateString($this->readUserMetaFirst($patientUserId, [
            'sosp_birthdate',
            'birthdate',
            'birth_date',
            'date_of_birth',
        ]));

        $phone = $this->readUserMetaFirst($patientUserId, [
            'billing_phone',
            'sosprescription_phone',
            'phone',
            'telephone',
            'mobile',
        ]);

        $gender = $this->readUserMetaFirst($patientUserId, [
            'gender',
            'billing_gender',
            'sosp_gender',
        ]);

        $weightKg = $this->normalizeMetricString($this->readUserMetaFirst($patientUserId, [
            'sosp_weight_kg',
            'weight_kg',
            'patient_weight_kg',
        ]), 1, 500);

        $email = '';
        if ($patientUser instanceof \WP_User && isset($patientUser->user_email) && is_string($patientUser->user_email)) {
            $email = sanitize_email($patientUser->user_email);
        }

        return [
            'firstName' => $name['first_name'],
            'lastName' => $name['last_name'],
            'birthDate' => $birthDate !== '' ? $birthDate : null,
            'gender' => $gender !== '' ? $gender : null,
            'email' => $email !== '' ? $email : null,
            'phone' => $phone !== '' ? $phone : null,
            'weight_kg' => $weightKg !== '' ? $weightKg : null,
        ];
    }

    private static function readConfigString(string $name, string $default = ''): string
    {
        if (defined($name)) {
            $value = constant($name);
            if (is_string($value)) {
                return $value;
            }
            if (is_scalar($value)) {
                return (string) $value;
            }
        }

        $value = getenv($name);
        if (is_string($value)) {
            return $value;
        }

        return $default;
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    private function normalizeActorPayload(array $actorPayload): array
    {
        $rawRole = strtoupper(trim((string) ($actorPayload['role'] ?? 'PATIENT')));
        $role = in_array($rawRole, ['DOCTOR', 'PATIENT', 'SYSTEM'], true) ? $rawRole : 'PATIENT';

        $rawWpUserId = $actorPayload['wp_user_id'] ?? $actorPayload['wpUserId'] ?? null;
        $wpUserId = null;
        if ($rawWpUserId !== null && $rawWpUserId !== '' && is_numeric($rawWpUserId)) {
            $wpUserId = (int) $rawWpUserId;
            if ($wpUserId < 1) {
                $wpUserId = null;
            }
        }

        return [
            'role' => $role,
            'wp_user_id' => $wpUserId,
        ];
    }

    /**
     * @param array<int, mixed> $ids
     * @return array<int, string>
     */
    private function normalizeStringIdArray(array $ids): array
    {
        $out = [];
        foreach ($ids as $raw) {
            if ($raw === null || !is_scalar($raw)) {
                continue;
            }
            $id = trim((string) $raw);
            if ($id === '') {
                continue;
            }
            if (strlen($id) < 8 || strlen($id) > 64) {
                continue;
            }
            $out[] = $id;
            if (count($out) >= 10) {
                break;
            }
        }

        return array_values(array_unique($out));
    }

    private function readUserMetaFirst(int $userId, array $keys): string
    {
        if ($userId <= 0) {
            return '';
        }

        foreach ($keys as $key) {
            $key = trim((string) $key);
            if ($key === '') {
                continue;
            }

            $value = get_user_meta($userId, $key, true);
            if (is_scalar($value)) {
                $text = trim((string) $value);
                if ($text !== '') {
                    return $text;
                }
            }
        }

        return '';
    }

    /**
     * @param array<int, string> $userFirstMetaKeys
     * @param array<int, string> $userLastMetaKeys
     * @param array<int, string> $fallbackFirstCandidates
     * @param array<int, string> $fallbackLastCandidates
     * @param array<int, string> $fallbackFullnameCandidates
     * @return array{first_name:string,last_name:string}
     */
    private function resolveHumanName(
        mixed $user,
        array $userFirstMetaKeys,
        array $userLastMetaKeys,
        bool $isDoctor,
        array $fallbackFirstCandidates = [],
        array $fallbackLastCandidates = [],
        array $fallbackFullnameCandidates = []
    ): array {
        $firstName = '';
        $lastName = '';
        $displayName = '';
        $userLogin = '';
        $userId = 0;

        if ($user instanceof \WP_User) {
            $userId = (int) $user->ID;
            $displayName = isset($user->display_name) ? trim((string) $user->display_name) : '';
            $userLogin = isset($user->user_login) ? trim((string) $user->user_login) : '';

            if (isset($user->first_name) && is_string($user->first_name)) {
                $firstName = trim($user->first_name);
            }
            if (isset($user->last_name) && is_string($user->last_name)) {
                $lastName = trim($user->last_name);
            }
        }

        if ($userId > 0 && $firstName === '') {
            $firstName = $this->readUserMetaFirst($userId, $userFirstMetaKeys);
        }
        if ($userId > 0 && $lastName === '') {
            $lastName = $this->readUserMetaFirst($userId, $userLastMetaKeys);
        }

        foreach ($fallbackFirstCandidates as $candidate) {
            if ($firstName !== '') {
                break;
            }
            $candidate = trim((string) $candidate);
            if ($candidate !== '' && !$this->looksLikeEmail($candidate)) {
                $firstName = $candidate;
            }
        }

        foreach ($fallbackLastCandidates as $candidate) {
            if ($lastName !== '') {
                break;
            }
            $candidate = trim((string) $candidate);
            if ($candidate !== '' && !$this->looksLikeEmail($candidate)) {
                $lastName = $candidate;
            }
        }

        $fullNameCandidate = $this->firstNonEmpty($fallbackFullnameCandidates);
        if (($firstName === '' || $lastName === '') && $fullNameCandidate === '' && $displayName !== '' && !$this->looksLikeEmail($displayName)) {
            $fullNameCandidate = $displayName;
        }
        if (($firstName === '' || $lastName === '') && $fullNameCandidate === '' && $userLogin !== '' && !$this->looksLikeEmail($userLogin)) {
            $fullNameCandidate = $userLogin;
        }

        if ($fullNameCandidate !== '') {
            $split = $this->splitHumanName($fullNameCandidate, $isDoctor);
            if ($firstName === '') {
                $firstName = $split['first_name'];
            }
            if ($lastName === '') {
                $lastName = $split['last_name'];
            }
        }

        $firstName = $this->cleanupNameToken($firstName, $isDoctor);
        $lastName = $this->cleanupNameToken($lastName, $isDoctor);

        if ($firstName === '' && $lastName !== '') {
            $split = $this->splitHumanName($lastName, $isDoctor);
            $firstName = $split['first_name'];
            $lastName = $split['last_name'];
        }
        if ($lastName === '' && $firstName !== '') {
            $split = $this->splitHumanName($firstName, $isDoctor);
            $firstName = $split['first_name'];
            $lastName = $split['last_name'];
        }

        if ($firstName === '') {
            $firstName = $isDoctor ? 'Médecin' : 'Patient';
        }
        if ($lastName === '') {
            $lastName = $isDoctor ? 'Prescripteur' : 'Inconnu';
        }

        return [
            'first_name' => $firstName,
            'last_name' => $lastName,
        ];
    }

    /**
     * @return array{first_name:string,last_name:string}
     */
    private function splitHumanName(string $value, bool $isDoctor): array
    {
        $clean = $this->cleanupNameToken($value, $isDoctor);
        if ($clean === '' || $this->looksLikeEmail($clean)) {
            return ['first_name' => '', 'last_name' => ''];
        }

        $parts = preg_split('/\s+/u', $clean) ?: [];
        $parts = array_values(array_filter(array_map('trim', $parts), static fn (string $part): bool => $part !== ''));
        if ($parts === []) {
            return ['first_name' => '', 'last_name' => ''];
        }
        if (count($parts) === 1) {
            return ['first_name' => $parts[0], 'last_name' => ''];
        }

        $firstName = array_shift($parts);
        $lastName = implode(' ', $parts);

        return [
            'first_name' => $this->cleanupNameToken((string) $firstName, $isDoctor),
            'last_name' => $this->cleanupNameToken($lastName, $isDoctor),
        ];
    }

    private function cleanupNameToken(string $value, bool $isDoctor): string
    {
        $value = wp_strip_all_tags((string) $value, true);
        $value = trim(preg_replace('/\s+/u', ' ', $value) ?? '');
        if ($value === '') {
            return '';
        }

        if ($this->looksLikeEmail($value)) {
            return '';
        }

        if ($isDoctor) {
            $value = preg_replace('/^(dr\.?|docteur|pr\.?|prof\.?|professeur)\s+/iu', '', $value) ?? $value;
            $value = trim($value);
        }

        return $value;
    }

    private function inferDoctorTitleFromNameSource(mixed $user): string
    {
        $candidates = [];
        if ($user instanceof \WP_User) {
            if (isset($user->display_name) && is_string($user->display_name)) {
                $candidates[] = $user->display_name;
            }
            if (isset($user->user_login) && is_string($user->user_login)) {
                $candidates[] = $user->user_login;
            }
        }

        foreach ($candidates as $candidate) {
            $raw = trim((string) $candidate);
            if ($raw === '') {
                continue;
            }
            if (preg_match('/^(pr\.?|prof\.?|professeur)\b/iu', $raw)) {
                return 'professeur';
            }
            if (preg_match('/^(dr\.?|docteur)\b/iu', $raw)) {
                return 'docteur';
            }
        }

        return '';
    }

    /**
     * @return array{address:string,zip_code:string,city:string}
     */
    private function splitAddressCityZip(string $address): array
    {
        $normalized = trim(preg_replace('/\s+/u', ' ', str_replace(["\r\n", "\r"], "\n", $address)) ?? '');
        if ($normalized === '') {
            return ['address' => '', 'zip_code' => '', 'city' => ''];
        }

        $parts = preg_split('/[,\n]/u', $normalized) ?: [];
        $parts = array_values(array_filter(array_map('trim', $parts), static fn (string $part): bool => $part !== ''));
        $last = $parts !== [] ? (string) end($parts) : $normalized;

        if (preg_match('/\b(?P<zip>\d{5})\s+(?P<city>[\p{L}\p{M}\-\'\s]+)$/u', $last, $m)) {
            return [
                'address' => $normalized,
                'zip_code' => trim((string) ($m['zip'] ?? '')),
                'city' => trim((string) ($m['city'] ?? '')),
            ];
        }

        return ['address' => $normalized, 'zip_code' => '', 'city' => ''];
    }

    private function resolveDoctorSignatureS3Key(int $doctorUserId): ?string
    {
        if ($doctorUserId <= 0) {
            return null;
        }

        $directKey = $this->readUserMetaFirst($doctorUserId, [
            'signature_s3_key',
            'sosprescription_signature_s3_key',
            'sosprescription_doctor_signature_s3_key',
        ]);
        if ($directKey !== '') {
            return $this->normalizeSignatureKeyForWorker($directKey);
        }

        $attachmentId = (int) $this->readUserMetaFirst($doctorUserId, [
            'signature_attachment_id',
            'sosprescription_signature_attachment_id',
            'sosprescription_doctor_signature_attachment_id',
        ]);
        if ($attachmentId > 0) {
            $attachedFile = get_post_meta($attachmentId, '_wp_attached_file', true);
            if (is_string($attachedFile) && trim($attachedFile) !== '') {
                return $this->normalizeSignatureKeyForWorker($attachedFile);
            }
        }

        $fileId = (int) $this->readUserMetaFirst($doctorUserId, [
            'sosprescription_signature_file_id',
            'signature_file_id',
        ]);

        $repo = new FileRepository();
        if ($fileId > 0) {
            $file = $repo->get($fileId);
            if (is_array($file) && !empty($file['storage_key']) && is_scalar($file['storage_key'])) {
                return $this->normalizeSignatureKeyForWorker((string) $file['storage_key']);
            }
        }

        $latest = $repo->find_latest_for_owner_purpose($doctorUserId, 'doctor_signature');
        if (is_array($latest) && !empty($latest['storage_key']) && is_scalar($latest['storage_key'])) {
            return $this->normalizeSignatureKeyForWorker((string) $latest['storage_key']);
        }

        return null;
    }

    private function normalizeSignatureKeyForWorker(string $rawKey): ?string
    {
        $key = trim($rawKey);
        if ($key === '') {
            return null;
        }

        if (stripos($key, 's3://') === 0) {
            return $key;
        }

        $key = ltrim($key, '/');
        if ($key === '') {
            return null;
        }

        $bucket = self::readConfigString('S3_BUCKET_SIGNATURES');
        if ($bucket === '') {
            $bucket = self::readConfigString('S3_BUCKET_PDF');
        }

        return $bucket !== '' ? sprintf('s3://%s/%s', trim($bucket), $key) : $key;
    }

    private function normalizeBirthdateString(string $value): string
    {
        $raw = trim($value);
        if ($raw === '') {
            return '';
        }

        if (preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $raw, $m)) {
            $year = (int) $m[1];
            $month = (int) $m[2];
            $day = (int) $m[3];
            return checkdate($month, $day, $year) ? sprintf('%04d-%02d-%02d', $year, $month, $day) : '';
        }

        if (preg_match('/^(\d{2})[\/\-.](\d{2})[\/\-.](\d{4})$/', $raw, $m)) {
            $day = (int) $m[1];
            $month = (int) $m[2];
            $year = (int) $m[3];
            return checkdate($month, $day, $year) ? sprintf('%04d-%02d-%02d', $year, $month, $day) : '';
        }

        return '';
    }

    private function normalizeMetricString(string $value, float $min, float $max): string
    {
        $raw = str_replace(',', '.', trim($value));
        if ($raw === '' || !is_numeric($raw)) {
            return '';
        }

        $number = (float) $raw;
        if ($number < $min || $number > $max) {
            return '';
        }

        $formatted = number_format($number, 1, '.', '');
        return str_ends_with($formatted, '.0') ? substr($formatted, 0, -2) : $formatted;
    }

    private function sanitizeDigits(string $value): string
    {
        return preg_replace('/\D+/', '', trim($value)) ?? '';
    }

    /**
     * @param array<int, string> $values
     */
    private function firstNonEmpty(array $values): string
    {
        foreach ($values as $value) {
            $value = trim((string) $value);
            if ($value !== '') {
                return $value;
            }
        }

        return '';
    }

    private function looksLikeEmail(string $value): bool
    {
        $value = trim($value);
        if ($value === '' || strpos($value, '@') === false) {
            return false;
        }

        return (bool) is_email($value);
    }

    private static function normalizeApiPath(string $path): string
    {
        $trimmed = trim($path);
        if ($trimmed === '') {
            return self::DEFAULT_INGEST_PATH;
        }

        return '/' . ltrim($trimmed, '/');
    }

}