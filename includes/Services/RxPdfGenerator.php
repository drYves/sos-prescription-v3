<?php
declare(strict_types=1);

namespace SosPrescription\Services;

use DateTimeImmutable;
use SosPrescription\Db;
use SosPrescription\Repositories\FileRepository;
use SosPrescription\Repositories\PrescriptionRepository;
use SosPrescription\Utils\Date;
use WP_Error;

/**
 * Génération d'une ordonnance PDF "serveur" (MVP).
 *
 * Objectifs :
 * - produire un PDF téléchargeable par le patient (stockage privé + route REST protégée),
 * - inclure les informations prescripteur/patient + liste des médicaments,
 * - optionnel : intégrer une signature image (JPG/PNG via conversion JPEG si possible).
 *
 * IMPORTANT (MVP) :
 * - Ce PDF n'est pas une e-prescription SESAM-Vitale.
 * - Il ne remplace pas une signature électronique qualifiée.
 */
final class RxPdfGenerator
{
    // A4 en points (1/72 inch)
    private const PAGE_W = 595.28;
    private const PAGE_H = 841.89;

    /**
     * Base mPDF configuration (single source of truth).
     *
     * NOTE: We keep this minimal and stable for "pixel-perfect" ordonnance rendering.
     */
    private static function mpdf_config_base(): array
    {
        return [
            'mode' => 'utf-8',
            'format' => 'A4',
            // v1.7.4: calibration finale "pixel perfect".
            // Les audits ont montré que 18mm pénalisait trop la zone utile.
            // On passe à 12mm tout en conservant des marges haut/bas confortables.
            'margin_left' => 12,
            'margin_right' => 12,
            'margin_top' => 18,
            'margin_bottom' => 18,
            // mPDF : keep tables stable (critical for "pixel-perfect" ordonnance).
            // Required by our layout strategy: strict table layout + fixed mm units.
            'shrink_tables_to_fit' => 1,
            'default_font' => 'dejavusans',
        ];
    }

    /**
     * Expose (sanitized) mPDF config for Admin "Audit Config" tooling.
     *
     * @return array<string, mixed>
     */
    public static function debug_get_mpdf_config(): array
    {
        $cfg = self::mpdf_config_base();

        // Compute a tempDir compatible with shared hosting (Hostinger) and VPS (AWS/Bitnami).
        $uploads  = function_exists('wp_upload_dir') ? wp_upload_dir() : [];
        $base_dir = is_array($uploads) ? (string) ($uploads['basedir'] ?? '') : '';
        $base_dir = rtrim($base_dir, '/');

        // Default to our private uploads directory so we can keep permissions predictable.
        $tmp = ($base_dir !== '')
            ? ($base_dir . '/sosprescription-private/mpdf-tmp')
            : (rtrim((string) sys_get_temp_dir(), '/') . '/sosprescription-mpdf');

        // Try to create the directory (never fatal in audit mode).
        if (!is_dir($tmp)) {
            if (function_exists('wp_mkdir_p')) {
                @wp_mkdir_p($tmp);
            } else {
                @mkdir($tmp, 0755, true);
            }
        }

        // Always report the computed path in the audit output.
        $cfg['tempDir'] = $tmp;

        return $cfg;
    }


