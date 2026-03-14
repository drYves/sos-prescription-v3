<?php
declare(strict_types=1);

namespace SosPrescription;

final class Autoloader
{
    private const PREFIX = 'SosPrescription\\';

    public static function register(): void
    {
        spl_autoload_register([self::class, 'autoload'], true, true);
    }

    private static function autoload(string $class): void
    {
        if (strpos($class, self::PREFIX) !== 0) {
            return;
        }

        $rel = substr($class, strlen(self::PREFIX));
        $rel = str_replace('\\', '/', $rel);
        $path = SOSPRESCRIPTION_PATH . 'includes/' . $rel . '.php';

        if (is_file($path)) {
            require_once $path;
        }
    }
}
