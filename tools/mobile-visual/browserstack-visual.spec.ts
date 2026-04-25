import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, type Page } from '@playwright/test';

const configured = Boolean(process.env.BROWSERSTACK_USERNAME && process.env.BROWSERSTACK_ACCESS_KEY);
const OUTPUT_ROOT = '/var/www/sosprescription/audits/mobile_visual_browserstack';

const urls = configured
  ? [
      { slug: 'home', url: 'https://sosprescription.fr/' },
      { slug: 'demande-ordonnance', url: 'https://sosprescription.fr/demande-ordonnance/' },
      { slug: 'connexion-securisee', url: 'https://sosprescription.fr/connexion-securisee/' },
      { slug: 'politique-confidentialite', url: 'https://sosprescription.fr/politique-de-confidentialite/' },
      { slug: 'catalogue-medicaments', url: 'https://sosprescription.fr/catalogue-medicaments/' },
    ]
  : [];

async function collectMetrics(page: Page) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await page.evaluate(() => {
        const clientWidth = document.documentElement.clientWidth;
        const scrollWidth = document.documentElement.scrollWidth;
        const all = Array.from(document.querySelectorAll<HTMLElement>('body *'));
        const widerThanViewport = all
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              tagName: element.tagName,
              className: typeof element.className === 'string' ? element.className.slice(0, 180) : '',
              id: element.id || '',
              text: (element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120),
              width: Math.round(rect.width * 100) / 100,
              left: Math.round(rect.left * 100) / 100,
              right: Math.round(rect.right * 100) / 100,
            };
          })
          .filter((item) => item.width > clientWidth + 2 || item.left < -2 || item.right > clientWidth + 2)
          .sort((a, b) => b.width - a.width)
          .slice(0, 20);

        return {
          title: document.title,
          url: window.location.href,
          clientWidth,
          scrollWidth,
          horizontalOverflow: scrollWidth > clientWidth + 2,
          widerThanViewport,
        };
      });
    } catch (error) {
      if (attempt === 3) {
        throw error;
      }
      await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
      await page.waitForTimeout(500);
    }
  }

  throw new Error('Unable to collect metrics');
}

if (!configured) {
  test('BROWSERSTACK_NOT_CONFIGURED', async () => {
    console.log('BROWSERSTACK_NOT_CONFIGURED: export BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY.');
  });
}

for (const target of urls) {
  test(`real-device ${target.slug}`, async ({ page }, testInfo) => {
    const projectName = testInfo.project.name;
    const outputDir = path.join(OUTPUT_ROOT, projectName, target.slug);
    await mkdir(outputDir, { recursive: true });

    await page.goto(target.url, { waitUntil: 'networkidle', timeout: 90_000 });
    await page.screenshot({ path: path.join(outputDir, 'top.png'), fullPage: false });
    await page.screenshot({ path: path.join(outputDir, 'full.png'), fullPage: true });

    const metrics = {
      capturedAt: new Date().toISOString(),
      projectName,
      target,
      ...(await collectMetrics(page)),
    };
    await writeFile(path.join(outputDir, 'metrics.json'), JSON.stringify(metrics, null, 2));
  });
}
