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
// plays a checked-in clip, and reads the volume back off the real element.
//
// `public/` ships no audio file, so the soundtrack's source never decodes here.
// That does not weaken what is being verified: the contract is the volume the
// controller writes to the element, and a real element's `volume` is exactly
// that. This lane asserts the element's level under a real transport. It does
// not claim to measure anything audible, and it should not be described as
// doing so.
import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
// A real, checked-in clip the preview server can actually serve and play.
const PLAYABLE_VIDEO = "/demo-media/east-star-orbit.webm";
const onePixelGif = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
const MIXED_VIDEO_ASSET_ID = "00000000-0000-4000-8000-000000000152";
const DUCK_FACTOR = 0.3;
// The policy allows up to 300ms to duck and 600ms to restore; observe past both
// so a slow machine cannot be read as a regression.
const SETTLED_MS = 1_200;
const EPSILON = 0.01;

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

async function openStory() {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  await page.route("**/api/auth/get-session", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: "null",
  }));
  await page.route("**/api/uploads/assets/*/read-url", (route) => {
    const id = /\/assets\/([^/]+)\/read-url/.exec(new URL(route.request().url()).pathname)?.[1];
    const url = id === MIXED_VIDEO_ASSET_ID
      ? `${origin}${PLAYABLE_VIDEO}`
      : onePixelGif;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ url, expiresAt: "2026-09-01T00:00:00.000Z" }),
    });
  });
  await page.goto(`${origin}/?qaState=journey-story&qaMode=mixed-media`, { waitUntil: "domcontentloaded" });
  await page.locator(".journey-story").waitFor({ state: "visible" });
  // The soundtrack reaches Story through the upload pipeline, which is far more
  // machinery than this lane is verifying. The preview exposes a direct attach
  // affordance for exactly that reason.
  // The Story is a modal, so the preview's fixture controls sit behind its
  // backdrop and are marked inert. Dispatching the click reaches the handler
  // without pretending this lane is testing the button's hit area.
  await page.locator("[data-qa-story-attach-soundtrack]").dispatchEvent("click");
  await page.locator("audio").first().waitFor({ state: "attached", timeout: 10_000 });
  return page;
}

/** The Story's own keyboard navigation: focus the current page and step. */
async function stepMedia(page, key) {
  await page.evaluate(async (pressed) => {
    const current = document.querySelector('[data-media-page="current"]');
    if (!current) throw new Error("Story presented no current media page");
    if (current instanceof HTMLElement) current.focus();
    current?.dispatchEvent(new KeyboardEvent("keydown", {
      key: pressed,
      bubbles: true,
      cancelable: true,
    }));
  }, key);
  await page.waitForTimeout(600);
}

const currentIsVideo = (page) => page.evaluate(
  () => Boolean(document.querySelector('[data-media-page="current"] video')),
);

const videoPresented = (page) => page.evaluate(
  () => Boolean(document.querySelector("video[data-shared-media-id]")),
);

const soundtrackVolume = (page) => page.evaluate(
  () => document.querySelector("audio")?.volume ?? null,
);

/** Wait until the real soundtrack element stops moving. */
async function settledVolume(page) {
  await page.waitForFunction(
    (epsilon) => {
      const audio = document.querySelector("audio");
      if (!audio) return false;
      const seen = audio.dataset.qaLastVolume;
      if (seen === undefined || Math.abs(audio.volume - Number(seen)) > epsilon) {
        audio.dataset.qaLastVolume = String(audio.volume);
        return false;
      }
      return true;
    },
    EPSILON,
    { polling: 120, timeout: 8_000 },
  );
  return soundtrackVolume(page);
}

/** Put the real video into a genuinely audible, playing state. */
async function playAudibly(page) {
  await page.evaluate(async () => {
    // The immersive stage does not necessarily tag its element the way the
    // inline one does, so fall back to any video rather than insisting on a
    // particular attribute.
    const element = document.querySelector("video[data-shared-media-id]") ?? document.querySelector("video");
    if (!element) return;
    Object.defineProperty(element, "ended", { value: false, configurable: true });
    element.muted = false;
    element.volume = 1;
    await element.play();
  });
}

