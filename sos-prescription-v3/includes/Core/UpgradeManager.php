<?php

declare(strict_types=1);

namespace SOSPrescription\Core;

use SOSPrescription\Frontend\VerificationPage;

/**
 * Upgrade manager (Release Readiness).
 *
 * Responsibilities:
 * - Track plugin code version in DB (option: sosprescription_version)
 * - Provide a stable hook point for future migrations
 * - Flush rewrite rules ONCE after upgrade (admin-only) so /v/{token} works
 */
final class UpgradeManager
{
    private const OPT_CODE_VERSION = 'sosprescription_version';
    private const OPT_NEEDS_FLUSH_REWRITE = 'sosprescription_needs_rewrite_flush';

    public static function register_hooks(): void
    {
        // We flush rewrite rules only in admin, and only once after upgrade.
        add_action('admin_init', [self::class, 'maybe_flush_rewrite_rules'], 99);
    }

    /**
     * Detects a plugin upgrade and runs the (currently empty) upgrade routine.
     *
     * This runs on plugins_loaded (via Plugin::init) so it can react to version
     * changes without requiring manual activation steps.
     */
    public static function maybe_upgrade(): void
    {
        $codeVersion = self::get_code_version();
        if ($codeVersion === '') {
            return;
        }

        $storedVersion = (string) get_option(self::OPT_CODE_VERSION, '');
        if ($storedVersion === $codeVersion) {
            return;
        }

        // Hook point for future migrations.
        self::upgrade_routine($storedVersion, $codeVersion);

        // Persist version.
        update_option(self::OPT_CODE_VERSION, $codeVersion, true);

        // Schedule rewrite flush (admin-only).
        update_option(self::OPT_NEEDS_FLUSH_REWRITE, $codeVersion, true);
    }

    /**
     * A future-proof upgrade routine.
     *
     * @param string $from Previous version stored in DB (may be empty).
     * @param string $to   Current code version.
     */
    private static function upgrade_routine(string $from, string $to): void
    {
        /**
         * Fires when the plugin detects a version upgrade.
         *
         * Useful to attach migrations (DB schema, options, file moves, etc.).
         */
        do_action('sosprescription_upgrade_routine', $from, $to);
    }

    /**
     * Flush rewrite rules once after an upgrade.
     *
     * We do it in admin_init because our rewrite rules are registered on init.
     */
    public static function maybe_flush_rewrite_rules(): void
    {
        if (!current_user_can('manage_options')) {
            return;
        }

        $codeVersion = self::get_code_version();
        if ($codeVersion === '') {
            return;
        }

        $flag = (string) get_option(self::OPT_NEEDS_FLUSH_REWRITE, '');
        if ($flag !== $codeVersion) {
            return;
        }

        // Ensure /v/{token} rewrite is registered before flushing.
        if (class_exists(VerificationPage::class)) {
            VerificationPage::register_rewrite();
        }

        flush_rewrite_rules(false);
        delete_option(self::OPT_NEEDS_FLUSH_REWRITE);
    }

    private static function get_code_version(): string
    {
        return defined('SOSPRESCRIPTION_VERSION') ? (string) SOSPRESCRIPTION_VERSION : '';
    }
}
