<?php
declare(strict_types=1);

namespace SosPrescription\Rest;

use SOSPrescription\Core\NdjsonLogger;
use SOSPrescription\Core\ReqId;
use SosPrescription\Services\Logger;
use Throwable;
use WP_Error;
use WP_REST_Request;
use WP_REST_Response;

defined('ABSPATH') || exit;

final class ErrorResponder
{
    private const ROUTE_PREFIXES = [
        '/sosprescription/v1/',
        '/sosprescription/v3/',
        '/sosprescription/v4/',
    ];

    private static ?NdjsonLogger $logger = null;
    private static bool $hooks_registered = false;

    public static function register_hooks(): void
    {
        if (self::$hooks_registered) {
            return;
        }

        self::$hooks_registered = true;

        add_filter('rest_request_after_callbacks', [self::class, 'normalize_rest_response'], 99, 3);
    }

    /**
     * @param mixed $response
     * @param mixed $handler
     * @return mixed
     */
    public static function normalize_rest_response($response, $handler, $request)
    {
        if (!$request instanceof WP_REST_Request) {
            return $response;
        }

        if (!self::is_sosprescription_route((string) $request->get_route())) {
            return $response;
        }

        if (is_wp_error($response)) {
            return self::to_rest_response($response);
        }

        if ($response instanceof WP_REST_Response) {
            $status = (int) $response->get_status();
            if ($status < 400) {
                return $response;
            }

            $data = $response->get_data();
            if (!is_array($data) || !isset($data['code'])) {
                return $response;
            }

            $normalized = self::normalize_error_array($data, $status);
            $normalizedResponse = new WP_REST_Response($normalized, $status);
            foreach ($response->get_headers() as $header => $value) {
                $normalizedResponse->header((string) $header, (string) $value);
            }

            return $normalizedResponse;
        }

        return $response;
    }

    public static function internal_error(
        Throwable $error,
        string $code,
        string $message,
        int $status,
        string $reqId,
        array $context = [],
        ?string $event = null
    ): WP_Error {
        $context = array_merge(
            [
                'public_code' => $code,
                'public_status' => $status,
            ],
            $context
        );

        self::logger()->error($event ?: 'rest.internal_error', $context, $reqId, $error);

        return new WP_Error(
            $code,
            $message,
            [
                'status' => $status,
                'req_id' => $reqId,
            ]
        );
    }

    public static function worker_bridge_error(
        Throwable $error,
        string $fallbackCode,
        string $fallbackMessage,
        int $fallbackStatus,
        string $reqId,
        array $context = [],
        ?string $event = null
    ): WP_Error {
        $mapped = self::map_worker_throwable($error, $fallbackCode, $fallbackMessage, $fallbackStatus);

        $context = array_merge(
            [
                'public_code' => $mapped['code'],
                'public_status' => $mapped['status'],
                'exception_class' => get_class($error),
                'exception_message' => trim($error->getMessage()),
            ],
            $context
        );

        if ($mapped['worker_http_status'] !== null) {
            $context['worker_http_status'] = $mapped['worker_http_status'];
        }
        if ($mapped['worker_code'] !== null) {
            $context['worker_code'] = $mapped['worker_code'];
        }

        self::logger()->error($event ?: 'rest.worker_bridge_error', $context, $reqId, $error);

        $errorData = [
            'status' => $mapped['status'],
            'req_id' => $reqId,
            'error_data' => [
                'bridge_exception' => trim($error->getMessage()),
            ],
        ];
        if ($mapped['worker_http_status'] !== null) {
            $errorData['error_data']['worker_http_status'] = $mapped['worker_http_status'];
        }
        if ($mapped['worker_code'] !== null) {
            $errorData['error_data']['worker_code'] = $mapped['worker_code'];
        }

        return new WP_Error(
            $mapped['code'],
            $mapped['message'],
            $errorData
        );
    }

