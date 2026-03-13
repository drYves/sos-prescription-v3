<?php
declare(strict_types=1);

namespace SOSPrescription\Admin;

use SOSPrescription\Db;
use SOSPrescription\Services\FileStorage;
use SOSPrescription\Services\Logger;
use SOSPrescription\Services\SandboxConfig;

/**
 * Sandbox (tests) – outils de nettoyage pour repartir sur une base propre.
 *
 * IMPORTANT: page destructive, réservée aux admins / rôles techniques.
 */
final class SandboxPage
{
	public static function register_actions(): void
	{
		add_action('admin_post_sosprescription_sandbox_save', [self::class, 'handle_save_settings']);
		add_action('admin_post_sosprescription_sandbox_purge_requests', [self::class, 'handle_purge_requests']);
	}

	/**
	 * Menu callback.
	 */
	public static function render_page(): void
	{
		if (!current_user_can('sosprescription_manage_data')) {
			wp_die('Accès refusé.', 403);
		}

		$counts = self::get_counts();
		$sandbox = SandboxConfig::get();
		$logger = Logger::get_settings();
		$notice = isset($_GET['sandbox_notice']) ? sanitize_text_field((string) $_GET['sandbox_notice']) : '';
		$notice_type = isset($_GET['sandbox_notice_type']) ? sanitize_text_field((string) $_GET['sandbox_notice_type']) : 'updated';

		echo '<div class="wrap sp-ui">';
		echo '<h1>Sandbox (tests)</h1>';
		echo '<p class="sp-muted" style="max-width: 980px;">Outils de nettoyage pour les phases de tests. <strong>Attention :</strong> ces actions sont destructrices et irréversibles.</p>';

		if ($notice !== '') {
			$cls = $notice_type === 'error' ? 'notice notice-error' : 'notice notice-success';
			echo '<div class="' . esc_attr($cls) . '"><p>' . esc_html($notice) . '</p></div>';
		}

		echo '<div class="sp-row" style="gap:20px; flex-wrap:wrap; max-width: 1040px;">';

		// Card: quick stats
		echo '<div class="sp-card" style="flex:1; min-width: 320px; max-width: 520px;">';
		echo '<h2 style="margin-top:0">État (demandes)</h2>';
		echo '<table class="widefat striped" style="margin:0;">';
		echo '<tbody>';
		echo '<tr><td><strong>Demandes (prescriptions)</strong></td><td>' . wp_kses_post(self::render_count_cell($counts['prescriptions'])) . '</td></tr>';
		echo '<tr><td>Items (médicaments)</td><td>' . wp_kses_post(self::render_count_cell($counts['items'])) . '</td></tr>';
		echo '<tr><td>Messages</td><td>' . wp_kses_post(self::render_count_cell($counts['messages'])) . '</td></tr>';
		echo '<tr><td>Fichiers</td><td>' . wp_kses_post(self::render_count_cell($counts['files'])) . '</td></tr>';
		echo '<tr><td>Audit</td><td>' . wp_kses_post(self::render_count_cell($counts['audit'])) . '</td></tr>';
		echo '</tbody>';
		echo '</table>';
		echo '<p style="margin:12px 0 0; color:#6b7280; font-size:12px;">Astuce : utilisez cette page uniquement en environnement de test.</p>';
		echo '</div>';

		// Card: project phase + logging preset
		echo '<div class="sp-card" style="flex:1; min-width: 320px; max-width: 520px;">';
		echo '<h2 style="margin-top:0">Phase projet & logs</h2>';
		echo '<p style="margin-top:0; color:#6b7280;">Choisissez une phase pour appliquer automatiquement un preset de logs (utile en tests). En production, désactivez les logs pour éviter l\'écriture disque.</p>';

		echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
		wp_nonce_field('sosprescription_sandbox_save');
		echo '<input type="hidden" name="action" value="sosprescription_sandbox_save" />';

		$project_mode = !empty($sandbox['project_mode']);
		$testing_mode = !empty($sandbox['testing_mode']);
		$phase = isset($sandbox['phase']) ? (string) $sandbox['phase'] : 'dev';

		echo '<label style="display:block; margin:10px 0;">';
		echo '<input type="checkbox" name="sosprescription_project_mode" value="1" ' . checked(true, $project_mode, false) . ' /> ';
		echo '<strong>Mode projet</strong> : appliquer automatiquement le preset de logs de la phase sélectionnée';
		echo '</label>';

		echo '<label style="display:block; margin:10px 0;">Phase : ';
		echo '<select name="sosprescription_phase" style="min-width: 220px;">';
		echo '<option value="dev" ' . selected($phase, 'dev', false) . '>Développement (DEV)</option>';
		echo '<option value="test" ' . selected($phase, 'test', false) . '>Recette / Tests (TEST)</option>';
		echo '<option value="prod" ' . selected($phase, 'prod', false) . '>Production (PROD)</option>';
		echo '</select>';
		echo '</label>';

		echo '<label style="display:block; margin:10px 0;">';
		echo '<input type="checkbox" name="sosprescription_testing_mode" value="1" ' . checked(true, $testing_mode, false) . ' /> ';
		echo 'Testing mode (déverrouille certaines contraintes en environnement de test)';
		echo '</label>';

		echo '<p style="margin:14px 0 0;">';
		echo '<button type="submit" class="button button-primary">Enregistrer</button>';
		echo '</p>';
		echo '</form>';

		// Current logger state summary
		$enabled = !empty($logger['enabled']);
		$runtime_misc = !empty($logger['runtime_misc_enabled']);
		$bdpm = !empty($logger['bdpm_enabled']);
		$scopes = isset($logger['scopes']) && is_array($logger['scopes']) ? $logger['scopes'] : [];
		$on = 0;
		foreach ($scopes as $v) {
			if (!empty($v)) { $on++; }
		}

		echo '<hr style="margin:16px 0;" />';
		echo '<h3 style="margin:0 0 8px; font-size:13px;">État des logs</h3>';
		echo '<ul style="margin:0; padding-left:18px; color:#374151;">';
		echo '<li><strong>Global</strong> : ' . ($enabled ? '<span style="color:#16a34a">ON</span>' : '<span style="color:#dc2626">OFF</span>') . '</li>';
		echo '<li><strong>Scopes actifs</strong> : ' . esc_html((string) $on) . '</li>';
		echo '<li><strong>Runtime misc</strong> : ' . ($runtime_misc ? 'ON' : 'OFF') . '</li>';
		echo '<li><strong>BDPM import</strong> : ' . ($bdpm ? 'ON' : 'OFF') . '</li>';
		echo '</ul>';

		if (!empty($sandbox['updated_at'])) {
			echo '<p style="margin:10px 0 0; color:#6b7280; font-size:12px;">Dernière mise à jour : ' . esc_html((string) $sandbox['updated_at']) . '</p>';
		}
		echo '</div>';

		// Card: purge actions
		echo '<div class="sp-card" style="flex:1; min-width: 320px; max-width: 520px;">';
		echo '<h2 style="margin-top:0">Nettoyage</h2>';
		echo '<p style="margin-top:0">Supprime toutes les demandes (patients/médecins) et leurs données associées.</p>';

		echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
		wp_nonce_field('sosprescription_sandbox_purge_requests');
		echo '<input type="hidden" name="action" value="sosprescription_sandbox_purge_requests" />';
		echo '<label style="display:block; margin:10px 0;">
			<input type="checkbox" name="delete_files" value="1" />
			Supprimer aussi les fichiers stockés sur disque (uploads/sosprescription-private)
		</label>';
		echo '<label style="display:block; margin:10px 0;">
			<input type="checkbox" name="delete_audit" value="1" checked />
			Purger aussi l\'audit log (recommandé en tests)
		</label>';
		echo '<label style="display:block; margin:10px 0;">
			<input type="checkbox" name="confirm" value="1" required />
			<strong>Je confirme</strong> la suppression de ces données de test
		</label>';

		echo '<p style="margin:14px 0 0;">
			<button type="submit" class="button button-primary" style="background:#dc2626; border-color:#dc2626;">Purger toutes les demandes</button>
		</p>';
		echo '</form>';
		echo '</div>';

		echo '</div>';
		echo '</div>';
	}

