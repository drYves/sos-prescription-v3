const puppeteer = require('puppeteer');

(async () => {
  console.log("🚀 Lancement de Puppeteer...");
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  
  // Masquage basique pour ressembler à un vrai navigateur
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'fr-FR,fr;q=0.9' });

  // RPPS de test (tiré de tes logs)
  const url = 'https://annuaire.esante.gouv.fr/recherche?identifiant=100005543';
  console.log(`🌐 Navigation vers ${url}...`);

  try {
    // On attend que le réseau se calme (SPA Angular)
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
    
    // On attend 2 secondes supplémentaires pour laisser le JS rendre le DOM
    await new Promise(r => setTimeout(r, 2000));

    console.log("📸 Prise de la capture d'écran...");
    await page.screenshot({ path: '/var/www/sosprescription/rpps-debug.png', fullPage: true });

    // Extraction du texte pour voir si on a les données
    const text = await page.evaluate(() => document.body.innerText);
    console.log("📄 Extrait du DOM :");
    console.log(text.substring(0, 500));

  } catch (e) {
    console.error("❌ Erreur pendant la navigation :", e.message);
  } finally {
    await browser.close();
    console.log("✅ Terminé. Capture sauvegardée dans Filestash.");
  }
})();
