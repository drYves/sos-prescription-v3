<?php
declare(strict_types=1);

namespace SosPrescription\Assets;

final class AssetManifest
{
    private string $path;

    /** @var array<string, mixed> */
    private array $data = [];

    public function __construct(string $path)
    {
        $this->path = $path;
        $this->load();
    }

    private function load(): void
    {
        if (!is_file($this->path)) {
            $this->data = [];
            return;
        }

        $json = file_get_contents($this->path);
        if (!is_string($json) || $json === '') {
            $this->data = [];
            return;
        }

        $data = json_decode($json, true);
        if (!is_array($data)) {
            $this->data = [];
            return;
        }

        $this->data = $data;
    }

    /**
     * @return array<string, mixed>|null
     */
    public function get(string $entry): ?array
    {
        $candidates = [];
        $candidates[] = $entry;
        $candidates[] = ltrim($entry, '/');

        $base = basename($entry);
        if ($base !== '' && $base !== $entry) {
            $candidates[] = $base;
        }

        // Try without TS/JS extension (e.g. "form" / "admin")
        $stem = preg_replace('/\.(t|j)sx?$/i', '', $base);
        if (is_string($stem) && $stem !== '' && $stem !== $base) {
            $candidates[] = $stem;
        }

        foreach ($candidates as $k) {
            $item = $this->data[$k] ?? null;
            if (is_array($item)) {
                return $item;
            }
        }

        // Fallback: match keys ending with basename
        if ($base !== '') {
            foreach ($this->data as $k => $v) {
                if (!is_string($k) || !is_array($v)) {
                    continue;
                }
                if ($k === $base || str_ends_with($k, '/' . $base)) {
                    return $v;
                }
            }
        }

        return null;
    }
}
