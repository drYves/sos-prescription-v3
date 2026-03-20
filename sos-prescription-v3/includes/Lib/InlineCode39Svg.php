<?php
declare(strict_types=1);

namespace SosPrescription\Lib;

final class InlineCode39Svg
{
    /**
     * Patterns Code39, 9 éléments (barre/espace), 1 = large, 0 = étroit.
     * Le caractère '*' sert de start/stop.
     *
     * @var array<string, string>
     */
    private const PATTERNS = [
        '0' => '000110100',
        '1' => '100100001',
        '2' => '001100001',
        '3' => '101100000',
        '4' => '000110001',
        '5' => '100110000',
        '6' => '001110000',
        '7' => '000100101',
        '8' => '100100100',
        '9' => '001100100',
        'A' => '100001001',
        'B' => '001001001',
        'C' => '101001000',
        'D' => '000011001',
        'E' => '100011000',
        'F' => '001011000',
        'G' => '000001101',
        'H' => '100001100',
        'I' => '001001100',
        'J' => '000011100',
        'K' => '100000011',
        'L' => '001000011',
        'M' => '101000010',
        'N' => '000010011',
        'O' => '100010010',
        'P' => '001010010',
        'Q' => '000000111',
        'R' => '100000110',
        'S' => '001000110',
        'T' => '000010110',
        'U' => '110000001',
        'V' => '011000001',
        'W' => '111000000',
        'X' => '010010001',
        'Y' => '110010000',
        'Z' => '011010000',
        '-' => '010000101',
        '.' => '110000100',
        ' ' => '011000100',
        '$' => '010101000',
        '/' => '010100010',
        '+' => '010001010',
        '%' => '000101010',
        '*' => '010010100',
    ];

    public static function dataUri(string $text): string
    {
        $svg = self::svg($text);
        if ($svg === '') {
            return '';
        }

        return 'data:image/svg+xml;base64,' . base64_encode($svg);
    }

    public static function svg(string $text): string
    {
        $encoded = self::normalize($text);
        if ($encoded === '') {
            return '';
        }

        $payload = '*' . $encoded . '*';
        $quiet = 10;
        $narrow = 2;
        $wide = 5;
        $gap = $narrow;
        $barHeight = 44;
        $textHeight = 16;
        $paddingTop = 4;
        $paddingBottom = 2;

        $x = $quiet;
        $bars = [];
        $chars = preg_split('//u', $payload, -1, PREG_SPLIT_NO_EMPTY) ?: [];

        foreach ($chars as $char) {
            $pattern = self::PATTERNS[$char] ?? null;
            if ($pattern === null) {
                return '';
            }

            $elements = str_split($pattern);
            foreach ($elements as $index => $bit) {
                $width = $bit === '1' ? $wide : $narrow;
                $isBar = ($index % 2) === 0;
                if ($isBar) {
                    $bars[] = sprintf('<rect x="%d" y="%d" width="%d" height="%d" rx="0.4" ry="0.4" />', $x, $paddingTop, $width, $barHeight);
                }
                $x += $width;
            }

            $x += $gap;
        }

        $width = $x + $quiet - $gap;
        $height = $paddingTop + $barHeight + $textHeight + $paddingBottom;
        $safeText = htmlspecialchars($encoded, ENT_QUOTES | ENT_XML1, 'UTF-8');
        $barsHtml = implode("\n    ", $bars);
        $textX = (int) floor($width / 2);
        $textY = $paddingTop + $barHeight + 12;

        return <<<SVG
<svg xmlns="http://www.w3.org/2000/svg" width="{$width}" height="{$height}" viewBox="0 0 {$width} {$height}" role="img" aria-label="Code barre {$safeText}" shape-rendering="crispEdges">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <g fill="#0f172a">
    {$barsHtml}
  </g>
  <text x="{$textX}" y="{$textY}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="11" fill="#334155">{$safeText}</text>
</svg>
SVG;
    }

    private static function normalize(string $text): string
    {
        $text = strtoupper(trim($text));
        $text = preg_replace('/[^0-9A-Z.\- \$\/\+%]/', '', $text) ?? '';
        return $text;
    }
}
