<?php
declare(strict_types=1);

namespace SosPrescription\Services;

final class MagicLink
{
    public const TOKEN_BYTES = 32;
    public const TTL_SECONDS = 900;

    /**
     * @param array<string,mixed> $opts
     * @return array<string,mixed>
     */
    public function request(string $email, array $opts = []): array
    {
        $email = sanitize_email($email);
        if ($email === '' || !is_email($email)) {
            throw new \InvalidArgumentException('Adresse e-mail invalide.');
        }

        $email = strtolower($email);
        $roleHint = $this->normalizeRoleHint(isset($opts['role']) ? (string) $opts['role'] : 'patient');
        $redirectTo = isset($opts['redirect_to']) && is_string($opts['redirect_to']) ? $this->sanitizeRedirect($opts['redirect_to']) : '';

        $oldHash = get_transient($this->emailKey($email));
        if (is_string($oldHash) && $oldHash !== '') {
            delete_transient($this->tokenKey($oldHash));
            delete_transient($this->emailKey($email));
        }

        $token = bin2hex(random_bytes(self::TOKEN_BYTES));
        $tokenHash = $this->hashToken($token);
        $now = time();

        $payload = [
            'email' => $email,
            'role_hint' => $roleHint,
            'redirect_to' => $redirectTo,
            'created_at' => $now,
            'expires_at' => $now + self::TTL_SECONDS,
            'request_ip_hash' => $this->hashIp(isset($_SERVER['REMOTE_ADDR']) ? (string) $_SERVER['REMOTE_ADDR'] : ''),
        ];

        set_transient($this->tokenKey($tokenHash), $payload, self::TTL_SECONDS);
        set_transient($this->emailKey($email), $tokenHash, self::TTL_SECONDS);

        $magicUrl = add_query_arg('token', rawurlencode($token), home_url('/auth/magic'));
        $sent = $this->sendMail($email, $magicUrl, self::TTL_SECONDS);
        if (!$sent) {
            delete_transient($this->tokenKey($tokenHash));
            delete_transient($this->emailKey($email));
            throw new \RuntimeException('Impossible d’envoyer l’e-mail de connexion.');
        }

        return [
            'ok' => true,
            'email_masked' => $this->maskEmail($email),
            'expires_in' => self::TTL_SECONDS,
            'magic_url' => $magicUrl,
        ];
    }

    /**
     * @return array<string,mixed>
     */
    public function consume(string $token): array
    {
        $token = trim($token);
        if ($token === '') {
            throw new \InvalidArgumentException('Token invalide.');
        }

        $tokenHash = $this->hashToken($token);
        $record = get_transient($this->tokenKey($tokenHash));
        if (!is_array($record)) {
            throw new \RuntimeException('Lien magique invalide ou expiré.');
        }

        $email = isset($record['email']) ? sanitize_email((string) $record['email']) : '';
        if ($email === '' || !is_email($email)) {
            delete_transient($this->tokenKey($tokenHash));
            throw new \RuntimeException('Compte introuvable pour ce lien.');
        }

        $user = get_user_by('email', $email);
        $created = false;
        $roleHint = isset($record['role_hint']) ? $this->normalizeRoleHint((string) $record['role_hint']) : 'patient';

        if (!($user instanceof \WP_User)) {
            $created = true;
            $login = $this->buildUniqueLoginFromEmail($email);
            $randomPassword = wp_generate_password(24, true, true);
            $role = $this->resolveRoleForNewUser($roleHint);

            $userId = wp_insert_user([
                'user_login' => $login,
                'user_pass' => $randomPassword,
                'user_email' => $email,
                'display_name' => $this->defaultDisplayNameFromEmail($email),
                'role' => $role,
            ]);

            if (is_wp_error($userId)) {
                throw new \RuntimeException($userId->get_error_message());
            }

            $user = get_user_by('id', (int) $userId);
            if (!($user instanceof \WP_User)) {
                throw new \RuntimeException('Impossible de créer le compte.');
            }

            update_user_meta((int) $user->ID, 'sosprescription_magic_link_created', 1);
            update_user_meta((int) $user->ID, 'sosprescription_magic_role_hint', $roleHint);
        }

        wp_set_current_user((int) $user->ID);
        wp_set_auth_cookie((int) $user->ID, true, is_ssl());

        delete_transient($this->tokenKey($tokenHash));
        delete_transient($this->emailKey($email));

        return [
            'ok' => true,
            'created' => $created,
            'redirect_to' => isset($record['redirect_to']) ? (string) $record['redirect_to'] : '',
            'user' => [
                'id' => (int) $user->ID,
                'email' => (string) $user->user_email,
                'display_name' => (string) $user->display_name,
                'roles' => array_values((array) $user->roles),
            ],
        ];
    }

