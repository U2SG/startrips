import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { encodeCloneFrameStamp, decodeCloneFrameStamp } from "./qa-clone-frame-stamp.mjs";

/** Runs in the page. The stamp and the layout-only morph share a paint, not a clock. */
export function installCloneScreenProbe({ name, stationary, runId }, encode) {
  const marker = document.createElement("canvas");
  marker.width = 128; marker.height = 4;
  marker.setAttribute("aria-hidden", "true");
  marker.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;visibility:hidden;width:128px;height:4px";
  const context = marker.getContext("2d");
  const probe = { name, runId, observations: [], events: [], bitmap: null,
    running: true, fatal: null, clone: null, raf: null, observer: null };
  window.__qaCloneScreen = probe;
  const now = () => performance.timeOrigin + performance.now();
  const clear = () => { marker.style.visibility = "hidden"; };
  const fail = (reason) => { probe.fatal ??= reason; clear(); };
  if (!context || window.top !== window || devicePixelRatio !== 1 || visualViewport?.scale !== 1) {
    fail("clone frame witness requires a top-level, unscaled deviceScaleFactor=1 viewport");
  }
  document.body.append(marker);
  const sample = () => {
    clear();
    if (!probe.running || probe.fatal) return;
    const clones = [...document.querySelectorAll("[data-shared-element-clone]")];
    if (!clones.length) return;
    const clone = clones[0];
    if (clones.length !== 1 || !(clone instanceof HTMLCanvasElement)
      || clone.getAttribute("data-shared-element-clone") !== name) {
      fail("wrong, extra or non-canvas clone"); return;
    }
    if (probe.clone && probe.clone !== clone) { fail("clone generation changed"); return; }
    if (!probe.clone) {
      probe.clone = clone;
      probe.bitmap = document.createElement("canvas");
      probe.bitmap.width = clone.width; probe.bitmap.height = clone.height;
      const bitmapContext = probe.bitmap.getContext("2d");
      if (!bitmapContext) { fail("clone bitmap context unavailable"); return; }
      bitmapContext.drawImage(clone, 0, 0);
      probe.events.push({ kind: "attached", at: now(), name });
    }
    for (let node = clone; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if ([style.transform, style.translate, style.rotate, style.scale].some((value) => value && value !== "none")) {
        fail("transformed clone or ancestor cannot share this layout-frame witness"); return;
      }
    }
    const animations = clone.getAnimations();
    const animation = animations.find((entry) => entry.effect?.target === clone);
    const duration = animation?.effect?.getTiming().duration;
    const progress = typeof duration === "number" && duration > 0 && typeof animation.currentTime === "number"
      ? animation.currentTime / duration : null;
    // Stationary means the reduced-motion snapshot is still attached, with no
    // animation; it never means an already-settled destination is eligible.
    if (stationary ? animations.length !== 0
      : animations.length !== 1 || !animation || animation.playState !== "running"
        || !Number.isFinite(progress) || progress < 0.25 || progress > 0.65) return;
    if (animation && animation.effect.getKeyframes().some((frame) => Object.keys(frame)
      .some((key) => !["offset", "computedOffset", "easing", "composite", "left", "top", "width", "height", "borderRadius",
        "borderTopLeftRadius", "borderTopRightRadius", "borderBottomLeftRadius", "borderBottomRightRadius"].includes(key)))) {
      fail("clone animation is not the observed layout-only morph"); return;
    }
    const rect = clone.getBoundingClientRect();
    const box = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    const width = innerWidth, height = innerHeight;
    if (!(box.width > 0 && box.height > 0) || devicePixelRatio !== 1 || visualViewport?.scale !== 1) return;
    const position = [{ x: 0, y: 0 }, { x: width - 128, y: 0 },
      { x: 0, y: height - 4 }, { x: width - 128, y: height - 4 }].find(({ x, y }) =>
      x >= 0 && y >= 0 && x + 128 <= width && y + 4 <= height
        && (x + 128 < box.x || x > box.x + box.width
        || y + 4 < box.y || y > box.y + box.height));
    if (!position) return; // Never cover even one pixel of the measured media.
    const id = probe.observations.length;
    if (id > 65535) { fail("clone witness observation capacity exceeded"); return; }
    const bits = encode(runId, id);
    bits.forEach((bit, index) => {
      context.fillStyle = bit ? "#fff" : "#000";
      context.fillRect(index * 2, 0, 2, 4);
    });
    marker.style.left = `${position.x}px`; marker.style.top = `${position.y}px`;
    probe.observations.push({ id, at: now(), name, generation: 1, progress, stationary,
      box, position: { ...position, width: 128, height: 4 }, viewport: { width, height } });
    marker.style.visibility = "visible";
  };
  const tick = () => { sample(); if (probe.running) probe.raf = requestAnimationFrame(tick); };
  probe.observer = new MutationObserver((records) => {
    const relevant = records.some((record) => record.type === "attributes"
      || [...record.addedNodes, ...record.removedNodes].some((node) => node instanceof Element
        && (node.matches("[data-shared-element-clone]") || node.querySelector("[data-shared-element-clone]"))));
    if (!relevant) return; // Ignore the witness's own canvas/style writes.
    // MutationObserver runs at the microtask checkpoint before the next paint.
    // Old stamped PNGs remain valid; later paints cannot retain a removed stamp.
    clear();
    if (probe.clone && !probe.clone.isConnected) probe.events.push({ kind: "detached", at: now() });
    sample();
  });
  probe.observer.observe(document.body, { subtree: true, childList: true,
    attributes: true, attributeFilter: ["data-shared-element-clone"] });
  probe.stop = () => {
    probe.running = false; cancelAnimationFrame(probe.raf); probe.observer.disconnect(); marker.remove();
  };
  tick();
}

