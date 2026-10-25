import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { selectHostedBrowser } from './ci-browser-runtime.mjs';

const root = path.resolve('mobile/soc/dist');
const artifacts = path.resolve('artifacts/soc');
await fs.mkdir(artifacts, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
const cardsPath = 'project-data/accounts/local/profiles/default/worlds/ci-world/flashcards/book.json';
let cardVersion = 0;
let cards = { textbookId: 'book', updatedAt: new Date().toISOString(), cards: [1, 2].map((number) => ({
  id: `card-${number}`, question: `CI question ${number}`, choices: [`CI answer ${number}`, 'Other'], correctIndex: 0,
  explanation: 'CI explanation', source: { textbook: 'CI book', chapter: 'CI chapter', textbookSlug: 'book' },
  created: new Date().toISOString(), conversationId: 'ci-lesson', status: 'active', history: [],
})) };
const writes = [];
const waitForWrite = async (count) => {
  for (let attempt = 0; attempt < 100 && writes.length < count; attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(writes.length, count, 'The expected review write must reach the server');
  return writes[count - 1];
};
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const authenticated = request.headers.cookie?.includes('ci-study=1');
  function json(status, value) { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); }
  if (url.pathname === '/api/auth/sign-in/email') {
    response.setHeader('Set-Cookie', 'ci-study=1; HttpOnly; SameSite=Lax; Path=/');
    return json(200, {});
  }
  if (url.pathname === '/api/auth/sign-out') {
    response.setHeader('Set-Cookie', 'ci-study=; Max-Age=0; Path=/');
    return json(200, {});
  }
  if (url.pathname.startsWith('/api/soc/')) {
    if (!authenticated) return json(401, { error: 'AUTH_REQUIRED' });
    if (url.pathname.endsWith('/session')) return json(200, { user: { id: 'ci-study', name: 'Study', email: 'study@example.test' } });
    if (url.pathname.endsWith('/ping')) return json(200, { ok: true, root: '' });
    if (url.pathname.endsWith('/models')) return json(200, { active: '', profiles: [] });
    if (url.pathname.endsWith('/list')) return json(200, { entries: url.searchParams.get('path')?.endsWith('/flashcards') ? [{ name: 'book.json', dir: false, size: 0, mtime: 0 }] : [] });
    if (url.pathname.endsWith('/file')) {
      const relative = url.searchParams.get('path');
      if (relative?.endsWith('/worlds/active.json')) return json(200, { worldId: 'ci-world', textbookId: 'book' });
      if (relative?.endsWith('/textbook_index.json')) return json(200, { worldId: 'ci-world', updatedAt: '', textbooks: [] });
      if (relative === cardsPath) {
        if (request.method === 'PUT') {
          let text = '';
          for await (const chunk of request) text += chunk;
          const value = JSON.parse(text);
          writes.push({
            value, match: request.headers['if-match'],
            succeed() {
              assert.equal(this.match, `"cards-${cardVersion}"`);
              cards = value; cardVersion++;
              response.setHeader('ETag', `"cards-${cardVersion}"`);
              json(200, { ok: true });
            },
            fail() { json(503, { error: 'CI_OFFLINE', message: 'CI save unavailable' }); },
          });
          return;
        }
        response.setHeader('ETag', `"cards-${cardVersion}"`);
        return json(200, cards);
      }
    }
    if (url.pathname.endsWith('/voice')) return json(200, { available: false });
    return json(404, { error: 'STUDY_FILE_NOT_FOUND' });
  }
  try {
    const relative = url.pathname.replace(/^\/soc\/?/, '') || 'index.html';
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) return json(403, {});
    const bytes = await fs.readFile(file);
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    response.end(bytes);
  } catch { json(404, {}); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const browser = await chromium.launch({ executablePath: selectHostedBrowser(), headless: true, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/soc/`);
  await page.getByLabel('邮箱', { exact: true }).waitFor({ timeout: 60000 });
  await page.getByTestId('soc-splash').waitFor({ state: 'detached' });
  await page.screenshot({ path: path.join(artifacts, 'sign-in.png') });
  await page.getByLabel('邮箱', { exact: true }).fill('study@example.test');
  await page.getByLabel('密码', { exact: true }).fill('ci-only-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '教材', exact: true }).waitFor();
  assert.equal(await page.getByLabel('访问令牌', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '闪卡', exact: true }).click();
  await page.getByText('CI question 1', { exact: true }).waitFor();
  await page.getByText('CI answer 1', { exact: true }).click();
  const firstWrite = await waitForWrite(1);
  const saving = page.getByText('保存中…', { exact: true });
  await saving.waitFor();
  assert.equal(await saving.evaluate((element) => !!element.closest('[aria-disabled="true"]')), true);
  await saving.click({ force: true });
  assert.equal(await page.getByText('CI question 1', { exact: true }).count(), 1);
  assert.equal(cards.cards[0].history.length, 0);
  firstWrite.succeed();
  await page.getByText('下一张', { exact: true }).click();
  await page.getByText('CI question 2', { exact: true }).waitFor();
  assert.equal(cards.cards[0].history.length, 1);
  const reviewedAt = new Date(cards.cards[0].history[0].time);
  const firstDue = new Date(Date.UTC(reviewedAt.getUTCFullYear(), reviewedAt.getUTCMonth(), reviewedAt.getUTCDate() + 1, 16));
  assert.equal(cards.cards[0].nextReview, firstDue.toISOString());
  await page.getByText('CI answer 2', { exact: true }).click();
  (await waitForWrite(2)).fail();
  await page.getByText('重试', { exact: true }).click();
  await page.getByText('重试', { exact: true }).waitFor({ state: 'detached' });
  await page.getByText('CI answer 2', { exact: true }).click();
  const retryWrite = await waitForWrite(3);
  assert.equal(retryWrite.value.cards[0].history.length, 1, 'Retry must preserve the earlier saved answer');
  assert.equal(retryWrite.value.cards[1].history.length, 1, 'Retry must not duplicate a failed answer');
  retryWrite.succeed();
  await page.getByText('完成', { exact: true }).click();
  await page.getByText('今天的复习', { exact: false }).waitFor();
  await page.screenshot({ path: path.join(artifacts, 'flashcard-review.png') });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByText('刷新', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifacts, 'settings.png') });
  await page.getByText('退出', { exact: true }).click();
  await page.getByLabel('邮箱', { exact: true }).waitFor();
  assert.deepEqual(errors, [], 'The shared learning UI must not crash in a mobile browser');
  await context.close();
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
