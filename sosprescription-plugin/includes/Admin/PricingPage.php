<?php
declare(strict_types=1);

namespace SosPrescription\Admin;

use SosPrescription\Services\Pricing;
use SosPrescription\Services\Audit;

final class PricingPage
{
    public static function register_actions(): void
    {
        add_action('admin_post_sosprescription_pricing_save', [self::class, 'handle_save']);
    }

    public static function render_page(): void
    {
        if (!current_user_can('sosprescription_manage') && !current_user_can('manage_options')) {
            wp_die('Accès refusé.');
        }

        $pricing = Pricing::get();
        $std_eur = number_format($pricing['standard_cents'] / 100, 2, '.', '');
        $exp_eur = number_format($pricing['express_cents'] / 100, 2, '.', '');
        $std_eta = (int) $pricing['standard_eta_minutes'];
        $exp_eta = (int) $pricing['express_eta_minutes'];
        $cur = esc_html($pricing['currency']);

        $updated = isset($_GET['updated']) && (string) $_GET['updated'] === '1';

        echo '<div class="wrap">';
        echo '<h1 style="display:flex; align-items:center; gap:10px;">';
        echo '<img src="' . esc_url(SOSPRESCRIPTION_URL . 'assets/caduceus.svg') . '" alt="" style="width:26px;height:26px;" />';
        echo '<span>Tarifs</span>';
        echo '</h1>';

        echo '<p style="max-width:980px;">Configurez le prix d\'une évaluation médicale (standard) et l\'option express. Ces tarifs sont exposés via l\'API REST pour affichage côté patient.</p>';

        if ($updated) {
            echo '<div class="notice notice-success is-dismissible"><p>Tarifs enregistrés.</p></div>';
        }

        echo '<div style="max-width:980px;background:#fff;border:1px solid #dcdcde;border-radius:12px;padding:16px;margin:14px 0;">';
        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        echo '<input type="hidden" name="action" value="sosprescription_pricing_save" />';
        wp_nonce_field('sosprescription_pricing_save');

        echo '<table class="form-table" role="presentation">';
        echo '<tbody>';

        echo '<tr>';
        echo '<th scope="row"><label for="sosprescription_pricing_standard">Tarif standard</label></th>';
        echo '<td>';
        echo '<input type="text" class="regular-text" id="sosprescription_pricing_standard" name="standard_eur" value="' . esc_attr($std_eur) . '" />';
        echo ' <span class="description">EUR (ex: 25.00)</span>';
        echo '</td>';
        echo '</tr>';

        echo '<tr>';
        echo '<th scope="row"><label for="sosprescription_pricing_express">Tarif express</label></th>';
        echo '<td>';
        echo '<input type="text" class="regular-text" id="sosprescription_pricing_express" name="express_eur" value="' . esc_attr($exp_eur) . '" />';
        echo ' <span class="description">EUR (ex: 40.00)</span>';
        echo '</td>';
        echo '</tr>';

        echo '<tr>';
        echo '<th scope="row"><label for="sosprescription_pricing_std_eta">Délai estimé standard</label></th>';
        echo '<td>';
        echo '<input type="number" class="small-text" id="sosprescription_pricing_std_eta" name="standard_eta_minutes" value="' . esc_attr((string) $std_eta) . '" min="1" step="1" />';
        echo ' <span class="description">minutes (ex: 120). Affiché côté patient (SLA UX).</span>';
        echo '</td>';
        echo '</tr>';

        echo '<tr>';
        echo '<th scope="row"><label for="sosprescription_pricing_exp_eta">Délai estimé express</label></th>';
        echo '<td>';
        echo '<input type="number" class="small-text" id="sosprescription_pricing_exp_eta" name="express_eta_minutes" value="' . esc_attr((string) $exp_eta) . '" min="1" step="1" />';
        echo ' <span class="description">minutes (ex: 30). Affiché côté patient (SLA UX).</span>';
        echo '</td>';
        echo '</tr>';

        echo '<tr>';
        echo '<th scope="row"><label for="sosprescription_pricing_currency">Devise</label></th>';
        echo '<td>';
        echo '<input type="text" class="regular-text" id="sosprescription_pricing_currency" name="currency" value="' . esc_attr($cur) . '" maxlength="3" />';
        echo ' <span class="description">ISO 4217 (EUR)</span>';
        echo '</td>';
        echo '</tr>';

        echo '</tbody>';
        echo '</table>';

        echo '<p><button type="submit" class="button button-primary">Enregistrer</button></p>';
        echo '<p class="description">Dernière mise à jour : <code>' . esc_html($pricing['updated_at']) . '</code></p>';

        echo '</form>';
        echo '</div>';

        echo '</div>';
    }

    public static function handle_save(): void
    {
        if (!current_user_can('sosprescription_manage') && !current_user_can('manage_options')) {
            wp_die('Accès refusé.');
        }

        check_admin_referer('sosprescription_pricing_save');

        $standard_eur = isset($_POST['standard_eur']) ? (string) wp_unslash($_POST['standard_eur']) : '';
        $express_eur = isset($_POST['express_eur']) ? (string) wp_unslash($_POST['express_eur']) : '';
        $standard_eta = isset($_POST['standard_eta_minutes']) ? (int) wp_unslash($_POST['standard_eta_minutes']) : 0;
        $express_eta = isset($_POST['express_eta_minutes']) ? (int) wp_unslash($_POST['express_eta_minutes']) : 0;
        $currency = isset($_POST['currency']) ? (string) wp_unslash($_POST['currency']) : 'EUR';

        $standard_cents = self::eur_string_to_cents($standard_eur);
        $express_cents = self::eur_string_to_cents($express_eur);
        $currency = strtoupper(trim($currency));
        if ($currency === '') { $currency = 'EUR'; }

        Pricing::update([
            'standard_cents' => $standard_cents,
            'express_cents' => $express_cents,
            'standard_eta_minutes' => $standard_eta,
            'express_eta_minutes' => $express_eta,
            'currency' => $currency,
        ]);
		Audit::log('config_pricing_update', 'config', null, null, [
			'standard_cents' => $standard_cents,
			'express_cents' => $express_cents,
			'standard_eta_minutes' => $standard_eta,
			'express_eta_minutes' => $express_eta,
			'currency' => $currency,
		]);

        $url = add_query_arg([
            'page' => 'sosprescription-pricing',
            'updated' => '1',
        ], admin_url('admin.php'));

        wp_safe_redirect($url);
        exit;
    }

    private static function eur_string_to_cents(string $s): int
    {
        $s = trim($s);
        if ($s === '') { return 0; }
        $s = str_replace(',', '.', $s);
        if (!is_numeric($s)) { return 0; }
        $v = (float) $s;
        if ($v < 0) { $v = 0.0; }
        return (int) round($v * 100);
    }
}
