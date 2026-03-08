<?php
declare(strict_types=1);

namespace SosPrescription\Core;

final class MedLabConnector
{
    public static function mls1Token(string $rawPayload, string $hmacSecret): string
    {
        $payloadB64 = Base64Url::encode($rawPayload);
        $sigHex = hash_hmac('sha256', $rawPayload, $hmacSecret, false);
        return sprintf('mls1.%s.%s', $payloadB64, $sigHex);
    }
}
