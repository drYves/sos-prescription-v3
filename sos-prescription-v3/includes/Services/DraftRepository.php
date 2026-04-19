<?php
// includes/Services/DraftRepository.php

declare(strict_types=1);

namespace SosPrescription\Services;

use WP_User;

final class DraftRepository
{
    /**
     * @param array<string, mixed> $workerPayload
     */
    public function computeDraftTtl(array $workerPayload): int
    {
        $defaultTtl = 2 * HOUR_IN_SECONDS;

        $expiresAt = isset($workerPayload['expires_at']) && is_scalar($workerPayload['expires_at'])
            ? strtotime((string) $workerPayload['expires_at'])
            : false;
        if (is_int($expiresAt) && $expiresAt > time()) {
            return max(300, min(12 * HOUR_IN_SECONDS, $expiresAt - time()));
        }

        $expiresIn = isset($workerPayload['expires_in']) && is_numeric($workerPayload['expires_in'])
            ? (int) $workerPayload['expires_in']
            : 0;
        if ($expiresIn > 0) {
            return max(300, min(12 * HOUR_IN_SECONDS, $expiresIn));
        }

        return $defaultTtl;
    }

    /**
     * @param array<string, mixed> $payload
     */
    public function store(string $submissionRef, array $payload, int $ttl): void
    {
        set_transient(
            $this->buildTransientKey($submissionRef),
            $payload,
            max(300, $ttl)
        );
    }

    /**
     * @return array<string, mixed>|null
     */
    public function load(string $submissionRef): ?array
    {
        $payload = get_transient($this->buildTransientKey($submissionRef));
        return is_array($payload) ? $payload : null;
    }

    /**
     * @param array<string, mixed> $payload
     */
    public function currentUserMatches(array $payload): bool
    {
        $email = isset($payload['email']) && is_scalar($payload['email'])
            ? strtolower(trim((string) $payload['email']))
            : '';
        if ($email === '') {
            return current_user_can('manage_options');
        }

        $user = wp_get_current_user();
        if (!($user instanceof WP_User)) {
            return false;
        }

        $currentEmail = isset($user->user_email) ? strtolower(trim((string) $user->user_email)) : '';
        if ($currentEmail !== '' && $currentEmail === $email) {
            return true;
        }

        return current_user_can('manage_options');
    }

    private function buildTransientKey(string $submissionRef): string
    {
        return 'sosprescription_v4_draft_' . $submissionRef;
    }
}
