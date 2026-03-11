<?php
declare(strict_types=1);

namespace SosPrescription\Services;

/**
 * Logger projet (mode test / recette).
 *
 * Objectifs :
 * - Logs désactivés par défaut (prod)
 * - Activation globale + activation fine par canal et/ou par shortcode
 * - 1 fichier par shortcode et par jour
 * - Fonctions utilitaires : lister, télécharger, vider (truncate), supprimer
 */
final class Logger
{
    private const OPTION_ENABLED = 'sosprescription_logs_enabled';
    private const OPTION_BDPM_ENABLED = 'sosprescription_logs_bdpm_enabled';
    private const OPTION_SCOPES = 'sosprescription_logs_scopes';
    private const OPTION_RUNTIME_MISC_ENABLED = 'sosprescription_logs_runtime_misc_enabled';

    private const DIR_NAME = 'sosprescription-logs';

    /** @var array<int, string> */
    private static array $channels = ['bdpm', 'runtime'];

    private static ?string $request_id = null;
    private static float $request_start = 0.0;

    public static function enabled(): bool
    {
        if (defined('SOSPRESCRIPTION_LOGS_ENABLED')) {
            return (bool) SOSPRESCRIPTION_LOGS_ENABLED;
        }

        return get_option(self::OPTION_ENABLED, '0') === '1';
    }

    public static function set_enabled(bool $enabled): void
    {
        update_option(self::OPTION_ENABLED, $enabled ? '1' : '0', false);
    }

    /**
     * Enregistre un handler "best-effort" pour journaliser les erreurs fatales PHP.
     *
     * Objectif : éviter le cas "Il y a eu une erreur critique sur ce site" sans aucun log exploitable.
     *
     * NOTE : on force l'écriture dans scope "sosprescription_fatal" même si l'admin n'a pas activé les logs.
     */
    public static function register_fatal_handler(): void
    {
        static $registered = false;
        if ($registered) {
            return;
        }
        $registered = true;

        register_shutdown_function([self::class, 'handle_fatal_shutdown']);
    }

    public static function handle_fatal_shutdown(): void
    {
        $err = error_get_last();
        if (!is_array($err) || empty($err)) {
            return;
        }

        $type = (int) ($err['type'] ?? 0);
        $fatal_types = [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR];
        if (!in_array($type, $fatal_types, true)) {
            return;
        }

        $msg = (string) ($err['message'] ?? '');
        $file = (string) ($err['file'] ?? '');
        $line = (int) ($err['line'] ?? 0);

        self::write('runtime', 'sosprescription_fatal', 'error', 'PHP fatal', [
            'php_error_type' => $type,
            'php_error_message' => $msg,
            'php_error_file' => $file,
            'php_error_line' => $line,
        ]);
    }

    public static function bdpm_enabled(): bool
    {
        if (!self::enabled()) {
            return false;
        }

        if (defined('SOSPRESCRIPTION_LOGS_BDPM_ENABLED')) {
            return (bool) SOSPRESCRIPTION_LOGS_BDPM_ENABLED;
        }

        $opt = get_option(self::OPTION_BDPM_ENABLED, '');

        // Compat : si l'option n'existe pas encore, BDPM est activé (mais seulement si logs globaux ON).
        if ($opt === '') {
            return true;
        }

        return (string) $opt === '1';
    }

    public static function set_bdpm_enabled(bool $enabled): void
    {
        update_option(self::OPTION_BDPM_ENABLED, $enabled ? '1' : '0', false);
    }

    /**
     * Activation fine : scopes (shortcodes, etc.)
     *
     * Stockage : option associative (scope => '1' | '0').
     *
     * Règle :
     * - si l'option n'existe pas => compat (tout ON)
     * - si l'option existe => seulement les scopes avec '1' loggent.
     */
    public static function scope_enabled(string $scope): bool
    {
        if (!self::enabled()) {
            return false;
        }

        $scope = self::sanitize_scope($scope);
        if ($scope === '') {
            return false;
        }

        $map = get_option(self::OPTION_SCOPES, null);
        if ($map === null) {
            // Compat : aucune config fine => tout ON.
            // Exception : certains traceurs très verbeux doivent être activés explicitement.
            if ($scope === 'php_debug') {
                return false;
            }
            return true;
        }
        if (!is_array($map)) {
            return true;
        }

        // Si une config existe, le scope absent = OFF.
        if (!array_key_exists($scope, $map)) {
            return false;
        }

        $v = $map[$scope];
        if ($v === true || $v === 1 || $v === '1') {
            return true;
        }
        return false;
    }

    /**
     * @return array<string, string>
     */
    public static function scopes_map(): array
    {
        $map = get_option(self::OPTION_SCOPES, null);
        if (!is_array($map)) {
            return [];
        }

        $out = [];
        foreach ($map as $k => $v) {
            if (!is_string($k)) {
                continue;
            }
            $key = self::sanitize_scope($k);
            if ($key === '') {
                continue;
            }
            $out[$key] = (string) ($v === true || $v === 1 || $v === '1' ? '1' : '0');
        }

        return $out;
    }

    /**
     * @param array<string, mixed> $map
     */
    public static function set_scopes_map(array $map): void
    {
        $clean = [];
        foreach ($map as $k => $v) {
            if (!is_string($k)) {
                continue;
            }
            $key = self::sanitize_scope($k);
            if ($key === '') {
                continue;
            }
            $clean[$key] = ($v === true || $v === 1 || $v === '1') ? '1' : '0';
        }

        update_option(self::OPTION_SCOPES, $clean, false);
    }

    public static function runtime_misc_enabled(): bool
    {
        if (!self::enabled()) {
            return false;
        }

        $opt = get_option(self::OPTION_RUNTIME_MISC_ENABLED, '0');
        return (string) $opt === '1';
    }

