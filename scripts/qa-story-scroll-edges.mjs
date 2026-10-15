import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import sharp from "sharp";

const SELECTOR = ".story-point-note-sheet__body";
const EXPECTED = {
  top: { before: "false", after: "true" },
  middle: { before: "true", after: "true" },
  bottom: { before: "true", after: "false" },
  fits: { before: "false", after: "false" },
};

async function readState(page, text) {
  return page.locator(SELECTOR).evaluate((body, expectedText) => {
    const style = getComputedStyle(body);
    const rect = body.getBoundingClientRect();
    const note = body.querySelector(".story-point-note-sheet__text");
    return {
      before: body.dataset.scrollBefore, after: body.dataset.scrollAfter,
      top: body.scrollTop, maximum: Math.max(0, body.scrollHeight - body.clientHeight),
      clientHeight: body.clientHeight, scrollHeight: body.scrollHeight,
      textHeight: note?.getBoundingClientRect().height ?? 0,
      textMatches: note?.textContent === expectedText,
      viewport: { width: innerWidth, height: innerHeight },
      rect: { top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height },
      focused: document.activeElement === body,
      forced: matchMedia("(forced-colors: active)").matches,
      topWidth: style.borderTopWidth, bottomWidth: style.borderBottomWidth,
      mask: style.maskImage, background: style.backgroundImage,
      beforeInk: style.getPropertyValue("--scroll-edge-before").trim(),
      afterInk: style.getPropertyValue("--scroll-edge-after").trim(),
      media: document.querySelector('.journey-story__media [data-media-presented="true"]')?.getAttribute("data-media-presentation-id"),
    };
  }, text);
}

async function expectState(page, text, state, phase, forced = false) {
  const expected = EXPECTED[state];
  assert.ok(expected, `Unknown scroll expectation: ${state}`);
  try {
    // The expected state is chosen by the scenario, never inferred from the DOM.
    await page.waitForFunction(({ selector, state, expected, forced }) => {
      const body = document.querySelector(selector);
      if (!body || body.clientHeight <= 0) return false;
      const maximum = Math.max(0, body.scrollHeight - body.clientHeight);
      const geometry = state === "fits" ? maximum <= 1 && body.scrollTop <= 1
        : maximum > 1 && (state === "top" ? body.scrollTop <= 1
          : state === "bottom" ? maximum - body.scrollTop <= 1
            : body.scrollTop > 1 && maximum - body.scrollTop > 1);
      const style = getComputedStyle(body);
      const colorMode = matchMedia("(forced-colors: active)").matches === forced;
      const edgeWidths = !forced || (style.borderTopWidth === (expected.before === "true" ? "1px" : "0px")
        && style.borderBottomWidth === (expected.after === "true" ? "1px" : "0px"));
      return geometry && colorMode && edgeWidths
        && body.dataset.scrollBefore === expected.before && body.dataset.scrollAfter === expected.after;
    }, { selector: SELECTOR, state, expected, forced }, { polling: "raf", timeout: 3_000 });
    const actual = await readState(page, text);
    assert.equal(actual.textMatches, true, `${phase}: render the exact fixed note, not another fixture`);
    assert.ok(actual.clientHeight > 20 && actual.rect.top < actual.viewport.height && actual.rect.bottom > 0,
      `${phase}: the actual note scroller must be visible and nonempty`);
    assert.equal(actual.mask, "none", `${phase}: cues must not mask the author's text`);
    assert.equal(actual.forced, forced, `${phase}: test the explicitly requested color mode`);
    if (forced) {
      assert.equal(actual.topWidth, expected.before === "true" ? "1px" : "0px", `${phase}: inactive top cannot draw`);
      assert.equal(actual.bottomWidth, expected.after === "true" ? "1px" : "0px", `${phase}: inactive bottom cannot draw`);
    } else {
      assert.notEqual(actual.background, "none", `${phase}: the real scroll-cue stylesheet must be applied`);
      const clear = (ink) => ink === "transparent" || ink === "rgba(0, 0, 0, 0)";
      assert.equal(clear(actual.beforeInk), expected.before === "false", `${phase}: top cue paint must follow its state`);
      assert.equal(clear(actual.afterInk), expected.after === "false", `${phase}: bottom cue paint must follow its state`);
    }
    return { phase, state, ...actual };
  } catch (error) {
    const actual = await readState(page, text).catch((readError) => ({ readError: String(readError) }));
    throw new Error(`[scroll-edges/${phase}] expected ${state} ${JSON.stringify(expected)}; actual ${JSON.stringify(actual)}`,
      { cause: error });
  }
}

/** Native scrolling produces real browser scroll events; no geometry, flags,
 * text, CSS, or observer functions are mocked or assigned by these helpers. */
async function scrollTo(page, position) {
  await page.locator(SELECTOR).evaluate((body, position) => {
    const maximum = Math.max(0, body.scrollHeight - body.clientHeight);
    const top = position === "top" ? 0 : position === "middle" ? maximum / 2 : maximum;
    body.scrollTo({ top, behavior: "instant" });
  }, position);
}

