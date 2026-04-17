<?php

declare(strict_types=1);

namespace SosPrescription\Admin;

use SosPrescription\Services\Audit;
use SosPrescription\Services\ComplianceConfig;
use SosPrescription\Services\LegalPages;

final class CompliancePage
{
    public static function register_actions(): void
    {
        add_action('admin_post_sosprescription_compliance_save', [self::class, 'handle_save']);
        add_action('admin_post_sp_generate_legal_pages', [self::class, 'handle_generate_legal_pages']);
    }

    public static function render_page(): void
    {
        if (!self::can_manage()) {
            wp_die('Accès refusé.');
        }

        $tabs = LegalPages::tab_definitions();
        $activeTab = self::resolve_tab(isset($_GET['tab']) ? (string) wp_unslash($_GET['tab']) : 'mentions');
        $state = LegalPages::get_state();
        $cfg = ComplianceConfig::get();
        $bindings = LegalPages::get_dashboard_bindings();
        $registry = is_array($state['registry'] ?? null) ? $state['registry'] : [];

        echo '<div class="wrap sp-legal-admin">';
        self::render_inline_styles();

        echo '<div class="sp-legal-admin__header">';
        echo '<div>';
        echo '<h1>Générateur de pages légales <span class="sp-legal-admin__badge">V7.2.0</span></h1>';
        echo '<p class="sp-legal-admin__intro">Complétez les champs structurés, mettez à jour l’onglet actif et publiez automatiquement trois pages publiques theme-owned, sans régression sur la projection front existante.</p>';
        echo '</div>';
        echo '<div class="sp-legal-admin__header-actions">';
        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        echo '<input type="hidden" name="action" value="sp_generate_legal_pages" />';
        wp_nonce_field('sp_generate_legal_pages');
        echo '<button type="submit" class="button button-secondary">Créer / réparer les pages</button>';
        echo '</form>';
        echo '</div>';
        echo '</div>';

        self::render_notices();
        self::render_status_cards($bindings, $cfg);

        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        echo '<input type="hidden" name="action" value="sosprescription_compliance_save" />';
        echo '<input type="hidden" name="active_tab" value="' . esc_attr($activeTab) . '" />';
        wp_nonce_field('sosprescription_compliance_save');

        self::render_global_panel($registry);
        self::render_tabs_nav($tabs, $activeTab);
        self::render_active_tab($activeTab, $tabs, $state, $bindings, $cfg);

        echo '<div class="sp-legal-admin__footer">';
        echo '<button type="submit" class="button button-primary button-large">Mettre à jour</button>';
        echo '<p class="description">La sauvegarde met à jour les options du générateur, crée les pages manquantes si nécessaire et resynchronise les liens de compatibilité <code>cgu_url</code> et <code>privacy_url</code>.</p>';
        echo '</div>';
        echo '</form>';

        echo '</div>';
    }

    public static function handle_save(): void
    {
        if (!self::can_manage()) {
            wp_die('Accès refusé.');
        }

        check_admin_referer('sosprescription_compliance_save');

        $activeTab = self::resolve_tab(isset($_POST['active_tab']) ? (string) wp_unslash($_POST['active_tab']) : 'mentions');
        $state = LegalPages::build_state_from_admin_submission($_POST, $activeTab);
        LegalPages::save_state($state);
        $result = LegalPages::ensure_pages();

        $created = isset($result['created']) && is_array($result['created']) ? $result['created'] : [];
        $updated = isset($result['updated']) && is_array($result['updated']) ? $result['updated'] : [];
        $errors = isset($result['errors']) && is_array($result['errors']) ? $result['errors'] : [];

        Audit::log('config_update', 'compliance', null, null, [
            'active_tab' => $activeTab,
            'created_count' => count($created),
            'updated_count' => count($updated),
            'error_count' => count($errors),
        ]);

        $url = add_query_arg([
            'page' => 'sosprescription-compliance',
            'tab' => $activeTab,
            'updated' => '1',
            'created_count' => (string) count($created),
            'updated_count' => (string) count($updated),
            'issues' => implode('||', array_map('strval', $errors)),
        ], admin_url('admin.php'));

        wp_safe_redirect($url);
        exit;
    }

