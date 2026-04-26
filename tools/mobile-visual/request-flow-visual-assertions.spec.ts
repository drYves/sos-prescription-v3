import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, type Page } from '@playwright/test';

type TargetDevice = {
  name: string;
  width: number;
  height: number;
  isMobile: boolean;
};

type VisualIssue = {
  severity: 'info' | 'warning' | 'ko';
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

const OUTPUT_ROOT = '/var/www/sosprescription/audits/02_MOBILE_UX_QA/evidence/request_flow_visual_assertions';
const REQUEST_FLOW_URL = 'https://sosprescription.fr/demande-ordonnance/';

const devices: TargetDevice[] = [
  { name: 'iphone-se-like', width: 375, height: 667, isMobile: true },
  { name: 'iphone-standard-like', width: 390, height: 844, isMobile: true },
  { name: 'iphone-pro-max-like', width: 430, height: 932, isMobile: true },
  { name: 'pixel-like', width: 412, height: 915, isMobile: true },
  { name: 'ipad-portrait-like', width: 768, height: 1024, isMobile: true },
];

async function gotoRequestFlow(page: Page) {
  const response = await page.goto(`${REQUEST_FLOW_URL}?visual_assertions=${Date.now()}`, {
    waitUntil: 'domcontentloaded',
    timeout: 45_000,
  });

  if (response && response.status() >= 400) {
    throw new Error(`HTTP ${response.status()} while loading ${REQUEST_FLOW_URL}`);
  }

  await page.waitForSelector('#sosprescription-root-form, .sp-shell', { state: 'attached', timeout: 20_000 });
  await page.waitForFunction(() => typeof window.SOSPrescription !== 'undefined', null, { timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(1_000);
}

async function screenshotViewport(page: Page, outputDir: string, name: string) {
  await page.screenshot({ path: path.join(outputDir, `${name}.png`), fullPage: false });
}

async function scrollToSelector(page: Page, selector: string) {
  const locator = page.locator(selector).first();
  if ((await locator.count()) === 0) {
    return false;
  }
  await locator.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(300);
  return true;
}

async function chooseRequestPath(page: Page) {
  const choices = page.locator('#sosprescription-root-form button.sp-app-choice-card');
  if ((await choices.count()) === 0) {
    return false;
  }
  await choices.nth(1).click();
  await page.waitForTimeout(800);
  return true;
}

async function collectChoiceCards(page: Page) {
  return page.evaluate(() => {
    const textOf = (element: Element | null) => (element?.textContent || '').trim().replace(/\s+/g, ' ');
    const rectOf = (element: Element | null) => {
      if (!element) {
        return null;
      }
      const rect = element.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
      };
    };
    const lineWidths = (element: Element) => {
      const widths: number[] = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.textContent || !node.textContent.trim()) {
          continue;
        }
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of Array.from(range.getClientRects())) {
          if (rect.width > 1 && rect.height > 1) {
            widths.push(Math.round(rect.width));
          }
        }
        range.detach();
      }
      return widths;
    };

    return Array.from(document.querySelectorAll<HTMLElement>('.sp-app-choice-card')).map((element) => ({
      text: textOf(element).slice(0, 120),
      rect: rectOf(element),
      display: window.getComputedStyle(element).display,
      lineWidths: lineWidths(element),
    }));
  });
}

