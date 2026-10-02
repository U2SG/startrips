// #596 browser QA: the Journey soundtrack really steps down under an audible
// foreground video, and really comes back afterwards.
//
// What this lane proves, and what it deliberately does not claim:
//
// The unit tests drive the controller with a fake clock and fake elements. They
// prove the policy and the state machine are correct, but not that the controller
// is actually attached inside the real Story, that a real <video> playing really
// triggers it, or that the real <audio> element really ends up at the ducked
// level. That is what this lane is for: it opens the production Story preview,
// plays a checked-in clip, and reads the volume back off the element the
// controller drives.
//
// `public/` ships no audio file, so the soundtrack's source never decodes here.
// That does not weaken what is verified: the contract is the volume written to
// the real element. This lane asserts that element's level under a real
// transport. It does not claim to measure anything audible.
//
// Two harness facts make the assertions possible at all:
//
// 1. The Story's autoplay is not sticky. Pause a video and it starts again on
//    its own, and the fixture clip can reach its end mid-window and restore the
//    soundtrack by itself. Either silently revokes the precondition the next
//    assertion is about, which is how a correct duck came to read as a failed
//    one. `holdTransport` enforces the state from the page for the duration of
//    the assertion, which is what a member holding a transport looks like.
// 2. A settled volume must be judged by ARRIVAL at a level this lane names,
//    not by "stopped moving". A linear ramp's last few milliseconds move less
//    than any sensible epsilon, so a movement test returns before the gain has
//    actually got there - which is exactly how a restore once reported the
//    ducked level it started from.
import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
// A real, checked-in clip the preview server can serve and play.
const PLAYABLE_VIDEO = "/demo-media/east-star-orbit.webm";
const onePixelGif = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
const MIXED_VIDEO_ASSET_ID = "00000000-0000-4000-8000-000000000152";
const DUCK_FACTOR = 0.3;
// Arrival is judged against the level the assertion names, so this tolerance
// only has to cover the last frame of a ramp, not the whole transition.
const SETTLED_TOLERANCE = 0.005;
const SETTLED_DRIFT = 0.001;
const SETTLED_STABLE_POLLS = 3;
const SETTLED_POLL_MS = 120;
// Bounded. Large enough to cover a 450ms release plus several polls on a slow
// runner, small enough that a failing assertion still reports within the lane's
// own budget instead of stalling the run.
const SETTLED_TIMEOUT_MS = 8_000;

