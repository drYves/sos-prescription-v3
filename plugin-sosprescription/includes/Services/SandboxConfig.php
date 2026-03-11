<?php

namespace SosPrescription\Services;

/**
 * Sandbox / testing mode configuration.
 *
 * Default is OFF (production-safe).
 * When ON, payment-related restrictions can be bypassed for testing.
 */
final class SandboxConfig
{
    public const OPTION_KEY = 'sosprescription_sandbox';

    /**
     * Project phases used for presets (mainly logging).
     *
     * @return array<int,string>
     */
    public static function phases(): array
    {
        return ['dev', 'test', 'prod'];
    }

    /**
     * @return array{testing_mode:bool, project_mode:bool, phase:string, updated_at:string}
     */
    public static function get(): array
    {
        $opt = get_option(self::OPTION_KEY, []);
        if (!is_array($opt)) {
            $opt = [];
        }

        $phase = isset($opt['phase']) ? sanitize_key((string) $opt['phase']) : 'dev';
        if (!in_array($phase, self::phases(), true)) {
            $phase = 'dev';
        }

        return [
            'testing_mode' => !empty($opt['testing_mode']),
            'project_mode' => array_key_exists('project_mode', $opt) ? !empty($opt['project_mode']) : true,
            'phase'        => $phase,
            'updated_at'   => isset($opt['updated_at']) ? (string) $opt['updated_at'] : '',
        ];
    }

    public static function is_testing_mode(): bool
    {
        $cfg = self::get();
        return !empty($cfg['testing_mode']);
    }

    public static function is_project_mode(): bool
    {
        $cfg = self::get();
        return !empty($cfg['project_mode']);
    }

    /**
     * @return 'dev'|'test'|'prod'
     */
    public static function phase(): string
    {
        $cfg = self::get();
        $phase = (string) ($cfg['phase'] ?? 'dev');
        if (!in_array($phase, self::phases(), true)) {
            $phase = 'dev';
        }
        /** @var 'dev'|'test'|'prod' $phase */
        return $phase;
    }

    /**
     * @param array{testing_mode?:mixed, project_mode?:mixed, phase?:mixed} $in
     * @return array{testing_mode:bool, project_mode:bool, phase:string, updated_at:string}
     */
    public static function update(array $in): array
    {
        $cfg = self::get();
        if (array_key_exists('testing_mode', $in)) {
            $cfg['testing_mode'] = !empty($in['testing_mode']);
        }

        if (array_key_exists('project_mode', $in)) {
            $cfg['project_mode'] = !empty($in['project_mode']);
        }

        if (array_key_exists('phase', $in)) {
            $phase = sanitize_key((string) $in['phase']);
            if (in_array($phase, self::phases(), true)) {
                $cfg['phase'] = $phase;
            }
        }

        $cfg['updated_at'] = gmdate('c');

        // Autoload false (admin-only setting)
        update_option(self::OPTION_KEY, $cfg, false);
        return $cfg;
    }
}
