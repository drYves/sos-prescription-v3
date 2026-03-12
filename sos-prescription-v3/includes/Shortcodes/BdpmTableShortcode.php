<?php
declare(strict_types=1);

namespace SOSPrescription\Shortcodes;

use SOSPrescription\Assets;
use SOSPrescription\Services\Logger;

final class BdpmTableShortcode
{
    public static function register(): void
    {
        add_shortcode('sosprescription_bdpm_table', [self::class, 'render']);
    }

    /**
     * @param array<string, mixed> $atts
     */
    public static function render(array $atts = []): string
    {
        // per_page, version BDPM en base, etc. sont loggés pour faciliter le debug.

        $per_page = 20;
        if (isset($atts['per_page'])) {
            $per_page = (int) $atts['per_page'];
        }
        if ($per_page < 10) { $per_page = 10; }
        if ($per_page > 50) { $per_page = 50; }

        // Expose BDPM meta (version/date) — utile pour vérifier que la base a bien été importée.
        $meta = get_option('sosprescription_bdpm_meta');
        $version = (is_array($meta) && !empty($meta['bdpm_version'])) ? (string) $meta['bdpm_version'] : '';
        $imported = (is_array($meta) && !empty($meta['imported_at'])) ? (string) $meta['imported_at'] : '';

        Logger::log_shortcode('sosprescription_bdpm_table', 'info', 'shortcode_render', [
            'atts_count' => count($atts),
            'per_page' => (int) $per_page,
            'bdpm_version' => $version,
            'bdpm_imported_at' => $imported,
        ]);

        Assets::enqueue_frontend('bdpm_table');

        Logger::log_shortcode('sosprescription_bdpm_table', 'info', 'assets_state', [
            'script_enqueued' => wp_script_is('sosprescription-bdpm-table', 'enqueued'),
            'style_enqueued' => wp_style_is('sosprescription-bdpm-table', 'enqueued'),
        ]);

        return sprintf(
            '<div id="sosprescription-bdpm-table-root" data-per-page="%d" data-bdpm-version="%s" data-bdpm-imported="%s" data-icon="%s"></div><noscript>Activez JavaScript pour afficher le tableau BDPM.</noscript>',
            (int) $per_page,
            esc_attr($version),
            esc_attr($imported),
            esc_url(SOSPRESCRIPTION_URL . 'assets/caduceus.svg')
        );
    }
}
