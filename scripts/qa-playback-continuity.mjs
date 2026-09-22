// #456: sparse Route Point chapters must read as place -> memory -> next place.
//
// The unit tests own the grammar (`routePointChapterDensity`,
// `meaningfulPlaybackStepIndexes`); they cannot see the thing the issue is
// actually about, which is what a viewer sees at the seam between an arrival
// and the Route Point Media it introduces. This lane plays deterministic
// 0/1/3/4/6/9-media chapters in a real browser and grades the claims that only
// exist on screen:
//
//   1. no same-point globe re-focus — one camera command per Route Point, and
//      never two in a row for the same target;
//   2. no blank intermediate surface — every chapter beat has the caption, and
//      a populated chapter's media region is never an empty frame once its
//      media beat owns it;
//   3. meaningful Next/Previous — an `empty` chapter's arrival is a
//      destination, a populated chapter's arrival is not, and every media beat
//      stays reachable in canonical order;
//   4. 4-9 sequence chapters expose bounded peeks without a second video;
//   5. all of it on desktop, portrait phone AND phone landscape.
//
// It tunes nothing: the density grammar and the beat order are the product
// decision, and this only grades the shipped ones.
import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
const onePixelGif = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
const tinyVideo = "/demo-media/east-star-orbit.webm";

/**
 * The fixture's chapter densities, mirrored from `CONTINUITY_QA_MEDIA_COUNTS`
 * in src/preview/ProductQaPreview.tsx. Mirrored rather than imported because this script runs in
 * node against a served page, the same way `qa-playback-prefetch.mjs` mirrors
 * the beat table it drives.
 */
const MEDIA_COUNTS = [0, 1, 3, 4, 6, 9];

/** `buildPlaybackSteps` order for that fixture: intro, then per point a travel
 * (except the first), its arrival and one media beat per asset, then outro. */
function fixtureSteps() {
  const steps = [{ kind: "intro" }];
  for (let pointIndex = 0; pointIndex < MEDIA_COUNTS.length; pointIndex += 1) {
    if (pointIndex > 0) steps.push({ kind: "travel", pointIndex });
    steps.push({ kind: "stop", pointIndex, mediaCount: MEDIA_COUNTS[pointIndex] });
    for (let mediaIndex = 0; mediaIndex < MEDIA_COUNTS[pointIndex]; mediaIndex += 1) {
      steps.push({ kind: "media", pointIndex, mediaIndex });
    }
  }
  steps.push({ kind: "outro" });
  return steps;
}

const STEPS = fixtureSteps();

const densityFor = (mediaCount) => (
  mediaCount === 0 ? "empty" : mediaCount === 1 ? "single" : mediaCount <= 3 ? "few" : "sequence"
);

/** The beats manual Next/Previous may land on: everything but travel and the
 * arrival of a populated chapter. Derived from the fixture, so a fixture edit
 * moves the expectation with it instead of leaving a stale literal behind. */
const EXPECTED_MEANINGFUL = STEPS.flatMap((step, index) => {
  if (step.kind === "travel") return [];
  if (step.kind === "stop" && step.mediaCount > 0) return [];
  return [index];
});

/** One camera command per Route Point, plus the Journey framing that opens and
 * closes the run. A chapter that re-focused its own point would add one. */
const EXPECTED_CAMERA_KEYS = [
  "route",
  ...MEDIA_COUNTS.map((_unused, pointIndex) => `point:${pointIndex}`),
  "route",
];

const VIEWPORTS = [
  { label: "desktop", width: 1280, height: 800 },
  { label: "phone-portrait", width: 390, height: 844, isMobile: true, hasTouch: true },
  { label: "phone-landscape", width: 844, height: 390, isMobile: true, hasTouch: true },
];

const browser = await launchQaBrowser();
const checks = [];
let failed = false;

function record(name, detail) {
  checks.push({ name, ...detail });
  if (detail.failed) failed = true;
}