const browser = await launchQaBrowser({
  // The product only auto-plays after a gesture, and this lane has to reach the
  // playing state to observe anything.
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const checks = [];
let failed = false;

function add(check) {
  checks.push(check);
  if (check.failed) failed = true;
}

/** The controller's published view of itself. DEV-only in the product. */
const controllerView = (page) => page.evaluate(() => {
  const raw = document.querySelector(".journey-story")?.dataset.qaSoundtrackDuck;
  return raw ? JSON.parse(raw) : null;
});

/**
 * Wait until the driven element ARRIVES at `expect`, and holds there.
 *
 * `expect` is the level this assertion requires. Passing null would mean "wherever
 * the controller currently wants to go", which cannot distinguish a duck from a
 * restore - freezing the transport to sample one changes the other.
 *
 * Returns `{ value, view }` and never throws: a timeout is a failed assertion,
 * not an aborted lane, so one run reports every check's evidence together
 * instead of stopping at the first failure and hiding the rest.
 */
async function settledVolume(page, label, expect) {
  const reached = await page.waitForFunction(
    ({ tolerance, stablePolls, drift, goal }) => {
      const surface = document.querySelector(".journey-story");
      const raw = surface?.dataset.qaSoundtrackDuck;
      if (!raw) return false;
      const view = JSON.parse(raw);
      if (view.elementVolume === null || !Number.isFinite(view.target)) return false;
      const arrived = Math.abs(view.elementVolume - goal) <= tolerance;
      const state = surface.dataset.qaVolumePoll ?? "";
      const previous = state === "" ? null : JSON.parse(state);
      const steady = previous !== null && Math.abs(view.elementVolume - previous.volume) <= drift;
      const stable = arrived && steady ? (previous?.stable ?? 0) + 1 : 0;
      surface.dataset.qaVolumePoll = JSON.stringify({
        volume: view.elementVolume, target: view.target, goal, stable,
      });
      return stable >= stablePolls;
    },
    { tolerance: SETTLED_TOLERANCE, stablePolls: SETTLED_STABLE_POLLS, drift: SETTLED_DRIFT, goal: expect },
    { polling: SETTLED_POLL_MS, timeout: SETTLED_TIMEOUT_MS },
  ).then(() => true).catch(() => false);
  const view = await controllerView(page).catch(() => null);
  return {
    value: reached ? (view?.elementVolume ?? null) : null,
    view,
    reached,
  };
}

/**
 * Hold every video in the requested transport state until released.
 * See the note at the top about autoplay not being sticky.
 */
async function holdTransport(page, playing) {
  await page.evaluate((wantPlaying) => {
    const key = "__qaTransportHold";
    window[key]?.stop?.();
    const apply = () => {
      for (const element of document.querySelectorAll("video")) {
        // `play()` on an element with no frame data returns a promise that
        // neither resolves nor rejects: the call looks successful and nothing
        // plays. After a re-key or a source change the element can sit at
        // readyState 0, so kick it back to NETWORK_EMPTY first and let it load.
        if (wantPlaying && element.readyState < 2 && element.networkState === 3) {
          element.load();
        }
        if (wantPlaying) {
          // A clip that reached its end would fire `ended` and hand the soundtrack
          // back, so rewind before that event can matter.
          if (element.ended) element.currentTime = 0;
          if (element.paused) element.play().catch(() => undefined);
        } else if (!element.paused) {
          element.pause();
        }
      }
    };
    apply();
    window[key] = { stop: () => window.clearInterval(window[key].timer), timer: window.setInterval(apply, 50) };
  }, playing);
  return async () => {
    // Whether the precondition actually took hold. A `play()` issued while the
    // element has no frame data yet returns a promise that neither resolves nor
    // rejects, so the call looks fine and nothing plays - the precondition would
    // silently not exist, and the controller would be right to leave the
    // soundtrack alone. Reporting it keeps "the fixture failed to hold the
    // transport" distinct from "the product did not duck".
    const held = await page.evaluate((wantPlaying) => {
      const videos = [...document.querySelectorAll("video")];
      return {
        wantPlaying,
        videos: videos.length,
        ready: videos.filter((element) => element.readyState >= 2).length,
        playing: videos.filter((element) => !element.paused && element.readyState >= 2).length,
        paused: videos.filter((element) => element.paused).length,
      };
    }, playing).catch(() => null);
    await page.evaluate(() => {
      const key = "__qaTransportHold";
      window[key]?.stop?.();
      window[key] = undefined;
    }).catch(() => undefined);
    return held;
  };
}

const currentIsVideo = (page) => page.evaluate(
  () => Boolean(document.querySelector('[data-media-page="current"] video')),
);

/** The Story's own keyboard navigation: focus the current page and step. */
async function stepMedia(page, key) {
  await page.evaluate((pressed) => {
    const current = document.querySelector('[data-media-page="current"]');
    if (!current) throw new Error("Story presented no current media page");
    if (current instanceof HTMLElement) current.focus();
    current?.dispatchEvent(new KeyboardEvent("keydown", { key: pressed, bubbles: true, cancelable: true }));
  }, key);
  await page.waitForTimeout(600);
}

async function openStory() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  await page.route("**/api/auth/get-session", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: "null",
  }));
  await page.route("**/api/uploads/assets/*/read-url", (route) => {
    const id = /\/assets\/([^/]+)\/read-url/.exec(new URL(route.request().url()).pathname)?.[1];
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        url: id === MIXED_VIDEO_ASSET_ID ? `${origin}${PLAYABLE_VIDEO}` : onePixelGif,
        expiresAt: "2026-09-01T00:00:00.000Z",
      }),
    });
  });
  await page.goto(`${origin}/?qaState=journey-story&qaMode=mixed-media`, { waitUntil: "domcontentloaded" });
  await page.locator(".journey-story").waitFor({ state: "visible" });
  // The fixture control sits behind the Story's modal backdrop and is inert, so
  // the click is dispatched rather than pointed. It is a fixture, not the thing
  // under test.
  await page.locator("[data-qa-story-attach-soundtrack]").dispatchEvent("click");
  await page.locator("audio").first().waitFor({ state: "attached", timeout: 10_000 });
  // Step to the video: the narrative opens on a photograph. The media-nav
  // control is what advances reliably from the opening page; keyboard stepping
  // is used later, between pages already reached this way.
  for (let step = 0; step < 6; step += 1) {
    if (await currentIsVideo(page)) break;
    await page.evaluate(() => {
      document.querySelector('.journey-story__media-nav button[aria-pressed="false"]')?.click();
    });
    await page.waitForTimeout(450);
  }
  await page.locator("video[data-shared-media-id]").first().waitFor({ state: "attached", timeout: 15_000 });
  return page;
}

