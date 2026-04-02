<?php
declare(strict_types=1);

namespace SosPrescription\Core;

use DateTimeImmutable;
use DateTimeZone;
use Throwable;

final class NdjsonLogger
{
    private string $service = 'sosprescription';
    private string $component;
    private string $env;
    private string $siteId;

    /** @var resource */
    private $stream;

    public function __construct(string $component, ?string $siteId = null, ?string $env = null, $stream = null)
    {
        $this->component = $component;
        $this->siteId = $siteId ?: (getenv('ML_SITE_ID') ?: 'unknown_site');
        $this->env = $env ?: (getenv('SOSPRESCRIPTION_ENV') ?: 'prod');
        $this->stream = $stream ?? self::defaultStream();
    }

    public function info(string $event, array $context = [], ?string $reqId = null): void
    {
        $this->log('info', $event, $context, $reqId);
    }

    public function warning(string $event, array $context = [], ?string $reqId = null, ?Throwable $e = null): void
    {
        $this->log('warning', $event, $context, $reqId, $e ? self::safeError($e) : null);
    }

    public function error(string $event, array $context = [], ?string $reqId = null, ?Throwable $e = null): void
    {
        $this->log('error', $event, $context, $reqId, $e ? self::safeError($e) : null);
    }

    public function critical(string $event, array $context = [], ?string $reqId = null, ?Throwable $e = null): void
    {
        $this->log('critical', $event, $context, $reqId, $e ? self::safeError($e) : null);
    }

    /**
     * @param array<string, mixed>|null $error
     */
    public function log(string $severity, string $event, array $context = [], ?string $reqId = null, ?array $error = null): void
    {
        $tsMs = (int) floor(microtime(true) * 1000);
        $record = [
            'ts'        => self::isoUtcWithMs($tsMs),
            'ts_ms'     => $tsMs,
            'severity'  => $severity,
            'component' => $this->component,
            'service'   => $this->service,
            'site_id'   => $this->siteId,
            'env'       => $this->env,
            'event'     => $event,
            'req_id'    => ReqId::coalesce($reqId),
            'mem'       => [
                'php_alloc_mb' => (int) round(memory_get_usage(true) / 1024 / 1024),
                'php_used_mb'  => (int) round(memory_get_usage(false) / 1024 / 1024),
            ],
            'context'   => self::sanitizeContext($context),
        ];

        if (is_array($error) && $error !== []) {
            $record['error'] = self::sanitizeError($error);
        }

        $line = json_encode($record, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if (!is_string($line) || $line === '') {
            $line = '{"ts_ms":' . $tsMs . ',"severity":"error","component":"' . $this->component . '","event":"logger.encode_failed"}';
        }

        fwrite($this->stream, $line . "\n");
    }

    /**
     * @return array<string, mixed>
     */
    public static function safeError(Throwable $e): array
    {
        return [
            'class'      => get_class($e),
            'code'       => is_scalar($e->getCode()) ? (string) $e->getCode() : 'EXCEPTION',
            'message'    => $e->getMessage(),
            'file'       => $e->getFile(),
            'line'       => $e->getLine(),
            'trace'      => $e->getTraceAsString(),
            'stack_hash' => 'sha256:' . hash('sha256', $e->getFile() . ':' . $e->getLine() . ':' . $e->getCode()),
        ];
    }

    /**
     * @param mixed $value
     * @return mixed
     */
    private static function sanitizeContext($value)
    {
        if (is_array($value)) {
            $out = [];
            foreach ($value as $k => $v) {
                $key = is_string($k) ? $k : (string) $k;
                if (self::shouldRedactKey($key)) {
                    $out[$key] = '[REDACTED]';
                    continue;
                }
                $out[$key] = self::sanitizeContext($v);
            }
            return $out;
        }

        if (is_string($value)) {
            return self::truncate(self::redactStringPatterns($value), 500);
        }

        if (is_int($value) || is_float($value) || is_bool($value) || $value === null) {
            return $value;
        }

        return '[UNSERIALIZABLE]';
    }

    /**
     * @param array<string, mixed> $error
     * @return array<string, mixed>
     */
    private static function sanitizeError(array $error): array
    {
        $out = [];
        foreach ($error as $key => $value) {
            $normalizedKey = is_string($key) ? $key : (string) $key;
            if (is_array($value)) {
                $out[$normalizedKey] = self::sanitizeError($value);
                continue;
            }

            if (is_string($value)) {
                $out[$normalizedKey] = self::redactStringPatterns($value);
                continue;
            }

            if (is_int($value) || is_float($value) || is_bool($value) || $value === null) {
                $out[$normalizedKey] = $value;
                continue;
            }

            $out[$normalizedKey] = '[UNSERIALIZABLE]';
        }

        return $out;
    }

    private static function shouldRedactKey(string $key): bool
    {
        $k = strtolower($key);
        $block = [
            'patient', 'patient_id', 'patient_ref', 'patient_ref_hash',
            'nom', 'prenom', 'name', 'firstname', 'lastname',
            'email', 'mail', 'phone', 'tel', 'mobile',
            'address', 'adresse', 'street', 'city', 'zip',
            'dob', 'birth', 'naissance',
            'ssn', 'nss',
            'rpps', 'finess',
            'token', 'authorization', 'cookie', 'set-cookie', 'session',
            'password', 'secret', 'apikey', 'api_key', 'access_key', 'secret_key',
            'hmac', 'signature',
            'ocr', 'ocr_text', 'raw_text', 'html', 'body'
        ];

        foreach ($block as $needle) {
            if ($k === $needle || str_contains($k, $needle)) {
                return true;
            }
        }

        return false;
    }

    private static function redactStringPatterns(string $s): string
    {
        $s = preg_replace('/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/i', '[EMAIL]', $s) ?? $s;
        $s = preg_replace('/\\b(?:\\+33|0)[1-9](?:[\\s.\\-]?\\d{2}){4}\\b/', '[PHONE]', $s) ?? $s;
        $s = preg_replace('/\\b[a-f0-9]{32,}\\b/i', '[HEX]', $s) ?? $s;
        return $s;
    }

    private static function truncate(string $s, int $maxLen): string
    {
        if (strlen($s) <= $maxLen) {
            return $s;
        }
        return substr($s, 0, $maxLen) . '…[truncated]';
    }

    private static function isoUtcWithMs(int $tsMs): string
    {
        $sec = (int) floor($tsMs / 1000);
        $ms  = $tsMs % 1000;
        $dt = (new DateTimeImmutable('@' . $sec))->setTimezone(new DateTimeZone('UTC'));
        return $dt->format('Y-m-d\\TH:i:s') . '.' . str_pad((string) $ms, 3, '0', STR_PAD_LEFT) . 'Z';
    }

    private static function defaultStream()
    {
        $preferred = getenv('SOSPRESCRIPTION_LOG_STREAM');
        if ($preferred === 'stdout') {
            return fopen('php://stdout', 'wb');
        }

        if (PHP_SAPI === 'cli') {
            return fopen('php://stdout', 'wb');
        }

        return fopen('php://stderr', 'wb');
    }
}
