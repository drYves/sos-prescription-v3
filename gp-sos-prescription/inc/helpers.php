<?php
/**
 * Helpers du shell SOS Prescription V2.
 *
 * @package gp-sos-prescription
 */

if (! defined('ABSPATH')) {
    exit;
}

add_filter('nav_menu_css_class', 'sp_mark_primary_patient_menu_item', 20, 4);

/**
 * Retourne les slugs structurants du site.
 *
 * @return array<string, string|array<int, string>>
 */
function sp_get_route_map()
{
    return (array) apply_filters(
        'sp_route_map',
        array(
            'request'        => 'demande-ordonnance',
            'patient'        => 'espace-patient',
            'console'        => 'console-medecin',
            'doctor-account' => 'compte-medecin',
            'doctor-catalog' => 'catalogue-medicaments',
            'security'       => 'securite-confidentialite',
            'legal'          => array(
                'mentions-legales',
                'politique-de-confidentialite',
                'conditions-du-service',
            ),
            'verify'         => array(
                'verification-pharmacien',
                'verification-code',
                'verifier-code-delivrance',
            ),
        )
    );
}

/**
 * Retourne le slug courant si possible.
 *
 * @return string
 */
function sp_get_current_page_slug()
{
    if (! is_singular()) {
        return '';
    }

    $post = get_queried_object();

    if (! ($post instanceof WP_Post)) {
        return '';
    }

    return (string) $post->post_name;
}

/**
 * Retourne l’URL canonique d’une route connue.
 *
 * @param string $key Clé de la route.
 * @return string
 */
function sp_get_page_url($key)
{
    $routes = sp_get_route_map();

    if (! isset($routes[$key])) {
        return home_url('/');
    }

    if (is_array($routes[$key])) {
        $slug = (string) reset($routes[$key]);
    } else {
        $slug = (string) $routes[$key];
    }

    return home_url('/' . trim($slug, '/') . '/');
}


/**
 * Retourne la matrice publique besoin -> flow -> priorité.
 *
 * Le shell expose des routes simples via le paramètre `type`, puis le moteur applicatif
 * doit retrouver le flow médical et la priorité par défaut correspondants.
 *
 * @return array<string, array{type:string, flow:string, priority:string}>
 */
function sp_get_request_entry_catalog()
{
    return (array) apply_filters(
        'sp_request_entry_catalog',
        array(
            'standard' => array(
                'type'     => 'standard',
                'flow'     => 'ro_proof',
                'priority' => 'standard',
            ),
            'depannage-sos' => array(
                'type'     => 'depannage-sos',
                'flow'     => 'depannage_no_proof',
                'priority' => 'express',
            ),
        )
    );
}

/**
 * Normalise une entrée publique issue du paramètre `type` vers sa clé canonique.
 *
 * @param string $type Valeur brute d'URL.
 * @return string
 */
function sp_normalize_request_entry_type($type)
{
    $normalized = strtolower(trim((string) $type));

    $aliases = array(
        'standard'          => 'standard',
        'renewal'           => 'standard',
        'ro_proof'          => 'standard',
        'renouvellement'    => 'standard',
        'depannage'         => 'depannage-sos',
        'depannage_no_proof'=> 'depannage-sos',
        'sos'               => 'depannage-sos',
    );

    return isset($aliases[$normalized]) ? $aliases[$normalized] : $normalized;
}

/**
 * Retourne la configuration métier d'une entrée publique.
 *
 * @param string $type Type public.
 * @return array{type:string, flow:string, priority:string}|null
 */
function sp_get_request_entry_config($type)
{
    $catalog = sp_get_request_entry_catalog();
    $type    = sp_normalize_request_entry_type($type);

    if (! isset($catalog[$type])) {
        return null;
    }

    return $catalog[$type];
}

/**
 * Retourne l'URL d'entrée publique canonique pour un besoin donné.
 *
 * @param string $type Type public.
 * @return string
 */
function sp_get_request_entry_url($type)
{
    $config = sp_get_request_entry_config($type);

    if (! is_array($config)) {
        return sp_get_page_url('request');
    }

    return add_query_arg('type', (string) $config['type'], sp_get_page_url('request'));
}

/**
 * Teste si le slug courant correspond à une route donnée.
 *
 * @param string $key Clé de route.
 * @return bool
 */
function sp_current_page_is($key)
{
    $routes = sp_get_route_map();
    $slug   = sp_get_current_page_slug();

    if ($slug === '' || ! isset($routes[$key])) {
        return false;
    }

    if (is_array($routes[$key])) {
        return in_array($slug, $routes[$key], true);
    }

    return $slug === (string) $routes[$key];
}


/**
 * Marque l'entrée primaire "Espace patient" avec une classe de capsule stable.
 *
 * @param array<int, string> $classes Classes CSS courantes.
 * @param WP_Post            $item Objet item de menu.
 * @param stdClass           $args Arguments du menu.
 * @param int                $depth Profondeur.
 * @return array<int, string>
 */
function sp_mark_primary_patient_menu_item($classes, $item, $args, $depth)
{
    if ($depth !== 0) {
        return $classes;
    }

    $theme_location = isset($args->theme_location) ? (string) $args->theme_location : '';
    if ($theme_location !== 'primary') {
        return $classes;
    }

    $item_url    = isset($item->url) ? untrailingslashit((string) $item->url) : '';
    $patient_url = untrailingslashit(sp_get_page_url('patient'));
    $item_title  = isset($item->title) ? sanitize_title((string) $item->title) : '';

    if ($item_url === $patient_url || $item_title === 'espace-patient') {
        $classes[] = 'sp-nav-button';
    }

    return array_values(array_unique($classes));
}

/**
 * Rend le contenu minimaliste du widget tarifaire.
 *
 * @return string
 */

function sp_get_pricing_widget_markup()
{
    return '<div class="sp-pricing-widget">'
        . '<div class="sp-pricing-widget__item">'
            . '<div class="sp-pricing-widget__row">'
                . '<span class="sp-pricing-widget__label">' . esc_html__('Standard', 'gp-sos-prescription') . '</span>'
                . '<strong class="sp-pricing-widget__value">[sosprescription_pricing field="price" type="standard"]</strong>'
            . '</div>'
            . '<p class="sp-pricing-widget__meta">' . esc_html__('Continuité simple', 'gp-sos-prescription') . '</p>'
            . '<p class="sp-pricing-widget__meta sp-pricing-widget__meta--muted">' . esc_html__('File classique', 'gp-sos-prescription') . '</p>'
        . '</div>'
        . '<div class="sp-pricing-widget__item sp-pricing-widget__item--priority">'
            . '<div class="sp-pricing-widget__row">'
                . '<span class="sp-pricing-widget__label">' . esc_html__('SOS Prioritaire', 'gp-sos-prescription') . '</span>'
                . '<strong class="sp-pricing-widget__value">[sosprescription_pricing field="price" type="express"]</strong>'
            . '</div>'
            . '<p class="sp-pricing-widget__meta">' . esc_html__('Oubli, perte, voyage', 'gp-sos-prescription') . '</p>'
            . '<p class="sp-pricing-widget__meta sp-pricing-widget__meta--muted">' . esc_html__('Dossier prioritaire', 'gp-sos-prescription') . '</p>'
        . '</div>'
        . '<p class="sp-pricing-widget__foot">' . esc_html__('Zéro frais si refus médical', 'gp-sos-prescription') . '</p>'
    . '</div>';
}

/**
 * Retourne la variante de shell à afficher sur la page courante.
 de shell à afficher sur la page courante.
 *
 * @return string
 */
function sp_get_page_shell_variant()
{
    if (sp_is_console_context()) {
        return 'console';
    }

    if (sp_current_page_is('request')) {
        return 'request';
    }

    if (sp_current_page_is('patient')) {
        return 'patient';
    }

    if (sp_current_page_is('doctor-account')) {
        return 'doctor-account';
    }

    if (sp_current_page_is('doctor-catalog')) {
        return 'doctor-catalog';
    }

    if (sp_is_verify_context()) {
        return 'verify';
    }

    return 'public';
}

/**
 * Retourne le contexte macro utilisé par le body et les assets.
 *
 * @return string
 */
function sp_get_current_context()
{
    $variant = sp_get_page_shell_variant();

    if (in_array($variant, array('request', 'patient'), true)) {
        return 'patient';
    }

    if (in_array($variant, array('doctor-account', 'doctor-catalog'), true)) {
        return 'doctor';
    }

    if ($variant === 'console') {
        return 'console';
    }

    if ($variant === 'verify') {
        return 'verify';
    }

    return 'public';
}

/**
 * @return bool
 */
function sp_is_public_context()
{
    return sp_get_current_context() === 'public';
}

/**
 * @return bool
 */
function sp_is_patient_context()
{
    return sp_get_current_context() === 'patient';
}

/**
 * @return bool
 */
function sp_is_doctor_context()
{
    return sp_get_current_context() === 'doctor';
}

/**
 * @return bool
 */
function sp_is_console_context()
{
    return is_page_template('page-sos-console.php') || sp_current_page_is('console');
}

/**
 * @return bool
 */
function sp_is_verify_context()
{
    return sp_current_page_is('verify');
}

/**
 * Retourne le SVG du symbole de marque, si disponible.
 *
 * @return string
 */
function sp_get_brand_logo_svg()
{
    $logo_path = SP_THEME_PATH . '/assets/img/brand/sos-logo-symbol.svg';

    if (! is_readable($logo_path)) {
        return '';
    }

    $svg = file_get_contents($logo_path);

    return is_string($svg) ? $svg : '';
}


/**
 * Détermine si un lien contextuel est actif.
 *
 * @param string $variant Variante de shell.
 * @param string $url URL cible.
 * @return bool
 */
function sp_is_context_link_active($variant, $url)
{
    $url = untrailingslashit((string) $url);

    if ($variant === 'console' && $url === untrailingslashit(sp_get_page_url('console'))) {
        return sp_is_console_context();
    }

    if ($url === untrailingslashit(sp_get_page_url('request'))) {
        return sp_current_page_is('request');
    }

    if ($url === untrailingslashit(sp_get_page_url('patient'))) {
        return sp_current_page_is('patient');
    }

    if ($url === untrailingslashit(sp_get_page_url('doctor-account'))) {
        return sp_current_page_is('doctor-account');
    }

    if ($url === untrailingslashit(sp_get_page_url('doctor-catalog'))) {
        return sp_current_page_is('doctor-catalog');
    }

    if ($url === untrailingslashit(sp_get_page_url('security'))) {
        return sp_current_page_is('security');
    }

    return false;
}

/**
 * Retourne le libellé principal du role bar.
 *
 * @param string $variant Variante de shell.
 * @return string
 */
function sp_get_rolebar_title($variant)
{
    $titles = array(
        'request'        => __('Demande d’ordonnance', 'gp-sos-prescription'),
        'patient'        => __('Espace patient', 'gp-sos-prescription'),
        'doctor-account' => __('Compte médecin', 'gp-sos-prescription'),
        'doctor-catalog' => __('Référentiel Médicaments (BDPM)', 'gp-sos-prescription'),
        'console'        => __('Console médecin', 'gp-sos-prescription'),
    );

    return isset($titles[$variant]) ? $titles[$variant] : __('SOS Prescription', 'gp-sos-prescription');
}

/**
 * Retourne la phrase d’appui du role bar.
 *
 * @param string $variant Variante de shell.
 * @return string
 */
function sp_get_rolebar_description($variant)
{
    $descriptions = array(
        'request'        => __('Décrivez l’essentiel. Un médecin décide.', 'gp-sos-prescription'),
        'patient'        => __('Retrouvez vos ordonnances, vos documents et votre suivi médical.', 'gp-sos-prescription'),
        'doctor-account' => __('Gérez vos informations professionnelles et votre signature.', 'gp-sos-prescription'),
        'doctor-catalog' => __('Recherchez rapidement dans le Référentiel Médicaments (BDPM).', 'gp-sos-prescription'),
        'console'        => __('Validez, refusez ou réorientez sans friction.', 'gp-sos-prescription'),
    );

    return isset($descriptions[$variant]) ? $descriptions[$variant] : '';
}

/**
 * Retourne le hook custom GP Elements pour le role bar courant.
 *
 * @param string $variant Variante de shell.
 * @return string
 */
function sp_get_rolebar_hook_name($variant)
{
    if (in_array($variant, array('request', 'patient'), true)) {
        return 'sp_app_rolebar_patient';
    }

    if (in_array($variant, array('doctor-account', 'doctor-catalog'), true)) {
        return 'sp_app_rolebar_doctor';
    }

    if ($variant === 'console') {
        return 'sp_app_console_bar';
    }

    return '';
}

/**
 * Retourne le hook custom GP Elements pour la sidebar courante.
 *
 * @param string $variant Variante de shell.
 * @return string
 */
function sp_get_sidebar_hook_name($variant)
{
    if ($variant === 'request') {
        return 'sp_app_sidebar_request';
    }

    if ($variant === 'patient') {
        return 'sp_app_sidebar_patient';
    }

    if ($variant === 'doctor-account') {
        return 'sp_app_sidebar_doctor';
    }

    return '';
}


/**
 * Indique si la page courante doit afficher une sidebar de widgets contextuels.
 *
 * Le référentiel BDPM et la console restent volontairement sans widgets.
 *
 * @param string $variant Variante de shell.
 * @return bool
 */
function sp_page_has_context_sidebar($variant = '')
{
    if ($variant === '') {
        $variant = sp_get_page_shell_variant();
    }

    return in_array($variant, array('request', 'patient', 'doctor-account'), true);
}

/**
 * Retourne vrai si la barre applicative doit être rendue en mode compact.
 * Utilisé pour les écrans sans widgets latéraux afin d’éviter un faux décalage
 * visuel avec la zone principale.
 *
 * @param string $variant Variante de shell.
 * @return bool
 */
function sp_rolebar_uses_compact_layout($variant = '')
{
    if ($variant === '') {
        $variant = sp_get_page_shell_variant();
    }

    return in_array($variant, array('doctor-catalog', 'console'), true);
}

/**
 * Retourne vrai si le chip de contexte doit être affiché.
 * Sur les écrans sans sidebar, on le retire pour aligner parfaitement
 * le titre avec le cadre applicatif.
 *
 * @param string $variant Variante de shell.
 * @return bool
 */
function sp_rolebar_shows_chip($variant = '')
{
    if ($variant === '') {
        $variant = sp_get_page_shell_variant();
    }

    return ! in_array($variant, array('doctor-catalog', 'console'), true);
}

/**
 * Capture la sortie d'un hook pour pouvoir décider d'un fallback propre.
 *
 * @param string              $hook_name Hook à exécuter.
 * @param array<int, mixed>   $args Arguments transmis au hook.
 * @return string
 */
function sp_capture_action_output($hook_name, $args = array())
{
    if (! is_string($hook_name) || $hook_name === '') {
        return '';
    }

    ob_start();
    do_action_ref_array($hook_name, $args);
    $output = ob_get_clean();

    return is_string($output) ? $output : '';
}

/**
 * Retourne l’emplacement de menu contextuel.
 *
 * @param string $variant Variante de shell.
 * @return string
 */


/**
 * Retourne vrai si la page doit utiliser un conteneur resserré plein cadre.
 * Utilisé pour les écrans sans widgets afin d’aligner parfaitement le role bar
 * et la surface principale du shortcode.
 *
 * @param string $variant Variante de shell.
 * @return bool
 */
function sp_uses_compact_app_container($variant = '')
{
    if ($variant === '') {
        $variant = sp_get_page_shell_variant();
    }

    return in_array($variant, array('doctor-catalog', 'console'), true);
}

/**
 * Retourne l’emplacement applicatif unique utilisé par les shells sécurisés.
 *
 * @param string $variant Variante de shell.
 * @return string
 */
function sp_get_context_menu_location($variant)
{
    if (in_array($variant, array('request', 'patient', 'doctor-account', 'doctor-catalog', 'console'), true)) {
        return 'app-menu';
    }

    return '';
}

/**
 * Retourne les seules routes que le thème peut injecter automatiquement
 * dans la navigation applicative. Le référentiel BDPM reste géré manuellement
 * par l’administrateur dans le menu principal WordPress.
 *
 * @return array<int, string>
 */
function sp_get_app_menu_dynamic_route_keys()
{
    return array('patient', 'console', 'doctor-account');
}

/**
 * Décrit la navigation applicative canonique.
 *
 * @return array<int, array<string, mixed>>
 */
function sp_get_app_menu_blueprint()
{
    return array(
        array(
            'key'   => 'patient',
            'label' => __('Espace patient', 'gp-sos-prescription'),
            'url'   => sp_get_page_url('patient'),
            'group' => 'patient',
        ),
        array(
            'key'       => 'separator-patient-doctor',
            'separator' => true,
        ),
        array(
            'key'   => 'console',
            'label' => __('Console médecin', 'gp-sos-prescription'),
            'url'   => sp_get_page_url('console'),
            'group' => 'doctor',
        ),
        array(
            'key'   => 'doctor-account',
            'label' => __('Compte médecin', 'gp-sos-prescription'),
            'url'   => sp_get_page_url('doctor-account'),
            'group' => 'doctor',
        ),
    );
}

