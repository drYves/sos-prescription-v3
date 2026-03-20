<?php
declare(strict_types=1);

namespace SosPrescription\Lib;

final class InlineQrSvg
{
    private const QUIET_ZONE = 4;

    /** @var array<int, int>|null */
    private static ?array $gfExp = null;

    /** @var array<int, int>|null */
    private static ?array $gfLog = null;

    /**
     * 15 bits de format info pour ECC=M et mask=0.
     * Référence binaire: 101010000010010.
     */
    private const FORMAT_INFO_M_MASK_0 = 0x5412;

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
        $text = trim($text);
        if ($text === '') {
            return '';
        }

        $bytes = self::stringToBytes($text);
        $spec = self::pickSpec(count($bytes));
        if ($spec === null) {
            return '';
        }

        [$modules, $size] = self::encodeByteModeQr($bytes, $spec);

        $viewSize = $size + (self::QUIET_ZONE * 2);
        $rects = [];
        for ($y = 0; $y < $size; $y++) {
            $runStart = null;
            for ($x = 0; $x <= $size; $x++) {
                $isDark = $x < $size && !empty($modules[$y][$x]);
                if ($isDark && $runStart === null) {
                    $runStart = $x;
                    continue;
                }

                if ((!$isDark || $x === $size) && $runStart !== null) {
                    $width = $x - $runStart;
                    $rects[] = sprintf(
                        '<rect x="%d" y="%d" width="%d" height="1" />',
                        $runStart + self::QUIET_ZONE,
                        $y + self::QUIET_ZONE,
                        $width
                    );
                    $runStart = null;
                }
            }
        }

