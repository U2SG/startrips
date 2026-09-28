/** #489 R3: compare real production builds through the authorized owner entry.
 * Network fixtures contain public pictures and synthetic identities only.
 * This observes DOM writers and delivered animation frames; it is not a claim
 * about every display refresh or about an actual Android/Opera device.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
const baseline = process.env.QA_R3_MODE === "baseline";
const buildSha = process.env.QA_BUILD_SHA;
const harnessSha = process.env.QA_HARNESS_SHA;
if (!buildSha || !harnessSha) throw new Error("Exact build and harness SHAs are required");
const directory = "artifacts/story-autoplay-reproduction";
await mkdir(directory, { recursive: true });
const pictures = [
  "/artworks/china-handscroll.jpg", "/artworks/mughal-akbarnama.jpg",
  "/artworks/hokusai-wave.jpg", "/artworks/egypt-coffin.jpg",
  "/artworks/monet-water-lilies.jpg", "/artworks/woman-power-poster.jpg",
  "/artworks/stieglitz-hand-of-man.jpg", "/artworks/prehistoric-hands.jpg",
];
const ids = pictures.map((_, index) => `00000000-0000-4000-8000-${String(100 + index).padStart(12, "0")}`);
const journey = {
  id: "qa-r3-journey", atlasId: "qa-atlas", title: "R3 synthetic Journey",
  startedOn: "2026-08-20", endedOn: null, note: "Synthetic autoplay reproduction",
  lightColor: "#77c8c2", lightEffect: null, coverMediaAssetId: ids[0], revision: 1,
  createdByUserId: "qa-user", createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z",
  routePoints: [0, 1, 2].map((index) => ({
    id: `qa-r3-point-${index}`, journeyId: "qa-r3-journey", sortOrder: index,
    latitude: 22.5 + index, longitude: 114 + index, label: `Synthetic point ${index + 1}`,
    isStop: true, occurredAt: null, note: null, createdAt: "2026-08-20T00:00:00.000Z",
  })),
  media: ids.map((id, index) => ({
    id, journeyId: "qa-r3-journey", routePointId: `qa-r3-point-${index < 2 ? 0 : index < 6 ? 1 : 2}`,
    storageDriver: "qa", storageKey: `qa/r3-${index}.jpg`, fileName: `synthetic-${index + 1}.jpg`,
    mimeType: "image/jpeg", bytes: 200_000, sortOrder: index, uploadedByUserId: "qa-user",
    displayWidth: null, displayHeight: null, createdAt: "2026-08-20T00:10:00.000Z",
  })),
};
// The private recording is a foldable phone's inner display in desktop-site mode.
// CSS dimensions/DPR have not been measured on that phone. These two touch
// profiles bracket a wide device layout and desktop-site layout, plus a mouse
// control with the recording's pixel shape. No profile is labeled real-device.
const profiles = [
  { name: "desktop-control", viewport: { width: 1084, height: 1222 }, touch: false, dpr: 1, cpu: 1 },
  { name: "fold-wide-touch", viewport: { width: 800, height: 902 }, touch: true, dpr: 2.75, cpu: 4 },
  { name: "desktop-site-touch", viewport: { width: 980, height: 1105 }, touch: true, dpr: 2.75, cpu: 4 },
  { name: "desktop-site-large-images", viewport: { width: 980, height: 1105 }, touch: true, dpr: 2.75, cpu: 4, large: true },
];
const execute = promisify(execFile);
const largePictures = [];
await mkdir(`${directory}/fixtures`, { recursive: true });
for (const [index, picture] of pictures.entries()) {
  const path = `${directory}/fixtures/synthetic-${index + 1}.jpg`;
  await execute("ffmpeg", ["-v", "error", "-y", "-i", `public${picture}`, "-vf",
    "scale='if(gte(iw,ih),4096,-2)':'if(gte(iw,ih),-2,4096)'", "-frames:v", "1", "-q:v", "2", path]);
  const { stdout } = await execute("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", path]);
  const { width, height } = JSON.parse(stdout).streams[0];
  largePictures.push({ body: await readFile(path), width, height });
}
const browser = await launchQaBrowser({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const results = [];
const latch = () => { let resolve; const promise = new Promise((ready) => { resolve = ready; }); return { promise, resolve }; };

async function fixture(page, profile) {
  const reads = [], bytes = [];
  const readGate = latch(), byteGate = latch();
  const json = (route, body) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/auth/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/get-session")) return json(route, {
      session: { id: "qa-session", userId: "qa-user", activeOrganizationId: "qa-org", expiresAt: "2099-01-01T00:00:00.000Z" },
      user: { id: "qa-user", name: "QA User", email: "qa@example.com", emailVerified: true,
        createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z" },
    });
    if (path.endsWith("/organization/list")) return json(route, [{ id: "qa-org", name: "QA Atlas", slug: "qa-atlas" }]);
    return json(route, {});
  });
  await page.route("**/api/account-preferences/earth-experience", (route) => json(route, { earthExperience: "default", revision: 0, updatedAt: null }));
  await page.route("**/api/atlases/current", (route) => json(route, { atlas: { id: "qa-atlas", title: "QA Atlas", dedication: "Synthetic" }, role: "owner" }));
  const suppliedJourney = profile.large ? { ...journey, media: journey.media.map((asset, index) => ({
    ...asset, bytes: largePictures[index].body.length,
    displayWidth: largePictures[index].width, displayHeight: largePictures[index].height,
  })) } : journey;
  await page.route("**/api/journeys", (route) => json(route, { journeys: [suppliedJourney] }));
  await page.route("**/api/home-bases/dismissal", (route) => json(route, { dismissals: [] }));
  await page.route("**/api/home-bases", (route) => json(route, { periods: [] }));
  await page.route("**/api/everyday-fragments", (route) => json(route, { fragments: [] }));
  await page.route("**/api/uploads/assets/*/read-url", async (route) => {
    const id = /\/assets\/([^/]+)\/read-url/.exec(new URL(route.request().url()).pathname)?.[1];
    const index = ids.indexOf(id);
    if (index < 0) throw new Error("Unexpected asset read");
    const entry = { id, requestedAt: Date.now(), servedAt: null };
    reads.push(entry);
    if (id === ids[3]) await readGate.promise;
    entry.servedAt = Date.now();
    return json(route, { url: `${pictures[index]}?qaAsset=${id}`, expiresAt: new Date(Date.now() + 900_000).toISOString() });
  });
  await page.route(/\/artworks\/[^?]+\?qaAsset=/, async (route) => {
    const url = new URL(route.request().url()), id = url.searchParams.get("qaAsset");
    const entry = { id, requestedAt: Date.now(), servedAt: null };
    bytes.push(entry);
    if (id === ids[4]) await byteGate.promise;
    if (profile.large) {
      entry.servedAt = Date.now();
      return route.fulfill({ status: 200, contentType: "image/jpeg", body: largePictures[ids.indexOf(id)].body });
    }
    url.search = "";
    const response = await route.fetch({ url: url.toString() });
    entry.servedAt = Date.now();
    return route.fulfill({ response });
  });
  return { reads, bytes, readGate, byteGate };
}