/**
 * Retourne la clé de route correspondant à un slug structurant.
 *
 * @param string $slug Slug courant.
 * @return string
 */
function sp_get_route_key_from_slug($slug)
{
    $slug = trim((string) $slug, '/');

    foreach (sp_get_app_menu_dynamic_route_keys() as $key) {
        if ($slug === trim((string) sp_get_route_map()[$key], '/')) {
            return $key;
        }
    }

    return '';
}

/**
 * Retourne la clé de route correspondant à une URL de menu.
 *
 * @param string $url URL de menu.
 * @return string
 */
function sp_match_menu_url_to_route_key($url)
{
    $path = trim((string) wp_parse_url((string) $url, PHP_URL_PATH), '/');

    if ($path === '') {
        return '';
    }

    foreach (sp_get_app_menu_dynamic_route_keys() as $key) {
        $route_path = trim((string) wp_parse_url(sp_get_page_url($key), PHP_URL_PATH), '/');
        if ($path === $route_path) {
            return $key;
        }
    }

    return '';
}

/**
 * Extrait les routes connues depuis le menu assigné à l’emplacement app-menu.
 *
 * @return array<string, array<string, string>>
 */
function sp_get_assigned_app_menu_map()
{
    $locations = get_nav_menu_locations();

    if (empty($locations['app-menu'])) {
        return array();
    }

    $menu_items = wp_get_nav_menu_items((int) $locations['app-menu']);
    if (! is_array($menu_items) || empty($menu_items)) {
        return array();
    }

    $map = array();

    foreach ($menu_items as $menu_item) {
        if (! $menu_item) {
            continue;
        }

        $route_key = '';

        if (! empty($menu_item->object_id)) {
            $post = get_post((int) $menu_item->object_id);
            if ($post instanceof WP_Post) {
                $route_key = sp_get_route_key_from_slug((string) $post->post_name);
            }
        }

        if ($route_key === '') {
            $route_key = sp_match_menu_url_to_route_key((string) ($menu_item->url ?? ''));
        }

        if ($route_key === '') {
            continue;
        }

        $map[$route_key] = array(
            'title' => isset($menu_item->title) ? (string) $menu_item->title : '',
            'url'   => isset($menu_item->url) ? (string) $menu_item->url : '',
        );
    }

    return $map;
}

/**
 * Retourne la navigation applicative fusionnée avec l’emplacement app-menu.
 *
 * @param string $variant Variante active.
 * @return array<int, array<string, mixed>>
 */
function sp_get_context_navigation_items($variant)
{
    unset($variant);

    $items     = sp_get_app_menu_blueprint();
    $overrides = sp_get_assigned_app_menu_map();

    foreach ($items as $index => $item) {
        if (! empty($item['separator']) || empty($item['key'])) {
            continue;
        }

        $key = (string) $item['key'];
        if (! isset($overrides[$key])) {
            continue;
        }

        if (! empty($overrides[$key]['url'])) {
            $items[$index]['url'] = $overrides[$key]['url'];
        }
    }

    return $items;
}

/**
 * Rend la navigation applicative standardisée.
 *
 * @param string $variant Variante active.
 * @param string $prefix  Préfixe de classes BEM.
 * @return void
 */
function sp_render_context_navigation($variant, $prefix = 'sp-rolebar')
{
    $items = sp_get_context_navigation_items($variant);

    echo '<nav class="' . esc_attr($prefix . '__nav sp-app-menu-nav') . '" aria-label="Navigation applicative">';
    echo '<ul class="' . esc_attr($prefix . '__menu sp-app-menu') . '">';

    foreach ($items as $item) {
        if (! empty($item['separator'])) {
            echo '<li class="' . esc_attr($prefix . '__item sp-app-menu__item sp-app-menu__item--separator') . '" aria-hidden="true"><span class="sp-app-menu__separator"></span></li>';
            continue;
        }

        $url       = isset($item['url']) ? (string) $item['url'] : home_url('/');
        $label     = isset($item['label']) ? (string) $item['label'] : '';
        $group     = ! empty($item['group']) ? sanitize_html_class((string) $item['group']) : 'patient';
        $item_key  = ! empty($item['key']) ? sanitize_html_class((string) $item['key']) : 'item';
        $is_active = sp_is_context_link_active($variant, $url);

        $item_classes = array(
            $prefix . '__item',
            'sp-app-menu__item',
            'sp-app-menu__item--' . $group,
            'sp-app-menu__item--' . $item_key,
        );

        $link_classes = array(
            $prefix . '__link',
            'sp-app-menu__link',
        );

        if ($is_active) {
            $item_classes[] = 'current-menu-item';
            $link_classes[] = 'is-active';
        }

        $label_type = sp_get_context_menu_item_type($item_key);
        $label_html = $label_type !== ''
            ? sp_get_decorated_menu_label_html($label, $label_type)
            : esc_html($label);

        echo '<li class="' . esc_attr(implode(' ', $item_classes)) . '">';
        echo '<a class="' . esc_attr(implode(' ', $link_classes)) . '" href="' . esc_url($url) . '"' . ($is_active ? ' aria-current="page"' : '') . '>' . $label_html . '</a>';
        echo '</li>';
    }

    echo '</ul>';
    echo '</nav>';
}

/**
 * Rend le bandeau applicatif patient/médecin.
 *
 * La navigation applicative standardisée est toujours rendue par le thème.
 * Un hook GP Elements éventuel peut enrichir la zone meta sans remplacer le menu.
 *
 * @return void
 */
function sp_render_app_rolebar()
{
    $variant = sp_get_page_shell_variant();

    if (! in_array($variant, array('request', 'patient', 'doctor-account', 'doctor-catalog'), true)) {
        return;
    }

    $hook_name   = sp_get_rolebar_hook_name($variant);
    $hook_output = sp_capture_action_output($hook_name, array($variant, $hook_name));

    do_action('sp_before_app_rolebar', $variant, $hook_name);

    $rolebar_classes = array('sp-rolebar', 'sp-rolebar--' . sanitize_html_class($variant));
    if (sp_rolebar_uses_compact_layout($variant)) {
        $rolebar_classes[] = 'sp-rolebar--compact';
        $rolebar_classes[] = 'sp-rolebar--no-sidebar';
    }

    echo '<section class="' . esc_attr(implode(' ', $rolebar_classes)) . '" aria-label="Contexte applicatif" data-sp-slot="rolebar" data-sp-hook="' . esc_attr($hook_name) . '" data-sp-variant="' . esc_attr($variant) . '">';
    $container_class = 'sp-container sp-container--app';
    if (sp_uses_compact_app_container($variant)) {
        $container_class .= ' sp-container--app-compact';
    }
    echo '<div class="' . esc_attr($container_class) . '">';
    echo '<div class="sp-rolebar__meta">';

    if (trim($hook_output) !== '') {
        echo '<div class="sp-rolebar__custom-slot">' . $hook_output . '</div>';
    } else {
        echo '<div class="sp-rolebar__copy">';
        echo '<strong class="sp-rolebar__title">' . esc_html(sp_get_rolebar_title($variant)) . '</strong>';
        echo '<span class="sp-rolebar__description">' . esc_html(sp_get_rolebar_description($variant)) . '</span>';
        echo '</div>';
    }

    echo '</div>';
    echo '<div class="sp-rolebar__nav-wrap">';
    sp_render_context_navigation($variant, 'sp-rolebar');
    echo '</div>';
    echo '</div>';
    echo '</section>';

    do_action('sp_after_app_rolebar', $variant, $hook_name);
}

/**
 * Rend la barre compacte de la console médecin.
 *
 * La navigation applicative standardisée est toujours rendue par le thème.
 * Un hook GP Elements éventuel peut enrichir la zone meta sans remplacer le menu.
 *
 * @return void
 */
function sp_render_console_bar()
{
    if (! sp_is_console_context()) {
        return;
    }

    $variant     = 'console';
    $hook_name   = sp_get_rolebar_hook_name($variant);
    $hook_output = sp_capture_action_output($hook_name, array($variant, $hook_name));

    do_action('sp_before_console_bar', $variant, $hook_name);

    echo '<section class="sp-console-bar sp-console-bar--compact sp-console-bar--no-sidebar" aria-label="Console médecin" data-sp-slot="console-bar" data-sp-hook="' . esc_attr($hook_name) . '" data-sp-variant="console">';
    $container_class = 'sp-container sp-container--console';
    if (sp_uses_compact_app_container($variant)) {
        $container_class .= ' sp-container--console-compact';
    }
    echo '<div class="' . esc_attr($container_class) . '">';
    echo '<div class="sp-console-bar__meta">';

    if (trim($hook_output) !== '') {
        echo '<div class="sp-console-bar__custom-slot">' . $hook_output . '</div>';
    } else {
        echo '<div class="sp-console-bar__copy">';
        echo '<strong class="sp-console-bar__title">' . esc_html(sp_get_rolebar_title('console')) . '</strong>';
        echo '<span class="sp-console-bar__description">' . esc_html(sp_get_rolebar_description('console')) . '</span>';
        echo '</div>';
    }

    echo '</div>';
    echo '<div class="sp-console-bar__nav-wrap">';
    sp_render_context_navigation($variant, 'sp-console-bar');
    echo '</div>';
    echo '</div>';
    echo '</section>';

    do_action('sp_after_console_bar', $variant, $hook_name);
}

/**
 * Rend la sidebar de contexte.
 *
 * @return void
 */
function sp_render_context_sidebar()
{
    $variant = sp_get_page_shell_variant();

    if (! sp_page_has_context_sidebar($variant)) {
        return;
    }

    $sidebar_id  = sp_get_context_sidebar_id($variant);
    $hook_name   = sp_get_sidebar_hook_name($variant);
    $hook_output = sp_capture_action_output($hook_name, array($variant, $hook_name));

    echo '<div class="sp-sidebar-stack" data-sp-slot="sidebar" data-sp-hook="' . esc_attr($hook_name) . '">';

    do_action('sp_before_context_sidebar', $variant, $hook_name);
    do_action('sp_before_context_sidebar_' . $variant, $variant, $hook_name);

    if (trim($hook_output) !== '') {
        echo $hook_output;
    } elseif ($sidebar_id && is_active_sidebar($sidebar_id)) {
        dynamic_sidebar($sidebar_id);
    } elseif (is_active_sidebar('sp_app_sidebar')) {
        dynamic_sidebar('sp_app_sidebar');
    } else {
        $cards = sp_get_default_sidebar_cards($variant);
        foreach ($cards as $card) {
            sp_render_sidebar_card($card);
        }
    }

    do_action('sp_after_context_sidebar_' . $variant, $variant, $hook_name);
    do_action('sp_after_context_sidebar', $variant, $hook_name);

    echo '</div>';
}

/**
 * Retourne l’ID de sidebar WordPress correspondant à la variante.
 *
 * @param string $variant Variante de shell.
 * @return string
 */
function sp_get_context_sidebar_id($variant)
{
    if (in_array($variant, array('request', 'patient'), true)) {
        return 'sp_patient_sidebar';
    }

    if ($variant === 'doctor-account') {
        return 'sp_doctor_sidebar';
    }

    return '';
}

/**
 * Retourne les cartes fallback de sidebar.
 *
 * @param string $variant Variante de shell.
 * @return array<int, array<string, mixed>>
 */
function sp_get_default_sidebar_cards($variant)
{
    if ($variant === 'request') {
        return array(
            array(
                'title'     => __('Tarifs transparents', 'gp-sos-prescription'),
                'body_html' => sp_get_pricing_widget_markup(),
                'tone'      => 'accent',
                'actions'   => array(
                    array(
                        'label' => __('Voir les tarifs', 'gp-sos-prescription'),
                        'url'   => home_url('/#tarifs'),
                        'class' => 'sp-button sp-button--secondary',
                    ),
                ),
            ),
            array(
                'title'   => __('Quand ne pas utiliser SOS', 'gp-sos-prescription'),
                'body'    => __('Urgence, douleur importante, nouveau symptôme inquiétant, arrêt maladie ou demande hors cadre.', 'gp-sos-prescription'),
                'tone'    => 'neutral',
                'actions' => array(
                    array(
                        'label' => __('Lire le cadre', 'gp-sos-prescription'),
                        'url'   => sp_get_page_url('security'),
                        'class' => 'sp-button sp-button--ghost',
                    ),
                ),
            ),
            array(
                'title'   => __('Besoin d’aide ?', 'gp-sos-prescription'),
                'body'    => __('Parcours non urgent, prix affichés à l’avance, décision médicale avant validation.', 'gp-sos-prescription'),
                'tone'    => 'soft',
                'actions' => array(
                    array(
                        'label' => __('Espace patient', 'gp-sos-prescription'),
                        'url'   => sp_get_page_url('patient'),
                        'class' => 'sp-button sp-button--primary',
                    ),
                ),
            ),
        );
    }

    if ($variant === 'patient') {
        return array(
            array(
                'title'   => __('Nouvelle demande', 'gp-sos-prescription'),
                'body'    => __('Relancez un parcours SOS ou une continuité de traitement depuis votre espace.', 'gp-sos-prescription'),
                'tone'    => 'accent',
                'actions' => array(
                    array(
                        'label' => __('Démarrer', 'gp-sos-prescription'),
                        'url'   => sp_get_page_url('request'),
                        'class' => 'sp-button sp-button--primary',
                    ),
                ),
            ),
            array(
                'title'     => __('Tarifs transparents', 'gp-sos-prescription'),
                'body_html' => sp_get_pricing_widget_markup(),
                'tone'      => 'soft',
                'actions'   => array(
                    array(
                        'label' => __('Tarifs transparents', 'gp-sos-prescription'),
                        'url'   => home_url('/#tarifs'),
                        'class' => 'sp-button sp-button--secondary',
                    ),
                ),
            ),
            array(
                'title'   => __('Mes demandes', 'gp-sos-prescription'),
                'body'    => __('Retrouvez rapidement vos demandes récentes et l’état d’avancement de vos dossiers.', 'gp-sos-prescription'),
                'tone'    => 'soft',
            ),
            array(
                'title'   => __('Mes documents', 'gp-sos-prescription'),
                'body'    => __('Accédez aux éléments disponibles dans votre espace sans repasser par la page d’accueil.', 'gp-sos-prescription'),
                'tone'    => 'neutral',
            ),
            array(
                'title'   => __('Aide & support', 'gp-sos-prescription'),
                'body'    => __('Gardez votre ReqID à portée de main si vous contactez le support.', 'gp-sos-prescription'),
                'tone'    => 'neutral',
                'actions' => array(
                    array(
                        'label' => __('Cadre du service', 'gp-sos-prescription'),
                        'url'   => sp_get_page_url('security'),
                        'class' => 'sp-button sp-button--ghost',
                    ),
                ),
            ),
        );
    }

    return array(
        array(
            'title'   => __('Profil / RPPS', 'gp-sos-prescription'),
            'body'    => __('Vérifiez vos informations d’exercice, votre RPPS et votre signature.', 'gp-sos-prescription'),
            'tone'    => 'accent',
            'actions' => array(
                array(
                    'label' => __('Mon compte', 'gp-sos-prescription'),
                    'url'   => sp_get_page_url('doctor-account'),
                    'class' => 'sp-button sp-button--primary',
                ),
            ),
        ),
        array(
            'title'   => __('Raccourcis utiles', 'gp-sos-prescription'),
            'body'    => __('Accédez à la console médecin et à votre compte sans détour.', 'gp-sos-prescription'),
            'tone'    => 'soft',
            'actions' => array(
                array(
                    'label' => __('Console', 'gp-sos-prescription'),
                    'url'   => sp_get_page_url('console'),
                    'class' => 'sp-button sp-button--secondary',
                ),
                array(
                    'label' => __('Mon compte', 'gp-sos-prescription'),
                    'url'   => sp_get_page_url('doctor-account'),
                    'class' => 'sp-button sp-button--ghost',
                ),
            ),
        ),
        array(
            'title'   => __('Cadre de prescription', 'gp-sos-prescription'),
            'body'    => __('Gardez à l’écran les exclusions, la non-urgence et le principe de décision médicale.', 'gp-sos-prescription'),
            'tone'    => 'neutral',
        ),
        array(
            'title'   => __('Support technique', 'gp-sos-prescription'),
            'body'    => __('En cas de blocage, notez le contexte précis avant de solliciter le support.', 'gp-sos-prescription'),
            'tone'    => 'neutral',
        ),
    );
}

/**
 * Rend une carte de sidebar fallback.
 *
 * @param array<string, mixed> $card Données de carte.
 * @return void
 */
