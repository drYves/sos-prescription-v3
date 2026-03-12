<?php
declare(strict_types=1);

namespace SOSPrescription;

defined('ABSPATH') || exit;

final class Autoloader
{
    private const NAMESPACE_PREFIX = __NAMESPACE__ . '\\';
    private const FILE_EXTENSION   = '.php';

    /** @var bool */
    private static $registered = false;

    /** @var string */
    private static $baseDir = '';

    private function __construct()
    {
    }

    /**
     * Enregistre l'autoloader PSR-4 du plugin.
     *
     * Namespace racine : SOSPrescription\
     * Répertoire racine : includes/
     *
     * Exemple :
     * SOSPrescription\Repositories\JobRepository
     * => includes/Repositories/JobRepository.php
     *
     * @param string|null $baseDir
     * @return void
     */
    public static function register($baseDir = null): void
    {
        if (self::$registered === true) {
            return;
        }

        self::$baseDir = self::normalizeDirectory($baseDir !== null ? (string) $baseDir : __DIR__);

        spl_autoload_register(array(self::class, 'autoload'), true, true);

        self::$registered = true;
    }

    /**
     * Callback d'autoload PSR-4.
     *
     * @param string $class
     * @return void
     */
    public static function autoload(string $class): void
    {
        $class = ltrim($class, '\\');

        if ($class === '') {
            return;
        }

        if (strpos($class, self::NAMESPACE_PREFIX) !== 0) {
            return;
        }

        $file = self::resolveFilePath($class);

        if ($file === null) {
            return;
        }

        require_once $file;
    }

    /**
     * Résout le chemin absolu d'une classe vers son fichier PHP.
     *
     * @param string $class
     * @return string|null
     */
    private static function resolveFilePath(string $class): ?string
    {
        $prefixLength = strlen(self::NAMESPACE_PREFIX);
        $relativeClass = substr($class, $prefixLength);

        if ($relativeClass === false || $relativeClass === '') {
            return null;
        }

        if (
            strpos($relativeClass, '..') !== false ||
            strpos($relativeClass, "\0") !== false
        ) {
            return null;
        }

        $relativePath = str_replace('\\', DIRECTORY_SEPARATOR, $relativeClass) . self::FILE_EXTENSION;
        $absolutePath = self::normalizePath(self::$baseDir . DIRECTORY_SEPARATOR . $relativePath);

        if (!is_file($absolutePath) || !is_readable($absolutePath)) {
            return null;
        }

        return $absolutePath;
    }

    /**
     * Normalise un répertoire de base.
     *
     * @param string $directory
     * @return string
     */
    private static function normalizeDirectory(string $directory): string
    {
        $directory = self::normalizePath($directory);

        return rtrim($directory, DIRECTORY_SEPARATOR);
    }

    /**
     * Normalise les séparateurs de chemin pour compatibilité multi-OS.
     *
     * @param string $path
     * @return string
     */
    private static function normalizePath(string $path): string
    {
        if ($path === '') {
            return '';
        }

        $normalized = str_replace(array('/', '\\'), DIRECTORY_SEPARATOR, $path);
        $doubleSeparator = DIRECTORY_SEPARATOR . DIRECTORY_SEPARATOR;

        while (strpos($normalized, $doubleSeparator) !== false) {
            $normalized = str_replace($doubleSeparator, DIRECTORY_SEPARATOR, $normalized);
        }

        return $normalized;
    }
}
