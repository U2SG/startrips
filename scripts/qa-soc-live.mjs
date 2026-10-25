import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { selectHostedBrowser } from './ci-browser-runtime.mjs';

const origin = new URL(process.env.SOC_LIVE_ORIGIN).origin;
const artifacts = 'artifacts/soc-live';
await fs.mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ executablePath: selectHostedBrowser(), headless: true, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  let blockedFonts = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*.ttf', async (route) => { blockedFonts++; await route.abort(); });
  const response = await page.goto(`${origin}/soc/`, { waitUntil: 'domcontentloaded' });
  assert.equal(response.status(), 200);
  await page.getByLabel('邮箱', { exact: true }).waitFor({ timeout: 15000 });
  await page.getByTestId('soc-splash').waitFor({ state: 'detached', timeout: 15000 });
  await page.getByRole('button', { name: '登录', exact: true }).waitFor();
  assert.ok(blockedFonts > 0);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: `${artifacts}/sign-in.png` });
  await fs.writeFile(`${artifacts}/receipt.json`, JSON.stringify({ origin, signInVisible: true, blockedFonts, errors }, null, 2));
  await context.close();
} finally {
  await browser.close();
}
