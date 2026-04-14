# NOTE-INTEGRATION v4.8.1

- `style.css` porté en `Version: 4.8.1` avec un workspace métier élargi à `1200px` et les finitions Diamond Grade conservées.
- `SP_THEME_VERSION` mis à jour en `4.8.1` dans `functions.php`.
- `inc/helpers.php` repointe la synchronisation runtime vers `home-accueil-v4.8.1-gb.txt`.
- `tokens.css` porte `--sp-workspace-max` à `75rem`, aligne les conteneurs compacts sur `1200px`, ajoute `--sp-card-padding-block`, `--sp-card-padding-inline` et `--sp-message-bubble-max`.
- `app-shell.css` recentre le frame applicatif, garde la montée progressive jusqu’à `1200px` et évite l’overflow sur les écrans intermédiaires avec sidebar.
- `app-skin.css` élargit les surfaces patient concernées, augmente légèrement le padding des cartes et verrouille les bulles de messagerie à `70%` de largeur maximale.
- `app-shell.js` injecte la même contrainte de largeur dans le chat shadow DOM pour éviter toute régression visuelle côté patient.
- Les hairline borders, ombres multi-niveaux, effets glass, typographie resserrée et micro-interactions Diamond Grade sont maintenus.
- Contrôles exécutés : zéro occurrence de double ponctuation, zéro titre `H1/H2/H3` terminé par un point dans le snapshot, lint PHP OK sur `functions.php` et `inc/*.php`.
