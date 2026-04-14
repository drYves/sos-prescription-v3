# NOTE-INTEGRATION v4.8.0

- `style.css` porté en `Version: 4.8.0` avec un shell Diamond Grade plus net et plus statutaire.
- `SP_THEME_VERSION` mis à jour en `4.8.0` dans `functions.php`.
- `inc/helpers.php` repointe la synchronisation runtime vers `home-accueil-v4.8.0-gb.txt`.
- `tokens.css` centralise les nouveaux effets sémantiques : `--sp-shadow-premium`, `--sp-shadow-premium-lg`, `--sp-glass-effect`, `--sp-border-hairline`, `--sp-skeleton-shimmer`, `--sp-ease-standard`.
- La hiérarchie typographique renforce `Plus Jakarta Sans` pour les titres avec un `letter-spacing` négatif maîtrisé et des gris secondaires recalculés en `color-mix`.
- Les surfaces publiques et applicatives passent sur des hairline borders, des ombres multi-niveaux et des fonds glass à 85% pour un rendu plus calme et plus premium.
- Les modales publiques et les en-têtes de console adoptent un `backdrop-filter` de 20px avec une profondeur plus propre et plus médicale.
- Les boutons reçoivent des courbes de mouvement `cubic-bezier` et un état `:active` en `scale(0.98)`.
- Les skeleton screens utilisent désormais un shimmer lent et soyeux via `--sp-skeleton-shimmer`.
- Les espaces de travail compacts patient et console sont recentrés sur une largeur de référence de `800px` avec des gutters plus généreux.
- Les badges de statut reçoivent une pastille interne et une finition plus lisible côté patient comme côté médecin.
- Contrôles exécutés : zéro occurrence de double ponctuation, zéro titre `H1/H2/H3` terminé par un point dans le snapshot, lint PHP OK sur `functions.php` et `inc/*.php`.
