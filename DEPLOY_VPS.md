# SOS Prescription — Déploiement VPS (préparation AWS Lightsail / Bitnami)

Ce document prépare la migration vers un VPS (ex: AWS Lightsail) pour une future production HDS.

## 1) Portabilité des chemins
Le plugin n'utilise pas de chemins "en dur" de type `/var/www/html` ou `/opt/bitnami/wordpress`.
Il s'appuie sur :
- `plugin_dir_path(__FILE__)` / `plugin_dir_url(__FILE__)`
- `wp_upload_dir()`

Donc le même ZIP fonctionne sur Hostinger et sur un VPS Bitnami.

## 2) Extensions PHP recommandées
Minimum (fonctionnel) :
- PHP >= 8.2
- `ext-json` (standard)
- `ext-mbstring` (mPDF, traitement texte)
- `ext-zip` (ZipArchive, import BDPM)
- `ext-xml` (WordPress)
- `ext-fileinfo` (validation uploads)
- `ext-openssl` (random_bytes / TLS)

Fortement recommandé :
- `ext-gd` (rendu images dans PDF : signature, QR)
- `ext-curl` (transport HTTP WP plus fiable : Turnstile, notifications, Stripe)
- `ext-intl` (formatage locale)

## 3) Stockage fichiers (uploads)
Par défaut, les fichiers sont stockés dans `wp-content/uploads` :
- `sosprescription-private/` (pièces justificatives + PDF ordonnance)
- `sosprescription-logs/` (logs)
- `sosprescription-import/` (sessions import BDPM)
- `sosprescription-templates/` (override templates)

Sur VPS, vous pouvez envisager de déplacer le stockage privé hors webroot (meilleure défense en profondeur).
Si vous utilisez Nginx (pas de .htaccess), assurez-vous de bloquer l'accès direct à :
`/wp-content/uploads/sosprescription-private/`

Exemple Nginx (à adapter) :
```nginx
location ^~ /wp-content/uploads/sosprescription-private/ {
  deny all;
  return 403;
}
```

## 4) Cron / jobs
Le plugin utilise les mécanismes WordPress standards (WP-Cron) pour certaines opérations (notifications, etc.).
Sur VPS, il est recommandé de désactiver WP-Cron et d'installer un cron système (toutes les 5 minutes) :
```bash
*/5 * * * * wget -q -O - https://votre-domaine.tld/wp-cron.php?doing_wp_cron >/dev/null 2>&1
```

## 5) Observabilité
- Activer les Logs SOS Prescription via l'admin (SOS Prescription > Logs).
- En environnement de recette, vous pouvez activer `WP_DEBUG_LOG` (WordPress) en complément.

## 6) Sauvegardes
À sauvegarder :
- Base de données WordPress
- Dossier `wp-content/uploads/` (notamment `sosprescription-private`, `sosprescription-templates`)

⚠️ Les pièces justificatives et ordonnances sont des données sensibles : chiffrage au repos recommandé en prod.
