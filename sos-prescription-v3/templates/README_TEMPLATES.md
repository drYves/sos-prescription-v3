# Templates mPDF — SOSPrescription (A/B/C)

Ces templates sont conçus pour mPDF (HTML/CSS limité) sur hébergement mutualisé.  
Aucun JS, aucune ressource externe, mise en page via tables, unités en mm.

## 1) Installer une variante (sans toucher au PHP)

mPDF charge un template depuis un fichier :
- Override recommandé : `/wp-content/uploads/sosprescription-templates/rx-ordonnance-mpdf.html`

Étapes :
1. Choisir une variante :
   - `rx-ordonnance-variant-A.html`
   - `rx-ordonnance-variant-B.html`
   - `rx-ordonnance-variant-C.html`
2. Copier son contenu dans :
   `/wp-content/uploads/sosprescription-templates/rx-ordonnance-mpdf.html`
3. Générer une ordonnance de test depuis le back-office SOSPrescription.

## 2) Comment tester rapidement

### A) Preview HTML brute (sans données)
- Ouvrir le fichier HTML dans un navigateur (les placeholders resteront visibles).
- Objectif : vérifier l'esthétique générale et la cohérence des espacements.

### B) Test PDF mPDF (réel)
Générer un PDF via le plugin (mPDF) avec 4 scénarios minimum.

## 3) Checklist de validation (non-régression)

### Visuel (pixel-stable)
- Header gauche : hiérarchie lisible (spécialité, nom médecin, diplôme, RPPS/adresse/tel).
- Header droite :
  - Badge "Dossier {{UID}}" au-dessus du barcode (stack vertical).
  - Espacement vertical stable entre badge et barcode (pas collé).
  - Alignement à droite propre (tout est flush-right).
- Patient card :
  - 3 colonnes alignées.
  - Poids/Taille : si absent, doit afficher "—" (le PHP le fait via {{PATIENT_WH_LABEL}}).
- Capsule ORDONNANCE : centrée, lisible, style premium.
- Liste médicaments :
  - Nom en gras + tags dosage/forme (si présents) + posologie lisible.
  - Pas de chevauchement, pas de texte minuscule (pas de shrink inattendu).
- Compteur MED_COUNT :
  - Double carré parfaitement 1:1, contours nets, chiffre centré.
- Footer sécurité :
  - QR visible, ID + empreinte + code délivrance lisibles.
  - Signature à droite : image ou fallback discret, sans casser la mise en page.
  - Watermark discret en bas.

### Fonctionnel (scan)
- Barcode Code128A scannable (pharmacie) :
  - NE PAS compenser la quiet-zone (pas de rognage / overflow hidden / negative margins).
  - Objectif : alignement géométrique (bounding-box) à droite.
- QR scannable :
  - QR net, dimension fixe (CSS .qr-img : 18mm x 18mm) et contraste correct.

### Multi-page
- Test "1 médicament" : rendu premium, aucun trou.
- Test "8 médicaments" :
  - Pagination propre, pas de footer écrasé.
  - Chaque bloc médicament reste lisible.
- Test "posologie très longue" :
  - Pas de chevauchement ; si un item est très haut, il peut passer à la page suivante.

### Images
- Signature absente :
  - Le template doit afficher le fallback injecté via {{SIGNATURE_IMG_HTML}}.
- QR absent (cas extrême) :
  - Le layout doit rester stable (cellule QR peut être vide).

## 4) Debug (manuel via template, sans PHP)

Pour vérifier le bounding-box du barcode :
- Dans la variante choisie, décommenter temporairement :
  `barcode { border: 0.2mm solid #ef4444; }`
Puis regénérer un PDF.

=> Si la bordure rouge touche le bord droit de la colonne, l'alignement géométrique est OK.

## 5) Rappel placeholders (ne pas modifier)
Texte : `{{UID}} {{DOCTOR_DISPLAY}} {{SPECIALTY}} {{RPPS}} {{DIPLOMA_LINE}} {{PATIENT_NAME}} {{PATIENT_BIRTH_LABEL}} {{PATIENT_WH_LABEL}} {{RX_PUBLIC_ID}} {{HASH_SHORT}} {{DELIVERY_CODE}} {{MED_COUNT}} {{ISSUE_LINE}}`  
HTML : `{{MEDICATIONS_HTML}} {{QR_IMG_HTML}} {{BARCODE_HTML}} {{SIGNATURE_IMG_HTML}}`