async function open({ viewport, reduceMotion = true }) {
  const page = await browser.newPage({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    isMobile: viewport.isMobile ?? false,
    hasTouch: viewport.hasTouch ?? false,
    reducedMotion: reduceMotion ? "reduce" : "no-preference",
  });
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  // Sample the stage on every attribute and child mutation. A blank seam is
  // exactly a sample where the chapter is on screen and carries neither its
  // caption nor anything in its media region, so it has to be observed as it
  // happens rather than polled for afterwards.
  await page.addInitScript(() => {
    const store = window;
    const trace = store.__qaPlaybackContinuity ?? { cameraTargets: [] };
    trace.samples = [];
    store.__qaPlaybackContinuity = trace;
    const sample = (overlay) => {
      const chapter = overlay.querySelector(".journey-playback__chapter");
      const mediaRegion = overlay.querySelector(".journey-playback__chapter-media");
      const presentation = mediaRegion?.querySelector(".playback-media-presentation");
      return {
        at: Date.now(),
        step: Number(overlay.getAttribute("data-playback-step")),
        phase: overlay.getAttribute("data-playback-phase"),
        density: overlay.getAttribute("data-playback-chapter-density"),
        hold: overlay.getAttribute("data-playback-hold"),
        hasChapter: Boolean(chapter),
        chapterPoint: chapter?.getAttribute("data-chapter-point") ?? null,
        hasCaption: Boolean(overlay.querySelector(".journey-playback__stop h3")),
        hasMediaRegion: Boolean(mediaRegion),
        hasMediaFrame: Boolean(presentation?.getAttribute("data-presented-asset")),
        requestedAsset: presentation?.getAttribute("data-requested-asset") ?? null,
        presentedAsset: presentation?.getAttribute("data-presented-asset") ?? null,
        sequencePrimary: presentation?.getAttribute("data-sequence-primary") ?? null,
        sequencePeekCount: Number(presentation?.getAttribute("data-sequence-peek-count") ?? 0),
        liveVideoCount: presentation?.querySelectorAll(".playback-media-presentation__slot video").length ?? 0,
        peekVideoCount: presentation?.querySelectorAll(".playback-media-presentation__peek video").length ?? 0,
      };
    };
    const push = (overlay) => {
      const entry = sample(overlay);
      const last = trace.samples[trace.samples.length - 1];
      if (last && Object.keys(entry).every((key) => key === "at" || last[key] === entry[key])) return;
      trace.samples.push(entry);
    };
    const attach = () => {
      const overlay = document.querySelector(".journey-playback");
      if (!overlay) return false;
      push(overlay);
      const observer = new MutationObserver(() => push(overlay));
      observer.observe(overlay, { attributes: true, childList: true, subtree: true });
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
  await page.route("**/api/uploads/assets/*/read-url", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      url: route.request().url().includes("st109-p4-m2") ? tinyVideo : onePixelGif,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }),
  }));

  const query = new URLSearchParams({
    qaState: "journey-playback",
    qaMode: "continuity",
    qaReduceMotion: reduceMotion ? "1" : "0",
  });
  await page.goto(`${origin}/?${query}`, { waitUntil: "domcontentloaded" });
  await page.locator(".journey-playback").waitFor({ state: "visible", timeout: 30_000 });
  return { page, consoleErrors, pageErrors };
}

const readTrace = (page) => page.evaluate(() => ({
  cameraTargets: [...(window.__qaPlaybackContinuity?.cameraTargets ?? [])],
  samples: [...(window.__qaPlaybackContinuity?.samples ?? [])],
}));

const currentStep = (page) => page.locator(".journey-playback").evaluate((overlay) => ({
  step: Number(overlay.getAttribute("data-playback-step")),
  phase: overlay.getAttribute("data-playback-phase"),
  density: overlay.getAttribute("data-playback-chapter-density"),
}));