function sp_render_sidebar_card($card)
{
    $tone    = ! empty($card['tone']) ? sanitize_html_class((string) $card['tone']) : 'neutral';
    $title   = ! empty($card['title']) ? (string) $card['title'] : '';
    $body    = ! empty($card['body']) ? (string) $card['body'] : '';
    $actions = ! empty($card['actions']) && is_array($card['actions']) ? $card['actions'] : array();

    echo '<section class="sp-widget-card sp-widget-card--' . esc_attr($tone) . '" data-tone="' . esc_attr($tone) . '">';
    if ($title !== '') {
        echo '<div class="sp-widget-card__header">';
        echo '<h3 class="sp-widget-card__title">' . esc_html($title) . '</h3>';
        echo '</div>';
    }
    if (! empty($card['body_html']) && is_string($card['body_html'])) {
        $body_html = do_shortcode((string) $card['body_html']);
        echo '<div class="sp-widget-card__body sp-widget-card__body--html">' . wp_kses_post($body_html) . '</div>';
    } elseif ($body !== '') {
        echo '<p class="sp-widget-card__body">' . esc_html($body) . '</p>';
    }
    if (! empty($actions)) {
        echo '<div class="sp-widget-card__actions">';
        foreach ($actions as $action) {
            $action_label = isset($action['label']) ? (string) $action['label'] : '';
            $action_url   = isset($action['url']) ? (string) $action['url'] : home_url('/');
            $action_class = isset($action['class']) ? (string) $action['class'] : 'sp-button sp-button--secondary';
            echo '<a class="' . esc_attr($action_class) . '" href="' . esc_url($action_url) . '">' . esc_html($action_label) . '</a>';
        }
        echo '</div>';
    }
    echo '</section>';
}

add_filter('nav_menu_item_title', 'sp_filter_secure_menu_labels', 20, 4);
add_filter('the_content', 'sp_replace_public_content_asset_tokens', 15);
add_filter('the_content', 'sp_render_documentary_legal_layout', 20);
add_filter('wpseo_title', 'sp_filter_wpseo_title', 20);
add_filter('wpseo_metadesc', 'sp_filter_wpseo_metadesc', 20);
add_filter('wpseo_opengraph_title', 'sp_filter_wpseo_opengraph_title', 20);
add_filter('wpseo_opengraph_desc', 'sp_filter_wpseo_opengraph_desc', 20);
add_filter('wpseo_twitter_title', 'sp_filter_wpseo_twitter_title', 20);
add_filter('wpseo_twitter_description', 'sp_filter_wpseo_twitter_description', 20);
add_filter('wpseo_opengraph_image', 'sp_filter_wpseo_opengraph_image', 20);
add_filter('wpseo_twitter_image', 'sp_filter_wpseo_twitter_image', 20);


/**
 * Retourne l’URL d’un asset du thème, avec version optionnelle.
 *
 * @param string $relative_path Chemin relatif dans le thème.
 * @param string $version       Version d’asset optionnelle.
 * @return string
 */
function sp_get_theme_asset_url($relative_path, $version = '')
{
    $relative_path = ltrim((string) $relative_path, '/');
    $url           = trailingslashit(get_stylesheet_directory_uri()) . $relative_path;

    if ((string) $version !== '') {
        $url = add_query_arg('v', (string) $version, $url);
    }

    return $url;
}

/**
 * Retourne l’URL d’un asset de marque du thème.
 *
 * @param string $file_name Nom de fichier dans /assets/img/brand/.
 * @param string $version   Version d’asset optionnelle.
 * @return string
 */
function sp_get_brand_asset_url($file_name, $version = '')
{
    $file_name = ltrim((string) $file_name, '/');

    return sp_get_theme_asset_url('assets/img/brand/' . $file_name, $version);
}

/**
 * Retourne les pictogrammes de paiement compacts utilisés sur l’accueil.
 *
 * @return string
 */
function sp_get_payment_icons_markup()
{
    $asset_version = defined('SP_THEME_VERSION') ? (string) SP_THEME_VERSION : '2.5.7';

    $items = array(
        array(
            'slug'  => 'visa',
            'label' => 'Visa',
            'file'  => 'visa-flat-rounded.svg',
        ),
        array(
            'slug'  => 'amex',
            'label' => 'American Express',
            'file'  => 'americanexpress-flat-rounded.svg',
        ),
        array(
            'slug'  => 'mastercard',
            'label' => 'Mastercard',
            'file'  => 'mastercard-flat-rounded.svg',
        ),
    );

    $markup = '<div class="sp-payment-icons" aria-hidden="true">';

    foreach ($items as $item) {
        $markup .= '<span class="sp-payment-icons__item sp-payment-icons__item--' . esc_attr($item['slug']) . '">';
        $markup .= '<img src="' . esc_url(sp_get_brand_asset_url($item['file'], $asset_version)) . '" alt="' . esc_attr($item['label']) . '" loading="lazy" decoding="async" />';
        $markup .= '</span>';
    }

    $markup .= '</div>';

    return $markup;
}

/**
 * Retourne le bandeau des technologies de confiance.
 *
 * @return string
 */
function sp_get_tech_stack_markup()
{
    $asset_version = defined('SP_THEME_VERSION') ? (string) SP_THEME_VERSION : '2.5.7';

    $items = array(
        array(
            'slug'    => 'hds',
            'label'   => 'HDS',
            'tooltip' => __('Hébergement HDS : Certification critique pour les données de santé.', 'gp-sos-prescription'),
            'file'    => 'hds-square.svg',
        ),
        array(
            'slug'    => 'scalingo',
            'label'   => 'Scalingo',
            'tooltip' => __('Scalingo : Plateforme Cloud française haute performance.', 'gp-sos-prescription'),
            'file'    => 'scalingo-square.svg',
        ),
        array(
            'slug'    => 'aws',
            'label'   => 'AWS',
            'tooltip' => __('AWS : Infrastructure mondiale et disponibilité 99,99%.', 'gp-sos-prescription'),
            'file'    => 'aws-square.svg',
        ),
        array(
            'slug'    => 'postgresql',
            'label'   => 'PostgreSQL',
            'tooltip' => __('PostgreSQL : Base de données chiffrée et intégrité absolue.', 'gp-sos-prescription'),
            'file'    => 'postgresql-square.svg',
        ),
        array(
            'slug'    => 'nodejs',
            'label'   => 'Node.js',
            'tooltip' => __('Node.js : Traitement asynchrone ultra-rapide des flux.', 'gp-sos-prescription'),
            'file'    => 'nodejs-square.svg',
        ),
        array(
            'slug'    => 'react',
            'label'   => 'React',
            'tooltip' => __('React : Interface fluide pour un parcours patient réactif.', 'gp-sos-prescription'),
            'file'    => 'react-square.svg',
        ),
    );

    $markup = '<div class="sp-tech-stack" role="list" aria-label="' . esc_attr__('Infrastructure de confiance', 'gp-sos-prescription') . '">';

    foreach ($items as $item) {
        $markup .= '<span class="sp-tech-stack__item sp-tech-stack__item--' . esc_attr($item['slug']) . '" role="listitem" tabindex="0" data-tooltip="' . esc_attr($item['tooltip']) . '">';
        $markup .= '<img src="' . esc_url(sp_get_brand_asset_url($item['file'], $asset_version)) . '" alt="' . esc_attr($item['label']) . '" loading="lazy" decoding="async" />';
        $markup .= '</span>';
    }

    $markup .= '</div>';

    return $markup;
}

/**
 * Retourne l’icône SVG du bouton espace patient sécurisé.
 *
 * @return string
 */
function sp_get_patient_secure_button_icon_svg()
{
    return '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
}



/**
 * Bridge de priorité request déplacé dans assets/js/app-shell.js.
 *
 * La couche shell garde le mapping côté frontend sans injecter de script inline.
 *
 * @return void
 */
function sp_enqueue_request_priority_bridge()
{
    return;
}

/**
 * Remplace les tokens d’assets publics dans le contenu par les URLs du thème.

 *
 * @param string $content Contenu HTML courant.
 * @return string
 */