	public static function handle_save_settings(): void
	{
		if (!current_user_can('sosprescription_manage_data')) {
			wp_die('Accès refusé.', 403);
		}

		check_admin_referer('sosprescription_sandbox_save');

		$project_mode = !empty($_POST['sosprescription_project_mode']);
		$testing_mode = !empty($_POST['sosprescription_testing_mode']);
		$phase = isset($_POST['sosprescription_phase']) ? sanitize_key((string) wp_unslash($_POST['sosprescription_phase'])) : 'dev';

		$cfg = SandboxConfig::update([
			'project_mode' => $project_mode,
			'testing_mode' => $testing_mode,
			'phase' => $phase,
		]);

		// Apply a logging preset when project mode is enabled.
		if (!empty($cfg['project_mode'])) {
			self::apply_logging_preset((string) $cfg['phase']);
		}

		Logger::log_shortcode('sosprescription_admin', 'info', 'sandbox_settings_saved', [
			'project_mode' => !empty($cfg['project_mode']),
			'testing_mode' => !empty($cfg['testing_mode']),
			'phase' => (string) $cfg['phase'],
		]);

		$url = add_query_arg(
			[
				'page' => 'sosprescription-sandbox',
				'sandbox_notice' => rawurlencode('Sandbox mis à jour.' . (!empty($cfg['project_mode']) ? ' Preset de logs appliqué.' : '')),
				'sandbox_notice_type' => 'success',
			],
			admin_url('admin.php')
		);
		wp_safe_redirect($url);
		exit;
	}