/** Pre-arm before input. CDP metadata.timestamp in Chrome 154 is NOT capture time. */
export async function beginCloneScreenCapture(page, assetId, { stationary = false, artifact } = {}) {
  const runId = randomBytes(4).readUInt32BE();
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  const acknowledgements = new Set();
  let selected = null, lastPng = null, error = null, stopped = false, queue = Promise.resolve();
  let resolveFrame;
  const ready = new Promise((resolve) => { resolveFrame = resolve; });
  const receive = (frame) => {
    const acknowledgement = cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId })
      .catch((cause) => { error ??= String(cause); });
    acknowledgements.add(acknowledgement);
    void acknowledgement.finally(() => acknowledgements.delete(acknowledgement));
    const row = { receivedAt: Date.now(), metadata: frame.metadata, matches: [] };
    frames.push(row);
    queue = queue.then(async () => {
      if (selected) return;
      const png = Buffer.from(frame.data, "base64");
      lastPng = png;
      const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
      row.size = { width: info.width, height: info.height };
      row.matches = decodeCloneFrameStamp({ data, ...info }, runId);
      if (!row.matches.length) return;
      // Choose by delivery order BEFORE evaluating any media pixels. Multiple
      // markers fail closed; no search for a later image with a passing picture.
      selected = { png, row, stamp: row.matches[0], ambiguous: row.matches.length !== 1 };
      resolveFrame(selected);
    }).catch((cause) => { error ??= String(cause); resolveFrame(null); });
  };
  const dispose = async () => {
    if (stopped) return;
    stopped = true;
    await cdp.send("Page.stopScreencast").catch((cause) => { error ??= String(cause); });
    cdp.off("Page.screencastFrame", receive);
    await queue;
    await Promise.all(acknowledgements);
    await page.evaluate(() => window.__qaCloneScreen?.stop()).catch(() => {});
    await cdp.detach().catch(() => {});
  };
  try {
    await page.evaluate(`(${installCloneScreenProbe.toString()})(${JSON.stringify({
      name: `story-fullscreen-${assetId}`, stationary, runId,
    })}, (${encodeCloneFrameStamp.toString()}))`);
    cdp.on("Page.screencastFrame", receive);
    const viewport = page.viewportSize();
    await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1,
      maxWidth: viewport.width, maxHeight: viewport.height });
  } catch (cause) { await dispose(); throw cause; }
  return {
    dispose,
    async frame() {
      let timer;
      try { await Promise.race([ready, new Promise((resolve) => { timer = setTimeout(resolve, 9_000); })]); }
      finally { clearTimeout(timer); }
      await dispose();
      const probe = await page.evaluate(() => {
        const { observations, events, fatal } = window.__qaCloneScreen;
        return { observations, events, fatal };
      });
      const observation = selected && probe.observations[selected.stamp.observationId];
      const failed = Boolean(error || probe.fatal || !selected || selected.ambiguous || !observation
        || ["x", "y", "width", "height"].some((key) => observation.position[key] !== selected.stamp.position[key])
        || observation.viewport.width !== selected.row.size.width || observation.viewport.height !== selected.row.size.height
        || selected.row.metadata.pageScaleFactor !== 1);
      const diagnostic = { failed, error, runId, ...probe, frames, selected: selected ? {
        stamp: selected.stamp, receivedAt: selected.row.receivedAt, metadata: selected.row.metadata,
      } : null, observation };
      if (artifact) {
        await mkdir("artifacts/story-media", { recursive: true });
        const path = `artifacts/story-media/${artifact}-clone-screen`;
        await writeFile(`${path}.json`, JSON.stringify(diagnostic, null, 2));
        if (selected?.png ?? lastPng) {
          await writeFile(`${path}.png`, selected?.png ?? lastPng);
          diagnostic.artifact = `${path}.png`;
        }
      }
      return { ...diagnostic, png: selected?.png.toString("base64") ?? null };
    },
  };
}