function sp_replace_public_content_asset_tokens($content)
{
    if (is_admin() || ! is_string($content) || $content === '') {
        return $content;
    }

    $asset_version       = defined('SP_THEME_VERSION') ? (string) SP_THEME_VERSION : '2.5.7';
    $favicon_url         = esc_url(sp_get_brand_asset_url('sos-favicon.svg', $asset_version));
    $diagram_url         = esc_url(sp_get_brand_asset_url('sos-prescription-workflow-hds-v4.svg', $asset_version));
    $transit_diagram_url = esc_url(sp_get_brand_asset_url('chiffrement-aes.svg', $asset_version));
    $payment_icons       = sp_get_payment_icons_markup();
    $tech_stack          = sp_get_tech_stack_markup();
    $patient_url           = esc_url(sp_get_page_url('patient'));
    $request_entry_url     = esc_url(sp_get_page_url('request'));
    $standard_request_url  = esc_url(sp_get_request_entry_url('standard'));
    $renewal_request_url   = $standard_request_url;
    $sos_request_url       = esc_url(sp_get_request_entry_url('depannage-sos'));
    $patient_secure_button = '<a class="sp-button sp-button--secondary" href="' . $patient_url . '"><span class="sp-button__icon" aria-hidden="true">' . sp_get_patient_secure_button_icon_svg() . '</span><span>Accéder à mon espace</span></a>';

    $replacements = array(
        '%%SP_THEME_FAVICON_URL%%' => $favicon_url,
        '%%SP_WORKFLOW_V4_URL%%'   => $diagram_url,
        '%%SP_TRANSIT_AES_URL%%'  => $transit_diagram_url,
        '%%SP_PAYMENT_ICONS%%'     => $payment_icons,
        '%%SP_TECH_STACK%%'         => $tech_stack,
        '%%SP_REQUEST_ENTRY_URL%%'    => $request_entry_url,
        '%%SP_REQUEST_STANDARD_URL%%' => $standard_request_url,
        '%%SP_REQUEST_RENEWAL_URL%%'  => $renewal_request_url,
        '%%SP_REQUEST_SOS_URL%%'     => $sos_request_url,
        '<p class="sp-cta-note">Le prix affiché ici est repris dans le formulaire puis dans le récapitulatif avant paiement.</p>' => '',
        '<a class="sp-button sp-button--secondary" href="/espace-patient/">Mon espace sécurisé</a>' => $patient_secure_button,
        '<a class="sp-button sp-button--secondary" href="/espace-patient/"><span>Mon espace sécurisé</span><span class="sp-button__icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10V7a5 5 0 0 1 10 0v3"></path><path d="M6 10h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z"></path></svg></span></a>' => $patient_secure_button,
        '<a class="sp-button sp-button--secondary" href="/espace-patient/"><span class="sp-button__icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="8" r="3.25"></circle><path d="M4.5 19.25a5.75 5.75 0 0 1 11 0"></path><path d="m15.75 17.25 1.75 1.75 3.25-3.25"></path></svg></span><span>Mon espace sécurisé</span></a>' => $patient_secure_button,
        '<a class="sp-button sp-button--secondary" href="https://sosprescription.fr/espace-patient/"><span class="sp-button__icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="8" r="3.25"></circle><path d="M4.5 19.25a5.75 5.75 0 0 1 11 0"></path><path d="m15.75 17.25 1.75 1.75 3.25-3.25"></path></svg></span><span>Mon espace sécurisé</span></a>' => str_replace('/espace-patient/', 'https://sosprescription.fr/espace-patient/', $patient_secure_button),
        '<a class="sp-button sp-button--secondary" href="https://sosprescription.fr/espace-patient/">Mon espace sécurisé</a>' => str_replace('/espace-patient/', 'https://sosprescription.fr/espace-patient/', $patient_secure_button),
        '<a class="sp-button sp-button--secondary" href="https://sosprescription.fr/espace-patient/"><span>Mon espace sécurisé</span><span class="sp-button__icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10V7a5 5 0 0 1 10 0v3"></path><path d="M6 10h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z"></path></svg></span></a>' => str_replace('/espace-patient/', 'https://sosprescription.fr/espace-patient/', $patient_secure_button),
        '/demande-ordonnance/?type=standard' => $standard_request_url,
        '/demande-ordonnance/?type=renouvellement' => $renewal_request_url,
        '/demande-ordonnance/?type=depannage-sos' => $sos_request_url,
        'https://sosprescription.fr/demande-ordonnance/?type=standard' => str_replace(home_url('/'), 'https://sosprescription.fr/', $standard_request_url),
        'https://sosprescription.fr/demande-ordonnance/?type=renouvellement' => str_replace(home_url('/'), 'https://sosprescription.fr/', $renewal_request_url),
        'https://sosprescription.fr/demande-ordonnance/?type=depannage-sos' => str_replace(home_url('/'), 'https://sosprescription.fr/', $sos_request_url),
        '<span class="sp-payment-proof__label">Paiement 100% sécurisé via <a href="https://stripe.com/fr">Stripe</a></span>' => '<span class="sp-payment-proof__label">Paiement 100% sécurisé via <a href="https://stripe.com/fr" target="_blank" rel="noopener noreferrer">Stripe</a></span>',
        '<span class="sp-payment-proof__label">Paiement 100% sécurisé via Stripe</span>' => '<span class="sp-payment-proof__label">Paiement 100% sécurisé via <a href="https://stripe.com/fr" target="_blank" rel="noopener noreferrer">Stripe</a></span>',
        '<a class="sp-button sp-button--primary" href="/demande-ordonnance/?type=renouvellement">Choisir Standard</a>' => '',
        '<a class="sp-button sp-button--primary" href="/demande-ordonnance/?type=depannage-sos">Choisir SOS Prioritaire</a>' => '',
        '<a class="sp-button sp-button--primary" href="https://sosprescription.fr/demande-ordonnance/?type=renouvellement">Choisir Standard</a>' => '',
        '<a class="sp-button sp-button--primary" href="https://sosprescription.fr/demande-ordonnance/?type=depannage-sos">Choisir SOS Prioritaire</a>' => '',

        '<h2>Engagement éthique de continuité.</h2>' => '<h2>Engagement éthique de continuité</h2>',
        '<h2>Engagement éthique de continuité</h2>' => '<h2>Engagement éthique de continuité</h2>',
        '<p class="sp-ethics-head__lead">Un relais ponctuel en complément de votre parcours de soins habituel, sans jamais remplacer votre médecin traitant.</p>' => '<p class="sp-ethics-head__lead">Relais sécurisé pour vos traitements habituels en cas d’indisponibilité de votre cabinet médical.</p>',
        '<p class="sp-ethics-head__body">SOS Prescription sécurise votre traitement habituel en cas d’indisponibilité de votre cabinet. Pour tout suivi chronique ou nouveau symptôme, votre médecin traitant reste votre interlocuteur unique.</p>' => '<p class="sp-ethics-head__body">Ce service complète votre parcours de soins sans jamais remplacer votre médecin traitant. Pour tout nouveau symptôme ou suivi de pathologie chronique, consultez votre praticien référent.</p>',
        '<h2>Votre sécurité, notre standard</h2>' => '<h2>Sécurité de santé &amp; Protection des données</h2>',
        '<h2>Sécurité de santé &amp; Protection des données.</h2>' => '<h2>Sécurité de santé &amp; Protection des données</h2>',
        '<h2>Sécurité de santé &amp; Protection des données</h2>' => '<h2>Sécurité de santé &amp; Protection des données</h2>',
        '<p>Garantissez votre secret médical dans un cadre homologué.</p>' => '<p>Une infrastructure certifiée garantissant la sécurité totale de vos données et échanges médicaux.</p>',
        '<p>Une infrastructure certifiée garantissant la confidentialité absolue de votre parcours de soins.</p>' => '<p>Une infrastructure certifiée garantissant la sécurité totale de vos données et échanges médicaux.</p>',
        '<h3 id="sp-modal-security-title">Architecture de Sécurité</h3>' => '<h3 id="sp-modal-security-title">Infrastructure de confiance &amp; Audit technique</h3>',
        '<h3 id="sp-modal-specimen-title">Format Homologué &amp; Sécurisé</h3>' => '<h3 id="sp-modal-specimen-title">Standard d\'officine &amp; Certification QR Code</h3>',
        '<p>Nous utilisons des standards technologiques mondiaux pour garantir le cloisonnement et la haute disponibilité de vos données de santé.</p>' => '<p>Une infrastructure fondée sur des standards technologiques mondiaux pour garantir le cloisonnement HDS et l’intégrité totale de vos données.</p>',
        '<p>Le minimum utile, sans jargon.</p>' => '<p>Les 7 réponses statutaires avant toute demande.</p>',
        '<section class="sp-section sp-section-tech">' => '<section id="infrastructure-confiance" class="sp-section sp-section-tech">',
        '<p>Aperçu démonstratif d’une ordonnance sécurisée, lisible en officine et vérifiable par code et QR.</p>' => '<p>Aperçu démonstratif d’une ordonnance de relais sécurisée : identité RPPS, QR Code de vérification et lisibilité standardisée en officine.</p>',
        '<span>Ordonnance sécurisée, format lisible en officine</span>' => '<span>Ordonnance de relais certifiée, format lisible en officine</span>',
        '<li>Cloisonnement strict des espaces patient, médecin et officine.</li>' => '<li>Cloisonnement HDS des espaces patient, médecin et officine.</li>',
        '<li>Liens temporaires et accès contrôlés pour les documents sensibles.</li>' => '<li>Liens temporaires, accès contrôlés et flux chiffrés pour les documents sensibles.</li>',
        '<li>Journalisation technique et supervision continue de l’infrastructure.</li>' => '<li>Journalisation technique continue et supervision active de l’infrastructure.</li>',
        '<li>Hébergement opéré dans un cadre conforme HDS.</li>' => '<li>Hébergement opéré dans un environnement certifié HDS.</li>',
        '<strong>2 min</strong><p>Demande ciblée, sans détour.</p>' => '<strong>Saisie rapide</strong><p>Questionnaire médical complété en 2 minutes.</p>',
        '<strong>Sans visio</strong><p>Pas de consultation inutile.</p>' => '<strong>Zéro visio</strong><p>Échange 100% textuel, sans contrainte de rendez-vous.</p>',
        '<strong>Tarif fixe</strong><p>Aucun frais caché.</p>' => '<strong>Tarif fixe</strong><p>Forfait unique, sans frais supplémentaires.</p>',
        '<strong>Décision humaine</strong><p>Une vraie expertise derrière chaque validation.</p>' => '<strong>Validation médicale</strong><p>Chaque demande est contrôlée par un médecin certifié.</p>',
        '<h2>Un blocage ? Reprenez votre traitement.</h2>' => '<h2>Assurez la continuité de votre traitement</h2>',
        '<h2>Assurez la continuité de votre traitement.</h2>' => '<h2>Assurez la continuité de votre traitement</h2>',
        '<h2>Assurez la continuité de votre traitement</h2>' => '<h2>Assurez la continuité de votre traitement</h2>',
        '<p>Une demande courte, une validation médicale, un accès simple à l’ordonnance quand votre situation le permet.</p>' => '<p>Examen médical de votre dossier et délivrance d’une ordonnance de relais certifiée.</p>',
        '<a class="sp-button sp-button--primary" href="/demande-ordonnance/">Démarrer ma demande</a>' => '<a class="sp-button sp-button--primary" href="/demande-ordonnance/">Demander une ordonnance</a>',
        '<a class="sp-button sp-button--primary" href="https://sosprescription.fr/demande-ordonnance/">Démarrer ma demande</a>' => '<a class="sp-button sp-button--primary" href="https://sosprescription.fr/demande-ordonnance/">Demander une ordonnance</a>',
        'Standard :' => 'Standard :',
        'SOS Prioritaire :' => 'SOS Prioritaire :',
        'Ordonnance sécurisée : format lisible en officine' => 'Ordonnance sécurisée, format lisible en officine',
        'Traitement habituel : renouvellement temporaire' => 'Traitement habituel : renouvellement temporaire',
        'Dr A. Martin : RPPS vérifié' => 'Dr A. Martin, RPPS vérifié',
        'https://sosprescription.fr/wp-content/uploads/2026/03/sos-favicon.svg' => $favicon_url,
        '/wp-content/themes/gp-sos-prescription/assets/img/brand/sos-favicon.svg' => $favicon_url,
        '/wp-content/themes/gp-sos-prescription/assets/img/brand/sos-prescription-workflow-hds-v4.svg?v=2.4.18' => $diagram_url,
        '/wp-content/themes/gp-sos-prescription/assets/img/brand/sos-prescription-workflow-hds-v4.svg?v=2.4.19' => $diagram_url,
        '/wp-content/themes/gp-sos-prescription/assets/img/brand/sos-prescription-workflow-hds-v4.svg?v=2.4.20' => $diagram_url,
        '/wp-content/themes/gp-sos-prescription/assets/img/brand/sos-prescription-workflow-hds-v4.svg?v=2.4.21' => $diagram_url,
        '/wp-content/themes/gp-sos-prescription/assets/img/brand/sos-prescription-workflow-hds-v4.svg?v=2.4.22' => $diagram_url,
        '/wp-content/themes/gp-sos-prescription/assets/img/brand/sos-prescription-workflow-hds-v4.svg?v=2.4.23' => $diagram_url,
        '/wp-content/themes/gp-sos-prescription/assets/img/brand/sos-prescription-workflow-hds-v4.svg?v=2.4.24' => $diagram_url,
        '/wp-content/themes/gp-sos-prescription/assets/img/brand/sos-prescription-workflow-hds-v4.svg?v=2.4.25' => $diagram_url,
        '/wp-content/themes/gp-sos-prescription/assets/img/brand/sos-prescription-workflow-hds-v4.svg?v=2.4.26' => $diagram_url,
        '/wp-content/themes/gp-sos-prescription/assets/img/brand/sos-prescription-workflow-hds-v4.svg?v=2.4.28' => $diagram_url,
        '/wp-content/themes/gp-sos-prescription/assets/img/brand/sos-prescription-workflow-hds-v4.svg?v=2.4.30' => $diagram_url,
        '/wp-content/themes/gp-sos-prescription/assets/img/brand/sos-prescription-workflow-hds-v4.svg?v=2.4.31' => $diagram_url,
        '/wp-content/themes/gp-sos-prescription/assets/img/brand/sos-prescription-workflow-hds-v4.svg?v=2.4.32' => $diagram_url,
        '/wp-content/themes/gp-sos-prescription/assets/img/brand/sos-prescription-workflow-hds-v4.svg?v=2.4.33' => $diagram_url,
        '/wp-content/themes/gp-sos-prescription/assets/img/brand/sos-prescription-workflow-hds-v4.svg?v=2.4.35' => $diagram_url,
        '/wp-content/themes/gp-sos-prescription/assets/img/brand/sos-prescription-workflow-hds-v4.svg?v=2.4.36' => $diagram_url,
        '/wp-content/themes/gp-sos-prescription/assets/img/brand/sos-prescription-workflow-hds-v4.svg?v=2.4.37' => $diagram_url,
        '/wp-content/themes/gp-sos-prescription/assets/img/brand/sos-prescription-workflow-hds-v4.svg' => $diagram_url,
    );

    $content = strtr($content, $replacements);

    

    $compare_markup = <<<'HTML'
<div class="sp-section-head sp-section-head--center">
        <h2>Distinction du service</h2>
        <p>Une lecture claire entre continuité de soins ciblée et téléconsultation de diagnostic.</p>
      </div>

      <div class="sp-compare-cards">
        <article class="sp-card sp-compare-card">
          <h3 class="sp-compare-card__title">Expertise ciblée</h3>
          <div class="sp-compare-card__options">
            <div class="sp-compare-option sp-compare-option--sos">
              <div class="sp-compare-option__head">
                <span class="sp-compare-option__icon sp-compare-option__icon--good" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><path d="m9 11 3 3L22 4"></path></svg></span>
                <strong>SOS Prescription</strong>
              </div>
              <p>Continuité de soins.</p>
            </div>
            <div class="sp-compare-option sp-compare-option--other">
              <div class="sp-compare-option__head">
                <span class="sp-compare-option__icon sp-compare-option__icon--bad" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="m15 9-6 6"></path><path d="m9 9 6 6"></path></svg></span>
                <strong>Téléconsultation</strong>
              </div>
              <p>Diagnostic.</p>
            </div>
          </div>
        </article>

        <article class="sp-card sp-compare-card">
          <h3 class="sp-compare-card__title">Modalités d’échange</h3>
          <div class="sp-compare-card__options">
            <div class="sp-compare-option sp-compare-option--sos">
              <div class="sp-compare-option__head">
                <span class="sp-compare-option__icon sp-compare-option__icon--good" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><path d="m9 11 3 3L22 4"></path></svg></span>
                <strong>SOS Prescription</strong>
              </div>
              <p>Asynchrone sécurisée.</p>
            </div>
            <div class="sp-compare-option sp-compare-option--other">
              <div class="sp-compare-option__head">
                <span class="sp-compare-option__icon sp-compare-option__icon--bad" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="m15 9-6 6"></path><path d="m9 9 6 6"></path></svg></span>
                <strong>Téléconsultation</strong>
              </div>
              <p>Synchrone temps réel.</p>
            </div>
          </div>
        </article>

        <article class="sp-card sp-compare-card">
          <h3 class="sp-compare-card__title">Indication médicale</h3>
          <div class="sp-compare-card__options">
            <div class="sp-compare-option sp-compare-option--sos">
              <div class="sp-compare-option__head">
                <span class="sp-compare-option__icon sp-compare-option__icon--good" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><path d="m9 11 3 3L22 4"></path></svg></span>
                <strong>SOS Prescription</strong>
              </div>
              <p>Relais de traitement habituel.</p>
            </div>
            <div class="sp-compare-option sp-compare-option--other">
              <div class="sp-compare-option__head">
                <span class="sp-compare-option__icon sp-compare-option__icon--bad" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="m15 9-6 6"></path><path d="m9 9 6 6"></path></svg></span>
                <strong>Téléconsultation</strong>
              </div>
              <p>Nouveaux symptômes.</p>
            </div>
          </div>
        </article>
      </div>
HTML;


    $standard_grid_markup = <<<'HTML'
<div class="sp-standard-grid">
        <article class="sp-card sp-standard-card">
          <div class="sp-standard-card__inner">
            <span class="sp-icon-badge" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-shield-plus"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M9 12h6"/><path d="M12 9v6"/></svg></span>
            <div class="sp-standard-card__content">
              <strong>Hébergement certifié HDS</strong>
              <p>Données de santé hébergées sur des infrastructures agréées garantissant leur sécurité et leur isolation.</p>
              <button type="button" class="sp-button sp-button--ghost sp-standard-card__more" data-sp-modal-open="security" aria-haspopup="dialog" aria-controls="sp-modal-security">
                <span>Consulter l’architecture</span>
                <span class="sp-button__icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"></path><path d="m13 5 7 7-7 7"></path></svg></span>
              </button>
            </div>
          </div>
        </article>

        <article class="sp-card sp-standard-card">
          <div class="sp-standard-card__inner">
            <span class="sp-icon-badge" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-user-check-icon lucide-user-check"><path d="m16 11 2 2 4-4"/><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg></span>
            <div class="sp-standard-card__content">
              <strong>Identité RPPS vérifiée</strong>
              <p>Chaque ordonnance est validée par un médecin identifié au répertoire national de santé.</p>
              <button type="button" class="sp-button sp-button--ghost sp-standard-card__more" data-sp-modal-open="specimen" aria-haspopup="dialog" aria-controls="sp-modal-specimen">
                <span>Vérifier le standard</span>
                <span class="sp-button__icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"></path><path d="m13 5 7 7-7 7"></path></svg></span>
              </button>
            </div>
          </div>
        </article>

        <article class="sp-card sp-standard-card">
          <div class="sp-standard-card__inner">
            <span class="sp-icon-badge" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-lock-keyhole-icon lucide-lock-keyhole"><circle cx="12" cy="16" r="1"/><rect x="3" y="10" width="18" height="12" rx="2"/><path d="M7 10V7a5 5 0 0 1 10 0v3"/></svg></span>
            <div class="sp-standard-card__content">
              <strong>Confidentialité des échanges</strong>
              <p>Transmission des données chiffrée et sécurisée entre le patient, le médecin et l’infrastructure.</p>
              <button type="button" class="sp-button sp-button--ghost sp-standard-card__more" data-sp-modal-open="transit" aria-haspopup="dialog" aria-controls="sp-modal-transit">
                <span>Protocole technique</span>
                <span class="sp-button__icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"></path><path d="m13 5 7 7-7 7"></path></svg></span>
              </button>
            </div>
          </div>
        </article>
      </div>
HTML;

    $steps_grid_markup = <<<'HTML'
<div class="sp-steps-grid">
        <article class="sp-card sp-step-card">
          <span class="sp-step-card__badge" aria-hidden="true">1</span>
          <div class="sp-step-card__inner">
            <span class="sp-icon-badge sp-step-card__icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z"></path><path d="m8.5 8.5 7 7"></path></svg></span>
            <div class="sp-card-content">
              <strong>Faites votre demande</strong>
              <p>Remplissez le formulaire en 2 minutes avec les informations utiles sur votre traitement habituel.</p>
            </div>
          </div>
        </article>

        <article class="sp-card sp-step-card">
          <span class="sp-step-card__badge" aria-hidden="true">2</span>
          <div class="sp-step-card__inner">
            <span class="sp-icon-badge sp-step-card__icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 2v2"></path><path d="M5 2v2"></path><path d="M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1"></path><path d="M8 15a6 6 0 0 0 12 0v-3"></path><circle cx="20" cy="10" r="2"></circle></svg></span>
            <div class="sp-card-content">
              <strong>Un médecin vérifie</strong>
              <p>Un médecin analyse votre dossier. La décision, validation, refus ou orientation, reste strictement médicale.</p>
            </div>
          </div>
        </article>

        <article class="sp-card sp-step-card">
          <span class="sp-step-card__badge" aria-hidden="true">3</span>
          <div class="sp-step-card__inner">
            <span class="sp-icon-badge sp-step-card__icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h4a1 1 0 0 1 1 1v4a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-4a1 1 0 0 1 1-1h4a2 2 0 0 0 2-2v-2a2 2 0 0 0-2-2h-4a1 1 0 0 1-1-1V4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4a1 1 0 0 1-1 1z"></path></svg></span>
            <div class="sp-card-content">
              <strong>Le pharmacien délivre</strong>
              <p>Recevez votre ordonnance par lien sécurisé, puis présentez-la simplement à votre pharmacien.</p>
            </div>
          </div>
        </article>
      </div>
HTML;

    $diff_grid_markup = <<<'HTML'
<div class="sp-diff-grid">
        <article class="sp-card sp-diff-chip">
          <span class="sp-icon-badge" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="13" r="8"></circle><path d="M12 13l3-2"></path><path d="M9 2h6"></path><path d="M12 5V3"></path></svg></span>
          <div class="sp-card-content">
            <strong>Saisie rapide</strong>
            <p>Questionnaire médical complété en 2 minutes.</p>
          </div>
        </article>
        <article class="sp-card sp-diff-chip">
          <span class="sp-icon-badge" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-video-off" aria-hidden="true"><path d="M10.66 6H14a2 2 0 0 1 2 2v2.5l5.248-3.062A.5.5 0 0 1 22 7.87v8.196"></path><path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2"></path><path d="m2 2 20 20"></path></svg></span>
          <div class="sp-card-content">
            <strong>Zéro visio</strong>
            <p>Échange 100% textuel, sans contrainte de rendez-vous.</p>
          </div>
        </article>
        <article class="sp-card sp-diff-chip">
          <span class="sp-icon-badge" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2"></rect><circle cx="12" cy="12" r="2.5"></circle><path d="M7 9h.01"></path><path d="M17 15h.01"></path></svg></span>
          <div class="sp-card-content">
            <strong>Tarif fixe</strong>
            <p>Forfait unique, sans frais supplémentaires.</p>
          </div>
        </article>
        <article class="sp-card sp-diff-chip">
          <span class="sp-icon-badge" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-stethoscope" aria-hidden="true"><path d="M11 2v2"></path><path d="M5 2v2"></path><path d="M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1"></path><path d="M8 15a6 6 0 0 0 12 0v-3"></path><circle cx="20" cy="10" r="2"></circle></svg></span>
          <div class="sp-card-content">
            <strong>Validation médicale</strong>
            <p>Chaque demande est contrôlée par un médecin certifié.</p>
          </div>
        </article>
      </div>
HTML;

    $faq_markup = <<<'HTML'
<div class="sp-faq-list">
        <details class="sp-faq-item"><summary>Qui analyse ma demande ?</summary><p>Chaque dossier fait l’objet d’une analyse asynchrone ciblée par un médecin inscrit à l’Ordre des médecins. Le praticien est seul juge de la suite à donner : validation, refus ou orientation vers une consultation physique selon votre état de santé.</p></details>
        <details class="sp-faq-item"><summary>Est-ce remboursé par l’Assurance Maladie ?</summary><p>SOS Prescription est un service privé de relais médical. À ce titre, les frais d’expertise et de plateforme ne sont pas pris en charge par l’Assurance Maladie.</p></details>
        <details class="sp-faq-item"><summary>Puis-je demander n’importe quel médicament ?</summary><p>Le service est strictement limité à la continuité de traitements habituels. Sont exclus du protocole : les stupéfiants, les médicaments à risque de mésusage, les traitements sous surveillance renforcée ou toute demande sortant du cadre du relais ponctuel.</p></details>
        <details class="sp-faq-item"><summary>Ce service remplace-t-il mon médecin traitant ?</summary><p>En aucun cas. Notre engagement éthique repose sur la continuité des soins : nous intervenons en relais sécurisé uniquement en cas d’indisponibilité de votre cabinet médical. Pour tout nouveau symptôme ou suivi chronique, votre médecin traitant reste votre interlocuteur unique.</p></details>
        <details class="sp-faq-item"><summary>Est-ce adapté à une urgence médicale ?</summary><p>SOS Prescription n’est pas un service d’urgence. En cas de détresse vitale, de nouveaux symptômes ou d’aggravation rapide, contactez immédiatement le 15 ou le 112.</p></details>
        <details class="sp-faq-item"><summary>Quand suis-je débité ?</summary><p>Le règlement n’est prélevé qu’après validation médicale de votre demande. En cas de refus du médecin pour des raisons de sécurité ou de hors-cadre, aucun frais n’est facturé (zéro frais si refus).</p></details>
        <details class="sp-faq-item"><summary>Comment l’ordonnance est-elle vérifiée en pharmacie ?</summary><p>Le document délivré respecte le standard d’officine : il comporte une signature certifiée, l’identité RPPS du médecin et un QR Code d’authentification permettant au pharmacien de vérifier la validité de la prescription en temps réel.</p></details>
      </div>
HTML;

    $content = preg_replace(
        '/<div class="sp-standard-grid">.*?<\/div>\s*(?=<div class="sp-modal-security" id="sp-modal-security")/su',
        $standard_grid_markup . "

      ",
        $content,
        1
    );

    $content = preg_replace(
        '/<h1 class="sp-hero__title"[^>]*>.*?(?:data-sp-hero-cycle="hero-problem"|data-sp-typewriter="hero-problem").*?<\/h1>/su',
        '<h1 class="sp-hero__title"><span class="sp-hero__line">Besoin d’une ordonnance&nbsp;?</span></h1>',
        $content
    );

    $content = preg_replace(
        '/<div class="sp-section-head sp-section-head--center">\s*<h2>(?:Pourquoi nous choisir \?|Distinction du service\.?)<\/h2>.*?<\/div>\s*<div class="sp-compare-cards">.*?<\/div>\s*(?=<!-- \/wp:html -->)/su',
        $compare_markup . "
      ",
        $content,
        1
    );

    $content = preg_replace(
        '/\s*<article class="sp-card sp-compare-card">(?:(?!<article class="sp-card sp-compare-card">).)*?<h3 class="sp-compare-card__title">Résultat attendu<\/h3>(?:(?!<article class="sp-card sp-compare-card">).)*?<\/article>\s*/su',
        '',
        $content,
        1
    );

    $content = preg_replace(
        '/<div class="sp-steps-grid">.*?<\/div>\s*(?=<!-- \/wp:html -->)/su',
        $steps_grid_markup . "
      ",
        $content,
        1
    );

    $content = preg_replace(
        '/<div class="sp-diff-grid">.*?<\/div>\s*(?=<!-- \/wp:html -->)/su',
        $diff_grid_markup . "
      ",
        $content,
        1
    );

    $content = preg_replace(
        '/<div class="sp-faq-list">.*?<\/div>\s*(?=<!-- \/wp:html -->)/su',
        $faq_markup . "
      ",
        $content,
        1
    );

    $content = preg_replace(
        '/\s*<a class="sp-button sp-button--primary" href="(?:https?:\/\/sosprescription\.fr)?\/demande-ordonnance\/\?type=(?:renouvellement|depannage-sos)">Choisir(?: Standard| SOS Prioritaire)<\/a>\s*/u',
        '',
        $content
    );
    return $content;
}

