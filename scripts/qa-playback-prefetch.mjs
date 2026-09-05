// #197 acceptance 6: Fast tempo must not have materially worse playback
// continuity than Standard just because its media lookahead stayed fixed.
//
// `src/journey/playbackPrefetchPlan.ts` already replaced the fixed
// `current + next` slice with a per-tempo time budget, and 14 node tests cover
// that arithmetic. What no test observed is a real browser playing real beats
// against slow signed reads, which is the only place the claim is falsifiable.
// This lane measures it: the same image-heavy fixture and the same artificial
// read delay are played at `fast` and at `standard`, and the run fails when
// `fast` holds for decode more than `standard` does beyond a declared
// tolerance. It deliberately tunes nothing — the per-tempo budget values are a
// product-owner decision (ST-010 / ST-011) and this only grades the shipped
// ones.
import { readFileSync } from "node:fs";
import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
const onePixelGif = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";

/**
 * The artificial latency of every signed read, chosen to sit BETWEEN the two
 * tempos' image dwells (`fast` 1700 ms, `standard` 2800 ms in
 * `PLAYBACK_TEMPO_PROFILES`).
 *
 * That is what makes this lane a detector rather than a tautology: a planner
 * regressed to `current + next` requests beat k+1 as beat k begins, which
 * lands 500 ms AFTER `fast` needs it — a hold on every beat — and comfortably
 * before `standard` needs it, so the differential below goes red. Under the
 * shipped time-budget window both tempos prepare several beats ahead and hold
 * for neither. A delay below 1700 or above 2800 would pass whatever the
 * planner did.
 */
const READ_DELAY_MS = 2_200;

/**
 * Media beats graded per run, after the warm-up boundary below.
 *
 * Bounded on purpose: playing a 20-image fixture to its outro costs ~57 s at
 * `standard`, and the `browser-qa` lane has 12 minutes for install, Chromium,
 * a Vite boot and five runs.
 */
const MEASURED_MEDIA_STEPS = 10;
/** The same, for the runs that grade bounds and reachability, not the differential. */
const SECONDARY_MEDIA_STEPS = 6;
/**
 * Quick Recap plays the beats its own Edit Plan selected, not the fixture's 60
 * images, so this asks for fewer: enough beats to prove the window advances
 * through a recap plan, without asserting a selection size the deterministic
 * builder owns and this lane must not constrain.
 */
const RECAP_MEDIA_STEPS = 3;

/**
 * Measurement starts when the FIRST media beat has rendered, not at mount.
 *
 * Both tempos wait the same `READ_DELAY_MS` for the first read, but `fast`
 * reaches the stop beat sooner (intro 800 + arrival) than `standard`
 * (intro 1100 + arrival), so the opening hold is a few hundred ms longer at
 * `fast` with nothing whatsoever wrong. Grading the cold start would make this
 * lane fail on correct code.
 */
const WARMUP_MEDIA_STEPS = 1;

/**
 * How much worse `fast` may be than `standard` before the run fails.
 *
 * One hold and 500 ms absorb scheduler noise on a shared CI runner; a
 * lookahead that stayed fixed costs one hold per beat (ten holds, ~5 s here),
 * which is an order of magnitude outside this.
 */
const HOLD_COUNT_TOLERANCE = 1;
const HOLD_MS_TOLERANCE = 500;

// Acceptance 5: the bound is read out of the module that owns it, so a change
// to the constant cannot leave this lane grading a stale number. A rename must
// break the lane loudly rather than silently disable it.
const prefetchPlanSource = readFileSync(
  new URL("../src/journey/playbackPrefetchPlan.ts", import.meta.url),
  "utf8",
);
const maxAssetsMatch = /export const MAX_PREFETCH_ASSETS = (\d+);/.exec(prefetchPlanSource);
if (!maxAssetsMatch) {
  throw new Error(
    "MAX_PREFETCH_ASSETS not found in src/journey/playbackPrefetchPlan.ts — "
    + "the prefetch bound this lane grades has moved or been renamed.",
  );
}
const MAX_PREFETCH_ASSETS = Number(maxAssetsMatch[1]);
/**
 * The observed ceiling is one above the module's cap, for two bounded and
 * deliberate reasons: `JourneyPlaybackOverlay` prepends the beat's hold target
 * when the window does not already contain it, outside the cap; and a sample
 * taken as a window advances can see the new read before the just-displayed
 * beat is counted, because the step attribute and the effect that issues the
 * read land in the same React commit. A lookahead that lost its bound would
 * show 20-60 here, not 9.
 */