    public static function handle_generate_legal_pages(): void
    {
        if (!self::can_manage()) {
            wp_die('Accès refusé.');
        }

        check_admin_referer('sp_generate_legal_pages');

        $result = LegalPages::ensure_pages();
        $created = isset($result['created']) && is_array($result['created']) ? $result['created'] : [];
        $updated = isset($result['updated']) && is_array($result['updated']) ? $result['updated'] : [];
        $errors = isset($result['errors']) && is_array($result['errors']) ? $result['errors'] : [];

        Audit::log('legal_pages_generate', 'compliance', null, null, [
            'created_count' => count($created),
            'updated_count' => count($updated),
            'errors_count' => count($errors),
        ]);

        $url = add_query_arg([
            'page' => 'sosprescription-compliance',
            'generated' => '1',
            'created_count' => (string) count($created),
            'updated_count' => (string) count($updated),
            'issues' => implode('||', array_map('strval', $errors)),
        ], admin_url('admin.php'));

        wp_safe_redirect($url);
        exit;
    }

    /**
     * @param array<string, array<string, mixed>> $bindings
     * @param array<string, mixed> $cfg
     */
    private static function render_status_cards(array $bindings, array $cfg): void
    {
        echo '<div class="sp-legal-admin__cards">';
        foreach ($bindings as $binding) {
            $statusKey = (string) ($binding['status_key'] ?? 'missing');
            $statusLabel = (string) ($binding['status_label'] ?? 'Inconnu');
            $permalink = (string) ($binding['permalink'] ?? '');
            $pageId = (int) ($binding['page_id'] ?? 0);
            $pageStatus = (string) ($binding['page_status'] ?? '');
            $pageTitle = (string) ($binding['page_title'] ?? '');

            echo '<section class="sp-legal-admin__card">';
            echo '<div class="sp-legal-admin__card-head">';
            echo '<h2>' . esc_html((string) ($binding['label'] ?? 'Document')) . '</h2>';
            echo '<span class="sp-legal-admin__status sp-legal-admin__status--' . esc_attr($statusKey) . '">' . esc_html($statusLabel) . '</span>';
            echo '</div>';
            echo '<dl class="sp-legal-admin__mini-definitions">';
            echo '<dt>Slug</dt><dd><code>' . esc_html((string) ($binding['slug'] ?? '')) . '</code></dd>';
            echo '<dt>Shortcode</dt><dd><code>' . esc_html((string) ($binding['shortcode'] ?? '')) . '</code></dd>';
            echo '<dt>Page reconnue</dt><dd>';
            if ($pageId > 0) {
                echo '<strong>' . esc_html($pageTitle !== '' ? $pageTitle : '(sans titre)') . '</strong><br />';
                echo '#' . esc_html((string) $pageId) . ' · ' . esc_html($pageStatus !== '' ? $pageStatus : 'inconnu');
            } else {
                echo '—';
            }
            echo '</dd>';
            echo '</dl>';
            echo '<p class="description">' . esc_html((string) ($binding['details'] ?? '')) . '</p>';
            if ($permalink !== '') {
                echo '<p class="sp-legal-admin__card-links"><a href="' . esc_url($permalink) . '" target="_blank" rel="noopener noreferrer">Voir</a>';
                if ($pageId > 0) {
                    $editLink = get_edit_post_link($pageId);
                    if (is_string($editLink) && $editLink !== '') {
                        echo ' · <a href="' . esc_url($editLink) . '">Éditer</a>';
                    }
                }
                echo '</p>';
            }
            echo '</section>';
        }

        echo '<section class="sp-legal-admin__card sp-legal-admin__card--compat">';
        echo '<div class="sp-legal-admin__card-head"><h2>Projection front</h2><span class="sp-legal-admin__status sp-legal-admin__status--info">Compatibilité</span></div>';
        echo '<dl class="sp-legal-admin__mini-definitions">';
        echo '<dt>CGU</dt><dd><code>' . esc_html((string) ($cfg['cgu_url'] ?? '')) . '</code></dd>';
        echo '<dt>Version CGU</dt><dd>' . esc_html((string) ($cfg['cgu_version'] ?? '')) . '</dd>';
        echo '<dt>Confidentialité</dt><dd><code>' . esc_html((string) ($cfg['privacy_url'] ?? '')) . '</code></dd>';
        echo '<dt>Version confidentialité</dt><dd>' . esc_html((string) ($cfg['privacy_version'] ?? '')) . '</dd>';
        echo '</dl>';
        echo '<p class="description">Le front existant continue à consommer <code>cgu_url</code>, <code>privacy_url</code>, <code>cgu_version</code> et <code>privacy_version</code>.</p>';
        echo '</section>';
        echo '</div>';
    }