	private static function apply_logging_preset(string $phase): void
	{
		$phase = sanitize_key($phase);
		if (!in_array($phase, SandboxConfig::phases(), true)) {
			$phase = 'dev';
		}

		// Presets: DEV/TEST => logs ON (all scopes), PROD => logs OFF.
		$enabled = $phase !== 'prod';
		$scopes = [
			'sosprescription_form' => $enabled ? '1' : '0',
			'sosprescription_admin' => $enabled ? '1' : '0',
			'sosprescription_patient' => $enabled ? '1' : '0',
			'sosprescription_doctor_account' => $enabled ? '1' : '0',
			'sosprescription_bdpm_table' => $enabled ? '1' : '0',
		];

		Logger::set_enabled($enabled);
		Logger::set_scopes_map($scopes);
		Logger::set_runtime_misc_enabled($enabled);
		Logger::set_bdpm_enabled($enabled);
	}

	public static function handle_purge_requests(): void
	{
		if (!current_user_can('sosprescription_manage_data')) {
			wp_die('Accès refusé.', 403);
		}

		check_admin_referer('sosprescription_sandbox_purge_requests');

		if (!isset($_POST['confirm']) || (string) $_POST['confirm'] !== '1') {
			$redirect = add_query_arg([
				'page' => 'sosprescription-sandbox',
				'sandbox_notice' => rawurlencode('Action annulée : confirmation manquante.'),
				'sandbox_notice_type' => 'error',
			], admin_url('admin.php'));
			wp_safe_redirect($redirect);
			exit;
		}

		$delete_files = isset($_POST['delete_files']) && (string) $_POST['delete_files'] === '1';
		$delete_audit = isset($_POST['delete_audit']) && (string) $_POST['delete_audit'] === '1';

		global $wpdb;
		$t_presc = Db::table('prescriptions');
		$t_items = Db::table('prescription_items');
		$t_msgs  = Db::table('prescription_messages');
		$t_files = Db::table('files');
		$t_audit = self::resolve_audit_table();

		$deleted_disk = 0;
		$deleted_db = [
			'prescriptions' => 0,
			'items' => 0,
			'messages' => 0,
			'files' => 0,
			'audit' => 0,
		];

		// Optionnel: suppression fichiers sur disque (avant suppression DB)
		if ($delete_files) {
			try {
				$rows = self::table_exists($t_files) ? $wpdb->get_results("SELECT id, storage_key FROM {$t_files}", ARRAY_A) : [];
				if (is_array($rows)) {
					foreach ($rows as $r) {
						$sk = isset($r['storage_key']) ? (string) $r['storage_key'] : '';
						if ($sk === '') continue;
						$abs = FileStorage::safe_abs_path($sk);
						if (!is_wp_error($abs) && is_string($abs) && $abs !== '' && is_file($abs)) {
							if (@unlink($abs)) {
								$deleted_disk++;
							}
						}
					}
				}
			} catch (\Throwable $e) {
				// no-op
			}
		}

		// Delete DB rows (order matters)
		$deleted_db['items'] = self::safe_delete_all($t_items);
		$deleted_db['messages'] = self::safe_delete_all($t_msgs);
		$deleted_db['files'] = self::safe_delete_all($t_files);
		if ($delete_audit) {
			$deleted_db['audit'] = self::safe_delete_all($t_audit);
		}
		$deleted_db['prescriptions'] = self::safe_delete_all($t_presc);

		Logger::log_shortcode('sosprescription_admin', 'info', 'sandbox_purge_requests', [
			'delete_files' => $delete_files,
			'deleted_disk' => $deleted_disk,
			'deleted_db' => $deleted_db,
		]);

		$msg = 'Purge terminée.';
		$msg .= ' Demandes: ' . (string) $deleted_db['prescriptions'];
		$msg .= ', items: ' . (string) $deleted_db['items'];
		$msg .= ', messages: ' . (string) $deleted_db['messages'];
		$msg .= ', fichiers: ' . (string) $deleted_db['files'];
		if ($delete_files) {
			$msg .= ', fichiers disque: ' . (string) $deleted_disk;
		}

		$redirect = add_query_arg([
			'page' => 'sosprescription-sandbox',
			'sandbox_notice' => rawurlencode($msg),
			'sandbox_notice_type' => 'success',
		], admin_url('admin.php'));
		wp_safe_redirect($redirect);
		exit;
	}