const OUTSTANDING_ASSET_CEILING = MAX_PREFETCH_ASSETS + 1;

const PREFETCH_FIXTURES = {
  // Mirrors `prefetchQaJourney` in src/main.tsx, which is where both fixtures
  // are declared; this is only the beat table needed to map an asset back to
  // the beat that displays it.
  single: { points: 1, imagesPerPoint: 20 },
  multi: { points: 5, imagesPerPoint: 12 },
};

const pad = (value, width) => `${value}`.padStart(width, "0");
const fixtureAssetId = (pointIndex, mediaIndex) =>
  `00000000-0000-4000-8000-1${pad(pointIndex, 2)}${pad(mediaIndex, 3)}000000`;

/**
 * The fixture's beats in `buildPlaybackSteps` order: intro, then per route
 * point a travel (except the first), a stop and one media beat per image, then
 * outro. Mirrored here rather than imported because this script runs in node
 * against a served page, the same way `qa-media-controls.mjs` mirrors the beat
 * order it drives.
 */
function fixtureSteps(fixture) {
  const { points, imagesPerPoint } = PREFETCH_FIXTURES[fixture];
  const steps = [{ kind: "intro", pointIndex: null, assetId: null }];
  for (let pointIndex = 0; pointIndex < points; pointIndex += 1) {
    if (pointIndex > 0) steps.push({ kind: "travel", pointIndex, assetId: null });
    steps.push({ kind: "stop", pointIndex, assetId: null });
    for (let mediaIndex = 0; mediaIndex < imagesPerPoint; mediaIndex += 1) {
      steps.push({ kind: "media", pointIndex, assetId: fixtureAssetId(pointIndex, mediaIndex) });
    }
  }
  steps.push({ kind: "outro", pointIndex: null, assetId: null });
  return steps;
}

const browser = await launchQaBrowser();
const checks = [];
let failed = false;

function record(name, detail) {
  checks.push({ name, ...detail });
  if (detail.failed) failed = true;
}

async function openRun({ fixture, recap = false }) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  // The overlay publishes `data-playback-step` and, from #197,
  // `data-playback-hold` on `.journey-playback`. Sampling those transitions is
  // how a decode hold is counted directly instead of inferred from a
  // wall-clock gap: a video beat holding for its own runtime reads `video`, a
  // trim positioning reads `trim`, and only `decode` is a lookahead symptom.
  await page.addInitScript(() => {
    const trace = { events: [] };
    window.__qaPlaybackPrefetch = trace;
    const sample = (overlay) => ({
      at: Date.now(),
      step: Number(overlay.getAttribute("data-playback-step")),
      hold: overlay.getAttribute("data-playback-hold"),
      phase: overlay.getAttribute("data-playback-phase"),
      mode: overlay.getAttribute("data-playback-mode"),
      hasImage: Boolean(overlay.querySelector(".journey-playback__media img")),
    });
    const push = (overlay) => {
      const entry = sample(overlay);
      const last = trace.events[trace.events.length - 1];
      if (
        last
        && last.step === entry.step
        && last.hold === entry.hold
        && last.phase === entry.phase
        && last.hasImage === entry.hasImage
      ) return;
      trace.events.push(entry);
    };
    const attach = () => {
      const overlay = document.querySelector(".journey-playback");
      if (!overlay) return false;
      push(overlay);
      // Attribute changes carry the step and the hold; the child list carries
      // the moment a beat's <img> is actually in the document.
      new MutationObserver(() => push(overlay)).observe(overlay, {
        attributes: true,
        attributeFilter: [
          "data-playback-step",
          "data-playback-hold",
          "data-playback-phase",
          "data-playback-mode",
        ],
      });
      new MutationObserver(() => push(overlay)).observe(overlay, {
        childList: true,
        subtree: true,
      });
      return true;
    };
    const poll = setInterval(() => {
      if (attach()) clearInterval(poll);
    }, 20);
  });

  await page.route("**/api/auth/get-session", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: "null",
  }));

  const reads = [];
  await page.route("**/api/uploads/assets/*/read-url", async (route) => {
    const assetId = /assets\/([^/]+)\/read-url/.exec(route.request().url())?.[1] ?? null;
    const entry = { assetId, requestedAt: Date.now(), fulfilledAt: null };
    reads.push(entry);
    await new Promise((resolve) => setTimeout(resolve, READ_DELAY_MS));
    entry.fulfilledAt = Date.now();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        url: onePixelGif,
        // Far enough ahead that no read is re-signed mid-run: a refresh would
        // add a request the window never asked for and distort every count.
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    });
  });

  const query = new URLSearchParams({
    qaState: "journey-playback",
    qaMode: "prefetch",
    qaFixture: fixture,
  });
  if (recap) query.set("qaRecap", "1");
  await page.goto(`${origin}/?${query}`, { waitUntil: "domcontentloaded" });
  await page.locator(".journey-playback").waitFor({ state: "visible", timeout: 30_000 });
  return { page, reads, consoleErrors, pageErrors };
}

