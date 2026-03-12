SOS Prescription — Guide d'installation (Hostinger / mutualisé)
===========================================================

Ce guide est volontairement "pas à pas" (niveau débutant) pour mettre le plugin en route sur un hébergement mutualisé (Hostinger).

Pré-requis
----------
- WordPress >= 6.0
- PHP >= 8.2
- HTTPS activé (obligatoire)

1) Installer le plugin
----------------------
1. Dans WordPress : Extensions > Ajouter.
2. Cliquez "Téléverser une extension".
3. Sélectionnez le fichier ZIP du plugin (sosprescription.zip) puis installez/activez.

2) Configurer l'anti-bot Turnstile (Cloudflare)
----------------------------------------------
Turnstile est intégré directement au plugin (aucun dossier mu-plugins à déplacer).

Il faut uniquement définir les clés (Site Key + Secret Key).

Sur Hostinger :
1. Ouvrez le gestionnaire de fichiers.
2. Éditez le fichier : public_html/wp-config.php
3. Ajoutez (ou modifiez) ces constantes (adaptez les valeurs) :

    define('SOSPRESCRIPTION_TURNSTILE_SITE_KEY', 'VOTRE_SITE_KEY');
    define('SOSPRESCRIPTION_TURNSTILE_SECRET_KEY', 'VOTRE_SECRET_KEY');

4. Enregistrez.

Note : le script Turnstile est chargé depuis Cloudflare.
Pensez à le mentionner dans votre politique de confidentialité / cookies si nécessaire.

3) Vérifier les permissions (dossiers uploads)
----------------------------------------------
Le plugin stocke des fichiers dans wp-content/uploads. Il crée les dossiers automatiquement.

Sur Hostinger, vérifiez que le dossier suivant est bien inscriptible :
- wp-content/uploads/

Le plugin va créer (au besoin) ces sous-dossiers :
- wp-content/uploads/sosprescription-private/   (pièces jointes patient, PDF ordonnance)
- wp-content/uploads/sosprescription-logs/      (logs runtime / bdpm)
- wp-content/uploads/sosprescription-import/    (sessions d'import BDPM)
- wp-content/uploads/sosprescription-templates/ (override templates ordonnance / vérification)

Permissions recommandées :
- Dossiers : 755 (si problème d'écriture, essayez 775)
- Fichiers : 644

À éviter : 777 (dangereux).

4) Importer la BDPM (référentiel médicaments)
---------------------------------------------
L'import BDPM est conçu pour les hébergements mutualisés (timeouts PHP). Il fonctionne en "batch" (petites étapes) et peut reprendre.

Procédure :
1. Dans WordPress : SOS Prescription > Import BDPM.
2. Étape 1 : uploadez l'archive ZIP BDPM (source officielle : base-donnees-publique.medicaments.gouv.fr/telechargement).
3. Étape 2 : cliquez "Démarrer / Reprendre".

Si l'hébergement coupe le process (timeout) :
- Rechargez la page
- Cliquez à nouveau "Démarrer / Reprendre"
Le batch reprendra automatiquement sur la session d'import.

Après import :
- Utilisez "Vérifier la recherche médicament" (test search) sur la page Import.
- Si la recherche côté patient semble vide : vérifiez l'état BDPM + la whitelist (périmètre).

5) Configurer le périmètre (Whitelist)
--------------------------------------
Le plugin supporte un périmètre de lancement :
- RO / continuité documentée (avec preuve)
- Dépannage continuité (sans preuve) avec restrictions

Allez dans : SOS Prescription > Périmètre.
- Configurez les listes ATC/CIS autorisées / interdites selon vos besoins.

6) Tester un parcours complet
-----------------------------
1. Connectez-vous en tant que patient (compte WP) et soumettez une demande via le formulaire.
2. Connectez-vous en tant que médecin (compte WP) et ouvrez la Console Médecin.
3. Générez le PDF puis validez/refusez.
4. Vérifiez la page de vérification /v/{token} via le QR.

7) Logs & debug
---------------
Les logs projet sont accessibles via : SOS Prescription > Logs.
Vous pouvez y :
- Télécharger un fichier
- Vider (truncate)
- Supprimer
- Télécharger un ZIP complet

8) Mise à jour : IMPORTANT (vous supprimez le plugin)
-----------------------------------------------------
Vous avez indiqué mettre à jour en supprimant puis réinstallant le plugin.

- Par défaut, SOS Prescription conserve les données (tables/options/signatures/templates) lors de la suppression.
- Pour forcer une purge totale, utilisez le réglage dans : SOS Prescription > Installation & statut (case "Purger toutes les données lors de la suppression").

9) OCR (validation soft côté navigateur)
---------------------------------------
Sur Hostinger, l'OCR serveur est désactivé. Le plugin utilise un OCR *client-side* (Tesseract.js) :
- L'analyse se fait dans le navigateur au moment de l'upload (pièce justificative).
- Si des mots-clés médicaux sont détectés => indicateur vert.
- Sinon => warning + bouton "Forcer l'envoi" (jamais bloquant).

Astuce : la 1ère exécution peut être un peu lente (download des assets wasm/lang dans le navigateur), c'est normal.