async function pausePlayback(page) {
  const pause = page.locator('.journey-playback__controls button[aria-label="暂停播放"]');
  await pause.waitFor({ state: "attached", timeout: 10_000 });
  await pause.evaluate((button) => button.click());
  await page.locator('.journey-playback__controls button[aria-label="继续播放"]')
    .waitFor({ state: "attached", timeout: 5_000 });
}

async function clickTransport(page, label) {
  const control = page.locator(`.journey-playback__controls button[aria-label="${label}"]`);
  await control.evaluate((button) => button.click());
  // The reducer commits with the click's own render; one animation frame is
  // enough to read the committed beat without polling for a timing guess.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => (
    requestAnimationFrame(resolve)
  ))));
}

function describeStep(index) {
  const step = STEPS[index];
  if (!step) return `#${index}:unknown`;
  if (step.kind === "media") return `#${index}:media(${step.pointIndex},${step.mediaIndex})`;
  if (step.kind === "stop") return `#${index}:stop(${step.pointIndex},${densityFor(step.mediaCount)})`;
  if (step.kind === "travel") return `#${index}:travel(${step.pointIndex})`;
  return `#${index}:${step.kind}`;
}

// ── Manual navigation, both directions, on both viewports ────────────────────
for (const viewport of VIEWPORTS) {
  const run = await open({ viewport });
  try {
    await pausePlayback(run.page);
    // Return to the very first beat so the walk starts from a known position
    // however far autoplay reached before the pause landed.
    for (let rewind = 0; rewind < STEPS.length; rewind += 1) {
      await clickTransport(run.page, "上一个章节");
    }
    const start = await currentStep(run.page);

    const forward = [start.step];
    const forwardDensity = [start.density];
    // A media beat that is in the DOM but occupies no space is the blank
    // surface in its worst form: every readiness attribute says settled while
    // the viewer sees nothing. Measure the box, do not trust the markup.
    const collapsedMediaBeats = [];
    for (let click = 0; click < EXPECTED_MEANINGFUL.length; click += 1) {
      await clickTransport(run.page, "下一个章节");
      const landed = await currentStep(run.page);
      forward.push(landed.step);
      forwardDensity.push(landed.density);
      if (STEPS[landed.step]?.kind === "media") {
        const box = await run.page.locator(".journey-playback__media").first().boundingBox();
        if (!box || box.width <= 0 || box.height <= 0) {
          collapsedMediaBeats.push({ step: describeStep(landed.step), box });
        }
      }
    }
    record(`${viewport.label}:media-beat-occupies-the-stage`, {
      collapsed: collapsedMediaBeats,
      failed: collapsedMediaBeats.length > 0,
    });
    if (viewport.label === "phone-portrait") {
      const longNoteStep = STEPS.findIndex((candidate) => (
        candidate.kind === "media" && candidate.pointIndex === 1 && candidate.mediaIndex === 0
      ));
      // The fixture's single-media Route Point carries an intentionally long note.
      // Its caption must become the bounded scroll owner rather than collapsing
      // the fixed-height chapter media row.
      for (let rewind = 0; rewind < STEPS.length; rewind += 1) {
        await clickTransport(run.page, "上一个章节");
      }
      for (let step = 0; step < EXPECTED_MEANINGFUL.length; step += 1) {
        const landed = await currentStep(run.page);
        if (landed.step === longNoteStep) break;
        await clickTransport(run.page, "下一个章节");
      }
      const longNoteLayout = await run.page.evaluate(() => {
        const caption = document.querySelector(".journey-playback__stop");
        const note = caption?.querySelector("blockquote");
        const media = document.querySelector(".journey-playback__media");
        const mediaRect = media?.getBoundingClientRect();
        return {
          captionClientHeight: caption?.clientHeight ?? 0,
          captionScrollHeight: caption?.scrollHeight ?? 0,
          noteScrollHeight: note?.scrollHeight ?? 0,
          mediaHeight: mediaRect?.height ?? 0,
          stageHeight: document.querySelector(".journey-playback__stage")?.getBoundingClientRect().height ?? 0,
        };
      });
      record("compact-mobile:long-note-preserves-media-row", {
        ...longNoteLayout,
        failed: longNoteLayout.captionScrollHeight <= longNoteLayout.captionClientHeight
          || longNoteLayout.mediaHeight < Math.max(160, longNoteLayout.stageHeight * 0.45),
      });
      // Restore the same end-of-walk state used by the backward-navigation check.
      for (let advance = 0; advance < EXPECTED_MEANINGFUL.length; advance += 1) {
        await clickTransport(run.page, "下一个章节");
      }
    }
    // The walk clamps at the last meaningful beat, so the visited set is the
    // meaningful set and nothing else.
    const visitedForward = [...new Set(forward)];
    const forwardFailed = JSON.stringify(visitedForward) !== JSON.stringify(EXPECTED_MEANINGFUL);
    record(`${viewport.label}:meaningful-next`, {
      expected: EXPECTED_MEANINGFUL.map(describeStep),
      actual: visitedForward.map(describeStep),
      failed: forwardFailed,
    });

    // Every landing publishes the density of the chapter it is in, so an
    // `empty` arrival is graded as an arrival and not inferred from the DOM.
    const densityByStep = new Map(forward.map((step, index) => [step, forwardDensity[index]]));
    const densityFailed = EXPECTED_MEANINGFUL.some((stepIndex) => {
      const step = STEPS[stepIndex];
      if (step.kind !== "stop" && step.kind !== "media") return false;
      return densityByStep.get(stepIndex) !== densityFor(MEDIA_COUNTS[step.pointIndex]);
    });
    record(`${viewport.label}:published-chapter-density`, {
      observed: [...densityByStep].map(([step, density]) => `${describeStep(step)}=${density}`),
      failed: densityFailed,
    });

    const backward = [];
    for (let click = 0; click < EXPECTED_MEANINGFUL.length; click += 1) {
      await clickTransport(run.page, "上一个章节");
      backward.push((await currentStep(run.page)).step);
    }
    const visitedBackward = [...new Set(backward)].sort((left, right) => left - right);
    const backwardFailed = JSON.stringify(visitedBackward)
      !== JSON.stringify(EXPECTED_MEANINGFUL.slice(0, -1));
    record(`${viewport.label}:meaningful-previous`, {
      expected: EXPECTED_MEANINGFUL.slice(0, -1).map(describeStep),
      actual: visitedBackward.map(describeStep),
      failed: backwardFailed,
    });

    const trace = await readTrace(run.page);
    // An `empty` chapter must not mount a media stage or carousel at all.
    const emptyWithMedia = trace.samples.filter((entry) => (
      entry.density === "empty" && entry.hasMediaRegion
    ));
    record(`${viewport.label}:empty-chapter-has-no-media-stage`, {
      samples: emptyWithMedia.length,
      failed: emptyWithMedia.length > 0,
    });

    const sequencePointsWithPeek = [...new Set(trace.samples
      .filter((entry) => (
        entry.density === "sequence"
        && entry.presentedAsset === entry.requestedAsset
        && entry.sequencePeekCount > 0
      ))
      .map((entry) => Number(entry.chapterPoint))
      .filter(Number.isFinite))]
      .sort((left, right) => left - right);
    record(`${viewport.label}:sequence-chapters-show-bounded-peek`, {
      expectedPoints: [3, 4, 5],
      actualPoints: sequencePointsWithPeek,
      failed: JSON.stringify(sequencePointsWithPeek) !== JSON.stringify([3, 4, 5]),
    });

    const mixedVideoAsset = "st109-p4-m2";
    const mixedVideoSamples = trace.samples.filter((entry) => entry.requestedAsset === mixedVideoAsset);
    const mixedVideoSettled = mixedVideoSamples.some((entry) => (
      entry.presentedAsset === mixedVideoAsset
      && entry.liveVideoCount === 1
      && entry.peekVideoCount === 0
    ));
    record(`${viewport.label}:sequence-video-has-one-live-transport`, {
      samples: mixedVideoSamples.length,
      maxLiveVideos: Math.max(0, ...mixedVideoSamples.map((entry) => entry.liveVideoCount)),
      maxPeekVideos: Math.max(0, ...mixedVideoSamples.map((entry) => entry.peekVideoCount)),
      failed: !mixedVideoSettled
        || mixedVideoSamples.some((entry) => entry.liveVideoCount > 1 || entry.peekVideoCount > 0),
    });

    record(`${viewport.label}:manual-walk-clean`, {
      consoleErrors: run.consoleErrors,
      pageErrors: run.pageErrors,
      failed: run.consoleErrors.length > 0 || run.pageErrors.length > 0,
    });
  } finally {
    await run.page.close();
  }
}

