SOS Prescription — Templates premium (variants)

Le template actif (par défaut) utilisé par mPDF est :
- templates/rx-ordonnance-mpdf.html

Dans cette version, le template par défaut a été remplacé par un fichier « source propre » (mm-only, tables verrouillées, placeholders inchangés).

Des variantes premium sont livrées pour itérer rapidement sur le rendu, sans toucher au PHP :
- templates/rx-ordonnance-variant-A.html
- templates/rx-ordonnance-variant-B.html
- templates/rx-ordonnance-variant-C.html

Procédure recommandée (override) :
1) Télécharger une variante (via le back-office « Ordonnances » → section Templates) ou via FTP.
2) Renommer la variante en « rx-ordonnance-mpdf.html ».
3) Déposer le fichier dans : wp-content/uploads/sosprescription-templates/
4) Regénérer une ordonnance (Console médecin → Générer PDF).

Rappel : les placeholders doivent rester inchangés (ex : {{UID}}, {{MED_ROWS_HTML}}, {{QR_IMG_HTML}}, {{BARCODE_HTML}}, {{SIGNATURE_IMG_HTML}}).
