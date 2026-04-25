# SOS Prescription Mobile Visual QA

Outillage CLI de recette visuelle mobile. Ce dossier ne contient pas de code produit.

## Installation

Depuis `tools/mobile-visual/` :

```bash
npm install
npx playwright install --with-deps chromium webkit
```

Si WebKit échoue sur le VPS Linux, conserver Chromium comme pré-check local et utiliser BrowserStack/LambdaTest pour Safari iOS réel.

## Recette locale

```bash
npm run mobile:visual:local
```

Le runner attend `domcontentloaded`, puis un signal DOM propre à chaque surface
au lieu de bloquer sur `networkidle`. Les requêtes longues de cache, analytics ou
scripts tiers ne doivent pas rendre la recette faussement rouge.

Sorties :

```text
/var/www/sosprescription/audits/mobile_visual_local/
```

Chaque combinaison browser/device/URL produit :

- `top.png`
- `full.png`
- `metrics.json`

URLs testées :

- `https://sosprescription.fr/`
- `https://sosprescription.fr/demande-ordonnance/`
- `https://sosprescription.fr/connexion-securisee/`
- `https://sosprescription.fr/politique-de-confidentialite/`
- `https://sosprescription.fr/catalogue-medicaments/`

Devices locaux :

- iPhone SE-like `375x667`
- iPhone standard-like `390x844`
- iPhone Pro Max-like `430x932`
- iPad portrait-like `768x1024`
- iPad landscape-like `1024x768`
- Pixel-like `412x915`

## Recette BrowserStack

Exporter les credentials :

```bash
export BROWSERSTACK_USERNAME="..."
export BROWSERSTACK_ACCESS_KEY="..."
npm run mobile:visual:browserstack
```

Si les variables ne sont pas présentes, le runner affiche `BROWSERSTACK_NOT_CONFIGURED` et ne lance pas de session distante.

Sorties :

```text
/var/www/sosprescription/audits/mobile_visual_browserstack/
```

Devices cibles préparés :

- iPhone SE / Safari
- iPhone 14 / Safari
- iPhone 15 Pro Max / Safari
- iPad / Safari
- Pixel 7 / Chrome Android

## Métriques

Chaque `metrics.json` contient :

- `clientWidth`
- `scrollWidth`
- `horizontalOverflow`
- top 20 éléments plus larges que viewport
- éléments utilisant une largeur en `vw`
- éléments en `white-space: nowrap`
- présence de `overflow-x:hidden` global
- nombre de boutons/liens visibles
- titre de page

## Limites

La recette locale Playwright/Chromium/WebKit reste un pré-check. Elle ne remplace pas Safari iOS réel, Chrome iOS réel ou Google App iOS. Les jalons mobiles doivent être validés avec vrais devices ou cloud real-device, car les écarts de viewport utile, typographie, barre d'adresse et in-app browser sont précisément le problème observé.