async function assertForcedNotePixels(page, { text, scenario, overflow }) {
  const output = "artifacts/story-media/note-scroll-edges";
  await mkdir(output, { recursive: true });
  const states = [];
  const check = async (state, phase) => {
    const measured = await expectState(page, text, state, `${scenario}/${phase}`, true);
    const box = await page.locator(SELECTOR).boundingBox();
    assert.ok(box && box.width > 8 && box.height > 8);
    const expected = EXPECTED[state];
    const pixels = {};
    for (const edge of ["before", "after"]) {
      // Existing inline padding is text-free even while the note is scrolled.
      const top = edge === "before";
      // Include both raster rows intersected by a fractional 1px border.
      // ceil(top) skipped the upper row; floor(bottom)-1 skipped the lower.
      const y = top ? Math.floor(box.y) : Math.floor(box.y + box.height) - 2;
      const image = await page.screenshot({path:`${output}/${scenario}-${phase}-${edge}.png`,
        clip:{x:Math.ceil(box.x)+2,y,width:1,height:3}});
      const {data,info} = await sharp(image).removeAlpha().raw().toBuffer({resolveWithObject:true});
      const color = row => [...data.subarray(row*info.channels,row*info.channels+3)];
      const ink = (top ? [0, 1] : [1, 2]).map(color), base = color(top ? 2 : 0);
      const difference = Math.max(...ink.map(pixel => pixel.reduce((sum,value,index)=>sum+Math.abs(value-base[index]),0)));
      // Inactive means BOTH possible border rows are clear. Active still
      // requires the original minimum contrast; no threshold is relaxed.
      assert.ok(expected[edge] === "true" ? difference >= 20 : difference <= 3,
        `${scenario}/${phase}/${edge}: visible border pixels ${JSON.stringify(ink)} vs padding ${base}, difference=${difference}; rect=${JSON.stringify(box)}`);
      pixels[edge] = {ink,base,difference,rect:box};
    }
    states.push({...measured,pixels});
  };
  await page.locator(".story-point-note-sheet__close").focus();
  await page.emulateMedia({forcedColors:"active"});
  try {
    await check(overflow ? "top" : "fits", "forced-initial");
    if (overflow) {
      await scrollTo(page, "middle");
      await check("middle", "forced-middle");
      await scrollTo(page, "bottom");
      await check("bottom", "forced-bottom");
      await scrollTo(page, "top");
      await check("top", "forced-return-top");
    } else {
      await scrollTo(page, "bottom");
      await check("fits", "forced-fits-after-scroll");
    }
  } catch (error) {
    await page.screenshot({path:`${output}/${scenario}-failure-full.png`});
    throw error;
  } finally { await page.emulateMedia({forcedColors:"none"}); }
  states.push(await expectState(page,text,overflow ? "top" : "fits",`${scenario}/restore-colors`));
  return states;
}