async function collectVisualAssertions(
  page: Page,
  device: TargetDevice,
  browserName: string,
  initialChoiceCards: Awaited<ReturnType<typeof collectChoiceCards>>,
) {
  return page.evaluate(
    ({ device, browserName, initialChoiceCards }) => {
      type RectSnapshot = {
        x: number;
        y: number;
        width: number;
        height: number;
        top: number;
        bottom: number;
        left: number;
        right: number;
      };

      type VisualIssue = {
        severity: 'info' | 'warning' | 'ko';
        code: string;
        message: string;
        details?: Record<string, unknown>;
      };

      const issues: VisualIssue[] = [];
      const viewport = {
        width: document.documentElement.clientWidth,
        height: window.innerHeight,
      };

      const rectOf = (element: Element | null): RectSnapshot | null => {
        if (!element) {
          return null;
        }
        const rect = element.getBoundingClientRect();
        return {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
        };
      };

      const textOf = (element: Element | null) => (element?.textContent || '').trim().replace(/\s+/g, ' ');

      const parseRgb = (value: string) => {
        const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
        if (!match) {
          return null;
        }
        return [Number(match[1]), Number(match[2]), Number(match[3])] as const;
      };

      const luminance = ([r, g, b]: readonly [number, number, number]) => {
        const convert = (channel: number) => {
          const normalized = channel / 255;
          return normalized <= 0.03928 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * convert(r) + 0.7152 * convert(g) + 0.0722 * convert(b);
      };

      const contrastRatio = (color: string, background: string) => {
        const foreground = parseRgb(color);
        const back = parseRgb(background);
        if (!foreground || !back) {
          return null;
        }
        const a = luminance(foreground);
        const b = luminance(back);
        return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
      };

      const lineWidths = (element: Element) => {
        const widths: number[] = [];
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (!node.textContent || !node.textContent.trim()) {
            continue;
          }
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const rect of Array.from(range.getClientRects())) {
            if (rect.width > 1 && rect.height > 1) {
              widths.push(Math.round(rect.width));
            }
          }
          range.detach();
        }
        return widths;
      };

      const countConsecutiveShortLines = (widths: number[], threshold: number) => {
        let max = 0;
        let current = 0;
        for (const width of widths) {
          if (width < threshold) {
            current += 1;
            max = Math.max(max, current);
          } else {
            current = 0;
          }
        }
        return max;
      };

      const siteHeader = document.querySelector('#masthead.site-header, .site-header');
      const siteHeaderRect = rectOf(siteHeader);
      const siteHeaderStyle = siteHeader ? window.getComputedStyle(siteHeader) : null;
      const appRoot = document.querySelector('#sosprescription-root-form');
      const appRootRect = rectOf(appRoot);
      const firstAppText = document.querySelector('#sosprescription-root-form .sp-app-header, #sosprescription-root-form .sp-app-stagebar, #sosprescription-root-form .sp-app-card');
      const firstAppTextRect = rectOf(firstAppText);

      if (siteHeaderRect && siteHeaderStyle && ['sticky', 'fixed'].includes(siteHeaderStyle.position)) {
        if (siteHeaderRect.height > 140 && device.width <= 430) {
          issues.push({
            severity: 'ko',
            code: 'HEADER_TOO_TALL_MOBILE',
            message: 'Le header sticky occupe une hauteur mobile excessive et réduit fortement la zone utile.',
            details: { height: siteHeaderRect.height, threshold: 140, position: siteHeaderStyle.position },
          });
        } else if (siteHeaderRect.height > 112 && device.width <= 430) {
          issues.push({
            severity: 'warning',
            code: 'HEADER_TALL_MOBILE',
            message: 'Le header sticky est haut pour un premier écran mobile.',
            details: { height: siteHeaderRect.height, threshold: 112, position: siteHeaderStyle.position },
          });
        }

        if (firstAppTextRect && firstAppTextRect.top < siteHeaderRect.bottom - 4 && firstAppTextRect.bottom > siteHeaderRect.top + 4) {
          issues.push({
            severity: 'ko',
            code: 'HEADER_OVERLAPS_APP_CONTENT',
            message: 'Le header sticky recouvre du contenu applicatif visible.',
            details: { header: siteHeaderRect, firstAppText: firstAppTextRect },
          });
        }
      }

      const stagebar = document.querySelector('.sp-app-stagebar');
      const stagebarRect = rectOf(stagebar);
      const stageItems = stagebar ? Array.from(stagebar.children) : [];
      const stageSnapshots = stageItems.map((element) => ({
        text: textOf(element),
        rect: rectOf(element),
      }));
      const stageLabels = stageItems.map((element) => textOf(element)).filter(Boolean);
      const narrowStageItems = stageSnapshots.filter((item) => item.rect && item.rect.width < 44);
      const stageLabelOverlaps = stageSnapshots.some((item, index) => {
        const next = stageSnapshots[index + 1];
        return Boolean(item.rect && next?.rect && item.rect.right > next.rect.left + 2 && item.rect.bottom > next.rect.top + 2);
      });

      if (stagebarRect && device.width <= 430) {
        if (stagebarRect.width / Math.max(stageItems.length, 1) < 70) {
          issues.push({
            severity: 'warning',
            code: 'STAGEBAR_COMPRESSED',
            message: 'La stagebar dispose de peu de largeur par étape sur mobile.',
            details: { stagebarWidth: stagebarRect.width, itemCount: stageItems.length, widthPerItem: Math.round(stagebarRect.width / Math.max(stageItems.length, 1)) },
          });
        }
        if (narrowStageItems.length > 0 || stageLabelOverlaps) {
          issues.push({
            severity: 'ko',
            code: 'STAGEBAR_LABEL_RISK',
            message: 'La stagebar présente un risque de labels illisibles ou chevauchés.',
            details: { narrowStageItems, stageLabelOverlaps, stageLabels },
          });
        }
      }

      const choiceCards = Array.from(document.querySelectorAll<HTMLElement>('.sp-app-choice-card'));
      const currentChoiceCardSnapshots = choiceCards.map((element) => ({
        text: textOf(element).slice(0, 120),
        rect: rectOf(element),
        display: window.getComputedStyle(element).display,
        lineWidths: lineWidths(element),
      }));
      const choiceCardSnapshots = initialChoiceCards.length > 0 ? initialChoiceCards : currentChoiceCardSnapshots;
      const visibleChoiceCards = choiceCardSnapshots.filter((item) => item.rect && item.rect.width > 0 && item.rect.height > 0);
      const cardsSideBySide = visibleChoiceCards.length >= 2 && visibleChoiceCards.some((item, index) => {
        const next = visibleChoiceCards[index + 1];
        return Boolean(item.rect && next?.rect && Math.abs(item.rect.top - next.rect.top) < 24);
      });
      const narrowCards = visibleChoiceCards.filter((item) => item.rect && item.rect.width < 280);
      const fragmentedCards = visibleChoiceCards.filter((item) => countConsecutiveShortLines(item.lineWidths, 70) >= 3);

      if (device.width <= 430) {
        if (cardsSideBySide) {
          issues.push({
            severity: 'ko',
            code: 'CHOICE_CARDS_TWO_COLUMNS_MOBILE',
            message: 'Les cards de choix apparaissent en deux colonnes sous 430px.',
            details: { visibleChoiceCards },
          });
        }
        if (narrowCards.length > 0) {
          issues.push({
            severity: 'ko',
            code: 'CHOICE_CARDS_TOO_NARROW',
            message: 'Une card de choix est trop étroite pour une lecture mobile confortable.',
            details: { narrowCards },
          });
        }
        if (fragmentedCards.length > 0) {
          issues.push({
            severity: 'warning',
            code: 'CHOICE_CARD_TEXT_FRAGMENTATION',
            message: 'Le texte de card contient plusieurs lignes visuellement très courtes.',
            details: { fragmentedCards: fragmentedCards.map((item) => ({ text: item.text, lineWidths: item.lineWidths })) },
          });
        }
      }

      const legalLabels = Array.from(document.querySelectorAll<HTMLElement>('.sp-app-card--consent label, .sp-app-card--attestation label, .sp-app-checkbox__label'));
      const legalSnapshots = legalLabels.map((element) => ({
        text: textOf(element).slice(0, 140),
        rect: rectOf(element),
        lineWidths: lineWidths(element),
      }));
      const narrowLegal = legalSnapshots.filter((item) => item.rect && item.rect.width < 180);
      const fragmentedLegal = legalSnapshots.filter((item) => countConsecutiveShortLines(item.lineWidths, 70) >= 3);
      const consentCardRect = rectOf(document.querySelector('.sp-app-card--consent'));

      if (narrowLegal.length > 0) {
        issues.push({
          severity: 'ko',
          code: 'LEGAL_TEXT_TOO_NARROW',
          message: 'Un bloc legal/attestation a une largeur de texte utile trop faible.',
          details: { narrowLegal },
        });
      }
      if (fragmentedLegal.length > 0) {
        issues.push({
          severity: 'warning',
          code: 'LEGAL_TEXT_FRAGMENTATION',
          message: 'Un bloc legal/attestation contient des lignes très courtes successives.',
          details: { fragmentedLegal: fragmentedLegal.map((item) => ({ text: item.text, lineWidths: item.lineWidths })) },
        });
      }
      if (consentCardRect && device.width <= 430 && consentCardRect.height > 560) {
        issues.push({
          severity: 'warning',
          code: 'LEGAL_BLOCK_TOO_TALL',
          message: 'Le bloc consentements occupe une hauteur excessive sur mobile.',
          details: { consentCard: consentCardRect, threshold: 560 },
        });
      }

      const continueButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) => textOf(button).toLowerCase() === 'continuer');
      const continueRect = rectOf(continueButton || null);
      const continueStyle = continueButton ? window.getComputedStyle(continueButton) : null;
      const continueContrast = continueStyle ? contrastRatio(continueStyle.color, continueStyle.backgroundColor) : null;
      if (!continueButton || !continueRect || continueRect.width === 0 || continueRect.height === 0) {
        issues.push({
          severity: 'ko',
          code: 'CTA_CONTINUE_NOT_VISIBLE',
          message: 'Le CTA Continuer est absent ou invisible.',
        });
      } else {
        const opacity = continueStyle ? Number(continueStyle.opacity) : 1;
        if (opacity < 0.65) {
          issues.push({
            severity: 'ko',
            code: 'CTA_CONTINUE_LOW_OPACITY',
            message: 'Le CTA Continuer a une opacité trop faible.',
            details: { opacity },
          });
        }
        if (continueRect.height < 44) {
          issues.push({
            severity: 'warning',
            code: 'CTA_CONTINUE_SMALL_TOUCH_TARGET',
            message: 'Le CTA Continuer est sous la hauteur minimale tactile recommandée.',
            details: { height: continueRect.height },
          });
        }
        if (continueContrast !== null && continueContrast < 3) {
          issues.push({
            severity: 'warning',
            code: 'CTA_CONTINUE_LOW_CONTRAST',
            message: 'Le contraste texte/fond du CTA Continuer est faible.',
            details: { contrast: continueContrast, color: continueStyle?.color, backgroundColor: continueStyle?.backgroundColor },
          });
        }
      }

      const koCount = issues.filter((issue) => issue.severity === 'ko').length;
      const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
      const verdict = koCount > 0 ? 'KO' : warningCount > 0 ? 'PARTIAL' : 'OK';

      return {
        capturedAt: new Date().toISOString(),
        browserName,
        device,
        viewport,
        verdict,
        issueSummary: { koCount, warningCount, infoCount: issues.filter((issue) => issue.severity === 'info').length },
        issues,
        measurements: {
          siteHeader: {
            rect: siteHeaderRect,
            position: siteHeaderStyle?.position || null,
            zIndex: siteHeaderStyle?.zIndex || null,
          },
          appRoot: appRootRect,
          firstAppText: firstAppTextRect,
          stagebar: {
            rect: stagebarRect,
            labels: stageLabels,
            items: stageSnapshots,
          },
          choiceCards: visibleChoiceCards,
          currentChoiceCards: currentChoiceCardSnapshots,
          legal: {
            consentCard: consentCardRect,
            labels: legalSnapshots,
          },
          cta: {
            rect: continueRect,
            opacity: continueStyle?.opacity || null,
            contrast: continueContrast,
            backgroundColor: continueStyle?.backgroundColor || null,
            color: continueStyle?.color || null,
          },
        },
      };
    },
    { device, browserName, initialChoiceCards },
  );
}

