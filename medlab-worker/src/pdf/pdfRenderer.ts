import puppeteer, { type Browser } from 'puppeteer-core';

export type RenderInput = { html: string; timeoutMs?: number };

export class PdfRenderer {
  private browserPromise: Promise<Browser> | null = null;

  private getBrowser(): Promise<Browser> {
    if (!this.browserPromise) {
      this.browserPromise = puppeteer.launch({
        executablePath: process.env['PUPPETEER_EXECUTABLE_PATH'] ?? '/usr/bin/chromium-browser',
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
    }
    return this.browserPromise;
  }

  async render(input: RenderInput): Promise<Buffer> {
    const browser = await this.getBrowser();
    const context = await browser.createBrowserContext();
    try {
      const page = await context.newPage();
      await page.setContent(input.html, { waitUntil: 'networkidle0', timeout: input.timeoutMs ?? 20_000 });
      return Buffer.from(await page.pdf({ format: 'A4', printBackground: true }));
    } finally {
      await context.close();
    }
  }
}
