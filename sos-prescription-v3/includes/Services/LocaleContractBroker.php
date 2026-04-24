<?php
declare(strict_types=1);

namespace SosPrescription\Services;

use SOSPrescription\Assets\Assets as AssetManager;

/**
 * Broker minimal du contrat de locale pour le POC multilingue.
 *
 * Itération 1 : résolution serveur bornée, sans switch, sans persistance,
 * sans détection navigateur et sans catalogue de traductions.
 */
final class LocaleContractBroker
{
    private const CONTRACT_VERSION = 1;
    private const DEFAULT_LOCALE = 'fr-FR';

    /**
     * @var string[]
     */
    private const SUPPORTED_LOCALES = ['fr-FR', 'en-GB'];

    private const FALLBACK_SLUG = 'poc-multilingue-fallback';

    /**
     * @var array<string, array{kind:string}>
     */
    private const POC_SURFACES = [
        'securite-confidentialite' => ['kind' => 'wordpress_host'],
        'catalogue-medicaments' => ['kind' => 'public_separate_route'],
        self::FALLBACK_SLUG => ['kind' => 'fallback_no_sister'],
    ];

    public static function register_hooks(): void
    {
        add_action('wp_enqueue_scripts', [self::class, 'maybe_request_runtime_config'], 1);
    }

    public static function maybe_request_runtime_config(): void
    {
        $surface = self::current_surface();
        if (! $surface['isPocSurface']) {
            return;
        }

        // La surface BDPM reçoit déjà sa configuration via le chemin legacy Assets.php.
        // On évite ici une double impression du même objet global.
        if ($surface['slug'] === 'catalogue-medicaments') {
            return;
        }

        if (class_exists(AssetManager::class)) {
            AssetManager::ensure_global_runtime_config();
        }
    }

    /**
     * @return array<string, mixed>|null
     */
    public static function runtime_contract(): ?array
    {
        $surface = self::current_surface();
        if (! $surface['isPocSurface']) {
            return null;
        }

        return self::build_contract($surface);
    }

    /**
     * @param array{slug:string,kind:string,isPocSurface:bool} $surface
     * @return array<string, mixed>
     */
    private static function build_contract(array $surface): array
    {
        $resolution = self::resolve_locale();

        return [
            'activeLocale' => $resolution['locale'],
            'defaultLocale' => self::DEFAULT_LOCALE,
            'supportedLocales' => self::SUPPORTED_LOCALES,
            'resolutionSource' => $resolution['source'],
            'surface' => [
                'slug' => $surface['slug'],
                'kind' => $surface['kind'],
                'isPocSurface' => $surface['isPocSurface'],
            ],
            'fallback' => [
                'hasSister' => false,
                'fallbackSlug' => self::FALLBACK_SLUG,
                'reason' => $surface['slug'] === self::FALLBACK_SLUG ? 'fallback_surface' : null,
            ],
            'alternatives' => [],
            'diagnostics' => [
                'isPoc' => true,
                'contractVersion' => self::CONTRACT_VERSION,
                'resolutionSource' => $resolution['source'],
                'pocSurfaceSlugs' => array_keys(self::POC_SURFACES),
            ],
        ];
    }

    /**
     * @return array{locale:string,source:string}
     */
    private static function resolve_locale(): array
    {
        $queryLocale = self::query_locale();
        if ($queryLocale !== null) {
            return [
                'locale' => $queryLocale,
                'source' => 'query_param',
            ];
        }

        return [
            'locale' => self::DEFAULT_LOCALE,
            'source' => 'default',
        ];
    }

    private static function query_locale(): ?string
    {
        $raw = null;
        if (isset($_GET['locale']) && is_scalar($_GET['locale'])) {
            $raw = (string) wp_unslash((string) $_GET['locale']);
        } elseif (isset($_GET['lang']) && is_scalar($_GET['lang'])) {
            $raw = (string) wp_unslash((string) $_GET['lang']);
        }

        if ($raw === null) {
            return null;
        }

        $candidate = trim($raw);
        if ($candidate === '') {
            return null;
        }

        $normalized = str_replace('_', '-', $candidate);
        $lower = strtolower($normalized);

        $aliases = [
            'fr' => 'fr-FR',
            'fr-fr' => 'fr-FR',
            'en' => 'en-GB',
            'en-gb' => 'en-GB',
        ];

        return $aliases[$lower] ?? null;
    }

    /**
     * @return array{slug:string,kind:string,isPocSurface:bool}
     */
    private static function current_surface(): array
    {
        $slug = self::current_slug();
        if ($slug !== '' && isset(self::POC_SURFACES[$slug])) {
            return [
                'slug' => $slug,
                'kind' => self::POC_SURFACES[$slug]['kind'],
                'isPocSurface' => true,
            ];
        }

        return [
            'slug' => $slug,
            'kind' => 'unknown',
            'isPocSurface' => false,
        ];
    }

    private static function current_slug(): string
    {
        $post = get_post();
        if ($post instanceof \WP_Post && isset($post->post_name)) {
            $postName = sanitize_title((string) $post->post_name);
            if ($postName !== '') {
                return $postName;
            }
        }

        $path = self::request_path();
        if ($path === '') {
            return '';
        }

        $segments = array_values(array_filter(explode('/', $path), static fn (string $segment): bool => $segment !== ''));
        if ($segments === []) {
            return '';
        }

        return sanitize_title((string) end($segments));
    }

    private static function request_path(): string
    {
        $requestUri = isset($_SERVER['REQUEST_URI']) && is_scalar($_SERVER['REQUEST_URI'])
            ? (string) $_SERVER['REQUEST_URI']
            : '';

        if ($requestUri === '') {
            return '';
        }

        $path = (string) parse_url($requestUri, PHP_URL_PATH);
        return trim($path, '/');
    }
}