/**
 * Indique si la page courante est un document légal public.
 *
 * @return bool
 */
function sp_is_legal_document_page()
{
    return sp_current_page_is('security') || sp_current_page_is('legal');
}

/**
 * Retourne le type d’item décoré dans les menus.
 *
 * @param WP_Post $item Item de menu.
 * @return string
 */
function sp_get_secure_menu_item_type($item)
{
    $item_url   = isset($item->url) ? untrailingslashit((string) $item->url) : '';
    $item_title = isset($item->title) ? sanitize_title((string) $item->title) : '';

    $targets = array(
        'patient' => array(
            'url'   => untrailingslashit(sp_get_page_url('patient')),
            'title' => 'espace-patient',
        ),
        'console' => array(
            'url'   => untrailingslashit(sp_get_page_url('console')),
            'title' => 'console-medecin',
        ),
        'doctor-account' => array(
            'url'   => untrailingslashit(sp_get_page_url('doctor-account')),
            'title' => 'compte-medecin',
        ),
    );

    foreach ($targets as $type => $target) {
        if ($item_url === $target['url'] || $item_title === $target['title']) {
            return $type;
        }
    }

    return '';
}

/**
 * Retourne l’icône SVG liée à un item sécurisé / métier du menu.
 *
 * Mapping héraldique v2.5.2 :
 * - console          => Lucide stethoscope
 * - doctor-account   => Lucide shield-plus
 *
 * @param string $type Type d’item.
 * @return string
 */
function sp_get_secure_menu_icon_svg($type)
{
    if ($type === 'console') {
        return '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-stethoscope" aria-hidden="true"><path d="M11 2v2"/><path d="M5 2v2"/><path d="M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1"/><path d="M8 15a6 6 0 0 0 12 0v-3"/><circle cx="20" cy="10" r="2"/></svg>';
    }

    if ($type === 'doctor-account') {
        return '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-shield-plus" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M9 12h6"/><path d="M12 9v6"/></svg>';
    }

    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3z"></path><path d="m9 12 2 2 4-4"></path></svg>';
}

/**
 * Retourne le libellé décoré avec icône pour le menu.
 *
 * @param string $label Libellé texte brut.
 * @param string $type  Type d’item.
 * @return string
 */
function sp_get_decorated_menu_label_html($label, $type)
{
    $label = trim((string) $label);

    if ($label === '' || $type === '') {
        return esc_html($label);
    }

    return '<span class="sp-nav-item__label sp-nav-item__label--secure sp-nav-item__label--' . esc_attr($type) . '">'
        . '<span class="sp-nav-item__icon" aria-hidden="true">' . sp_get_secure_menu_icon_svg($type) . '</span>'
        . '<span class="sp-nav-item__text">' . esc_html($label) . '</span>'
    . '</span>';
}

/**
 * Retourne le type décoré d’un item de navigation applicative.
 *
 * @param string $item_key Clé de l’item.
 * @return string
 */
function sp_get_context_menu_item_type($item_key)
{
    if (in_array($item_key, array('patient', 'console', 'doctor-account'), true)) {
        return $item_key;
    }

    return '';
}

/**
 * Ajoute une icône aux items Espace patient, Console médecin et Compte médecin.
 *
 * @param string   $title Titre HTML.
 * @param WP_Post  $item Item de menu.
 * @param stdClass $args Arguments du menu.
 * @param int      $depth Profondeur.
 * @return string
 */
function sp_filter_secure_menu_labels($title, $item, $args, $depth)
{
    $type = sp_get_secure_menu_item_type($item);

    if ($type === '' || strpos((string) $title, 'sp-nav-item__label') !== false) {
        return $title;
    }

    $plain_title = trim(wp_strip_all_tags((string) $title));
    if ($plain_title === '') {
        $plain_title = isset($item->title) ? trim(wp_strip_all_tags((string) $item->title)) : '';
    }

    if ($plain_title === '') {
        return $title;
    }

    return sp_get_decorated_menu_label_html($plain_title, $type);
}

/**
 * Génère un layout documentaire pour les pages légales.
 *
 * @param string $content Contenu HTML courant.
 * @return string
 */
function sp_render_documentary_legal_layout($content)
{
    if (is_admin() || ! is_singular('page') || ! sp_is_legal_document_page() || ! in_the_loop() || ! is_main_query()) {
        return $content;
    }

    if (strpos((string) $content, 'sp-legal-shell') !== false) {
        return $content;
    }

    $headings   = array();
    $structured = sp_build_legal_document_sections((string) $content, $headings);
    $title      = get_the_title();
    $eyebrow    = sp_current_page_is('security')
        ? __('Sécurité HDS · confidentialité · accès contrôlés', 'gp-sos-prescription')
        : __('Document certifié', 'gp-sos-prescription');

    $summaryLabel = __('Navigation dans le document', 'gp-sos-prescription');
    $summaryHint  = __('Accédez directement aux sections principales de cette page.', 'gp-sos-prescription');
    $summary      = sp_get_legal_toc_markup($headings);

    return '<section class="sp-legal-shell">'
        . '<div class="sp-legal-layout">'
            . '<div class="sp-legal-main">'
                . '<header class="sp-legal-hero">'
                    . '<div class="sp-legal-hero__intro">'
                        . '<p class="sp-eyebrow">' . esc_html($eyebrow) . '</p>'
                        . '<h1>' . esc_html($title) . '</h1>'
                    . '</div>'
                    . '<aside class="sp-legal-toc" aria-label="' . esc_attr($summaryLabel) . '">'
                        . '<div class="sp-legal-toc__card">'
                            . '<div class="sp-legal-toc__header">'
                                . '<p class="sp-legal-toc__eyebrow">' . esc_html($summaryLabel) . '</p>'
                                . '<p class="sp-legal-toc__hint">' . esc_html($summaryHint) . '</p>'
                            . '</div>'
                            . $summary
                        . '</div>'
                    . '</aside>'
                . '</header>'
                . '<article class="sp-legal-content">' . $structured . '</article>'
            . '</div>'
        . '</div>'
    . '</section>';
}

/**
 * Prépare le HTML brut d’un document légal pour le rendu public.
 *
 * @param string                            $content  HTML brut.
 * @param array<int, array<string, string>> $headings Références du sommaire.
 * @return string
 */
function sp_build_legal_document_sections($content, &$headings)
{
    $content = trim((string) $content);
    $content = preg_replace('/^\s*<h1[^>]*>.*?<\/h1>\s*/is', '', $content, 1);
    $content = sp_highlight_legal_note_paragraphs($content);

    $seen_ids = array();
    $counter  = 0;

    return (string) preg_replace_callback(
        '/<h2\b([^>]*)>(.*?)<\/h2>/is',
        static function ($matches) use (&$headings, &$seen_ids, &$counter) {
            $counter++;

            $attributes   = isset($matches[1]) ? (string) $matches[1] : '';
            $heading_html = isset($matches[2]) ? (string) $matches[2] : '';
            $heading_text = trim(wp_strip_all_tags($heading_html));

            if ($heading_text === '') {
                return (string) ($matches[0] ?? '');
            }

            $anchor_id = '';
            if (preg_match('/\bid=("|\')(.*?)\1/i', $attributes, $id_matches)) {
                $anchor_id = trim((string) ($id_matches[2] ?? ''));
            }

            if ($anchor_id === '') {
                $anchor_id = 'sp-legal-' . sanitize_title($heading_text);
            }

            if ($anchor_id === 'sp-legal-' || $anchor_id === '') {
                $anchor_id = 'sp-legal-section-' . (string) $counter;
            }

            $base_id = $anchor_id;
            $suffix  = 2;
            while (isset($seen_ids[$anchor_id])) {
                $anchor_id = $base_id . '-' . (string) $suffix;
                $suffix++;
            }
            $seen_ids[$anchor_id] = true;

            $headings[] = array(
                'id'    => $anchor_id,
                'label' => $heading_text,
            );

            $attributes = preg_replace('/\s*\bid=("|\').*?\1/i', '', $attributes);
            $attributes = trim((string) $attributes);
            $attributes = $attributes === '' ? '' : ' ' . $attributes;

            return '<h2 id="' . esc_attr($anchor_id) . '"' . $attributes . '>' . wp_kses_post($heading_html) . '</h2>';
        },
        $content
    );
}

/**
 * Met en relief certains paragraphes importants des documents légaux.
 *
 * @param string $html HTML source.
 * @return string
 */
function sp_highlight_legal_note_paragraphs($html)
{
    return (string) preg_replace_callback(
        '/<p>(.*?)<\/p>/is',
        static function ($matches) {
            $text = trim(preg_replace('/\s+/u', ' ', wp_strip_all_tags((string) $matches[1])));
            $needles = array(
                '@sosprescription.fr',
                'Dernière mise à jour',
                'CNIL',
            );

            foreach ($needles as $needle) {
                if (mb_stripos($text, $needle) !== false) {
                    return '<div class="sp-legal-card sp-legal-card--note">' . $matches[0] . '</div>';
                }
            }

            return $matches[0];
        },
        (string) $html
    );
}

/**
 * Retourne le HTML du sommaire documentaire.
 *
 * @param array<int, array<string, string>> $headings Liste d’ancres.
 * @return string
 */
function sp_get_legal_toc_markup($headings)
{
    if (empty($headings)) {
        return '<p class="sp-legal-toc__empty">' . esc_html__('Aucune section détectée.', 'gp-sos-prescription') . '</p>';
    }

    $html     = '<nav class="sp-legal-toc__nav" aria-label="' . esc_attr__('Sections du document', 'gp-sos-prescription') . '"><ol class="sp-legal-toc__list">';
    $position = 0;

    foreach ($headings as $heading) {
        $id    = isset($heading['id']) ? (string) $heading['id'] : '';
        $label = isset($heading['label']) ? (string) $heading['label'] : '';

        if ($id === '' || $label === '') {
            continue;
        }

        $position++;
        $index = str_pad((string) $position, 2, '0', STR_PAD_LEFT);

        $html .= '<li class="sp-legal-toc__item">'
            . '<a class="sp-legal-toc__link" href="#' . esc_attr($id) . '">'
                . '<span class="sp-legal-toc__index">' . esc_html($index) . '</span>'
                . '<span class="sp-legal-toc__label">' . esc_html($label) . '</span>'
            . '</a>'
        . '</li>';
    }

    $html .= '</ol></nav>';

    return $html;
}

/**
 * Retourne le slug SEO courant.
 *
 * @return string
 */
function sp_get_current_seo_slug()
{
    if (is_front_page()) {
        return 'accueil';
    }

    if (! is_singular('page')) {
        return '';
    }

    return sp_get_current_page_slug();
}

/**
 * Retourne la table SEO/OG par slug.
 *
 * @return array<string, array<string, string>>
 */
function sp_get_yoast_meta_map()
{
    return array(
        'accueil' => array(
            'focus_keyphrase'    => 'ordonnance en ligne',
            'title'              => 'Ordonnance en ligne non urgente | SOS Prescription',
            'description'        => 'Ordonnance en ligne pour renouvellement de traitement ou SOS Prescription non urgente, avec validation médicale, lien sécurisé et cadre HDS.',
            'og_title'           => 'Ordonnance en ligne sécurisée | SOS Prescription',
            'og_description'     => 'Demande en 2 minutes, validation médicale, renouvellement traitement ou SOS Prescription non urgente dans un cadre sécurisé HDS.',
        ),
        'securite-confidentialite' => array(
            'focus_keyphrase'    => 'sécurité HDS',
            'title'              => 'Sécurité HDS & confidentialité | SOS Prescription',
            'description'        => 'Découvrez le cadre de sécurité HDS de SOS Prescription : confidentialité, accès contrôlés, traçabilité et protection des données médicales.',
            'og_title'           => 'Sécurité HDS & confidentialité médicale | SOS Prescription',
            'og_description'     => 'Architecture sécurisée, confidentialité renforcée et accès cloisonnés pour les parcours patient, médecin et officine.',
        ),
        'mentions-legales' => array(
            'focus_keyphrase'    => 'mentions légales SOS Prescription',
            'title'              => 'Mentions légales | SOS Prescription',
            'description'        => 'Consultez les mentions légales de SOS Prescription : éditeur, hébergement, propriété intellectuelle et cadre juridique du service.',
            'og_title'           => 'Mentions légales du service | SOS Prescription',
            'og_description'     => 'Toutes les informations légales sur l’éditeur, l’hébergement et le fonctionnement du site SOS Prescription.',
        ),
        'politique-de-confidentialite' => array(
            'focus_keyphrase'    => 'politique de confidentialité médicale',
            'title'              => 'Politique de confidentialité | SOS Prescription',
            'description'        => 'Politique de confidentialité de SOS Prescription : données personnelles, sécurité HDS, durées de conservation et droits RGPD.',
            'og_title'           => 'Confidentialité & RGPD | SOS Prescription',
            'og_description'     => 'Comprenez quelles données sont traitées, pourquoi, combien de temps et comment exercer vos droits RGPD.',
        ),
        'conditions-du-service' => array(
            'focus_keyphrase'    => 'conditions SOS Prescription',
            'title'              => 'Conditions du service | SOS Prescription',
            'description'        => 'Conditions du service SOS Prescription : renouvellement traitement, cadre non urgent, délais indicatifs, décision médicale et paiement.',
            'og_title'           => 'Conditions d’utilisation | SOS Prescription',
            'og_description'     => 'Cadre du service, situations acceptées ou exclues, tarifs, délais et principe de décision médicale.',
        ),
        'demande-ordonnance' => array(
            'focus_keyphrase'    => 'demande d’ordonnance en ligne',
            'title'              => 'Demande d’ordonnance en ligne | SOS Prescription',
            'description'        => 'Déposez votre demande d’ordonnance en ligne pour renouvellement traitement ou SOS Prescription non urgente, avec analyse médicale sécurisée.',
            'og_title'           => 'Démarrer une demande d’ordonnance | SOS Prescription',
            'og_description'     => 'Formulaire court, validation médicale et transmission sécurisée de l’ordonnance quand la situation le permet.',
        ),
        'espace-patient' => array(
            'focus_keyphrase'    => 'espace patient sécurisé',
            'title'              => 'Espace patient sécurisé | SOS Prescription',
            'description'        => 'Accédez à votre espace patient sécurisé pour suivre vos demandes, retrouver vos documents et gérer votre parcours SOS Prescription.',
            'og_title'           => 'Espace patient sécurisé | SOS Prescription',
            'og_description'     => 'Suivi de dossier, documents et accès contrôlés dans un espace patient sécurisé pensé pour la continuité de traitement.',
        ),
        'console-medecin' => array(
            'focus_keyphrase'    => 'console médecin sécurisée',
            'title'              => 'Console médecin sécurisée | SOS Prescription',
            'description'        => 'Console médecin sécurisée pour l’analyse des demandes, la validation médicale et la gestion des parcours SOS Prescription.',
            'og_title'           => 'Console médecin | SOS Prescription',
            'og_description'     => 'Interface sécurisée dédiée à l’évaluation médicale, au suivi des dossiers et au contrôle des prescriptions.',
        ),
        'compte-medecin' => array(
            'focus_keyphrase'    => 'compte médecin sécurisé',
            'title'              => 'Compte médecin sécurisé | SOS Prescription',
            'description'        => 'Gérez votre compte médecin SOS Prescription : profil, RPPS, informations d’exercice et paramètres d’accès sécurisés.',
            'og_title'           => 'Compte médecin | SOS Prescription',
            'og_description'     => 'Profil professionnel, accès sécurisés et réglages du compte médecin au sein de l’environnement SOS Prescription.',
        ),
        'catalogue-medicaments' => array(
            'focus_keyphrase'    => 'référentiel médicaments BDPM',
            'title'              => 'Référentiel médicaments BDPM | SOS Prescription',
            'description'        => 'Consultez le référentiel médicaments BDPM de SOS Prescription pour retrouver rapidement les spécialités utiles au parcours médical.',
            'og_title'           => 'Référentiel médicaments BDPM | SOS Prescription',
            'og_description'     => 'Accès rapide au catalogue médicaments BDPM dans un environnement cohérent avec le shell médical SOS Prescription.',
        ),
    );
}

