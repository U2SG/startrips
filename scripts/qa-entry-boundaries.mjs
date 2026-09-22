import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { launchQaBrowser } from "./qa-browser.mjs";

const baseUrl = process.env.QA_BASE_URL ?? process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
const outputDirectory = new URL("../artifacts/entry-boundaries/", import.meta.url);
const legacyModule = /^\/src\/(?:App\.tsx|data\/archiveRecords\.ts|experience\/|storage\/personalMoments\.ts|components\/(?:Archive|Artwork|Personal|GenerationProgress|PointPlacedConfirmation|SignalLog|SculptureCutout)|styles\/(?:legacy-shell|archive-shell|artwork-browser|personal-artifact|personal-gallery)\.css)/;
const results = [];
const browser = await launchQaBrowser({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

async function inspectFixture({ name, query, selector, legacy = false, width = 1280 }) {
  // Each family gets a fresh module cache, so an earlier fixture cannot hide a
  // dependency request. DOM readiness comes from the selected renderer.
  const context = await browser.newContext({
    viewport: { width, height: 800 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const requested = new Set();
  const pageErrors = [];
  page.on("request", (request) => requested.add(new URL(request.url()).pathname));
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    await page.goto(new URL(`/?${query}`, baseUrl).href, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator(selector).waitFor({ state: "visible", timeout: 15_000 });
    const presentation = await page.evaluate(() => {
      const shell = document.querySelector(".experience");
      const header = document.querySelector(".global-header");
      const archive = document.querySelector(".archive-shell");
      const style = (element) => element ? getComputedStyle(element) : null;
      return {
        legacyShells: document.querySelectorAll(".experience").length,
        shellPosition: style(shell)?.position ?? null,
        shellIsolation: style(shell)?.isolation ?? null,
        headerPosition: style(header)?.position ?? null,
        headerLeft: style(header)?.left ?? null,
        archivePosition: style(archive)?.position ?? null,
        archiveNodes: document.querySelectorAll(".archive-node").length,
      };
    });
    const legacyRequests = [...requested].filter((path) => legacyModule.test(path)).sort();
    const sample = { name, width, legacyRequests, pageErrors, presentation };
    results.push(sample);
    console.log(JSON.stringify(sample));
    assert.deepEqual(pageErrors, [], `${name}: browser errors`);
    if (legacy) {
      assert(requested.has("/src/App.tsx"), `${name}: legacy App was not loaded`);
      assert(requested.has("/src/styles/legacy-shell.css"), `${name}: legacy shell stylesheet was not loaded`);
      assert(requested.has("/src/styles/archive-shell.css"), `${name}: archive stylesheet was not loaded`);
      assert.equal(presentation.legacyShells, 1);
      assert.equal(presentation.shellPosition, "relative");
      assert.equal(presentation.shellIsolation, "isolate");
      assert.equal(presentation.headerPosition, "absolute");
      assert.equal(presentation.headerLeft, width <= 720 ? "20px" : "34px");
      assert.equal(presentation.archivePosition, "absolute");
      assert(presentation.archiveNodes > 0, `${name}: legacy archive content is absent`);
    } else {
      assert.deepEqual(legacyRequests, [], `${name}: product fixture loaded legacy modules`);
      assert.equal(presentation.legacyShells, 0);
    }
  } finally {
    await context.close();
  }
}

let failure;
try {
  await inspectFixture({
    name: "product-recovery",
    query: "qaState=recovery-surfaces&qaMode=empty",
    selector: '[data-qa-recovery-surface="empty"] .startrips-recovery-surface',
  });
  await inspectFixture({
    name: "product-composer",
    query: "qaState=journey-composer",
    selector: ".journey-composer",
  });
  await inspectFixture({
    name: "product-login",
    query: "qaState=login-v3&qaPhase=ready&qaLite=1",
    selector: ".auth-card--login-v3",
  });
  for (const width of [1280, 390]) {
    await inspectFixture({
      name: "legacy-archive",
      query: "qaState=archive-index",
      selector: ".archive-shell",
      legacy: true,
      width,
    });
  }
} catch (error) {
  failure = error;
} finally {
  await browser.close();
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(new URL("results.json", outputDirectory), JSON.stringify({
    failed: Boolean(failure),
    error: failure instanceof Error ? failure.message : failure ? String(failure) : null,
    results,
  }, null, 2), "utf8");
}
if (failure) throw failure;
