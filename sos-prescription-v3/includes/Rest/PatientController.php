<?php
declare(strict_types=1);

namespace SosPrescription\Rest;

use SOSPrescription\Core\ReqId;
use SosPrescription\Services\Logger;
use SosPrescription\Services\RestGuard;
use SosPrescription\Rest\ErrorResponder;
use SosPrescription\Utils\Date;
use WP_Error;
use WP_REST_Request;
use WP_REST_Response;

class PatientController extends \WP_REST_Controller
{
    public function permissions_check_logged_in_nonce(WP_REST_Request $request): bool|WP_Error
    {
        $ok = RestGuard::require_logged_in($request);
        if (is_wp_error($ok)) {
            return $ok;
        }

        return RestGuard::require_wp_rest_nonce($request);
    }

    public function update_profile(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $user_id = (int) get_current_user_id();
        if ($user_id < 1) {
            return new WP_Error('sosprescription_auth_required', 'Connexion requise.', ['status' => 401]);
        }

        $params = $this->request_data($request);
        $first_name_input = $this->normalize_name_candidate($params['first_name'] ?? $params['firstName'] ?? '');
        $last_name_input = $this->normalize_name_candidate($params['last_name'] ?? $params['lastName'] ?? '');
        $birth_raw = trim((string) ($params['birthdate'] ?? $params['birthDate'] ?? ''));
        $phone = $this->sanitize_phone($params['phone'] ?? '');
        $email = $this->sanitize_email_input($params['email'] ?? '');
        $weight_kg = $this->sanitize_decimal_string($params['weight_kg'] ?? $params['weightKg'] ?? '');
        $height_cm = $this->sanitize_decimal_string($params['height_cm'] ?? $params['heightCm'] ?? '');

        if (($first_name_input !== '' && $this->looks_like_email($first_name_input)) || ($last_name_input !== '' && $this->looks_like_email($last_name_input))) {
            return new WP_Error(
                'sosprescription_patient_identity_invalid',
                'Le prénom et le nom doivent contenir une identité patient valide, pas une adresse e-mail.',
                ['status' => 400]
            );
        }

        if ($email !== '' && !is_email($email)) {
            return new WP_Error(
                'sosprescription_patient_email_invalid',
                'Adresse e-mail invalide.',
                ['status' => 400]
            );
        }

        if ($weight_kg !== '' && !$this->is_valid_weight($weight_kg)) {
            return new WP_Error(
                'sosprescription_patient_weight_invalid',
                'Poids invalide. Merci de saisir une valeur en kilogrammes.',
                ['status' => 400]
            );
        }

        if ($height_cm !== '' && !$this->is_valid_height($height_cm)) {
            return new WP_Error(
                'sosprescription_patient_height_invalid',
                'Taille invalide. Merci de saisir une valeur en centimètres.',
                ['status' => 400]
            );
        }

        $first_name = sanitize_text_field($first_name_input);
        $last_name = sanitize_text_field($last_name_input);

        $birth_iso = '';
        if ($birth_raw !== '') {
            $birth_iso = Date::normalize_birthdate($birth_raw) ?? '';
            if ($birth_iso === '') {
                return new WP_Error(
                    'sosprescription_patient_birthdate_invalid',
                    'Date de naissance invalide (format attendu : JJ/MM/AAAA).',
                    ['status' => 400]
                );
            }
        }

        $current_user = wp_get_current_user();
        $userdata = [
            'ID' => $user_id,
            'first_name' => $first_name,
            'last_name' => $last_name,
        ];

        if ($email !== '') {
            $current_email = ($current_user instanceof \WP_User) ? (string) $current_user->user_email : '';
            if (strcasecmp($current_email, $email) !== 0) {
                $userdata['user_email'] = $email;
            }
        }

        $full_name = trim($first_name . ' ' . $last_name);
        $current_display_name = ($current_user instanceof \WP_User) ? (string) $current_user->display_name : '';
        if ($full_name !== '' && ($current_display_name === '' || $this->looks_like_email($current_display_name))) {
            $userdata['display_name'] = $full_name;
        }

        $updated = wp_update_user($userdata);
        if (is_wp_error($updated)) {
            return ErrorResponder::wp_error(
                $updated,
                'sosprescription_patient_profile_update_failed',
                'Le profil n’a pas pu être enregistré.',
                500,
                $this->build_req_id(),
                [
                    'controller' => __CLASS__,
                    'action' => 'update_profile',
                    'user_id' => $user_id,
                ],
                'patient.profile_update_failed'
            );
        }

        if ($birth_iso !== '') {
            update_user_meta($user_id, 'sosp_birthdate', $birth_iso);
            update_user_meta($user_id, 'sosp_birthdate_precision', Date::birthdate_precision($birth_raw));
        } else {
            delete_user_meta($user_id, 'sosp_birthdate');
            delete_user_meta($user_id, 'sosp_birthdate_precision');
        }

        if ($phone !== '') {
            update_user_meta($user_id, 'sosp_phone', $phone);
        } else {
            delete_user_meta($user_id, 'sosp_phone');
        }

        if ($email !== '') {
            update_user_meta($user_id, 'sosp_email', $email);
        } else {
            delete_user_meta($user_id, 'sosp_email');
        }

        if ($weight_kg !== '') {
            update_user_meta($user_id, 'sosp_weight_kg', $weight_kg);
        } else {
            delete_user_meta($user_id, 'sosp_weight_kg');
        }

        if ($height_cm !== '') {
            update_user_meta($user_id, 'sosp_height_cm', $height_cm);
        } else {
            delete_user_meta($user_id, 'sosp_height_cm');
        }

        $refreshed_user = get_userdata($user_id);
        $profile = $this->build_profile_payload($user_id, $refreshed_user instanceof \WP_User ? $refreshed_user : null);

        return new WP_REST_Response([
            'ok' => true,
            'message' => 'Profil enregistré.',
            'profile' => $profile,
            'currentUser' => [
                'id' => $user_id,
                'displayName' => $profile['full_name'] !== '' ? $profile['full_name'] : (($refreshed_user instanceof \WP_User) ? (string) $refreshed_user->display_name : ''),
                'email' => $profile['email'],
                'roles' => ($refreshed_user instanceof \WP_User) ? array_values((array) $refreshed_user->roles) : [],
                'firstName' => $profile['first_name'],
                'lastName' => $profile['last_name'],
                'first_name' => $profile['first_name'],
                'last_name' => $profile['last_name'],
                'birthDate' => $profile['birthdate_iso'],
                'birthdate' => $profile['birthdate_iso'],
                'sosp_birthdate' => $profile['birthdate_iso'],
                'phone' => $profile['phone'],
            ],
            'patientProfile' => [
                'first_name' => $profile['first_name'],
                'last_name' => $profile['last_name'],
                'fullname' => $profile['full_name'],
                'birthdate_iso' => $profile['birthdate_iso'],
                'birthdate_fr' => $profile['birthdate_fr'],
                'phone' => $profile['phone'],
                'email' => $profile['email'],
                'weight_kg' => $profile['weight_kg'],
                'height_cm' => $profile['height_cm'],
                'bmi_value' => $profile['bmi_value'],
                'bmi_label' => $profile['bmi_label'],
            ],
        ], 200);
    }

