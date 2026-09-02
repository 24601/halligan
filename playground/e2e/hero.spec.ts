import { expect, test } from '@playwright/test';
import {
  assertCspMeta,
  collectConsoleErrors,
  collectForeignRequests,
  keyboardReach,
} from './contract.js';

const ORIGIN = 'http://localhost:4173';
const PINNED = '/?seed=7&run=off';

async function settle(page: import('@playwright/test').Page): Promise<void> {
  // The archive is seeded by running the mind for real; wait for it rather
  // than for a fixed delay, so the pinned state is a state and not a moment.
  await expect(page.getByText(/checkpoints over/)).toBeVisible({
    timeout: 60_000,
  });
}

test.describe('D1 hero', () => {
  test('loads, runs a real mind, and keeps to its own origin', async ({
    page,
  }) => {
    const errors = collectConsoleErrors(page);
    const foreign = collectForeignRequests(page, ORIGIN);

    await page.goto(PINNED);
    await assertCspMeta(page);

    await expect(
      page.getByRole('heading', { name: 'A mind, waking itself.' })
    ).toBeVisible();
    await expect(page.locator('.hero__kicker')).toHaveText(
      'No provider attached'
    );

    // Real steps, read out of the store: the log is not empty and the step
    // chip agrees with it.
    await expect(page.locator('.log__row').first()).toBeVisible();
    await settle(page);

    const stepsChip = page.locator('.chip', { hasText: 'STEPS' });
    await expect(stepsChip).toBeVisible();
    const stepsText = (await stepsChip.innerText()).replace(/\D+/g, '');
    expect(Number(stepsText)).toBeGreaterThan(0);

    // The unmeasured cost is an em-dash, never a zero and never red.
    const cost = page.locator('.chip', { hasText: 'COST' });
    await expect(cost).toContainText('—');
    await expect(cost).not.toContainText('0');

    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
    expect(foreign, `unexpected origins: ${foreign.join(' | ')}`).toEqual([]);
  });

  test('poking the mind snaps the ladder to rung 0 through the real dispatch path', async ({
    page,
  }) => {
    await page.goto(PINNED);
    await settle(page);

    // Advance enough simulated time for the pacer to climb off rung 0.
    for (let i = 0; i < 4; i++) {
      await page.getByRole('button', { name: 'Step' }).click();
    }
    const rung = page.locator('.ladder__now');
    await expect(rung).not.toContainText('rung 0', { timeout: 30_000 });

    await page.getByRole('button', { name: /Poke the mind/ }).click();
    await expect(rung).toContainText('rung 0', { timeout: 30_000 });
  });

  test('space pokes the mind from the keyboard', async ({ page }) => {
    await page.goto(PINNED);
    await settle(page);
    const before = await page.locator('.log__row').count();
    await page.locator('h1').click();
    await page.keyboard.press('Space');
    await expect
      .poll(async () => page.locator('.log__row').count(), { timeout: 30_000 })
      .toBeGreaterThan(before);
  });

  test('the keyboard reaches every control on the hero', async ({ page }) => {
    await page.goto(PINNED);
    await settle(page);
    const reached = (await keyboardReach(page, 70)).join(' || ');
    for (const control of [
      'Skip to the mind',
      'Find a demo',
      'Toggle the evidence drawer',
      'Poke the mind',
      'Run',
      'Step',
      'Reset',
      'Open the deep view',
      'Recover the pacer from the log',
    ]) {
      expect(reached, `keyboard never reached: ${control}`).toContain(control);
    }
    const sliders = await page.locator('input[type="range"]').count();
    expect(sliders).toBeGreaterThan(1);
  });

  test('the evidence drawer opens on I and carries live pacer state', async ({
    page,
  }) => {
    await page.goto(PINNED);
    await settle(page);
    await page.locator('h1').click();
    await page.keyboard.press('i');
    const drawer = page.getByRole('dialog', { name: 'Evidence inspector' });
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText('spontaneousWakes');
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
  });

  test('the finder opens on Cmd/Ctrl+K and routes to a live demo', async ({
    page,
  }) => {
    await page.goto(PINNED);
    await settle(page);
    await page.locator('h1').click();
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: 'Find' });
    await expect(palette).toBeVisible();
    await page.keyboard.type('ladder');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/d=D1/);
    await expect(
      page.getByRole('heading', { name: 'Mind', exact: true })
    ).toBeVisible();
  });

  test('the deep view loads its compactor and fork', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await page.goto('/?d=D1&seed=7&run=off');
    await expect(
      page.getByRole('heading', { name: 'Mind', exact: true })
    ).toBeVisible();
    await expect(page.getByText('Context window compactor')).toBeVisible();
    await expect(page.getByText('Fork from a step')).toBeVisible();
    await page.getByRole('button', { name: 'Fork', exact: true }).click();
    await expect(page.locator('.fork__receipt')).toContainText(/depth 1/, {
      timeout: 60_000,
    });
    await expect(page.locator('.fork__side')).toHaveCount(2);
    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('pinned hero, light theme', async ({ page }) => {
    await page.goto(PINNED);
    await settle(page);
    await page.evaluate(() =>
      document.documentElement.setAttribute('data-theme', 'light')
    );
    await expect(page.locator('.hero')).toHaveScreenshot('hero-light.png', {
      mask: [page.locator('.log__scroll'), page.locator('.chips')],
    });
  });

  test('pinned hero, dark theme', async ({ page }) => {
    await page.goto(PINNED);
    await settle(page);
    await page.evaluate(() =>
      document.documentElement.setAttribute('data-theme', 'dark')
    );
    await expect(page.locator('.hero')).toHaveScreenshot('hero-dark.png', {
      mask: [page.locator('.log__scroll'), page.locator('.chips')],
    });
  });
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('the hero is fully legible with no motion', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await page.goto(PINNED);
    await settle(page);
    await expect(page.locator('.ladder__now')).toContainText('rung');
    // Nothing may exist only in motion: the ladder prints its level, the
    // pyramid prints its block sizes.
    await expect(page.locator('.hero__bignum')).toBeVisible();
    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
  });
});
