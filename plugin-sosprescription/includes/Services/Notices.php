<?php
declare(strict_types=1);

namespace SosPrescription\Services;

/**
 * Rendu du bandeau "mentions" côté patient.
 */
final class Notices
{
    /**
     * @param 'form'|'patient' $context
     */
    public static function render(string $context): string
    {
        $context = strtolower(trim($context));
        if ($context !== 'form' && $context !== 'patient') {
            return '';
        }

        $cfg = NoticesConfig::get();

        $enabled = $context === 'form'
            ? (bool) ($cfg['enabled_form'] ?? false)
            : (bool) ($cfg['enabled_patient'] ?? false);

        if (!$enabled) {
            return '';
        }

        $title = (string) ($cfg['title'] ?? 'Informations importantes');
        $items_text = (string) ($cfg['items_text'] ?? '');
        $dismissible = !empty($cfg['dismissible']);

        $lines = preg_split('/\r\n|\r|\n/', $items_text);
        if (!is_array($lines)) {
            $lines = [];
        }

        $items = [];
        foreach ($lines as $ln) {
            $ln = trim((string) $ln);
            if ($ln === '') {
                continue;
            }
            $items[] = $ln;
        }

        if (empty($items)) {
            return '';
        }

        // HTML très limité (liens) : on évite tout script.
        $allowed = [
            'a' => [
                'href' => true,
                'target' => true,
                'rel' => true,
            ],
            'strong' => [],
            'em' => [],
            'code' => [],
            'br' => [],
        ];

        $key = 'sosprescription_notice_' . $context;

        $close_btn = '';
        if ($dismissible) {
            $close_btn = '<button type="button" class="sp-notice-close" aria-label="Fermer">×</button>';
        }

        $html = '<div class="sosprescription-notice" data-notice-key="' . esc_attr($key) . '" role="note">';
        $html .= '<div class="sp-notice-header"><strong>' . esc_html($title) . '</strong>' . $close_btn . '</div>';
        $html .= '<ul class="sp-notice-list">';

        foreach ($items as $it) {
            $safe = wp_kses($it, $allowed);
            $html .= '<li>' . $safe . '</li>';
        }

        $html .= '</ul></div>';

        return $html;
    }
}
