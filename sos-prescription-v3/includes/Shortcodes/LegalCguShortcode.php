<?php
declare(strict_types=1);

namespace SosPrescription\Shortcodes;

use SosPrescription\Services\LegalPages;

final class LegalCguShortcode
{
    public static function register(): void
    {
        add_shortcode('sosprescription_legal_cgu', [self::class, 'render']);
    }

    public static function render(array|string $atts = []): string
    {
        return LegalPages::render('conditions');
    }
}
