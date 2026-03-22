<?php // includes/Core/ReqId.php
declare(strict_types=1);

namespace SOSPrescription\Core;

final class ReqId
{
    public static function new(): string
    {
        try {
            return 'req_' . bin2hex(random_bytes(8));
        } catch (\Throwable $e) {
            return 'req_' . md5((string) wp_rand() . microtime(true));
        }
    }

    public static function coalesce(?string $reqId = null): string
    {
        $reqId = is_string($reqId) ? trim($reqId) : '';

        return $reqId !== '' ? $reqId : self::new();
    }
}
