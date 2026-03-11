<?php
declare(strict_types=1);

namespace SosPrescription\Admin;

use SosPrescription\Services\OcrConfig;
use SosPrescription\Services\Audit;

final class OcrPage
{
    public static function register_actions(): void
    {
        add_action('admin_post_sosprescription_ocr_save', [self::class, 'handle_save']);
    }

    public static function render_page(): void
    {
        if (!current_user_can('sosprescription_manage') && !current_user_can('manage_options')) {
            wp_die('Accès refusé.');
        }

        $updated = isset($_GET['updated']) && (string) $_GET['updated'] === '1';

        $enabled  = (bool) get_option(OcrConfig::OPTION_KEY_ENABLED, true);
        $debug    = (bool) get_option(OcrConfig::OPTION_KEY_DEBUG, false);
        $keywords = (string) get_option(OcrConfig::OPTION_KEY_KEYWORDS, '');

        $keywords_regex = (string) (OcrConfig::public_data()['client']['keywords_regex'] ?? '');

        $plugin_path = defined('SOSPRESCRIPTION_PATH') ? (string) SOSPRESCRIPTION_PATH : '';
        $plugin_url  = defined('SOSPRESCRIPTION_URL') ? (string) SOSPRESCRIPTION_URL : '';

        $checks = [
            'tesseract_js' => [
                'label' => 'tesseract.min.js',
                'path' => $plugin_path . 'assets/js/libs/tesseract/tesseract.min.js',
                'url'  => $plugin_url . 'assets/js/libs/tesseract/tesseract.min.js',
            ],
            'worker_js' => [
                'label' => 'worker.min.js',
                'path' => $plugin_path . 'assets/js/libs/tesseract/worker.min.js',
                'url'  => $plugin_url . 'assets/js/libs/tesseract/worker.min.js',
            ],
            'core_js' => [
                'label' => 'tesseract-core.wasm.js',
                'path' => $plugin_path . 'assets/js/libs/tesseract/tesseract-core.wasm.js',
                'url'  => $plugin_url . 'assets/js/libs/tesseract/tesseract-core.wasm.js',
            ],
            'core_wasm' => [
                'label' => 'tesseract-core.wasm',
                'path' => $plugin_path . 'assets/js/libs/tesseract/tesseract-core.wasm',
                'url'  => $plugin_url . 'assets/js/libs/tesseract/tesseract-core.wasm',
            ],
            'lang_fr' => [
                'label' => 'fra.traineddata.gz',
                'path' => $plugin_path . 'assets/lang/fra.traineddata.gz',
                'url'  => $plugin_url . 'assets/lang/fra.traineddata.gz',
            ],
        ];

        echo '<div class="wrap">';
        echo '<h1 style="display:flex; align-items:center; gap:10px;">';
        echo '<img src="' . esc_url($plugin_url . 'assets/caduceus.svg') . '" alt="" style="width:26px;height:26px;" />';
        echo '<span>OCR (Client-side) — Validation des justificatifs</span>';
        echo '</h1>';

        echo '<p style="max-width:980px;">';
        echo 'Sur hébergement mutualisé, l\'OCR serveur est désactivé. ';
        echo 'Nous utilisons une <strong>validation OCR côté navigateur</strong> (Tesseract.js) : ';
        echo 'le document est analysé <em>localement</em> pour détecter des mots-clés (best effort). ';
        echo 'En cas de doute, le patient peut toujours <strong>forcer l\'envoi</strong>.';
        echo '</p>';

        echo '<div class="notice notice-info"><p>';
        echo '<strong>Mots-clés (regex utilisée) :</strong> <code>' . esc_html($keywords_regex) . '</code>';
        echo '</p></div>';

        if ($updated) {
            echo '<div class="notice notice-success is-dismissible"><p>Configuration OCR enregistrée.</p></div>';
        }

        echo '<div style="max-width:980px;background:#fff;border:1px solid #dcdcde;border-radius:12px;padding:16px;margin:14px 0;">';
        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        echo '<input type="hidden" name="action" value="sosprescription_ocr_save" />';
        wp_nonce_field('sosprescription_ocr_save');

        echo '<table class="form-table" role="presentation"><tbody>';

        echo '<tr>';
        echo '<th scope="row">Activer la validation OCR (client)</th>';
        echo '<td>';
        echo '<label><input type="checkbox" name="enabled" value="1" ' . checked($enabled, true, false) . ' /> Activer</label>';
        echo '<p class="description">Recommandé : activé. En cas de faux négatif, le patient peut forcer l\'envoi.</p>';
        echo '</td>';
        echo '</tr>';

        echo '<tr>';
        echo '<th scope="row">Mode debug</th>';
        echo '<td>';
        echo '<label><input type="checkbox" name="debug" value="1" ' . checked($debug, true, false) . ' /> Logs Tesseract dans la console navigateur</label>';
        echo '<p class="description">Utile pour diagnostiquer les lenteurs / erreurs OCR sur certains terminaux.</p>';
        echo '</td>';
        echo '</tr>';

        echo '<tr>';
        echo '<th scope="row">Mots-clés OCR</th>';
        echo '<td>';
        echo '<textarea name="sosprescription_ocr_client_keywords" rows="6" class="large-text code" placeholder="docteur\nrpps\nordonnance\n...">' . esc_textarea($keywords) . '</textarea>';
        echo '<p class="description">Un mot-clé par ligne (ou séparés par virgule). Si vide, la liste par défaut est utilisée.</p>';
        echo '</td>';
        echo '</tr>';

        echo '</tbody></table>';

        echo '<hr />';
        echo '<h2>Fichiers embarqués (sans CDN)</h2>';
        echo '<table class="widefat striped" style="max-width:960px;">';
        echo '<thead><tr><th>Composant</th><th>Présent</th><th>Chemin</th></tr></thead><tbody>';

        foreach ($checks as $c) {
            $ok = $c['path'] !== '' && file_exists($c['path']);
            echo '<tr>';
            echo '<td><strong>' . esc_html($c['label']) . '</strong></td>';
            echo '<td>' . ($ok ? '<span style="color:#16a34a;font-weight:700;">OK</span>' : '<span style="color:#dc2626;font-weight:700;">MANQUANT</span>') . '</td>';
            echo '<td><code>' . esc_html($c['path']) . '</code></td>';
            echo '</tr>';
        }

        echo '</tbody></table>';

        echo '<p style="margin-top:14px;"><button type="submit" class="button button-primary">Enregistrer</button></p>';

        echo '</form>';
        echo '</div>';

        echo '</div>';
    }