async function setTempo(page, tempo) {
  await page.locator(".journey-playback__tempo select").selectOption(tempo);
}

async function readTrace(page) {
  return page.evaluate(() => window.__qaPlaybackPrefetch.events);
}

/** Wait until `count` distinct media beats have rendered their image. */
async function waitForRenderedMediaSteps(page, count, timeout) {
  await page.waitForFunction((target) => {
    const trace = window.__qaPlaybackPrefetch;
    if (!trace) return false;
    const rendered = new Set(
      trace.events
        .filter((entry) => entry.phase === "media" && entry.hasImage && entry.hold === "none")
        .map((entry) => entry.step),
    );
    return rendered.size >= target;
  }, count, { timeout });
}

/** The distinct media beats that rendered, in the order they first rendered. */
function renderedMediaSteps(events) {
  const seen = new Map();
  for (const entry of events) {
    if (entry.phase !== "media" || !entry.hasImage || entry.hold !== "none") continue;
    if (!seen.has(entry.step)) seen.set(entry.step, entry.at);
  }
  return [...seen].map(([step, at]) => ({ step, at }));
}

/**
 * Contiguous stretches where the overlay published `hold="decode"`. Only that
 * value is a lookahead symptom; `video` and `trim` are a beat owning its own
 * runtime.
 */
function decodeHolds(events) {
  const holds = [];
  let open = null;
  for (const entry of events) {
    if (entry.hold === "decode" && !open) open = { at: entry.at, step: entry.step };
    else if (entry.hold !== "decode" && open) {
      holds.push({ ...open, durationMs: entry.at - open.at });
      open = null;
    }
  }
  if (open) holds.push({ ...open, durationMs: Date.now() - open.at });
  return holds;
}

/**
 * Assets read but not yet displayed, sampled at every read request: the size of
 * the live window, including the beat on screen.
 */
function maxOutstandingAssets(reads, rendered, sinceAt) {
  let max = 0;
  for (const read of reads) {
    if (read.requestedAt < sinceAt) continue;
    const requested = reads.filter((other) => other.requestedAt <= read.requestedAt).length;
    const displayed = rendered.filter((entry) => entry.at <= read.requestedAt).length;
    max = Math.max(max, requested - displayed);
  }
  return max;
}

/**
 * Per-asset lead time: how long an asset had been readable before the beat that
 * displays it appeared. A negative value IS a hold — the beat arrived before
 * its media did. Recorded rather than gated; the gate is the differential.
 */
function readyLeadMs(reads, rendered, steps, sinceAt) {
  const fulfilledByAsset = new Map(
    reads
      .filter((read) => read.fulfilledAt !== null)
      .map((read) => [read.assetId, read.fulfilledAt]),
  );
  const samples = [];
  for (const entry of rendered) {
    if (entry.at < sinceAt) continue;
    const assetId = steps[entry.step]?.assetId ?? null;
    const fulfilledAt = assetId ? fulfilledByAsset.get(assetId) : undefined;
    if (fulfilledAt === undefined) continue;
    samples.push(entry.at - fulfilledAt);
  }
  return samples;
}

function summarise(samples) {
  if (samples.length === 0) return { count: 0, minMs: null, medianMs: null };
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    count: sorted.length,
    minMs: sorted[0],
    medianMs: sorted[Math.floor(sorted.length / 2)],
  };
}

/**
 * One measured playback run: set the tempo, let the warm-up beat render, then
 * grade the following `measuredSteps` beats.
 */
