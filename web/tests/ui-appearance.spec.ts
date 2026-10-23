import { test, expect, type Page } from '@playwright/test';
test.skip(process.env.DATAQORE_ISOLATED_TEST !== '1', 'Use the disposable full-stack fixture.');
async function theme(page: Page, value: 'Light' | 'Dark' | 'System') {
  if (await page.getByRole('button', { name: 'User menu', exact: true }).count()) {
    const previous = new URL(page.url()).pathname;
    await page.goto('/settings/appearance');
    await page.getByRole('radio', { name: value, exact: true }).check();
    await page.goto(previous);
  } else {
    await page.getByRole('button', { name: 'Theme', exact: true }).click();
    await page.getByRole('radio', { name: value, exact: true }).check();
    await page.keyboard.press('Escape');
  }
}
async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill('admin@dataqore.test');
  await page.getByLabel('Password', { exact: true }).fill('DataQore-test-password-2026');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
}
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
async function readableColors(page: Page) {
  const pairs = await page.evaluate(() => {
    const css = getComputedStyle(document.documentElement);
    const luminance = (token: string) => {
      const color = css.getPropertyValue('--' + token).trim();
      const rgb = color.replace('#', '').match(/.{2}/g)!.map(value => parseInt(value, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
      return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
    };
    return [['semantic-text-primary', 'semantic-background-surface'], ['semantic-text-secondary', 'semantic-background-surface'],
      ['semantic-action-primary-text', 'semantic-action-primary'], ['semantic-status-success-foreground', 'semantic-status-success-background'],
      ['semantic-status-info-foreground', 'semantic-status-info-background'], ['semantic-status-warning-foreground', 'semantic-status-warning-background']]
      .map(([a, b]) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); });
  });
  for (const contrast of pairs) expect(contrast).toBeGreaterThanOrEqual(4.5);
}


test('theme follows the system before React, allows overrides and persists on login', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  // Vite may add a cache-busting query after a source update.
  await page.route(/\/src\/main\.tsx(?:\?.*)?$/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: 'window.__themeBeforeReact = document.documentElement.dataset.theme;\n' + await response.text() });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  expect(await page.evaluate(() => (window as Window & { __themeBeforeReact?: string }).__themeBeforeReact)).toBe('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: 'test-results/theme-login-dark.png', fullPage: true });
  await theme(page, 'Light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('button', { name: 'Theme', exact: true })).toBeFocused();
  await page.emulateMedia({ colorScheme: 'light' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await theme(page, 'System');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('dataqore.ui.theme'))).toBe('system');
});

test('expanded and compact desktop navigation, dark charts and draft preservation', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.sidebar-desktop')).toHaveCSS('width', '256px');
  await readableColors(page);
  await page.screenshot({ path: 'test-results/sidebar-expanded-light.png', fullPage: true });
  await theme(page, 'Dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.sidebar-desktop')).toHaveCSS('background-color', 'rgb(23, 44, 60)');
  await expect(page.locator('.wordmark')).toHaveAttribute('src', '/branding/dataqore-logo-inverse.svg');
  await readableColors(page);
  await expect(page.locator('.recharts-cartesian-axis-tick-value').first()).toHaveCSS('fill', 'rgb(210, 224, 232)');
  await page.screenshot({ path: 'test-results/sidebar-expanded-dark.png', fullPage: true });
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(page.locator('.sidebar-desktop')).toHaveCSS('width', '80px');
  const connections = page.getByRole('link', { name: 'Connections', exact: true });
  await connections.focus();
  await expect(page.getByRole('tooltip')).toHaveText('Connections');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await connections.hover();
  await expect(page.getByRole('tooltip')).toHaveText('Connections');
  await page.screenshot({ path: 'test-results/sidebar-compact-dark.png', fullPage: true });
  await connections.click();
  await page.getByRole('button', { name: 'New connection', exact: true }).click();
  await page.getByLabel('Connection name', { exact: true }).fill('Unsaved appearance draft');
  // System appearance changes also reach open Radix portals without resetting input.
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await theme(page, 'System');
  await page.getByRole('button', { name: 'New connection', exact: true }).click();
  await page.getByLabel('Connection name', { exact: true }).fill('Draft survives system change');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.getByLabel('Connection name', { exact: true })).toHaveValue('Draft survives system change');
  await expect(page.locator('.dialog-content')).toHaveCSS('background-color', 'rgb(18, 37, 50)');
  await page.screenshot({ path: 'test-results/theme-connection-dialog-dark.png', fullPage: true });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await noOverflow(page);
  const preferences = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)])));
  expect(preferences).toEqual({ 'dataqore.ui.theme': 'system', 'dataqore.ui.sidebar': 'collapsed' });
});

test('mobile navigation traps focus, closes and restores desktop preference', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await theme(page, 'Dark');
  await page.setViewportSize({ width: 390, height: 700 });
  const trigger = page.getByRole('button', { name: 'Toggle navigation', exact: true });
  await expect(page.getByRole('dialog', { name: 'Main navigation' })).toHaveCount(0);
  await trigger.click();
  const drawer = page.getByRole('dialog', { name: 'Main navigation' });
  await expect(drawer).toBeVisible();
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Tab');
    expect(await drawer.evaluate(el => el.contains(document.activeElement))).toBe(true);
  }
  await page.screenshot({ path: 'test-results/sidebar-mobile-dark.png', fullPage: true });
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.mouse.click(375, 200);
  await expect(drawer).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await drawer.getByRole('link', { name: 'Catalog', exact: true }).click();
  await expect(drawer).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Catalog', exact: true })).toBeVisible();
  await noOverflow(page);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await page.setViewportSize({ width: 390, height: 500 });
  await trigger.click();
  await expect(drawer.getByRole('button', { name: 'Theme', exact: true })).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await expect(drawer).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeFocused();
});

test('invalid and blocked storage recover without losing interactive appearance', async ({ browser }) => {
  for (const blocked of [false, true]) {
    const context = await browser.newContext({ colorScheme: 'light', baseURL: process.env.DATAQORE_WEB_URL });
    try {
      await context.addInitScript(block => {
        if (block) {
          Storage.prototype.getItem = () => { throw new DOMException('Blocked', 'SecurityError'); };
          Storage.prototype.setItem = () => { throw new DOMException('Blocked', 'SecurityError'); };
        } else { localStorage.setItem('dataqore.ui.theme', 'invalid'); localStorage.setItem('dataqore.ui.sidebar', 'invalid'); }
      }, blocked);
      const page = await context.newPage();
      await login(page);
      await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      await theme(page, 'Dark');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await page.getByRole('button', { name: 'Collapse sidebar' }).click();
      await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
    } finally { await context.close(); }
  }
});