    /**
     * @return array<string, mixed>
     */
    private function request_data(WP_REST_Request $request): array
    {
        $body = $request->get_json_params();
        if (!is_array($body) || $body === []) {
            $body = $request->get_body_params();
        }
        if (!is_array($body) || $body === []) {
            $body = $request->get_params();
        }

        return is_array($body) ? $body : [];
    }

    private function normalize_name_candidate(mixed $value): string
    {
        return trim(preg_replace('/\s+/u', ' ', wp_strip_all_tags((string) $value, true)) ?? '');
    }

    private function sanitize_phone(mixed $value): string
    {
        $clean = trim(preg_replace('/\s+/u', ' ', wp_strip_all_tags((string) $value, true)) ?? '');
        if ($clean === '') {
            return '';
        }

        $clean = preg_replace('/[^0-9+().\-\s]/', '', $clean) ?? '';
        $clean = trim(preg_replace('/\s+/u', ' ', $clean) ?? '');

        return function_exists('mb_substr') ? (string) mb_substr($clean, 0, 40) : substr($clean, 0, 40);
    }

    private function sanitize_email_input(mixed $value): string
    {
        $raw = trim((string) $value);
        if ($raw === '') {
            return '';
        }

        return sanitize_email($raw);
    }

    private function sanitize_decimal_string(mixed $value): string
    {
        $raw = trim((string) $value);
        if ($raw === '') {
            return '';
        }

        $raw = str_replace(',', '.', $raw);
        $raw = preg_replace('/[^0-9.]/', '', $raw) ?? '';
        if ($raw === '') {
            return '';
        }

        if (substr_count($raw, '.') > 1) {
            $parts = explode('.', $raw);
            $raw = array_shift($parts) . '.' . implode('', $parts);
        }

        if (!is_numeric($raw)) {
            return '';
        }

        $float = (float) $raw;
        if (!is_finite($float) || $float <= 0) {
            return '';
        }

        $normalized = number_format($float, 1, '.', '');
        if (str_ends_with($normalized, '.0')) {
            $normalized = substr($normalized, 0, -2);
        }

        return $normalized;
    }