    private function sendMail(string $email, string $magicUrl, int $ttlSeconds): bool
    {
        $siteName = wp_specialchars_decode(get_bloginfo('name'), ENT_QUOTES);
        $ttlMinutes = max(1, (int) floor($ttlSeconds / 60));
        $subject = sprintf('[%s] Votre lien de connexion sécurisé', $siteName !== '' ? $siteName : 'SOS Prescription');

        $bodyLines = [
            'Bonjour,',
            '',
            'Cliquez sur le lien ci-dessous pour vous connecter à votre espace SOS Prescription :',
            $magicUrl,
            '',
            sprintf('Ce lien est valable %d minutes et ne peut être utilisé qu’une seule fois.', $ttlMinutes),
            '',
            'Si vous n’êtes pas à l’origine de cette demande, vous pouvez ignorer cet e-mail.',
        ];

        $headers = ['Content-Type: text/plain; charset=UTF-8'];
        return (bool) wp_mail($email, $subject, implode("\n", $bodyLines), $headers);
    }

    private function resolveRoleForNewUser(string $roleHint): string
    {
        $autoDoctor = (bool) apply_filters('sosprescription_magic_link_auto_doctor_role', false, $roleHint);
        if ($roleHint === 'doctor' && $autoDoctor && get_role('sosprescription_doctor')) {
            return 'sosprescription_doctor';
        }
        return 'subscriber';
    }

    private function buildUniqueLoginFromEmail(string $email): string
    {
        $base = preg_replace('/@.*/', '', $email);
        $login = sanitize_user((string) $base, true);
        if ($login === '') {
            $login = 'user';
        }

        $try = $login;
        $attempts = 0;
        while (username_exists($try)) {
            $attempts++;
            $try = $login . (string) random_int(1000, 9999);
            if ($attempts > 5) {
                $try = $login . '-' . (string) time();
                break;
            }
        }

        return $try;
    }

    private function defaultDisplayNameFromEmail(string $email): string
    {
        $local = preg_replace('/@.*/', '', $email) ?: 'Utilisateur';
        $local = str_replace(['.', '_', '-'], ' ', $local);
        $local = preg_replace('/\s+/', ' ', $local) ?: $local;
        return ucwords(trim($local));
    }

    private function normalizeRoleHint(string $role): string
    {
        $role = strtolower(trim($role));
        return in_array($role, ['patient', 'doctor'], true) ? $role : 'patient';
    }

    private function sanitizeRedirect(string $redirect): string
    {
        $redirect = trim($redirect);
        if ($redirect === '') {
            return '';
        }
        $sanitized = wp_sanitize_redirect($redirect);
        if ($sanitized === '') {
            return '';
        }
        return substr($sanitized, 0, 512);
    }

    private function hashToken(string $token): string
    {
        return hash_hmac('sha256', $token, (string) wp_salt('auth'));
    }

    private function tokenKey(string $tokenHash): string
    {
        return 'sp_magic_link_token_' . $tokenHash;
    }

    private function emailKey(string $email): string
    {
        return 'sp_magic_link_email_' . hash('sha256', strtolower(trim($email)));
    }

    private function hashIp(string $ip): string
    {
        $ip = trim($ip);
        if ($ip === '') {
            return '';
        }
        return substr(hash('sha256', wp_salt('auth') . '|' . $ip), 0, 16);
    }

    private function maskEmail(string $email): string
    {
        $parts = explode('@', $email, 2);
        if (count($parts) !== 2) {
            return $email;
        }
        [$local, $domain] = $parts;
        if ($local === '') {
            return '***@' . $domain;
        }
        $prefix = substr($local, 0, 1);
        return $prefix . str_repeat('*', max(2, strlen($local) - 1)) . '@' . $domain;
    }
}