    /**
     * @param array<string, mixed> $registry
     */
    private static function render_global_panel(array $registry): void
    {
        $defs = LegalPages::global_field_definitions();

        echo '<section class="sp-legal-admin__panel">';
        echo '<div class="sp-legal-admin__panel-head">';
        echo '<div><h2>Réglages partagés</h2><p class="description">Ces paramètres servent à la gouvernance éditoriale globale et à la compatibilité front.</p></div>';
        echo '</div>';
        echo '<div class="sp-legal-admin__grid sp-legal-admin__grid--shared">';

        foreach ($defs as $name => $def) {
            $value = $registry[$name] ?? null;
            self::render_field($name, $def, $value);
        }

        echo '</div>';
        echo '</section>';
    }

    /**
     * @param array<string, array<string, mixed>> $tabs
     */
    private static function render_tabs_nav(array $tabs, string $activeTab): void
    {
        echo '<nav class="nav-tab-wrapper sp-legal-admin__tabs" aria-label="Pages légales">';
        foreach ($tabs as $tabKey => $tab) {
            $url = add_query_arg([
                'page' => 'sosprescription-compliance',
                'tab' => $tabKey,
            ], admin_url('admin.php'));
            $classes = 'nav-tab' . ($tabKey === $activeTab ? ' nav-tab-active' : '');
            echo '<a class="' . esc_attr($classes) . '" href="' . esc_url($url) . '">' . esc_html((string) ($tab['title'] ?? $tabKey)) . '</a>';
        }
        echo '</nav>';
    }

    /**
     * @param array<string, array<string, mixed>> $tabs
     * @param array<string, mixed> $state
     * @param array<string, array<string, mixed>> $bindings
     * @param array<string, mixed> $cfg
     */
    private static function render_active_tab(string $activeTab, array $tabs, array $state, array $bindings, array $cfg): void
    {
        $tab = $tabs[$activeTab] ?? $tabs['mentions'];
        $registry = is_array($state['registry'] ?? null) ? $state['registry'] : [];
        $slotState = is_array($state[$activeTab] ?? null) ? $state[$activeTab] : [];
        $binding = $bindings[$activeTab] ?? [];

        echo '<div class="sp-legal-admin__tab-layout">';

        echo '<section class="sp-legal-admin__panel">';
        echo '<div class="sp-legal-admin__panel-head">';
        echo '<div><h2>' . esc_html((string) ($tab['title'] ?? '')) . '</h2><p class="description">' . esc_html((string) ($tab['description'] ?? '')) . '</p></div>';
        echo '</div>';
        echo '<div class="sp-legal-admin__grid">';
        foreach ((array) ($tab['fields'] ?? []) as $name => $def) {
            self::render_field($name, $def, $registry[$name] ?? null);
        }
        echo '</div>';
        echo '</section>';

        echo '<aside class="sp-legal-admin__side">';
        echo '<section class="sp-legal-admin__panel sp-legal-admin__panel--sticky">';
        echo '<div class="sp-legal-admin__panel-head"><div><h2>Publication</h2><p class="description">Métadonnées visibles et informations de binding du document actif.</p></div></div>';
        echo '<div class="sp-legal-admin__field">';
        echo '<label for="' . esc_attr($activeTab . '_version') . '">Version visible</label>';
        echo '<input class="regular-text" type="text" id="' . esc_attr($activeTab . '_version') . '" name="' . esc_attr($activeTab . '_version') . '" value="' . esc_attr((string) ($slotState['version'] ?? '1.0.0')) . '" />';
        echo '</div>';
        echo '<div class="sp-legal-admin__field">';
        echo '<label for="' . esc_attr($activeTab . '_effective_date') . '">Date d’effet</label>';
        echo '<input class="regular-text" type="date" id="' . esc_attr($activeTab . '_effective_date') . '" name="' . esc_attr($activeTab . '_effective_date') . '" value="' . esc_attr((string) ($slotState['effective_date'] ?? '')) . '" />';
        echo '</div>';
        echo '<dl class="sp-legal-admin__mini-definitions sp-legal-admin__mini-definitions--stacked">';
        echo '<dt>Dernière mise à jour</dt><dd>' . esc_html((string) ($slotState['updated_at'] ?? '')) . '</dd>';
        echo '<dt>Slug canonique</dt><dd><code>' . esc_html((string) ($binding['slug'] ?? '')) . '</code></dd>';
        echo '<dt>Shortcode</dt><dd><code>' . esc_html((string) ($binding['shortcode'] ?? '')) . '</code></dd>';
        echo '<dt>Binding</dt><dd>' . esc_html((string) ($binding['status_label'] ?? 'Inconnu')) . '</dd>';
        echo '</dl>';
        if (!empty($binding['permalink'])) {
            echo '<p class="sp-legal-admin__card-links"><a href="' . esc_url((string) $binding['permalink']) . '" target="_blank" rel="noopener noreferrer">Voir la page publique</a></p>';
        }
        if ($activeTab === 'conditions') {
            echo '<p class="description">Projection front actuelle : <code>' . esc_html((string) ($cfg['cgu_url'] ?? '')) . '</code> · version <strong>' . esc_html((string) ($cfg['cgu_version'] ?? '')) . '</strong>.</p>';
        }
        if ($activeTab === 'privacy') {
            echo '<p class="description">La section cookies est intégrée dans cette page ; aucune 4e page publique n’est créée. Projection front actuelle : <code>' . esc_html((string) ($cfg['privacy_url'] ?? '')) . '</code> · version <strong>' . esc_html((string) ($cfg['privacy_version'] ?? '')) . '</strong>.</p>';
        }
        echo '</section>';
        echo '</aside>';

        echo '</div>';
    }

