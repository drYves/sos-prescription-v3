<?php
declare(strict_types=1);

namespace SOSPrescription;

defined('ABSPATH') || exit;

final class Autoloader
{
    private const ROOT_NAMESPACE = 'SOSPrescription';

    private static bool $registered = false;

    private static string $baseDir = '';

    /** @var array<string, string> */
    private static array $resolvedPaths = [];

    private function __construct()
    {
    }

    public static function register(?string $baseDir = null): void
    {
        if (self::$registered) {
            return;
        }

        $dir = $baseDir !== null && $baseDir !== '' ? $baseDir : __DIR__;
        self::$baseDir = rtrim(self::normalizePath($dir), DIRECTORY_SEPARATOR);

        spl_autoload_register([self::class, 'autoload'], true, true);
        self::$registered = true;
    }

    public static function autoload(string $class): void
    {
        $class = ltrim($class, '\\');
        if ($class === '') {
            return;
        }

        $prefix = self::extractRootNamespace($class);
        if ($prefix === null || strcasecmp($prefix, self::ROOT_NAMESPACE) !== 0) {
            return;
        }

        $file = self::resolveFile($class);
        if ($file === null) {
            error_log('[SOSPrescription] Autoloader trying to load: ' . self::buildNominalPath($class));
            return;
        }

        error_log('[SOSPrescription] Autoloader trying to load: ' . $file);
        require_once $file;
    }

    private static function extractRootNamespace(string $class): ?string
    {
        $parts = explode('\\', $class, 2);

        return isset($parts[0]) && $parts[0] !== '' ? $parts[0] : null;
    }

    private static function resolveFile(string $class): ?string
    {
        if (isset(self::$resolvedPaths[$class])) {
            return self::$resolvedPaths[$class];
        }

        $relativeClass = self::stripRootNamespace($class);
        if ($relativeClass === null || $relativeClass === '') {
            return null;
        }

        $relativePath = str_replace('\\', DIRECTORY_SEPARATOR, $relativeClass) . '.php';
        $nominal = self::normalizePath(self::$baseDir . DIRECTORY_SEPARATOR . $relativePath);

        if (is_file($nominal)) {
            self::$resolvedPaths[$class] = $nominal;
            return $nominal;
        }

        $resolved = self::resolveCaseInsensitivePath(self::$baseDir, explode(DIRECTORY_SEPARATOR, $relativePath));
        if ($resolved !== null && is_file($resolved)) {
            self::$resolvedPaths[$class] = $resolved;
            return $resolved;
        }

        return null;
    }

    private static function stripRootNamespace(string $class): ?string
    {
        $prefix = self::extractRootNamespace($class);
        if ($prefix === null || $prefix === '') {
            return null;
        }

        $relative = substr($class, strlen($prefix));
        if (!is_string($relative)) {
            return null;
        }

        return ltrim($relative, '\\');
    }

    private static function buildNominalPath(string $class): string
    {
        $relativeClass = self::stripRootNamespace($class);
        if ($relativeClass === null || $relativeClass === '') {
            return self::$baseDir;
        }

        $relativePath = str_replace('\\', DIRECTORY_SEPARATOR, $relativeClass) . '.php';

        return self::normalizePath(self::$baseDir . DIRECTORY_SEPARATOR . $relativePath);
    }

    /**
     * @param array<int, string> $segments
     */
    private static function resolveCaseInsensitivePath(string $base, array $segments): ?string
    {
        $current = rtrim(self::normalizePath($base), DIRECTORY_SEPARATOR);
        if ($current === '' || !is_dir($current)) {
            return null;
        }

        foreach ($segments as $segment) {
            if ($segment === '') {
                continue;
            }

            $matched = self::findCaseInsensitiveMatch($current, $segment);
            if ($matched === null) {
                return null;
            }

            $current = $matched;
        }

        return self::normalizePath($current);
    }

    private static function findCaseInsensitiveMatch(string $directory, string $target): ?string
    {
        $candidate = self::normalizePath($directory . DIRECTORY_SEPARATOR . $target);
        if (file_exists($candidate)) {
            return $candidate;
        }

        $entries = @scandir($directory);
        if (!is_array($entries)) {
            return null;
        }

        foreach ($entries as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }

            if (strcasecmp($entry, $target) === 0) {
                return self::normalizePath($directory . DIRECTORY_SEPARATOR . $entry);
            }
        }

        return null;
    }

    private static function normalizePath(string $path): string
    {
        return str_replace(['/', '\\'], DIRECTORY_SEPARATOR, $path);
    }
}