// ── Sequence stack stress: rapid seek + tempo churn must stay current ─────────
{
  const run = await open({ viewport: VIEWPORTS[2], reduceMotion: false });
  try {
    await pausePlayback(run.page);
    for (let rewind = 0; rewind < STEPS.length; rewind += 1) {
      await clickTransport(run.page, "上一个章节");
    }
    const targetStep = STEPS.findIndex((candidate) => (
      candidate.kind === "media" && candidate.pointIndex === 5 && candidate.mediaIndex === 0
    ));
    for (let move = 0; move < EXPECTED_MEANINGFUL.length; move += 1) {
      if ((await currentStep(run.page)).step === targetStep) break;
      await clickTransport(run.page, "下一个章节");
    }
    await run.page.waitForFunction(() => (
      document.querySelector(".playback-media-presentation")?.getAttribute("data-media-presentation") === "settled"
    ));
    await run.page.locator('.journey-playback__controls button[aria-label="继续播放"]').evaluate((button) => button.click());

    const scrubber = run.page.locator('.journey-playback__progress input[type="range"]');
    const tempo = run.page.locator(".journey-playback__tempo select");
    await scrubber.press("ArrowRight");
    await tempo.selectOption("fast");
    await scrubber.press("ArrowRight");
    await tempo.selectOption("immersive");
    await scrubber.press("ArrowRight");
    await tempo.selectOption("standard");
    await run.page.waitForFunction(() => {
      const overlay = document.querySelector(".journey-playback");
      const presentation = document.querySelector(".playback-media-presentation");
      return overlay?.getAttribute("data-playback-chapter-density") === "sequence"
        && presentation?.getAttribute("data-media-presentation") === "settled"
        && presentation.getAttribute("data-sequence-primary") === presentation.getAttribute("data-requested-asset")
        && presentation.getAttribute("data-presented-asset") === presentation.getAttribute("data-requested-asset");
    }, null, { timeout: 10_000 });
    const final = await run.page.evaluate(() => {
      const overlay = document.querySelector(".journey-playback");
      const presentation = document.querySelector(".playback-media-presentation");
      return {
        step: Number(overlay?.getAttribute("data-playback-step")),
        density: overlay?.getAttribute("data-playback-chapter-density"),
        requested: presentation?.getAttribute("data-requested-asset"),
        presented: presentation?.getAttribute("data-presented-asset"),
        primary: presentation?.getAttribute("data-sequence-primary"),
        peeks: Number(presentation?.getAttribute("data-sequence-peek-count") ?? 0),
      };
    });
    record("phone-landscape:sequence-rapid-seek-tempo-stays-current", {
      ...final,
      failed: final.density !== "sequence" || final.primary !== final.requested
        || final.presented !== final.requested || final.peeks < 1,
    });
  } finally {
    await run.page.close();
  }
}