/**
 * Retourne la configuration SEO active de la page courante.
 *
 * @return array<string, string>
 */
function sp_get_current_yoast_meta_payload()
{
    $slug = sp_get_current_seo_slug();
    $map  = sp_get_yoast_meta_map();

    if ($slug === '' || ! isset($map[$slug])) {
        return array();
    }

    return $map[$slug];
}

/**
 * Vérifie si un champ Yoast a déjà été rempli dans la fiche de la page.
 *
 * @param string $meta_key Clé post meta Yoast.
 * @return bool
 */
function sp_has_custom_yoast_meta($meta_key)
{
    $post_id = get_queried_object_id();

    if (! $post_id) {
        return false;
    }

    return (string) get_post_meta($post_id, $meta_key, true) !== '';
}

/**
 * Retourne l’URL de l’image sociale par défaut.
 *
 * @return string
 */
function sp_get_default_social_image_url()
{
    return trailingslashit(SP_THEME_URL) . 'assets/img/brand/sos-prescription-og-default.png';
}

/**
 * @param string $title
 * @return string
 */
function sp_filter_wpseo_title($title)
{
    $payload = sp_get_current_yoast_meta_payload();

    if (empty($payload) || sp_has_custom_yoast_meta('_yoast_wpseo_title')) {
        return $title;
    }

    return isset($payload['title']) ? (string) $payload['title'] : $title;
}

/**
 * @param string $description
 * @return string
 */
function sp_filter_wpseo_metadesc($description)
{
    $payload = sp_get_current_yoast_meta_payload();

    if (empty($payload) || sp_has_custom_yoast_meta('_yoast_wpseo_metadesc')) {
        return $description;
    }

    return isset($payload['description']) ? (string) $payload['description'] : $description;
}

/**
 * @param string $title
 * @return string
 */
function sp_filter_wpseo_opengraph_title($title)
{
    $payload = sp_get_current_yoast_meta_payload();

    if (empty($payload) || sp_has_custom_yoast_meta('_yoast_wpseo_opengraph-title')) {
        return $title;
    }

    if (! empty($payload['og_title'])) {
        return (string) $payload['og_title'];
    }

    return ! empty($payload['title']) ? (string) $payload['title'] : $title;
}

/**
 * @param string $description
 * @return string
 */
function sp_filter_wpseo_opengraph_desc($description)
{
    $payload = sp_get_current_yoast_meta_payload();

    if (empty($payload) || sp_has_custom_yoast_meta('_yoast_wpseo_opengraph-description')) {
        return $description;
    }

    if (! empty($payload['og_description'])) {
        return (string) $payload['og_description'];
    }

    return ! empty($payload['description']) ? (string) $payload['description'] : $description;
}

/**
 * @param string $title
 * @return string
 */
function sp_filter_wpseo_twitter_title($title)
{
    $payload = sp_get_current_yoast_meta_payload();

    if (empty($payload) || sp_has_custom_yoast_meta('_yoast_wpseo_twitter-title')) {
        return $title;
    }

    if (! empty($payload['og_title'])) {
        return (string) $payload['og_title'];
    }

    return ! empty($payload['title']) ? (string) $payload['title'] : $title;
}

/**
 * @param string $description
 * @return string
 */
function sp_filter_wpseo_twitter_description($description)
{
    $payload = sp_get_current_yoast_meta_payload();

    if (empty($payload) || sp_has_custom_yoast_meta('_yoast_wpseo_twitter-description')) {
        return $description;
    }

    if (! empty($payload['og_description'])) {
        return (string) $payload['og_description'];
    }

    return ! empty($payload['description']) ? (string) $payload['description'] : $description;
}

/**
 * @param string $image
 * @return string
 */
function sp_filter_wpseo_opengraph_image($image)
{
    if (sp_get_current_seo_slug() === '' || sp_has_custom_yoast_meta('_yoast_wpseo_opengraph-image')) {
        return $image;
    }

    return sp_get_default_social_image_url();
}

/**
 * @param string $image
 * @return string
 */
function sp_filter_wpseo_twitter_image($image)
{
    if (sp_get_current_seo_slug() === '' || sp_has_custom_yoast_meta('_yoast_wpseo_twitter-image')) {
        return $image;
    }

    return sp_get_default_social_image_url();
}


add_filter('the_content', 'sp_sync_public_security_v255', 16);

/**
 * Synchronise la section sécurité v2.5.5 après les normalisations shell.
 *
 * - verrouille le wording exact des 3 piliers avec ponctuation purgée ;
 * - raccorde le 3e pilier à la modale Transit ;
 * - injecte le diagramme AES dans une modale dédiée placée en bas de page ;
 * - maintient la ponctuation sans point terminal sur les titres H1/H2 publics.
 *
 * @param string $content Contenu HTML courant.
 * @return string
 */
function sp_sync_public_security_v255($content)
{
    if (is_admin() || ! is_string($content) || $content === '') {
        return $content;
    }

    $asset_version       = defined('SP_THEME_VERSION') ? (string) SP_THEME_VERSION : '2.5.7';
    $diagram_url         = esc_url(sp_get_brand_asset_url('sos-prescription-workflow-hds-v4.svg', $asset_version));
    $transit_diagram_url = esc_url(sp_get_brand_asset_url('chiffrement-aes.svg', $asset_version));

    $standard_section_markup = <<<HTML
<div class="sp-section-head sp-section-head--center">
        <h2>Sécurité de santé &amp; Protection des données</h2>
        <p>Une infrastructure certifiée garantissant la sécurité totale de vos données et échanges médicaux.</p>
      </div>

      <div class="sp-standard-grid">
        <article class="sp-card sp-standard-card">
          <div class="sp-standard-card__inner">
            <span class="sp-icon-badge" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-shield-plus"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"></path><path d="M9 12h6"></path><path d="M12 9v6"></path></svg></span>
            <div class="sp-standard-card__content">
              <strong>Hébergement certifié HDS</strong>
              <p>Données de santé hébergées sur des infrastructures agréées garantissant leur sécurité et leur isolation.</p>
              <button type="button" class="sp-button sp-button--ghost sp-standard-card__more" data-sp-modal-open="security" aria-haspopup="dialog" aria-controls="sp-modal-security">
                <span>Consulter l’architecture</span>
                <span class="sp-button__icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"></path><path d="m13 5 7 7-7 7"></path></svg></span>
              </button>
            </div>
          </div>
        </article>

        <article class="sp-card sp-standard-card">
          <div class="sp-standard-card__inner">
            <span class="sp-icon-badge" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-user-check-icon lucide-user-check"><path d="m16 11 2 2 4-4"></path><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle></svg></span>
            <div class="sp-standard-card__content">
              <strong>Identité RPPS vérifiée</strong>
              <p>Chaque ordonnance est validée par un médecin identifié au répertoire national de santé.</p>
              <button type="button" class="sp-button sp-button--ghost sp-standard-card__more" data-sp-modal-open="specimen" aria-haspopup="dialog" aria-controls="sp-modal-specimen">
                <span>Vérifier le standard</span>
                <span class="sp-button__icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"></path><path d="m13 5 7 7-7 7"></path></svg></span>
              </button>
            </div>
          </div>
        </article>

        <article class="sp-card sp-standard-card">
          <div class="sp-standard-card__inner">
            <span class="sp-icon-badge" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-lock-keyhole-icon lucide-lock-keyhole"><circle cx="12" cy="16" r="1"></circle><rect x="3" y="10" width="18" height="12" rx="2"></rect><path d="M7 10V7a5 5 0 0 1 10 0v3"></path></svg></span>
            <div class="sp-standard-card__content">
              <strong>Confidentialité des échanges</strong>
              <p>Transmission des données chiffrée et sécurisée entre le patient, le médecin et l’infrastructure.</p>
              <button type="button" class="sp-button sp-button--ghost sp-standard-card__more" data-sp-modal-open="transit" aria-haspopup="dialog" aria-controls="sp-modal-transit">
                <span>Protocole technique</span>
                <span class="sp-button__icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"></path><path d="m13 5 7 7-7 7"></path></svg></span>
              </button>
            </div>
          </div>
        </article>
      </div>

      <div class="sp-modal-security" id="sp-modal-security" aria-hidden="true">
        <div class="sp-modal-security__backdrop" data-sp-modal-close="security"></div>
        <div class="sp-modal-security__dialog" role="dialog" aria-modal="true" aria-labelledby="sp-modal-security-title">
          <div class="sp-modal-security__header">
            <h3 id="sp-modal-security-title">Infrastructure de confiance &amp; Audit technique</h3>
            <button type="button" class="sp-modal-security__close" aria-label="Fermer" data-sp-modal-close="security">×</button>
          </div>
          <div class="sp-modal-security__body">
            <div class="sp-modal-security__diagram-wrap">
              <img class="sp-modal-security__diagram" src="{$diagram_url}" alt="Schéma d’architecture de sécurité et d’audit technique SOS Prescription" loading="lazy" decoding="async" />
            </div>
            <ul class="sp-security-checklist">
              <li>Cloisonnement HDS des espaces patient, médecin et officine.</li>
              <li>Liens temporaires, accès contrôlés et flux chiffrés pour les documents sensibles.</li>
              <li>Journalisation technique continue et supervision active de l’infrastructure.</li>
              <li>Traçabilité de l’identité RPPS et vérification des signatures sur les ordonnances de relais.</li>
            </ul>
          </div>
        </div>
      </div>
HTML;

    $transit_modal_markup = <<<HTML
  <div class="sp-modal-transit" id="sp-modal-transit" aria-hidden="true">
    <div class="sp-modal-security__backdrop" data-sp-modal-close="transit"></div>
    <div class="sp-modal-security__dialog" role="dialog" aria-modal="true" aria-labelledby="sp-modal-transit-title">
      <div class="sp-modal-security__header">
        <h3 id="sp-modal-transit-title">Protocole de Confidentialité &amp; Chiffrement de Transit</h3>
        <button type="button" class="sp-modal-security__close" aria-label="Fermer" data-sp-modal-close="transit">×</button>
      </div>
      <div class="sp-modal-security__body sp-modal-security__body--transit">
        <div class="sp-modal-security__diagram-wrap sp-modal-security__diagram-wrap--transit">
          <img class="sp-modal-security__diagram sp-modal-security__diagram--transit" src="{$transit_diagram_url}" alt="Diagramme du protocole de confidentialité et de chiffrement de transit SOS Prescription" loading="lazy" decoding="async" />
        </div>
        <ul class="sp-security-checklist sp-security-checklist--transit">
          <li><strong>Chiffrement des échanges :</strong> Données chiffrées lors de leur transmission entre patient et médecin.</li>
          <li><strong>Standards avancés :</strong> Protocoles de chiffrement reconnus garantissant la confidentialité.</li>
          <li><strong>Infrastructure isolée :</strong> Transit via une infrastructure HDS cloisonnée et sécurisée.</li>
          <li><strong>Accès contrôlés :</strong> Accès limité aux seuls acteurs autorisés.</li>
        </ul>
      </div>
    </div>
  </div>
HTML;

    $content = preg_replace(
        '/(<section class="sp-section sp-section-standard">.*?<div class="sp-container sp-standard">\s*<!-- wp:html -->\s*)(.*?)(\s*<!-- \/wp:html -->\s*<\/div>\s*<!-- \/wp:generateblocks\/element -->\s*<\/section>)/su',
        '$1' . "\n      " . $standard_section_markup . "\n      " . '$3',
        $content,
        1
    );

    if (strpos($content, 'id="sp-modal-transit"') === false) {
        $content = preg_replace(
            '/(\s*<div class="sp-modal-security" id="sp-modal-specimen")/u',
            "\n\n" . $transit_modal_markup . "\n\n  " . '$1',
            $content,
            1
        );
    }

    $content = str_replace(
        array(
            '<h2>Engagement éthique de continuité.</h2>',
            '<h2>Sécurité de santé &amp; Protection des données.</h2>',
            '<h2>Distinction du service.</h2>',
            '<h2>Assurez la continuité de votre traitement.</h2>',
            '<h2>Une infrastructure de confiance.</h2>',
            '<h2>Questions fréquentes.</h2>',
        ),
        array(
            '<h2>Engagement éthique de continuité</h2>',
            '<h2>Sécurité de santé &amp; Protection des données</h2>',
            '<h2>Distinction du service</h2>',
            '<h2>Assurez la continuité de votre traitement</h2>',
            '<h2>Une infrastructure de confiance</h2>',
            '<h2>Questions fréquentes</h2>',
        ),
        $content
    );

    return $content;
}


add_filter('the_content', 'sp_sync_public_shell_v256', 17);

/**
 * Synchronise le CTA unique, le sélecteur de situation et les modales standardisées v2.5.7.
 *
 * @param string $content Contenu HTML courant.
 * @return string
 */