async function observe(page) {
  await page.evaluate(() => {
    const root = document.querySelector(".journey-story__media");
    const state = { running: true, frames: [], writes: [], input: [], ticks: { raf: 0, mutation: 0 } };
    window.__qaR3 = state;
    const identity = (url) => url ? new URL(url, document.baseURI).searchParams.get("qaAsset") : null;
    const rectangle = (r) => ({ left: r.left, top: r.top, width: r.width, height: r.height });
    const clipped = (node) => {
      const b = node.getBoundingClientRect(), clip = getComputedStyle(node).clipPath;
      const sides = clip.startsWith("inset(") ? (clip.match(/-?\d*\.?\d+(?:e[-+]?\d+)?%/gi) ?? []).map((v) => Number(v.slice(0, -1))) : [];
      const [top = 0, right = top, bottom = top, left = right] = sides;
      return { left: b.left + b.width * left / 100, top: b.top + b.height * top / 100,
        width: b.width * (1 - (left + right) / 100), height: b.height * (1 - (top + bottom) / 100) };
    };
    const contains = (b, x, y) => b && b.width > 0 && b.height > 0 && x >= b.left && x <= b.left + b.width && y >= b.top && y <= b.top + b.height;
    const intersection = (a, b) => {
      const left = Math.max(a.left, b.left), top = Math.max(a.top, b.top);
      return { left, top, width: Math.max(0, Math.min(a.left + a.width, b.left + b.width) - left),
        height: Math.max(0, Math.min(a.top + a.height, b.top + b.height) - top) };
    };
    let lastAperture = null;
    const sample = (tick) => {
      if (!state.running) return;
      const pages = root?.querySelector("[data-story-media-pages]");
      if (!pages) return;
      state.ticks[tick] += 1;
      const slots = [...pages.querySelectorAll("[data-media-page]")].map((node, slot) => {
        const image = node.querySelector("img"), style = getComputedStyle(node);
        const imageStyle = image ? getComputedStyle(image) : null;
        const box = image?.getBoundingClientRect();
        const scale = box && image.naturalWidth && image.naturalHeight ? Math.min(box.width / image.naturalWidth, box.height / image.naturalHeight) : 0;
        const picture = scale ? { left: box.left + (box.width - image.naturalWidth * scale) / 2,
          top: box.top + (box.height - image.naturalHeight * scale) / 2, width: image.naturalWidth * scale, height: image.naturalHeight * scale } : null;
        const band = clipped(node);
        return { slot, id: node.getAttribute("data-media-page-id"), role: node.getAttribute("data-media-page"),
          incoming: node.getAttribute("data-media-incoming"), ready: node.getAttribute("data-media-page-ready"),
          read: node.getAttribute("data-media-read-state"), generation: node.getAttribute("data-media-read-generation"),
          src: identity(image?.getAttribute("src")), actual: identity(image?.currentSrc), complete: image?.complete,
          natural: image ? [image.naturalWidth, image.naturalHeight] : null, hidden: image?.hidden,
          displayed: Boolean(image && !image.hidden && imageStyle.display !== "none" && imageStyle.visibility !== "hidden"
            && style.visibility !== "hidden" && Number(style.opacity) > 0 && picture),
          opacity: Number(style.opacity), z: Number(style.zIndex), transform: style.transform, clip: style.clipPath,
          picture, band, box: rectangle(node.getBoundingClientRect()),
        };
      }).sort((a, b) => b.z - a.z || b.slot - a.slot);
      const legal = slots.find((slot) => slot.displayed && slot.complete && slot.actual === slot.id);
      const aperture = legal ? intersection(legal.picture, legal.band) : lastAperture;
      if (legal && aperture?.width > 0 && aperture?.height > 0) lastAperture = aperture;
      const points = aperture ? [[0.5, 0.5], [0.3, 0.5], [0.7, 0.5], [0.5, 0.3], [0.5, 0.7]].map(([x, y]) => {
        const px = aperture.left + aperture.width * x, py = aperture.top + aperture.height * y;
        const owner = slots.find((slot) => slot.displayed && contains(slot.picture, px, py) && contains(slot.band, px, py));
        return owner ? { id: owner.id, actual: owner.actual, slot: owner.slot, opacity: owner.opacity } : null;
      }) : [];
      const waiting = [...root.querySelectorAll(".is-waiting")].some((node) => {
        const style = getComputedStyle(node); return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0;
      });
      state.frames.push({ at: performance.now(), tick, requested: root.getAttribute("data-media-requested"),
        current: slots.find((slot) => slot.role === "current")?.id ?? null,
        incoming: slots.find((slot) => slot.incoming === "true")?.id ?? null,
        presentation: pages.getAttribute("data-media-presentation"), slots, aperture, points, waiting });
    };
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type !== "attributes" || !(r.target instanceof Element)) continue;
        state.writes.push({ at: performance.now(), attribute: r.attributeName, oldValue: r.oldValue,
          value: r.target.getAttribute(r.attributeName), slot: r.target.closest("[data-media-page]")?.getAttribute("data-media-page-id") ?? null });
      }
      sample("mutation");
    });
    const input = (event) => {
      if (!event.target.closest?.('.journey-story__media-nav button[aria-pressed]')) return;
      state.input.push({ at: performance.now(), type: event.type, trusted: event.isTrusted,
        pointerType: event.pointerType, pressed: event.target.closest("button")?.getAttribute("aria-pressed") });
    };
    document.addEventListener("pointerup", input, true);
    observer.observe(root, { subtree: true, attributes: true, attributeOldValue: true, childList: true });
    state.stop = () => { state.running = false; observer.disconnect(); document.removeEventListener("pointerup", input, true); };
    const frame = () => { if (!state.running) return; sample("raf"); requestAnimationFrame(frame); };
    frame();
  });
}

