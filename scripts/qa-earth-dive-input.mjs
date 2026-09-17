/** Stop fixture input while readiness catches up inside the blend band.
 * The test pins this fixture position inside the product's actual blend cuts.
 */
export const DIVE_FIXTURE_PARK_PROGRESS = 0.6;

export function nextDiveFixtureInput(state, requestedDelta, fineDelta, parkBlending = false) {
  if (parkBlending && state.stage === "detail") {
    throw new Error("Dive fixture passed blending before measurement; refusing further detail zoom");
  }
  if (parkBlending && state.semanticZoom === "local"
      && Number(state.localProgress) >= DIVE_FIXTURE_PARK_PROGRESS) {
    return { kind: "wait-blending" };
  }
  // Coarse input near the end of regional can cross the entire local band.
  return { kind: "wheel", deltaY: requestedDelta < 0 && state.semanticZoom === "regional"
    ? Math.max(requestedDelta, fineDelta) : requestedDelta };
}

export async function acknowledgedDiveWheel(page, point, deltaY) {
  await page.mouse.move(point.x, point.y);
  const before = await page.evaluate(() => window.__qaEarthDiveWheelEvents?.length ?? null);
  if (!Number.isInteger(before)) throw new Error("Dive wheel recorder is unavailable");
  await page.mouse.wheel(0, deltaY);
  // Wait for real native delivery, then renderer publication, not an assumed
  // 100ms sleep. No synthetic event, repeat gesture, or increased retry count.
  await page.waitForFunction(
    (count) => (window.__qaEarthDiveWheelEvents?.length ?? 0) > count,
    before,
    { timeout: 5_000 },
  );
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

// This callback is serialized into the browser by Playwright. A renderer's
// post-sync metadata arrives before React publishes the reveal presentation.
// Waiting for a published result does not require it to be correct: both on/off
// return true so the caller still rejects a wrong reduced-motion mask.
export function hasPublishedDiveReveal() {
  const map = document.querySelector(".detailed-earth-map");
  const layer = document.querySelector(".living-atlas-globe__detail-layer");
  const mode = layer?.getAttribute("data-earth-dive-spatial-reveal");
  const revision = Number(map?.getAttribute("data-map-reveal-revision"));
  return map?.getAttribute("data-map-reveal-stage") === "blending"
    && revision > 0
    && Number(map.getAttribute("data-map-post-sync-render-revision")) === revision
    && mode != null && mode !== "holding";
}