    /**
     * @param array<string, mixed> $definition
     */
    private static function render_field(string $name, array $definition, mixed $value): void
    {
        $type = (string) ($definition['type'] ?? 'text');
        $label = (string) ($definition['label'] ?? $name);
        $description = (string) ($definition['description'] ?? '');
        $fieldId = 'sp_legal_' . $name;

        echo '<div class="sp-legal-admin__field sp-legal-admin__field--' . esc_attr($type) . '">';

        if ($type === 'checkbox') {
            echo '<label class="sp-legal-admin__checkbox">';
            echo '<input type="checkbox" id="' . esc_attr($fieldId) . '" name="' . esc_attr($name) . '" value="1"' . (!empty($value) ? ' checked' : '') . ' />';
            echo '<span>' . esc_html($label) . '</span>';
            echo '</label>';
            if ($description !== '') {
                echo '<p class="description">' . esc_html($description) . '</p>';
            }
            echo '</div>';
            return;
        }

        echo '<label for="' . esc_attr($fieldId) . '">' . esc_html($label) . '</label>';

        if ($type === 'textarea') {
            echo '<textarea id="' . esc_attr($fieldId) . '" name="' . esc_attr($name) . '" rows="5">' . esc_textarea(is_scalar($value) ? (string) $value : '') . '</textarea>';
        } else {
            $inputType = $type === 'email' ? 'email' : 'text';
            echo '<input class="regular-text" type="' . esc_attr($inputType) . '" id="' . esc_attr($fieldId) . '" name="' . esc_attr($name) . '" value="' . esc_attr(is_scalar($value) ? (string) $value : '') . '" />';
        }

        if ($description !== '') {
            echo '<p class="description">' . esc_html($description) . '</p>';
        }

        echo '</div>';
    }

    private static function render_notices(): void
    {
        $updated = isset($_GET['updated']) && (string) $_GET['updated'] === '1';
        $generated = isset($_GET['generated']) && (string) $_GET['generated'] === '1';
        $issues = isset($_GET['issues']) ? trim((string) wp_unslash($_GET['issues'])) : '';
        $createdCount = isset($_GET['created_count']) ? max(0, (int) $_GET['created_count']) : 0;
        $updatedCount = isset($_GET['updated_count']) ? max(0, (int) $_GET['updated_count']) : 0;

        if ($updated) {
            $message = sprintf('Générateur mis à jour. Pages créées : %d. Pages réparées ou resynchronisées : %d.', $createdCount, $updatedCount);
            echo '<div class="notice notice-success is-dismissible"><p>' . esc_html($message) . '</p></div>';
        }

        if ($generated) {
            $message = sprintf('Création / réparation terminée. Pages créées : %d. Pages resynchronisées : %d.', $createdCount, $updatedCount);
            echo '<div class="notice notice-success is-dismissible"><p>' . esc_html($message) . '</p></div>';
        }

        if ($issues !== '') {
            $parts = array_filter(array_map('trim', explode('||', $issues)), static fn(string $item): bool => $item !== '');
            echo '<div class="notice notice-warning"><p><strong>Points d’attention :</strong></p><ul style="margin-left:1.2em;">';
            foreach ($parts as $part) {
                echo '<li>' . esc_html($part) . '</li>';
            }
            echo '</ul></div>';
        }
    }

    private static function resolve_tab(string $candidate): string
    {
        $tabs = array_keys(LegalPages::tab_definitions());
        return in_array($candidate, $tabs, true) ? $candidate : 'mentions';
    }