function grade(frames) {
  const failures = [], ownerChanges = [], sequences = new Map();
  let previous = ids[0], requested = ids[0];
  for (const frame of frames) {
    if (frame.requested && frame.requested !== requested) {
      previous = requested; requested = frame.requested;
    }
    const centre = frame.points[0];
    const actual = centre?.actual ?? null;
    const sequence = sequences.get(requested) ?? [];
    if (actual !== sequence.at(-1)) {
      sequence.push(actual); sequences.set(requested, sequence);
      ownerChanges.push({ at: frame.at, requested, actual, current: frame.current, incoming: frame.incoming });
    }
    const reasons = [];
    if (!frame.points.length || frame.points.some((point) => !point)) reasons.push("blank-aperture");
    if (frame.waiting) reasons.push("waiting-replaces-frame");
    if (frame.points.some((point) => point && point.id !== point.actual)) reasons.push("physical-slot-identity-mismatch");
    if (frame.points.some((point) => point && point.actual !== requested && point.actual !== previous)) reasons.push("third-media-exposure");
    if (frame.points.some((point) => point && point.opacity < 0.99)) reasons.push("dimmed-picture");
    const seenTarget = sequence.indexOf(requested);
    if (seenTarget >= 0 && sequence.slice(seenTarget + 1).some((id) => id && id !== requested)) reasons.push("foreground-reversal");
    if (frame.slots.length > 3) reasons.push("presentation-page-bound");
    if (reasons.length) failures.push({ ...frame, reasons });
  }
  const counts = {};
  for (const frame of failures) for (const reason of frame.reasons) counts[reason] = (counts[reason] ?? 0) + 1;
  return { frames: frames.length, counts, ownerChanges, sequences: Object.fromEntries(sequences),
    firstFailures: failures.slice(0, 12), reproduced: failures.length > 0 };
}