    /**
     * @return array<string, mixed>|WP_Error
     */
    public static function generate(int $prescription_id, int $doctor_user_id): array|WP_Error
    {
        if ($prescription_id < 1) {
            return new WP_Error('sosprescription_bad_id', 'ID invalide.', ['status' => 400]);
        }
        if ($doctor_user_id < 1) {
            return new WP_Error('sosprescription_bad_doctor', 'Médecin invalide.', ['status' => 400]);
        }

        $rxRepo = new PrescriptionRepository();
        // Keep repositories defined even if optional branches (signature, auto-repair)
        // are skipped. This avoids undefined/null variable fatals.
        $files_repo = new FileRepository();
        $rx = $rxRepo->get($prescription_id);
        if (!$rx) {
            return new WP_Error('sosprescription_not_found', 'Prescription introuvable.', ['status' => 404]);
        }

        $payload = isset($rx['payload']) && is_array($rx['payload']) ? $rx['payload'] : [];
        $patient = isset($payload['patient']) && is_array($payload['patient']) ? $payload['patient'] : [];

        $patient_name = trim((string) ($patient['fullname'] ?? ''));
        $patient_birth = trim((string) ($patient['birthdate'] ?? ''));
        $patient_note = trim((string) ($patient['note'] ?? ''));

        // Compte utilisateur associé au patient (pour réutiliser les données profil : poids, taille, etc.)
        // NOTE : ce champ existe dans la table des ordonnances (patient_user_id).
        $patient_user_id = (int) ($rx['patient_user_id'] ?? 0);

        if ($patient_name === '') {
            $patient_name = 'Patient';
        }

        $uid = isset($rx['uid']) ? (string) $rx['uid'] : ('RX-' . (string) $prescription_id);

        $doctor = get_userdata($doctor_user_id);
        if (!$doctor) {
            return new WP_Error('sosprescription_doctor_missing', 'Médecin introuvable.', ['status' => 404]);
        }

        $doc_name = trim((string) $doctor->display_name);
        if ($doc_name === '') {
            $doc_name = 'Médecin';
        }

        // Métadonnées profil médecin (via DoctorAccountShortcode)
        // If not configured yet, default to "Docteur" so the header stays consistent.
        $doctor_title = (string) get_user_meta($doctor_user_id, 'sosprescription_doctor_title', true);
        if (trim($doctor_title) === '') {
            $doctor_title = 'docteur';
        }
        $rpps = (string) get_user_meta($doctor_user_id, 'sosprescription_rpps', true);
        $specialty = (string) get_user_meta($doctor_user_id, 'sosprescription_specialty', true);
        $address = (string) get_user_meta($doctor_user_id, 'sosprescription_professional_address', true);
        $phone = (string) get_user_meta($doctor_user_id, 'sosprescription_professional_phone', true);
        $sig_file_id = (int) get_user_meta($doctor_user_id, 'sosprescription_signature_file_id', true);

        // Auto-réparation (robustesse):
        // Si la meta n'est pas renseignée mais qu'un fichier de signature existe déjà
        // dans notre stockage privé, on l'utilise automatiquement et on met à jour la meta.
        if ($sig_file_id <= 0 && $doctor_user_id > 0) {
            // Auto-réparation : si une signature a été uploadée mais non liée au compte,
            // on récupère la plus récente et on la rattache au profil.
            try {
                $latest_sig = $files_repo->find_latest_for_owner_purpose($doctor_user_id, 'doctor_signature');
                if (is_array($latest_sig) && !empty($latest_sig['id'])) {
                    $sig_file_id = (int) $latest_sig['id'];
                    if ($sig_file_id > 0) {
                        update_user_meta($doctor_user_id, 'sosprescription_signature_file_id', (string) $sig_file_id);
                    }
                }
            } catch (\Throwable $e) {
                // best-effort : pas bloquant
            }
        }

        // Bloc "premium" (facultatif)
        $diploma_label = (string) get_user_meta($doctor_user_id, 'sosprescription_diploma_label', true);
        $diploma_university = (string) get_user_meta($doctor_user_id, 'sosprescription_diploma_university_location', true);
        $diploma_honors = (string) get_user_meta($doctor_user_id, 'sosprescription_diploma_honors', true);
        $issue_place = (string) get_user_meta($doctor_user_id, 'sosprescription_issue_place', true);

        // Ligne unique de diplôme affichée sur l'ordonnance (objectif : rendu "Premium")
        // Exemple attendu : "Diplômé de la Faculté de médecine Paris XIII • Lauréat de l'Académie"
        $diploma_line_parts = [];
        $diploma_label = trim($diploma_label);
        $diploma_university = trim($diploma_university);
        $diploma_honors = trim($diploma_honors);

        // Compat / confort : certains médecins ont saisi la faculté directement dans le champ « spécialité »
        // (ex: « Médecine d'urgence Paris XIII »). Si aucune faculté n'est renseignée, on tente
        // d'extraire un suffixe « Paris + num. romain » pour :
        //  - alléger la ligne spécialité dans l'en-tête
        //  - alimenter le bloc diplôme (rendu premium)
        if ($diploma_university === '' && $specialty !== '') {
            if (preg_match('/\b(Paris\s+[IVXLCDM]+)\b/ui', $specialty, $m)) {
                $diploma_university = trim((string) $m[1]);
                $specialty = trim(preg_replace('/\b' . preg_quote($m[1], '/') . '\b/ui', '', $specialty));
                $specialty = trim(preg_replace('/\s{2,}/u', ' ', $specialty));
            }
        }

        // Heuristique (compatibilité) : si le champ 'label' a été utilisé pour répéter la spécialité,
        // on l'ignore afin d'afficher une vraie ligne de diplôme.
        // Exemple : label='Médecine d'urgence' + université='Paris XIII' => 'Diplômé de la Faculté de médecine Paris XIII'.
        $norm_label = strtolower(preg_replace('/\s+/', ' ', $diploma_label));
        $norm_spec  = strtolower(preg_replace('/\s+/', ' ', trim((string) $specialty)));
        if ($diploma_label !== '' && $diploma_university !== '' && $diploma_honors === '' && $norm_label === $norm_spec) {
            $diploma_label = '';
        }

        if ($diploma_label !== '') {
            $diploma_line_parts[] = trim($diploma_label . ($diploma_university !== '' ? (' ' . $diploma_university) : ''));
        } elseif ($diploma_university !== '') {
            $diploma_line_parts[] = 'Diplômé de la Faculté de médecine ' . $diploma_university;
        }

        if ($diploma_honors !== '') {
            $diploma_line_parts[] = $diploma_honors;
        }

        $doctor_diploma_line = implode(' • ', array_values(array_filter($diploma_line_parts, static function ($v) {
            return trim((string) $v) !== '';
        })));

        $items = isset($rx['items']) && is_array($rx['items']) ? $rx['items'] : [];

        $now_ts = (int) current_time('timestamp');
        $date_str = date_i18n('d/m/Y', $now_ts);

        $sig = null;
        if ($sig_file_id > 0) {
            // 1) Prefer JPEG normalised (stable rendering across PDF engines)
            $sig = self::load_signature_as_jpeg($sig_file_id);

            // 2) Fallback: use the original bytes if conversion failed (keeps signature visible)
            if (empty($sig) || empty($sig['bytes'])) {
                // Prefer the MIME stored in DB (more reliable than mime_content_type on some hosts).
                $sig_row = $files_repo->get($sig_file_id);
                $sig_mime = is_array($sig_row) ? (string) ($sig_row['mime'] ?? '') : '';

                $abs = $files_repo->get_file_absolute_path($sig_file_id);
                if (!is_wp_error($abs) && is_string($abs) && is_file($abs)) {
                    $raw_bytes = @file_get_contents($abs);
                    if (is_string($raw_bytes) && $raw_bytes !== '') {
                        $type = 'jpeg';

                        // 1) DB mime
                        if ($sig_mime === 'image/png') {
                            $type = 'png';
                        } elseif ($sig_mime === 'image/jpeg' || $sig_mime === 'image/jpg') {
                            $type = 'jpeg';
                        } else {
                            // 2) Magic-bytes detection (fallback)
                            if (substr($raw_bytes, 0, 8) === "\x89PNG\r\n\x1A\n") {
                                $type = 'png';
                            } elseif (substr($raw_bytes, 0, 2) === "\xFF\xD8") {
                                $type = 'jpeg';
                            }
                        }
                        $sig = [
                            'type'  => $type,
                            'bytes' => $raw_bytes,
                        ];
                    }
                }
            }
        }

        // Données patient enrichies (si disponibles)
        // IMPORTANT : sur certains environnements, l'ID peut être vide (invité). On sécurise.
        // IMPORTANT : compat meta (ancienne clé sosprescription_patient_* vs nouvelles clés sosp_*).
        $patient_weight_raw = $patient_user_id > 0 ? get_user_meta($patient_user_id, 'sosp_weight_kg', true) : '';
        if ($patient_weight_raw === '' && $patient_user_id > 0) {
            $patient_weight_raw = get_user_meta($patient_user_id, 'sosprescription_patient_weight_kg', true);
        }
        $patient_weight = is_numeric($patient_weight_raw) ? (string) $patient_weight_raw : '';

        $patient_height_raw = $patient_user_id > 0 ? get_user_meta($patient_user_id, 'sosp_height_cm', true) : '';
        if ($patient_height_raw === '' && $patient_user_id > 0) {
            $patient_height_raw = get_user_meta($patient_user_id, 'sosprescription_patient_height_cm', true);
        }
        $patient_height = is_numeric($patient_height_raw) ? (string) $patient_height_raw : '';

        $verification = self::ensure_verification_payload(
            $prescription_id,
            (string) $uid,
            (string) $rpps,
            (string) $patient_name,
            (string) $patient_birth,
            $items
        );

        // --- Préparation des champs "premium" attendus par le template PDF ---
        $verify_url = trim((string) ($verification['url'] ?? ''));
        $verify_code = trim((string) ($verification['code'] ?? ''));
        $verify_hash_short = trim((string) ($verification['hash_short'] ?? ''));
        $verify_rx_public_id = trim((string) ($verification['rx_public_id'] ?? ''));
        $checksum_med_count = (int) ($verification['med_count'] ?? count($items));

        $patient_birthdate_label = '';
        $birth_raw = trim((string) $patient_birth);
        if ($birth_raw !== '') {
            $dt = null;
            if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $birth_raw)) {
                $dt = DateTimeImmutable::createFromFormat('Y-m-d', $birth_raw);
            } elseif (preg_match('/^\d{2}\/\d{2}\/\d{4}$/', $birth_raw)) {
                $dt = DateTimeImmutable::createFromFormat('d/m/Y', $birth_raw);
            }
            if ($dt instanceof DateTimeImmutable) {
                $birth_fr = $dt->format('d/m/Y');
                $age = (int) $dt->diff((new DateTimeImmutable('@' . $now_ts)))->y;
                $patient_birthdate_label = trim($birth_fr . ' (' . $age . ' ans)');
            }
        }
        if ($patient_birthdate_label === '') {
            $patient_birthdate_label = '—';
        }

        $patient_weight_height_label = '—';
        $w = trim(is_scalar($patient_weight) ? (string) $patient_weight : '');
        $h = trim(is_scalar($patient_height) ? (string) $patient_height : '');
        $wh_parts = [];
        if ($w !== '') {
            $wh_parts[] = $w . ' kg';
        }
        if ($h !== '') {
            $wh_parts[] = $h . ' cm';
        }
        if (!empty($wh_parts)) {
            $patient_weight_height_label = implode(' / ', $wh_parts);
        }

        $qr_jpeg_bytes_base64 = '';
        if ($verify_url !== '') {
            $qr_jpeg = self::generate_qr_jpeg_bytes($verify_url);
            if (is_string($qr_jpeg) && $qr_jpeg !== '') {
                $qr_jpeg_bytes_base64 = base64_encode($qr_jpeg);
            }
        }

        $barcode_jpeg_bytes_base64 = '';
        $rpps_clean = preg_replace('/\s+/', '', (string) $rpps);
        if (is_string($rpps_clean) && $rpps_clean !== '') {
            $bar_jpeg = self::generate_code39_jpeg_bytes($rpps_clean);
            if (is_string($bar_jpeg) && $bar_jpeg !== '') {
                $barcode_jpeg_bytes_base64 = base64_encode($bar_jpeg);
            }
        }

        // Normalise la signature pour le moteur PDF (attend "bytes").
        $sig_for_pdf = null;
        if (is_array($sig)) {
            if (!empty($sig['bytes']) && is_string($sig['bytes'])) {
                $sig_for_pdf = $sig;
            } elseif (!empty($sig['jpeg_bytes_base64']) && is_string($sig['jpeg_bytes_base64'])) {
                $decoded = base64_decode($sig['jpeg_bytes_base64'], true);
                if (is_string($decoded) && $decoded !== '') {
                    $sig_for_pdf = [
                        'type' => 'jpeg',
                        'bytes' => $decoded,
                    ];
                }
            }
        }

        // PDF rendering engine
        // - Primary: mPDF (HTML/CSS) if installed (vendor/autoload.php) or already loaded
        // - Fallback: legacy minimal PDF renderer (pure PHP) to avoid hard failures
        $use_mpdf = self::ensure_mpdf_loaded();

        $pdf_bytes = $use_mpdf
            ? self::build_pdf_bytes_mpdf([
                'uid' => $uid,
                'date' => $date_str,
                'patient_name' => $patient_name,
                'patient_birth' => $patient_birth,
                'patient_note' => $patient_note,
                'patient_weight' => is_scalar($patient_weight) ? (string) $patient_weight : '',
                'patient_height' => is_scalar($patient_height) ? (string) $patient_height : '',
                'patient_birthdate_label' => $patient_birthdate_label,
                'patient_weight_height_label' => $patient_weight_height_label,
                'doctor_name' => $doc_name,
                'doctor_title' => $doctor_title,
                'doctor_rpps' => $rpps,
                'doctor_specialty' => $specialty,
                'doctor_address' => $address,
                'doctor_phone' => $phone,
                'doctor_diploma_label' => $diploma_label,
                'doctor_diploma_university_location' => $diploma_university,
                'doctor_diploma_honors' => $diploma_honors,
                'issue_place' => $issue_place,
                'doctor_diploma_line' => $doctor_diploma_line,
                'doctor_issue_place' => $issue_place,
                'created_fr' => $date_str,
                'verify_url' => $verify_url,
                'verify_code' => $verify_code,
                'verify_hash_short' => $verify_hash_short,
                'verify_rx_public_id' => $verify_rx_public_id,
                'checksum_med_count' => $checksum_med_count,
                'qr_jpeg_bytes_base64' => $qr_jpeg_bytes_base64,
                'barcode_jpeg_bytes_base64' => $barcode_jpeg_bytes_base64,
                'verification' => $verification,
                'items' => $items,
            ], $sig_for_pdf)
            : self::build_pdf_bytes([
            'uid' => $uid,
            'date' => $date_str,
            'patient_name' => $patient_name,
            'patient_birth' => $patient_birth,
            'patient_note' => $patient_note,
            'patient_weight' => is_scalar($patient_weight) ? (string) $patient_weight : '',
            'patient_height' => is_scalar($patient_height) ? (string) $patient_height : '',
            'patient_birthdate_label' => $patient_birthdate_label,
            'patient_weight_height_label' => $patient_weight_height_label,
            'doctor_name' => $doc_name,
            'doctor_title' => $doctor_title,
            'doctor_rpps' => $rpps,
            'doctor_specialty' => $specialty,
            'doctor_address' => $address,
            'doctor_phone' => $phone,
            'doctor_diploma_label' => $diploma_label,
            'doctor_diploma_university_location' => $diploma_university,
            'doctor_diploma_honors' => $diploma_honors,
            'issue_place' => $issue_place,
            'doctor_diploma_line' => $doctor_diploma_line,
            'doctor_issue_place' => $issue_place,
            'created_fr' => $date_str,
            'verify_url' => $verify_url,
            'verify_code' => $verify_code,
            'verify_hash_short' => $verify_hash_short,
            'verify_rx_public_id' => $verify_rx_public_id,
            'checksum_med_count' => $checksum_med_count,
            'qr_jpeg_bytes_base64' => $qr_jpeg_bytes_base64,
            'barcode_jpeg_bytes_base64' => $barcode_jpeg_bytes_base64,
            'verification' => $verification,
            'items' => $items,
        ], $sig_for_pdf);

        if (is_wp_error($pdf_bytes)) {
            return $pdf_bytes;
        }

        // Nom de fichier stable et lisible
        $safe_uid = preg_replace('/[^A-Za-z0-9_-]+/', '-', $uid);
        $safe_uid = $safe_uid ? trim((string) $safe_uid, '-') : (string) $prescription_id;
        $original_name = 'ordonnance-' . $safe_uid . '.pdf';

        $stored = FileStorage::store_contents($pdf_bytes, 'pdf', 'application/pdf', $original_name);
        if (is_wp_error($stored)) {
            return $stored;
        }

        $fileRepo = new FileRepository();
        $existing = $fileRepo->find_latest_for_prescription_purpose($prescription_id, 'rx_pdf');
        $created_at = current_time('mysql');

        if ($existing) {
            // Nettoie l'ancien fichier (best-effort)
            $old_key = isset($existing['storage_key']) ? (string) $existing['storage_key'] : '';
            if ($old_key !== '') {
                $old_path = FileStorage::safe_abs_path($old_key);
                if (!is_wp_error($old_path) && is_string($old_path) && is_file($old_path)) {
                    @unlink($old_path);
                }
            }

            $fileRepo->update((int) $existing['id'], [
                'mime' => 'application/pdf',
                'original_name' => $original_name,
                'storage_key' => (string) ($stored['storage_key'] ?? ''),
                'size_bytes' => (int) ($stored['size_bytes'] ?? 0),
                'created_at' => $created_at,
            ]);

            $file_id = (int) $existing['id'];
        } else {
            $created = $fileRepo->create(
                $doctor_user_id,
                $prescription_id,
                'rx_pdf',
                'application/pdf',
                $original_name,
                (string) ($stored['storage_key'] ?? ''),
                (int) ($stored['size_bytes'] ?? 0)
            );

            if (isset($created['error'])) {
                $abs = isset($stored['abs_path']) ? (string) $stored['abs_path'] : '';
                if ($abs !== '' && is_file($abs)) {
                    @unlink($abs);
                }
                return new WP_Error('sosprescription_db_error', 'Erreur DB (fichier ordonnance).', ['status' => 500]);
            }

            $file_id = (int) ($created['id'] ?? 0);
            $created_at = (string) ($created['created_at'] ?? $created_at);
        }

        return [
            'id' => $file_id,
            'prescription_id' => $prescription_id,
            'purpose' => 'rx_pdf',
            'mime' => 'application/pdf',
            'original_name' => $original_name,
            'size_bytes' => (int) ($stored['size_bytes'] ?? 0),
            'created_at' => $created_at,
            'download_url' => rest_url('sosprescription/v1/files/' . $file_id . '/download'),
        ];
    }

    /**
     * Rend le HTML final de l'ordonnance à partir du template fichier et d'un jeu de données.
     *
     * Utile pour :
     * - prévisualisation back-office (itérations rapides sur le template),
     * - diagnostic des tokens (si un champ ne sort pas dans le PDF).
     *
     * @param array<string,mixed> $data
     * @param array{type?:string,bytes?:string}|null $signature
     */
    public static function render_template_html(array $data, ?array $signature = null): string|WP_Error
    {
        return self::render_rx_html_mpdf_from_file($data, $signature);
    }

    /**
     * Génère des bytes PDF à partir du template fichier et d'un jeu de données.
     *
     * Utile pour :
     * - génération d'un PDF de démonstration (sans créer une prescription en base),
     * - tests de rendu mPDF (mêmes contraintes que la prod).
     *
     * @param array<string,mixed> $data
     * @param array{type?:string,bytes?:string}|null $signature
     */
    public static function build_pdf_bytes_from_data(array $data, ?array $signature = null): string|WP_Error
    {
        return self::build_pdf_bytes_mpdf($data, $signature);
    }


    /**
     * DEBUG: Renvoie le tableau associatif des variables injectées dans le template (sans générer de PDF).
     *
     * Utilisé par l'outil "Audit Config" du back-office (Templates & Troubleshooting).
     *
     * @param array<string,mixed> $data
     * @param array{type?:string,bytes?:string}|null $signature
     * @return array<string,string>
     */
    public static function debug_build_template_replacements(array $data, ?array $signature = null): array
    {
        return self::build_rx_template_replacements($data, $signature);
    }


    /**
     * Helper: generate a QR-code JPEG (base64) for a given text.
     *
     * Used by admin demo/preview tools so the template remains the single source of truth.
     */
    public static function generate_qr_jpeg_base64(string $text): string
    {
        $bytes = self::generate_qr_jpeg_bytes($text);
        if (!is_string($bytes) || $bytes === '') {
            return '';
        }
        return base64_encode($bytes);
    }

    /**
     * Assure l'existence des éléments de vérification (token QR + code à 6 chiffres)
     * et renvoie un payload prêt à être intégré au PDF.
     *
     * NB : le token est aléatoire (non dérivé de l'UID) pour éviter le brute-force.
     *
     * @param array<int, array<string, mixed>> $items
     * @return array{token:string,url:string,code:string,rx_public_id:string,hash_short:string,med_count:int}
     */
    private static function ensure_verification_payload(
        int $prescription_id,
        string $uid,
        string $doctor_rpps,
        string $patient_fullname,
        string $patient_birthdate,
        array $items
    ): array {
        global $wpdb;

        $table = Db::table('prescriptions');
        $row = $wpdb->get_row(
            $wpdb->prepare("SELECT verify_token, verify_code FROM {$table} WHERE id = %d LIMIT 1", $prescription_id),
            ARRAY_A
        );

        $token = isset($row['verify_token']) ? (string) $row['verify_token'] : '';
        $code = isset($row['verify_code']) ? (string) $row['verify_code'] : '';

        // Génération si absent
        if ($token === '') {
            try {
                // 48 caractères hex, aléatoire (24 bytes)
                $token = bin2hex(random_bytes(24));
            } catch (\Throwable $e) {
                // Fallback (moins robuste, mais évite un crash)
                $token = wp_generate_password(48, false, false);
            }
        }

        if ($code === '' || !preg_match('/^\d{6}$/', $code)) {
            $code = str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
        }

        // Si l'un des deux était absent, on persiste.
        if (!isset($row['verify_token']) || (string) $row['verify_token'] === '' || !isset($row['verify_code']) || (string) $row['verify_code'] === '') {
            $wpdb->update(
                $table,
                [
                    'verify_token' => $token,
                    'verify_code' => $code,
                    'updated_at' => current_time('mysql'),
                ],
                ['id' => $prescription_id],
                ['%s', '%s', '%s'],
                ['%d']
            );
        }

        // URL (format court /v/…)
        $url = home_url('/v/' . $token);

        // Identifiant "Premium" lisible (ex: RX-31EE58-53E2)
        $rx_public_id = 'RX-' . strtoupper(substr($token, 0, 6)) . '-' . strtoupper(substr($token, 6, 4));

        // Empreinte courte (pour vérification visuelle)
        $items_compact = [];
        foreach ($items as $it) {
            $items_compact[] = [
                'label' => isset($it['label']) ? (string) $it['label'] : '',
                'cip13' => isset($it['cip13']) ? (string) $it['cip13'] : '',
                'cis' => isset($it['cis']) ? (string) $it['cis'] : '',
                'schedule' => isset($it['schedule']) ? $it['schedule'] : null,
            ];
        }
        $hash_input = $uid . '|' . $doctor_rpps . '|' . $patient_fullname . '|' . $patient_birthdate . '|' . wp_json_encode($items_compact);
        $hash_short = strtoupper(substr(hash('sha256', $hash_input), 0, 12));

        return [
            'token' => $token,
            'url' => $url,
            'code' => $code,
            'rx_public_id' => $rx_public_id,
            'hash_short' => $hash_short,
            'med_count' => count($items),
        ];
    }

    /**
     * Charge la signature (JPG/PNG) et renvoie un JPEG binaire + dimensions.
     *
     * @return array{bytes:string,width:int,height:int}|null
     */
    private static function load_signature_as_jpeg(int $file_id): ?array
    {
        $repo = new FileRepository();
        $row = $repo->get($file_id);
        if (!$row) {
            return null;
        }

        $mime = isset($row['mime']) ? (string) $row['mime'] : '';
        $key = isset($row['storage_key']) ? (string) $row['storage_key'] : '';
        if ($key === '') {
            return null;
        }

        $path = FileStorage::safe_abs_path($key);
        if (is_wp_error($path) || !is_string($path) || !is_file($path)) {
            return null;
        }

        // JPEG : normaliser (ré-encodage) pour éviter les soucis de rendu (profil couleur, progressif, EXIF, etc.)
        // Objectif : un flux JPEG simple, léger et compatible avec les moteurs PDF (mPDF/Dompdf).
        if ($mime === 'image/jpeg' || $mime === 'image/jpg') {
            // Préférence: GD -> re-encode + downscale
            if (function_exists('imagecreatefromjpeg') && function_exists('imagejpeg')) {
                $src = @imagecreatefromjpeg($path);
                if ($src) {
                    $w = imagesx($src);
                    $h = imagesy($src);

                    // Downscale si trop grand (signature = visuel petit, inutile d'avoir une image énorme)
                    $max_w = 1000;
                    $scale = ($w > 0) ? min(1.0, $max_w / (float) $w) : 1.0;
                    $tw = (int) max(1, round($w * $scale));
                    $th = (int) max(1, round($h * $scale));

                    $dst = imagecreatetruecolor($tw, $th);
                    if ($dst) {
                        imagecopyresampled($dst, $src, 0, 0, 0, 0, $tw, $th, $w, $h);

                        ob_start();
                        imagejpeg($dst, null, 85);
                        $jpeg = (string) ob_get_clean();

                        imagedestroy($dst);
                        imagedestroy($src);

                        if ($jpeg !== '' && strpos($jpeg, "\xFF\xD8") === 0) {
                            return [
                                'bytes' => $jpeg,
                                'width' => $tw,
                                'height' => $th,
                            ];
                        }
                    }

                    imagedestroy($src);
                }
            }

            // Fallback: bytes bruts
            $bytes = @file_get_contents($path);
            $info = @getimagesize($path);
            if (!is_string($bytes) || $bytes === '' || !is_array($info)) {
                return null;
            }
            return [
                'bytes' => $bytes,
                'width' => isset($info[0]) ? (int) $info[0] : 0,
                'height' => isset($info[1]) ? (int) $info[1] : 0,
            ];
        }

        // PNG : conversion vers JPEG si GD dispo
        if ($mime === 'image/png' && function_exists('imagecreatefrompng') && function_exists('imagejpeg')) {
            $src = @imagecreatefrompng($path);
            if (!$src) {
                return null;
            }

            $w = imagesx($src);
            $h = imagesy($src);

            // Downscale si trop grand
            $max_w = 800;
            $scale = ($w > 0) ? min(1.0, $max_w / (float) $w) : 1.0;
            $tw = (int) max(1, round($w * $scale));
            $th = (int) max(1, round($h * $scale));

            $dst = imagecreatetruecolor($tw, $th);
            if (!$dst) {
                imagedestroy($src);
                return null;
            }

            // fond blanc
            $white = imagecolorallocate($dst, 255, 255, 255);
            imagefilledrectangle($dst, 0, 0, $tw, $th, $white);
            imagecopyresampled($dst, $src, 0, 0, 0, 0, $tw, $th, $w, $h);

            ob_start();
            imagejpeg($dst, null, 85);
            $jpeg = (string) ob_get_clean();

            imagedestroy($src);
            imagedestroy($dst);

            if ($jpeg === '') {
                return null;
            }

            return [
                'bytes' => $jpeg,
                'width' => $tw,
                'height' => $th,
            ];
        }

        return null;
    }

    /**
     * Génère un QR code en JPEG.
     *
     * Objectif: un QR scannable sur serveur mutualisé (Hostinger) sans dépendre
     * des delegates ImageMagick ("qr:") qui ne sont pas toujours compilés.
     *
     * Stratégie:
     * 1) Utiliser une lib pure-PHP (phpqrcode) embarquée dans le plugin
     *    (GD requis, déjà présent sur la majorité des hébergements).
     * 2) Fallback Imagick si présent.
     * 3) Dernier recours: placeholder visuel (non scannable) afin de ne pas
     *    casser la génération PDF.
     */
    private static function generate_qr_jpeg_bytes(string $text, int $size_px = 360): ?string
    {
        $text = trim($text);
        if ($text === '') {
            return null;
        }

        // 1) Lib pure PHP (phpqrcode) -> PNG -> JPEG
        $png = '';
        $lib = dirname(__DIR__) . '/Lib/phpqrcode/phpqrcode.php';
        if (is_file($lib)) {
            try {
                if (!class_exists('QRcode')) {
                    require_once $lib;
                }
                if (class_exists('QRcode')) {
                    // EC Level M + module size 4 + marge 2 -> bon compromis pour QR URL courte.
                    // ⚠️ Important : ne pas utiliser outfile=false car phpqrcode envoie un header Content-Type: image/png
                    // (et cela casse le rendu HTML des pages admin). On génère donc dans un fichier temporaire.
                    $tmp = @tempnam(sys_get_temp_dir(), 'spqr_');

                    // Fallback hébergements mutualisés : tenter un tmp dans uploads si /tmp est restreint.
                    if (!is_string($tmp) || $tmp === '') {
                        if (function_exists('wp_upload_dir')) {
                            $up = wp_upload_dir(null, false, false);
                            if (is_array($up) && !empty($up['basedir'])) {
                                $dir = rtrim((string) $up['basedir'], '/\\') . '/sosprescription-private/tmp';
                                if (function_exists('wp_mkdir_p')) {
                                    @wp_mkdir_p($dir);
                                } elseif (!is_dir($dir)) {
                                    @mkdir($dir, 0775, true);
                                }
                                $tmp = @tempnam($dir, 'spqr_');
                            }
                        }
                    }

                    if (is_string($tmp) && $tmp !== '') {
                        \QRcode::png($text, $tmp, QR_ECLEVEL_M, 4, 2);
                        $png = (string) @file_get_contents($tmp);
                        @unlink($tmp);
                    }
                }
            } catch (\Throwable $e) {
                if (ob_get_level() > 0) {
                    @ob_end_clean();
                }
                $png = '';
            }
        }

        if ($png !== '' && function_exists('imagecreatefromstring') && function_exists('imagejpeg')) {
            $src = @imagecreatefromstring($png);
            if ($src !== false) {
                $w = imagesx($src);
                $h = imagesy($src);

                // Optionnel: redimensionnement (sans lissage excessif)
                $tw = (int) max(1, $size_px);
                $th = (int) max(1, $size_px);
                $dst = imagecreatetruecolor($tw, $th);
                if ($dst !== false) {
                    $white = imagecolorallocate($dst, 255, 255, 255);
                    imagefilledrectangle($dst, 0, 0, $tw - 1, $th - 1, $white);

                    // Interpolation neutre (évite le flou sur les modules)
                    if (function_exists('imagesetinterpolation')) {
                        @imagesetinterpolation($dst, IMG_NEAREST_NEIGHBOUR);
                    }

                    imagecopyresampled($dst, $src, 0, 0, 0, 0, $tw, $th, $w, $h);

                    ob_start();
                    imagejpeg($dst, null, 100);
                    $jpg = (string) ob_get_clean();
                    imagedestroy($dst);
                    imagedestroy($src);

                    if ($jpg !== '' && strpos($jpg, "\xFF\xD8") === 0) {
                        return $jpg;
                    }
                }

                imagedestroy($src);
            }
        }

        // 2) Tentative Imagick (si le serveur supporte "qr:" via delegates)
        if (class_exists('Imagick')) {
            try {
                $im = new \Imagick();
                $im->setBackgroundColor('white');
                $im->readImage('qr:' . $text);
                if (method_exists($im, 'setImageAlphaChannel')) {
                    $im->setImageAlphaChannel(\Imagick::ALPHACHANNEL_REMOVE);
                }
                $im->setImageBackgroundColor('white');
                $im->resizeImage($size_px, $size_px, \Imagick::FILTER_LANCZOS, 1, true);
                $im->setImageFormat('jpeg');
                $blob = $im->getImageBlob();
                $im->clear();
                $im->destroy();
                if (is_string($blob) && strlen($blob) > 1000) {
                    return $blob;
                }
            } catch (\Throwable $e) {
                // Continue to fallback
            }
        }

        // 3) Fallback : placeholder (ne scanne pas) mais évite une 500.
        if (function_exists('imagecreatetruecolor') && function_exists('imagejpeg')) {
            $im = imagecreatetruecolor($size_px, $size_px);
            if (!$im) {
                return null;
            }
            $white = imagecolorallocate($im, 255, 255, 255);
            $black = imagecolorallocate($im, 17, 24, 39);
            $gray = imagecolorallocate($im, 229, 231, 235);
            imagefilledrectangle($im, 0, 0, $size_px - 1, $size_px - 1, $white);
            imagerectangle($im, 0, 0, $size_px - 1, $size_px - 1, $gray);
            imagestring($im, 5, (int) ($size_px / 2) - 16, (int) ($size_px / 2) - 8, 'QR', $black);
            ob_start();
            imagejpeg($im, null, 90);
            $blob = (string) ob_get_clean();
            imagedestroy($im);
            return $blob !== '' ? $blob : null;
        }

        return null;
    }

    /**
     * Génère un code-barres Code39 (compatible douchettes) au format JPEG.
     *
     * Objectif : remplacer le rendu texte "*RPPS*" (non scannable) par un vrai
     * code-barres, sans dépendance lourde.
     */
    private static function generate_code39_jpeg_bytes(string $data, int $height_px = 70, int $narrow = 2, int $wide = 5, int $quiet = 10): ?string
    {
        $data = strtoupper(trim($data));
        if ($data === '') {
            return null;
        }

        // Table Code39 (n=narrow, w=wide). Pattern = 9 éléments (bar/space alternés, commence par bar).
        $p = [
            '0' => 'nnnwwnwnn',
            '1' => 'wnnwnnnnw',
            '2' => 'nnwwnnnnw',
            '3' => 'wnwwnnnnn',
            '4' => 'nnnwwnnnw',
            '5' => 'wnnwwnnnn',
            '6' => 'nnwwwnnnn',
            '7' => 'nnnwnnwnw',
            '8' => 'wnnwnnwnn',
            '9' => 'nnwwnnwnn',
            'A' => 'wnnnnwnnw',
            'B' => 'nnwnnwnnw',
            'C' => 'wnwnnwnnn',
            'D' => 'nnnnwwnnw',
            'E' => 'wnnnwwnnn',
            'F' => 'nnwnwwnnn',
            'G' => 'nnnnnwwnw',
            'H' => 'wnnnnwwnn',
            'I' => 'nnwnnwwnn',
            'J' => 'nnnnwwwnn',
            'K' => 'wnnnnnnww',
            'L' => 'nnwnnnnww',
            'M' => 'wnwnnnnwn',
            'N' => 'nnnnwnnww',
            'O' => 'wnnnwnnwn',
            'P' => 'nnwnwnnwn',
            'Q' => 'nnnnnnwww',
            'R' => 'wnnnnnwwn',
            'S' => 'nnwnnnwwn',
            'T' => 'nnnnwnwwn',
            'U' => 'wwnnnnnnw',
            'V' => 'nwwnnnnnw',
            'W' => 'wwwnnnnnn',
            'X' => 'nwnnwnnnw',
            'Y' => 'wwnnwnnnn',
            'Z' => 'nwwnwnnnn',
            '-' => 'nwnnnnwnw',
            '.' => 'wwnnnnwnn',
            ' ' => 'nwwnnnwnn',
            '$' => 'nwnwnwnnn',
            '/' => 'nwnwnnnwn',
            '+' => 'nwnnnwnwn',
            '%' => 'nnnwnwnwn',
            '*' => 'nwnnwnwnn',
        ];

        // Filtre des caractères non supportés.
        $filtered = '';
        for ($i = 0; $i < strlen($data); $i++) {
            $ch = $data[$i];
            if (isset($p[$ch]) && $ch !== '*') {
                $filtered .= $ch;
            }
        }
        if ($filtered === '') {
            return null;
        }

        $encoded = '*' . $filtered . '*';

        // Calcule largeur totale.
        $width = $quiet * 2;
        $gap = $narrow; // inter-char gap
        for ($i = 0; $i < strlen($encoded); $i++) {
            $pattern = $p[$encoded[$i]];
            for ($j = 0; $j < 9; $j++) {
                $width += ($pattern[$j] === 'w') ? $wide : $narrow;
            }
            if ($i < strlen($encoded) - 1) {
                $width += $gap;
            }
        }

        if (!function_exists('imagecreatetruecolor')) {
            return null;
        }

        $img = imagecreatetruecolor($width, $height_px);
        if (!$img) {
            return null;
        }

        $white = imagecolorallocate($img, 255, 255, 255);
        $black = imagecolorallocate($img, 0, 0, 0);
        imagefill($img, 0, 0, $white);

        // Dessine barres.
        $x = $quiet;
        $bar_top = 2;
        $bar_bottom = $height_px - 2;
        for ($i = 0; $i < strlen($encoded); $i++) {
            $pattern = $p[$encoded[$i]];
            for ($j = 0; $j < 9; $j++) {
                $w = ($pattern[$j] === 'w') ? $wide : $narrow;
                $is_bar = ($j % 2 === 0);
                if ($is_bar) {
                    imagefilledrectangle($img, $x, $bar_top, $x + $w - 1, $bar_bottom, $black);
                }
                $x += $w;
            }
            if ($i < strlen($encoded) - 1) {
                $x += $gap;
            }
        }

        ob_start();
        imagejpeg($img, null, 100);
        $jpeg = (string) ob_get_clean();
        imagedestroy($img);

        if ($jpeg === '' || substr($jpeg, 0, 2) !== "\xFF\xD8") {
            return null;
        }

        return $jpeg;
    }

    /**
     * @param array<string, mixed> $data
     * @param array{bytes:string,width:int,height:int}|null $signature
     */
    
    /**
     * Génère un PDF "Premium" (look & feel aligné sur le template HTML FINAL).
     * L'objectif est un rendu moderne, aéré et "dashboard médical".
     */
    
    /**
     * Génère un PDF "Premium" (look & feel aligné sur Ordonnance-Template-FINAL.html).
     * Objectif : obtenir un rendu très proche du template HTML, sans moteur HTML->PDF (compat serveur mutualisé).
     */
    /**
     * Best-effort loader for mPDF.
     *
     * - If the class already exists, we consider it available.
     * - Otherwise, try to require plugin-local vendor/autoload.php (if present).
     *
     * This keeps the plugin deployable on hosts where Composer is not available
     * (you can vendor the library locally and upload the vendor/ folder).
     */
    private static function ensure_mpdf_loaded(): bool
    {
        if (class_exists('Mpdf\\Mpdf')) {
            return true;
        }

        // Try to load Composer autoloader if bundled in the plugin.
        $root = dirname(__DIR__, 2);
        $autoload = $root . '/vendor/autoload.php';
        if (is_file($autoload)) {
            try {
                require_once $autoload;
            } catch (\Throwable $e) {
                // ignore
            }
        }

        return class_exists('Mpdf\\Mpdf');
    }

    /**
     * Premium PDF renderer using mPDF (HTML/CSS).
     *
     * IMPORTANT: mPDF has limited CSS support (no real Flexbox). The layout uses
     * tables for the header/patient cards for maximum fidelity and stability.
     *
     * @param array<string,mixed> $data
     * @param array{type?:string,bytes?:string}|null $signature
     */
    private static function build_pdf_bytes_mpdf(array $data, ?array $signature): string|WP_Error
    {
        if (!self::ensure_mpdf_loaded()) {
            return new WP_Error('sosprescription_mpdf_missing', 'mPDF non disponible. Installez mpdf/mpdf dans vendor/ ou via Composer.', ['status' => 500]);
        }

        // Guard: ensure we have the class.
        if (!class_exists('Mpdf\\Mpdf')) {
            return new WP_Error('sosprescription_mpdf_missing', 'mPDF non chargé (autoload manquant).', ['status' => 500]);
        }

        try {
            $uploads = wp_upload_dir();
            $tmp = rtrim((string) ($uploads['basedir'] ?? ''), '/') . '/sosprescription-private/mpdf-tmp';
            if ($tmp !== '') {
                if (!is_dir($tmp)) {
                    @wp_mkdir_p($tmp);
                }
            }

            $mpdfConfig = self::mpdf_config_base();
            if (is_string($tmp) && $tmp !== '' && is_dir($tmp) && is_writable($tmp)) {
                $mpdfConfig['tempDir'] = $tmp;
            }

            $mpdf = new \Mpdf\Mpdf($mpdfConfig);
            $mpdf->SetTitle('Ordonnance');
            $mpdf->SetAuthor((string) ($data['doctor_name'] ?? ''));

            // IMPORTANT : le template HTML est désormais chargé depuis un fichier .html
            // (et non codé en dur) pour permettre des itérations rapides sans toucher au PHP.
            // Voir : templates/rx-ordonnance-mpdf.html (par défaut) + override uploads.
            $tpl = self::render_rx_html_mpdf_from_file($data, $signature);
            if (is_wp_error($tpl)) {
                return $tpl;
            }

            // Extraction best-effort de <style>…</style> (mPDF gère mieux quand on lui passe la CSS en header)
            $css = '';
            if (preg_match_all('/<style[^>]*>(.*?)<\/style>/is', $tpl, $m)) {
                foreach ($m[1] as $chunk) {
                    if (is_string($chunk)) {
                        $css .= "\n" . $chunk;
                    }
                }
            }
            $body = $tpl;
            if (preg_match('/<body[^>]*>(.*?)<\/body>/is', $tpl, $m2)) {
                $body = (string) $m2[1];
            }

            // Sécurité : si le template n'a pas de <body>, il peut contenir des <style>.
            // On évite les doublons en supprimant les blocs <style> du body.
            $body_no_style = preg_replace('/<style[^>]*>.*?<\/style>/is', '', $body);
            if (is_string($body_no_style) && $body_no_style !== '') {
                $body = $body_no_style;
            }

            if (trim($css) !== '') {
                $mpdf->WriteHTML("<style>\n" . $css . "\n</style>", \Mpdf\HTMLParserMode::HEADER_CSS);
            }

            // Debug : visualiser les cellules/bords (admin option)
            if ((bool) get_option('sosprescription_mpdf_debug_borders', false)) {
                $mpdf->WriteHTML('td, th, div { border: 0.1mm solid red !important; }', \Mpdf\HTMLParserMode::HEADER_CSS);
            }
            $mpdf->WriteHTML($body, \Mpdf\HTMLParserMode::HTML_BODY);

            // Return bytes
            return $mpdf->Output('', \Mpdf\Output\Destination::STRING_RETURN);
        } catch (\Throwable $e) {
            return new WP_Error('sosprescription_mpdf_error', 'Erreur génération PDF (mPDF): ' . $e->getMessage(), ['status' => 500]);
        }
    }

    /**
     * Rend le HTML de l'ordonnance à partir d'un fichier template (editable).
     *
     * Priorité de résolution du template :
     * 1) filtre WP `sosprescription_rx_template_path`
     * 2) option WP `sosprescription_rx_template_path`
     * 3) fichier override dans uploads : /wp-content/uploads/sosprescription-templates/rx-ordonnance-mpdf.html
     * 4) template par défaut dans le plugin : /templates/rx-ordonnance-mpdf.html
     *
     * @param array<string,mixed> $data
     * @param array{type?:string,bytes?:string}|null $signature
     */
    private static function render_rx_html_mpdf_from_file(array $data, ?array $signature): string|WP_Error
    {
        $resolved = self::resolve_rx_template_path();
        $path = (string) ($resolved['path'] ?? '');
        $source = (string) ($resolved['source'] ?? '');

        if ($path === '' || !is_file($path) || !is_readable($path)) {
            // Fallback : ancien rendu (hardcoded) pour éviter de casser la prod.
            $css = self::render_rx_html_mpdf_styles();
            $body = self::render_rx_html_mpdf_body($data, $signature);
            return $css . "\n" . $body;
        }

        $tpl = @file_get_contents($path);
        if (!is_string($tpl) || $tpl === '') {
            return new WP_Error('sosprescription_rx_template_unreadable', 'Template ordonnance illisible : ' . basename($path), ['status' => 500]);
        }

        // Log (best-effort)
        try {
            $hash = substr(hash('sha256', $tpl), 0, 12);
            Logger::log_scoped('runtime', 'sosprescription_rxpdf', 'info', 'rx_template_loaded', [
                'template_source' => $source,
                'template_basename' => basename($path),
                'template_hash' => $hash,
            ]);
        } catch (\Throwable $e) {
            // ignore
        }

        // Build replacements
        $repl = self::build_rx_template_replacements($data, $signature);
        // Apply
        $out = strtr($tpl, $repl);

        return $out;
    }

    /**
     * Résout le chemin du template ordonnance.
     *
     * @return array{path:string,source:string}
     */
    private static function resolve_rx_template_path(): array
    {
        $default = SOSPRESCRIPTION_PATH . 'templates/rx-ordonnance-mpdf.html';

        // 1) Filter (dev override)
        $filtered = apply_filters('sosprescription_rx_template_path', '');
        if (is_string($filtered) && trim($filtered) !== '') {
            $p = trim($filtered);
            if (self::is_safe_template_path($p)) {
                return ['path' => $p, 'source' => 'filter'];
            }
        }

        // 2) Option (admin override)
        $opt = get_option('sosprescription_rx_template_path', '');
        if (is_string($opt) && trim($opt) !== '') {
            $p = trim($opt);
            if (self::is_safe_template_path($p)) {
                return ['path' => $p, 'source' => 'option'];
            }
        }

        // 3) Uploads override
        $uploads = wp_upload_dir();
        $basedir = rtrim((string) ($uploads['basedir'] ?? ''), '/');
        if ($basedir !== '') {
            $override = $basedir . '/sosprescription-templates/rx-ordonnance-mpdf.html';
            if (is_file($override) && is_readable($override)) {
                return ['path' => $override, 'source' => 'uploads_override'];
            }
        }

        // 4) Default
        return ['path' => $default, 'source' => 'plugin_default'];
    }

    /**
     * Valide qu'un chemin de template est "safe" (évite lecture de fichiers arbitraires).
     */
    private static function is_safe_template_path(string $path): bool
    {
        $path = trim($path);
        if ($path === '') {
            return false;
        }
        if (!preg_match('/\.(html?|xhtml)$/i', $path)) {
            return false;
        }
        // Must be absolute
        if ($path[0] !== '/' && !preg_match('/^[A-Za-z]:\\\\/', $path)) {
            return false;
        }
        // Restrict to plugin dir or uploads dir.
        $uploads = wp_upload_dir();
        $basedir = rtrim((string) ($uploads['basedir'] ?? ''), '/');
        $plugin = rtrim((string) SOSPRESCRIPTION_PATH, '/');
        $real = realpath($path);
        if ($real === false) {
            return false;
        }
        $real = (string) $real;
        if ($plugin !== '' && str_starts_with($real, $plugin)) {
            return true;
        }
        if ($basedir !== '' && str_starts_with($real, $basedir)) {
            return true;
        }
        return false;
    }

    /**
     * Construit le dictionnaire de remplacement {{TOKENS}} => valeurs.
     *
     * Convention :
     * - tokens texte => HTML-escaped (safe in text or attributes)
     * - tokens HTML => injectés tels quels (déjà échappés ou générés côté PHP)
     *
     * @param array<string,mixed> $data
     * @param array{type?:string,bytes?:string}|null $signature
     * @return array<string,string>
     */
    private static function build_rx_template_replacements(array $data, ?array $signature): array
    {
        $uid = (string) ($data['uid'] ?? '');
        $created_fr = (string) ($data['created_fr'] ?? '');

        $doctor_title = trim((string) ($data['doctor_title'] ?? ''));
        $doctor_name = trim((string) ($data['doctor_name'] ?? ''));
        $doctor_prefix = 'Dr';
        $doctor_title_lc = strtolower($doctor_title);
        if (in_array($doctor_title_lc, ['professeur', 'pr', 'prof', 'prof.'], true)) {
            $doctor_prefix = 'Pr';
        }
        $doctor_display = $doctor_name;
        if ($doctor_display === '') {
            $doctor_display = $doctor_prefix;
        } elseif (!preg_match('/^(Dr|Pr|Prof)\b/i', $doctor_display)) {
            $doctor_display = trim($doctor_prefix . ' ' . $doctor_display);
        }

        $specialty = trim((string) ($data['doctor_specialty'] ?? ''));
        $rpps = trim((string) ($data['doctor_rpps'] ?? ''));
        $address = trim((string) ($data['doctor_address'] ?? ''));
        $phone = trim((string) ($data['doctor_phone'] ?? ''));
        $diploma = trim((string) ($data['doctor_diploma_line'] ?? ''));
        $issue_place = trim((string) ($data['issue_place'] ?? ''));

        $patient_name = trim((string) ($data['patient_name'] ?? ''));
        $patient_birth_label = trim((string) ($data['patient_birthdate_label'] ?? ''));
        $patient_wh_label = trim((string) ($data['patient_weight_height_label'] ?? ''));
        if ($patient_birth_label === '') {
            $patient_birth_label = '—';
        }
        if ($patient_wh_label === '') {
            $patient_wh_label = '—';
        }

        $verify_url = trim((string) ($data['verify_url'] ?? ''));
        $verify_rx_public_id = trim((string) ($data['verify_rx_public_id'] ?? ''));
        $verify_hash_short = trim((string) ($data['verify_hash_short'] ?? ''));
        $verify_code = trim((string) ($data['verify_code'] ?? ''));
        $med_count = (int) ($data['checksum_med_count'] ?? 0);

        // Issue line
        $issue_line = '';
        if ($issue_place !== '' && $created_fr !== '') {
            $issue_line = 'Fait à ' . $issue_place . ', le ' . $created_fr;
        } elseif ($created_fr !== '') {
            $issue_line = 'Le ' . $created_fr;
        }

        // QR image (data-uri generated earlier)
        $qr_html = '';
        if (!empty($data['qr_jpeg_bytes_base64']) && is_string($data['qr_jpeg_bytes_base64'])) {
            $qr_data = 'data:image/jpeg;base64,' . $data['qr_jpeg_bytes_base64'];
            $qr_html = '<img class="qr-img" src="' . esc_attr($qr_data) . '" alt="QR code" width="18mm" height="18mm" style="width:18mm;height:18mm;" />';
        }

        // Barcode (mPDF native tag is the best)
        $barcode_html = '';
        if ($rpps !== '') {
            $barcode_html = '<barcode code="' . esc_attr($rpps) . '" type="C128A" size="0.9" height="1.2" />';
        }

        // Signature image as data-uri (best-effort)
        // NOTE: We always render something (image or small fallback text) so layout stays stable and
        // issues are visible during tests.
        $sig_data_uri = '';
        $sig_html = '';
        if (is_array($signature) && !empty($signature['bytes']) && is_string($signature['bytes'])) {
            $bytes = (string) $signature['bytes'];

            // 1) Try to infer from declared type (can be: png/jpeg or image/png|image/jpeg)
            $mime = '';
            if (!empty($signature['type']) && is_string($signature['type'])) {
                $t = strtolower(trim((string) $signature['type']));
                if ($t === 'png' || $t === 'image/png') {
                    $mime = 'image/png';
                } elseif ($t === 'jpeg' || $t === 'jpg' || $t === 'image/jpeg') {
                    $mime = 'image/jpeg';
                }
            }

            // 2) Fallback to magic bytes
            if ($mime === '') {
                if (substr($bytes, 0, 8) === "\x89PNG\r\n\x1A\n") {
                    $mime = 'image/png';
                } elseif (substr($bytes, 0, 2) === "\xFF\xD8") {
                    $mime = 'image/jpeg';
                }
            }

            // 3) Last resort
            if ($mime === '') {
                $mime = 'image/png';
            }

            $sig_data_uri = 'data:' . $mime . ';base64,' . base64_encode($bytes);
        }

        if ($sig_data_uri !== '') {
            // Signature: render in a fixed mm "box" to avoid DPI drift.
            // We preserve aspect ratio by fitting inside a 55x18mm box (contain).
            $box_w_mm = 55.0;
            $box_h_mm = 18.0;
            $w_mm = $box_w_mm;
            $h_mm = $box_h_mm;

            // Best-effort ratio detection (works on shared hosting, no Imagick required).
            if (function_exists('getimagesizefromstring')) {
                $info = @getimagesizefromstring($bytes);
                if (is_array($info) && !empty($info[0]) && !empty($info[1])) {
                    $px_w = (float) $info[0];
                    $px_h = (float) $info[1];
                    if ($px_w > 0.0 && $px_h > 0.0) {
                        $ratio = $px_w / $px_h;
                        $box_ratio = $box_w_mm / $box_h_mm;

                        if ($ratio >= $box_ratio) {
                            // Constrained by width
                            $w_mm = $box_w_mm;
                            $h_mm = $box_w_mm / $ratio;
                        } else {
                            // Constrained by height
                            $h_mm = $box_h_mm;
                            $w_mm = $box_h_mm * $ratio;
                        }
                    }
                }
            }

            // Clamp to sane bounds (avoid empty/NaN)
            if (!is_finite($w_mm) || $w_mm < 1.0) { $w_mm = $box_w_mm; }
            if (!is_finite($h_mm) || $h_mm < 1.0) { $h_mm = $box_h_mm; }
            if ($w_mm > $box_w_mm) { $w_mm = $box_w_mm; }
            if ($h_mm > $box_h_mm) { $h_mm = $box_h_mm; }

            $w_attr = rtrim(rtrim(number_format($w_mm, 2, '.', ''), '0'), '.');
            $h_attr = rtrim(rtrim(number_format($h_mm, 2, '.', ''), '0'), '.');

            $sig_html = '<div class="signature"><img class="sig-img" src="' . esc_attr($sig_data_uri) . '" alt="Signature" width="' . $w_attr . 'mm" height="' . $h_attr . 'mm" style="width:' . $w_attr . 'mm; height:' . $h_attr . 'mm; display:inline-block; vertical-align:top;" /></div>';
        } else {
            $sig_html = '<span class="sig-fallback">Signature non disponible</span>';
        }

        // Items HTML (table-based, stable)
        $items_html = '';
        $items = is_array($data['items'] ?? null) ? (array) $data['items'] : [];
        foreach ($items as $it) {
            if (!is_array($it)) {
                continue;
            }
            $name = trim((string) ($it['denomination'] ?? $it['name'] ?? ''));
            if ($name === '') {
                $name = 'Médicament';
            }
            $strength = trim((string) ($it['dosage_tag'] ?? $it['strength'] ?? ''));
            $form = trim((string) ($it['form_tag'] ?? $it['form'] ?? ''));
            $posology = trim((string) ($it['posologie'] ?? $it['posology'] ?? $it['posology_text'] ?? ''));

            $tags = '';
            if ($strength !== '') {
                $tags .= '<span class="med-tag">' . esc_html($strength) . '</span>';
            }
            if ($form !== '') {
                $tags .= '<span class="med-tag">' . esc_html($form) . '</span>';
            }

            $items_html .= '<div class="med-row">'
                . '<table class="med-table" width="100%" cellpadding="0" cellspacing="0"><tr>'
                . '<td class="med-dot-cell"><div class="med-dot"></div></td>'
                . '<td class="med-name-wrap">'
                . '<div><span class="med-name">' . esc_html($name) . '</span>' . $tags . '</div>'
                . '<div class="med-posology">' . nl2br(esc_html($posology)) . '</div>'
                . '</td>'
                . '</tr></table>'
                . '</div>';
        }
        if ($items_html === '') {
            $items_html = '<div class="muted">Aucun médicament.</div>';
        }

        // Text tokens (escaped)
        $text = static function (string $v): string {
            return esc_html($v);
        };

        $repl = [
            '{{UID}}' => $text($uid),
            '{{DOSSIER_UID}}' => $text($uid),
            '{{DATE_FR}}' => $text($created_fr),

            '{{DOCTOR_PREFIX}}' => $text($doctor_prefix),
            '{{DOCTOR_NAME}}' => $text($doctor_name),
            '{{DOCTOR_DISPLAY}}' => $text($doctor_display),
            '{{SPECIALTY}}' => $text($specialty),
            '{{RPPS}}' => $text($rpps),
            '{{ADDRESS}}' => $text($address),
            '{{PHONE}}' => $text($phone),
            '{{DIPLOMA_LINE}}' => $text($diploma),

            '{{PATIENT_NAME}}' => $text($patient_name),
            '{{PATIENT_BIRTH_LABEL}}' => $text($patient_birth_label),
            '{{PATIENT_WH_LABEL}}' => $text($patient_wh_label),

            '{{VERIFY_URL}}' => $text($verify_url),
            '{{RX_PUBLIC_ID}}' => $text($verify_rx_public_id),
            '{{HASH_SHORT}}' => $text($verify_hash_short),
            '{{DELIVERY_CODE}}' => $text($verify_code),
            '{{MED_COUNT}}' => $text((string) $med_count),
            '{{ISSUE_LINE}}' => $text($issue_line),
        ];

        // HTML tokens (raw)
        $repl['{{MEDICATIONS_HTML}}'] = $items_html;
        $repl['{{QR_IMG_HTML}}'] = $qr_html;
        $repl['{{BARCODE_HTML}}'] = $barcode_html;
        $repl['{{SIGNATURE_IMG_HTML}}'] = $sig_html;

        // Also expose data URIs (for custom <img src="{{...}}"> usage)
        $repl['{{QR_DATA_URI}}'] = $qr_html !== '' ? (string) preg_replace('/^.*src=\"([^\"]+)\".*$/', '$1', $qr_html) : '';
        $repl['{{SIGNATURE_DATA_URI}}'] = $sig_data_uri !== '' ? esc_html($sig_data_uri) : '';

        return $repl;
    }

    /**
     * Render CSS for the mPDF HTML template.
     */
    private static function render_rx_html_mpdf_styles(): string
    {
        // NOTE: CSS volontairement "bridé" pour compatibilité mPDF + moteurs PHP classiques.
        // => priorité aux TABLES, bordures, couleurs simples, radius, typographie et espacement.
        return <<<CSS
<style>
    /* Base */
    body { font-family: DejaVu Sans, sans-serif; color: #111827; font-size: 11pt; }
    table { border-collapse: collapse; }
    .muted { color: #6b7280; }
    .muted2 { color: #9ca3af; }
    .small { font-size: 9pt; }
    .xsmall { font-size: 8pt; }

    /* Header */
    .header-grid { width: 100%; }
    .header-grid td { vertical-align: top; }
    .specialty { color: #1e40af; text-transform: uppercase; font-weight: 700; font-size: 9pt; letter-spacing: 0.6pt; }
    .doc-name { font-size: 18pt; font-weight: 800; margin: 0.5mm 0 1.5mm 0; }
    .doctor-lines { font-size: 9pt; line-height: 1.45; }
    .header-divider { border-bottom: 1px dashed #e5e7eb; margin: 4mm 0 0 0; }
    .badge { background: #eff6ff; color: #1e40af; border-radius: 99px; padding: 2.4mm 4.2mm; font-weight: 800; font-size: 9pt; display: inline-block; }
    .barcode-wrap { text-align: right; }

    /* Patient card */
    .patient-card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 5mm 6mm; margin-top: 6mm; }
    .patient-grid { width: 100%; }
    .patient-grid td { vertical-align: top; }
    .pc-label { font-size: 8pt; font-weight: 800; text-transform: uppercase; color: #94a3b8; letter-spacing: 0.4pt; }
    .pc-value { font-size: 12pt; font-weight: 700; margin-top: 1mm; }

    /* Center title */
    .doc-title-wrap { text-align: center; margin: 10mm 0 7mm; }
    .doc-title { background: #eff6ff; color: #2563eb; border-radius: 99px; padding: 2.7mm 9mm; font-weight: 900; letter-spacing: 1.8pt; font-size: 10pt; text-transform: uppercase; display: inline-block; }

    /* Medications list (table-based) */
    .med-row { margin-bottom: 7mm; page-break-inside: avoid; }
    .med-table { width: 100%; }
    .med-dot-cell { width: 6mm; vertical-align: top; padding-top: 2.2mm; }
    .med-dot { width: 3mm; height: 3mm; background: #2563eb; border-radius: 50%; }
    .med-name { font-size: 12pt; font-weight: 900; }
    .med-name-wrap { word-wrap: break-word; }
    .med-tag { font-size: 8pt; font-weight: 800; background: #f3f4f6; color: #6b7280; padding: 1.1mm 2.2mm; border-radius: 6px; margin-left: 2mm; }
    .med-posology { font-size: 10pt; color: #4b5563; line-height: 1.5; margin-top: 1.2mm; }

    /* Stripe + checksum med count (stable layout for mPDF) */
    .strip-table { width: 100%; margin: 8mm 0 4mm; }
    .void-zone-cell { height: 14mm; background: #f3f4f6; border-bottom: 1px solid #e5e7eb; }
    .count-cell { width: 22mm; background: #f3f4f6; border-bottom: 1px solid #e5e7eb; vertical-align: bottom; }
    .count-box { width: 14mm; height: 14mm; border: 1px solid #111827; padding: 1mm; margin-left: auto; }
    .count-box-inner { width: 100%; height: 12mm; border: 1px solid #111827; text-align: center; font-weight: 900; font-size: 13pt; line-height: 12mm; }

    /* Footer (security) */
    .footer { border-top: 2px solid #e5e7eb; padding-top: 6mm; }
    .footer-grid { width: 100%; }
    .footer-grid td { vertical-align: middle; }
    .security-title { font-weight: 900; font-size: 10pt; }
    .qr-img { width: 18mm; height: 18mm; }
    .issue-line { font-size: 7.5pt; color: #6b7280; margin-bottom: 1.5mm; }
    .delivery-row { margin-top: 2mm; }
    .delivery-label { font-size: 8pt; color: #9ca3af; font-weight: 800; text-transform: uppercase; letter-spacing: 0.4pt; }
    .delivery-code { font-size: 14pt; font-weight: 900; color: #111827; background: #f3f4f6; padding: 1.4mm 2.6mm; border-radius: 6px; }
    .sig-img { max-height: 22mm; }
    .right { text-align: right; }
    .watermark { margin-top: 6mm; text-align: center; font-size: 8pt; color: #d1d5db; }
</style>
CSS;
    }

    /**
     * Render HTML body for the mPDF template.
     *
     * @param array<string,mixed> $data
     * @param array{type?:string,bytes?:string}|null $signature
     */
    private static function render_rx_html_mpdf_body(array $data, ?array $signature): string
    {
        $uid = isset($data['uid']) ? (string) $data['uid'] : '';
        $created_fr = isset($data['created_fr']) ? (string) $data['created_fr'] : '';

        $doctor_title = trim((string) ($data['doctor_title'] ?? ''));
        $doctor_name = trim((string) ($data['doctor_name'] ?? ''));

        // Display prefix (Dr / Pr) for a professional look.
        $doctor_prefix = 'Dr';
        $doctor_title_lc = strtolower($doctor_title);
        if (in_array($doctor_title_lc, ['professeur', 'pr', 'prof', 'prof.'], true)) {
            $doctor_prefix = 'Pr';
        }

        $doctor_display = $doctor_name;
        if ($doctor_display === '') {
            $doctor_display = $doctor_prefix;
        } elseif (!preg_match('/^(Dr|Pr|Prof)\b/i', $doctor_display)) {
            $doctor_display = trim($doctor_prefix . ' ' . $doctor_display);
        }

        $specialty = trim((string) ($data['doctor_specialty'] ?? ''));
        $rpps = trim((string) ($data['doctor_rpps'] ?? ''));
        $address = trim((string) ($data['doctor_address'] ?? ''));
        $phone = trim((string) ($data['doctor_phone'] ?? ''));
        $diploma = trim((string) ($data['doctor_diploma_line'] ?? ''));

        $patient_name = trim((string) ($data['patient_name'] ?? ''));
        $patient_birth_label = trim((string) ($data['patient_birthdate_label'] ?? ''));
        $patient_wh_label = trim((string) ($data['patient_weight_height_label'] ?? ''));

        $verify_url = trim((string) ($data['verify_url'] ?? ''));
        $verify_rx_public_id = trim((string) ($data['verify_rx_public_id'] ?? ''));
        $verify_hash_short = trim((string) ($data['verify_hash_short'] ?? ''));
        $verify_code = trim((string) ($data['verify_code'] ?? ''));

        $checksum_med_count = (int) ($data['checksum_med_count'] ?? 0);

        // Signature image as data-uri (best-effort)
        $sig_data_uri = '';
        if (is_array($signature) && !empty($signature['bytes']) && is_string($signature['bytes'])) {
            $bytes = (string) $signature['bytes'];

            // Default: JPEG (most compatible). We also detect magic-bytes to avoid wrong MIME.
            $mime = 'image/jpeg';

            // 1) Magic-bytes (priority)
            if (substr($bytes, 0, 8) === "\x89PNG\r\n\x1A\n") {
                $mime = 'image/png';
            } elseif (substr($bytes, 0, 2) === "\xFF\xD8") {
                $mime = 'image/jpeg';
            } elseif (!empty($signature['type']) && is_string($signature['type'])) {
                // 2) Fallback: declared type
                $t = strtolower((string) $signature['type']);
                if ($t === 'png') {
                    $mime = 'image/png';
                }
            }

            $sig_data_uri = 'data:' . $mime . ';base64,' . base64_encode($bytes);
        }

        // Items
        $items = [];
        if (!empty($data['items']) && is_array($data['items'])) {
            $items = $data['items'];
        }

        $items_html = '';
        foreach ($items as $it) {
            if (!is_array($it)) {
                continue;
            }
            // Compat: certains DTO exposent denomination/posologie, d'autres name/posology
            $name = trim((string) ($it['denomination'] ?? $it['name'] ?? ''));
            if ($name === '') {
                $name = 'Médicament';
            }
            $strength = trim((string) ($it['dosage_tag'] ?? $it['strength'] ?? ''));
            $form = trim((string) ($it['form_tag'] ?? $it['form'] ?? ''));
            $posology = trim((string) ($it['posologie'] ?? $it['posology'] ?? $it['posology_text'] ?? ''));

            $tags = '';
            if ($strength !== '') {
                $tags .= '<span class="med-tag">' . esc_html($strength) . '</span>';
            }
            if ($form !== '') {
                $tags .= '<span class="med-tag">' . esc_html($form) . '</span>';
            }

            // Template "CSS limité" : layout table (plus stable sur les moteurs HTML->PDF PHP).
            $items_html .= '<div class="med-row">'
                . '<table class="med-table" width="100%" cellpadding="0" cellspacing="0"><tr>'
                . '<td class="med-dot-cell"><div class="med-dot"></div></td>'
                . '<td class="med-name-wrap">'
                . '<div><span class="med-name">' . esc_html($name) . '</span>' . $tags . '</div>'
                . '<div class="med-posology">' . nl2br(esc_html($posology)) . '</div>'
                . '</td>'
                . '</tr></table>'
                . '</div>';
        }

        if ($items_html === '') {
            $items_html = '<div class="muted">Aucun médicament.</div>';
        }

        $issue_place = trim((string) ($data['issue_place'] ?? ''));
        $issue_line = $issue_place !== '' && $created_fr !== ''
            ? 'Fait à ' . esc_html($issue_place) . ', le ' . esc_html($created_fr)
            : ($created_fr !== '' ? 'Le ' . esc_html($created_fr) : '');

        // For QR & Barcode: use mPDF native <barcode> tag
        $barcode_html = $rpps !== ''
            ? '<div class="barcode-wrap"><barcode code="' . esc_attr($rpps) . '" type="C128A" size="0.9" height="1.2" /></div>'
            : '';


	        // QR Code: embed as image to avoid requiring the optional mpdf/qrcode package.
	        // - We still keep mPDF native <barcode> for 1D barcodes (RPPS), but QR is handled
	        //   via our own generator (phpqrcode) and embedded as data-uri.
	        $qr_data_uri = '';
	        if (!empty($data['qr_jpeg_bytes_base64']) && is_string($data['qr_jpeg_bytes_base64'])) {
	            $qr_data_uri = 'data:image/jpeg;base64,' . $data['qr_jpeg_bytes_base64'];
	        }
	        $qr_html = $qr_data_uri !== ''
	            ? '<img class="qr-img" src="' . esc_attr($qr_data_uri) . '" alt="QR code" width="18mm" height="18mm" style="width:18mm;height:18mm;" />'
	            : '';

        // Header right meta
        $badge_html = '';
        if ($uid !== '') {
            // Inline styles to maximize mPDF CSS compatibility (border-radius/background)
            $badge_html = '<span class="badge" style="background:#eff6ff;color:#1e40af;border-radius:99px;padding:4px 12px;font-weight:700;display:inline-block;">Dossier ' . esc_html($uid) . '</span>';
        }

        $meta_right = '';
        if ($badge_html !== '' || $barcode_html !== '') {
            $meta_right = '<table class="meta-right-table" align="right" cellpadding="0" cellspacing="0">'
                . ($badge_html !== '' ? '<tr><td align="right">' . $badge_html . '</td></tr>' : '')
                . ($barcode_html !== '' ? '<tr><td align="right" style="padding-top:3mm">' . $barcode_html . '</td></tr>' : '')
                . '</table>';
        }
        $doctor_lines = '';
        if ($specialty !== '') {
            $doctor_lines .= '<div class="specialty">' . esc_html($specialty) . '</div>';
        }
        $doctor_lines .= '<div class="doc-name">' . esc_html($doctor_display) . '</div>';
        $doctor_lines .= '<div class="doctor-lines muted">';
        if ($diploma !== '') {
            $doctor_lines .= esc_html($diploma) . '<br />';
        }
        if ($rpps !== '') {
            $doctor_lines .= 'RPPS : ' . esc_html($rpps) . '<br />';
        }
        if ($address !== '') {
            $doctor_lines .= esc_html($address) . '<br />';
        }
        if ($phone !== '') {
            $doctor_lines .= esc_html($phone) . '<br />';
        }
        $doctor_lines .= '</div>';

        // Patient card values
        $patient_birth_label = $patient_birth_label !== '' ? $patient_birth_label : '—';
        $patient_wh_label = $patient_wh_label !== '' ? $patient_wh_label : '—';

        // Security meta order: Verification, Identifiant, Empreinte, Code délivrance (last)
        $security_meta = '';
        if ($verify_url !== '') {
            $security_meta .= '<div class="muted2 small">Vérification : via QR code</div>';
        }
        if ($verify_rx_public_id !== '') {
            $security_meta .= '<div class="muted2 small">Identifiant : ' . esc_html($verify_rx_public_id) . '</div>';
        }
        if ($verify_hash_short !== '') {
            $security_meta .= '<div class="muted2 small">Empreinte : ' . esc_html($verify_hash_short) . '</div>';
        }
        if ($verify_code !== '') {
            // IMPORTANT: on le met en valeur visuellement (élément "high tech") tout en restant compact.
            $security_meta .= '<div class="delivery-row">'
                . '<div class="delivery-label">Code délivrance</div>'
                . '<div><span class="delivery-code">' . esc_html($verify_code) . '</span></div>'
                . '</div>';
        }

        $sig_html = '';
        if ($sig_data_uri !== '') {
            $sig_html = '<img class="sig-img" src="' . esc_attr($sig_data_uri) . '" alt="Signature" width="55mm" height="18mm" style="width:55mm;height:18mm;object-fit:contain;" />';
        }

        $html = '';

        $html .= '<table class="header-grid"><tr>'
            . '<td style="width:68%">' . $doctor_lines . '</td>'
            . '<td style="width:32%; text-align:right">' . $meta_right . '</td>'
            . '</tr></table>';

        // Ligne de séparation (dashed) sous l’en-tête, proche du template HTML premium.
        $html .= '<div class="header-divider"></div>';

        $html .= '<div class="patient-card">'
            . '<table class="patient-grid"><tr>'
            . '<td style="width:40%"><div class="pc-label">Patient</div><div class="pc-value">' . esc_html($patient_name !== '' ? $patient_name : '—') . '</div></td>'
            . '<td style="width:30%; text-align:center"><div class="pc-label">Date de naissance</div><div class="pc-value">' . esc_html($patient_birth_label) . '</div></td>'
            . '<td style="width:30%; text-align:right"><div class="pc-label">Poids / taille</div><div class="pc-value">' . esc_html($patient_wh_label) . '</div></td>'
            . '</tr></table>'
            . '</div>';

        $html .= '<div class="doc-title-wrap"><span class="doc-title">Ordonnance</span></div>';

        $html .= '<div class="prescription">' . $items_html . '</div>';

        $count = (int) $checksum_med_count;
        $html .= '<table class="strip-table" width="100%" cellpadding="0" cellspacing="0"><tr>'
            . '<td class="void-zone-cell">&nbsp;</td>'
            . '<td class="count-cell"><div class="count-box"><div class="count-box-inner">' . $count . '</div></div></td>'
            . '</tr></table>';

        $html .= '<div class="footer">'
            . '<table class="footer-grid"><tr>'
            . '<td style="width:15%">' . $qr_html . '</td>'
            . '<td style="width:45%">'
            . '<div class="security-title">Ordonnance certifiée.</div>'
            . $security_meta
            . '</td>'
            . '<td style="width:40%" class="right">'
            . '<div class="issue-line">' . $issue_line . '</div>'
            . $sig_html
            . '</td>'
            . '</tr></table>'
            . '</div>';

        $html .= '<div class="watermark">Généré par sosprescription.fr — Ordonnance sécurisée</div>';

        return $html;
    }

    private static function build_pdf_bytes(array $data, ?array $signature): string
    {
        // ------------------------------
        // Données normalisées
        // ------------------------------
        $doctor_name = trim((string) ($data['doctor_name'] ?? ''));
        $doctor_title = trim((string) ($data['doctor_title'] ?? ''));
        $doctor_speciality = trim((string) ($data['doctor_speciality'] ?? ''));
        $doctor_rpps = trim((string) ($data['doctor_rpps'] ?? ''));
        $doctor_address = trim((string) ($data['doctor_address'] ?? ''));
        $doctor_phone = trim((string) ($data['doctor_phone'] ?? ''));
        $doctor_email = trim((string) ($data['doctor_email'] ?? ''));
        $doctor_diploma_line = trim((string) ($data['doctor_diploma_line'] ?? ''));
        $doctor_issue_place = trim((string) ($data['doctor_issue_place'] ?? ''));

        // Titre affiché (Dr / Pr)
        $doctor_prefix = 'Dr';
        $doctor_title_lc = strtolower($doctor_title);
        if (in_array($doctor_title_lc, ['professeur', 'pr', 'prof', 'prof.'], true)) {
            $doctor_prefix = 'Pr';
        }
        $doctor_name_display = $doctor_name;
        if ($doctor_name_display === '') {
            $doctor_name_display = $doctor_prefix;
        } elseif (!preg_match('/^(Dr|Pr|Prof)\b/i', $doctor_name_display)) {
            $doctor_name_display = trim($doctor_prefix . ' ' . $doctor_name_display);
        }

        $patient_name = trim((string) ($data['patient_name'] ?? ''));
        $patient_birthdate_label = trim((string) ($data['patient_birthdate_label'] ?? ''));
        $patient_weight_height_label = trim((string) ($data['patient_weight_height_label'] ?? '—'));

        $created_fr = trim((string) ($data['created_fr'] ?? ''));

        $items = is_array($data['items'] ?? null) ? (array) $data['items'] : [];
        $total_items = count($items);

        // Vérification / sécurité
        $verify_url = trim((string) ($data['verify_url'] ?? ''));
        $verify_code = trim((string) ($data['verify_code'] ?? ''));
        $verify_hash_short = trim((string) ($data['verify_hash_short'] ?? ''));
        $rx_public_id = trim((string) ($data['verify_rx_public_id'] ?? ''));

        if ($rx_public_id === '') {
            $rx_uid = trim((string) ($data['rx_uid'] ?? ''));
            $rx_public_id = $rx_uid !== '' ? ('RX-' . $rx_uid) : '';
        }

        $checksum_med_count = (int) ($data['checksum_med_count'] ?? $total_items);

        // ------------------------------
        // Palette (alignée template HTML)
        // ------------------------------
        $ink_primary = '#111827';
        $ink_secondary = '#6b7280';
        $ink_tertiary = '#9ca3af';
        $label_muted = '#94a3b8';
        $accent = '#2563eb';
        $border_light = '#e5e7eb';
        $badge_bg = '#eff6ff';
        $tag_bg = '#f3f4f6';
        $void_bg = '#f3f4f6';
        $watermark = '#d1d5db';

        // ------------------------------
        // Layout A4
        // ------------------------------
        $margin = 57.0; // ≈ 20mm
        $x0 = $margin;
        $w = self::PAGE_W - 2 * $margin;

        // Footer / Zone sécurité (inspiré template FINAL)
        $footer_h = 115.0;
        $footer_top = self::PAGE_H - $margin - $footer_h;

        $count_box = 44.0;
        $count_pad_right = 15.0;
        $count_overlap = 25.0;
        $gap_before_footer = 30.0;

        $count_bottom = $footer_top - $gap_before_footer;
        $count_top = $count_bottom - $count_box;

        $void_h = 50.0;
        $void_bottom = $count_top + $count_overlap;
        $void_top = $void_bottom - $void_h;

        // ------------------------------
        // Helpers PDF
        // ------------------------------
        $color_rgb = static function (string $hex): array {
            $hex = ltrim($hex, '#');
            if (strlen($hex) === 3) {
                $hex = $hex[0] . $hex[0] . $hex[1] . $hex[1] . $hex[2] . $hex[2];
            }
            $r = hexdec(substr($hex, 0, 2)) / 255;
            $g = hexdec(substr($hex, 2, 2)) / 255;
            $b = hexdec(substr($hex, 4, 2)) / 255;
            return [$r, $g, $b];
        };

        $text_width = static function (string $text, int $size): float {
            // Approximation: Helvetica/Helvetica-Bold ~ 0.55em/char
            // (meilleur centrage pour les badges/titres, ex: "ORDONNANCE").
            $len = function_exists('mb_strlen') ? mb_strlen($text, 'UTF-8') : strlen($text);
            return $len * $size * 0.55;
        };

        $set_fill = static function (string &$content, string $hex) use ($color_rgb): void {
            [$r, $g, $b] = $color_rgb($hex);
            $content .= self::fmt($r) . ' ' . self::fmt($g) . ' ' . self::fmt($b) . " rg\n";
        };

        $set_stroke = static function (string &$content, string $hex) use ($color_rgb): void {
            [$r, $g, $b] = $color_rgb($hex);
            $content .= self::fmt($r) . ' ' . self::fmt($g) . ' ' . self::fmt($b) . " RG\n";
        };

        $set_line_width = static function (string &$content, float $w): void {
            $content .= self::fmt($w) . " w\n";
        };

        $set_dash = static function (string &$content, array $pattern = [], float $phase = 0.0): void {
            if (empty($pattern)) {
                $content .= "[] 0 d\n";
                return;
            }
            $parts = array_map(static fn($v) => self::fmt((float) $v), $pattern);
            $content .= '[' . implode(' ', $parts) . '] ' . self::fmt($phase) . " d\n";
        };

        $draw_line = static function (string &$content, float $x1, float $y1_top, float $x2, float $y2_top): void {
            $content .= self::fmt($x1) . ' ' . self::fmt(self::PAGE_H - $y1_top) . ' m '
                . self::fmt($x2) . ' ' . self::fmt(self::PAGE_H - $y2_top) . " l S\n";
        };

        $draw_round_rect = static function (string &$content, float $x, float $y_top, float $w, float $h, float $r, bool $fill, bool $stroke): void {
            $k = 0.5522847498;
            $bottom = self::PAGE_H - $y_top - $h;
            $top = $bottom + $h;
            $left = $x;
            $right = $x + $w;

            $r = max(0.0, min($r, min($w, $h) / 2.0));
            $ck = $r * $k;

            $content .= self::fmt($left + $r) . ' ' . self::fmt($bottom) . " m\n";
            $content .= self::fmt($right - $r) . ' ' . self::fmt($bottom) . " l\n";
            $content .= self::fmt($right - $r + $ck) . ' ' . self::fmt($bottom) . ' ' . self::fmt($right) . ' ' . self::fmt($bottom + $r - $ck) . ' ' . self::fmt($right) . ' ' . self::fmt($bottom + $r) . " c\n";
            $content .= self::fmt($right) . ' ' . self::fmt($top - $r) . " l\n";
            $content .= self::fmt($right) . ' ' . self::fmt($top - $r + $ck) . ' ' . self::fmt($right - $r + $ck) . ' ' . self::fmt($top) . ' ' . self::fmt($right - $r) . ' ' . self::fmt($top) . " c\n";
            $content .= self::fmt($left + $r) . ' ' . self::fmt($top) . " l\n";
            $content .= self::fmt($left + $r - $ck) . ' ' . self::fmt($top) . ' ' . self::fmt($left) . ' ' . self::fmt($top - $r + $ck) . ' ' . self::fmt($left) . ' ' . self::fmt($top - $r) . " c\n";
            $content .= self::fmt($left) . ' ' . self::fmt($bottom + $r) . " l\n";
            $content .= self::fmt($left) . ' ' . self::fmt($bottom + $r - $ck) . ' ' . self::fmt($left + $r - $ck) . ' ' . self::fmt($bottom) . ' ' . self::fmt($left + $r) . ' ' . self::fmt($bottom) . " c\n";
            $content .= "h\n";

            if ($fill && $stroke) {
                $content .= "B\n";
            } elseif ($fill) {
                $content .= "f\n";
            } else {
                $content .= "S\n";
            }
        };

        $draw_circle = static function (string &$content, float $cx, float $cy_top, float $r, bool $fill, bool $stroke): void {
            $k = 0.5522847498;
            $cy = self::PAGE_H - $cy_top;

            $content .= self::fmt($cx + $r) . ' ' . self::fmt($cy) . " m\n";
            $content .= self::fmt($cx + $r) . ' ' . self::fmt($cy + $r * $k) . ' ' . self::fmt($cx + $r * $k) . ' ' . self::fmt($cy + $r) . ' ' . self::fmt($cx) . ' ' . self::fmt($cy + $r) . " c\n";
            $content .= self::fmt($cx - $r * $k) . ' ' . self::fmt($cy + $r) . ' ' . self::fmt($cx - $r) . ' ' . self::fmt($cy + $r * $k) . ' ' . self::fmt($cx - $r) . ' ' . self::fmt($cy) . " c\n";
            $content .= self::fmt($cx - $r) . ' ' . self::fmt($cy - $r * $k) . ' ' . self::fmt($cx - $r * $k) . ' ' . self::fmt($cy - $r) . ' ' . self::fmt($cx) . ' ' . self::fmt($cy - $r) . " c\n";
            $content .= self::fmt($cx + $r * $k) . ' ' . self::fmt($cy - $r) . ' ' . self::fmt($cx + $r) . ' ' . self::fmt($cy - $r * $k) . ' ' . self::fmt($cx + $r) . ' ' . self::fmt($cy) . " c\n";
            $content .= "h\n";

            if ($fill && $stroke) {
                $content .= "B\n";
            } elseif ($fill) {
                $content .= "f\n";
            } else {
                $content .= "S\n";
            }
        };

        $add_text_top = static function (string &$content, string $font, int $size, float $x, float $y_top, string $text): void {
            $y_abs = self::PAGE_H - $y_top - $size;
            self::add_text_abs($content, $font, $size, $x, $y_abs, $text);
        };

        $add_text_top_aligned = static function (string &$content, string $font, int $size, float $x, float $y_top, string $text, string $align = 'L', float $max_w = 0.0) use ($text_width, $add_text_top): void {
            if ($max_w > 0) {
                $tw = $text_width($text, $size);
                if ($align === 'C') {
                    $x += max(0.0, ($max_w - $tw) / 2.0);
                } elseif ($align === 'R') {
                    $x += max(0.0, $max_w - $tw);
                }
            }
            $add_text_top($content, $font, $size, $x, $y_top, $text);
        };

        $wrap = static function (string $text, int $size, float $max_w) use ($text_width): array {
            $max_chars = (int) max(10, floor($max_w / ($size * 0.52)));
            return self::wrap_multiline($text, $max_chars);
        };

        $add_wrapped = static function (string &$content, string $font, int $size, float $x, float $y_top, string $text, float $max_w, float $lh, string $align = 'L') use ($add_text_top_aligned, $wrap): float {
            $lines = $wrap($text, $size, $max_w);
            $y = $y_top;
            foreach ($lines as $ln) {
                $add_text_top_aligned($content, $font, $size, $x, $y, $ln, $align, $max_w);
                $y += $lh;
            }
            return $y;
        };

        $parse_med = static function (string $title): array {
            $title = trim(preg_replace('/\s+/', ' ', $title));
            $form = '';
            $left = $title;
            if (strpos($title, ',') !== false) {
                [$left, $form] = explode(',', $title, 2);
                $left = trim($left);
                $form = trim($form);
            }
            $dosage = '';
            $base = $left;

            if (preg_match('/(\d+(?:[.,]\d+)?\s*(?:mg|g|µg|mcg|ui|iu|ml|%)(?:\s*\/\s*\d+(?:[.,]\d+)?\s*(?:mg|g|µg|mcg|ui|iu|ml|%))*)/iu', $left, $m)) {
                $dosage = trim($m[1]);
                $base = trim(str_replace($m[1], '', $left));
                $base = trim(preg_replace('/\s{2,}/', ' ', $base));
                $base = trim($base, " ,;-\t");
                if ($base === '') {
                    $base = $left;
                }
            }

            return [$base, $dosage, $form];
        };

        // ------------------------------
        // Images (QR + signature)
        // ------------------------------
        $images = [];

        $qr_bytes = '';
        if (!empty($data['qr_jpeg_bytes_base64'])) {
            $decoded = base64_decode((string) $data['qr_jpeg_bytes_base64'], true);
            if (is_string($decoded)) {
                $qr_bytes = $decoded;
            }
        }
        if ($qr_bytes !== '') {
            $info = @getimagesizefromstring($qr_bytes);
            $wpx = is_array($info) && isset($info[0]) ? (int) $info[0] : 256;
            $hpx = is_array($info) && isset($info[1]) ? (int) $info[1] : 256;
            $images['ImQR'] = [
                'type' => 'jpeg',
                'bytes' => $qr_bytes,
                'width' => $wpx,
                'height' => $hpx,
            ];
        }

        // Barcode RPPS (Code39) – optionnel.
        $bar_bytes = '';
        if (!empty($data['barcode_jpeg_bytes_base64'])) {
            $decoded = base64_decode((string) $data['barcode_jpeg_bytes_base64'], true);
            if (is_string($decoded)) {
                $bar_bytes = $decoded;
            }
        }
        if ($bar_bytes !== '') {
            $info = @getimagesizefromstring($bar_bytes);
            $wpx = is_array($info) && isset($info[0]) ? (int) $info[0] : 600;
            $hpx = is_array($info) && isset($info[1]) ? (int) $info[1] : 120;
            $images['ImBAR'] = [
                'type' => 'jpeg',
                'bytes' => $bar_bytes,
                'width' => $wpx,
                'height' => $hpx,
            ];
        }

        if (is_array($signature) && !empty($signature['bytes'])) {
            $sig_bytes = (string) $signature['bytes'];
            $info = @getimagesizefromstring($sig_bytes);
            if (is_array($info) && isset($info[0], $info[1])) {
                $images['ImSIG'] = [
                    'type' => $signature['type'] ?? 'png',
                    'bytes' => $sig_bytes,
                    'width' => (int) $info[0],
                    'height' => (int) $info[1],
                ];
            }
        }

        // ------------------------------
        // Construction pages
        // ------------------------------
        $pages = [];
        $item_index = 0;
        $page_num = 0;

        while ($item_index < $total_items || $page_num === 0) {
            $content = "";

            // --------------------------
            // HEADER (sans card) + ligne pointillée
            // --------------------------
            $y = $margin;

            $set_fill($content, $ink_primary);
            $add_text_top($content, 'F2', 16, $x0, $y, $doctor_name_display !== '' ? $doctor_name_display : 'Dr');
            $y += 22;

            if ($doctor_speciality !== '') {
                $set_fill($content, $accent);
                $spec = function_exists('mb_strtoupper') ? mb_strtoupper($doctor_speciality, 'UTF-8') : strtoupper($doctor_speciality);
                $add_text_top($content, 'F2', 10, $x0, $y, $spec);
                $y += 14;
            }

            $set_fill($content, $ink_secondary);

            $details_lines = [];
            if ($doctor_diploma_line !== '') {
                $details_lines[] = $doctor_diploma_line;
            }
            if ($doctor_rpps !== '') {
                $details_lines[] = 'RPPS : ' . $doctor_rpps;
            }
            if ($doctor_address !== '') {
                $details_lines[] = $doctor_address;
            }
            if ($doctor_phone !== '' || $doctor_email !== '') {
                $extra = [];
                if ($doctor_phone !== '') {
                    $extra[] = $doctor_phone;
                }
                if ($doctor_email !== '') {
                    $extra[] = $doctor_email;
                }
                $details_lines[] = implode(' • ', $extra);
            }

            $details_txt = implode("\n", $details_lines);
            $y = $add_wrapped($content, 'F1', 9, $x0, $y, $details_txt, $w * 0.62, 12.0, 'L');
            $header_bottom = $y + 6;

            // RPPS (droite) : code-barres scannable si disponible, sinon fallback texte.
            if ($doctor_rpps !== '') {
                $barcode_x = $x0 + $w * 0.65;
                $barcode_y = $margin + 6;

                if (!empty($images['ImBAR'])) {
                    // Zone "barcode-container" (à droite) proche du template.
                    $barcode_w = $w * 0.33;
                    $barcode_h = 34;
                    // pdf_draw_image attend une coordonnée Y depuis le bas
                    $content .= self::pdf_draw_image('ImBAR', $barcode_x, self::PAGE_H - $barcode_y - $barcode_h, $barcode_w, $barcode_h);
                    $set_fill($content, $ink_secondary);
                    $add_text_top($content, 'F2', 8, $barcode_x, $barcode_y + 36, 'RPPS');
                } else {
                    $set_fill($content, $ink_primary);
                    $add_text_top($content, 'F1', 20, $barcode_x, $barcode_y + 2, '*' . $doctor_rpps . '*');
                    $set_fill($content, $ink_secondary);
                    $add_text_top($content, 'F2', 8, $barcode_x, $barcode_y + 26, 'RPPS');
                }
            }

            // Ligne pointillée
            $set_stroke($content, $border_light);
            $set_line_width($content, 1.0);
            $set_dash($content, [3, 3], 0);
            $draw_line($content, $x0, $header_bottom, $x0 + $w, $header_bottom);
            $set_dash($content, [], 0);

            // --------------------------
            // PATIENT CARD
            // --------------------------
            $patient_top = $header_bottom + 25;
            $patient_h = 66.0;

            $set_fill($content, '#ffffff');
            $set_stroke($content, $border_light);
            $set_line_width($content, 1.0);
            $draw_round_rect($content, $x0, $patient_top, $w, $patient_h, 12.0, true, true);

            $col_left_w = $w * 0.40;
            $col_center_w = $w * 0.30;
            $col_right_w = $w * 0.30;

            $pad_x = 20.0;
            $pad_y = 18.0;

            // Left
            $set_fill($content, $label_muted);
            $add_text_top($content, 'F2', 8, $x0 + $pad_x, $patient_top + $pad_y, 'PATIENT');
            $set_fill($content, $ink_primary);
            $add_text_top($content, 'F1', 12, $x0 + $pad_x, $patient_top + $pad_y + 16, $patient_name !== '' ? $patient_name : '—');

            // Center
            $cx = $x0 + $col_left_w;
            $set_fill($content, $label_muted);
            $add_text_top_aligned($content, 'F2', 8, $cx + 10, $patient_top + $pad_y, 'DATE DE NAISSANCE', 'C', $col_center_w - 20);
            $set_fill($content, $ink_primary);
            $add_text_top_aligned($content, 'F1', 12, $cx + 10, $patient_top + $pad_y + 16, $patient_birthdate_label !== '' ? $patient_birthdate_label : '—', 'C', $col_center_w - 20);

            // Right
            $rx = $x0 + $col_left_w + $col_center_w;
            $set_fill($content, $label_muted);
            $add_text_top_aligned($content, 'F2', 8, $rx + 10, $patient_top + $pad_y, 'POIDS / TAILLE', 'R', $col_right_w - 20);
            $set_fill($content, $ink_primary);
            $add_text_top_aligned($content, 'F1', 12, $rx + 10, $patient_top + $pad_y + 16, $patient_weight_height_label !== '' ? $patient_weight_height_label : '—', 'R', $col_right_w - 20);

            // --------------------------
            // TITRE CENTRAL (badge)
            // --------------------------
            $title_top = $patient_top + $patient_h + 38;
            $badge_h = 24.0;
            $badge_w = 160.0;
            $badge_x = $x0 + ($w - $badge_w) / 2.0;

            $set_fill($content, $badge_bg);
            $set_stroke($content, $badge_bg);
            $draw_round_rect($content, $badge_x, $title_top, $badge_w, $badge_h, 12.0, true, false);

            $set_fill($content, $accent);
            $add_text_top_aligned($content, 'F2', 10, $badge_x, $title_top + 7, 'ORDONNANCE', 'C', $badge_w);

            // Début liste médicaments
            $y_cursor = $title_top + $badge_h + 28;
            $y_max = $void_top - 18;

            // --------------------------
            // MEDS LIST
            // --------------------------
            while ($item_index < $total_items) {
                $it = $items[$item_index] ?? [];
                $title_raw = trim((string) ($it['title'] ?? ($it['name'] ?? ($it['denomination'] ?? 'Médicament'))));
                $posology = trim((string) ($it['posology'] ?? ($it['posologie'] ?? '')));

                [$base, $dosage, $form] = $parse_med($title_raw);

                $instr = $posology !== '' ? $posology : '—';

                // Wrap long BDPM labels so medicine name never gets cut on narrow renders.
                $max_w_text = $w - 30.0;
                $med_name = $base !== '' ? $base : $title_raw;
                $name_lines = $wrap($med_name, 13, $max_w_text);
                if (empty($name_lines)) {
                    $name_lines = [$med_name];
                }

                // Tags (dosage / forme) are rendered on their own line(s) under the name.
                $tags = [];
                if ($dosage !== '') { $tags[] = $dosage; }
                if ($form !== '') { $tags[] = $form; }

                // Estimation hauteur (approx) : name lines + tags + instruction lines + padding
                $instr_lines_est = $wrap($instr, 10, $max_w_text);
                $h = 16.0;
                $h += count($name_lines) * 16.0;
                $h += !empty($tags) ? 18.0 : 0.0;
                $h += max(1, count($instr_lines_est)) * 14.0;
                $h += 20.0;
                $h = max(72.0, $h);

                if ($y_cursor + $h > $y_max && $y_cursor > ($title_top + $badge_h + 40)) {
                    break;
                }

                // Bullet halo + dot
                $bullet_x = $x0 + 6;
                $bullet_y = $y_cursor + 10;
                $set_fill($content, $badge_bg);
                $set_stroke($content, $badge_bg);
                $draw_circle($content, $bullet_x, $bullet_y, 7.0, true, false);
                $set_fill($content, $accent);
                $set_stroke($content, $accent);
                $draw_circle($content, $bullet_x, $bullet_y, 3.0, true, false);

                // Nom (wrapped)
                $text_x = $x0 + 20;
                $set_fill($content, $ink_primary);
                $y_name = $y_cursor;
                foreach ($name_lines as $ln) {
                    $ln = trim((string) $ln);
                    if ($ln === '') { continue; }
                    $add_text_top($content, 'F2', 13, $text_x, $y_name, $ln);
                    $y_name += 16.0;
                }

                // Tags (on a dedicated line under the name, with optional wrapping to a 2nd line)
                $tag_x = $text_x;
                $tag_y = $y_name + 2.0;
                $tag_line_h = 18.0;
                $tag_lines_used = 1;

                foreach ($tags as $tg) {
                    $tg = trim($tg);
                    if ($tg === '') { continue; }

                    $tw = $text_width($tg, 7);
                    $bw = $tw + 16.0;
                    $bh = 14.0;

                    if ($tag_x + $bw > $x0 + $w) {
                        if ($tag_lines_used >= 2) {
                            break;
                        }
                        $tag_lines_used++;
                        $tag_x = $text_x;
                        $tag_y += $tag_line_h;
                    }

                    $set_fill($content, $tag_bg);
                    $set_stroke($content, $tag_bg);
                    $draw_round_rect($content, $tag_x, $tag_y, $bw, $bh, 6.0, true, false);

                    $set_fill($content, $ink_secondary);
                    $add_text_top($content, 'F2', 7, $tag_x + 6, $tag_y + 4, $tg);

                    $tag_x += $bw + 8.0;
                }

                // Instructions (start after name + tags)
                $y_after_tags = !empty($tags) ? ($tag_y + $tag_line_h) : $y_name;
                $y_instr_start = $y_after_tags + 6.0;

                $set_fill($content, $ink_secondary);
                $y_instr_end = $add_wrapped($content, 'F1', 10, $text_x, $y_instr_start, $instr, $w - 20, 14.0, 'L');

                $y_cursor = $y_instr_end + 18.0;
                $item_index++;
            }

            if ($item_index < $total_items) {
                $set_fill($content, $ink_tertiary);
                $add_text_top($content, 'F1', 9, $x0, $y_max - 8, 'Suite page suivante…');
            }

            // --------------------------
            // VOID ZONE + COUNT BOX
            // --------------------------
            $set_fill($content, $void_bg);
            $set_stroke($content, $border_light);
            $set_line_width($content, 1.0);
            $draw_round_rect($content, $x0, $void_top, $w, $void_h, 0.0, true, true);

            // Diagonales
            $set_stroke($content, $border_light);
            $set_line_width($content, 0.5);
            $step = 20.0;
            for ($sx = -$void_h; $sx < $w + $void_h; $sx += $step) {
                $x1 = $x0 + $sx;
                $y1 = $void_top;
                $x2 = $x1 + $void_h;
                $y2 = $void_top + $void_h;
                $draw_line($content, $x1, $y1, $x2, $y2);
            }

            // Count box
            $cb_x = $x0 + $w - $count_box - $count_pad_right;
            $cb_y = $count_top;

            $set_stroke($content, $ink_primary);
            $set_line_width($content, 1.0);
            $set_fill($content, '#ffffff');
            $draw_round_rect($content, $cb_x, $cb_y, $count_box, $count_box, 0.0, true, true);

            $inner = 3.0;
            $draw_round_rect($content, $cb_x + $inner, $cb_y + $inner, $count_box - 2 * $inner, $count_box - 2 * $inner, 0.0, false, true);

            $set_fill($content, $ink_primary);
            $add_text_top_aligned($content, 'F2', 16, $cb_x, $cb_y + 13, (string) max(0, $checksum_med_count), 'C', $count_box);

            // --------------------------
            // FOOTER (sécurité)
            // --------------------------
            $set_stroke($content, $border_light);
            $set_line_width($content, 2.0);
            $draw_line($content, $x0, $footer_top, $x0 + $w, $footer_top);

            $pad_footer = 20.0;
            $qr_size = 50.0;
            $qr_x = $x0;
            $qr_y = $footer_top + $pad_footer;

            if (isset($images['ImQR'])) {
                $content .= self::pdf_draw_image('ImQR', $qr_x, self::PAGE_H - $qr_y - $qr_size, $qr_size, $qr_size);
            } else {
                $set_stroke($content, $border_light);
                $set_fill($content, '#ffffff');
                $set_line_width($content, 1.0);
                $draw_round_rect($content, $qr_x, $qr_y, $qr_size, $qr_size, 6.0, true, true);
                $set_fill($content, $ink_tertiary);
                $add_text_top_aligned($content, 'F2', 12, $qr_x, $qr_y + 18, 'QR', 'C', $qr_size);
            }

            // Texte légal + sécurité
            $legal_x = $qr_x + $qr_size + 15;
            $legal_y = $qr_y + 2;

            $set_fill($content, $ink_primary);
            $add_text_top($content, 'F2', 9, $legal_x, $legal_y, 'Ordonnance certifiée.');

            $set_fill($content, $ink_tertiary);
            $security_lines = [];
            // Esthétique : on n'imprime pas l'URL longue (le QR code contient déjà le lien).
            if ($verify_url !== '') { $security_lines[] = 'Vérification : via QR code'; }
            if ($rx_public_id !== '') { $security_lines[] = 'Identifiant : ' . $rx_public_id; }
            if ($verify_hash_short !== '') { $security_lines[] = 'Empreinte : ' . $verify_hash_short; }
            if ($verify_code !== '') { $security_lines[] = 'Code délivrance : ' . $verify_code; }

            $security_txt = implode("\n", $security_lines);
            $add_wrapped($content, 'F1', 8, $legal_x, $legal_y + 12, $security_txt, $w * 0.55, 11.0, 'L');

            // Signature bloc
            $sig_w = 140.0;
            $sig_x = $x0 + $w - $sig_w;
            $sig_y = $qr_y;

            $set_fill($content, $ink_secondary);
            $place_line = ($doctor_issue_place !== '' ? ('Fait à ' . $doctor_issue_place . ', ') : '');
            $place_line .= ($created_fr !== '' ? ('le ' . $created_fr) : '');
            $add_text_top_aligned($content, 'F1', 9, $sig_x, $sig_y, $place_line, 'R', $sig_w);

            if (isset($images['ImSIG'])) {
                // Signature image (prioritaire) – max-height ~60px (≈ 60pt) avec respect du ratio.
                $sig_max_h = 60.0;
                $iw = (float) ($images['ImSIG']['width'] ?? 0);
                $ih = (float) ($images['ImSIG']['height'] ?? 0);

                if ($iw > 0 && $ih > 0) {
                    $scale = min($sig_w / $iw, $sig_max_h / $ih);
                    $sig_img_w = $iw * $scale;
                    $sig_img_h = $ih * $scale;

                    // Alignement à droite dans la zone de signature.
                    $sig_img_x = $sig_x + ($sig_w - $sig_img_w);
                    $content .= self::pdf_draw_image('ImSIG', $sig_img_x, self::PAGE_H - ($sig_y + 16) - $sig_img_h, $sig_img_w, $sig_img_h);
                } else {
                    // Fallback rare : métadonnées image invalides
                    $set_fill($content, $ink_primary);
                    $add_text_top_aligned($content, 'F3', 22, $sig_x, $sig_y + 10, $doctor_name, 'R', $sig_w);
                }
            } else {
                $set_stroke($content, $border_light);
                $set_line_width($content, 1.0);
                $draw_line($content, $sig_x, $sig_y + 34, $sig_x + $sig_w, $sig_y + 34);

                // Fallback signature (lisible) si aucune image de signature n'est configurée.
                $set_fill($content, $ink_primary);
                $add_text_top_aligned($content, 'F3', 22, $sig_x, $sig_y + 10, $doctor_name, 'R', $sig_w);
            }

            // Watermark
            $set_fill($content, $watermark);
            $wm_y = self::PAGE_H - 23.0; // ≈ 8mm du bas
            $add_text_top_aligned($content, 'F1', 8, $x0, $wm_y, 'Généré par sosprescription.fr — Ordonnance sécurisée.', 'C', $w);

            $pages[] = $content;
            $page_num++;
        }

        return self::pdf_build($pages, $images);
    }



    
    private static function fmt(float $n): string
    {
        $s = number_format($n, 3, '.', '');
        $s = rtrim(rtrim($s, '0'), '.');
        if ($s === '-0') {
            $s = '0';
        }
        return $s;
    }

    private static function add_text_top(string &$content, string $font, int $size, float $x, float $y_top, string $text): void
    {
        // $y_top est exprimé depuis le haut de page
        $y = self::PAGE_H - $y_top - $size;
        self::add_text_abs($content, $font, $size, $x, $y, $text);
    }

    private static function add_text_abs(string &$content, string $font, int $size, float $x, float $y, string $text): void
    {
        $safe = self::pdf_escape_text($text);
        $content .= "BT\n/{$font} {$size} Tf\n" . self::fmt($x) . ' ' . self::fmt($y) . " Td\n({$safe}) Tj\nET\n";
    }

    /**
     * Assemble a minimal PDF (Type1 fonts + optional JPEG images) from content streams.
     *
     * @param array<int,string> $pages
     * @param array<string,array{bytes:string,width:int,height:int}> $images
     */
    private static function pdf_build(array $pages, array $images): string
    {
        $writer = new RxPdfWriter();

        // Fonts
        // IMPORTANT : WinAnsiEncoding est nécessaire pour afficher correctement les accents
        // avec les polices Type1 standards (Helvetica, Helvetica-Bold).
        $f1 = $writer->add_object('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
        $f2 = $writer->add_object('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
        $f3 = $writer->add_object('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>');

        // Images (XObjects)
        $xobjects = [];
        foreach ($images as $name => $img) {
            if (!is_array($img) || !isset($img['bytes'], $img['width'], $img['height'])) {
                continue;
            }
            $bytes = $img['bytes'];
            if (!is_string($bytes) || $bytes === '') {
                continue;
            }
            $w = (int) $img['width'];
            $h = (int) $img['height'];
            if ($w <= 0) { $w = 1; }
            if ($h <= 0) { $h = 1; }

            // On suppose du JPEG (DCTDecode) : load_signature_as_jpeg() garantit la conversion.
            $obj = '<< /Type /XObject /Subtype /Image /Width ' . $w . ' /Height ' . $h
                . ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' . strlen($bytes)
                . " >>\nstream\n" . $bytes . "\nendstream";
            $xobjects[(string) $name] = $writer->add_object($obj);
        }

        $pages_id = $writer->add_object('<< /Type /Pages /Kids [] /Count 0 >>');

        $page_ids = [];
        foreach ($pages as $content) {
            if (!is_string($content)) {
                $content = '';
            }

            $content_id = $writer->add_object('<< /Length ' . strlen($content) . " >>\nstream\n" . $content . "\nendstream");

            $res = '<< /Font << /F1 ' . $f1 . ' 0 R /F2 ' . $f2 . ' 0 R /F3 ' . $f3 . ' 0 R >>';
            if (!empty($xobjects)) {
                $pairs = [];
                foreach ($xobjects as $name => $oid) {
                    // /Name <obj> 0 R
                    $pairs[] = '/' . $name . ' ' . $oid . ' 0 R';
                }
                $res .= ' /XObject << ' . implode(' ', $pairs) . ' >>';
            }
            $res .= ' >>';

            $page_obj = '<< /Type /Page /Parent ' . $pages_id . ' 0 R'
                . ' /MediaBox [0 0 ' . self::fmt(self::PAGE_W) . ' ' . self::fmt(self::PAGE_H) . ']'
                . ' /Resources ' . $res
                . ' /Contents ' . $content_id . ' 0 R >>';

            $page_ids[] = $writer->add_object($page_obj);
        }

        $kids = implode(' ', array_map(static fn($id) => $id . ' 0 R', $page_ids));
        $writer->set_object($pages_id, '<< /Type /Pages /Kids [' . $kids . '] /Count ' . count($page_ids) . ' >>');

        $root_id = $writer->add_object('<< /Type /Catalog /Pages ' . $pages_id . ' 0 R >>');
        $writer->set_root_id($root_id);

        return $writer->render();
    }

private static function wrap_multiline(string $text, int $max_chars): array
    {
        $text = (string) $text;
        $text = str_replace(["\r\n", "\r"], "\n", $text);
        $chunks = explode("\n", $text);
        $out = [];
        foreach ($chunks as $ch) {
            $ch = trim((string) $ch);
            if ($ch === '') {
                continue;
            }
            $wrapped = wordwrap($ch, $max_chars, "\n", false);
            foreach (explode("\n", $wrapped) as $ln) {
                $ln = trim((string) $ln);
                if ($ln !== '') {
                    $out[] = $ln;
                }
            }
        }
        return $out;
    }

    private static function pdf_escape_text(string $utf8): string
    {
        $s = $utf8;
        // Convertit en Windows-1252 (WinAnsi)
        $converted = @iconv('UTF-8', 'Windows-1252//TRANSLIT//IGNORE', $s);
        if (is_string($converted) && $converted !== '') {
            $s = $converted;
        } else {
            // Fallback (peut perdre certains caractères)
            $s = utf8_decode($s);
        }

        $s = str_replace("\\", "\\\\", $s);
        $s = str_replace("(", "\\(", $s);
        $s = str_replace(")", "\\)", $s);
        $s = str_replace(["\r", "\n"], ' ', $s);
        return $s;
    }

    private static function pdf_draw_image(string $name, float $x, float $y, float $w, float $h): string
    {
        // Matrix: [w 0 0 h x y] cm
        return "q\n" . self::fmt($w) . ' 0 0 ' . self::fmt($h) . ' ' . self::fmt($x) . ' ' . self::fmt($y) . " cm\n/{$name} Do\nQ\n";
    }
}

/**
 * Mini writer PDF (objets + xref) pour le MVP.
 *
 * NOTE : ne gère que ce dont on a besoin ici (fonts type1, 1+ pages, 0/1 image JPEG).
 */
final class RxPdfWriter
{
    /** @var array<int, string> */
    private array $objects = [];
    private int $root_id = 0;

    public function add_object(string $body): int
    {
        $this->objects[] = $body;
        return count($this->objects);
    }

    public function set_object(int $id, string $body): void
    {
        if ($id < 1) {
            return;
        }
        $idx = $id - 1;
        if (!isset($this->objects[$idx])) {
            return;
        }
        $this->objects[$idx] = $body;
    }

    public function set_root_id(int $id): void
    {
        $this->root_id = $id;
    }

    public function render(): string
    {
        $pdf = "%PDF-1.4\n";
        $offsets = [];

        $count = count($this->objects);
        for ($i = 1; $i <= $count; $i++) {
            $offsets[$i] = strlen($pdf);
            $pdf .= $i . " 0 obj\n" . $this->objects[$i - 1] . "\nendobj\n";
        }

        $xref_pos = strlen($pdf);
        $pdf .= "xref\n";
        $pdf .= "0 " . (string) ($count + 1) . "\n";
        $pdf .= "0000000000 65535 f \n";
        for ($i = 1; $i <= $count; $i++) {
            $pdf .= sprintf('%010d 00000 n ' . "\n", (int) $offsets[$i]);
        }

        $root = $this->root_id > 0 ? $this->root_id : 1;
        $pdf .= "trailer\n";
        $pdf .= "<< /Size " . (string) ($count + 1) . " /Root {$root} 0 R >>\n";
        $pdf .= "startxref\n";
        $pdf .= (string) $xref_pos . "\n%%EOF";
        return $pdf;
    }
}
