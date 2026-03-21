<?php // includes/Core/JobDispatcher.php

declare(strict_types=1);

namespace SOSPrescription\Core;

use RuntimeException;
use SOSPrescription\Repositories\FileRepository;
use SOSPrescription\Repositories\PrescriptionRepository;
use wpdb;

final class JobDispatcher
{
    private const CURRENT_SCHEMA_VERSION = '2026.6';
    private const JOB_TYPE = 'PDF_GEN';
    private const DEFAULT_PRIORITY = 50;
    private const DEFAULT_MAX_ATTEMPTS = 5;
    private const DEFAULT_EXPIRATION_MS = 86400000;
    private const DEFAULT_INGEST_PATH = '/api/v1/prescriptions';

    /** @var array<string, true>|null */
    private ?array $jobsColumns = null;

    public function __construct(
        private wpdb $db,
        private NdjsonLogger $logger,
        private string $siteId,
        private string $hmacSecret,
        private ?string $kid = null,
        ?string $workerBaseUrl = null,
        ?string $ingestPath = null,
        ?int $timeoutS = null,
        ?string $hmacSecretPrevious = null
    ) {
        unset($workerBaseUrl, $ingestPath, $timeoutS, $hmacSecretPrevious);
    }

    public static function fromEnv(wpdb $db, NdjsonLogger $logger): self
    {
        $secret = self::readConfigString('ML_HMAC_SECRET');
        if ($secret === '') {
            throw new RuntimeException('Missing ML_HMAC_SECRET');
        }

        $siteId = self::readConfigString('ML_SITE_ID', 'unknown_site');
        $kid = self::readConfigString('ML_HMAC_KID');

        return new self(
            $db,
            $logger,
            $siteId,
            $secret,
            $kid !== '' ? $kid : null
        );
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
     * @return array{ok:true,job_id:string,dedup:bool,req_id:string,mode:string,status:string,processing_status:string,uid:string,verify_token:string|null}
     */
    public function dispatch_pdf_generation(int $rx_id, ?string $reqId = null): array
    {
        $reqId = ReqId::coalesce($reqId);
        if ($rx_id <= 0) {
            throw new RuntimeException('Invalid rx_id');
        }

        $jobsTable = $this->jobsTableName();
        $this->ensureJobsTableReady($jobsTable);

        $payload = $this->buildIngressPayload($rx_id, $reqId);
        $rawJson = wp_json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if (!is_string($rawJson) || $rawJson === '') {
            throw new RuntimeException('JSON encode failed');
        }

        $jobId = $this->generateJobId();
        $jobNonce = $this->generateUrlSafeRandom(24);
        $payloadSha256Binary = hash('sha256', $rawJson, true);
        $mls1Token = $this->buildMls1Token($rawJson);
        $nowMysql = $this->dbNowMysql();
        $expMs = $this->nowMs() + $this->defaultExpirationMs();

        $insertData = $this->buildInsertData(
            $jobId,
            $reqId,
            $rx_id,
            $jobNonce,
            $rawJson,
            $payloadSha256Binary,
            $mls1Token,
            $nowMysql,
            $expMs
        );
        $insertFormats = $this->buildInsertFormats($insertData);

        $inserted = false;
        $lastError = '';

        for ($attempt = 0; $attempt < 3; $attempt++) {
            if ($attempt > 0) {
                $jobId = $this->generateJobId();
                $jobNonce = $this->generateUrlSafeRandom(24);

                $insertData = $this->buildInsertData(
                    $jobId,
                    $reqId,
                    $rx_id,
                    $jobNonce,
                    $rawJson,
                    $payloadSha256Binary,
                    $mls1Token,
                    $nowMysql,
                    $expMs
                );
                $insertFormats = $this->buildInsertFormats($insertData);
            }

            $previousSuppress = $this->db->suppress_errors(true);
            $result = $this->db->insert($jobsTable, $insertData, $insertFormats);
            $this->db->suppress_errors($previousSuppress);

            if ($result !== false) {
                $inserted = true;
                break;
            }

            $lastError = trim((string) $this->db->last_error);
            if (!$this->isRetryableInsertCollision($lastError)) {
                break;
            }
        }

        if (!$inserted) {
            $message = $lastError !== '' ? $lastError : 'Local job insert failed';

            $this->logger->error('job.dispatch.local_insert_failed', [
                'rx_id' => $rx_id,
                'job_id' => $jobId,
                'table' => $jobsTable,
                'db_error' => $message,
            ], $reqId);

            throw new RuntimeException('Failed to insert local PDF job');
        }

        $uid = '';
        if (
            isset($payload['prescription'])
            && is_array($payload['prescription'])
            && isset($payload['prescription']['wpPrescriptionUid'])
            && is_scalar($payload['prescription']['wpPrescriptionUid'])
        ) {
            $uid = (string) $payload['prescription']['wpPrescriptionUid'];
        }

        $verifyToken = null;
        if (
            isset($payload['prescription'])
            && is_array($payload['prescription'])
            && array_key_exists('verifyToken', $payload['prescription'])
        ) {
            $candidate = $payload['prescription']['verifyToken'];
            if ($candidate !== null && is_scalar($candidate)) {
                $verifyToken = (string) $candidate;
            }
        }

        $this->logger->info('job.dispatch.local_enqueued', [
            'rx_id' => $rx_id,
            'job_id' => $jobId,
            'table' => $jobsTable,
            'status' => 'PENDING',
            'processing_status' => 'PENDING',
        ], $reqId);

        return [
            'ok' => true,
            'job_id' => $jobId,
            'dedup' => false,
            'req_id' => $reqId,
            'mode' => 'created',
            'status' => 'PENDING',
            'processing_status' => 'PENDING',
            'uid' => $uid,
            'verify_token' => $verifyToken,
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function buildIngressPayload(int $rxId, string $reqId): array
    {
        $rx = $this->fetchPrescription($rxId);

        $doctorUserId = isset($rx['doctor_user_id']) ? (int) $rx['doctor_user_id'] : 0;
        if ($doctorUserId <= 0 && function_exists('get_current_user_id')) {
            $doctorUserId = (int) get_current_user_id();
        }
        if ($doctorUserId <= 0) {
            throw new RuntimeException('Prescription has no assigned doctor');
        }

        $patientUserId = isset($rx['patient_user_id']) ? (int) $rx['patient_user_id'] : 0;
        $tsMs = (int) floor(microtime(true) * 1000);

        return [
            'schema_version' => self::CURRENT_SCHEMA_VERSION,
            'site_id' => $this->siteId,
            'ts_ms' => $tsMs,
            'nonce' => $this->generateUrlSafeRandom(16),
            'req_id' => $reqId,
            'doctor' => $this->buildDoctorPayload($doctorUserId),
            'patient' => $this->buildPatientPayload($rx, $patientUserId),
            'prescription' => $this->buildPrescriptionPayload($rx, $rxId),
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function fetchPrescription(int $rxId): array
    {
        $repo = new PrescriptionRepository();
        $rx = $repo->get($rxId);
        if (!is_array($rx) || empty($rx['id'])) {
            throw new RuntimeException('Prescription not found');
        }

        return $rx;
    }

    /**
     * @return array<string, mixed>
     */
    private function buildDoctorPayload(int $doctorUserId): array
    {
        $doctorUser = $doctorUserId > 0 ? get_userdata($doctorUserId) : false;
        $name = $this->resolveHumanName(
            $doctorUser,
            [
                'first_name',
                'billing_first_name',
            ],
            [
                'last_name',
                'billing_last_name',
            ],
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
     * @param array<string, mixed> $rx
     * @return array<string, mixed>
     */
    private function buildPatientPayload(array $rx, int $patientUserId): array
    {
        $patientUser = $patientUserId > 0 ? get_userdata($patientUserId) : false;
        $payload = isset($rx['payload']) && is_array($rx['payload']) ? $rx['payload'] : [];
        $patientBlock = isset($payload['patient']) && is_array($payload['patient']) ? $payload['patient'] : [];

        $name = $this->resolveHumanName(
            $patientUser,
            [
                'first_name',
                'billing_first_name',
            ],
            [
                'last_name',
                'billing_last_name',
            ],
            false,
            [
                isset($patientBlock['first_name']) ? (string) $patientBlock['first_name'] : '',
                isset($patientBlock['firstname']) ? (string) $patientBlock['firstname'] : '',
                isset($patientBlock['firstName']) ? (string) $patientBlock['firstName'] : '',
                isset($payload['patient_first_name']) ? (string) $payload['patient_first_name'] : '',
            ],
            [
                isset($patientBlock['last_name']) ? (string) $patientBlock['last_name'] : '',
                isset($patientBlock['lastname']) ? (string) $patientBlock['lastname'] : '',
                isset($patientBlock['lastName']) ? (string) $patientBlock['lastName'] : '',
                isset($payload['patient_last_name']) ? (string) $payload['patient_last_name'] : '',
            ],
            [
                isset($patientBlock['fullname']) ? (string) $patientBlock['fullname'] : '',
                isset($payload['patient_name']) ? (string) $payload['patient_name'] : '',
                isset($rx['patient_name']) ? (string) $rx['patient_name'] : '',
            ]
        );

        $birthDate = $this->normalizeBirthdateString(
            $this->firstNonEmpty([
                $patientUserId > 0 ? $this->readUserMetaFirst($patientUserId, ['sosp_birthdate']) : '',
                isset($patientBlock['birthdate']) ? (string) $patientBlock['birthdate'] : '',
                isset($patientBlock['birthDate']) ? (string) $patientBlock['birthDate'] : '',
                isset($payload['patient_birthdate']) ? (string) $payload['patient_birthdate'] : '',
                isset($rx['patient_birthdate']) ? (string) $rx['patient_birthdate'] : '',
                isset($rx['patient_dob']) ? (string) $rx['patient_dob'] : '',
            ])
        );

        if ($birthDate === '') {
            throw new RuntimeException('Patient birthdate is missing');
        }

        $email = '';
        if ($patientUser instanceof \WP_User && isset($patientUser->user_email) && is_string($patientUser->user_email)) {
            $email = sanitize_email($patientUser->user_email);
        }
        if ($email === '' && isset($patientBlock['email']) && is_string($patientBlock['email'])) {
            $email = sanitize_email($patientBlock['email']);
        }

        $phone = '';
        if ($patientUserId > 0) {
            $phone = $this->readUserMetaFirst($patientUserId, [
                'billing_phone',
                'sosprescription_phone',
                'phone',
                'telephone',
                'mobile',
            ]);
        }
        if ($phone === '' && isset($patientBlock['phone']) && is_string($patientBlock['phone'])) {
            $phone = trim($patientBlock['phone']);
        }

        $gender = '';
        if ($patientUserId > 0) {
            $gender = $this->readUserMetaFirst($patientUserId, [
                'gender',
                'billing_gender',
                'sosp_gender',
            ]);
        }
        if ($gender === '' && isset($patientBlock['gender']) && is_string($patientBlock['gender'])) {
            $gender = trim($patientBlock['gender']);
        }

        return [
            'firstName' => $name['first_name'],
            'lastName' => $name['last_name'],
            'birthDate' => $birthDate,
            'gender' => $gender !== '' ? $gender : null,
            'email' => $email !== '' ? $email : null,
            'phone' => $phone !== '' ? $phone : null,
        ];
    }

    /**
     * @param array<string, mixed> $rx
     * @return array<string, mixed>
     */
    private function buildPrescriptionPayload(array $rx, int $rxId): array
    {
        $payload = isset($rx['payload']) && is_array($rx['payload']) ? $rx['payload'] : [];
        $patientBlock = isset($payload['patient']) && is_array($payload['patient']) ? $payload['patient'] : [];

        $privateNotes = $this->firstNonEmpty([
            isset($patientBlock['note']) ? (string) $patientBlock['note'] : '',
            isset($payload['private_notes']) ? (string) $payload['private_notes'] : '',
            isset($rx['decision_reason']) ? (string) $rx['decision_reason'] : '',
        ]);

        $items = isset($rx['items']) && is_array($rx['items']) ? $this->normalizeMedicationItems($rx['items']) : [];

        return [
            'items' => $items,
            'privateNotes' => $privateNotes !== '' ? $privateNotes : null,
            'source' => 'wordpress',
            'wpPrescriptionId' => $rxId,
            'wpPrescriptionUid' => isset($rx['uid']) && is_scalar($rx['uid']) ? (string) $rx['uid'] : '',
            'wpStatus' => isset($rx['status']) && is_scalar($rx['status']) ? (string) $rx['status'] : '',
            'verifyToken' => isset($rx['verify_token']) && $rx['verify_token'] !== null ? (string) $rx['verify_token'] : '',
            'verifyCode' => isset($rx['verify_code']) && $rx['verify_code'] !== null ? (string) $rx['verify_code'] : '',
            'createdAt' => isset($rx['created_at']) && is_scalar($rx['created_at']) ? (string) $rx['created_at'] : '',
            'updatedAt' => isset($rx['updated_at']) && is_scalar($rx['updated_at']) ? (string) $rx['updated_at'] : '',
        ];
    }

    /**
     * @param array<int, mixed> $items
     * @return array<int, array<string, mixed>>
     */
    private function normalizeMedicationItems(array $items): array
    {
        $out = [];
        foreach ($items as $item) {
            if (!is_array($item)) {
                continue;
            }

            $raw = [];
            if (isset($item['raw']) && is_array($item['raw'])) {
                $raw = $item['raw'];
            }

            $out[] = [
                'line_no' => isset($item['line_no']) ? (int) $item['line_no'] : 0,
                'cis' => isset($item['cis']) && $item['cis'] !== null ? (string) $item['cis'] : null,
                'cip13' => isset($item['cip13']) && $item['cip13'] !== null ? (string) $item['cip13'] : null,
                'denomination' => isset($item['denomination']) ? (string) $item['denomination'] : 'Médicament',
                'posologie' => isset($item['posologie']) && $item['posologie'] !== null ? (string) $item['posologie'] : null,
                'quantite' => isset($item['quantite']) && $item['quantite'] !== null ? (string) $item['quantite'] : null,
                'raw' => $raw,
            ];
        }

        return array_values($out);
    }

    /**
     * @return array<string, mixed>
     */
    private function buildInsertData(
        string $jobId,
        string $reqId,
        int $rxId,
        string $jobNonce,
        string $rawJson,
        string $payloadSha256Binary,
        string $mls1Token,
        string $nowMysql,
        int $expMs
    ): array {
        $columns = $this->jobsTableColumns();

        $data = [
            'job_id' => $jobId,
            'site_id' => $this->siteId,
            'req_id' => $reqId,
            'job_type' => self::JOB_TYPE,
            'status' => 'PENDING',
            'priority' => self::DEFAULT_PRIORITY,
            'available_at' => $nowMysql,
            'rx_id' => $rxId,
            'nonce' => $jobNonce,
            'payload' => $rawJson,
            'mls1_token' => $mls1Token,
            'created_at' => $nowMysql,
            'updated_at' => $nowMysql,
        ];

        if (isset($columns['kid'])) {
            $data['kid'] = $this->kid ?? '';
        }
        if (isset($columns['exp_ms'])) {
            $data['exp_ms'] = $expMs;
        }
        if (isset($columns['payload_sha256'])) {
            $data['payload_sha256'] = $payloadSha256Binary;
        }
        if (isset($columns['attempts'])) {
            $data['attempts'] = 0;
        }
        if (isset($columns['max_attempts'])) {
            $data['max_attempts'] = self::DEFAULT_MAX_ATTEMPTS;
        }
        if (isset($columns['created_by'])) {
            $data['created_by'] = function_exists('get_current_user_id') ? (int) get_current_user_id() : 0;
        }
        if (isset($columns['worker_ref'])) {
            $data['worker_ref'] = '';
        }
        if (isset($columns['locked_by'])) {
            $data['locked_by'] = '';
        }
        if (isset($columns['last_error_code'])) {
            $data['last_error_code'] = '';
        }
        if (isset($columns['last_error_message_safe'])) {
            $data['last_error_message_safe'] = null;
        } elseif (isset($columns['last_error_message'])) {
            $data['last_error_message'] = null;
        }

        return $data;
    }

    /**
     * @param array<string, mixed> $data
     * @return array<int, string>
     */
    private function buildInsertFormats(array $data): array
    {
        $formats = [];

        foreach ($data as $key => $value) {
            if ($value === null) {
                $formats[] = '%s';
                continue;
            }

            if (in_array($key, ['priority', 'rx_id', 'exp_ms', 'attempts', 'max_attempts', 'created_by'], true)) {
                $formats[] = '%d';
                continue;
            }

            $formats[] = '%s';
        }

        return $formats;
    }

    /**
     * @return array<string, true>
     */
    private function jobsTableColumns(): array
    {
        if (is_array($this->jobsColumns)) {
            return $this->jobsColumns;
        }

        $table = $this->jobsTableName();
        $rows = $this->db->get_results('SHOW COLUMNS FROM `' . esc_sql($table) . '`', ARRAY_A);
        if (!is_array($rows)) {
            $this->jobsColumns = [];
            return $this->jobsColumns;
        }

        $out = [];
        foreach ($rows as $row) {
            if (!is_array($row) || empty($row['Field'])) {
                continue;
            }
            $out[(string) $row['Field']] = true;
        }

        $this->jobsColumns = $out;
        return $this->jobsColumns;
    }

    private function ensureJobsTableReady(string $table): void
    {
        $exists = $this->db->get_var($this->db->prepare('SHOW TABLES LIKE %s', $table));
        if (!is_string($exists) || $exists !== $table) {
            throw new RuntimeException('Jobs table is missing');
        }

        $columns = $this->jobsTableColumns();
        $required = [
            'job_id',
            'site_id',
            'job_type',
            'status',
            'priority',
            'available_at',
            'rx_id',
            'nonce',
            'payload',
            'mls1_token',
            'req_id',
            'created_at',
            'updated_at',
        ];

        foreach ($required as $column) {
            if (!isset($columns[$column])) {
                throw new RuntimeException(sprintf('Jobs table is missing required column: %s', $column));
            }
        }
    }

    private function jobsTableName(): string
    {
        return $this->db->prefix . 'sosprescription_jobs';
    }

    private function buildMls1Token(string $rawJson): string
    {
        $b64Payload = self::base64UrlEncode($rawJson);
        $signature = hash_hmac('sha256', $rawJson, $this->hmacSecret, false);

        return sprintf('mls1.%s.%s', $b64Payload, $signature);
    }

    private function dbNowMysql(): string
    {
        $value = $this->db->get_var("SELECT DATE_FORMAT(NOW(3), '%Y-%m-%d %H:%i:%s')");
        if (is_string($value) && $value !== '') {
            return $value;
        }

        return gmdate('Y-m-d H:i:s');
    }

    private function nowMs(): int
    {
        return (int) floor(microtime(true) * 1000);
    }

    private function defaultExpirationMs(): int
    {
        return (int) apply_filters('sosprescription_jobs_default_expiration_ms', self::DEFAULT_EXPIRATION_MS);
    }

    private function generateJobId(): string
    {
        if (function_exists('wp_generate_uuid4')) {
            $uuid = (string) wp_generate_uuid4();
            if ($uuid !== '') {
                return $uuid;
            }
        }

        $hex = bin2hex($this->randomBytes(16));

        return sprintf(
            '%s-%s-4%s-%s%s-%s',
            substr($hex, 0, 8),
            substr($hex, 8, 4),
            substr($hex, 13, 3),
            dechex((hexdec($hex[16]) & 0x3) | 0x8),
            substr($hex, 17, 3),
            substr($hex, 20, 12)
        );
    }

    private function generateUrlSafeRandom(int $bytesLength): string
    {
        return self::base64UrlEncode($this->randomBytes(max(8, $bytesLength)));
    }

    private function randomBytes(int $length): string
    {
        try {
            return random_bytes($length);
        } catch (\Throwable) {
            $fallback = '';
            while (strlen($fallback) < $length) {
                $fallback .= hash('sha256', (string) wp_rand() . microtime(true), true);
            }
            return substr($fallback, 0, $length);
        }
    }

    private static function base64UrlEncode(string $bytes): string
    {
        return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
    }

    private function isRetryableInsertCollision(string $lastError): bool
    {
        if ($lastError === '') {
            return false;
        }

        $haystack = strtolower($lastError);

        return str_contains($haystack, 'duplicate')
            || str_contains($haystack, 'uq_site_nonce')
            || str_contains($haystack, 'uq_site_type_payloadhash')
            || str_contains($haystack, 'job_id');
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
            if (checkdate($month, $day, $year)) {
                return sprintf('%04d-%02d-%02d', $year, $month, $day);
            }
            return '';
        }

        if (preg_match('/^(\d{2})[\/\-.](\d{2})[\/\-.](\d{4})$/', $raw, $m)) {
            $day = (int) $m[1];
            $month = (int) $m[2];
            $year = (int) $m[3];
            if (checkdate($month, $day, $year)) {
                return sprintf('%04d-%02d-%02d', $year, $month, $day);
            }
            return '';
        }

        if (preg_match('/^(\d{4})[\/\-.](\d{2})[\/\-.](\d{2})$/', $raw, $m)) {
            $year = (int) $m[1];
            $month = (int) $m[2];
            $day = (int) $m[3];
            if (checkdate($month, $day, $year)) {
                return sprintf('%04d-%02d-%02d', $year, $month, $day);
            }
        }

        return '';
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

    private static function normalizeIngressPath(string $path): string
    {
        $path = trim($path);
        if ($path === '') {
            return self::DEFAULT_INGEST_PATH;
        }

        return '/' . ltrim($path, '/');
    }
}
