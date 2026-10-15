import assert from "node:assert/strict";

/** Exercise the real note scroller, including keyboard input and a viewport resize. */
export async function assertStoryScrollEdges(page) {
  const selector = ".story-point-note-sheet__body";
  const body = page.locator(selector);
  const check = async () => {
    await page.waitForFunction((selector) => {
      const node = document.querySelector(selector);
      if (!node) return false;
      const maximum = Math.max(0, node.scrollHeight - node.clientHeight);
      const position = Math.max(0, Math.min(maximum, node.scrollTop));
      const before = maximum > 1 && position > 1;
      const after = maximum > 1 && maximum - position > 1;
      return node.dataset.scrollBefore === String(before) && node.dataset.scrollAfter === String(after);
    }, selector, { polling: "raf", timeout: 3_000 });
    return body.evaluate((node) => ({
      before: node.dataset.scrollBefore, after: node.dataset.scrollAfter,
      top: node.scrollTop, maximum: Math.max(0, node.scrollHeight - node.clientHeight),
      mask: getComputedStyle(node).maskImage,
    }));
  };
  await body.focus();
  await page.keyboard.press("Home");
  const start = await check();
  assert.equal(start.before, "false", "Start of note must not suggest hidden earlier text");
  assert.equal(start.mask, "none", "Scroll cues must not mask the author's text");
  await page.keyboard.press("End");
  if (start.maximum > 1) await page.waitForFunction((selector) => {
    const node = document.querySelector(selector);
    return node && node.scrollHeight - node.clientHeight - node.scrollTop <= 1;
  }, selector, { polling: "raf", timeout: 3_000 });
  const end = await check();
  assert.equal(end.after, "false", "The bottom cue must clear at the last line");
  const viewport = page.viewportSize();
  if (viewport) {
    await page.setViewportSize({ ...viewport, height: viewport.height + 24 });
    await check();
    await page.setViewportSize(viewport);
    await check();
  }
  await body.focus();
  await page.keyboard.press("Home");
  if (start.maximum > 1) await page.waitForFunction((selector) => (document.querySelector(selector)?.scrollTop ?? 1) <= 1,
    selector, { polling: "raf", timeout: 3_000 });
  await check();
  console.log(JSON.stringify({ name: "story-note-scroll-edges", viewport, start, end }));
}
