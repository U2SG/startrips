import { launchQaBrowser } from "./qa-browser.mjs";

const baseUrl = process.env.QA_BASE_URL ?? "http://127.0.0.1:4173";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function exifImage() {
  // A genuine JPEG APP1/TIFF coordinate + timezone + accuracy fixture:
  // 22.2783194 N, 114.17469 E, August 30 2026 at +08.
  const bytes = new Uint8Array(2 + 2 + 2 + 6 + 336 + 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset, value) => {
    for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i);
    bytes[offset + value.length] = 0;
  };
  const entry = (offset, tag, type, count, value, inline = null) => {
    view.setUint16(offset, tag, true);
    view.setUint16(offset + 2, type, true);
    view.setUint32(offset + 4, count, true);
    if (inline !== null) {
      for (let i = 0; i < 4; i++) view.setUint8(offset + 8 + i, inline.charCodeAt(i) || 0);
    } else view.setUint32(offset + 8, value, true);
  };
  const rationals = (offset, values) => {
    values.forEach(([numerator, denominator], index) => {
      view.setUint32(offset + index * 8, numerator, true);
      view.setUint32(offset + index * 8 + 4, denominator, true);
    });
  };
  bytes[0] = 0xff; bytes[1] = 0xd8; bytes[2] = 0xff; bytes[3] = 0xe1;
  view.setUint16(4, 344, false);
  ascii(6, "Exif");
  const tiff = 12;
  bytes[tiff] = 0x49; bytes[tiff + 1] = 0x49;
  view.setUint16(tiff + 2, 42, true);
  view.setUint32(tiff + 4, 8, true);
  view.setUint16(tiff + 8, 2, true);
  entry(tiff + 10, 0x8769, 4, 1, 38);
  entry(tiff + 22, 0x8825, 4, 1, 100);
  view.setUint32(tiff + 34, 0, true);
  view.setUint16(tiff + 38, 4, true);
  entry(tiff + 40, 0x9003, 2, 20, 190);
  entry(tiff + 52, 0x9004, 2, 20, 210);
  entry(tiff + 64, 0x9011, 2, 7, 230);
  entry(tiff + 76, 0x9012, 2, 7, 237);
  view.setUint32(tiff + 88, 0, true);
  view.setUint16(tiff + 100, 7, true);
  entry(tiff + 102, 0x0001, 2, 2, 0, "N");
  entry(tiff + 114, 0x0002, 5, 3, 244);
  entry(tiff + 126, 0x0003, 2, 2, 0, "E");
  entry(tiff + 138, 0x0004, 5, 3, 268);
  entry(tiff + 150, 0x0007, 5, 3, 292);
  entry(tiff + 162, 0x001d, 2, 11, 316);
  entry(tiff + 174, 0x001f, 5, 1, 327);
  view.setUint32(tiff + 186, 0, true);
  ascii(tiff + 190, "2026:08:30 14:15:00");
  ascii(tiff + 210, "2026:08:31 09:30:00");
  ascii(tiff + 230, "+08:00");
  ascii(tiff + 237, "+09:00");
  rationals(tiff + 244, [[22, 1], [16, 1], [4195, 100]]);
  rationals(tiff + 268, [[114, 1], [10, 1], [28884, 1000]]);
  rationals(tiff + 292, [[1, 1], [2, 1], [3, 1]]);
  ascii(tiff + 316, "2026:09:01");
  rationals(tiff + 327, [[15, 2]]);
  bytes[bytes.length - 2] = 0xff; bytes[bytes.length - 1] = 0xd9;
  return Buffer.from(bytes);
}

const noGpsFiles = [
  { name: "no-gps-a.png", mimeType: "image/png", buffer: Buffer.from("89504e470d0a1a0a01", "hex") },
  { name: "no-gps-b.png", mimeType: "image/png", buffer: Buffer.from("89504e470d0a1a0a02", "hex") },
];

const stateOf = async (page) => JSON.parse(
  await page.locator("[data-qa-route-batch-state]").getAttribute("data-qa-route-batch-state"),
);

