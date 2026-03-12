<?php
namespace SOSPrescription\Services;

if (!defined('ABSPATH')) {
	exit;
}

/**
 * ThemeTrace
 *
 * Traceur "UI / Theme" (GeneratePress, child theme, layouts) pour diagnostiquer rapidement
 * les problèmes d'espace, de sidebar, de layout, etc.
 *
 * Les logs sont écrits dans un fichier dédié (scope = gp_theme), au format NDJSON :
 *   wp-content/uploads/sosprescription-logs/runtime-gp_theme-YYYY-MM-DD.log
 *
 * ⚠️ Par sécurité, on masque les tokens (/v/{token}) dans l'URI.
 */
class ThemeTrace
{
	private const SCOPE = 'gp_theme';

	private static bool $did_request = false;
	private static bool $did_body_class = false;
	private static bool $did_sidebar_layout = false;

	public static function register(): void
	{
		// Trace côté front (pas besoin en wp-admin). On garde quand même les hooks :
		// chaque callback fait ses propres garde-fous (enabled()).
		add_action('wp', [__CLASS__, 'trace_request'], 1);
		add_filter('generate_sidebar_layout', [__CLASS__, 'trace_generate_sidebar_layout'], 9999, 1);
		add_filter('body_class', [__CLASS__, 'trace_body_class'], 9999, 1);
	}

	private static function enabled(): bool
	{
		// On n'exécute rien si le système de logs est désactivé, ou si le scope n'est pas activé.
		return Logger::enabled() && Logger::scope_enabled(self::SCOPE, 'runtime');
	}

	/**
	 * Log "contexte de requête" (1 seule fois par requête).
	 */
	public static function trace_request(): void
	{
		if (self::$did_request || !self::enabled()) {
			return;
		}
		self::$did_request = true;

		global $post;

		$post_id = is_object($post) ? (int) $post->ID : 0;
		$slug = (is_object($post) && isset($post->post_name)) ? (string) $post->post_name : '';
		$page_template = $post_id ? (string) get_page_template_slug($post_id) : '';

		// Détection côté thème (si la fonction est disponible).
		$is_app_request = null;
		if (function_exists('sp_ds_is_app_request')) {
			try {
				$is_app_request = (bool) call_user_func('sp_ds_is_app_request');
			} catch (\Throwable $e) {
				$is_app_request = null;
			}
		}

		$payload = [
			'request' => [
				'method' => isset($_SERVER['REQUEST_METHOD']) ? (string) $_SERVER['REQUEST_METHOD'] : '',
				'uri'    => self::mask_uri(isset($_SERVER['REQUEST_URI']) ? (string) $_SERVER['REQUEST_URI'] : ''),
			],
			'theme' => [
				'stylesheet' => function_exists('get_stylesheet') ? (string) get_stylesheet() : '',
				'template'   => function_exists('get_template') ? (string) get_template() : '',
			],
			'wp' => [
				'is_admin'          => function_exists('is_admin') ? (bool) is_admin() : null,
				'is_user_logged_in' => function_exists('is_user_logged_in') ? (bool) is_user_logged_in() : null,
				'queried_object_id' => function_exists('get_queried_object_id') ? (int) get_queried_object_id() : null,
			],
			'post' => [
				'id'            => $post_id,
				'type'          => $post_id && function_exists('get_post_type') ? (string) get_post_type($post_id) : '',
				'slug'          => $slug,
				'page_template' => $page_template,
			],
			'app' => [
				'sp_ds_is_app_request' => $is_app_request,
				'is_verify_request'    => self::is_verify_request(),
				'app_sidebar_active'   => function_exists('is_active_sidebar') ? (bool) is_active_sidebar('sp_app_sidebar') : null,
			],
		];

		Logger::ndjson_scoped('runtime', self::SCOPE, 'info', 'request', $payload);
	}

	/**
	 * Log du layout sidebar GeneratePress (1 seule fois par requête).
	 *
	 * Cette info est critique pour comprendre pourquoi "Disposition de la colonne latérale"
	 * n'a pas d'effet (override par filter) ou pourquoi la sidebar n'apparaît pas.
	 *
	 * @param string $layout
	 * @return string
	 */
	public static function trace_generate_sidebar_layout($layout)
	{
		if (!self::enabled()) {
			return $layout;
		}

		// Defensive: GeneratePress should pass a string, but on reste safe.
		if (!is_string($layout)) {
			$layout = (string) $layout;
		}

		// mPDF/Plugin : éviter un spam de lignes si GP appelle le filtre plusieurs fois.
		if (!self::$did_sidebar_layout) {
			self::$did_sidebar_layout = true;

			$is_app_request = null;
			if (function_exists('sp_ds_is_app_request')) {
				try {
					$is_app_request = (bool) call_user_func('sp_ds_is_app_request');
				} catch (\Throwable $e) {
					$is_app_request = null;
				}
			}

			$payload = [
				'layout' => $layout,
				'request_uri' => self::mask_uri(isset($_SERVER['REQUEST_URI']) ? (string) $_SERVER['REQUEST_URI'] : ''),
				'queried_object_id' => function_exists('get_queried_object_id') ? (int) get_queried_object_id() : null,
				'sp_ds_is_app_request' => $is_app_request,
			];

			Logger::ndjson_scoped('runtime', self::SCOPE, 'debug', 'generate_sidebar_layout', $payload);
		}

		return $layout;
	}

	/**
	 * Log d'un échantillon des body classes (1 seule fois par requête).
	 *
	 * Utile pour vérifier que le thème a bien ajouté `sp-app` / `sp-verify`.
	 *
	 * @param array $classes
	 * @return array
	 */
	public static function trace_body_class(array $classes): array
	{
		if (self::$did_body_class || !self::enabled()) {
			return $classes;
		}
		self::$did_body_class = true;

		$payload = [
			'contains' => [
				'sp-app'    => in_array('sp-app', $classes, true),
				'sp-verify' => in_array('sp-verify', $classes, true),
			],
			'classes_sample' => array_slice($classes, 0, 30),
		];

		Logger::ndjson_scoped('runtime', self::SCOPE, 'debug', 'body_class', $payload);

		return $classes;
	}

	/**
	 * Masque les tokens sensibles (route /v/{token}) dans une URI.
	 */
	private static function mask_uri(string $uri): string
	{
		$uri = trim($uri);
		if ($uri === '') {
			return '';
		}

		// Masque /v/{token} (token = 6+ chars alphanum + -/_)
		$uri = preg_replace_callback('#(/v/)([A-Za-z0-9_-]{6,})#', function ($m) {
			$token = $m[2];
			$head = substr($token, 0, 4);
			$tail = substr($token, -2);
			return $m[1] . $head . '…' . $tail;
		}, $uri);

		// Masque query params usuels (token=, t=, code=) si présents
		$uri = preg_replace('#([?&](token|t|code)=)[^&]+#i', '$1***', $uri);

		return (string) $uri;
	}

	/**
	 * Détection simple de la route /v/{token} (focus verification).
	 */
	private static function is_verify_request(): bool
	{
		$uri = isset($_SERVER['REQUEST_URI']) ? (string) $_SERVER['REQUEST_URI'] : '';
		return (bool) preg_match('#^/v/[A-Za-z0-9_-]{6,}#', $uri);
	}
}