// ── One uninterrupted cinematic pass: the seam itself ────────────────────────
{
  const run = await open({ viewport: VIEWPORTS[0] });
  try {
    // `fast` keeps the whole fixture inside this lane's budget while playing
    // exactly the same beats in exactly the same order.
    await run.page.locator(".journey-playback__tempo select").selectOption("fast");
    await run.page.waitForFunction(() => (
      document.querySelector(".journey-playback")?.getAttribute("data-playback-phase") === "outro"
    ), null, { timeout: 90_000 });
    // #465: the final spatial focus commits when the media-to-map bridge settles.
    await run.page.waitForFunction(() => (
      window.__qaPlaybackContinuity?.cameraTargets.at(-1)?.key === "route"
    ));
    const trace = await readTrace(run.page);

    const cameraKeys = trace.cameraTargets.map((entry) => entry.key);
    const cameraFailed = JSON.stringify(cameraKeys) !== JSON.stringify(EXPECTED_CAMERA_KEYS);
    record("autoplay:no-same-point-refocus", {
      expected: EXPECTED_CAMERA_KEYS,
      actual: cameraKeys,
      failed: cameraFailed,
    });

    // A chapter beat with neither its caption nor anything in its media region
    // is the blank intermediate surface the issue forbids. A decode hold is not
    // one: the beat is deliberately waiting and the caption is still on screen.
    const blank = trace.samples.filter((entry) => (
      (entry.phase === "stop" || entry.phase === "media")
      && entry.hasChapter
      && !entry.hasCaption
    ));
    record("autoplay:caption-spans-the-arrival-media-seam", {
      samples: blank.length,
      failed: blank.length > 0,
    });

    // Leaving a populated chapter's last media must land on the next chapter's
    // travel/arrival, never on a beat of the point just left.
    const stepOrder = trace.samples
      .map((entry) => entry.step)
      .filter((step, index, all) => index === 0 || all[index - 1] !== step);
    const regressions = stepOrder.filter((step, index) => index > 0 && step < stepOrder[index - 1]);
    record("autoplay:advances-forward-only", {
      order: stepOrder.map(describeStep),
      failed: regressions.length > 0,
    });

    // Every media beat actually put a frame in the chapter's media region.
    const mediaBeats = new Set(trace.samples
      .filter((entry) => entry.phase === "media" && entry.hasMediaFrame)
      .map((entry) => entry.step));
    const expectedMediaBeats = STEPS.flatMap((step, index) => (
      step.kind === "media" ? [index] : []
    ));
    const missing = expectedMediaBeats.filter((step) => !mediaBeats.has(step));
    record("autoplay:no-media-omitted", {
      expected: expectedMediaBeats.map(describeStep),
      missing: missing.map(describeStep),
      failed: missing.length > 0,
    });

    record("autoplay:clean", {
      consoleErrors: run.consoleErrors,
      pageErrors: run.pageErrors,
      failed: run.consoleErrors.length > 0 || run.pageErrors.length > 0,
    });
  } finally {
    await run.page.close();
  }
}