async function chooseExistingTargets(review, ids) {
  const groups = review.locator(".route-batch__group");
  const count = await groups.count();
  assert(count > 0, "Upload must expose real editable groups");
  for (let index = 0; index < count; index++) {
    const group = groups.nth(index);
    await group.getByLabel("媒体去向").selectOption(ids[index % ids.length]);
  }
}

const browser = await launchQaBrowser({ headless: true });
try {
  for (const scenario of ["manual", "auto", "partial"]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      const url = new URL("/?qaState=journey-story&qaMode=route-point-batch", baseUrl);
      url.searchParams.set("qaBatchScenario", scenario);
      await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
      const input = page.locator('.journey-story__media-add input[type="file"]');
      await input.waitFor({ state: "attached" });
      const files = scenario === "auto" ? [
        { name: "gps-a.jpg", mimeType: "image/jpeg", buffer: exifImage() },
        { name: "gps-b.jpg", mimeType: "image/jpeg", buffer: exifImage() },
      ] : noGpsFiles;
      await input.setInputFiles(files);
      const review = page.locator('section[aria-label="批量媒体途径点草案审阅"]');
      await review.waitFor({ state: "visible" });
      let state = await stateOf(page);
      assert(state.uploads === 0 && state.applies === 0, "File input must create a draft, not silently commit");

      if (scenario === "auto") {
        await review.getByRole("checkbox", { name: "仅本批允许自动整理" }).check();
      } else {
        if (scenario === "manual") {
          // Consent is never enough for unlocated or manually edited groups.
          await review.getByRole("checkbox", { name: "仅本批允许自动整理" }).check();
          state = await stateOf(page);
          assert(state.applies === 0, "Uncertain evidence must not auto-write");
        }
        await chooseExistingTargets(review, scenario === "partial"
          ? ["00000000-0000-4000-8000-000000000004", "qa-route-point-b"]
          : ["00000000-0000-4000-8000-000000000004"]);
        await review.getByRole("button", { name: "确认这些分组并上传" }).click();
      }

      if (scenario === "partial") {
        await page.getByText("媒体已上传，但途径点提交结果未知。", { exact: false }).waitFor({ state: "visible" });
        state = await stateOf(page);
        assert(state.uploads === 1 && state.applies === 1 && state.rejected === 1,
          "Move-only partial failure must be one rejected atomic operation, never retried");
        assert(state.reads >= 1, "An unknown POST must reconcile by the same operation ID");
        assert(state.media.length === files.length && state.media.every((media) => media.routePointId === null),
          "A rejected second target must not leave the first move committed");
        assert(await page.locator('section[aria-label="最近一次批量途径点回执"]').count() === 0,
          "Failure cannot manufacture a successful receipt");
      } else {
        const receipt = page.locator('section[aria-label="最近一次批量途径点回执"]');
        await receipt.waitFor({ state: "visible" });
        state = await stateOf(page);
        assert(state.uploads === 1 && state.applies === 1 && state.media.length === files.length,
          "One upload and one atomic apply must account for every file");
        assert(state.media.every((media) => media.routePointId === "00000000-0000-4000-8000-000000000004"),
          "Every file must be assigned to its reviewed existing Route Point");
        await page.getByRole("button", { name: "退出旅程故事" }).click();
        await page.locator(".journey-story").waitFor({ state: "detached" });
        await page.locator("[data-qa-story-reopen]").click();
        await receipt.waitFor({ state: "visible" });
        state = await stateOf(page);
        assert(state.reads >= 1 && state.applies === 1,
          "Reopening must read the durable receipt, never issue a new POST");
        await receipt.getByRole("button", { name: "撤销本批整理" }).click();
        await page.getByText("已按服务端回执撤销本批整理", { exact: false }).waitFor({ state: "visible" });
        state = await stateOf(page);
        assert(state.undos === 1 && state.media.every((media) => media.routePointId === null),
          "Undo must restore Journey-level media without deleting uploaded assets");
        assert(await receipt.getByRole("button", { name: "撤销本批整理" }).count() === 0,
          "An undone receipt must not expose a second undo");
      }
      assert(errors.length === 0, `No page errors expected: ${errors.join(" | ")}`);
      console.log(JSON.stringify({ scenario, status: "pass", ...state }));
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
