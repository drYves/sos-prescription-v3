<?php
declare(strict_types=1);

namespace SosPrescription\Core;

final class NdjsonLogger
{
    private string $component;
    private string $siteId;
    private string $env;

    public function __construct(string $component, string $siteId, string $env)
    {
        $this->component = $component;
        $this->siteId = $siteId;
        $this->env = $env;
    }

    public function info(string $event, array $context = [], ?string $reqId = null): void
    {
        $this->log('INFO', $event, $context, $reqId);
    }

    public function warning(string $event, array $context = [], ?string $reqId = null): void
    {
        $this->log('WARN', $event, $context, $reqId);
    }

    public function error(string $event, array $context = [], ?string $reqId = null): void
    {
        $this->log('ERROR', $event, $context, $reqId);
    }

    private function log(string $level, string $event, array $context, ?string $reqId): void
    {
        $record = [
            'ts' => gmdate('c'),
            'level' => $level,
            'event' => $event,
            'component' => $this->component,
            'site_id' => $this->siteId,
            'env' => $this->env,
            'req_id' => ReqId::coalesce($reqId),
            'ctx' => $this->redact($context),
        ];

        $line = wp_json_encode($record, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if (is_string($line)) {
            error_log($line);
        }
    }

    private function redact(array $context): array
    {
        $redacted = [];
        foreach ($context as $key => $value) {
            $k = strtolower((string) $key);
            if (str_contains($k, 'secret') || str_contains($k, 'token') || str_contains($k, 'password') || str_contains($k, 'patient') || str_contains($k, 'email')) {
                $redacted[$key] = '[REDACTED]';
                continue;
            }
            $redacted[$key] = $value;
        }
        return $redacted;
    }
}
