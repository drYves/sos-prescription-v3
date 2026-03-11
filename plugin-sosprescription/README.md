# SosPrescription (WordPress Plugin)

**Version plugin : 1.7.23**

Plugin WordPress pour gérer une **évaluation médicale asynchrone** (périmètre MVP : RO / continuité documentée), avec :
- Import BDPM (fichiers TXT tabulés, ZIP) + recherche médicaments
- Formulaire patient (RO / continuité) + preuves (upload) + messagerie asynchrone
- Paiement Stripe en **autorisation** (capture à l’approbation, annulation en cas de refus)
- Console médecin (queue, dossier, questions/réponses, décision)
- Génération d’**ordonnance PDF côté serveur** + téléchargement sécurisé
- Whitelist configurable (classes/produits autorisés) + exigences de preuve
- Notifications email/SMS (sans données de santé)
- Bloc conformité (consentement, audit log, rétention)
- Protection anti-bot via Cloudflare Turnstile (intégré au plugin)

## Shortcodes

- Formulaire patient (demande + paiement + dépôt de pièces) : `[sosprescription_form]`
- Portail patient (messagerie + statut + téléchargement) : `[sosprescription_patient]`
- Console médecin (queue + dossier + messagerie + décision) : `[sosprescription_admin]`
- Compte médecin (RPPS, infos pro, signature) : `[sosprescription_doctor_account]`
- Catalogue médicaments (table BDPM) : `[sosprescription_bdpm_table]` (option : `per_page="10|20|50"`)

> Note : les shortcodes “patient/console/formulaire” nécessitent un utilisateur connecté (auth WordPress + nonce REST).

## Logs

Menu WP Admin : **SOS Prescription → Logs**

Fonctionnement :
- Canal **BDPM** : import (sessions, étapes, erreurs)
- Canal **Runtime** : **1 fichier par shortcode et par jour** (ex : `runtime-sosprescription_form-2026-01-01.log`)

Nouveautés 1.3.3 :
- Page Logs réorganisée en **onglets** (Réglages / BDPM / Runtime / Shortcodes / Visionneuse).
- Téléchargement des logs en **ZIP** (par canal, par shortcode, runtime général).
- Page Import BDPM : correction de l’affichage des **derniers imports** + ajout d’un **historique**.
- Page Import BDPM : barre de progression et statut fichiers plus lisibles + recherche “Test rapide” en **autocomplete** (même logique que le formulaire).

Nouveautés 1.3.2 :
- Les recherches médicaments affichent désormais le **nom de la spécialité (CIS.denomination)** en titre, et la **présentation** en sous-titre.
- Les ordonnances (API) sont enrichies avec la dénomination BDPM pour garantir l’affichage du nom du médicament.
- Logs REST améliorés : les appels API sont rattachés au shortcode via l’en-tête `X-Sos-Scope`.
- Page Logs améliorée : preset “Activer uniquement”, toggle “Runtime général (hors shortcode)”, section dédiée.
- Correctifs CSS front pour éviter des collisions de thèmes sur les boutons (dropdown de recherche).

Nouveautés 1.3.1 :
- Activation fine **par shortcode** (ne logguez que ce que vous testez)
- Visionneuse “tail” (affiche les derniers ~200KB sans télécharger)
- Actions par fichier : **Voir / Télécharger / Vider (truncate) / Supprimer**
- Télémétrie de debug front (loader Vite) via l’endpoint REST `POST /wp-json/sosprescription/v1/logs/frontend`

Recommandation : en prod, laisser les logs OFF.

## Installation & statut

Menu WP Admin : **SOS Prescription → Installation & statut**

Cet écran permet :
- d’assigner les pages WordPress à chaque interface (ou de les créer automatiquement),
- de vérifier rapidement la config (Stripe, tarifs, Turnstile, whitelist, consentement…).

## Notes de version (high level)

- **1.5.x** : patient portal + messagerie, stockage fichiers, Stripe, génération ordonnance PDF, whitelist, notifications, audit log et rétention.

## Rôles & permissions

- `administrator` reçoit :
  - `sosprescription_manage`
  - `sosprescription_manage_data`
  - `sosprescription_validate`

- Rôle optionnel créé à l’activation :
  - `sosprescription_doctor` (libellé : **Médecin (SOS Prescription)**)
  - capacité : `sosprescription_validate`

## Constantes (wp-config.php)

Turnstile :
```php
define('SOSPRESCRIPTION_TURNSTILE_SITE_KEY', '...');    // public
define('SOSPRESCRIPTION_TURNSTILE_SECRET_KEY', '...');  // secret
```

Mode dev (Vite) :
```php
define('SOSPRESCRIPTION_DEV', true);
define('SOSPRESCRIPTION_DEV_SERVER', 'http://localhost:5173');
```

## Import BDPM

Menu WP Admin : **SOS Prescription → Import BDPM**

1) Uploader le ZIP officiel (BDPM)  
2) Démarrer / Reprendre l’import

L’import se fait par lots (batch) pour éviter les timeouts.

## Développement front

Voir `BUILD.md`.

## Notes techniques PDF (mPDF / dompdf)

### Objectif

Le rendu PDF doit rester **fidèle** et **robuste** sur un hébergement mutualisé, sans dépendre d’un navigateur headless.

### mPDF (recommandé côté plugin)

mPDF supporte un sous-ensemble de HTML/CSS. Pour maximiser la fidélité :

**À privilégier (stable)**

- Layout : **tables** (`<table>`, `border-collapse`, cellules avec largeurs fixes)
- Typo : polices intégrées (ex : **DejaVu Sans**), graisses simples
- Styles : bordures, radius, couleurs unies, padding/margins (mm/pt)
- Images : **PNG/JPG** (idéalement via chemin local ou data-uri base64)
- Pagination : `page-break-inside: avoid` sur les blocs médicaments
- Code 1D : balise mPDF `<barcode ... />` (RPPS) ; QR : image générée côté serveur (data-uri)

**À éviter (souvent instable ou non supporté)**

- CSS Grid / Flexbox avancé
- Variables CSS, pseudo-éléments complexes, filtres, gradients lourds
- JavaScript (non exécuté)
- Fonts Google (à éviter : préférer fontes embarquées si besoin)

### dompdf (alternative possible)

dompdf est globalement similaire (HTML/CSS limité) et excelle aussi avec les **tables**. En pratique :

- Pas de balise `<barcode>` native (il faut des images de codes)
- Support CSS variable selon versions (flex/grid limités)
- JavaScript non exécuté

### Recommandation “template compatible”

Pour un rendu “premium” tout en restant compatible :

- **Structure en cards** via tables + bordures/radius
- Badges simples (fond uni + radius)
- “Timeline/metadata” en colonnes via table
- Pas d’effets décoratifs dépendant de pseudo-éléments

