<?php
declare(strict_types=1);

namespace SosPrescription\Shortcodes;

use SosPrescription\Services\LegalPages;

final class LegalCookiesShortcode
{
    public static function register(): void
    {
        add_shortcode('sosprescription_legal_cookies', [self::class, 'render']);
    }

    public static function render(array|string $atts = []): string
    {
        return LegalPages::render_cookies_shortcode();
    }
}