function sp_sync_public_shell_v256($content)
{
    if (is_admin() || ! is_string($content) || $content === '') {
        return $content;
    }

    $asset_version         = defined('SP_THEME_VERSION') ? (string) SP_THEME_VERSION : '2.5.7';
    $request_entry_url     = esc_url(sp_get_page_url('request'));
    $standard_request_url  = esc_url(sp_get_request_entry_url('standard'));
    $sos_request_url       = esc_url(sp_get_request_entry_url('depannage-sos'));
    $workflow_diagram_url  = esc_url(sp_get_brand_asset_url('sos-prescription-workflow-hds-v4.svg', $asset_version));
    $transit_diagram_url   = esc_url(sp_get_brand_asset_url('chiffrement-aes.svg', $asset_version));

    $hero_markup = <<<HTML
<div class="sp-hero-cta-single">
        <a class="sp-button sp-button--primary sp-button--hero" href="{$request_entry_url}">Demander une ordonnance</a>
      </div>

      <div class="sp-status-bar" role="status" aria-label="État de la plateforme">
        <span>Service médical disponible</span>
        <span class="sp-status-item--live">Médecins en ligne</span>
        <span>Délai d’expertise prioritaire : [sosprescription_pricing field="eta" type="express"]</span>
      </div>
HTML;

    $selector_markup = <<<HTML
<div class="sp-section-head sp-pricing-head">
        <h2>Sélecteur de situation</h2>
        <p>Deux portes d’entrée claires pour orienter votre demande vers le bon parcours applicatif.</p>
      </div>

      <div class="sp-selector-grid" role="navigation" aria-label="Choisir votre situation">
        <article class="sp-card sp-selector-card">
          <div class="sp-selector-card__top">
            <span class="sp-icon-badge sp-icon-badge--selector" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-shield-check"><path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3z"></path><path d="m9 12 2 2 4-4"></path></svg></span>
            <div class="sp-card-content">
              <strong>Renouvellement habituel</strong>
              <p class="sp-selector-card__situation"><span>Situation</span> Avec justificatif</p>
              <p>Vous disposez de votre ancienne ordonnance ou d’une photo de votre boîte de médicament.</p>
            </div>
          </div>
          <div class="sp-selector-card__actions">
            <a class="sp-button sp-button--ghost" href="{$standard_request_url}">Initier le renouvellement</a>
          </div>
        </article>

        <article class="sp-card sp-card--featured sp-selector-card sp-selector-card--sos">
          <div class="sp-selector-card__top">
            <span class="sp-icon-badge sp-icon-badge--selector" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-zap"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"></path></svg></span>
            <div class="sp-card-content">
              <strong>Dépannage SOS</strong>
              <p class="sp-selector-card__situation"><span>Situation</span> Sans justificatif</p>
              <p>Oubli, perte ou déplacement. Vous n’avez aucune preuve de votre traitement sous la main.</p>
            </div>
          </div>
          <div class="sp-selector-card__actions">
            <a class="sp-button sp-button--primary" href="{$sos_request_url}">Démarrer le dépannage</a>
          </div>
        </article>
      </div>
HTML;

    $security_modal_markup = <<<HTML
<div class="sp-modal-security sp-modal-standard" id="sp-modal-security" aria-hidden="true">
        <div class="sp-modal-security__backdrop" data-sp-modal-close="security"></div>
        <div class="sp-modal-security__dialog" role="dialog" aria-modal="true" aria-labelledby="sp-modal-security-title">
          <div class="sp-modal-security__header">
            <h3 id="sp-modal-security-title">Infrastructure de confiance &amp; Audit technique</h3>
            <button type="button" class="sp-modal-security__close" aria-label="Fermer" data-sp-modal-close="security">×</button>
          </div>
          <div class="sp-modal-security__body">
            <div class="sp-modal-security__diagram-wrap sp-modal-visual-box">
              <img class="sp-modal-security__diagram" src="{$workflow_diagram_url}" alt="Schéma d’architecture de sécurité et d’audit technique SOS Prescription" loading="lazy" decoding="async" />
            </div>
            <ul class="sp-security-checklist sp-modal-standard__list">
              <li>Cloisonnement HDS des espaces patient, médecin et officine.</li>
              <li>Liens temporaires, accès contrôlés et flux chiffrés pour les documents sensibles.</li>
              <li>Journalisation technique continue et supervision active de l’infrastructure.</li>
              <li>Traçabilité de l’identité RPPS et vérification des signatures sur les ordonnances de relais.</li>
            </ul>
            <div class="sp-modal-standard__actions">
              <button type="button" class="sp-button sp-button--ghost sp-modal-standard__button" data-sp-modal-close="security">Fermer</button>
            </div>
          </div>
        </div>
      </div>
HTML;

    $transit_modal_markup = <<<HTML
<div class="sp-modal-transit sp-modal-standard" id="sp-modal-transit" aria-hidden="true">
    <div class="sp-modal-security__backdrop" data-sp-modal-close="transit"></div>
    <div class="sp-modal-security__dialog" role="dialog" aria-modal="true" aria-labelledby="sp-modal-transit-title">
      <div class="sp-modal-security__header">
        <h3 id="sp-modal-transit-title">Protocole de Confidentialité &amp; Chiffrement de Transit</h3>
        <button type="button" class="sp-modal-security__close" aria-label="Fermer" data-sp-modal-close="transit">×</button>
      </div>
      <div class="sp-modal-security__body sp-modal-security__body--transit">
        <div class="sp-modal-security__diagram-wrap sp-modal-security__diagram-wrap--transit sp-modal-visual-box">
          <img class="sp-modal-security__diagram sp-modal-security__diagram--transit" src="{$transit_diagram_url}" alt="Diagramme du protocole de confidentialité et de chiffrement de transit SOS Prescription" loading="lazy" decoding="async" />
        </div>
        <ul class="sp-security-checklist sp-security-checklist--transit sp-modal-standard__list">
          <li><strong>Chiffrement des échanges :</strong> Données chiffrées lors de leur transmission entre patient et médecin.</li>
          <li><strong>Standards avancés :</strong> Protocoles de chiffrement reconnus garantissant la confidentialité.</li>
          <li><strong>Infrastructure isolée :</strong> Transit via une infrastructure HDS cloisonnée et sécurisée.</li>
          <li><strong>Accès contrôlés :</strong> Accès limité aux seuls acteurs autorisés.</li>
        </ul>
        <div class="sp-modal-standard__actions">
          <button type="button" class="sp-button sp-button--ghost sp-modal-standard__button" data-sp-modal-close="transit">Fermer</button>
        </div>
      </div>
    </div>
  </div>
HTML;

    $content = preg_replace(
        '/(<div class="sp-container sp-hero-actions">\s*<!-- wp:html -->\s*)(.*?)(\s*<!-- \/wp:html -->\s*<\/div>\s*<!-- \/wp:generateblocks\/element -->)/su',
        '$1' . "\n      " . $hero_markup . "\n      " . '$3',
        $content,
        1
    );

    $content = preg_replace(
        '/(<div class="sp-container sp-pricing">\s*<!-- wp:html -->\s*)(.*?)(\s*<!-- \/wp:html -->\s*<\/div>\s*<!-- \/wp:generateblocks\/element -->\s*<\/section>)/su',
        '$1' . "\n      " . $selector_markup . "\n      " . '$3',
        $content,
        1
    );

    $content = preg_replace(
        '/<div class="sp-modal-security(?:\s+sp-modal-standard)?" id="sp-modal-security" aria-hidden="true">.*?(?=\s*<!-- \/wp:html -->)/su',
        $security_modal_markup . "\n\n      ",
        $content,
        1
    );

    if (strpos($content, 'id="sp-modal-transit"') !== false) {
        $content = preg_replace(
            '/<div class="sp-modal-transit(?:\s+sp-modal-standard)?" id="sp-modal-transit" aria-hidden="true">.*?(?=\s*<div class="sp-modal-security" id="sp-modal-specimen")/su',
            $transit_modal_markup . "\n\n  ",
            $content,
            1
        );
    } else {
        $content = preg_replace(
            '/(\s*<div class="sp-modal-security" id="sp-modal-specimen")/u',
            "\n\n  " . $transit_modal_markup . "\n\n  " . '$1',
            $content,
            1
        );
    }

    $content = str_replace(
        array(
            '<a class="sp-button sp-button--primary" href="/demande-ordonnance/">Démarrer ma demande</a>',
            '<a class="sp-button sp-button--primary" href="https://sosprescription.fr/demande-ordonnance/">Démarrer ma demande</a>',
            '<a class="sp-button sp-button--primary" href="/demande-ordonnance/">Commencer ce parcours</a>',
            '<a class="sp-button sp-button--primary" href="https://sosprescription.fr/demande-ordonnance/">Commencer ce parcours</a>'
        ),
        array(
            '<a class="sp-button sp-button--primary" href="' . $request_entry_url . '">Demander une ordonnance</a>',
            '<a class="sp-button sp-button--primary" href="' . str_replace(home_url('/'), 'https://sosprescription.fr/', $request_entry_url) . '">Demander une ordonnance</a>',
            '<a class="sp-button sp-button--primary" href="' . $request_entry_url . '">Demander une ordonnance</a>',
            '<a class="sp-button sp-button--primary" href="' . str_replace(home_url('/'), 'https://sosprescription.fr/', $request_entry_url) . '">Demander une ordonnance</a>'
        ),
        $content
    );

    $content = preg_replace('/\.\.(\s*<\/p>)/u', '.$1', $content);

    return $content;
}


/**
 * Synchronise la finition Diamond-Grade v2.5.7.
 *
 * - CTA unique verrouillé en hero et en CTA final.
 * - Sélecteur de situation harmonisé sur deux cartes strictement symétriques.
 * - Modales security / transit / specimen rendues visuellement identiques.
 * - Purge finale des doubles points et des points terminaux sur H2/H3.
 *
 * @param string $content Contenu HTML courant.
 * @return string
 */