    public static function set_runtime_misc_enabled(bool $enabled): void
    {
        update_option(self::OPTION_RUNTIME_MISC_ENABLED, $enabled ? '1' : '0', false);
    }

    /**
     * Log générique.
     *
     * @param array<string, mixed> $context
     */
    

    /**
     * Convenience wrapper for INFO logs (mostly used in admin pages).
     *
     * Supported signatures:
     *  - info(string $message, array $context = [])
     *  - info(string $channel, string $message, array $context = [])
     */
    public static function info(...$args): void
    {
        $channel = 'admin';
        $message = '';
        $context = [];

        if (count($args) >= 3 && is_string($args[0]) && is_string($args[1]) && is_array($args[2])) {
            $channel = $args[0];
            $message = $args[1];
            $context = $args[2];
        } elseif (count($args) >= 2 && is_string($args[0]) && is_array($args[1])) {
            $message = $args[0];
            $context = $args[1];
        } elseif (count($args) >= 1 && is_string($args[0])) {
            $message = $args[0];
            if (isset($args[1]) && is_array($args[1])) {
                $context = $args[1];
            }
        }

        if ($message === '') {
            return;
        }

        $scope = '';
        if (preg_match('/^([a-z0-9]+)[_-]/i', $message, $m)) {
            $scope = strtolower($m[1]);
        }

        if ($scope !== '') {
            self::log_scoped($channel, $scope, 'info', $message, $context);
            return;
        }

        self::log($channel, 'info', $message, $context);
    }

public static function log(string $channel, string $level, string $message, array $context = []): void
    {
        self::write($channel, '', $level, $message, $context);
    }

    /**
     * Log dans un fichier scoped (ex: runtime-assets-2026-01-01.log).
     *
     * @param array<string, mixed> $context
     */
    public static function log_scoped(string $channel, string $scope, string $level, string $message, array $context = []): void
    {
        self::write($channel, $scope, $level, $message, $context);
    }

    /**
     * Log dédié à un shortcode : 1 fichier par shortcode et par jour.
     *
     * @param array<string, mixed> $context
     */
    

	/**
	 * Write an ERROR log entry with automatic PII masking (message + context).
	 *
	 * This is a convenience wrapper. The Logger write pipeline already masks PII
	 * in both message and context before persisting logs.
	 *
	 * @param array<string,mixed> $context
	 *
	 * @since 1.9.1
	 */
	public static function safe_error(string $message, array $context = [], string $channel = 'runtime', string $scope = ''): void
	{
		self::log('ERROR', $message, $context, $channel, $scope);
	}

	/**
	 * Trace structurée au format NDJSON (1 JSON par ligne).
	 *
	 * But : permettre un diagnostic fiable (par ex. UI / Thème / GeneratePress) sans dépendre
	 * d'un parsing "humain" des logs texte.
	 *
	 * Note : le fichier conserve l'extension .log pour rester compatible avec l'UI d'export
	 * existante (download/clear/view). Le contenu, lui, est du NDJSON pur.
	 *
	 * @param string $channel  'runtime' (défaut) ou 'bdpm'
	 * @param string $scope    Scope du traceur (ex: 'gp_theme')
	 * @param string $level    debug|info|warn|error
	 * @param string $event    Nom technique de l'évènement
	 * @param array  $payload  Données structurées (sera sanitizé)
	 */