    private static function can_manage(): bool
    {
        return current_user_can('sosprescription_manage') || current_user_can('manage_options');
    }

    private static function render_inline_styles(): void
    {
        echo '<style>
        .sp-legal-admin{max-width:1280px}
        .sp-legal-admin__header{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin:18px 0 22px}
        .sp-legal-admin__header h1{display:flex;align-items:center;gap:10px;margin:0 0 8px}
        .sp-legal-admin__badge{display:inline-flex;align-items:center;justify-content:center;padding:3px 10px;border-radius:999px;background:#eef2ff;border:1px solid #c7d2fe;color:#3730a3;font-size:12px;font-weight:700}
        .sp-legal-admin__intro{max-width:920px;margin:0;color:#50575e}
        .sp-legal-admin__cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin:0 0 18px}
        .sp-legal-admin__card,.sp-legal-admin__panel{background:#fff;border:1px solid #dcdcde;border-radius:16px;padding:18px;box-shadow:0 1px 2px rgba(15,23,42,.04)}
        .sp-legal-admin__card-head,.sp-legal-admin__panel-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:12px}
        .sp-legal-admin__card h2,.sp-legal-admin__panel h2{margin:0;font-size:18px;line-height:1.3}
        .sp-legal-admin__status{display:inline-flex;align-items:center;justify-content:center;padding:5px 10px;border-radius:999px;font-size:12px;font-weight:700;white-space:nowrap}
        .sp-legal-admin__status--exists{background:#dcfce7;color:#166534}
        .sp-legal-admin__status--missing{background:#fee2e2;color:#991b1b}
        .sp-legal-admin__status--modified_manually,.sp-legal-admin__status--incorrect_shortcode,.sp-legal-admin__status--incorrect_slug,.sp-legal-admin__status--slug_conflict,.sp-legal-admin__status--occupied_slug{background:#fef3c7;color:#92400e}
        .sp-legal-admin__status--info{background:#eef2ff;color:#3730a3}
        .sp-legal-admin__mini-definitions{display:grid;grid-template-columns:120px 1fr;gap:8px 12px;margin:0}
        .sp-legal-admin__mini-definitions dt{font-weight:600;color:#1d2327}
        .sp-legal-admin__mini-definitions dd{margin:0;color:#50575e}
        .sp-legal-admin__mini-definitions--stacked{grid-template-columns:1fr}
        .sp-legal-admin__mini-definitions--stacked dt{margin-top:8px}
        .sp-legal-admin__card-links{margin:10px 0 0}
        .sp-legal-admin__tabs{margin:18px 0 0;border-bottom:1px solid #dcdcde}
        .sp-legal-admin__tabs .nav-tab{border-top-left-radius:12px;border-top-right-radius:12px;padding:10px 16px}
        .sp-legal-admin__tab-layout{display:grid;grid-template-columns:minmax(0,1.8fr) minmax(320px,.9fr);gap:18px;margin-top:18px}
        .sp-legal-admin__grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
        .sp-legal-admin__grid--shared{grid-template-columns:repeat(4,minmax(0,1fr))}
        .sp-legal-admin__field{display:flex;flex-direction:column;gap:8px}
        .sp-legal-admin__field label{font-weight:600;color:#1d2327}
        .sp-legal-admin__field textarea,.sp-legal-admin__field input[type=text],.sp-legal-admin__field input[type=email],.sp-legal-admin__field input[type=date]{width:100%;max-width:none}
        .sp-legal-admin__field textarea{min-height:132px}
        .sp-legal-admin__checkbox{display:flex;align-items:center;gap:10px;font-weight:600}
        .sp-legal-admin__checkbox input{margin:0}
        .sp-legal-admin__side{display:block}
        .sp-legal-admin__panel--sticky{position:sticky;top:32px}
        .sp-legal-admin__footer{display:flex;align-items:center;gap:16px;margin:18px 0 0}
        .sp-legal-admin code{font-size:12px}
        @media (max-width: 1280px){.sp-legal-admin__cards{grid-template-columns:repeat(2,minmax(0,1fr))}.sp-legal-admin__grid--shared{grid-template-columns:repeat(2,minmax(0,1fr))}}
        @media (max-width: 960px){.sp-legal-admin__header{flex-direction:column}.sp-legal-admin__tab-layout,.sp-legal-admin__grid,.sp-legal-admin__grid--shared,.sp-legal-admin__cards{grid-template-columns:1fr}.sp-legal-admin__panel--sticky{position:static}}
        </style>';
    }
}