    public static function handle_save(): void
    {
        if (!current_user_can('sosprescription_manage') && !current_user_can('manage_options')) {
            wp_die('Accès refusé.');
        }

        check_admin_referer('sosprescription_ocr_save');

        $enabled = isset($_POST['enabled']) && (string) wp_unslash($_POST['enabled']) === '1';
        $debug   = isset($_POST['debug']) && (string) wp_unslash($_POST['debug']) === '1';

        $keywords = '';
        if (isset($_POST['sosprescription_ocr_client_keywords'])) {
            $keywords = sanitize_textarea_field(wp_unslash($_POST['sosprescription_ocr_client_keywords']));
            $keywords = trim($keywords);
        }

        update_option(OcrConfig::OPTION_KEY_ENABLED, (bool) $enabled, false);
        update_option(OcrConfig::OPTION_KEY_DEBUG, (bool) $debug, false);
        update_option(OcrConfig::OPTION_KEY_KEYWORDS, $keywords, false);

        Audit::log('config_ocr_client_update', 'config', null, null, [
            'enabled' => (bool) $enabled,
            'debug' => (bool) $debug,
            'keywords_len' => strlen($keywords),
        ]);

        $url = add_query_arg([
            'page' => 'sosprescription-ocr',
            'updated' => '1',
        ], admin_url('admin.php'));

        wp_safe_redirect($url);
        exit;
    }
}
