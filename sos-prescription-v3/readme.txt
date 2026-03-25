=== SOS Prescription ===
Contributors: sosprescription
Tags: healthcare, e-sante, prescription, pdf, ocr, security, logs
Requires at least: 6.0
Tested up to: 6.5
Requires PHP: 8.2
Stable tag: 3.4.15
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

== Description ==

SOS Prescription est un plugin WordPress (e-santé) destiné à orchestrer un parcours complet autour d'une ordonnance :

* Demande patient (upload + OCR client-side « soft validation »)
* Console médecin (validation/refus, génération PDF)
* Vérification pharmacien (/v/{token}) + délivrance auditée
* Observabilité : logs NDJSON, ReqID support, outils de diagnostic & export

== Installation ==

1. Téléversez le ZIP dans WordPress : Extensions > Ajouter > Téléverser.
2. Activez le plugin.
3. Ouvrez le back-office du plugin (menu SOS Prescription).
4. Vérifiez l'onglet "System Status" : permissions, assets OCR, mPDF.

== Installation & Configuration Avancée ==

=== Cron Jobs (nettoyage stockage) ===

Le plugin planifie un nettoyage quotidien via WP-Cron :

* Hook: `sosprescription_storage_cleanup_daily`
* Objectif: limiter la saturation disque (mutualisé) et supprimer les fichiers temporaires anciens.

Conseil: sur serveur type VPS, configurez un cron système qui déclenche `wp-cron.php` régulièrement.

=== Chemins critiques (uploads) ===

Le plugin utilise des dossiers sous `wp-content/uploads/` :

* `uploads/sosprescription-private/` (stockage sensible: logs, PDFs)
* `uploads/sosprescription-private/logs/` (logs NDJSON)
* `uploads/sosprescription-private/tmp/` (temporaires OCR/PDF)
* `uploads/sosprescription-templates/` (templates surchargeables)

Assurez-vous que WordPress peut écrire dans ces dossiers (755 ou 775 selon votre serveur).

=== Hiérarchie des Templates ===

Ordre de résolution (selon composant):

1. `wp-content/uploads/sosprescription-templates/` (override runtime)
2. Thème enfant / thème parent (si le composant utilise la hiérarchie WP via `locate_template()`)
3. Templates par défaut du plugin (`/templates/`)

La page "System Status" expose la source utilisée (Plugin Default vs Override) si applicable.

== Frequently Asked Questions ==

= L'OCR serveur est-il requis ? =

Non. L'OCR est effectué côté navigateur (Tesseract.js) avec validation "soft" (non bloquante).

= Comment ajuster les mots-clés OCR ? =

Back-office > OCR: modifiez "Mots-clés OCR". La regex est propagée au front sans rebuild.

= Pourquoi /v/{token} ne marche pas après update ? =

La v1.9.0 introduit un UpgradeManager qui déclenche un flush des règles de réécriture après upgrade.
Si besoin, visitez le back-office en tant qu'administrateur pour finaliser le flush.

= Où sont les logs ? =

Back-office > Logs, ou directement dans `uploads/sosprescription-private/logs/`.

== Changelog ==

= 2.0.0 =
* Version "Gold" (Production Ready) : packaging final et nettoyage.
* Mise a jour du versioning global + durcissement anti directory listing (index.php).

= 1.9.5 =
* Pharmacien : anti-double soumission lors de la confirmation de délivrance (bouton désactivé + spinner, réactivation uniquement en cas d'erreur API).
* Patient : timeout OCR gracieux (15s) pour éviter une interface bloquée ; le worker est interrompu et un message convivial est affiché.
* Front-end : couche i18n-lite (SosPrescription.i18n) pour centraliser les messages.

= 1.9.1 =
* System Status: actionable advice for WARN/FAIL checks (permissions, mPDF vendor, memory limit, etc.).
* OCR: "log-once" alert for missing client assets (12h throttle via transient).
* Security/privacy: safe error logging helper prevents accidental PII leakage in NDJSON context.

= 1.9.0 =
* Ajout UpgradeManager (version en base + point d'extension migrations + flush rewrite post-upgrade)
* Ajout d'une matrice QA embarquée (`assets/qa-checklist.json`) + lien dans System Status
* Ajout `readme.txt` (documentation WordPress standard)

= 1.8.2 =
* Audit de configuration étendu (overrides templates, options, routing)

== Upgrade Notice ==

= 2.0.0 =
Version "Gold" (Production Ready). Mise a jour recommandee.

= 1.9.5 =
* Renforce l'UX patient/pharmacien (timeout OCR, anti-double submission, messages centralisés).

= 1.9.1 =
Improved diagnostics (actionable advice) and safer OCR asset alerts (log-once throttle).

= 1.9.0 =
Version "Release Readiness". Recommandé avant passage en production (observabilité + procédure upgrade).