    private function is_valid_weight(string $value): bool
    {
        if (!is_numeric($value)) {
            return false;
        }
        $float = (float) $value;
        return is_finite($float) && $float >= 1.0 && $float <= 500.0;
    }

    private function is_valid_height(string $value): bool
    {
        if (!is_numeric($value)) {
            return false;
        }
        $float = (float) $value;
        return is_finite($float) && $float >= 30.0 && $float <= 300.0;
    }


    private function build_req_id(): string
    {
        try {
            return ReqId::coalesce(Logger::get_request_id());
        } catch (\Throwable $e) {
            try {
                return 'req_' . bin2hex(random_bytes(8));
            } catch (\Throwable $fallback) {
                return 'req_' . md5((string) wp_rand() . microtime(true));
            }
        }
    }

    private function looks_like_email(string $value): bool
    {
        $value = trim($value);
        if ($value === '' || strpos($value, '@') === false) {
            return false;
        }

        return (bool) is_email($value);
    }

    /**
     * @return array{first_name:string,last_name:string,full_name:string,birthdate_iso:string,birthdate_fr:string,phone:string,email:string,weight_kg:string,height_cm:string,bmi_value:string,bmi_label:string}
     */
    private function build_profile_payload(int $user_id, ?\WP_User $user = null): array
    {
        $user = $user instanceof \WP_User ? $user : get_userdata($user_id);

        $first_name = sanitize_text_field((string) get_user_meta($user_id, 'first_name', true));
        $last_name = sanitize_text_field((string) get_user_meta($user_id, 'last_name', true));
        $birth_iso = (string) get_user_meta($user_id, 'sosp_birthdate', true);
        $phone = (string) get_user_meta($user_id, 'sosp_phone', true);
        $email = (string) get_user_meta($user_id, 'sosp_email', true);
        if ($email === '' && $user instanceof \WP_User) {
            $email = (string) $user->user_email;
        }
        $weight_kg = (string) get_user_meta($user_id, 'sosp_weight_kg', true);
        $height_cm = (string) get_user_meta($user_id, 'sosp_height_cm', true);
        $bmi_value = Date::bmi_value($weight_kg, $height_cm);
        $bmi_label = Date::bmi_label($weight_kg, $height_cm);

        return [
            'first_name' => $first_name,
            'last_name' => $last_name,
            'full_name' => trim($first_name . ' ' . $last_name),
            'birthdate_iso' => $birth_iso,
            'birthdate_fr' => $birth_iso !== '' ? Date::iso_to_fr($birth_iso) : '',
            'phone' => $phone,
            'email' => $email,
            'weight_kg' => $weight_kg,
            'height_cm' => $height_cm,
            'bmi_value' => $bmi_value !== null ? (string) $bmi_value : '',
            'bmi_label' => $bmi_label !== '—' ? $bmi_label : '',
        ];
    }
}