test.describe('request flow visual assertions', () => {
  for (const device of devices) {
    test(`${device.name}`, async ({ page, browserName }) => {
      const outputDir = path.join(OUTPUT_ROOT, browserName, device.name);
      await mkdir(outputDir, { recursive: true });

      await page.setViewportSize({ width: device.width, height: device.height });
      await gotoRequestFlow(page);
      await screenshotViewport(page, outputDir, 'top');

      await scrollToSelector(page, '.sp-app-stagebar');
      await screenshotViewport(page, outputDir, 'stagebar');

      await scrollToSelector(page, '.sp-app-card--step-choice, .sp-app-choice-card');
      await screenshotViewport(page, outputDir, 'choice_cards');
      const initialChoiceCards = await collectChoiceCards(page);

      const pathChosen = await chooseRequestPath(page);
      if (pathChosen) {
        await scrollToSelector(page, '.sp-app-card--medication-request');
        await screenshotViewport(page, outputDir, 'treatment');

        await scrollToSelector(page, '.sp-app-card--consent, .sp-app-card--attestation');
        await screenshotViewport(page, outputDir, 'legal');

        await scrollToSelector(page, 'button.sp-app-button--primary');
        await screenshotViewport(page, outputDir, 'cta');
      }

      const assertions = await collectVisualAssertions(page, device, browserName, initialChoiceCards);
      await writeFile(path.join(outputDir, 'request_flow_visual_assertions.json'), JSON.stringify(assertions, null, 2));
    });
  }
});
