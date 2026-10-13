// QA-only helpers. Page functions must be self-contained: Playwright serializes
// them into the browser without their module scope.

/** Read and qualify the exact same settled-book snapshot in one browser task. */
export function settledBookSnapshot(want) {
  const stage = document.querySelector(".journey-book-3d__stage");
  const raw = stage?.dataset.qaBook;
  if (!raw) return false; // absent while unsettled; never parse undefined
  const book = JSON.parse(raw); // malformed instrumentation must still fail
  if (book.face !== want) return false;
  const box = stage.getBoundingClientRect();
  return { ...book, stage: { left: box.left, top: box.top, width: box.width, height: box.height } };
}

/** The flight's progress condition and returned evidence cannot come from different frames. */
export function flightBookSnapshot({ want, tol }) {
  const raw = document.querySelector(".journey-book-3d__stage")?.dataset.qaBookFlight;
  if (!raw) return false;
  const flight = JSON.parse(raw);
  return Math.abs(flight.progress - want) <= tol && !flight.following ? flight : false;
}

/** Resolve as `promise` does, or reject naming `label` after `ms`. */
export async function bounded(label, promise, ms = 30_000) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: no answer within ${ms} ms`)), ms);
  });
  try { return await Promise.race([promise, expired]); }
  finally { clearTimeout(timer); }
}

/** Consume the value captured by the successful predicate, not a new DOM evaluation. */
export async function waitForBookSnapshot(page, label, predicate, arg, timeoutMs, readTimeoutMs) {
  const handle = await page.waitForFunction(predicate, arg, { timeout: timeoutMs });
  try {
    return await bounded(`${label}: read captured snapshot`, handle.jsonValue(), readTimeoutMs);
  } finally {
    await bounded(`${label}: release captured snapshot`, handle.dispose(), readTimeoutMs);
  }
}
