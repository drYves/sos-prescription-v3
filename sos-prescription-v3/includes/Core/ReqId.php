<?php
declare(strict_types=1);

namespace SosPrescription\Core;

final class ReqId
{
    public static function new(): string
    {
        return Base64Url::encode(random_bytes(6));
    }

    public static function coalesce(?string $reqId): string
    {
        return (is_string($reqId) && $reqId !== '') ? $reqId : self::new();
    }
}
