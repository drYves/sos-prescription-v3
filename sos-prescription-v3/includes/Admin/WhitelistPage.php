<?php
declare(strict_types=1);

namespace SOSPrescription\Admin;

use SOSPrescription\Services\Whitelist;
use SOSPrescription\Services\Audit;

/**
 * Backoffice : configuration du périmètre (whitelist ATC/CIS).
 *
 * Objectif MVP :
 * - restreindre le service aux traitements autorisés au lancement,
 * - exclure explicitement certaines classes (ex: stupéfiants),
 * - permettre d'ajuster le périmètre sans modifier le code.
 */
final class WhitelistPage
{
    public static function register_actions(): void
    {
        add_action('admin_post_sosprescription_whitelist_save', [self::class, 'handle_save']);
    }

    public static function render_page(): void
    {
        if (!current_user_can('sosprescription_manage') && !current_user_can('manage_options')) {
            wp_die('Accès refusé.');
        }

        $cfg = Whitelist::get();

        $updated = isset($_GET['updated']) && (string) $_GET['updated'] === '1';

        $mode = esc_html($cfg['mode']);
        $require_evidence = (bool) $cfg['require_evidence'];

        $allowed_atc = esc_textarea(implode("\n", $cfg['allowed_atc_prefixes']));
        $denied_atc  = esc_textarea(implode("\n", $cfg['denied_atc_prefixes']));
        $allowed_cis = esc_textarea(implode("\n", array_map('strval', $cfg['allowed_cis'])));
        $denied_cis  = esc_textarea(implode("\n", array_map('strval', $cfg['denied_cis'])));

        echo '<div class="wrap">';
        echo '<h1 style="display:flex; align-items:center; gap:10px;">';
        echo '<img src="' . esc_url(SOSPRESCRIPTION_URL . 'assets/caduceus.svg') . '" alt="" style="width:26px;height:26px;" />';
        echo '<span>Périmètre (whitelist)</span>';
        echo '</h1>';

        echo '<p style="max-width:980px;">';
        echo 'Définissez les <strong>classes ATC</strong> et/ou les <strong>codes CIS</strong> autorisés. ';
        echo 'Le formulaire patient filtrera les médicaments en fonction de ce périmètre (si activé).';
        echo '</p>';

        echo '<div class="notice notice-info"><p><strong>Note :</strong> La whitelist s’appuie sur la table <code>CIS_MITM</code> (ATC). Assurez-vous d’avoir importé la BDPM avec ce fichier.</p></div>';


// Bloc "glossaire" — pour rendre les codes lisibles en backoffice
echo '<div style="max-width:980px;background:#fff;border:1px solid #dcdcde;border-radius:12px;padding:16px;margin:14px 0;">';
echo '<h2 style="margin:0 0 10px;">Glossaire des codes & flows</h2>';
echo '<p style="margin:0 0 12px;color:#4b5563;">Ces codes apparaissent dans la BDPM (Base de Données Publique des Médicaments) et dans les réglages de périmètre.</p>';
echo '<table class="widefat striped" style="max-width:980px;">';
echo '<thead><tr><th style="width:140px;">Code</th><th>Signification</th><th style="width:240px;">Exemple</th></tr></thead><tbody>';
echo '<tr><td><code>CIS</code></td><td>Code Identifiant de Spécialité (niveau “médicament / spécialité”). Stable et utilisé comme clé principale en BDPM.</td><td><code>64793681</code></td></tr>';
echo '<tr><td><code>CIP13</code></td><td>Code présentation (niveau “boîte / conditionnement”). Un même CIS peut avoir plusieurs CIP13.</td><td><code>3400934998331</code></td></tr>';
echo '<tr><td><code>ATC</code></td><td>Classification OMS Anatomique, Thérapeutique et Chimique. On utilise des <em>préfixes</em> (ex: <code>N02BE</code>) pour définir des familles.</td><td><code>N02BE01</code> (Paracétamol)</td></tr>';
echo '<tr><td><code>flow</code></td><td>Parcours côté formulaire (paramètre transmis à l’API de recherche). En V1.5.28 : <code>ro_proof</code> = denylist uniquement ; <code>depannage_no_proof</code> = allowlist + denylist.</td><td><code>ro_proof</code></td></tr>';
echo '</tbody></table>';
$doc_url = esc_url(SOSPRESCRIPTION_URL . 'docs/SOSPrescription-Whitelist-Documentation-v1.5.28.pdf');
echo '<p style="margin:12px 0 0;"><a class="button button-secondary" href="' . $doc_url . '" target="_blank" rel="noopener">Télécharger la documentation Whitelist (PDF)</a></p>';
echo '</div>';

        if ($updated) {
            echo '<div class="notice notice-success is-dismissible"><p>Configuration enregistrée.</p></div>';
        }

        echo '<div style="max-width:980px;background:#fff;border:1px solid #dcdcde;border-radius:12px;padding:16px;margin:14px 0;">';
        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        echo '<input type="hidden" name="action" value="sosprescription_whitelist_save" />';
        wp_nonce_field('sosprescription_whitelist_save');

        echo '<table class="form-table" role="presentation">';
        echo '<tbody>';

        echo '<tr>';
        echo '<th scope="row">Mode</th>';
        echo '<td>';
        echo '<fieldset>';
        echo '<label style="display:block; margin-bottom:6px;"><input type="radio" name="mode" value="off" ' . checked($mode, 'off', false) . ' /> Off (pas de restriction)</label>';
        echo '<label style="display:block; margin-bottom:6px;"><input type="radio" name="mode" value="warn" ' . checked($mode, 'warn', false) . ' /> Warn (journalise hors périmètre, n’empêche pas)</label>';
        echo '<label style="display:block; margin-bottom:6px;"><input type="radio" name="mode" value="enforce" ' . checked($mode, 'enforce', false) . ' /> Enforce (filtre + bloque hors périmètre)</label>';
        echo '</fieldset>';
        echo '<p class="description">Recommandé en production : <strong>Enforce</strong>.</p>';
        echo '</td>';
        echo '</tr>';

        echo '<tr>';
        echo '<th scope="row">Preuve obligatoire</th>';
        echo '<td>';
        echo '<label><input type="checkbox" name="require_evidence" value="1" ' . checked($require_evidence, true, false) . ' /> Exiger au moins 1 pièce justificative (ordonnance / boîte / historique)</label>';
        echo '</td>';
        echo '</tr>';

        echo '<tr>';
        echo '<th scope="row"><label for="sosprescription_whitelist_allowed_atc">ATC autorisés (préfixes)</label></th>';
        echo '<td>';
        echo '<textarea class="large-text code" rows="8" id="sosprescription_whitelist_allowed_atc" name="allowed_atc_prefixes" placeholder="Ex:\nG03A\nH03A\nR06">' . $allowed_atc . '</textarea>';
        echo '<p class="description">Un préfixe par ligne. Exemple : <code>G03A</code> autorise toutes les spécialités dont le code ATC commence par G03A.</p>';
        echo '</td>';
        echo '</tr>';

        echo '<tr>';
        echo '<th scope="row"><label for="sosprescription_whitelist_denied_atc">ATC interdits (préfixes)</label></th>';
        echo '<td>';
        echo '<textarea class="large-text code" rows="6" id="sosprescription_whitelist_denied_atc" name="denied_atc_prefixes" placeholder="Ex:\nN02A\nN05B\nN05C">' . $denied_atc . '</textarea>';
        echo '<p class="description">Ces préfixes priment sur l’autorisation (deny &gt; allow).</p>';
        echo '</td>';
        echo '</tr>';

        echo '<tr>';
        echo '<th scope="row"><label for="sosprescription_whitelist_allowed_cis">CIS autorisés (override)</label></th>';
        echo '<td>';
        echo '<textarea class="large-text code" rows="5" id="sosprescription_whitelist_allowed_cis" name="allowed_cis" placeholder="Un CIS par ligne">' . $allowed_cis . '</textarea>';
        echo '<p class="description">Override : si un CIS est listé ici, il sera autorisé même si l’ATC est absent (sauf si explicitement interdit en CIS).</p>';
        echo '</td>';
        echo '</tr>';

        echo '<tr>';
        echo '<th scope="row"><label for="sosprescription_whitelist_denied_cis">CIS interdits (override)</label></th>';
        echo '<td>';
        echo '<textarea class="large-text code" rows="5" id="sosprescription_whitelist_denied_cis" name="denied_cis" placeholder="Un CIS par ligne">' . $denied_cis . '</textarea>';
        echo '<p class="description">Override : un CIS listé ici est toujours interdit.</p>';
        echo '</td>';
        echo '</tr>';

        echo '</tbody>';
        echo '</table>';

        echo '<p><button type="submit" class="button button-primary">Enregistrer</button></p>';
        echo '<p class="description">Dernière mise à jour : <code>' . esc_html((string) $cfg['updated_at']) . '</code></p>';

        echo '</form>';
        echo '</div>';

        echo '</div>';
    }

