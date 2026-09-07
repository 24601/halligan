import { expect, type Page } from '@playwright/test';

/**
 * Shared assertions every demo spec runs. Extending lanes import this rather
 * than re-deriving the contract, so a demo cannot quietly ship without it.
 */
export function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  return errors;
}

export function collectForeignRequests(page: Page, origin: string): string[] {
  const foreign: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) return;
    if (!url.startsWith(origin)) foreign.push(url);
  });
  return foreign;
}

export async function assertCspMeta(page: Page): Promise<void> {
  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content');
  expect(
    csp,
    'a Content-Security-Policy meta must ship with the page'
  ).toBeTruthy();
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("base-uri 'none'");
  expect(csp).toContain("form-action 'none'");
}

/** Tab through the page and return the accessible names the keyboard reaches. */
export async function keyboardReach(page: Page, steps = 60): Promise<string[]> {
  const names: string[] = [];
  await page.locator('body').click({ position: { x: 2, y: 2 } });
  for (let i = 0; i < steps; i++) {
    await page.keyboard.press('Tab');
    const name = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return '';
      const label =
        el.getAttribute('aria-label') ??
        el.getAttribute('data-tooltip') ??
        el.getAttribute('placeholder') ??
        el.textContent?.trim().slice(0, 60) ??
        '';
      return `${el.tagName.toLowerCase()}:${label}`;
    });
    if (name) names.push(name);
  }
  return names;
}