try {
  for (const profile of profiles) {
    // This is an approximate wall-clock anchor for video keyframes, not frame
    // grading. Browser observers retain their exact page-clock timestamps.
    const videoStartedAt = Date.now();
    const page = await browser.newPage({ viewport: profile.viewport, isMobile: profile.touch, hasTouch: profile.touch,
      deviceScaleFactor: profile.dpr, reducedMotion: "no-preference", recordVideo: { dir: directory, size: profile.viewport } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    const record = { profile, buildSha, harnessSha, mode: baseline ? "baseline" : "candidate", errors, steps: [], holds: [] };
    const routes = await fixture(page, profile);
    if (profile.large) record.fixtureDimensions = largePictures.map(({ width, height }) => [width, height]);
    try {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpu });
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      const activate = async (locator) => profile.touch ? await locator.tap() : await locator.click();
      await activate(page.getByRole("button", { name: `打开旅程：${journey.title}`, exact: true }).first());
      await page.locator(".journey-story").waitFor({ state: "visible" });
      await page.waitForFunction(() => !document.querySelector("[data-shared-element-clone]"), null, { polling: "raf", timeout: 8_000 });
      const settled = (id) => page.waitForFunction((expected) => {
        const stage = document.querySelector(".journey-story__media [data-story-media-pages]");
        const current = stage?.querySelector('[data-media-page="current"]');
        const image = current?.querySelector("img");
        return stage?.getAttribute("data-media-presentation") === "settled" && current?.getAttribute("data-media-page-id") === expected
          && current.getAttribute("data-media-page-ready") === "true" && image && !image.hidden && image.complete && image.naturalWidth > 0
          && new URL(image.currentSrc).searchParams.get("qaAsset") === expected;
      }, id, { polling: "raf", timeout: 8_000 });
      await settled(ids[0]);
      record.environment = await page.evaluate(() => ({ userAgent: navigator.userAgent, viewport: [innerWidth, innerHeight],
        dpr: devicePixelRatio, coarse: matchMedia("(any-pointer: coarse)").matches,
        reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
        layout: document.querySelector(".journey-story")?.getAttribute("data-story-layout"), entry: location.pathname + location.search }));
      await observe(page);
      await activate(page.locator('.journey-story__media-nav button[aria-pressed="false"]'));
      for (let index = 1; index <= 6; index += 1) {
        await page.waitForFunction((id) => document.querySelector(".journey-story__media")?.getAttribute("data-media-requested") === id,
          ids[index], { polling: "raf", timeout: 9_000 });
        if (index === 3 || index === 4) {
          const log = index === 3 ? routes.reads : routes.bytes;
          const deadline = Date.now() + 5_000;
          while (!log.some((entry) => entry.id === ids[index]) && Date.now() < deadline) {
            await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
          }
          if (!log.some((entry) => entry.id === ids[index] && entry.servedAt === null)) throw new Error("Expected held response was not reached");
          const from = Date.now();
          for (let frame = 0; frame < 25; frame += 1) await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
          record.holds.push({ index, gate: index === 3 ? "read" : "bytes", from, to: Date.now() });
          (index === 3 ? routes.readGate : routes.byteGate).resolve();
        }
        await settled(ids[index]);
        record.steps.push({ index, id: ids[index] });
      }
      const observations = await page.evaluate(() => { window.__qaR3.stop(); return {
        frames: window.__qaR3.frames, writes: window.__qaR3.writes, ticks: window.__qaR3.ticks, input: window.__qaR3.input }; });
      await writeFile(`${directory}/${profile.name}-trace.json`, JSON.stringify({ ...record, ...observations, reads: routes.reads, bytes: routes.bytes }, null, 2));
      record.observations = grade(observations.frames);
      record.ticks = observations.ticks;
      record.writerEvents = observations.writes.length;
      record.input = observations.input;
      record.validExecution = record.steps.length === 6 && observations.ticks.raf > 0 && !record.environment.reducedMotion
        && record.environment.entry === "/" && record.environment.layout === "desktop"
        && observations.input.some((event) => event.trusted && event.pointerType === (profile.touch ? "touch" : "mouse"))
        && errors.length === 0;
    } catch (error) {
      record.error = String(error);
      record.validExecution = false;
      const observations = await page.evaluate(() => { window.__qaR3?.stop(); return window.__qaR3 ? {
        frames: window.__qaR3.frames, writes: window.__qaR3.writes, ticks: window.__qaR3.ticks, input: window.__qaR3.input } : null; }).catch(() => null);
      if (observations) record.observations = grade(observations.frames);
      await writeFile(`${directory}/${profile.name}-failure.json`, JSON.stringify({ ...record, observations, reads: routes.reads, bytes: routes.bytes }, null, 2));
    } finally {
      routes.readGate.resolve(); routes.byteGate.resolve();
      const video = page.video();
      await page.close();
      if (video) {
        const path = `${directory}/${profile.name}-continuous.webm`;
        await rename(await video.path(), path);
        const { stdout } = await execute("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", path]);
        const duration = Number(JSON.parse(stdout).format.duration);
        record.keyframes = [];
        const anchors = [...record.holds.map((hold) => ({ name: `held-${hold.gate}`,
          seconds: ((hold.from + hold.to) / 2 - videoStartedAt) / 1000 })), { name: "end", seconds: duration - 0.4 }];
        for (const anchor of anchors) {
          const seconds = Math.max(0, Math.min(duration - 0.2, anchor.seconds));
          const png = `${directory}/${profile.name}-${anchor.name}.png`;
          await execute("ffmpeg", ["-v", "error", "-y", "-ss", String(seconds), "-i", path, "-frames:v", "1", png]);
          record.keyframes.push({ path: png, seconds, approximateAnchor: true });
        }
      }
      results.push(record);
      console.log(JSON.stringify(record));
    }
  }
} finally { await browser.close(); }
const valid = results.length === profiles.length && results.every((record) => record.validExecution);
const reproduced = results.some((record) => record.observations?.reproduced);
const summary = { buildSha, harnessSha, mode: baseline ? "baseline" : "candidate", validExecution: valid,
  disposition: !valid ? "INVALID_EXECUTION" : baseline ? reproduced ? "BASELINE_REPRODUCED" : "BASELINE_NOT_REPRODUCED"
    : reproduced ? "CANDIDATE_FAILED" : "CANDIDATE_PASSED", results };
await writeFile(`${directory}/summary.json`, JSON.stringify(summary, null, 2));
if (!valid || (!baseline && reproduced)) process.exitCode = 1;