    public static function handle_save(): void
    {
        if (!current_user_can('sosprescription_manage') && !current_user_can('manage_options')) {
            wp_die('Accès refusé.');
        }

        check_admin_referer('sosprescription_whitelist_save');

        $mode = isset($_POST['mode']) ? (string) wp_unslash($_POST['mode']) : 'enforce';
        $allowed_atc_prefixes = isset($_POST['allowed_atc_prefixes']) ? (string) wp_unslash($_POST['allowed_atc_prefixes']) : '';
        $denied_atc_prefixes  = isset($_POST['denied_atc_prefixes']) ? (string) wp_unslash($_POST['denied_atc_prefixes']) : '';
        $allowed_cis = isset($_POST['allowed_cis']) ? (string) wp_unslash($_POST['allowed_cis']) : '';
        $denied_cis  = isset($_POST['denied_cis']) ? (string) wp_unslash($_POST['denied_cis']) : '';
        $require_evidence = isset($_POST['require_evidence']) && (string) wp_unslash($_POST['require_evidence']) === '1';

        Whitelist::update([
            'mode' => $mode,
            'allowed_atc_prefixes' => $allowed_atc_prefixes,
            'denied_atc_prefixes' => $denied_atc_prefixes,
            'allowed_cis' => $allowed_cis,
            'denied_cis' => $denied_cis,
            'require_evidence' => $require_evidence,
        ]);

        Audit::log('config_whitelist_update', 'config', null, null, [
            'mode' => $mode,
            'require_evidence' => (bool) $require_evidence,
        ]);

        $url = add_query_arg([
            'page' => 'sosprescription-whitelist',
            'updated' => '1',
        ], admin_url('admin.php'));

        wp_safe_redirect($url);
        exit;
    }
}