async function measureRun({ label, fixture, tempo, recap = false, measuredSteps }) {
  const run = await openRun({ fixture, recap });
  try {
    await setTempo(run.page, tempo);
    await waitForRenderedMediaSteps(run.page, WARMUP_MEDIA_STEPS, 60_000);
    const warmup = renderedMediaSteps(await readTrace(run.page));
    const sinceAt = warmup[warmup.length - 1].at;
    await waitForRenderedMediaSteps(
      run.page,
      WARMUP_MEDIA_STEPS + measuredSteps,
      // Room for the slowest tempo's dwell plus the read delay on every beat.
      (measuredSteps + 2) * 6_000,
    );
    const events = await readTrace(run.page);
    const rendered = renderedMediaSteps(events);
    const measured = rendered.filter((entry) => entry.at > sinceAt);
    const holds = decodeHolds(events).filter((hold) => hold.at >= sinceAt);
    const steps = fixtureSteps(fixture);
    const measurement = {
      label,
      fixture,
      tempo,
      mode: events[events.length - 1]?.mode ?? null,
      readDelayMs: READ_DELAY_MS,
      measuredMediaSteps: measured.length,
      decodeHoldCount: holds.length,
      decodeHoldMs: holds.reduce((total, hold) => total + hold.durationMs, 0),
      // Quick Recap plays a PROJECTED journey, so a beat index there does not
      // map to the fixture's beat table; the lead time is reported for Full
      // Playback only and the recap run is graded on holds and bounds.
      readyLeadMs: recap
        ? { count: 0, minMs: null, medianMs: null }
        : summarise(readyLeadMs(run.reads, rendered, steps, sinceAt)),
      prefetchedAssets: run.reads.length,
      maxOutstandingAssets: maxOutstandingAssets(run.reads, rendered, sinceAt),
      maxPrefetchAssets: MAX_PREFETCH_ASSETS,
      outstandingCeiling: OUTSTANDING_ASSET_CEILING,
    };
    return { run, measurement, events, rendered, sinceAt };
  } catch (error) {
    await run.page.close();
    throw error;
  }
}

function recordRuntimeErrors(label, run) {
  if (run.consoleErrors.length === 0 && run.pageErrors.length === 0) return;
  record(`${label}-runtime-errors`, {
    consoleErrors: run.consoleErrors,
    pageErrors: run.pageErrors,
    failed: true,
  });
}

const measurements = [];

