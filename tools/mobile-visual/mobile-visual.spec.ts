import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, type Page } from '@playwright/test';

type TargetUrl = {
  slug: string;
  url: string;
  readySelector: string;
};

type TargetDevice = {
  name: string;
  width: number;
  height: number;
  isMobile: boolean;
};

const OUTPUT_ROOT = '/var/www/sosprescription/audits/mobile_visual_local';

const urls: TargetUrl[] = [
  { slug: 'home', url: 'https://sosprescription.fr/', readySelector: 'body.sp-context-public, .sp-bg-canvas, main' },
  {
    slug: 'demande-ordonnance',
    url: 'https://sosprescription.fr/demande-ordonnance/',
    readySelector: '#sosprescription-root-form, .sp-shell, .sp-app-frame, main',
  },
  {
    slug: 'connexion-securisee',
    url: 'https://sosprescription.fr/connexion-securisee/',
    readySelector: '.sp-shell, .sp-app-frame, form, main',
  },
  {
    slug: 'politique-confidentialite',
    url: 'https://sosprescription.fr/politique-de-confidentialite/',
    readySelector: 'article, .entry-content, main',
  },
  {
    slug: 'catalogue-medicaments',
    url: 'https://sosprescription.fr/catalogue-medicaments/',
    readySelector: '#sosprescription-bdpm-table-root, .sp-shell, .entry-content, main',
  },
];

const devices: TargetDevice[] = [
  { name: 'iphone-se-like', width: 375, height: 667, isMobile: true },
  { name: 'iphone-standard-like', width: 390, height: 844, isMobile: true },
  { name: 'iphone-pro-max-like', width: 430, height: 932, isMobile: true },
  { name: 'ipad-portrait-like', width: 768, height: 1024, isMobile: true },
  { name: 'ipad-landscape-like', width: 1024, height: 768, isMobile: false },
  { name: 'pixel-like', width: 412, height: 915, isMobile: true },
];

async function collectMetrics(page: Page) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await page.evaluate(() => {
        const clientWidth = document.documentElement.clientWidth;
        const scrollWidth = document.documentElement.scrollWidth;
        const all = Array.from(document.querySelectorAll<HTMLElement>('body *'));
        const rects = all
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return {
              tagName: element.tagName,
              className: typeof element.className === 'string' ? element.className.slice(0, 180) : '',
              id: element.id || '',
              text: (element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120),
              width: Math.round(rect.width * 100) / 100,
              left: Math.round(rect.left * 100) / 100,
              right: Math.round(rect.right * 100) / 100,
              top: Math.round(rect.top * 100) / 100,
              display: style.display,
              whiteSpace: style.whiteSpace,
              overflowX: style.overflowX,
              cssWidth: style.width,
              minWidth: style.minWidth,
            };
          })
          .filter((item) => item.width > 0);

        const widest = [...rects].sort((a, b) => b.width - a.width).slice(0, 20);
        const widerThanViewport = rects
          .filter((item) => item.width > clientWidth + 2 || item.left < -2 || item.right > clientWidth + 2)
          .sort((a, b) => b.width - a.width)
          .slice(0, 20);
        const width100vw = rects.filter((item) => item.cssWidth.includes('vw')).slice(0, 20);
        const nowrap = rects.filter((item) => item.whiteSpace === 'nowrap').slice(0, 20);
        const overflowHiddenGlobal = (() => {
          const html = window.getComputedStyle(document.documentElement).overflowX;
          const body = window.getComputedStyle(document.body).overflowX;
          return html === 'hidden' || body === 'hidden';
        })();
        const visibleButtons = all.filter((element) => {
          const rect = element.getBoundingClientRect();
          const role = element.getAttribute('role');
          return rect.width > 0 && rect.height > 0 && (element.tagName === 'BUTTON' || element.tagName === 'A' || role === 'button');
        }).length;

        return {
          title: document.title,
          url: window.location.href,
          clientWidth,
          scrollWidth,
          horizontalOverflow: scrollWidth > clientWidth + 2,
          widest,
          widerThanViewport,
          width100vw,
          nowrap,
          overflowHiddenGlobal,
          visibleButtons,
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

async function gotoAndWaitForSurface(page: Page, target: TargetUrl) {
  let response = null;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      response = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await page.waitForTimeout(750);
      }
    }
  }

  if (lastError) {
    throw lastError;
  }

  if (response && response.status() >= 400) {
    throw new Error(`HTTP ${response.status()} while loading ${target.url}`);
  }

  await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => undefined);
  await page.waitForSelector(target.readySelector, { state: 'attached', timeout: 20_000 });
  await page.waitForTimeout(500);
}

for (const device of devices) {
  for (const target of urls) {
    test(`${device.name} ${target.slug}`, async ({ page, browserName }) => {
      const outputDir = path.join(OUTPUT_ROOT, browserName, device.name, target.slug);
      await mkdir(outputDir, { recursive: true });

      await page.setViewportSize({ width: device.width, height: device.height });
      await gotoAndWaitForSurface(page, target);
      await page.screenshot({ path: path.join(outputDir, 'top.png'), fullPage: false });
      await page.screenshot({ path: path.join(outputDir, 'full.png'), fullPage: true });

      const metrics = {
        capturedAt: new Date().toISOString(),
        browserName,
        device,
        target,
        ...(await collectMetrics(page)),
      };
      await writeFile(path.join(outputDir, 'metrics.json'), JSON.stringify(metrics, null, 2));
    });
  }
}
