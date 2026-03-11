<?php
declare(strict_types=1);

namespace SosPrescription;

final class Installer
{
    public static function activate(): void
    {
        self::install();

        // Par défaut, on CONSERVE les données lors d'une suppression du plugin (utile pendant les tests / mises à jour).
        // Pour purger réellement (RGPD / arrêt du service), activez l'option dans SOS Prescription > Configuration,
        // ou définissez SOSPRESCRIPTION_PURGE_ON_UNINSTALL à true.
        if (get_option('sosprescription_purge_on_uninstall', null) === null) {
            add_option('sosprescription_purge_on_uninstall', 'no', '', false);
        }

        // Prépare la route courte de vérification (/v/{token}).
        // flush_rewrite_rules est coûteux : appelé uniquement à l'activation.
        if (class_exists('SosPrescription\\Frontend\\VerificationPage')) {
            \SosPrescription\Frontend\VerificationPage::register_rewrite();
            flush_rewrite_rules(false);
        }
    }

    public static function install(): void
    {
        global $wpdb;

        require_once ABSPATH . 'wp-admin/includes/upgrade.php';

        $charset = $wpdb->get_charset_collate();

        $prescriptions = Db::table('prescriptions');
        $items         = Db::table('prescription_items');

        $files    = Db::table('files');
        $messages = Db::table('prescription_messages');
		$audit    = Db::table('audit');

        $cis   = Db::table('cis');
        $cip   = Db::table('cip');
        $compo = Db::table('compo');
        $smr   = Db::table('has_smr');
        $asmr  = Db::table('has_asmr');
        $gener = Db::table('gener');
        $cpd   = Db::table('cpd');
        $info  = Db::table('info');
        $dispo = Db::table('dispo');
        $mitm  = Db::table('mitm');

        $sql = [];

        $sql[] = "CREATE TABLE {$prescriptions} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            uid VARCHAR(32) NOT NULL,
            patient_user_id BIGINT UNSIGNED NOT NULL,
            doctor_user_id BIGINT UNSIGNED NULL,
            status VARCHAR(20) NOT NULL,

            flow VARCHAR(20) NOT NULL DEFAULT 'renewal',
            priority VARCHAR(20) NOT NULL DEFAULT 'standard',

            payload_json LONGTEXT NOT NULL,
            pricing_snapshot_json LONGTEXT NULL,

            payment_provider VARCHAR(20) NULL,
            payment_intent_id VARCHAR(64) NULL,
            payment_status VARCHAR(30) NULL,
            amount_cents INT UNSIGNED NULL,
            currency CHAR(3) NOT NULL DEFAULT 'EUR',

            decision_code VARCHAR(40) NULL,
            decision_reason TEXT NULL,
            decision_note_internal LONGTEXT NULL,
            decision_message_patient LONGTEXT NULL,

            verify_token VARCHAR(64) NULL,
            verify_code CHAR(6) NULL,
            dispensed_at DATETIME NULL,
            dispensed_ip_hash VARCHAR(64) NULL,

            client_request_id VARCHAR(64) NULL,
            assigned_at DATETIME NULL,
            last_activity_at DATETIME NULL,

            created_at DATETIME NOT NULL,
            updated_at DATETIME NOT NULL,
            decided_at DATETIME NULL,

            PRIMARY KEY  (id),
            UNIQUE KEY uq_uid (uid),
            UNIQUE KEY uq_patient_client_req (patient_user_id, client_request_id),
            KEY idx_patient_status (patient_user_id, status),
            KEY idx_status (status),
            KEY idx_doctor (doctor_user_id),
            KEY idx_status_priority_created (status, priority, created_at),
            KEY idx_flow_status (flow, status),
            KEY idx_payment_intent (payment_intent_id),
            UNIQUE KEY uq_verify_token (verify_token)
        ) {$charset};";