function sp_sync_public_shell_v257($content)
{
    if (is_admin() || ! is_string($content) || $content === '') {
        return $content;
    }

    $asset_version        = defined('SP_THEME_VERSION') ? (string) SP_THEME_VERSION : '2.5.7';
    $request_entry_url    = esc_url(sp_get_page_url('request'));
    $standard_request_url = esc_url(sp_get_request_entry_url('standard'));
    $sos_request_url      = esc_url(sp_get_request_entry_url('depannage-sos'));
    $workflow_diagram_url = esc_url(sp_get_brand_asset_url('sos-prescription-workflow-hds-v4.svg', $asset_version));
    $transit_diagram_url  = esc_url(sp_get_brand_asset_url('chiffrement-aes.svg', $asset_version));

    $hero_markup = <<<HTML
<div class="sp-hero-cta-single">
        <a class="sp-button sp-button--primary sp-button--hero" href="{$request_entry_url}">Demander une ordonnance</a>
      </div>

      <div class="sp-status-bar" role="status" aria-label="État de la plateforme">
        <span>Service médical disponible</span>
        <span class="sp-status-item--live">Médecins en ligne</span>
        <span>Délai d’expertise prioritaire : [sosprescription_pricing field="eta" type="express"]</span>
      </div>
HTML;

    $selector_markup = <<<HTML
<div class="sp-section-head sp-pricing-head">
        <h2>Sélecteur de situation</h2>
        <p>Deux portes d’entrée claires pour orienter votre demande vers le bon parcours applicatif.</p>
      </div>

      <div class="sp-selector-grid" role="navigation" aria-label="Choisir votre situation">
        <article class="sp-card sp-selector-card">
          <div class="sp-selector-card__top">
            <span class="sp-icon-badge sp-icon-badge--selector" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-shield-check"><path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3z"></path><path d="m9 12 2 2 4-4"></path></svg></span>
            <div class="sp-card-content">
              <strong>Renouvellement habituel</strong>
              <p class="sp-selector-card__situation"><span>Situation</span> Avec justificatif</p>
              <p>Vous disposez de votre ancienne ordonnance ou d’une photo de votre boîte de médicament.</p>
            </div>
          </div>
          <div class="sp-selector-card__actions">
            <a class="sp-button sp-button--ghost" href="{$standard_request_url}">Initier le renouvellement</a>
          </div>
        </article>

        <article class="sp-card sp-selector-card sp-selector-card--sos">
          <div class="sp-selector-card__top">
            <span class="sp-icon-badge sp-icon-badge--selector" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-zap"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"></path></svg></span>
            <div class="sp-card-content">
              <strong>Dépannage SOS</strong>
              <p class="sp-selector-card__situation"><span>Situation</span> Sans justificatif</p>
              <p>Oubli, perte ou déplacement. Vous n’avez aucune preuve de votre traitement sous la main.</p>
            </div>
          </div>
          <div class="sp-selector-card__actions">
            <a class="sp-button sp-button--primary" href="{$sos_request_url}">Démarrer le dépannage</a>
          </div>
        </article>
      </div>
HTML;

    $final_cta_markup = <<<HTML
<div class="sp-final-cta-card">
        <h2>Assurez la continuité de votre traitement</h2>
        <p>Examen médical de votre dossier et délivrance d’une ordonnance de relais certifiée.</p>
        <div class="sp-actions">
          <a class="sp-button sp-button--primary" href="{$request_entry_url}">Demander une ordonnance</a>
        </div>
      </div>
HTML;

    $security_modal_markup = <<<HTML
<div class="sp-modal-security sp-modal-standard" id="sp-modal-security" aria-hidden="true">
        <div class="sp-modal-security__backdrop" data-sp-modal-close="security"></div>
        <div class="sp-modal-security__dialog" role="dialog" aria-modal="true" aria-labelledby="sp-modal-security-title">
          <div class="sp-modal-security__header">
            <h3 id="sp-modal-security-title">Infrastructure de confiance &amp; Audit technique</h3>
            <button type="button" class="sp-modal-security__close" aria-label="Fermer" data-sp-modal-close="security">×</button>
          </div>
          <div class="sp-modal-security__body">
            <div class="sp-modal-visual-box">
              <img class="sp-modal-security__diagram" src="{$workflow_diagram_url}" alt="Schéma d’architecture de sécurité et d’audit technique SOS Prescription" loading="lazy" decoding="async" />
            </div>
            <ul class="sp-security-checklist sp-modal-standard__list">
              <li>Cloisonnement HDS des espaces patient, médecin et officine.</li>
              <li>Liens temporaires, accès contrôlés et flux chiffrés pour les documents sensibles.</li>
              <li>Journalisation technique continue et supervision active de l’infrastructure.</li>
              <li>Traçabilité de l’identité RPPS et vérification des signatures sur les ordonnances de relais.</li>
            </ul>
          </div>
        </div>
      </div>
HTML;

    $transit_modal_markup = <<<HTML
<div class="sp-modal-transit sp-modal-standard" id="sp-modal-transit" aria-hidden="true">
    <div class="sp-modal-security__backdrop" data-sp-modal-close="transit"></div>
    <div class="sp-modal-security__dialog" role="dialog" aria-modal="true" aria-labelledby="sp-modal-transit-title">
      <div class="sp-modal-security__header">
        <h3 id="sp-modal-transit-title">Protocole de Confidentialité &amp; Chiffrement de Transit</h3>
        <button type="button" class="sp-modal-security__close" aria-label="Fermer" data-sp-modal-close="transit">×</button>
      </div>
      <div class="sp-modal-security__body">
        <div class="sp-modal-visual-box">
          <img class="sp-modal-security__diagram" src="{$transit_diagram_url}" alt="Diagramme du protocole de confidentialité et de chiffrement de transit SOS Prescription" loading="lazy" decoding="async" />
        </div>
        <ul class="sp-security-checklist sp-modal-standard__list">
          <li><strong>Chiffrement des échanges :</strong> Données chiffrées lors de leur transmission entre patient et médecin.</li>
          <li><strong>Standards avancés :</strong> Protocoles de chiffrement reconnus garantissant la confidentialité.</li>
          <li><strong>Infrastructure isolée :</strong> Transit via une infrastructure HDS cloisonnée et sécurisée.</li>
          <li><strong>Accès contrôlés :</strong> Accès limité aux seuls acteurs autorisés.</li>
        </ul>
      </div>
    </div>
  </div>
HTML;

    $specimen_modal_markup = <<<'HTML'
<div class="sp-modal-security sp-modal-standard" id="sp-modal-specimen" aria-hidden="true">
    <div class="sp-modal-security__backdrop" data-sp-modal-close="specimen"></div>
    <div class="sp-modal-security__dialog" role="dialog" aria-modal="true" aria-labelledby="sp-modal-specimen-title">
      <div class="sp-modal-security__header">
        <h3 id="sp-modal-specimen-title">Standard d’officine &amp; Certification QR Code</h3>
        <button type="button" class="sp-modal-security__close" aria-label="Fermer" data-sp-modal-close="specimen">×</button>
      </div>
      <div class="sp-modal-security__body">
        <div class="sp-modal-visual-box">
          <div class="sp-specimen-modal__layout">
            <div class="sp-ordonnance-paper" aria-label="Spécimen d’ordonnance sécurisée">
              <div class="sp-ordonnance-paper__header">
                <div>
                  <strong>SOS Prescription</strong>
                  <span>Ordonnance de relais certifiée, format lisible en officine</span>
                </div>
                <div class="sp-ordonnance-paper__meta">
                  <span>Date d’émission</span>
                  <strong>01/04/2026</strong>
                </div>
              </div>
              <div class="sp-dispense-capsule">
                <span class="sp-dispense-capsule__eyebrow">Code délivrance</span>
                <span class="sp-dispense-capsule__code">746327</span>
              </div>
              <div class="sp-ordonnance-paper__rule"></div>
              <div class="sp-ordonnance-paper__grid">
                <div class="sp-ordonnance-paper__field">
                  <span>Patient</span>
                  <strong>Nom Prénom</strong>
                </div>
                <div class="sp-ordonnance-paper__field">
                  <span>Référence dossier</span>
                  <strong>SP-746327</strong>
                </div>
                <div class="sp-ordonnance-paper__field sp-ordonnance-paper__field--full">
                  <span>Prescription</span>
                  <strong>Traitement habituel : renouvellement temporaire</strong>
                  <small>Spécimen de présentation destiné à illustrer la lisibilité, la traçabilité et la conformité du document.</small>
                </div>
              </div>
              <div class="sp-ordonnance-paper__footer">
                <div class="sp-ordonnance-paper__signature">
                  <span>Signature certifiée</span>
                  <strong>Dr A. Martin, RPPS vérifié</strong>
                </div>
                <div class="sp-ordonnance-paper__qr" aria-hidden="true"><svg class="sp-ordonnance-paper__qr-code" width="29mm" height="29mm" version="1.1" viewBox="0 0 29 29" xmlns="http://www.w3.org/2000/svg"><path d="M0,0H1V1H0zM1,0H2V1H1zM2,0H3V1H2zM3,0H4V1H3zM4,0H5V1H4zM5,0H6V1H5zM6,0H7V1H6zM8,0H9V1H8zM9,0H10V1H9zM12,0H13V1H12zM13,0H14V1H13zM15,0H16V1H15zM17,0H18V1H17zM18,0H19V1H18zM22,0H23V1H22zM23,0H24V1H23zM24,0H25V1H24zM25,0H26V1H25zM26,0H27V1H26zM27,0H28V1H27zM28,0H29V1H28zM0,1H1V2H0zM6,1H7V2H6zM9,1H10V2H9zM12,1H13V2H12zM16,1H17V2H16zM17,1H18V2H17zM19,1H20V2H19zM22,1H23V2H22zM28,1H29V2H28zM0,2H1V3H0zM2,2H3V3H2zM3,2H4V3H3zM4,2H5V3H4zM6,2H7V3H6zM9,2H10V3H9zM12,2H13V3H12zM14,2H15V3H14zM17,2H18V3H17zM19,2H20V3H19zM20,2H21V3H20zM22,2H23V3H22zM24,2H25V3H24zM25,2H26V3H25zM26,2H27V3H26zM28,2H29V3H28zM0,3H1V4H0zM2,3H3V4H2zM3,3H4V4H3zM4,3H5V4H4zM6,3H7V4H6zM8,3H9V4H8zM9,3H10V4H9zM11,3H12V4H11zM13,3H14V4H13zM16,3H17V4H16zM19,3H20V4H19zM22,3H23V4H22zM24,3H25V4H24zM25,3H26V4H25zM26,3H27V4H26zM28,3H29V4H28zM0,4H1V5H0zM2,4H3V5H2zM3,4H4V5H3zM4,4H5V5H4zM6,4H7V5H6zM8,4H9V5H8zM10,4H11V5H10zM11,4H12V5H11zM12,4H13V5H12zM13,4H14V5H13zM15,4H16V5H15zM17,4H18V5H17zM18,4H19V5H18zM22,4H23V5H22zM24,4H25V5H24zM25,4H26V5H25zM26,4H27V5H26zM28,4H29V5H28zM0,5H1V6H0zM6,5H7V6H6zM8,5H9V6H8zM13,5H14V6H13zM17,5H18V6H17zM19,5H20V6H19zM22,5H23V6H22zM28,5H29V6H28zM0,6H1V7H0zM1,6H2V7H1zM2,6H3V7H2zM3,6H4V7H3zM4,6H5V7H4zM5,6H6V7H5zM6,6H7V7H6zM8,6H9V7H8zM10,6H11V7H10zM12,6H13V7H12zM14,6H15V7H14zM16,6H17V7H16zM18,6H19V7H18zM20,6H21V7H20zM22,6H23V7H22zM23,6H24V7H23zM24,6H25V7H24zM25,6H26V7H25zM26,6H27V7H26zM27,6H28V7H27zM28,6H29V7H28zM8,7H9V8H8zM9,7H10V8H9zM10,7H11V8H10zM12,7H13V8H12zM17,7H18V8H17zM0,8H1V9H0zM4,8H5V9H4zM6,8H7V9H6zM7,8H8V9H7zM8,8H9V9H8zM11,8H12V9H11zM14,8H15V9H14zM15,8H16V9H15zM17,8H18V9H17zM20,8H21V9H20zM21,8H22V9H21zM22,8H23V9H22zM23,8H24V9H23zM24,8H25V9H24zM25,8H26V9H25zM28,8H29V9H28zM0,9H1V10H0zM1,9H2V10H1zM2,9H3V10H2zM3,9H4V10H3zM7,9H8V10H7zM11,9H12V10H11zM12,9H13V10H12zM13,9H14V10H13zM15,9H16V10H15zM16,9H17V10H16zM18,9H19V10H18zM21,9H22V10H21zM22,9H23V10H22zM23,9H24V10H23zM24,9H25V10H24zM25,9H26V10H25zM26,9H27V10H26zM27,9H28V10H27zM28,9H29V10H28zM3,10H4V11H3zM4,10H5V11H4zM6,10H7V11H6zM9,10H10V11H9zM10,10H11V11H10zM13,10H14V11H13zM14,10H15V11H14zM15,10H16V11H15zM18,10H19V11H18zM21,10H22V11H21zM22,10H23V11H22zM23,10H24V11H23zM28,10H29V11H28zM0,11H1V12H0zM1,11H2V12H1zM2,11H3V12H2zM3,11H4V12H3zM5,11H6V12H5zM9,11H10V12H9zM10,11H11V12H10zM15,11H16V12H15zM17,11H18V12H17zM20,11H21V12H20zM21,11H22V12H21zM23,11H24V12H23zM25,11H26V12H25zM27,11H28V12H27zM28,11H29V12H28zM1,12H2V13H1zM2,12H3V13H2zM3,12H4V13H3zM4,12H5V13H4zM5,12H6V13H5zM6,12H7V13H6zM7,12H8V13H7zM9,12H10V13H9zM10,12H11V13H10zM11,12H12V13H11zM12,12H13V13H12zM14,12H15V13H14zM17,12H18V13H17zM19,12H20V13H19zM21,12H22V13H21zM23,12H24V13H23zM27,12H28V13H27zM4,13H5V14H4zM8,13H9V14H8zM10,13H11V14H10zM11,13H12V14H11zM13,13H14V14H13zM15,13H16V14H15zM16,13H17V14H16zM22,13H23V14H22zM23,13H24V14H23zM24,13H25V14H24zM25,13H26V14H25zM26,13H27V14H26zM27,13H28V14H27zM28,13H29V14H28zM0,14H1V15H0zM5,14H6V15H5zM6,14H7V15H6zM7,14H8V15H7zM8,14H9V15H8zM9,14H10V15H9zM10,14H11V15H10zM12,14H13V15H12zM13,14H14V15H13zM15,14H16V15H15zM22,14H23V15H22zM24,14H25V15H24zM25,14H26V15H25zM26,14H27V15H26zM28,14H29V15H28zM0,15H1V16H0zM1,15H2V16H1zM3,15H4V16H3zM4,15H5V16H4zM5,15H6V16H5zM7,15H8V16H7zM8,15H9V16H8zM14,15H15V16H14zM15,15H16V16H15zM17,15H18V16H17zM22,15H23V16H22zM23,15H24V16H23zM27,15H28V16H27zM28,15H29V16H28zM0,16H1V17H0zM2,16H3V17H2zM4,16H5V17H4zM5,16H6V17H5zM6,16H7V17H6zM8,16H9V17H8zM14,16H15V17H14zM15,16H16V17H15zM17,16H18V17H17zM18,16H19V17H18zM19,16H20V17H19zM21,16H22V17H21zM23,16H24V17H23zM27,16H28V17H27zM0,17H1V18H0zM1,17H2V18H1zM2,17H3V18H2zM3,17H4V18H3zM7,17H8V18H7zM8,17H9V18H8zM9,17H10V18H9zM11,17H12V18H11zM12,17H13V18H12zM13,17H14V18H13zM15,17H16V18H15zM16,17H17V18H16zM17,17H18V18H17zM18,17H19V18H18zM21,17H22V18H21zM22,17H23V18H22zM23,17H24V18H23zM24,17H25V18H24zM25,17H26V18H25zM27,17H28V18H27zM28,17H29V18H28zM2,18H3V19H2zM3,18H4V19H3zM5,18H6V19H5zM6,18H7V19H6zM9,18H10V19H9zM11,18H12V19H11zM13,18H14V19H13zM15,18H16V19H15zM18,18H19V19H18zM20,18H21V19H20zM21,18H22V19H21zM22,18H23V19H22zM24,18H25V19H24zM26,18H27V19H26zM28,18H29V19H28zM2,19H3V20H2zM3,19H4V20H3zM4,19H5V20H4zM7,19H8V20H7zM15,19H16V20H15zM16,19H17V20H16zM17,19H18V20H17zM18,19H19V20H18zM24,19H25V20H24zM27,19H28V20H27zM28,19H29V20H28zM0,20H1V21H0zM1,20H2V21H1zM4,20H5V21H4zM5,20H6V21H5zM6,20H7V21H6zM8,20H9V21H8zM10,20H11V21H10zM11,20H12V21H11zM14,20H15V21H14zM15,20H16V21H15zM17,20H18V21H17zM20,20H21V21H20zM21,20H22V21H21zM22,20H23V21H22zM23,20H24V21H23zM24,20H25V21H24zM25,20H26V21H25zM28,20H29V21H28zM8,21H9V22H8zM13,21H14V22H13zM15,21H16V22H15zM16,21H17V22H16zM19,21H20V22H19zM20,21H21V22H20zM24,21H25V22H24zM28,21H29V22H28zM0,22H1V23H0zM1,22H2V23H1zM2,22H3V23H2zM3,22H4V23H3zM4,22H5V23H4zM5,22H6V23H5zM6,22H7V23H6zM8,22H9V23H8zM9,22H10V23H9zM12,22H13V23H12zM13,22H14V23H13zM14,22H15V23H14zM15,22H16V23H15zM19,22H20V23H19zM20,22H21V23H20zM22,22H23V23H22zM24,22H25V23H24zM25,22H26V23H25zM26,22H27V23H26zM28,22H29V23H28zM0,23H1V24H0zM6,23H7V24H6zM9,23H10V24H9zM12,23H13V24H12zM14,23H15V24H14zM16,23H17V24H16zM17,23H18V24H17zM18,23H19V24H18zM19,23H20V24H19zM20,23H21V24H20zM24,23H25V24H24zM27,23H28V24H27zM0,24H1V25H0zM2,24H3V25H2zM3,24H4V25H3zM4,24H5V25H4zM6,24H7V25H6zM8,24H9V25H8zM9,24H10V25H9zM10,24H11V25H10zM12,24H13V25H12zM13,24H14V25H13zM14,24H15V25H14zM17,24H18V25H17zM19,24H20V25H19zM20,24H21V25H20zM21,24H22V25H21zM22,24H23V25H22zM23,24H24V25H23zM24,24H25V25H24zM25,24H26V25H25zM28,24H29V25H28zM0,25H1V26H0zM2,25H3V26H2zM3,25H4V26H3zM4,25H5V26H4zM6,25H7V26H6zM12,25H13V26H12zM14,25H15V26H14zM15,25H16V26H15zM16,25H17V26H16zM19,25H20V26H19zM21,25H22V26H21zM28,25H29V26H28zM0,26H1V27H0zM2,26H3V27H2zM3,26H4V27H3zM4,26H5V27H4zM6,26H7V27H6zM9,26H10V27H9zM10,26H11V27H10zM11,26H12V27H11zM12,26H13V27H12zM13,26H14V27H13zM14,26H15V27H14zM15,26H16V27H15zM17,26H18V27H17zM21,26H22V27H21zM25,26H26V27H25zM26,26H27V27H26zM27,26H28V27H27zM28,26H29V27H28zM0,27H1V28H0zM6,27H7V28H6zM10,27H11V28H10zM11,27H12V28H11zM13,27H14V28H13zM15,27H16V28H15zM17,27H18V28H17zM19,27H20V28H19zM20,27H21V28H20zM21,27H22V28H21zM22,27H23V28H22zM24,27H25V28H24zM25,27H26V28H25zM27,27H28V28H27zM28,27H29V28H28zM0,28H1V29H0zM1,28H2V29H1zM2,28H3V29H2zM3,28H4V29H3zM4,28H5V29H4zM5,28H6V29H5zM6,28H7V29H6zM8,28H9V29H8zM9,28H10V29H9zM10,28H11V29H10zM11,28H12V29H11zM12,28H13V29H12zM13,28H14V29H13zM14,28H15V29H14zM17,28H18V29H17zM20,28H21V29H20zM21,28H22V29H21zM22,28H23V29H22zM24,28H25V29H24zM27,28H28V29H27z" id="qr-path" fill="#000000" fill-opacity="1" fill-rule="nonzero" stroke="none"/></svg></div>
              </div>
            </div>
          </div>
        </div>
        <ul class="sp-security-checklist sp-modal-standard__list sp-security-checklist--specimen">
          <li>Format conforme officines</li>
          <li>QR Code d’authentification</li>
          <li>Signature certifiée</li>
        </ul>
      </div>
    </div>
  </div>
HTML;

    $content = preg_replace(
        '/(<div class="sp-container sp-hero-actions">\s*<!-- wp:html -->\s*)(.*?)(\s*<!-- \/wp:html -->\s*<\/div>\s*<!-- \/wp:generateblocks\/element -->)/su',
        '$1' . "\n      " . $hero_markup . "\n      " . '$3',
        $content,
        1
    );

    $content = preg_replace(
        '/(<div class="sp-container sp-pricing">\s*<!-- wp:html -->\s*)(.*?)(\s*<!-- \/wp:html -->\s*<\/div>\s*<!-- \/wp:generateblocks\/element -->\s*<\/section>)/su',
        '$1' . "\n      " . $selector_markup . "\n      " . '$3',
        $content,
        1
    );

    $content = preg_replace(
        '/<div class="sp-final-cta-card">.*?(?=\s*<!-- \/wp:html -->)/su',
        $final_cta_markup . "\n      ",
        $content,
        1
    );

    $content = preg_replace(
        '/<div class="sp-modal-security(?:\s+sp-modal-standard)?" id="sp-modal-security" aria-hidden="true">.*?(?=\s*<!-- \/wp:html -->)/su',
        $security_modal_markup . "\n\n      ",
        $content,
        1
    );

    if (strpos($content, 'id="sp-modal-transit"') !== false) {
        $content = preg_replace(
            '/<div class="sp-modal-transit(?:\s+sp-modal-standard)?" id="sp-modal-transit" aria-hidden="true">.*?(?=\s*<div class="sp-modal-security(?:\s+sp-modal-standard)?" id="sp-modal-specimen")/su',
            $transit_modal_markup . "\n\n  ",
            $content,
            1
        );
    } else {
        $content = preg_replace(
            '/(\s*<div class="sp-modal-security(?:\s+sp-modal-standard)?" id="sp-modal-specimen")/u',
            "\n\n  " . $transit_modal_markup . "\n\n  " . '$1',
            $content,
            1
        );
    }

    $content = preg_replace(
        '/<div class="sp-modal-security(?:\s+sp-modal-standard)?" id="sp-modal-specimen" aria-hidden="true">.*?(?=\s*<!-- \/wp:html -->)/su',
        $specimen_modal_markup . "\n\n  ",
        $content,
        1
    );

    $content = str_replace('sp-card--featured sp-selector-card sp-selector-card--sos', 'sp-selector-card sp-selector-card--sos', $content);
    $content = preg_replace('/\s*<div class="sp-modal-standard__actions">.*?<\/div>\s*/su', "\n", $content);

    $content = preg_replace('/\.{2,}/', '.', $content);

    $content = preg_replace('/<(h[23])([^>]*)>([^<]*?)\.<\/(h[23])>/u', '<$1$2>$3</$4>', $content);

    return $content;
}
add_filter('the_content', 'sp_sync_public_shell_v257', 18);



/**
 * Synchronise la source unique du shell public v4.8.1.
 *
 * Le thème recharge le snapshot HTML souverain v4.8.1 afin d’éviter toute dérive
 * entre le fichier livré et le rendu frontend réel.
 *
 * @param string $content Contenu HTML courant.
 * @return string
 */
function sp_sync_public_shell_v481($content)
{
    if (is_admin() || ! is_string($content) || $content === '') {
        return $content;
    }

    if (strpos($content, 'sp-bg-canvas') === false && strpos($content, 'sp-section-hero') === false) {
        return $content;
    }

    $snapshot_path = SP_THEME_PATH . '/home-accueil-v4.8.1-gb.txt';

    if (! is_readable($snapshot_path)) {
        return $content;
    }

    $snapshot = file_get_contents($snapshot_path);

    if (! is_string($snapshot) || $snapshot === '') {
        return $content;
    }

    $snapshot = do_shortcode($snapshot);
    $snapshot = sp_replace_public_content_asset_tokens($snapshot);

    $snapshot = preg_replace('/\.{2,}/', '.', $snapshot);

    $snapshot = preg_replace('/<(h[1-3])([^>]*)>([^<]*?)\.<\/\1>/u', '<$1$2>$3</$1>', $snapshot);

    return $snapshot;
}
add_filter('the_content', 'sp_sync_public_shell_v481', 19);