	/**
	 * Counts rows for quick display.
	 * @return array<string, array{exists:bool,count:int}>
	 */
	private static function get_counts(): array
	{
		$counts = [
			'prescriptions' => ['exists' => false, 'count' => 0],
			'items' => ['exists' => false, 'count' => 0],
			'messages' => ['exists' => false, 'count' => 0],
			'files' => ['exists' => false, 'count' => 0],
			'audit' => ['exists' => false, 'count' => 0],
		];

		$counts['prescriptions'] = self::safe_count(Db::table('prescriptions'));
		$counts['items'] = self::safe_count(Db::table('prescription_items'));
		$counts['messages'] = self::safe_count(Db::table('prescription_messages'));
		$counts['files'] = self::safe_count(Db::table('files'));
		$counts['audit'] = self::safe_count(self::resolve_audit_table());

		return $counts;
	}

	/**
	 * @return array{exists:bool,count:int}
	 */
	private static function safe_count(string $table): array
	{
		global $wpdb;

		if ($table === '' || !self::table_exists($table)) {
			return ['exists' => false, 'count' => 0];
		}

		try {
			$value = $wpdb->get_var("SELECT COUNT(*) FROM {$table}");
			return ['exists' => true, 'count' => $value === null ? 0 : (int) $value];
		} catch (\Throwable $e) {
			return ['exists' => true, 'count' => 0];
		}
	}

	private static function safe_delete_all(string $table): int
	{
		global $wpdb;

		if ($table === '' || !self::table_exists($table)) {
			return 0;
		}

		try {
			$result = $wpdb->query("DELETE FROM {$table}");
			return is_int($result) ? $result : 0;
		} catch (\Throwable $e) {
			return 0;
		}
	}

	private static function resolve_audit_table(): string
	{
		$auditLog = Db::table('audit_log');
		if (self::table_exists($auditLog)) {
			return $auditLog;
		}

		return Db::table('audit');
	}

	private static function table_exists(string $table): bool
	{
		global $wpdb;

		if ($table === '') {
			return false;
		}

		try {
			$sql = $wpdb->prepare('SHOW TABLES LIKE %s', $table);
			return (string) $wpdb->get_var($sql) === $table;
		} catch (\Throwable $e) {
			return false;
		}
	}

	/**
	 * @param array{exists:bool,count:int}|mixed $item
	 */
	private static function render_count_cell($item): string
	{
		if (!is_array($item) || empty($item['exists'])) {
			return '<span style="color:#b45309;">Table absente (Lancer réparation)</span>';
		}

		return esc_html((string) ((int) ($item['count'] ?? 0)));
	}
}