        $sql[] = "CREATE TABLE {$items} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            prescription_id BIGINT UNSIGNED NOT NULL,
            line_no INT UNSIGNED NOT NULL,
            cis BIGINT UNSIGNED NULL,
            cip13 VARCHAR(13) NULL,
            denomination TEXT NOT NULL,
            posologie TEXT NULL,
            quantite TEXT NULL,
            item_json LONGTEXT NOT NULL,
            PRIMARY KEY (id),
            UNIQUE KEY uq_presc_line (prescription_id, line_no),
            KEY idx_presc (prescription_id),
            KEY idx_cis (cis),
            KEY idx_cip13 (cip13)
        ) {$charset};";

        $sql[] = "CREATE TABLE {$files} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            owner_user_id BIGINT UNSIGNED NOT NULL,
            prescription_id BIGINT UNSIGNED NULL,
            purpose VARCHAR(30) NOT NULL,
            mime VARCHAR(100) NOT NULL,
            original_name TEXT NOT NULL,
            storage_key VARCHAR(255) NOT NULL,
            size_bytes BIGINT UNSIGNED NOT NULL,
            created_at DATETIME NOT NULL,
            PRIMARY KEY (id),
            KEY idx_owner (owner_user_id),
            KEY idx_prescription (prescription_id),
            KEY idx_purpose (purpose)
        ) {$charset};";

        $sql[] = "CREATE TABLE {$messages} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            prescription_id BIGINT UNSIGNED NOT NULL,
            author_role VARCHAR(20) NOT NULL,
            author_user_id BIGINT UNSIGNED NULL,
            body LONGTEXT NOT NULL,
            attachments_json LONGTEXT NULL,
            created_at DATETIME NOT NULL,
            PRIMARY KEY (id),
            KEY idx_prescription_created (prescription_id, created_at),
            KEY idx_author (author_user_id)
        ) {$charset};";

		// Journal d'audit (accès & actions sensibles) — recommandé conformité.
		$sql[] = "CREATE TABLE {$audit} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			event_at DATETIME NOT NULL,
			actor_user_id BIGINT UNSIGNED NULL,
			actor_role VARCHAR(30) NULL,
			actor_ip VARCHAR(45) NULL,
			actor_user_agent VARCHAR(255) NULL,
			action VARCHAR(60) NOT NULL,
			object_type VARCHAR(30) NOT NULL,
			object_id BIGINT UNSIGNED NULL,
			prescription_id BIGINT UNSIGNED NULL,
			meta_json LONGTEXT NULL,
			PRIMARY KEY (id),
			KEY idx_event_at (event_at),
			KEY idx_actor (actor_user_id),
			KEY idx_object (object_type, object_id),
			KEY idx_prescription (prescription_id)
		) {$charset};";

        $sql[] = "CREATE TABLE {$cis} (
            cis BIGINT UNSIGNED NOT NULL,
            denomination VARCHAR(255) NOT NULL,
            forme_pharmaceutique VARCHAR(255) NULL,
            voie_administration VARCHAR(255) NULL,
            statut_admin VARCHAR(255) NULL,
            type_procedure VARCHAR(255) NULL,
            etat_commercialisation VARCHAR(255) NULL,
            date_amm DATE NULL,
            statut_bdm VARCHAR(255) NULL,
            num_autorisation VARCHAR(255) NULL,
            titulaires TEXT NULL,
            surveillance_renforcee TINYINT(1) NOT NULL DEFAULT 0,
            row_hash CHAR(32) NOT NULL,
            PRIMARY KEY (cis),
            KEY idx_denom (denomination),
            UNIQUE KEY uq_hash (row_hash)
        ) {$charset};";

        $sql[] = "CREATE TABLE {$cip} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            cis BIGINT UNSIGNED NOT NULL,
            cip7 VARCHAR(7) NULL,
            cip13 VARCHAR(13) NULL,
            libelle_presentation VARCHAR(255) NULL,
            statut_admin VARCHAR(255) NULL,
            date_declaration DATE NULL,
            date_commercialisation DATE NULL,
            agrement_collectivites VARCHAR(50) NULL,
            taux_remboursement VARCHAR(50) NULL,
            prix_ttc DECIMAL(10,2) NULL,
            prix_honoraires DECIMAL(10,2) NULL,
            row_hash CHAR(32) NOT NULL,
            PRIMARY KEY (id),
            UNIQUE KEY uq_cip13 (cip13),
            KEY idx_cis (cis),
            KEY idx_cip7 (cip7),
            UNIQUE KEY uq_hash (row_hash)
        ) {$charset};";

        $sql[] = "CREATE TABLE {$compo} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            cis BIGINT UNSIGNED NOT NULL,
            designation_element_pharmaceutique VARCHAR(255) NULL,
            code_substance VARCHAR(50) NULL,
            substance VARCHAR(255) NULL,
            dosage VARCHAR(100) NULL,
            unite_dosage VARCHAR(50) NULL,
            reference_dosage VARCHAR(50) NULL,
            nature_composant VARCHAR(255) NULL,
            row_hash CHAR(32) NOT NULL,
            PRIMARY KEY (id),
            KEY idx_cis (cis),
            KEY idx_substance (substance),
            UNIQUE KEY uq_hash (row_hash)
        ) {$charset};";

        $sql[] = "CREATE TABLE {$smr} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            cis BIGINT UNSIGNED NOT NULL,
            code_has VARCHAR(50) NULL,
            date_avis DATE NULL,
            valeur_smr VARCHAR(255) NULL,
            libelle VARCHAR(255) NULL,
            row_hash CHAR(32) NOT NULL,
            PRIMARY KEY (id),
            KEY idx_cis (cis),
            UNIQUE KEY uq_hash (row_hash)
        ) {$charset};";

        $sql[] = "CREATE TABLE {$asmr} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            cis BIGINT UNSIGNED NOT NULL,
            code_has VARCHAR(50) NULL,
            date_avis DATE NULL,
            valeur_asmr VARCHAR(255) NULL,
            libelle VARCHAR(255) NULL,
            row_hash CHAR(32) NOT NULL,
            PRIMARY KEY (id),
            KEY idx_cis (cis),
            UNIQUE KEY uq_hash (row_hash)
        ) {$charset};";

        $sql[] = "CREATE TABLE {$gener} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            cis BIGINT UNSIGNED NOT NULL,
            groupe_generique_id VARCHAR(50) NULL,
            libelle_groupe VARCHAR(255) NULL,
            type_generique VARCHAR(255) NULL,
            numero_tri INT NULL,
            row_hash CHAR(32) NOT NULL,
            PRIMARY KEY (id),
            KEY idx_cis (cis),
            KEY idx_groupe (groupe_generique_id),
            UNIQUE KEY uq_hash (row_hash)
        ) {$charset};";

        $sql[] = "CREATE TABLE {$cpd} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            cis BIGINT UNSIGNED NOT NULL,
            condition_prescription TEXT NULL,
            row_hash CHAR(32) NOT NULL,
            PRIMARY KEY (id),
            KEY idx_cis (cis),
            UNIQUE KEY uq_hash (row_hash)
        ) {$charset};";

        $sql[] = "CREATE TABLE {$info} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            cis BIGINT UNSIGNED NOT NULL,
            type_info VARCHAR(255) NULL,
            date_debut DATE NULL,
            date_fin DATE NULL,
            texte LONGTEXT NULL,
            row_hash CHAR(32) NOT NULL,
            PRIMARY KEY (id),
            KEY idx_cis (cis),
            UNIQUE KEY uq_hash (row_hash)
        ) {$charset};";

        $sql[] = "CREATE TABLE {$dispo} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            cis BIGINT UNSIGNED NOT NULL,
            cip13 VARCHAR(13) NULL,
            etat_dispo VARCHAR(255) NULL,
            date_debut DATE NULL,
            date_fin DATE NULL,
            row_hash CHAR(32) NOT NULL,
            PRIMARY KEY (id),
            KEY idx_cis (cis),
            KEY idx_cip13 (cip13),
            UNIQUE KEY uq_hash (row_hash)
        ) {$charset};";

        $sql[] = "CREATE TABLE {$mitm} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            cis BIGINT UNSIGNED NOT NULL,
            code_atc VARCHAR(50) NULL,
            libelle_atc VARCHAR(255) NULL,
            row_hash CHAR(32) NOT NULL,
            PRIMARY KEY (id),
            KEY idx_cis (cis),
            KEY idx_atc (code_atc),
            UNIQUE KEY uq_hash (row_hash)
        ) {$charset};";

        foreach ($sql as $statement) {
            dbDelta($statement);
        }

        self::ensure_capabilities();
        self::ensure_roles();

        update_option('sosprescription_db_version', SOSPRESCRIPTION_VERSION, false);
    }

    private static function ensure_capabilities(): void
    {
        $admin = get_role('administrator');
        if ($admin) {
            $admin->add_cap('sosprescription_manage');
            $admin->add_cap('sosprescription_manage_data');
            $admin->add_cap('sosprescription_validate');
        }
    }

    private static function ensure_roles(): void
    {
        // Rôle Médecin (optionnel) - facilite l'attribution des droits sans passer par un plugin tiers.
        if (!get_role('sosprescription_doctor')) {
            add_role('sosprescription_doctor', 'Médecin (SOS Prescription)', [
                'read' => true,
                'sosprescription_validate' => true,
            ]);
        } else {
            $role = get_role('sosprescription_doctor');
            if ($role) {
                $role->add_cap('read');
                $role->add_cap('sosprescription_validate');
            }
        }
    }


    /**
     * Détermine si la désinstallation doit purger les données (tables/options).
     *
     * IMPORTANT : pendant les phases de tests, il est fréquent de supprimer/réinstaller le plugin.
     * Par défaut, on ne purge PAS pour éviter toute perte (signature médecin, historique, etc.).
     */
    public static function should_purge_on_uninstall(): bool
    {
        // v1.7.8+: hard safety switch (preferred).
        if (defined('SOSPRESCRIPTION_NUKE_ON_UNINSTALL') && SOSPRESCRIPTION_NUKE_ON_UNINSTALL === true) {
            return true;
        }


        if (defined('SOSPRESCRIPTION_PURGE_ON_UNINSTALL') && SOSPRESCRIPTION_PURGE_ON_UNINSTALL) {
            return true;
        }

        $opt = get_option('sosprescription_purge_on_uninstall', 'no');
        return ($opt === 'yes' || $opt === '1' || $opt === 1 || $opt === true);
    }

    /**
     * Callback utilisé par uninstall.php et/ou register_uninstall_hook().
     */
    public static function uninstall_hook(): void
    {
        if (!self::should_purge_on_uninstall()) {
            // On conserve les données (comportement par défaut).
            return;
        }

        self::uninstall();
    }
    public static function uninstall(): void
    {
        global $wpdb;

        $tables = [
            Db::table('prescriptions'),
            Db::table('prescription_items'),
            Db::table('files'),
            Db::table('prescription_messages'),
			Db::table('audit'),
            Db::table('cis'),
            Db::table('cip'),
            Db::table('compo'),
            Db::table('has_smr'),
            Db::table('has_asmr'),
            Db::table('gener'),
            Db::table('cpd'),
            Db::table('info'),
            Db::table('dispo'),
            Db::table('mitm'),
        ];

        foreach ($tables as $table) {
            // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
            $wpdb->query("DROP TABLE IF EXISTS {$table}");
        }

        delete_option('sosprescription_db_version');
        delete_option('sosprescription_import_state');
        delete_option('sosprescription_pricing');
        delete_option('sosprescription_stripe');
		delete_option('sosprescription_notifications');
		delete_option('sosprescription_compliance');
        delete_option('sosprescription_whitelist');
        delete_option('sosprescription_notices');
        delete_option('sosprescription_ocr');
        delete_option('sosprescription_ocr_client_enabled');
        delete_option('sosprescription_ocr_client_debug');
		delete_option('sosprescription_pages');
		wp_clear_scheduled_hook(\SosPrescription\Services\Retention::CRON_HOOK);

        // On ne supprime pas automatiquement le rôle pour éviter de casser une installation existante.
    }
}
