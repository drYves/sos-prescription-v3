<?php
declare(strict_types=1);

namespace SOSPrescription\Admin;

use SOSPrescription\Services\StripeConfig;
use SOSPrescription\Services\Audit;

/**
 * Page back-office : configuration Stripe.
 *
 * Objectif :
 * - activer/désactiver le paiement
 * - stocker les clés Stripe (publishable/secret) + webhook secret
 *
 * IMPORTANT : la clé secrète ne doit jamais être exposée via l'API publique.
 */
final class PaymentsPage
{
    public static function register_actions(): void
    {
        add_action('admin_post_sosprescription_payments_save', [self::class, 'handle_save']);
    }

    public static function render_page(): void
    {
        if (!current_user_can('sosprescription_manage') && !current_user_can('manage_options')) {
            wp_die('Accès refusé.');
        }

        $cfg = StripeConfig::get();

        $updated = isset($_GET['updated']) && (string) $_GET['updated'] === '1';

        $webhook_url = rest_url('sosprescription/v1/stripe/webhook');

        echo '<div class="wrap">';
        echo '<h1 style="display:flex; align-items:center; gap:10px;">';
        echo '<img src="' . esc_url(SOSPRESCRIPTION_URL . 'assets/caduceus.svg') . '" alt="" style="width:26px;height:26px;" />';
        echo '<span>Paiements (Stripe)</span>';
        echo '</h1>';

        echo '<p style="max-width:980px;">Configurez Stripe pour activer le paiement (pré-autorisation) lors de la soumission. La capture est effectuée après décision médicale.</p>';

        if ($updated) {
            echo '<div class="notice notice-success is-dismissible"><p>Configuration Stripe enregistrée.</p></div>';
        }

        echo '<div style="max-width:980px;background:#fff;border:1px solid #dcdcde;border-radius:12px;padding:16px;margin:14px 0;">';
        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        echo '<input type="hidden" name="action" value="sosprescription_payments_save" />';
        wp_nonce_field('sosprescription_payments_save');

        echo '<table class="form-table" role="presentation"><tbody>';

        echo '<tr>';
        echo '<th scope="row">Activer Stripe</th>';
        echo '<td>';
        echo '<label><input type="checkbox" name="enabled" value="1" ' . checked($cfg['enabled'], true, false) . ' /> Paiements activés</label>';
        echo '<p class="description">Si désactivé, aucune pré-autorisation Stripe n\'est créée.</p>';
        echo '</td>';
        echo '</tr>';

        echo '<tr>';
        echo '<th scope="row"><label for="sosprescription_stripe_publishable">Clé publique (publishable)</label></th>';
        echo '<td>';
        echo '<input type="text" class="regular-text" id="sosprescription_stripe_publishable" name="publishable_key" value="' . esc_attr($cfg['publishable_key']) . '" />';
        echo '<p class="description">Commence généralement par <code>pk_test_</code> ou <code>pk_live_</code>.</p>';
        echo '</td>';
        echo '</tr>';

        echo '<tr>';
        echo '<th scope="row"><label for="sosprescription_stripe_secret">Clé secrète (secret)</label></th>';
        echo '<td>';
        echo '<input type="password" class="regular-text" id="sosprescription_stripe_secret" name="secret_key" value="' . esc_attr($cfg['secret_key']) . '" autocomplete="new-password" />';
        echo '<p class="description">Commence généralement par <code>sk_test_</code> ou <code>sk_live_</code>. Ne jamais exposer côté front.</p>';
        echo '</td>';
        echo '</tr>';

        echo '<tr>';
        echo '<th scope="row"><label for="sosprescription_stripe_webhook">Webhook signing secret</label></th>';
        echo '<td>';
        echo '<input type="password" class="regular-text" id="sosprescription_stripe_webhook" name="webhook_secret" value="' . esc_attr($cfg['webhook_secret']) . '" autocomplete="new-password" />';
        echo '<p class="description">Stripe Webhooks → endpoint → <em>Signing secret</em> (commence par <code>whsec_</code>).</p>';
        echo '</td>';
        echo '</tr>';

        echo '<tr>';
        echo '<th scope="row">Webhook URL</th>';
        echo '<td>';
        echo '<code>' . esc_html($webhook_url) . '</code>';
        echo '<p class="description">À configurer dans Stripe (Events recommandés : <code>payment_intent.amount_capturable_updated</code>, <code>payment_intent.succeeded</code>, <code>payment_intent.payment_failed</code>, <code>payment_intent.canceled</code>).</p>';
        echo '</td>';
        echo '</tr>';

        echo '</tbody></table>';

        echo '<p><button type="submit" class="button button-primary">Enregistrer</button></p>';
        echo '</form>';
        echo '</div>';

        echo '<div style="max-width:980px;">';
        echo '<h2>Notes</h2>';
        echo '<ul style="list-style:disc;padding-left:20px;">';
        echo '<li>Le système utilise des <strong>PaymentIntents</strong> en <code>capture_method=manual</code> : le patient autorise, puis la plateforme capture après décision.</li>';
        echo '<li>Les montants sont pilotés par la page <strong>Tarifs</strong>.</li>';
        echo '<li>En cas de refus médical, l\'autorisation est annulée (annulation du PaymentIntent) afin de ne pas débiter le patient.</li>';
        echo '</ul>';
        echo '</div>';

        echo '</div>';
    }

    public static function handle_save(): void
    {
        if (!current_user_can('sosprescription_manage') && !current_user_can('manage_options')) {
            wp_die('Accès refusé.');
        }

        check_admin_referer('sosprescription_payments_save');

        $enabled = isset($_POST['enabled']) && (string) wp_unslash($_POST['enabled']) === '1';
        $publishable_key = isset($_POST['publishable_key']) ? (string) wp_unslash($_POST['publishable_key']) : '';
        $secret_key = isset($_POST['secret_key']) ? (string) wp_unslash($_POST['secret_key']) : '';
        $webhook_secret = isset($_POST['webhook_secret']) ? (string) wp_unslash($_POST['webhook_secret']) : '';

        StripeConfig::update([
            'enabled' => $enabled,
            'publishable_key' => trim($publishable_key),
            'secret_key' => trim($secret_key),
            'webhook_secret' => trim($webhook_secret),
        ]);

        Audit::log('config_stripe_update', 'config', null, null, [
            'enabled' => (bool) $enabled,
            'has_publishable_key' => trim($publishable_key) !== '',
            'has_secret_key' => trim($secret_key) !== '',
            'has_webhook_secret' => trim($webhook_secret) !== '',
        ]);

        $url = add_query_arg([
            'page' => 'sosprescription-payments',
            'updated' => '1',
        ], admin_url('admin.php'));

        wp_safe_redirect($url);
        exit;
    }
}
