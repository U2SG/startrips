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
let expireSession = false;
const studyBase = 'project-data/accounts/local/profiles/default/worlds/ci-world';
let importedBook = null;
let activeSelection = null;
let activeVersion = 0;
let importFailure = true;
const uploads = [];
const listeningFiles = new Map();
const narrations = [];
let listeningWrites = 0;
const wav = Buffer.alloc(44 + 8000 * 2 * 8);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
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
  const authenticated = !expireSession && request.headers.cookie?.includes('ci-study=1');
  function json(status, value) { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); }
  if (url.pathname === '/ci-book.wav') { response.writeHead(200, { 'Content-Type': 'audio/wav' }); response.end(wav); return; }
  if (url.pathname === '/api/auth/sign-in/email') {
    response.setHeader('Set-Cookie', 'ci-study=1; HttpOnly; SameSite=Lax; Path=/');
    return json(200, {});
  }
  if (url.pathname === '/api/auth/sign-out') {
    response.setHeader('Set-Cookie', 'ci-study=; Max-Age=0; Path=/');
    return json(200, {});
  }
  if (url.pathname.startsWith('/api/soc/')) {
    if (!authenticated && url.pathname.endsWith('/session')) {
      // Real connections may deliver headers before the anonymous JSON body.
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.flushHeaders();
      const timer = setTimeout(() => response.end(JSON.stringify({ error: 'AUTH_REQUIRED' })), 200);
      response.once('close', () => clearTimeout(timer));
      return;
    }
    if (!authenticated) return json(401, { error: 'AUTH_REQUIRED' });
    if (url.pathname.endsWith('/session')) return json(200, { user: { id: 'ci-study', name: 'Study', email: 'study@example.test' } });
    if (url.pathname.endsWith('/ping')) return json(200, { ok: true, root: '' });
    if (url.pathname.endsWith('/models')) return json(200, { active: '', profiles: [] });
    if (url.pathname.endsWith('/textbooks/import')) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      uploads.push({ name: url.searchParams.get('name'), world: url.searchParams.get('world'), body: Buffer.concat(chunks) });
      if (importFailure) return json(400, { error: 'STUDY_EPUB_INVALID', message: 'EPUB 文件损坏，请重新选择' });
      importedBook = { id: 'phone-book', title: '手机教材', fileName: 'source.epub', format: 'epub', numPages: 2, currentPage: 0 };
      return json(201, importedBook);
    }
    if (url.pathname.endsWith('/list')) {
      const relative = url.searchParams.get('path');
      return json(200, { entries: relative?.endsWith('/flashcards') ? [{ name: 'book.json', dir: false, size: 0, mtime: 0 }]
        : relative?.endsWith('/worlds') ? [{ name: 'ci-world', dir: true, size: 0, mtime: 0 }]
        : relative?.endsWith('/textbooks/phone-book') ? [{ name: 'source.epub', dir: false, size: 0, mtime: 0 }] : [] });
    }
    if (url.pathname.endsWith('/extract')) {
      const number = Number(url.searchParams.get('start'));
      return json(200, { numPages: 2, sourceSig: 'ci-book-source', pages: [{ page: number, text: number === 1 ? '第一段原文。\n”\n第二段原文！' : '第二页原文。最后一段。' }] });
    }
    if (url.pathname.endsWith('/file')) {
      const relative = url.searchParams.get('path');
      if (relative?.includes('/listening-')) {
        if (request.method === 'PUT') {
          let text = ''; for await (const chunk of request) text += chunk;
          listeningFiles.set(relative, JSON.parse(text)); listeningWrites++;
          response.setHeader('ETag', `"listening-${listeningWrites}"`); return json(200, { ok: true });
        }
        if (!listeningFiles.has(relative)) return json(404, { error: 'STUDY_FILE_NOT_FOUND' });
        response.setHeader('ETag', `"listening-${listeningWrites}"`); return json(200, listeningFiles.get(relative));
      }
      if (relative?.endsWith('/worlds/active.json')) {
        if (request.method === 'PUT') {
          let text = ''; for await (const chunk of request) text += chunk;
          activeSelection = JSON.parse(text); activeVersion++;
          response.setHeader('ETag', `"active-${activeVersion}"`); return json(200, { ok: true });
        }
        if (!activeSelection) return json(404, { error: 'STUDY_FILE_NOT_FOUND' });
        response.setHeader('ETag', `"active-${activeVersion}"`); return json(200, activeSelection);
      }
      if (relative?.endsWith('/world_meta.json')) return json(200, { worldId: 'ci-world', name: '学习', companions: [] });
      if (relative?.endsWith('/textbook_index.json')) return json(200, { worldId: 'ci-world', updatedAt: '', textbooks: importedBook ? [importedBook] : [] });
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
    if (url.pathname.endsWith('/voice')) {
      if (request.method === 'POST') { let text = ''; for await (const chunk of request) text += chunk; narrations.push(JSON.parse(text)); }
      return json(200, request.method === 'POST' ? { url: `http://${request.headers.host}/ci-book.wav` } : { available: true });
    }
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
  // A phone must reach and use the app even while every CJK font is unavailable.
  for (const mode of ['pending', 'failed']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const errors = [];
    const releaseFonts = [];
    let fontRequests = 0;
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*.ttf', async (route) => {
      fontRequests++;
      if (mode === 'pending') await new Promise((resolve) => releaseFonts.push(resolve));
      await route.abort();
    });
    try {
      await page.goto(`http://127.0.0.1:${address.port}/soc/`, { waitUntil: 'domcontentloaded' });
      await page.getByLabel('邮箱', { exact: true }).waitFor({ timeout: 8000 });
      await page.getByTestId('soc-splash').waitFor({ state: 'detached', timeout: 8000 });
      assert.equal(await page.getByRole('alert').count(), 0, 'Anonymous sign-in must not report a connection error');
      assert.ok(fontRequests > 0, 'The regression must intercept actual font downloads');
      assert.equal(await page.evaluate(() => document.fonts.check('16px NotoSansSC_400Regular')), false);
      await page.getByLabel('邮箱', { exact: true }).fill('study@example.test');
      await page.getByLabel('密码', { exact: true }).fill('ci-only-password');
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await page.getByRole('button', { name: '教材', exact: true }).waitFor({ timeout: 8000 });
      await page.getByText('准备上课', { exact: true }).waitFor();
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByText('刷新', { exact: true }).waitFor();
      // Playwright screenshots wait for fonts; CDP captures the visible fallback.
      const cdp = await context.newCDPSession(page);
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      await fs.writeFile(path.join(artifacts, `fonts-${mode}.png`), Buffer.from(data, 'base64'));
      await cdp.detach();
      assert.deepEqual(errors, [], `Font ${mode} must not crash the app`);
    } finally {
      releaseFonts.forEach((release) => release());
      await page.unrouteAll({ behavior: 'wait' });
      await context.close();
    }
  }
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/soc/`);
  await page.getByLabel('邮箱', { exact: true }).waitFor({ timeout: 60000 });
  await page.getByTestId('soc-splash').waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('alert').count(), 0, 'A delayed anonymous 401 body must remain readable');
  await page.screenshot({ path: path.join(artifacts, 'sign-in.png') });
  await page.getByLabel('邮箱', { exact: true }).fill('study@example.test');
  await page.getByLabel('密码', { exact: true }).fill('ci-only-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '教材', exact: true }).waitFor();
  await page.getByText('准备上课', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('访问令牌', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '教材', exact: true }).click();
  const uploadButton = page.getByRole('button', { name: '上传教材', exact: true });
  const payload = Buffer.from('CI phone EPUB bytes');
  const selectBook = async () => {
    await uploadButton.waitFor();
    await page.waitForFunction(() => !document.querySelector('[aria-label="上传教材"]')?.getAttribute('aria-disabled'));
    const chooser = page.waitForEvent('filechooser');
    await uploadButton.click();
    await (await chooser).setFiles({ name: '手机教材.epub', mimeType: 'application/epub+zip', buffer: payload });
  };
  await selectBook();
  await page.getByText('EPUB 文件损坏，请重新选择', { exact: true }).waitFor();
  importFailure = false;
  await selectBook();
  await page.getByText('上传并解析教材…', { exact: true }).waitFor({ state: 'detached' });
  await page.getByText('《手机教材》', { exact: true }).waitFor();
  await page.getByRole('button', { name: '教材', exact: true }).click();
  await page.getByText('手机教材', { exact: true }).waitFor();
  assert.equal(uploads.length, 2);
  assert.equal(uploads[1].world, studyBase);
  assert.equal(uploads[1].name, '手机教材.epub');
  assert.deepEqual(uploads[1].body, payload, 'Phone selection must upload the original binary bytes');
  await page.screenshot({ path: path.join(artifacts, 'textbook-upload.png') });
  await page.getByRole('button', { name: '听书：手机教材', exact: true }).click();
  await page.getByTestId('listening-reader').waitFor();
  await page.getByRole('button', { name: '从第 2 段朗读', exact: true }).waitFor();
  await page.getByRole('button', { name: '从第 2 段朗读', exact: true }).click();
  await page.getByRole('button', { name: '暂停听书', exact: true }).waitFor();
  await page.waitForFunction(() => Number(document.querySelector('[aria-label="本句播放进度"]')?.getAttribute('aria-valuenow')) >= 1);
  await page.getByRole('button', { name: '暂停听书', exact: true }).click();
  await page.getByRole('button', { name: '播放听书', exact: true }).waitFor();
  await page.getByRole('button', { name: '听书设置', exact: true }).click();
  await page.getByRole('radio', { name: '1.5 倍速', exact: true }).click();
  await page.getByRole('radio', { name: '30 分钟后停止', exact: true }).click();
  await page.screenshot({ path: path.join(artifacts, 'listening-reader.png') });
  await page.getByLabel('听书页码', { exact: true }).fill('2');
  await page.getByRole('button', { name: '跳转到页码', exact: true }).click();
  await page.getByText('第二页原文。', { exact: true }).waitFor();
  for (let attempt = 0; attempt < 100; attempt++) {
    const bookmark = [...listeningFiles.entries()].find(([name]) => name.endsWith('/listening-progress.json'))?.[1];
    if (bookmark?.page === 2 && bookmark.speed === 1.5) break;
    await page.waitForTimeout(50);
  }
  const checkpoint = [...listeningFiles.entries()].find(([name]) => name.endsWith('/listening-progress.json'))?.[1];
  assert.equal(checkpoint?.page, 2); assert.equal(checkpoint?.speed, 1.5);
  await page.getByRole('button', { name: '收起听书', exact: true }).click();
  await page.getByTestId('listening-mini').waitFor();
  // A full reload must restore the independent listening checkpoint, never lesson progress.
  await page.reload();
  await page.getByRole('button', { name: '教材', exact: true }).click();
  await page.getByRole('button', { name: '听书：手机教材', exact: true }).click();
  await page.getByText('第二页原文。', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('听书页码', { exact: true }).inputValue(), '2');
  await page.getByRole('button', { name: '听书设置', exact: true }).click();
  assert.equal(await page.getByRole('radio', { name: '1.5 倍速', exact: true }).getAttribute('aria-checked'), 'true');
  assert.ok(listeningWrites > 0);
  assert.ok(narrations.some((request) => request.text === '第二段原文！'), 'The actual TTS request must preserve the source phrase');
  await page.getByRole('button', { name: '收起听书', exact: true }).click();
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
  // Changing the narrator invalidates both loaded and prefetched speech without a reload.
  await page.getByRole('button', { name: '继续听书', exact: true }).click();
  await page.getByRole('button', { name: '暂停听书', exact: true }).waitFor();
  const beforeVoice = narrations.length;
  await page.getByRole('button', { name: '听书音色：旁白', exact: true }).click();
  await page.getByRole('radio', { name: '选择 Ryan', exact: true }).click();
  for (let attempt = 0; attempt < 100 && !narrations.slice(beforeVoice).some((request) => request.voice === 'Ryan'); attempt++) await page.waitForTimeout(50);
  if (!narrations.slice(beforeVoice).some((request) => request.voice === 'Ryan')) {
    await page.screenshot({ path: path.join(artifacts, 'voice-change-failure.png') });
    throw new Error(`Voice change did not regenerate speech: ${JSON.stringify({ requests: narrations.slice(beforeVoice), selected: await page.getByRole('radio', { name: '选择 Ryan', exact: true }).getAttribute('aria-checked'), text: await page.locator('body').innerText() })}`);
  }
  await page.getByText('完成', { exact: true }).click();
  await page.getByRole('button', { name: '展开听书', exact: true }).click();
  await page.getByRole('button', { name: '暂停听书', exact: true }).click();
  if (!await page.getByRole('button', { name: '离线下载', exact: true }).count()) await page.getByRole('button', { name: '听书设置', exact: true }).click();
  await page.getByRole('button', { name: '离线下载', exact: true }).click();
  await page.getByLabel('下载起始页', { exact: true }).fill('1');
  await page.getByLabel('下载结束页', { exact: true }).fill('2');
  await page.getByRole('button', { name: '开始下载', exact: true }).click();
  await page.getByText('第 2 / 2 页 · 2 / 2 段', { exact: true }).waitFor();
  await page.getByRole('button', { name: '开始下载', exact: true }).waitFor();
  assert.ok(narrations.every((request) => /[\p{L}\p{N}]/u.test(request.text)), 'Punctuation-only passages must never reach TTS');
  await page.getByRole('button', { name: '收起听书', exact: true }).click();
  await page.getByRole('button', { name: '离线书库', exact: true }).click();
  await page.getByText('2 / 2 页', { exact: true }).waitFor();
  let offlineApiCalls = 0;
  const blockOffline = async (route) => { offlineApiCalls++; await route.abort(); };
  await page.route('**/api/**', blockOffline);
  await context.setOffline(true);
  await page.getByRole('button', { name: '离线听：手机教材', exact: true }).click();
  await page.getByText('第二页原文。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '播放听书', exact: true }).click();
  await page.waitForFunction(() => Number(document.querySelector('[aria-label="本句播放进度"]')?.getAttribute('aria-valuenow')) >= 1);
  await page.getByRole('button', { name: '暂停听书', exact: true }).click();
  await page.screenshot({ path: path.join(artifacts, 'offline-listening.png') });
  assert.equal(offlineApiCalls, 0, 'Offline open, playback and checkpointing must use only local data');
  await context.setOffline(false);
  await page.unroute('**/api/**', blockOffline);
  await page.getByRole('button', { name: '收起听书', exact: true }).click();
  await page.getByRole('button', { name: '返回', exact: true }).click();
  // Reopen online before exercising server-session expiry.
  await page.getByRole('button', { name: '教材', exact: true }).click();
  await page.getByRole('button', { name: '听书：手机教材', exact: true }).click();
  await page.getByText('第二页原文。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '收起听书', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '继续听书', exact: true }).click();
  await page.getByRole('button', { name: '暂停听书', exact: true }).waitFor();
  expireSession = true;
  await page.getByText('刷新', { exact: true }).click();
  await page.getByLabel('邮箱', { exact: true }).waitFor();
  await page.getByRole('alert').waitFor();
  assert.equal(await page.getByTestId('listening-mini').count(), 0, 'Session expiry must remove the old book player');
  expireSession = false;
  await page.getByLabel('邮箱', { exact: true }).fill('study@example.test');
  await page.getByLabel('密码', { exact: true }).fill('ci-only-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByText('刷新', { exact: true }).waitFor();
  await page.getByText('退出', { exact: true }).click();
  await page.getByLabel('邮箱', { exact: true }).waitFor();
  assert.deepEqual(errors, [], 'The shared learning UI must not crash in a mobile browser');
  await context.close();
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