    public static function wp_error(
        WP_Error $error,
        string $code,
        string $message,
        int $status,
        string $reqId,
        array $context = [],
        ?string $event = null
    ): WP_Error {
        $context = array_merge(
            [
                'public_code' => $code,
                'public_status' => $status,
                'wp_error_code' => (string) $error->get_error_code(),
                'wp_error_message' => (string) $error->get_error_message(),
                'wp_error_data' => $error->get_error_data(),
            ],
            $context
        );

        self::logger()->error($event ?: 'rest.wp_error', $context, $reqId);

        return new WP_Error(
            $code,
            $message,
            [
                'status' => $status,
                'req_id' => $reqId,
            ]
        );
    }

    private static function to_rest_response(WP_Error $error): WP_REST_Response
    {
        $status = self::extract_status($error->get_error_data());
        $code = (string) $error->get_error_code();
        $message = (string) $error->get_error_message();
        $normalized = self::normalize_error_array(
            [
                'code' => $code,
                'message' => $message,
                'req_id' => self::extract_req_id($error->get_error_data()),
                'retry_after' => self::extract_retry_after($error->get_error_data()),
                'error_data' => self::extract_error_data($error->get_error_data()),
            ],
            $status
        );

        return new WP_REST_Response($normalized, $status);
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    private static function normalize_error_array(array $payload, int $status): array
    {
        $code = isset($payload['code']) && is_scalar($payload['code']) ? trim((string) $payload['code']) : 'sosprescription_internal_error';
        if ($code === '') {
            $code = 'sosprescription_internal_error';
        }

        $message = isset($payload['message']) && is_scalar($payload['message']) ? trim((string) $payload['message']) : '';
        $reqId = isset($payload['req_id']) && is_scalar($payload['req_id'])
            ? trim((string) $payload['req_id'])
            : Logger::get_request_id();
        $reqId = ReqId::coalesce($reqId !== '' ? $reqId : null);

        $body = [
            'ok' => false,
            'code' => $code,
            'message' => self::normalize_public_message($code, $message, $status),
            'req_id' => $reqId,
        ];

        $retryAfter = isset($payload['retry_after']) ? self::extract_retry_after($payload) : null;
        if ($retryAfter !== null) {
            $body['retry_after'] = $retryAfter;
        }

        $errorData = isset($payload['error_data']) ? self::extract_error_data($payload) : [];
        if ($errorData !== []) {
            $body['error_data'] = $errorData;
        }

        return $body;
    }

    private static function normalize_public_message(string $code, string $message, int $status): string
    {
        $direct = self::mapped_public_message($code, $status);
        if ($direct !== null) {
            return $direct;
        }

        if (self::is_worker_code($code)) {
            return self::worker_public_message($code, $status, $message);
        }

        $trimmed = trim($message);
        if ($trimmed !== '' && $status < 500 && !self::looks_internal_message($trimmed)) {
            return $trimmed;
        }

        return self::generic_public_message($code, $status);
    }

    private static function mapped_public_message(string $code, int $status): ?string
    {
        return match ($code) {
            'sosprescription_rest_auth_required', 'sosprescription_auth_required' => 'Connexion requise.',
            'sosprescription_rest_bad_nonce' => 'Session invalide. Merci de recharger la page.',
            'sosprescription_rest_forbidden', 'sosprescription_forbidden' => 'Accès refusé.',
            'sosprescription_rate_limited' => 'Trop de requêtes. Veuillez réessayer plus tard.',
            'sosprescription_bad_id' => 'Identifiant invalide.',
            'sosprescription_not_found', 'sosprescription_prescription_not_found' => 'Ordonnance introuvable.',
            'sosprescription_worker_reference_missing' => 'Référence du dossier sécurisé introuvable.',
            'sosprescription_worker_ingest_failed' => 'Le service sécurisé est temporairement indisponible.',
            'sosprescription_worker_transition_failed' => 'La mise à jour du dossier a échoué. Réessayez ultérieurement.',
            'sosprescription_artifact_init_failed' => 'La préparation du document sécurisé a échoué.',
            'sosprescription_artifact_access_failed' => 'Le document sécurisé est temporairement indisponible.',
            'sosprescription_artifact_analyze_failed' => 'L’analyse du document est temporairement indisponible.',
            'sosprescription_messages_query_failed', 'sosprescription_messages_create_failed', 'sosprescription_messages_read_failed' => 'Le service de messagerie est temporairement indisponible.',
            'sosprescription_patient_profile_update_failed' => 'Le profil n’a pas pu être enregistré.',
            'sosprescription_pdf_dispatch_failed' => 'La génération du document est temporairement indisponible.',
            default => $status === 401 ? 'Connexion requise.' : null,
        };
    }

    private static function generic_public_message(string $code, int $status): string
    {
        $normalized = strtolower($code);

        if ($status === 401) {
            return 'Connexion requise.';
        }
        if ($status === 403) {
            return 'Accès refusé.';
        }
        if ($status === 404) {
            return 'Ressource introuvable.';
        }
        if ($status === 409) {
            return 'Conflit d’état. Merci de recharger la page.';
        }
        if ($status === 429) {
            return 'Trop de requêtes. Veuillez réessayer plus tard.';
        }

        if (str_contains($normalized, 'artifact') || str_contains($normalized, 'file')) {
            return $status >= 500
                ? 'Le service de documents sécurisés est temporairement indisponible.'
                : 'La requête sur le document est invalide.';
        }

        if (str_contains($normalized, 'message')) {
            return $status >= 500
                ? 'Le service de messagerie est temporairement indisponible.'
                : 'La requête de messagerie est invalide.';
        }

        if (str_contains($normalized, 'patient') || str_contains($normalized, 'profile')) {
            return $status >= 500
                ? 'Le profil n’a pas pu être enregistré.'
                : 'Les informations du profil sont invalides.';
        }

        if (str_contains($normalized, 'pdf')) {
            return 'La génération du document est temporairement indisponible.';
        }

        if (str_contains($normalized, 'worker') || str_contains($normalized, 'ingest') || str_contains($normalized, 'prescription')) {
            return $status >= 500
                ? 'Le service sécurisé est temporairement indisponible.'
                : 'La requête n’a pas pu être traitée.';
        }

        return $status >= 500
            ? 'Une erreur interne est survenue. Réessayez ultérieurement.'
            : 'La requête n’a pas pu être traitée.';
    }

    private static function worker_public_message(string $code, int $status, string $fallbackMessage): string
    {
        return match ($code) {
            'ML_AUTH_MISSING', 'ML_AUTH_INVALID_SIG', 'ML_AUTH_BAD_PAYLOAD', 'ML_AUTH_BODY_MISMATCH', 'ML_AUTH_SCOPE_DENIED', 'ML_AUTH_EXPIRED', 'ML_AUTH_REPLAY' => 'La requête sécurisée n’a pas pu être vérifiée.',
            'ML_INGEST_DISABLED' => 'Le service sécurisé est temporairement indisponible.',
            'ML_INGEST_BAD_JSON', 'ML_INGEST_BAD_REQUEST' => 'La requête transmise au service sécurisé est invalide.',
            'ML_SUBMISSION_BAD_JSON' => 'La requête de soumission sécurisée est invalide.',
            'ML_SUBMISSION_BAD_REQUEST' => 'La demande de soumission sécurisée est invalide.',
            'ML_SUBMISSION_NOT_FOUND' => 'Soumission sécurisée introuvable.',
            'ML_SUBMISSION_EXPIRED' => 'Cette soumission sécurisée a expiré. Merci de recommencer.',
            'ML_SUBMISSION_NOT_OPEN' => 'Cette soumission sécurisée ne peut plus être finalisée.',
            'ML_SUBMISSION_CREATE_FAILED' => 'La préparation de la soumission sécurisée a échoué.',
            'ML_SUBMISSION_FINALIZE_FAILED' => 'La création du dossier sécurisé a échoué. Merci de réessayer.',
            'ML_BODY_TOO_LARGE' => 'La requête dépasse la taille maximale autorisée.',
            'ML_BODY_ABORTED', 'ML_BODY_READ_FAILED' => 'La requête n’a pas pu être lue correctement.',
            'ML_ARTIFACT_BAD_REQUEST', 'ML_ARTIFACT_TICKET_MISSING' => 'La demande de document est invalide.',
            'ML_ARTIFACT_NOT_FOUND' => 'Document introuvable.',
            'ML_ARTIFACT_NOT_READY' => 'Le document n’est pas encore disponible.',
            'ML_ARTIFACT_TOO_LARGE' => 'Le fichier dépasse la taille maximale autorisée.',
            'ML_ARTIFACT_SIZE_MISMATCH', 'ML_ARTIFACT_CONTENT_TYPE_MISMATCH' => 'Le fichier transmis est invalide.',
            'ML_ARTIFACT_INIT_FAILED' => 'La préparation du document sécurisé a échoué.',
            'ML_ARTIFACT_UPLOAD_FAILED' => 'Le téléversement du document a échoué.',
            'ML_ARTIFACT_ACCESS_FAILED' => 'Le document sécurisé est temporairement indisponible.',
            'ML_MESSAGE_BAD_REQUEST' => 'La requête de messagerie est invalide.',
            'ML_MESSAGES_FAILED' => 'Le service de messagerie est temporairement indisponible.',
            'ML_APPROVE_FAILED' => 'La validation du dossier a échoué. Réessayez ultérieurement.',
            'ML_REJECT_FAILED' => 'La mise à jour du dossier a échoué. Réessayez ultérieurement.',
            'ML_AI_DISABLED' => 'L’analyse automatique du document est temporairement indisponible.',
            'ML_AI_TIMEOUT' => 'L’analyse automatique du document a expiré. Merci de réessayer.',
            'ML_AI_UNSUPPORTED_MIME' => 'Ce type de document n’est pas pris en charge pour l’analyse automatique.',
            'ML_AI_UPSTREAM_FAILED', 'ML_AI_FAILED' => 'L’analyse automatique du document a échoué. Merci de réessayer.',
            'ML_AI_S3_READ_FAILED' => 'Le document n’a pas pu être relu pour l’analyse automatique. Merci de le réimporter.',
            'CORS_FORBIDDEN' => 'Origine de requête non autorisée.',
            default => $status >= 500
                ? 'Le service sécurisé est temporairement indisponible.'
                : ($fallbackMessage !== '' && !self::looks_internal_message($fallbackMessage)
                    ? $fallbackMessage
                    : 'La requête n’a pas pu être traitée.'),
        };
    }

    /**
     * @return array{status:int,code:string,message:string,worker_code:?string,worker_http_status:?int}
     */
    private static function map_worker_throwable(
        Throwable $error,
        string $fallbackCode,
        string $fallbackMessage,
        int $fallbackStatus
    ): array {
        $message = trim($error->getMessage());

        if (preg_match('/^Worker HTTP\s+(\d{3})\s*:\s*(.*?)\s*\(([A-Z0-9_]+)\)$/u', $message, $matches)) {
            $status = max(400, min(599, (int) $matches[1]));
            $workerCode = trim((string) $matches[3]);

            return [
                'status' => $status,
                'code' => $workerCode !== '' ? $workerCode : $fallbackCode,
                'message' => self::worker_public_message($workerCode !== '' ? $workerCode : $fallbackCode, $status, $fallbackMessage),
                'worker_code' => $workerCode !== '' ? $workerCode : null,
                'worker_http_status' => $status,
            ];
        }

        if (stripos($message, 'Requête bloquée par WordPress') !== false) {
            return [
                'status' => 502,
                'code' => $fallbackCode,
                'message' => $fallbackMessage,
                'worker_code' => null,
                'worker_http_status' => null,
            ];
        }

        if (stripos($message, 'Invalid Worker response signature') !== false || stripos($message, 'Invalid Worker JSON response') !== false) {
            return [
                'status' => 502,
                'code' => $fallbackCode,
                'message' => 'Le service sécurisé a renvoyé une réponse invalide.',
                'worker_code' => null,
                'worker_http_status' => null,
            ];
        }

        return [
            'status' => $fallbackStatus,
            'code' => $fallbackCode,
            'message' => $fallbackMessage,
            'worker_code' => null,
            'worker_http_status' => null,
        ];
    }

    private static function extract_status(mixed $data): int
    {
        if (is_array($data) && isset($data['status']) && is_numeric($data['status'])) {
            $status = (int) $data['status'];
            if ($status >= 100 && $status <= 599) {
                return $status;
            }
        }

        return 500;
    }

    /**
     * @return array<string, mixed>
     */
    private static function extract_error_data(mixed $data): array
    {
        if (!is_array($data) || !isset($data['error_data']) || !is_array($data['error_data'])) {
            return [];
        }

        $out = [];
        foreach ($data['error_data'] as $key => $value) {
            if (!is_string($key) || $key === '') {
                continue;
            }
            if (is_scalar($value) || $value === null) {
                $out[$key] = $value;
            }
        }

        return $out;
    }

    private static function extract_req_id(mixed $data): string
    {
        if (is_array($data) && isset($data['req_id']) && is_scalar($data['req_id'])) {
            return ReqId::coalesce((string) $data['req_id']);
        }

        $current = Logger::get_request_id();
        return ReqId::coalesce($current !== '' ? $current : null);
    }

    private static function extract_retry_after(mixed $data): ?int
    {
        if (is_array($data) && isset($data['retry_after']) && is_numeric($data['retry_after'])) {
            $retryAfter = (int) $data['retry_after'];
            return $retryAfter > 0 ? $retryAfter : null;
        }

        return null;
    }

    private static function looks_internal_message(string $message): bool
    {
        $normalized = strtolower(trim($message));
        if ($normalized === '') {
            return false;
        }

        $needles = [
            'détail :',
            'detail :',
            'worker http',
            'requête bloquée par wordpress',
            'invalid worker',
            'stack trace',
            'traceback',
            'exception',
            'sqlstate',
            'select ',
            'insert ',
            'update ',
            'delete ',
            'fatal error',
            'uncaught',
            'call to',
            'undefined ',
            ' in /',
            ' at /',
        ];

        foreach ($needles as $needle) {
            if (str_contains($normalized, $needle)) {
                return true;
            }
        }

        return false;
    }

    private static function is_worker_code(string $code): bool
    {
        return str_starts_with($code, 'ML_') || $code === 'CORS_FORBIDDEN';
    }

    private static function is_sosprescription_route(string $route): bool
    {
        if ($route === '') {
            return false;
        }

        foreach (self::ROUTE_PREFIXES as $prefix) {
            if (str_starts_with($route, $prefix)) {
                return true;
            }
        }

        return false;
    }

    private static function logger(): NdjsonLogger
    {
        if (self::$logger instanceof NdjsonLogger) {
            return self::$logger;
        }

        $siteId = getenv('ML_SITE_ID');
        if (!is_string($siteId) || trim($siteId) === '') {
            $siteId = (string) (home_url('/') ?: 'unknown_site');
        }

        $env = getenv('SOSPRESCRIPTION_ENV');
        if (!is_string($env) || trim($env) === '') {
            $env = 'prod';
        }

        self::$logger = new NdjsonLogger('web', trim((string) $siteId), trim((string) $env));

        return self::$logger;
    }
}
