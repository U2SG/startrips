// Synthetic browser regression for the instrumentation race, run inside the
// existing last-spread suite. It does not replace any actual book pixel check.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { launchQaBrowser } from "./qa-browser.mjs";
import { settledBookSnapshot, flightBookSnapshot, waitForBookSnapshot } from "./qa-journey-book-readout.mjs";

export async function verifyBookReadoutRaces(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [], cases = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const book = { face: 78, spread: 39, sheets: 40, rects: { right: { left: 100, top: 30, width: 200, height: 300 } } };
  const flight = { progress: 1.5, following: false, sheetTop: 2, live: { top: 3, bottom: 0 } };
  const reset = async (readout) => {
    await page.setContent('<div class="journey-book-3d__stage" style="position:fixed;left:30px;top:20px;width:600px;height:400px"></div>');
    await page.evaluate((values) => Object.assign(document.querySelector(".journey-book-3d__stage").dataset, values), readout);
  };
  try {
    for (const [key, predicate, arg, value] of [
      ["qaBook", settledBookSnapshot, 78, book],
      ["qaBookFlight", flightBookSnapshot, { want: 1.5, tol: 0.01 }, flight],
    ]) {
      await reset({});
      assert.equal(await page.evaluate(predicate, arg), false);
      cases.push(`${key}: absent data is not a match`);
      for (const mutation of ["delete", "replace", "unmount"]) {
        await reset({ [key]: JSON.stringify(value) });
        const capturedPage = { async waitForFunction(fn, input, options) {
          const handle = await page.waitForFunction(fn, input, options);
          // Deterministically remove/change the attribute in the exact window
          // where the former implementation issued its second DOM read.
          await page.evaluate(({ kind, key }) => {
            const stage = document.querySelector(".journey-book-3d__stage");
            if (kind === "unmount") stage.remove();
            else if (kind === "delete") delete stage.dataset[key];
            else stage.dataset[key] = JSON.stringify({ face: 0, progress: 0, following: true });
          }, { kind: mutation, key });
          return handle;
        } };
        const result = await waitForBookSnapshot(capturedPage, `race ${key}/${mutation}`, predicate, arg, 30_000, 30_000);
        const expected = key === "qaBook" ? { ...book, stage: { left: 30, top: 20, width: 600, height: 400 } } : flight;
        assert.deepEqual(result, expected);
        assert.equal(await page.evaluate(predicate, arg), false, "current DOM is not the captured qualifying state");
        cases.push(`${key}: captured value survives ${mutation} after wait`);
      }
    }
    await reset({ qaBook: JSON.stringify({ ...book, face: 76 }), qaBookFlight: JSON.stringify({ ...flight, following: true }) });
    assert.equal(await page.evaluate(settledBookSnapshot, 78), false);
    assert.equal(await page.evaluate(flightBookSnapshot, { want: 1.5, tol: 0.01 }), false);
    cases.push("wrong face and following camera remain non-matches");
    assert.deepEqual(errors, []);
    return { cases, pageErrors: errors };
  } finally { await context.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const browser = await launchQaBrowser();
  try { console.log(JSON.stringify({ passed: true, ...await verifyBookReadoutRaces(browser) })); }
  finally { await browser.close(); }
}