// ── Reduced Motion changes presentation, never the chapter order ─────────────
{
  const run = await open({ viewport: VIEWPORTS[0], reduceMotion: false });
  try {
    await pausePlayback(run.page);
    for (let rewind = 0; rewind < STEPS.length; rewind += 1) {
      await clickTransport(run.page, "上一个章节");
    }
    const visited = [(await currentStep(run.page)).step];
    for (let click = 0; click < EXPECTED_MEANINGFUL.length; click += 1) {
      await clickTransport(run.page, "下一个章节");
      visited.push((await currentStep(run.page)).step);
    }
    const unique = [...new Set(visited)];
    record("motion-enabled:same-meaningful-moments", {
      expected: EXPECTED_MEANINGFUL.map(describeStep),
      actual: unique.map(describeStep),
      failed: JSON.stringify(unique) !== JSON.stringify(EXPECTED_MEANINGFUL),
    });
  } finally {
    await run.page.close();
  }
}

await browser.close();

for (const check of checks) {
  console.error(`[qa-playback-continuity] ${check.failed ? "FAIL" : "ok"} ${check.name} ${JSON.stringify({ ...check, name: undefined, failed: undefined })}`);
}
console.error(`[qa-playback-continuity] checks=${checks.length} failed=${checks.filter((check) => check.failed).length}`);
process.exit(failed ? 1 : 0);