        $body = implode("\n    ", $rects);
        return <<<SVG
<svg xmlns="http://www.w3.org/2000/svg" width="{$viewSize}" height="{$viewSize}" viewBox="0 0 {$viewSize} {$viewSize}" role="img" aria-label="QR code" shape-rendering="crispEdges">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <g fill="#0f172a">
    {$body}
  </g>
</svg>
SVG;
    }

    /**
     * @param array<int, int> $dataBytes
     * @param array<string, mixed> $spec
     * @return array{0: array<int, array<int, bool>>, 1: int}
     */
    private static function encodeByteModeQr(array $dataBytes, array $spec): array
    {
        $dataCodewords = self::makeDataCodewords($dataBytes, (int) $spec['version'], (int) $spec['data_codewords']);
        $interleaved = self::interleaveBlocks($dataCodewords, $spec);
        $bits = self::codewordsToBits($interleaved);

        $size = (int) $spec['size'];
        [$modules, $isFunction] = self::initMatrix($spec);
        self::placeCodewords($modules, $isFunction, $bits, $size);
        self::applyMask0($modules, $isFunction, $size);
        self::drawFormatBits($modules, $isFunction, $size);

        return [$modules, $size];
    }

    /**
     * @return array<string, mixed>|null
     */
    private static function pickSpec(int $byteLength): ?array
    {
        $specs = [
            [
                'version' => 5,
                'size' => 37,
                'capacity_bytes' => 84,
                'data_codewords' => 86,
                'ecc_per_block' => 24,
                'blocks' => [43, 43],
                'alignment' => [6, 30],
            ],
            [
                'version' => 6,
                'size' => 41,
                'capacity_bytes' => 106,
                'data_codewords' => 108,
                'ecc_per_block' => 16,
                'blocks' => [27, 27, 27, 27],
                'alignment' => [6, 34],
            ],
        ];

        foreach ($specs as $spec) {
            if ($byteLength <= (int) $spec['capacity_bytes']) {
                return $spec;
            }
        }

        return null;
    }

    /**
     * @param array<int, int> $bytes
     * @return array<int, int>
     */
    private static function makeDataCodewords(array $bytes, int $version, int $dataCodewords): array
    {
        $bits = [];
        self::appendBits($bits, 0b0100, 4); // mode octet
        self::appendBits($bits, count($bytes), $version <= 9 ? 8 : 16);
        foreach ($bytes as $byte) {
            self::appendBits($bits, $byte, 8);
        }

        $maxBits = $dataCodewords * 8;
        $terminator = min(4, max(0, $maxBits - count($bits)));
        for ($i = 0; $i < $terminator; $i++) {
            $bits[] = 0;
        }

        while ((count($bits) % 8) !== 0) {
            $bits[] = 0;
        }

        $codewords = [];
        for ($i = 0, $count = count($bits); $i < $count; $i += 8) {
            $value = 0;
            for ($j = 0; $j < 8; $j++) {
                $value = ($value << 1) | ($bits[$i + $j] ?? 0);
            }
            $codewords[] = $value;
        }

        $pads = [0xEC, 0x11];
        $padIndex = 0;
        while (count($codewords) < $dataCodewords) {
            $codewords[] = $pads[$padIndex % 2];
            $padIndex++;
        }

        return $codewords;
    }

    /**
     * @param array<int, int> $dataCodewords
     * @param array<string, mixed> $spec
     * @return array<int, int>
     */
    private static function interleaveBlocks(array $dataCodewords, array $spec): array
    {
        $blocks = [];
        $offset = 0;
        foreach ((array) $spec['blocks'] as $blockLength) {
            $length = (int) $blockLength;
            $blocks[] = array_slice($dataCodewords, $offset, $length);
            $offset += $length;
        }

        $eccBlocks = [];
        $eccLen = (int) $spec['ecc_per_block'];
        foreach ($blocks as $block) {
            $eccBlocks[] = self::reedSolomonRemainder($block, $eccLen);
        }

        $out = [];
        $maxDataLen = 0;
        foreach ($blocks as $block) {
            $maxDataLen = max($maxDataLen, count($block));
        }

        for ($i = 0; $i < $maxDataLen; $i++) {
            foreach ($blocks as $block) {
                if (isset($block[$i])) {
                    $out[] = $block[$i];
                }
            }
        }

        for ($i = 0; $i < $eccLen; $i++) {
            foreach ($eccBlocks as $eccBlock) {
                if (isset($eccBlock[$i])) {
                    $out[] = $eccBlock[$i];
                }
            }
        }

        return $out;
    }

    /**
     * @param array<int, int> $codewords
     * @return array<int, int>
     */
    private static function codewordsToBits(array $codewords): array
    {
        $bits = [];
        foreach ($codewords as $codeword) {
            self::appendBits($bits, $codeword, 8);
        }
        return $bits;
    }

    /**
     * @param array<string, mixed> $spec
     * @return array{0: array<int, array<int, bool>>, 1: array<int, array<int, bool>>}
     */
    private static function initMatrix(array $spec): array
    {
        $size = (int) $spec['size'];
        $modules = array_fill(0, $size, array_fill(0, $size, false));
        $isFunction = array_fill(0, $size, array_fill(0, $size, false));

        self::drawFinder($modules, $isFunction, 0, 0, $size);
        self::drawFinder($modules, $isFunction, $size - 7, 0, $size);
        self::drawFinder($modules, $isFunction, 0, $size - 7, $size);

        for ($i = 8; $i < ($size - 8); $i++) {
            self::setFunctionModule($modules, $isFunction, $i, 6, ($i % 2) === 0, $size);
            self::setFunctionModule($modules, $isFunction, 6, $i, ($i % 2) === 0, $size);
        }

        $coords = (array) ($spec['alignment'] ?? []);
        foreach ($coords as $cy) {
            foreach ($coords as $cx) {
                $x = (int) $cx;
                $y = (int) $cy;
                if (!empty($isFunction[$y][$x])) {
                    continue;
                }
                self::drawAlignment($modules, $isFunction, $x, $y, $size);
            }
        }

        self::setFunctionModule($modules, $isFunction, 8, $size - 8, true, $size);
        self::reserveFormatInfo($isFunction, $size);

        return [$modules, $isFunction];
    }

    /**
     * @param array<int, array<int, bool>> $modules
     * @param array<int, array<int, bool>> $isFunction
     * @param array<int, int> $bits
     */
    private static function placeCodewords(array &$modules, array $isFunction, array $bits, int $size): void
    {
        $bitIndex = 0;
        $upward = true;

        for ($right = $size - 1; $right >= 1; $right -= 2) {
            if ($right === 6) {
                $right--;
            }

            $yRange = $upward ? range($size - 1, 0, -1) : range(0, $size - 1);
            foreach ($yRange as $y) {
                for ($dx = 0; $dx < 2; $dx++) {
                    $x = $right - $dx;
                    if (!empty($isFunction[$y][$x])) {
                        continue;
                    }

                    $modules[$y][$x] = !empty($bits[$bitIndex]);
                    $bitIndex++;
                }
            }

            $upward = !$upward;
        }
    }

    /**
     * @param array<int, array<int, bool>> $modules
     * @param array<int, array<int, bool>> $isFunction
     */
    private static function applyMask0(array &$modules, array $isFunction, int $size): void
    {
        for ($y = 0; $y < $size; $y++) {
            for ($x = 0; $x < $size; $x++) {
                if (!empty($isFunction[$y][$x])) {
                    continue;
                }
                if ((($x + $y) % 2) === 0) {
                    $modules[$y][$x] = !$modules[$y][$x];
                }
            }
        }
    }

    /**
     * @param array<int, array<int, bool>> $modules
     * @param array<int, array<int, bool>> $isFunction
     */
    private static function drawFormatBits(array &$modules, array &$isFunction, int $size): void
    {
        $bits = self::FORMAT_INFO_M_MASK_0;

        for ($i = 0; $i <= 5; $i++) {
            self::setFunctionModule($modules, $isFunction, 8, $i, (($bits >> $i) & 1) !== 0, $size);
        }
        self::setFunctionModule($modules, $isFunction, 8, 7, (($bits >> 6) & 1) !== 0, $size);
        self::setFunctionModule($modules, $isFunction, 8, 8, (($bits >> 7) & 1) !== 0, $size);
        self::setFunctionModule($modules, $isFunction, 7, 8, (($bits >> 8) & 1) !== 0, $size);

        for ($i = 9; $i <= 14; $i++) {
            self::setFunctionModule($modules, $isFunction, 14 - $i, 8, (($bits >> $i) & 1) !== 0, $size);
        }

        for ($i = 0; $i <= 7; $i++) {
            self::setFunctionModule($modules, $isFunction, $size - 1 - $i, 8, (($bits >> $i) & 1) !== 0, $size);
        }
        for ($i = 8; $i <= 14; $i++) {
            self::setFunctionModule($modules, $isFunction, 8, $size - 15 + $i, (($bits >> $i) & 1) !== 0, $size);
        }

        self::setFunctionModule($modules, $isFunction, 8, $size - 8, true, $size);
    }

    /**
     * @param array<int, array<int, bool>> $modules
     * @param array<int, array<int, bool>> $isFunction
     */
    private static function drawFinder(array &$modules, array &$isFunction, int $left, int $top, int $size): void
    {
        for ($dy = -1; $dy <= 7; $dy++) {
            for ($dx = -1; $dx <= 7; $dx++) {
                $x = $left + $dx;
                $y = $top + $dy;
                if ($x < 0 || $y < 0 || $x >= $size || $y >= $size) {
                    continue;
                }

                $isDark = (
                    ($dx >= 0 && $dx <= 6 && ($dy === 0 || $dy === 6))
                    || ($dy >= 0 && $dy <= 6 && ($dx === 0 || $dx === 6))
                    || ($dx >= 2 && $dx <= 4 && $dy >= 2 && $dy <= 4)
                );
                self::setFunctionModule($modules, $isFunction, $x, $y, $isDark, $size);
            }
        }
    }

    /**
     * @param array<int, array<int, bool>> $modules
     * @param array<int, array<int, bool>> $isFunction
     */
    private static function drawAlignment(array &$modules, array &$isFunction, int $cx, int $cy, int $size): void
    {
        for ($dy = -2; $dy <= 2; $dy++) {
            for ($dx = -2; $dx <= 2; $dx++) {
                $distance = max(abs($dx), abs($dy));
                self::setFunctionModule($modules, $isFunction, $cx + $dx, $cy + $dy, $distance !== 1, $size);
            }
        }
    }

    /**
     * @param array<int, array<int, bool>> $isFunction
     */
    private static function reserveFormatInfo(array &$isFunction, int $size): void
    {
        for ($i = 0; $i < 9; $i++) {
            if ($i === 6) {
                continue;
            }
            $isFunction[8][$i] = true;
            $isFunction[$i][8] = true;
        }

        for ($i = 0; $i < 8; $i++) {
            $isFunction[8][$size - 1 - $i] = true;
            $isFunction[$size - 1 - $i][8] = true;
        }
    }

    /**
     * @param array<int, array<int, bool>> $modules
     * @param array<int, array<int, bool>> $isFunction
     */
    private static function setFunctionModule(array &$modules, array &$isFunction, int $x, int $y, bool $isDark, int $size): void
    {
        if ($x < 0 || $y < 0 || $x >= $size || $y >= $size) {
            return;
        }

        $modules[$y][$x] = $isDark;
        $isFunction[$y][$x] = true;
    }

    /**
     * @param array<int, int> $bits
     */
    private static function appendBits(array &$bits, int $value, int $count): void
    {
        for ($i = $count - 1; $i >= 0; $i--) {
            $bits[] = ($value >> $i) & 1;
        }
    }

    /**
     * @param array<int, int> $data
     * @return array<int, int>
     */
    private static function reedSolomonRemainder(array $data, int $degree): array
    {
        $generator = self::generatorPolynomial($degree);
        $remainder = array_fill(0, $degree, 0);

        foreach ($data as $value) {
            $factor = $value ^ $remainder[0];
            array_shift($remainder);
            $remainder[] = 0;
            for ($i = 0; $i < $degree; $i++) {
                $remainder[$i] ^= self::gfMultiply($generator[$i + 1], $factor);
            }
        }

        return $remainder;
    }

    /**
     * @return array<int, int>
     */
    private static function generatorPolynomial(int $degree): array
    {
        $poly = [1];
        for ($i = 0; $i < $degree; $i++) {
            $poly = self::polyMultiply($poly, [1, self::gfPow($i)]);
        }
        return $poly;
    }

    /**
     * @param array<int, int> $a
     * @param array<int, int> $b
     * @return array<int, int>
     */
    private static function polyMultiply(array $a, array $b): array
    {
        $out = array_fill(0, count($a) + count($b) - 1, 0);
        foreach ($a as $i => $aVal) {
            foreach ($b as $j => $bVal) {
                $out[$i + $j] ^= self::gfMultiply($aVal, $bVal);
            }
        }
        return $out;
    }

    private static function gfPow(int $exp): int
    {
        self::initGaloisTables();
        return self::$gfExp[$exp % 255];
    }

    private static function gfMultiply(int $x, int $y): int
    {
        if ($x === 0 || $y === 0) {
            return 0;
        }

        self::initGaloisTables();
        return self::$gfExp[self::$gfLog[$x] + self::$gfLog[$y]];
    }

    private static function initGaloisTables(): void
    {
        if (self::$gfExp !== null && self::$gfLog !== null) {
            return;
        }

        self::$gfExp = array_fill(0, 512, 0);
        self::$gfLog = array_fill(0, 256, 0);
        $x = 1;
        for ($i = 0; $i < 255; $i++) {
            self::$gfExp[$i] = $x;
            self::$gfLog[$x] = $i;
            $x <<= 1;
            if (($x & 0x100) !== 0) {
                $x ^= 0x11D;
            }
        }
        for ($i = 255; $i < 512; $i++) {
            self::$gfExp[$i] = self::$gfExp[$i - 255];
        }
    }

    /**
     * @return array<int, int>
     */
    private static function stringToBytes(string $text): array
    {
        if ($text === '') {
            return [];
        }

        $bytes = unpack('C*', $text);
        if (!is_array($bytes)) {
            return [];
        }

        return array_values($bytes);
    }
}