try {
  const page = await openStory();
  try {
    const audio = page.locator("audio").first();
    await audio.waitFor({ state: "attached", timeout: 10_000 });
    // The narrative opens on its first asset, which is a photograph. Step to the
    // video rather than assuming one is already presented, so the lane does not
    // silently prove nothing when the opening page changes.
    for (let step = 0; step < 6; step += 1) {
      if (await videoPresented(page)) break;
      await page.evaluate(() => {
        document.querySelector('.journey-story__media-nav button[aria-pressed="false"]')?.click();
      });
      await page.waitForTimeout(400);
    }
    const video = page.locator("video[data-shared-media-id]").first();
    await video.waitFor({ state: "attached", timeout: 10_000 });

    // The narrative auto-plays, so silence the transport before claiming the
    // soundtrack is at rest. Asserting "not ducked" while the video is still
    // playing would be asserting nothing.
    await page.evaluate(() => document.querySelector("video[data-shared-media-id]")?.pause());
    await page.waitForTimeout(SETTLED_MS);
    const atRest = await settledVolume(page);
    add({
      name: "soundtrack-holds-the-member-level-without-a-video",
      volume: atRest,
      failed: atRest === null || Math.abs(atRest - 1) > EPSILON,
    });

    // Make the real element audible and let the controller duck it. The
    // soundtrack's own source never decodes here (public/ ships no audio), so
    // the observation is the element's volume, not audible output.
    await page.evaluate(async () => {
      const element = document.querySelector("video[data-shared-media-id]");
      if (!element) throw new Error("Story presented no video element");
      element.muted = false;
      element.volume = 1;
      await element.play();
    });
    await page.waitForTimeout(SETTLED_MS);
    const ducked = await settledVolume(page);
    add({
      name: "an-audible-foreground-video-ducks-the-soundtrack",
      volume: ducked,
      expected: DUCK_FACTOR,
      failed: ducked === null || Math.abs(ducked - DUCK_FACTOR) > 0.02,
    });

    // Pausing the video must bring the soundtrack back.
    await page.evaluate(() => document.querySelector("video[data-shared-media-id]")?.pause());
    await page.waitForTimeout(SETTLED_MS);
    const afterPause = await settledVolume(page);
    add({
      name: "pausing-the-video-restores-the-soundtrack",
      volume: afterPause,
      failed: afterPause === null || Math.abs(afterPause - 1) > EPSILON,
    });

    // Mute must restore, and unmuting must duck again. Both while the video is
    // still playing: a muted *paused* video is not audible either way, so
    // running this after the pause case would prove nothing.
    await playAudibly(page);
    await page.waitForTimeout(SETTLED_MS);
    await page.evaluate(() => {
      const element = document.querySelector("video[data-shared-media-id]");
      if (element) element.muted = true;
    });
    await page.waitForTimeout(SETTLED_MS);
    const afterMute = await settledVolume(page);
    await page.evaluate(() => {
      const element = document.querySelector("video[data-shared-media-id]");
      if (element) element.muted = false;
    });
    await page.waitForTimeout(SETTLED_MS);
    const afterUnmute = await settledVolume(page);
    add({
      name: "muting-restores-and-unmuting-ducks-again",
      afterMute,
      afterUnmute,
      failed: afterMute === null || Math.abs(afterMute - 1) > EPSILON
        || afterUnmute === null || Math.abs(afterUnmute - DUCK_FACTOR) > 0.02,
    });

    // Resume must duck again, and ending the video must restore. The ducked
    // level has to be sampled BETWEEN the resume and the end: marking the
    // element ended straight after play() would make this pass even if resume
    // never ducked at all.
    await page.evaluate(() => {
      document.querySelector("video[data-shared-media-id]")?.pause();
    });
    await page.waitForTimeout(SETTLED_MS);
    const afterPauseAgain = await settledVolume(page);
    await playAudibly(page);
    // The stage re-settles after a pause before the video counts as the
    // presented one again, so wait for the duck rather than sampling a fixed
    // moment that can land before the settle finishes.
    const resumedDucked = await page.waitForFunction(
      (limit) => (document.querySelector("audio")?.volume ?? 1) < limit,
      0.5,
      { polling: 150, timeout: 15_000 },
    ).then(() => true).catch(() => false);
    const afterResume = await settledVolume(page);
    await page.evaluate(() => {
      const element = document.querySelector("video[data-shared-media-id]");
      if (!element) return;
      Object.defineProperty(element, "ended", { value: true, configurable: true });
    });
    await page.waitForTimeout(SETTLED_MS);
    const afterEnded = await settledVolume(page);
    add({
      name: "resume-ducks-again-and-ended-restores",
      afterPauseAgain,
      resumedDucked,
      afterResume,
      afterEnded,
      failed: afterPauseAgain === null || Math.abs(afterPauseAgain - 1) > EPSILON
        || !resumedDucked
        || afterResume === null || Math.abs(afterResume - DUCK_FACTOR) > 0.02
        || afterEnded === null || Math.abs(afterEnded - 1) > EPSILON,
    });

    // And a replacement soundtrack element must not be left at the browser
    // default while a video is still audible. This is the reported P2.
    await playAudibly(page);
    // Only swap once the duck is actually observable, or the assertion below
    // would be measuring a transport that was never audible to begin with.
    await page.waitForFunction(
      (limit) => (document.querySelector("audio")?.volume ?? 1) < limit,
      0.5,
      { polling: 120, timeout: 8_000 },
    ).catch(() => undefined);
    const reDucked = await settledVolume(page);
    // Swap the soundtrack's identity, which is what makes a Journey re-key the
    // element and genuinely remount it. Replacing the node directly would leave
    // React's ref pointing at a detached element and would prove nothing about
    // the controller.
    await page.locator("[data-qa-story-attach-soundtrack]").dispatchEvent("click");
    await page.waitForFunction(
      (epsilon) => {
        const audio = document.querySelector("audio");
        if (!audio) return false;
        const seen = audio.dataset.qaLastVolume;
        if (seen === undefined || Math.abs(audio.volume - Number(seen)) > epsilon) {
          audio.dataset.qaLastVolume = String(audio.volume);
          return false;
        }
        return true;
      },
      EPSILON,
      { polling: 120, timeout: 8_000 },
    ).catch(() => undefined);
    const afterReplacement = await settledVolume(page);
    add({
      name: "a-replacement-soundtrack-is-ducked-not-left-at-full-volume",
      volume: afterReplacement,
      duckedBeforeSwap: reDucked,
      failed: afterReplacement === null
        || Math.abs(afterReplacement - DUCK_FACTOR) > 0.02
        || Math.abs(afterReplacement - 1) <= EPSILON,
    });

    // Leaving a video for a photograph must restore, and coming back must duck
    // again. The Story's own keyboard navigation is used rather than a nav-dot
    // click: the media surface is a scroll-snap carousel, and a click there is
    // not a reliable way to change chapter.
    for (let step = 0; step < 4 && await currentIsVideo(page); step += 1) {
      await stepMedia(page, "ArrowRight");
    }
    const onPhoto = !(await currentIsVideo(page));
    // A navigated-away video is not stopped instantly, and while it is still
    // playing the soundtrack is right to stay ducked. Wait for the transport to
    // actually stop before asserting the restore - and report it when it never
    // does, because a video that keeps playing under a photograph is a finding
    // of its own rather than something to assert around.
    const videoStopped = await page.waitForFunction(
      () => ![...document.querySelectorAll("video")].some((element) => !element.paused),
      undefined,
      { polling: 150, timeout: 15_000 },
    ).then(() => true).catch(() => false);
    // Record why the soundtrack did or did not move. A lane that only asserts a
    // volume cannot tell "did not restore" from "the video is still audible".
    const probe = await page.evaluate(() => [...document.querySelectorAll("video")].map((element) => ({
      sharedMediaId: element.dataset.sharedMediaId ?? null,
      hidden: element.hidden,
      paused: element.paused,
      readyState: element.readyState,
      currentTime: Number(element.currentTime.toFixed(2)),
      volume: element.volume,
      muted: element.muted,
    })));
    const afterLeavingVideo = await settledVolume(page);
    // The controller's own view at the moment the restore should have happened.
    // Without it, "the volume did not move" cannot be told apart from "the
    // target is still ducked" or "the baseline itself drifted to that level".
    const controllerView = await page.evaluate(() => {
      const raw = document.querySelector(".journey-story")?.dataset.qaSoundtrackDuck;
      return raw ? JSON.parse(raw) : null;
    });
    for (let step = 0; step < 4 && !(await currentIsVideo(page)); step += 1) {
      await stepMedia(page, "ArrowLeft");
    }
    await playAudibly(page);
    await page.waitForTimeout(SETTLED_MS);
    const afterComingBack = await settledVolume(page);
    add({
      name: "image-to-video-to-image-restores-between-videos",
      onPhoto,
      videoStopped,
      controllerView,
      probe,
      afterLeavingVideo,
      afterComingBack,
      failed: !onPhoto
        || !videoStopped
        || afterLeavingVideo === null || Math.abs(afterLeavingVideo - 1) > EPSILON
        || afterComingBack === null || Math.abs(afterComingBack - DUCK_FACTOR) > 0.02,
    });

    // Rapid video A -> photograph -> video B. The superseded transport's state
    // must not leave the gain parked at the level it happened to be at.
    const beforeSwap = await settledVolume(page);
    await stepMedia(page, "ArrowRight");
    await stepMedia(page, "ArrowLeft");
    await stepMedia(page, "ArrowRight");
    await playAudibly(page);
    await page.waitForTimeout(SETTLED_MS);
    const afterRapidSwap = await settledVolume(page);
    add({
      name: "a-rapid-video-photo-video-swap-settles-on-the-ducked-level",
      beforeSwap,
      afterRapidSwap,
      failed: afterRapidSwap === null || Math.abs(afterRapidSwap - DUCK_FACTOR) > 0.02,
    });

    // The immersive stage hands off the SAME element rather than creating a
    // second one, so the duck must follow it there without a second controller
    // appearing - the issue's "fullscreen must not establish a second ducking
    // state".
    // The immersive hand-off is deliberately NOT asserted here. Clicking the
    // current media page did not enter the immersive stage in this lane
    // (`fullscreenVisible` came back false), so anything measured afterwards
    // would describe a surface that was never opened - reporting "the immersive
    // stage has no soundtrack" from a run that never entered it would be a
    // fabricated finding. The hand-off moves the same element rather than
    // creating a second one, and the controller has one owner per surface, but
    // that remains unverified in a real browser and needs the correct immersive
    // entry affordance before it can be claimed.
  } finally {
    await page.close();
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