/** A fixed long note MUST overflow; a separate short note MUST NOT overflow. */
export async function assertStoryScrollEdges(page, { text, scenario, overflow, pointer }) {
  assert.equal(typeof overflow, "boolean", "Every fixture declares its expected overflow before it runs");
  const states = [];
  const first = await expectState(page, text, overflow ? "top" : "fits", `${scenario}/initial`);
  states.push(first);
  if (!overflow) {
    assert.ok(first.textHeight + 8 <= first.clientHeight, `${scenario}: short text must fit with its padding`);
    // A native attempt to scroll cannot invent an edge on the short note.
    await scrollTo(page, "bottom");
    states.push(await expectState(page, text, "fits", `${scenario}/unscrollable-bottom`));
    await scrollTo(page, "top");
    states.push(await expectState(page, text, "fits", `${scenario}/unscrollable-top`));
    states.push(...await assertForcedNotePixels(page, {text,scenario,overflow}));
    return states;
  }
  assert.ok(first.maximum >= 80, `${scenario}: the long fixture must have meaningful overflow, not silently skip scrolling`);
  await scrollTo(page, "middle");
  states.push(await expectState(page, text, "middle", `${scenario}/middle-both-cues`));
  await scrollTo(page, "bottom");
  states.push(await expectState(page, text, "bottom", `${scenario}/bottom-hides-after`));
  await scrollTo(page, "top");
  states.push(await expectState(page, text, "top", `${scenario}/return-top-hides-before`));

  if (pointer.kind === "touch") {
    // Mobile input is a real finger gesture, not an assumption that emulated
    // phone Chrome implements the desktop Home/End default actions.
    const box = await page.locator(SELECTOR).boundingBox();
    assert.ok(box && box.height > 80, `${scenario}: touch scroll needs a usable visible aperture`);
    const x = box.x + box.width / 2;
    const y = Math.min(box.y + box.height * .7, page.viewportSize().height - 16);
    await page.locator(SELECTOR).evaluate(body => {
      window.__noteScrollEnded = false;
      window.__noteScrollEndTarget = body;
      window.__noteScrollListener = () => { window.__noteScrollEnded = false; };
      window.__noteScrollEndListener = () => { window.__noteScrollEnded = true; };
      body.addEventListener("scroll", window.__noteScrollListener, {passive:true});
      body.addEventListener("scrollend", window.__noteScrollEndListener);
    });
    await pointer.down(x, y);
    try {
      for (let step = 1; step <= 8; step += 1) {
        await pointer.move(x, y - step * 6);
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      }
      states.push(await expectState(page, text, "middle", `${scenario}/touch-moves-real-content`));
    } finally { await pointer.up(); }
    try {
      // TouchEnd dispatch can precede the compositor's last scroll delta.
      // Do not issue a conflicting scrollTo until this real gesture has ended.
      await page.waitForFunction(() => window.__noteScrollEnded === true, null, {polling:"raf",timeout:3_000});
    } finally {
      await page.evaluate(() => {
        window.__noteScrollEndTarget?.removeEventListener("scrollend", window.__noteScrollEndListener);
        window.__noteScrollEndTarget?.removeEventListener("scroll", window.__noteScrollListener);
        delete window.__noteScrollListener;
        delete window.__noteScrollEndTarget;
        delete window.__noteScrollEndListener;
        delete window.__noteScrollEnded;
      });
    }
  } else {
    // Retain desktop keyboard coverage alongside exact native boundary checks.
    await page.locator(SELECTOR).focus();
    assert.equal((await readState(page, text)).focused, true, `${scenario}: keyboard input belongs to the note`);
    await page.keyboard.press("End");
    states.push(await expectState(page, text, "bottom", `${scenario}/keyboard-end`));
    await page.keyboard.press("Home");
    states.push(await expectState(page, text, "top", `${scenario}/keyboard-home`));
  }
  await scrollTo(page, "top");
  states.push(await expectState(page, text, "top", `${scenario}/input-cleanup`));
  states.push(...await assertForcedNotePixels(page, {text,scenario,overflow}));
  assert.ok(states.every((state) => state.media === first.media), `${scenario}: scrolling never navigates the media`);
  return states;
}

/** Cross the real overflow threshold while retaining the SAME scroller and text.
 * Both same-width height changes and portrait/landscape rotation must change cues. */
export async function assertStoryScrollResize(page, { text, scenario, portrait, landscape }) {
  assert.deepEqual(page.viewportSize(), portrait, "Resize fixture starts at its declared portrait size");
  const original = await page.locator(SELECTOR).elementHandle();
  assert.ok(original, "The note scroller exists before resizing");
  const states = [];
  const capture = async (state, phase) => {
    assert.equal(await original.evaluate((body, selector) => body.isConnected && body === document.querySelector(selector), SELECTOR),
      true, `${scenario}/${phase}: resize must not remount the scroller`);
    const result = await expectState(page, text, state, `${scenario}/${phase}`);
    states.push(result);
    return result;
  };
  try {
    const fitted = await capture("fits", "portrait-fits");
    assert.ok(fitted.textHeight + 8 <= fitted.clientHeight, `${scenario}: the medium note fits the tall viewport`);
    const compact = { width: portrait.width, height: 400 };
    await page.setViewportSize(compact);
    const shorter = await capture("top", "height-shrink-shows-after");
    assert.ok(shorter.maximum >= 16 && fitted.clientHeight - shorter.clientHeight >= 16,
      `${scenario}: shrinking height must genuinely cross the overflow boundary`);
    await scrollTo(page, "bottom");
    await capture("bottom", "height-shrink-bottom-shows-before");
    await page.setViewportSize(portrait);
    await capture("fits", "height-grow-clears-both");
    await page.setViewportSize(landscape);
    const rotated = await capture("top", "landscape-shows-after");
    assert.ok(rotated.maximum >= 16, `${scenario}: landscape must actually overflow`);
    assert.ok(rotated.viewport.width > rotated.viewport.height, `${scenario}: landscape is real, not just a label`);
    await scrollTo(page, "middle");
    await capture("middle", "landscape-middle-both-cues");
    await scrollTo(page, "bottom");
    await capture("bottom", "landscape-bottom-hides-after");
    await page.setViewportSize(portrait);
    await capture("fits", "rotate-back-clears-both");
    // Repeating the boundary checks that the first resize did not detach observation.
    await page.setViewportSize(landscape);
    await capture("top", "landscape-again-shows-after");
    await page.setViewportSize(portrait);
    await capture("fits", "portrait-again-clears-both");
    assert.ok(states.every((state) => state.media === fitted.media), `${scenario}: resizing never changes the media owner`);
    return states;
  } finally {
    await original.dispose();
    await page.setViewportSize(portrait);
  }
}