try {
  const page = await openStory();
  try {
    {
      const release = await holdTransport(page, false);
      const rest = await settledVolume(page, "rest", 1);
      await release();
      add({
        name: "soundtrack-holds-the-member-level-without-a-video",
        volume: rest.value,
        view: rest.view,
        failed: rest.value === null || Math.abs(rest.value - 1) > SETTLED_TOLERANCE,
      });
    }
    {
      const release = await holdTransport(page, true);
      const ducked = await settledVolume(page, "audible duck", DUCK_FACTOR);
      await release();
      add({
        name: "an-audible-foreground-video-ducks-the-soundtrack",
        volume: ducked.value,
        expected: DUCK_FACTOR,
        view: ducked.view,
        failed: ducked.value === null || Math.abs(ducked.value - DUCK_FACTOR) > 0.02,
      });
    }
    {
      const release = await holdTransport(page, false);
      const paused = await settledVolume(page, "pause restore", 1);
      await release();
      add({
        name: "pausing-the-video-restores-the-soundtrack",
        volume: paused.value,
        view: paused.view,
        failed: paused.value === null || Math.abs(paused.value - 1) > SETTLED_TOLERANCE,
      });
    }
    {
      // Mute while still playing, then unmute - both held, so autoplay cannot
      // turn the first into "a paused video" and the second into nothing.
      const releaseMute = await holdTransport(page, true);
      await page.evaluate(() => {
        const element = document.querySelector("video[data-shared-media-id]") ?? document.querySelector("video");
        if (element) element.muted = true;
      });
      const afterMute = (await settledVolume(page, "mute restore", 1));
      await page.evaluate(() => {
        const element = document.querySelector("video[data-shared-media-id]") ?? document.querySelector("video");
        if (element) element.muted = false;
      });
      const afterUnmute = (await settledVolume(page, "unmute duck", DUCK_FACTOR));
      await releaseMute();
      add({
        name: "muting-restores-and-unmuting-ducks-again",
        afterMute: afterMute.value,
        afterUnmute: afterUnmute.value,
        view: afterUnmute.view,
        failed: afterMute.value === null || Math.abs(afterMute.value - 1) > SETTLED_TOLERANCE
          || afterUnmute.value === null || Math.abs(afterUnmute.value - DUCK_FACTOR) > 0.02,
      });
    }
    {
      // Resume: hold "stopped", then hold "playing" and require the duck.
      const releasePause = await holdTransport(page, false);
      const afterPauseAgain = (await settledVolume(page, "second pause", 1)).value;
      await releasePause();
      const releaseResume = await holdTransport(page, true);
      const resumed = await settledVolume(page, "resume duck", DUCK_FACTOR);
      // Simulate ending WITHOUT poisoning the page. `ended` is a read-only getter on
      // HTMLMediaElement.prototype, so an own property installed here outlives
      // the assertion and makes every later check on this page see a permanently
      // ended element - which reads as "the foreground never plays again" and
      // looks exactly like a product failure. It is deleted straight after.
      const endedIds = await page.evaluate(() => {
        let marked = 0;
        for (const element of document.querySelectorAll("video")) {
          Object.defineProperty(element, "ended", { value: true, configurable: true });
          marked += 1;
        }
        return marked;
      });
      const endedSample = await settledVolume(page, "ended restore", 1);
      await page.evaluate(() => {
        for (const element of document.querySelectorAll("video")) {
          // Back to the real getter rather than a pinned value.
          if (Object.prototype.hasOwnProperty.call(element, "ended")) delete element.ended;
        }
      });
      const heldResume = await releaseResume();
      add({
        name: "resume-ducks-again-and-ended-restores",
        afterPauseAgain,
        afterResume: resumed.value,
        afterEnded: endedSample.value,
        view: endedSample.view,
        held: heldResume,
        endedMarked: endedIds,
        failed: afterPauseAgain === null || Math.abs(afterPauseAgain - 1) > SETTLED_TOLERANCE
          || resumed.value === null || Math.abs(resumed.value - DUCK_FACTOR) > 0.02
          || endedSample.value === null || Math.abs(endedSample.value - 1) > SETTLED_TOLERANCE,
      });
    }
    {
      // A re-keyed soundtrack is a new element at the browser default; it must be
      // re-ducked, not left audible.
      const releaseSwap = await holdTransport(page, true);
      await page.locator("[data-qa-story-attach-soundtrack]").dispatchEvent("click");
      const remount = await settledVolume(page, "soundtrack remount", DUCK_FACTOR);
      const heldOk = await releaseSwap();
      add({
        name: "a-replacement-soundtrack-is-ducked-not-left-at-full-volume",
        volume: remount.value,
        // The whole controller view, because the interesting question after a
        // re-key is whether the foreground video is still recognised at all.
        view: remount.view,
        held: heldOk,
        failed: remount.value === null || Math.abs(remount.value - DUCK_FACTOR) > 0.02,
      });
    }
    {
      // image -> video -> image. Navigation is a synthetic key, which is not user
      // intent, so the transport is held per phase instead of trusted to stop.
      for (let step = 0; step < 4 && await currentIsVideo(page); step += 1) {
        await stepMedia(page, "ArrowRight");
      }
      const onPhoto = !(await currentIsVideo(page));
      const releaseLeave = await holdTransport(page, false);
      const leaving = await settledVolume(page, "leave restore", 1);
      await releaseLeave();
      for (let step = 0; step < 4 && !(await currentIsVideo(page)); step += 1) {
        await stepMedia(page, "ArrowLeft");
      }
      const releaseBack = await holdTransport(page, true);
      const comingBack = await settledVolume(page, "return duck", DUCK_FACTOR);
      const heldBack = await releaseBack();
      add({
        name: "image-to-video-to-image-restores-between-videos",
        onPhoto,
        afterLeavingVideo: leaving.value,
        afterComingBack: comingBack.value,
        view: leaving.view,
        heldBack,
        failed: !onPhoto
          || leaving.value === null || Math.abs(leaving.value - 1) > SETTLED_TOLERANCE
          || comingBack.value === null || Math.abs(comingBack.value - DUCK_FACTOR) > 0.02,
      });
    }
    {
      const releaseRapid = await holdTransport(page, true);
      await stepMedia(page, "ArrowRight");
      await stepMedia(page, "ArrowLeft");
      await stepMedia(page, "ArrowRight");
      const rapid = await settledVolume(page, "rapid swap", DUCK_FACTOR);
      const heldRapid = await releaseRapid();
      add({
        name: "a-rapid-video-photo-video-swap-settles-on-the-ducked-level",
        afterRapidSwap: rapid.value,
        view: rapid.view,
        held: heldRapid,
        failed: rapid.value === null || Math.abs(rapid.value - DUCK_FACTOR) > 0.02,
      });
    }
  } finally {
    await page.close();
  }

  // #596 requires the fullscreen hand-off, on its own page: the checks above
  // deliberately hold and release transports and re-key the soundtrack, and
  // leaving the Story in that state made the immersive entry unavailable - which
  // would have been reported as "the hand-off does not work".
  const immersivePage = await openStory();
  try {
    // The entry is the Story's own immersive control, located by class rather than
    // by its localized label. Clicking the picture itself does not open it.
    const inImmersive = await immersivePage
      .locator(".journey-story__fullscreen-entry, .journey-story__mobile-media-fullscreen")
      .first()
      .click({ timeout: 15_000 })
      .then(() => immersivePage.locator(".journey-story-fullscreen")
        .waitFor({ state: "visible", timeout: 15_000 }))
      .then(() => true)
      .catch(() => false);
    const soundtracksInImmersive = inImmersive
      ? await immersivePage.evaluate(() => document.querySelectorAll("audio").length)
      : null;
    const release = await holdTransport(immersivePage, true);
    const inImmersiveSample = inImmersive
      ? await settledVolume(immersivePage, "immersive duck", DUCK_FACTOR)
      : { value: null, view: null };
    await release();
    const view = inImmersiveSample.view ?? (await controllerView(immersivePage));
    add({
      // The stage hands off the SAME element rather than creating a second one,
      // so the duck must follow it in with no second controller appearing - the
      // issue's "fullscreen must not establish a second ducking state".
      name: "the-immersive-stage-ducks-without-a-second-soundtrack",
      inImmersive,
      soundtracksInImmersive,
      sameElement: view?.drivesElement !== false,
      inImmersiveVolume: inImmersiveSample.value,
      view,
      failed: !inImmersive
        || soundtracksInImmersive !== 1
        || view?.drivesElement === false
        || inImmersiveSample.value === null
        || Math.abs(inImmersiveSample.value - DUCK_FACTOR) > 0.02,
    });
  } finally {
    await immersivePage.close();
  }
} catch (error) {
  // The accumulated checks are this lane's only diagnostic record; a thrown
  // step must not take them down with it. Print first, then rethrow unchanged.
  console.log(JSON.stringify(checks, null, 2));
  throw error;
} finally {
  await browser.close();
}

console.log(JSON.stringify(checks, null, 2));
if (failed) process.exit(1);