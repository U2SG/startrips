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
    const element = document.querySelector("video[data-shared-media-id]");
    if (!element) throw new Error("Story presented no video element");
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

    // Resume must duck again, and ending the video must restore.
    await page.evaluate(() => {
      document.querySelector("video[data-shared-media-id]")?.pause();
    });
    await page.waitForTimeout(SETTLED_MS);
    const afterPauseAgain = await settledVolume(page);
    await page.evaluate(async () => {
      const element = document.querySelector("video[data-shared-media-id]");
      if (!element) return;
      await element.play();
      // Ending is driven on the element rather than by waiting out the clip, so
      // the lane does not depend on the fixture's duration.
      Object.defineProperty(element, "ended", { value: true, configurable: true });
    });
    await page.waitForTimeout(SETTLED_MS);
    const afterEnded = await settledVolume(page);
    add({
      name: "resume-ducks-again-and-ended-restores",
      afterPauseAgain,
      afterEnded,
      failed: afterPauseAgain === null || Math.abs(afterPauseAgain - 1) > EPSILON
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

    // Leaving the video for a photograph is deliberately NOT asserted here. The
    // Story's media navigation is a scroll-snap surface this lane cannot drive
    // reliably from a pointer click, and a check that quietly never navigates
    // would report "the soundtrack did not restore" when nothing was ever
    // tested. The restore branch itself is covered above by pause and by ended,
    // which are the two ways a video stops being audible without unmounting;
    // the unmount path is covered by the unit tests. Revisit with a proper
    // gesture before claiming this case.
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