try {
  // ── Acceptance 4 + 5: the Fast vs Standard differential ─────────────────
  const tempoRuns = {};
  for (const tempo of ["fast", "standard"]) {
    const label = `playback-prefetch-${tempo}`;
    const measured = await measureRun({
      label,
      fixture: "single",
      tempo,
      measuredSteps: MEASURED_MEDIA_STEPS,
    });
    try {
      const { measurement } = measured;
      measurements.push(measurement);
      tempoRuns[tempo] = measurement;
      record(label, {
        measurement,
        failed: measurement.measuredMediaSteps < MEASURED_MEDIA_STEPS
          || measurement.maxOutstandingAssets > OUTSTANDING_ASSET_CEILING,
      });
      recordRuntimeErrors(label, measured.run);
    } finally {
      await measured.run.page.close();
    }
  }

  const fast = tempoRuns.fast;
  const standard = tempoRuns.standard;
  const holdCountRegression = fast.decodeHoldCount - standard.decodeHoldCount;
  const holdMsRegression = fast.decodeHoldMs - standard.decodeHoldMs;
  record("playback-prefetch-fast-vs-standard", {
    readDelayMs: READ_DELAY_MS,
    measuredMediaSteps: MEASURED_MEDIA_STEPS,
    fast: { holdCount: fast.decodeHoldCount, holdMs: fast.decodeHoldMs },
    standard: { holdCount: standard.decodeHoldCount, holdMs: standard.decodeHoldMs },
    holdCountRegression,
    holdMsRegression,
    tolerance: { holdCount: HOLD_COUNT_TOLERANCE, holdMs: HOLD_MS_TOLERANCE },
    failed: holdCountRegression > HOLD_COUNT_TOLERANCE
      || holdMsRegression > HOLD_MS_TOLERANCE,
  });

  // ── A multi-Route-Point fixture, so the window is graded across chapters ─
  const multi = await measureRun({
    label: "playback-prefetch-multi-fast",
    fixture: "multi",
    tempo: "fast",
    measuredSteps: SECONDARY_MEDIA_STEPS,
  });
  try {
    measurements.push(multi.measurement);
    record("playback-prefetch-multi-fast", {
      measurement: multi.measurement,
      failed: multi.measurement.measuredMediaSteps < SECONDARY_MEDIA_STEPS
        || multi.measurement.maxOutstandingAssets > OUTSTANDING_ASSET_CEILING,
    });
    recordRuntimeErrors("playback-prefetch-multi-fast", multi.run);
  } finally {
    await multi.run.page.close();
  }

  // ── Acceptance 6a: Quick Recap at fast tempo ────────────────────────────
  // The recap owns its own Edit Plan and its own beat lengths, and the prefetch
  // window walks whatever `durationForStep` answers — so this run proves the
  // one policy covers both modes rather than only Full Playback. A recap that
  // failed to prepare would silently degrade to Full Playback, so the mode is
  // asserted rather than assumed.
  const recap = await measureRun({
    label: "playback-prefetch-recap-fast",
    fixture: "multi",
    tempo: "fast",
    recap: true,
    measuredSteps: RECAP_MEDIA_STEPS,
  });
  try {
    measurements.push(recap.measurement);
    record("playback-prefetch-recap-fast", {
      measurement: recap.measurement,
      failed: recap.measurement.mode !== "quick-recap"
        || recap.measurement.measuredMediaSteps < RECAP_MEDIA_STEPS
        || recap.measurement.maxOutstandingAssets > OUTSTANDING_ASSET_CEILING,
    });
    recordRuntimeErrors("playback-prefetch-recap-fast", recap.run);
  } finally {
    await recap.run.page.close();
  }

  // ── Acceptance 6b: a seek several chapters ahead during fast playback ────
  const seekRun = await openRun({ fixture: "multi" });
  try {
    const steps = fixtureSteps("multi");
    await setTempo(seekRun.page, "fast");
    await waitForRenderedMediaSteps(seekRun.page, WARMUP_MEDIA_STEPS, 60_000);
    const beforeSeek = renderedMediaSteps(await readTrace(seekRun.page));
    const preSeekStep = beforeSeek[beforeSeek.length - 1].step;
    const preSeekPointIndex = steps[preSeekStep]?.pointIndex ?? 0;
    // Scrub through the transport the product exposes rather than calling into
    // it: the range is time-scaled, so a fraction lands wherever the plan says
    // that elapsed time is, and where playback landed is then read back.
    const seekAt = Date.now();
    await seekRun.page.evaluate(() => {
      const input = document.querySelector(".journey-playback__progress input[type=\"range\"]");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, String(Math.round(Number(input.max) * 0.62)));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // The seek target may be a travel or stop beat; what has to hold is that
    // playback reaches a RENDERED media beat at the new narrative position.
    await seekRun.page.waitForFunction((step) => {
      const trace = window.__qaPlaybackPrefetch;
      return Boolean(trace?.events.some((entry) => (
        entry.step > step && entry.phase === "media" && entry.hasImage && entry.hold === "none"
      )));
    }, preSeekStep, { timeout: 60_000 });
    const events = await readTrace(seekRun.page);
    const landed = renderedMediaSteps(events).find((entry) => entry.at > seekAt);
    const landedPointIndex = landed ? steps[landed.step]?.pointIndex ?? null : null;
    // The window is derived from the live step index alone, so nothing behind
    // the new position may still be requested after the seek.
    const postSeekReads = seekRun.reads.filter((read) => read.requestedAt > seekAt);
    const stepForAsset = new Map(
      steps.flatMap((step, index) => (step.assetId ? [[step.assetId, index]] : [])),
    );
    const staleReads = landed
      ? postSeekReads.filter((read) => (
        (stepForAsset.get(read.assetId) ?? Number.POSITIVE_INFINITY) < landed.step
      ))
      : [];
    // A hold on the seek target itself is legitimate — its read had not been
    // asked for before the scrub. A hold on a beat BEHIND the new position is
    // the pre-seek window still controlling playback, which is the defect.
    const preSeekWindowHolds = landed
      ? decodeHolds(events).filter((hold) => hold.at > seekAt && hold.step < landed.step)
      : [];
    record("playback-prefetch-seek-fast", {
      preSeekStep,
      preSeekPointIndex,
      landedStep: landed?.step ?? null,
      landedPointIndex,
      chaptersAdvanced: landedPointIndex === null ? null : landedPointIndex - preSeekPointIndex,
      postSeekReadCount: postSeekReads.length,
      staleReads: staleReads.map((read) => read.assetId),
      preSeekWindowHolds,
      failed: landedPointIndex === null
        || landedPointIndex - preSeekPointIndex < 2
        || staleReads.length > 0
        || preSeekWindowHolds.length > 0,
    });
    recordRuntimeErrors("playback-prefetch-seek-fast", seekRun);
  } finally {
    await seekRun.page.close();
  }
} finally {
  await browser.close();
}

// One JSON line per measured run, as the acceptance asks, ahead of the full
// check list so the numbers are greppable in the CI job log.
for (const measurement of measurements) console.log(JSON.stringify(measurement));
console.log(JSON.stringify(checks, null, 2));
if (failed) process.exitCode = 1;