	public static function ndjson_scoped(string $channel, string $scope, string $level, string $event, array $payload = []): void
	{
		$channel = strtolower(trim($channel));
		$scope   = trim($scope);
		$level   = strtolower(trim($level));
		$event   = trim($event);

		if (!in_array($channel, self::$channels, true)) {
			$channel = 'runtime';
		}

		if ($level === '') {
			$level = 'info';
		}

		if ($event === '') {
			$event = 'event';
		}

		if (!self::enabled()) {
			return;
		}

		if ($channel === 'bdpm' && !self::bdpm_enabled()) {
			return;
		}

		// On respecte la même logique d'activation que les logs "classiques".
		if ($channel === 'runtime' && !self::scope_enabled($scope, 'runtime')) {
			return;
		}

		$dir = self::dir();
		if ($dir === '') {
			return;
		}

		$file = $scope !== '' ? ($channel . '-' . $scope . '-' . date('Y-m-d') . '.log') : ($channel . '-' . date('Y-m-d') . '.log');

		$row = [
			'ts'      => gmdate('c'),
			'level'   => $level,
			'rid'     => self::rid(),
			'channel' => $channel,
			'scope'   => $scope,
			'event'   => $event,
			'payload' => self::sanitize_context($payload),
		];

		$encoded = wp_json_encode($row, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
		if (!is_string($encoded) || $encoded === '') {
			return;
		}

		self::append_line(rtrim($dir, '/') . '/' . $file, $encoded);
	}

    /**
     * Append a single line to a file (best-effort, never throws).
     * Ensures the line ends with a newline and uses LOCK_EX to reduce interleaving.
     */
    private static function append_line(string $file, string $line): void
    {
        if ($file === '') {
            return;
        }

        // Ensure the directory exists (best-effort).
        $dir = dirname($file);
        if ($dir !== '' && !is_dir($dir)) {
            // @phpstan-ignore-next-line
            @wp_mkdir_p($dir);
        }

        if ($line === '') {
            $line = '{}';
        }

        if (substr($line, -1) !== "\n") {
            $line .= "\n";
        }

        // @phpstan-ignore-next-line
        @file_put_contents($file, $line, FILE_APPEND | LOCK_EX);
    }



public static function log_shortcode(string $shortcode, string $level, string $message, array $context = []): void
    {
        $shortcode = strtolower(trim($shortcode));
        if ($shortcode === '') {
            $shortcode = 'unknown_shortcode';
        }

        // Activation fine par shortcode.
        if (!self::scope_enabled($shortcode)) {
            return;
        }

        $context['shortcode'] = $shortcode;

        self::write('runtime', $shortcode, $level, $message, $context);
    }

    /**
     * @param array<string, mixed> $context
     */

    private static function write(string $channel, string $scope, string $level, string $message, array $context = []): void
    {
        $channel = strtolower(trim($channel));
        if (!in_array($channel, self::$channels, true)) {
            $channel = 'runtime';
        }

        $scope = self::sanitize_scope($scope);

        // Toujours journaliser les erreurs fatales PHP (meme si l'administrateur
        // n'a pas active les logs) afin de diagnostiquer les "Il y a eu une erreur critique sur ce site".
        $force_fatal = ($channel === 'runtime' && $scope === 'sosprescription_fatal');
        if (!$force_fatal && !self::enabled()) {
            return;
        }

        if ($channel === 'bdpm' && !self::bdpm_enabled()) {
            return;
        }

        // runtime sans scope => on garde OFF par defaut.
        if ($channel === 'runtime' && $scope === '' && !self::runtime_misc_enabled()) {
            return;
        }

        // runtime avec scope => filtrage fin
        if ($channel === 'runtime' && $scope !== '' && $scope !== 'sosprescription_fatal' && !self::scope_enabled($scope)) {
            return;
        }

        $dir = self::dir();
        if ($dir === '') {
            return;
        }

        $date = (string) current_time('Y-m-d');
        $file = $channel;
        if ($scope !== '') {
            $file .= '-' . $scope;
        }
        $file .= '-' . $date . '.log';
        $path = rtrim($dir, '/') . '/' . $file;

        $lvl = strtoupper(trim($level));
        if ($lvl === '') {
            $lvl = 'INFO';
        }

        // We keep both: a stable epoch timestamp (UTC) and a WP-local readable timestamp.
        $t = time();
        $ts = (string) current_time('Y-m-d H:i:s');

        $rid = self::request_id();

        // Enrich + sanitize (incl. PII redaction) before encoding.
        $context = self::enrich_context($context, $channel, $scope);
        $safe = !empty($context) ? self::sanitize_context($context) : [];
        $safe_msg = PiiScanner::mask_text($message);

        $record = [
            'rid' => $rid,
            't' => $t,
            'ts' => $ts,
            'lvl' => $lvl,
            'channel' => $channel,
            'scope' => $scope,
            'msg' => $safe_msg,
            'ctx' => $safe,
        ];

        $json = wp_json_encode($record, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if (!is_string($json) || $json === '') {
            // Last-resort fallback: minimal, safe record.
            $json = wp_json_encode([
                'rid' => $rid,
                't' => $t,
                'ts' => $ts,
                'lvl' => 'ERROR',
                'channel' => 'logger',
                'scope' => 'writer',
                'msg' => 'Failed to encode log record',
            ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            if (!is_string($json) || $json === '') {
                return;
            }
        }

        // NDJSON: one JSON object per line.
        $line = $json . "\n";

        // @phpstan-ignore-next-line
        @file_put_contents($path, $line, FILE_APPEND | LOCK_EX);
    }


    /**
     * @param array<string, mixed> $context
     * @return array<string, mixed>
     */
    private static function enrich_context(array $context, string $channel, string $scope): array
    {
        $base = [
            'request_id' => self::request_id(),
            'elapsed_ms' => self::elapsed_ms(),
            'channel' => $channel,
            'scope' => $scope,
            'plugin' => defined('SOSPRESCRIPTION_VERSION') ? (string) SOSPRESCRIPTION_VERSION : '',
            'php' => PHP_VERSION,
            'wp' => function_exists('get_bloginfo') ? (string) get_bloginfo('version') : '',
            'is_admin' => function_exists('is_admin') ? (bool) is_admin() : false,
            'ajax' => (defined('DOING_AJAX') && DOING_AJAX) ? true : false,
            'cron' => (defined('DOING_CRON') && DOING_CRON) ? true : false,
            'user_id' => function_exists('get_current_user_id') ? (int) get_current_user_id() : 0,
            'method' => isset($_SERVER['REQUEST_METHOD']) ? (string) $_SERVER['REQUEST_METHOD'] : '',
            'uri' => isset($_SERVER['REQUEST_URI']) ? (string) $_SERVER['REQUEST_URI'] : '',
            'referer' => isset($_SERVER['HTTP_REFERER']) ? (string) $_SERVER['HTTP_REFERER'] : '',
            'ua' => self::truncate((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 220),
            'ip_hash' => self::ip_hash((string) ($_SERVER['REMOTE_ADDR'] ?? '')),
            'mem_mb' => round((float) (memory_get_usage(true) / 1048576), 1),
        ];

        // Post context (utile pour shortcodes)
        global $post;
        if (isset($post) && is_object($post) && isset($post->ID)) {
            $base['post_id'] = (int) $post->ID;
            if (isset($post->post_type)) {
                $base['post_type'] = (string) $post->post_type;
            }
            if (isset($post->post_name)) {
                $base['post_name'] = (string) $post->post_name;
            }
        }

        // Ne pas écraser les valeurs explicites passées.
        foreach ($base as $k => $v) {
            if (!array_key_exists($k, $context)) {
                $context[$k] = $v;
            }
        }

        return $context;
    }
    private static function request_id(): string
    {
        if (self::$request_id !== null) {
            return self::$request_id;
        }

        // Point de départ du chronométrage (utile pour le debug/perf)
        self::$request_start = microtime(true);

        // 1) Tentative de récupération d'un ReqID fourni par le client (corrélation support)
        //    Header recommandé : X-SOSPrescription-ReqID: ABCD1234
        $candidate = '';
        if (isset($_SERVER['HTTP_X_SOSPRESCRIPTION_REQID'])) {
            $candidate = (string) $_SERVER['HTTP_X_SOSPRESCRIPTION_REQID'];
        } elseif (isset($_SERVER['HTTP_X_SOSPRESCRIPTION_REQUEST_ID'])) {
            // Tolérance : certains clients peuvent envoyer l'ancien header.
            $candidate = (string) $_SERVER['HTTP_X_SOSPRESCRIPTION_REQUEST_ID'];
        }

        $candidate = trim($candidate);
        if ($candidate !== '') {
            // Normalisation : alphanum uniquement + uppercase + tronquage à 8.
            $normalized = strtoupper(preg_replace('/[^A-Za-z0-9]/', '', $candidate));
            if (strlen($normalized) > 8) {
                $normalized = substr($normalized, 0, 8);
            }

            if (preg_match('/^[A-Z0-9]{8}$/', $normalized)) {
                self::$request_id = $normalized;
                return self::$request_id;
            }
        }

        // 2) Fallback serveur : 8 caractères hexadécimaux (lisible, stable, grep-friendly)
        try {
            self::$request_id = strtoupper(bin2hex(random_bytes(4))); // 8 chars
        } catch (\Throwable $e) {
            // Ultime fallback : 8 chiffres (pas idéal, mais toujours corrélable)
            try {
                self::$request_id = (string) wp_rand(10000000, 99999999);
            } catch (\Throwable $e2) {
                $t = (string) time();
                self::$request_id = substr($t, -8);
            }
        }

        return self::$request_id;
    }

    /**
     * Expose l'identifiant de requête pour le front/REST (debug UX).
     */
    public static function get_request_id(): string
    {
        return self::request_id();
    }

    /**
     * Alias court (Request ID) utilisé par certains traceurs internes.
     *
     * Historique : certains modules appellent Logger::rid() pour "request id".
     * Sans cette méthode, l'activation du scope de logs (ex: gp_theme)
     * peut provoquer un fatal error.
     */
    public static function rid(): string
    {
        return self::request_id();
    }

    private static function elapsed_ms(): int
    {
        if (self::$request_start <= 0) {
            return 0;
        }

        $ms = (microtime(true) - self::$request_start) * 1000;
        if ($ms < 0) {
            return 0;
        }
        return (int) round($ms);
    }

    private static function ip_hash(string $ip): string
    {
        $ip = trim($ip);
        if ($ip === '') {
            return '';
        }

        $salt = defined('AUTH_SALT') ? (string) AUTH_SALT : 'sosprescription';
        return substr(hash('sha256', $salt . '|' . $ip), 0, 16);
    }

    private static function truncate(string $s, int $max): string
    {
        $s = trim($s);
        if ($s === '') {
            return '';
        }
        if ($max < 10) {
            $max = 10;
        }
        if (strlen($s) <= $max) {
            return $s;
        }
        return substr($s, 0, $max) . '…';
    }

    private static function sanitize_scope(string $scope): string
    {
        $scope = strtolower(trim($scope));
        if ($scope === '') {
            return '';
        }

        // shortcodes => `sosprescription_form`, etc.
        $scope = preg_replace('/[^a-z0-9_]+/', '_', $scope);
        if (!is_string($scope)) {
            return '';
        }

        $scope = trim($scope, '_');
        if ($scope === '') {
            return '';
        }

        if (strlen($scope) > 64) {
            $scope = substr($scope, 0, 64);
        }

        return $scope;
    }

    public static function dir(): string
    {
        $uploads = wp_upload_dir();
        $base = isset($uploads['basedir']) ? (string) $uploads['basedir'] : '';
        if ($base === '') {
            return '';
        }

        $dir = rtrim($base, '/') . '/' . self::DIR_NAME;
        if (!is_dir($dir)) {
            wp_mkdir_p($dir);
        }

        if (!is_dir($dir)) {
            return '';
        }

        // Hardening (best-effort): block direct access on Apache and prevent directory listing.
        $htaccess = rtrim($dir, '/') . '/.htaccess';
        if (!is_file($htaccess)) {
            // @phpstan-ignore-next-line
            @file_put_contents($htaccess, "Deny from all\n");
        }

        $index = rtrim($dir, '/') . '/index.html';
        if (!is_file($index)) {
            // @phpstan-ignore-next-line
            @file_put_contents($index, '');
        }

        return $dir;
    }

    /**
     * @return array<int, array{name:string, size:int, modified:string}>
     */
    public static function list_files(string $channel, int $limit = 30): array
    {
        $channel = strtolower(trim($channel));
        if (!in_array($channel, self::$channels, true)) {
            return [];
        }

        $dir = self::dir();
        if ($dir === '') {
            return [];
        }

        $paths = glob(rtrim($dir, '/') . '/' . $channel . '-*.log');
        if (!is_array($paths)) {
            return [];
        }

        usort($paths, static function (string $a, string $b): int {
            $ma = @filemtime($a) ?: 0;
            $mb = @filemtime($b) ?: 0;
            if ($ma === $mb) {
                return strcmp($b, $a);
            }
            return $mb <=> $ma;
        });

        $out = [];
        foreach ($paths as $p) {
            if (count($out) >= $limit) {
                break;
            }
            if (!is_file($p)) {
                continue;
            }
            $out[] = [
                'name' => basename($p),
                'size' => (int) (@filesize($p) ?: 0),
                'modified' => (string) wp_date('Y-m-d H:i:s', (int) (@filemtime($p) ?: time())),
            ];
        }

        return $out;
    }

    /**
     * @return array<int, array{name:string, size:int, modified:string}>
     */
    public static function list_files_scoped(string $channel, string $scope, int $limit = 30): array
    {
        $channel = strtolower(trim($channel));
        if (!in_array($channel, self::$channels, true)) {
            return [];
        }

        $scope = self::sanitize_scope($scope);
        if ($scope === '') {
            return [];
        }

        $dir = self::dir();
        if ($dir === '') {
            return [];
        }

        $paths = glob(rtrim($dir, '/') . '/' . $channel . '-' . $scope . '-*.log');
        if (!is_array($paths)) {
            return [];
        }

        usort($paths, static function (string $a, string $b): int {
            $ma = @filemtime($a) ?: 0;
            $mb = @filemtime($b) ?: 0;
            if ($ma === $mb) {
                return strcmp($b, $a);
            }
            return $mb <=> $ma;
        });

        $out = [];
        foreach ($paths as $p) {
            if (count($out) >= $limit) {
                break;
            }
            if (!is_file($p)) {
                continue;
            }
            $out[] = [
                'name' => basename($p),
                'size' => (int) (@filesize($p) ?: 0),
                'modified' => (string) wp_date('Y-m-d H:i:s', (int) (@filemtime($p) ?: time())),
            ];
        }

        return $out;
    }

    public static function validate_log_file(string $basename): ?string
    {
        $basename = basename($basename);

        // Exemples:
        // - bdpm-2026-01-01.log
        // - runtime-sosprescription_form-2026-01-01.log
        // - runtime-rest-2026-01-01.log
        if (preg_match('/^(bdpm|runtime)(-[a-z0-9_]{1,64})?\-\d{4}\-\d{2}\-\d{2}\.log$/', $basename) !== 1) {
            return null;
        }

        $dir = self::dir();
        if ($dir === '') {
            return null;
        }

        $path = rtrim($dir, '/') . '/' . $basename;
        if (!is_file($path)) {
            return null;
        }

        return $path;
    }

    /**
     * Supprime tous les fichiers d'un canal.
     */
    public static function clear_channel(string $channel): int
    {
        $channel = strtolower(trim($channel));
        if (!in_array($channel, self::$channels, true)) {
            return 0;
        }

        $dir = self::dir();
        if ($dir === '') {
            return 0;
        }

        $paths = glob(rtrim($dir, '/') . '/' . $channel . '-*.log');
        if (!is_array($paths)) {
            return 0;
        }

        $deleted = 0;
        foreach ($paths as $p) {
            if (!is_string($p) || $p === '' || !is_file($p)) {
                continue;
            }
            // @phpstan-ignore-next-line
            if (@unlink($p)) {
                $deleted++;
            }
        }

        return $deleted;
    }

    /**
     * Supprime tous les fichiers d'un scope (ex: runtime + sosprescription_form)
     */
    public static function clear_scope(string $channel, string $scope): int
    {
        $channel = strtolower(trim($channel));
        if (!in_array($channel, self::$channels, true)) {
            return 0;
        }

        $scope = self::sanitize_scope($scope);
        if ($scope === '') {
            return 0;
        }

        $dir = self::dir();
        if ($dir === '') {
            return 0;
        }

        $paths = glob(rtrim($dir, '/') . '/' . $channel . '-' . $scope . '-*.log');
        if (!is_array($paths)) {
            return 0;
        }

        $deleted = 0;
        foreach ($paths as $p) {
            if (!is_string($p) || $p === '' || !is_file($p)) {
                continue;
            }
            // @phpstan-ignore-next-line
            if (@unlink($p)) {
                $deleted++;
            }
        }

        return $deleted;
    }

    public static function delete_file(string $basename): bool
    {
        $path = self::validate_log_file($basename);
        if ($path === null) {
            return false;
        }

        // @phpstan-ignore-next-line
        return @unlink($path);
    }

    public static function truncate_file(string $basename): bool
    {
        $path = self::validate_log_file($basename);
        if ($path === null) {
            return false;
        }

        // @phpstan-ignore-next-line
        return @file_put_contents($path, '', LOCK_EX) !== false;
    }

    public static function tail(string $basename, int $max_bytes = 200000): string
    {
        $path = self::validate_log_file($basename);
        if ($path === null) {
            return '';
        }

        $size = (int) (@filesize($path) ?: 0);
        if ($size <= 0) {
            return '';
        }

        if ($max_bytes < 1000) {
            $max_bytes = 1000;
        }

        $read = min($size, $max_bytes);

        $fh = @fopen($path, 'rb');
        if (!is_resource($fh)) {
            return '';
        }

        try {
            @fseek($fh, -$read, SEEK_END);
            $data = @fread($fh, $read);
            if (!is_string($data)) {
                $data = '';
            }
        } finally {
            @fclose($fh);
        }

        return $data;
    }


    /**
     * Convertit un chunk de log (legacy ou NDJSON) en lignes lisibles pour l'admin.
     *
     * - Legacy : renvoyé tel quel.
     * - NDJSON  : transformé en format lisible commençant par [ReqID].
     */
    public static function format_log_chunk_for_display(string $chunk): string
    {
        $chunk = (string) $chunk;
        if ($chunk === '') {
            return '';
        }

        $lines = preg_split("/\r\n|\n|\r/", $chunk);
        if (!is_array($lines)) {
            return $chunk;
        }

        $out = [];
        foreach ($lines as $line) {
            $line = trim((string) $line);
            if ($line === '') {
                continue;
            }
            $out[] = self::format_log_line_for_display($line);
        }

        return implode("\n", $out);
    }

    /**
     * Convertit une ligne de log NDJSON en ligne lisible.
     *
     * @param string $line Ligne brute (legacy ou JSON)
     * @return string Ligne formatée (toujours 1 ligne)
     */
    public static function format_log_line_for_display(string $line): string
    {
        $trim = trim($line);
        if ($trim === '') {
            return '';
        }

        if (isset($trim[0]) && $trim[0] === '{') {
            $rec = json_decode($trim, true);
            if (is_array($rec)) {
                $rid = strtoupper((string) ($rec['rid'] ?? ''));
                if ($rid === '' && isset($rec['ctx']) && is_array($rec['ctx']) && isset($rec['ctx']['request_id'])) {
                    $rid = strtoupper((string) $rec['ctx']['request_id']);
                }

                $lvl = strtoupper((string) ($rec['lvl'] ?? $rec['level'] ?? 'INFO'));
                $ts  = (string) ($rec['ts'] ?? '');
                $t   = isset($rec['t']) ? (int) $rec['t'] : 0;
                if ($ts === '' && $t > 0) {
                    $ts = date('Y-m-d H:i:s', $t);
                }

                $chan  = (string) ($rec['chan'] ?? $rec['channel'] ?? '');
                $scope = (string) ($rec['scope'] ?? '');
                $msg   = (string) ($rec['msg'] ?? $rec['message'] ?? '');

                $ctx = $rec['ctx'] ?? $rec['context'] ?? [];
                $ctx_str = '';
                if (is_array($ctx) && !empty($ctx)) {
                    // Retire les doublons fréquents (ils sont déjà affichés via les champs top-level)
                    foreach (['timestamp', 'timestamp_iso', 'channel', 'scope', 'level', 'message', 'request_id'] as $k) {
                        if (array_key_exists($k, $ctx)) {
                            unset($ctx[$k]);
                        }
                    }

                    if (!empty($ctx)) {
                        $ctx_json = wp_json_encode($ctx, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
                        if (is_string($ctx_json) && $ctx_json !== '{}' && $ctx_json !== '[]') {
                            // Coupe très large (évite les logs illisibles en back-office)
                            if (strlen($ctx_json) > 1200) {
                                $ctx_json = substr($ctx_json, 0, 1200) . '…';
                            }
                            $ctx_str = ' | ' . $ctx_json;
                        }
                    }
                }

                $prefix = '';
                if ($rid !== '') {
                    $prefix .= '[' . $rid . '] ';
                }
                if ($ts !== '') {
                    $prefix .= '[' . $ts . '] ';
                }

                $mid = '';
                if ($chan !== '' || $scope !== '') {
                    $mid = trim($chan . ':' . $scope) . ' ';
                }

                return trim($prefix . '[' . $lvl . '] ' . $mid . $msg . $ctx_str);
            }
        }

        // Legacy or non-JSON lines.
        return $trim;
    }

    /**
     * Parse une ligne de log (legacy ou NDJSON) et retourne un enregistrement normalisé.
     *
     * Format retourné (best-effort) :
     * - rid   : ReqID (8 chars) si détecté
     * - t     : timestamp Unix (secondes) si détecté
     * - scope : scope si détecté
     * - level : niveau si détecté (INFO/WARN/ERROR...)
     * - msg   : message (si disponible)
     * - format: ndjson|legacy|raw
     */
    private static function parse_log_line(string $line): ?array
    {
        $trim = trim($line);
        if ($trim === '') {
            return null;
        }

        // NDJSON (un JSON par ligne)
        if (isset($trim[0]) && $trim[0] === '{') {
            $decoded = json_decode($trim, true);
            if (is_array($decoded)) {
                $rid = '';
                if (isset($decoded['req_id'])) {
                    $rid = (string) $decoded['req_id'];
                } elseif (isset($decoded['rid'])) {
                    $rid = (string) $decoded['rid'];
                }

                $t = null;
                if (isset($decoded['t'])) {
                    $t = (int) $decoded['t'];
                } elseif (isset($decoded['ts'])) {
                    $t = (int) $decoded['ts'];
                }

                $scope = isset($decoded['scope']) ? (string) $decoded['scope'] : '';
                $level = isset($decoded['level']) ? (string) $decoded['level'] : '';
                $msg   = isset($decoded['msg']) ? (string) $decoded['msg'] : '';

                return [
                    'format' => 'ndjson',
                    'rid'    => strtoupper($rid),
                    't'      => $t,
                    'scope'  => $scope,
                    'level'  => strtoupper($level),
                    'msg'    => $msg,
                ];
            }
        }

        $legacy = self::parse_legacy_log_line($trim);
        if ($legacy !== null) {
            return $legacy;
        }

        return [
            'format' => 'raw',
            'msg'    => $trim,
        ];
    }

    /**
     * Parse une ligne legacy de type :
     * [REQID] [YYYY-mm-dd HH:ii:ss] [scope] [LEVEL] message...
     */
    private static function parse_legacy_log_line(string $line): ?array
    {
        // ReqID au début
        if (!preg_match('/^\[([A-Za-z0-9]{6,16})\]/', $line, $m)) {
            return null;
        }
        $rid = strtoupper($m[1]);

        $t = null;
        $scope = '';
        $level = '';
        $msg = $line;

        // Extraction best-effort des blocs
        if (preg_match('/^\[[A-Za-z0-9]{6,16}\]\s*\[([^\]]+)\]\s*\[([^\]]+)\]\s*\[([^\]]+)\]\s*(.*)$/', $line, $m2)) {
            $date_str = trim($m2[1]);
            $scope = trim($m2[2]);
            $level = strtoupper(trim($m2[3]));
            $msg = trim($m2[4]);
            $ts = strtotime($date_str);
            if ($ts !== false) {
                $t = (int) $ts;
            }
        }

        return [
            'format' => 'legacy',
            'rid'    => $rid,
            't'      => $t,
            'scope'  => $scope,
            'level'  => $level,
            'msg'    => $msg,
        ];
    }

    public static function search_global_reqid(string $req_id): array
    {
        $req_id = strtoupper(trim($req_id));
        $req_id = preg_replace('/[^A-Z0-9]/', '', $req_id);
        $req_id = substr($req_id, 0, 8);
        if ($req_id === '') {
            return [];
        }

        $dir = self::ensure_logs_dir();
        if (!$dir) {
            return [];
        }

        // Scan all .log files (legacy + NDJSON) in uploads/sosprescription-logs
        $files = glob(trailingslashit($dir) . '*.log');
        if (!$files) {
            return [];
        }

        // Sort newest first by filename (contains date), best-effort.
        rsort($files);

        $matches = [];

        foreach ($files as $file) {
            if (!is_readable($file)) {
                continue;
            }

            $fileMtime = (int) (@filemtime($file) ?: time());

            $fileBase = basename($file);
            $handle = @fopen($file, 'r');
            if (!$handle) {
                continue;
            }

            while (($line = fgets($handle)) !== false) {
                $lineTrim = trim($line);
                if ($lineTrim === '') {
                    continue;
                }

                // Perf: ignore lines that do not contain the ReqID (case-insensitive)
                if (stripos($lineTrim, $req_id) === false) {
                    continue;
                }

                $parsed = self::parse_log_line($lineTrim, $file);
                if (!$parsed) {
                    continue;
                }

                $rid = strtoupper((string) ($parsed['rid'] ?? ''));
                if ($rid !== $req_id) {
                    continue;
                }

                $ts = (int) ($parsed['t'] ?? 0);
                if ($ts <= 0 && !empty($parsed['ts'])) {
                    $ts = (int) strtotime((string) $parsed['ts']);
                }
                if ($ts <= 0) {
                    // Fallback: mtime du fichier si la ligne ne contient pas de timestamp exploitable.
                    $ts = $fileMtime;
                }

                $matches[] = [
                    'file'   => $fileBase,
                    'ts'     => $ts,
                    // For UI/export: always provide a readable (legacy-like) line
                    'line'   => self::format_log_line_for_display($lineTrim),
                    // For advanced tooling: keep raw and record
                    'raw'    => $lineTrim,
                    'record' => $parsed,
                ];
            }

            fclose($handle);
        }

        usort($matches, static function ($a, $b) {
            $ta = (int) ($a['ts'] ?? 0);
            $tb = (int) ($b['ts'] ?? 0);
            return $tb <=> $ta;
        });

        return $matches;
    }


    /**
     * Snapshot des réglages actuels de logging.
     *
     * Utilisé par le backoffice (ex: Sandbox) pour afficher un état cohérent
     * des flags sans dupliquer la logique.
     *
     * @return array{enabled:bool,runtime_misc_enabled:bool,bdpm_enabled:bool,scopes:array<string,bool>}
     */
    public static function get_settings(): array
    {
        return [
            'enabled' => self::enabled(),
            'runtime_misc_enabled' => self::runtime_misc_enabled(),
            'bdpm_enabled' => self::bdpm_enabled(),
            'scopes' => self::scopes_map(),
        ];
    }

    /**
     * @param array<string, mixed> $context
     * @return array<string, scalar|null>
     */

    private static function sanitize_context(array $context): array
    {
        $out = [];

        foreach ($context as $k => $v) {
            if (is_int($k)) {
                continue;
            }

            $key = is_string($k) ? $k : (string) $k;
            $key = trim($key);
            if ($key === '') {
                continue;
            }

            // PII redaction (by key) – health context: do not leak patient data in logs.
            if (self::is_sensitive_key($key)) {
                $out[$key] = self::redact_value($key, $v);
                continue;
            }

            // Scalars
            if (is_scalar($v) || $v === null) {
                $out[$key] = self::normalize_scalar($v);
                continue;
            }

            // Small arrays (best-effort, still PII-safe)
            if (is_array($v)) {
                $out[$key] = self::normalize_array($v);
                continue;
            }

            // Objects/resources: keep only type info
            if (is_object($v)) {
                $out[$key] = '[object ' . get_class($v) . ']';
                continue;
            }

            $out[$key] = '[unloggable]';
        }

        return $out;
    }

    /**
     * Detect if a key is considered sensitive (PII/health data).
     *
     * IMPORTANT: This is a conservative default. You can extend/override via filters.
     */
    private static function is_sensitive_key(string $key): bool
    {
        $k = strtolower($key);

        // Ne pas marquer comme PII des métriques/compteurs (ex: patient_name_len).
        if (preg_match('/(_len|_count|_bytes|_ms)$/i', $k)) {
            return false;
        }

        // Allow customization from integrators.
        $custom = apply_filters('sosprescription_logger_is_sensitive_key', null, $k);
        if (is_bool($custom)) {
            return $custom;
        }

        // Explicit patient identifiers
        $patterns = [
            // Identity
            '/(^|_)(patient_)?(name|nom|prenom|firstname|lastname|full(name)?)(_|$)/i',
            // Birth / DOB
            '/(^|_)(patient_)?(birth|birthdate|dob|date_naissance)(_|$)/i',
            // NIR / SSN
            '/(^|_)(nir|num_secu|secu|ssn|social)(_|$)/i',
            // Contact
            '/(^|_)(email|mail|phone|mobile|tel|telephone)(_|$)/i',
            // Address
            '/(^|_)(address|adresse|street|city|zip|postcode)(_|$)/i',
            // IP (personal data)
            '/(^|_)(ip|ip_address|remote_ip)(_|$)/i',
        ];

        foreach ($patterns as $p) {
            if (preg_match($p, $k)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Redact sensitive values.
     * We never block logging, we just remove/mask sensitive content.
     */
    private static function redact_value(string $key, $value): string
    {
        $k = strtolower($key);
        $s = is_scalar($value) || $value === null ? (string) $value : '';

        // Allow customization.
        $custom = apply_filters('sosprescription_logger_redact_value', null, $k, $s);
        if (is_string($custom)) {
            return $custom;
        }

        // IP
        if (preg_match('/(^|_)(ip|ip_address|remote_ip)(_|$)/i', $k)) {
            return self::anonymize_ip($s);
        }

        // Email
        if (preg_match('/(^|_)(email|mail)(_|$)/i', $k)) {
            return self::mask_email($s);
        }

        // Phone
        if (preg_match('/(^|_)(phone|mobile|tel|telephone)(_|$)/i', $k)) {
            return self::mask_phone($s);
        }

        // Birthdate/DOB
        if (preg_match('/(^|_)(birth|birthdate|dob|date_naissance)(_|$)/i', $k)) {
            return self::mask_birthdate($s);
        }

        // Names
        if (preg_match('/(^|_)(patient_)?(name|nom|prenom|firstname|lastname|full(name)?)(_|$)/i', $k)) {
            return self::mask_name($s);
        }

        // Default: hard redact
        return '[REDACTED]';
    }

    private static function normalize_scalar($value)
    {
        if ($value === null) {
            return null;
        }
        if (is_bool($value) || is_int($value) || is_float($value)) {
            return $value;
        }

        $s = (string) $value;
        $s = str_replace(["\r\n", "\r", "\n"], ' ', $s);
        $s = trim($s);

        // Strip obvious base64/data blobs
        if (strlen($s) > 500 && (strpos($s, 'data:') === 0 || preg_match('/^[A-Za-z0-9+\/]+=*$/', $s))) {
            return '[BLOB omitted len=' . strlen($s) . ']';
        }

        // Mask common PII patterns inside free strings (best-effort)
        // NOTE: we do NOT block logging; we sanitize to keep host-friendly behavior.
        $s = PiiScanner::mask_text($s);

        // Cap long strings
        $max = (int) apply_filters('sosprescription_logger_max_string_len', 300);
        if ($max > 0 && strlen($s) > $max) {
            $s = substr($s, 0, $max) . '…(truncated)';
        }

        return $s;
    }

    private static function normalize_array(array $arr): array
    {
        $out = [];
        $count = 0;
        $max_items = (int) apply_filters('sosprescription_logger_max_array_items', 50);

        foreach ($arr as $k => $v) {
            if ($max_items > 0 && $count >= $max_items) {
                $out['__truncated__'] = true;
                break;
            }
            $count++;

            $key = is_string($k) ? $k : (string) $k;
            $key = trim($key);
            if ($key === '') {
                continue;
            }

            if (self::is_sensitive_key($key)) {
                $out[$key] = self::redact_value($key, $v);
                continue;
            }

            if (is_scalar($v) || $v === null) {
                $out[$key] = self::normalize_scalar($v);
            } elseif (is_array($v)) {
                $out[$key] = '[array]';
            } elseif (is_object($v)) {
                $out[$key] = '[object ' . get_class($v) . ']';
            } else {
                $out[$key] = '[unloggable]';
            }
        }

        return $out;
    }

    private static function mask_name(string $s): string
    {
        $s = trim($s);
        if ($s === '') {
            return '[REDACTED]';
        }

        $parts = preg_split('/\s+/', $s);
        $masked = [];
        foreach ($parts as $p) {
            $p = trim($p);
            if ($p === '') {
                continue;
            }
            $first = function_exists('mb_substr') ? mb_substr($p, 0, 1, "UTF-8") : substr($p, 0, 1);
            $masked[] = $first . '****';
        }

        return implode(' ', $masked);
    }

    private static function mask_birthdate(string $s): string
    {
        $s = trim($s);
        if ($s === '') {
            return '[REDACTED]';
        }

        // ISO YYYY-MM-DD
        if (preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $s, $m)) {
            return $m[1] . '-**-**';
        }

        // FR DD/MM/YYYY
        if (preg_match('/^(\d{2})\/(\d{2})\/(\d{4})$/', $s, $m)) {
            return '**/**/' . $m[3];
        }

        // Fallback: keep only year if any
        if (preg_match('/(\d{4})/', $s, $m)) {
            return $m[1] . '-**-**';
        }

        return '[REDACTED]';
    }

    private static function mask_email(string $s): string
    {
        $s = trim($s);
        if ($s === '') {
            return '[REDACTED]';
        }
        if (strpos($s, '@') === false) {
            return '[REDACTED]';
        }
        [$local, $domain] = array_pad(explode('@', $s, 2), 2, '');
        $local = trim($local);
        $domain = trim($domain);
        if ($domain === '') {
            return '[REDACTED]';
        }
        $first = $local !== '' ? (function_exists('mb_substr') ? mb_substr($local, 0, 1, "UTF-8") : substr($local, 0, 1)) : '*';
        return $first . '***@' . $domain;
    }

    private static function mask_phone(string $s): string
    {
        $digits = preg_replace('/\D+/', '', $s);
        if ($digits === '') {
            return '[REDACTED]';
        }
        $tail = substr($digits, -2);
        return '***' . $tail;
    }

    private static function anonymize_ip(string $s): string
    {
        $s = trim($s);
        if ($s === '') {
            return '[REDACTED]';
        }

        // IPv4
        if (filter_var($s, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
            $parts = explode('.', $s);
            $parts[3] = '0';
            return implode('.', $parts);
        }

        // IPv6
        if (filter_var($s, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6)) {
            // Keep first 3 blocks, zero the rest
            $parts = explode(':', $s);
            $parts = array_pad($parts, 8, '0');
            for ($i = 3; $i < 8; $i++) {
                $parts[$i] = '0';
            }
            return implode(':', $parts);
        }

        return '[REDACTED]';
    }

}
