// #233 / ST-065 — owner-private Home Base activation/context QA.
// The existing projected Home anchor is the sole entry point. This lane proves
// pointer + keyboard activation, compact-mobile layout, historical period truth,
// and that Story/Playback/timeline intent wins without inventing another camera
// or semantic focus owner.
import { mkdirSync } from "node:fs";
import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
const captureDir = "artifacts/home-base-context";
mkdirSync(captureDir, { recursive: true });

const CURRENT_HOME = {
  id: "11111111-aaaa-4111-8111-111111111111",
  label: "北京",
  latitude: 39.9075,
  longitude: 116.39723,
  startedOn: "2025-01-01",
  endedOn: null,
  source: "manual",
};
const CITY_FIXTURE = {
  cities: [{
    n: "Beijing", z: "北京", la: 39.9075, lo: 116.39723, p: 18_960_744, r: 0, c: "CN",
  }],
};

const HISTORICAL_HOME = {
  id: "22222222-bbbb-4222-8222-222222222222",
  label: "成都",
  latitude: 30.5728,
  longitude: 104.0668,
  startedOn: "2022-01-01",
  endedOn: "2024-12-31",
  source: "manual",
};

function journey(id, title, startedOn, latitude, longitude) {
  return {
    id,
    atlasId: "qa-atlas",
    title,
    startedOn,
    endedOn: startedOn,
    note: "",
    lightColor: "#77c8c2",
    lightEffect: null,
    coverMediaAssetId: null,
    revision: 1,
    createdByUserId: "qa-user",
    createdAt: `${startedOn}T00:00:00.000Z`,
    updatedAt: `${startedOn}T00:00:00.000Z`,
    routePoints: [
      {
        id: `${id}-point`, journeyId: id, sortOrder: 0,
        latitude, longitude, label: title, isStop: true,
        occurredAt: `${startedOn}T12:00:00.000Z`, note: null,
        createdAt: `${startedOn}T12:00:00.000Z`,
      },
    ],
    media: [],
  };
}

const journeys = [
  journey("aaaaaaaa-1111-4111-8111-111111111111", "成都旧日", "2023-06-01", 30.5728, 104.0668),
  // Keep desktop arbitration comfortably beyond the renderer's 0.18-unit Route
  // Point threshold while Beijing remains the exact Home/city overlap fixture.
  journey("bbbbbbbb-2222-4222-8222-222222222222", "赣南今夏", "2026-06-01", 25.0, 116.4),
];
// Compact mobile owns a separate accessibility/context-placement fixture. Keep
// it free of Journey focus so the shipped fresh-Atlas Home camera seed is the
// only spatial owner; Route Point/city pointer precedence is already exercised
// above on the real overlap fixture. This proves the Home target itself rather
// than coupling keyboard reachability to an unrelated Journey focus flight.
const mobileJourneys = [];

const browser = await launchQaBrowser({
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const checks = [];
let failed = false;

function record(name, data, condition) {
  checks.push({ name, ...data, failed: !condition });
  if (!condition) failed = true;
}

async function installOwnerApi(page, journeyRows = journeys) {
  const fragments = { rows: [], requests: [], rejectReads: null, heldReads: null, rejectNext: null, holdNext: null, release: null };
  await page.route("**/api/everyday-fragments**", async (route) => {
    const method = route.request().method();
    const body = method === "POST" || method === "PUT" ? route.request().postDataJSON() : null;
    const id = new URL(route.request().url()).pathname.split("/")[3];
    // Strict Mode can replay a mounted read and abort its first request. Read
    // fixtures belong to the disclosure phase, not whichever request arrives first.
    const heldReads = method === "GET" ? fragments.heldReads : null;
    const rejection = method === "GET" ? fragments.rejectReads : fragments.rejectNext;
    fragments.requests.push({ method, id, body });
    let status = method === "POST" ? 201 : method === "DELETE" ? 204 : 200;
    let payload;
    if (rejection && (method === "GET" || rejection.method === method)) {
      status = rejection.status;
      payload = { error: rejection.code };
      if (method !== "GET") fragments.rejectNext = null;
    } else if (method === "GET") {
      payload = { fragments: structuredClone(fragments.rows) };
    } else if (method === "DELETE") {
      fragments.rows = fragments.rows.filter((row) => row.id !== id);
    } else {
      const fragment = { ...body, id: id ?? `33333333-cccc-4333-8333-${String(fragments.requests.length).padStart(12, "0")}` };
      fragments.rows = [...fragments.rows.filter((row) => row.id !== fragment.id), fragment];
      payload = { fragment };
    }
    if (heldReads || fragments.holdNext === method) {
      if (!heldReads) fragments.holdNext = null;
      let finish;
      const finished = new Promise((resolve) => { finish = resolve; });
      await new Promise((resolve) => {
        const release = async () => { resolve(); await finished; };
        if (heldReads) heldReads.push(release);
        else fragments.release = release;
      });
      if (!heldReads) fragments.release = null;
      // The old GET may have been aborted when its disclosure closed.
      await route.fulfill({ status, contentType: "application/json", body: payload ? JSON.stringify(payload) : "" }).catch(() => {});
      finish();
    } else {
      await route.fulfill({ status, contentType: "application/json", body: payload ? JSON.stringify(payload) : "" });
    }
  });
  // Exercise the real city-label projection/arbitration with one deterministic
  // GeoNames-shaped city at Home. The production dataset/collision budget is
  // covered elsewhere; this lane owns the interaction boundary itself.
  await page.route("**/earth/cities.json", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify(CITY_FIXTURE),
  }));
  const session = {
    session: {
      id: "qa-home-session", userId: "qa-user", token: "qa-token",
      expiresAt: "2027-01-01T00:00:00.000Z", createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z", activeOrganizationId: "qa-org",
    },
    user: {
      id: "qa-user", name: "QA Traveler", email: "qa@example.com", emailVerified: true,
      createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
    },
  };
  await page.route("**/api/auth/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/get-session")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(session) });
    }
    if (pathname.endsWith("/organization/list")) {
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify([{ id: "qa-org", name: "QA Atlas", slug: "qa-atlas" }]),
      });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  // #332: the Earth experience hydration read every signed-in mount issues.
  // Unstubbed it falls through to no API and logs a 500 the console assertions catch.
  await page.route("**/api/account-preferences/earth-experience", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ earthExperience: "default", revision: 0, updatedAt: null }),
  }));
  await page.route("**/api/atlases/current", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ atlas: { id: "qa-atlas", title: "QA Atlas", dedication: "同行记忆" }, role: "owner" }),
  }));
  await page.route("**/api/journeys", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ journeys: journeyRows }),
  }));
  await page.route("**/api/home-bases/dismissal", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ dismissals: [] }),
  }));
  await page.route("**/api/home-bases", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ periods: [HISTORICAL_HOME, CURRENT_HOME] }),
  }));
  return fragments;
}

async function openOwner(viewport, { journeyRows = journeys } = {}) {
  const page = await browser.newPage({ viewport });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const fragments = await installOwnerApi(page, journeyRows);
  // This contract starts from the EXISTING projected Home anchor, so the lane
  // must mount the real LivingAtlasGlobe rather than LivingAtlasQaGlobe (which
  // intentionally has no geographic Home projection surface).
  await page.goto(`${origin}/?qaState=atlas-gateway&qaMode=globe-chrome`, { waitUntil: "domcontentloaded" });
  await page.locator(".living-atlas").waitFor({ state: "visible", timeout: 30_000 });
  try {
    await page.waitForFunction(
      (periodId) => {
        const node = document.querySelector(`[data-home-base-period-id="${periodId}"]`);
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return !node.hidden && style.display !== "none" && rect.width >= 44 && rect.height >= 44;
      },
      CURRENT_HOME.id,
      { timeout: 30_000 },
    );
  } catch (error) {
    const diagnostics = await page.evaluate((periodId) => {
      const marker = document.querySelector(`[data-home-base-period-id="${periodId}"]`);
      const markerRect = marker instanceof HTMLElement ? marker.getBoundingClientRect() : null;
      const markerStyle = marker instanceof HTMLElement ? getComputedStyle(marker) : null;
      const scene = document.querySelector(".particle-earth-scene");
      const globe = document.querySelector(".living-atlas-globe");
      const atlas = document.querySelector(".living-atlas");
      return {
        mobileV2: atlas?.getAttribute("data-mobile-v2") ?? null,
        atlasClass: atlas?.getAttribute("class") ?? null,
        markerCount: document.querySelectorAll("[data-home-base-period-id]").length,
        marker: marker instanceof HTMLElement ? {
          hidden: marker.hidden,
          display: markerStyle?.display ?? null,
          visibility: markerStyle?.visibility ?? null,
          rect: markerRect ? { x: markerRect.x, y: markerRect.y, width: markerRect.width, height: markerRect.height } : null,
          presence: marker.getAttribute("data-home-base-presence"),
        } : null,
        earthDive: globe?.getAttribute("data-earth-dive") ?? null,
        earthDiveOwner: globe?.getAttribute("data-earth-dive-owner") ?? null,
        sceneReady: scene?.getAttribute("data-scene-ready") ?? null,
        focusRevision: scene?.getAttribute("data-focus-revision") ?? null,
        focusTargetLat: scene?.getAttribute("data-focus-target-lat") ?? null,
        focusTargetLon: scene?.getAttribute("data-focus-target-lon") ?? null,
        routeFocusLat: scene?.getAttribute("data-route-focus-lat") ?? null,
        routeFocusLon: scene?.getAttribute("data-route-focus-lon") ?? null,
      };
    }, CURRENT_HOME.id);
    throw new Error(`Home marker did not become actionable: ${JSON.stringify(diagnostics)}; ${error instanceof Error ? error.message : String(error)}`);
  }
  return { page, pageErrors, fragments };
}

async function waitForHeld(fragments) {
  const deadline = Date.now() + 5_000;
  while (!fragments.release && !fragments.heldReads?.length) {
    if (Date.now() > deadline) throw new Error("Expected a held fragment request");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function fillFragment(form, note = "") {
  await form.getByLabel("日期", { exact: true }).fill("2020-05-06");
  await form.getByLabel("纬度", { exact: true }).fill("22.5431");
  await form.getByLabel("经度", { exact: true }).fill("114.0579");
  await form.getByLabel("随记（选填）", { exact: true }).fill(note);
}

async function fragmentQa(owner, name) {
  const { page, fragments } = owner;
  const surface = page.locator("[data-everyday-fragments]");
  const list = page.locator("#everyday-fragments-list");
  const row = page.locator("[data-everyday-fragment-id]");
  const journeySnapshot = () => page.evaluate(() => ({
    rail: [...document.querySelectorAll(".living-atlas__journey-rail button")].map((button) => ({
      text: button.textContent, active: button.getAttribute("aria-current"),
    })),
    timeline: [...document.querySelectorAll(".journey-timeline")].map((node) => node.textContent),
    cursor: document.querySelector('.globe-time-scrubber input[type="range"]')?.value ?? null,
  }));
  const before = await journeySnapshot();
  const journeyRequests = [];
  const watchJourneys = (request) => {
    if (new URL(request.url()).pathname === "/api/journeys") journeyRequests.push(request.method());
  };
  page.on("request", watchJourneys);
  record(`${name}: fragments are lazy`, { requests: fragments.requests.length }, fragments.requests.length === 0);
  fragments.heldReads = [];
  await surface.getByRole("button", { name: "日常", exact: true }).click();
  await waitForHeld(fragments);
  const heldReads = fragments.heldReads;
  record(`${name}: initial read owns loading`, {}, await list.getByRole("status").isVisible());
  await surface.getByRole("button", { name: "日常", exact: true }).click();
  await list.waitFor({ state: "detached" });
  fragments.heldReads = null;
  fragments.rejectReads = { status: 503, code: "REQUEST_FAILED" };
  await surface.getByRole("button", { name: "日常", exact: true }).click();
  await list.getByRole("alert").waitFor();
  fragments.rejectReads = null;
  await list.getByRole("button", { name: "重试", exact: true }).click();
  await list.getByText("还没有日常，记下某一天、某个地方。", { exact: true }).waitFor();
  await list.getByRole("button", { name: "记录日常", exact: true }).click();
  let form = list.getByRole("form", { name: "记录日常", exact: true });
  await fillFragment(form);
  const targets = await surface.locator("button, input, textarea").evaluateAll((nodes) => nodes.map((node) => {
    const rect = node.getBoundingClientRect();
    return { tag: node.tagName, width: rect.width, height: rect.height };
  }));
  const placement = await page.locator("[data-home-base-context]").evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { fits: rect.top >= 0 && rect.right <= innerWidth && rect.left >= 0 && rect.bottom <= innerHeight, overflow: node.scrollWidth > node.clientWidth };
  });
  record(`${name}: fragment form fits and controls meet 44px`, { targets, placement },
    targets.every((target) => target.width >= 44 && target.height >= 44) && placement.fits && !placement.overflow);
  await page.screenshot({ path: `${captureDir}/${name}-everyday-form.png`, fullPage: false });
  fragments.rejectNext = { method: "POST", status: 400, code: "EVERYDAY_FRAGMENT_INVALID_DATE" };
  await form.getByRole("button", { name: "保存日常" }).click();
  await form.getByRole("alert").waitFor();
  record(`${name}: reason-coded validation preserves a recoverable draft`, { error: await form.getByRole("alert").innerText() },
    (await form.getByRole("alert").innerText()).includes("有效的日期") && (await form.getByLabel("纬度", { exact: true }).inputValue()) === "22.5431");
  fragments.holdNext = "POST";
  await form.getByRole("button", { name: "保存日常" }).click();
  await waitForHeld(fragments);
  record(`${name}: create pending`, {}, await form.getByRole("button", { name: "保存中…" }).isDisabled());
  fragments.release();
  await row.getByText("22.54310, 114.05790", { exact: true }).waitFor();
  await Promise.all(heldReads.map((release) => release()));
  record(`${name}: closed stale GET cannot erase a new fragment`, {}, await row.getByText("22.54310, 114.05790", { exact: true }).isVisible());
  const created = fragments.rows[0];
  record(`${name}: date + coordinates create an unassociated fragment`, { created },
    created.occurredOn === "2020-05-06" && created.homeBasePeriodId === null && created.placeLabel === null && created.note === null);
  await row.getByRole("button", { name: "编辑", exact: true }).click();
  form = row.getByRole("form", { name: "编辑日常" });
  await form.getByLabel("地点（选填）").fill("深圳湾");
  await form.getByLabel("随记（选填）").fill("晚风");
  fragments.holdNext = "PUT";
  await form.getByRole("button", { name: "保存日常" }).click();
  await waitForHeld(fragments);
  record(`${name}: edit pending`, {}, await form.getByRole("button", { name: "保存中…" }).isDisabled());
  fragments.release();
  await row.getByText("晚风", { exact: true }).waitFor();
  record(`${name}: edit renders optional place and note`, {}, (await row.innerText()).includes("深圳湾"));
  await row.getByRole("button", { name: "删除", exact: true }).click();
  fragments.rejectNext = { method: "DELETE", status: 503, code: "REQUEST_FAILED" };
  await row.getByRole("button", { name: "确认删除", exact: true }).click();
  await row.getByRole("alert").waitFor();
  fragments.holdNext = "DELETE";
  await row.getByRole("button", { name: "确认删除", exact: true }).click();
  await waitForHeld(fragments);
  record(`${name}: delete pending and retry`, {}, await row.getByRole("button", { name: "删除中…" }).isDisabled());
  fragments.release();
  await row.waitFor({ state: "detached" });
  record(`${name}: delete returns to empty`, {}, await list.getByText("还没有日常，记下某一天、某个地方。", { exact: true }).isVisible());

  // Closing the Home surface during PUT must not let its late result replace
  // an edit in a newly opened context. The stub commits before holding replies.
  await list.getByRole("button", { name: "记录日常", exact: true }).click();
  await fillFragment(list.getByRole("form"), "原记录");
  await list.getByRole("button", { name: "保存日常" }).click();
  await row.getByText("原记录", { exact: true }).waitFor();
  await row.getByRole("button", { name: "编辑", exact: true }).click();
  await row.getByLabel("随记（选填）").fill("延迟的编辑");
  fragments.holdNext = "PUT";
  await row.getByRole("button", { name: "保存日常" }).click();
  await waitForHeld(fragments);
  const releasePut = fragments.release;
  await closeContext(page);
  await (await currentHomeMarker(page)).focus();
  await page.keyboard.press("Enter");
  await surface.getByRole("button", { name: "日常", exact: true }).click();
  await row.getByText("延迟的编辑", { exact: true }).waitFor();
  await row.getByRole("button", { name: "编辑", exact: true }).click();
  await row.getByLabel("随记（选填）").fill("最新编辑");
  await row.getByRole("button", { name: "保存日常" }).click();
  await row.getByText("最新编辑", { exact: true }).waitFor();
  const putReply = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().includes("everyday-fragments"));
  await releasePut();
  await (await putReply).finished();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  record(`${name}: stale PUT cannot replace reopened edits`, {}, (await row.innerText()).includes("最新编辑"));

  await row.getByRole("button", { name: "删除", exact: true }).click();
  fragments.holdNext = "DELETE";
  await row.getByRole("button", { name: "确认删除", exact: true }).click();
  await waitForHeld(fragments);
  const releaseDelete = fragments.release;
  await surface.getByRole("button", { name: "日常", exact: true }).click();
  await surface.getByRole("button", { name: "记录日常", exact: true }).click();
  form = list.getByRole("form", { name: "记录日常", exact: true });
  await fillFragment(form, "保留的日常");
  await form.getByRole("button", { name: "保存日常" }).click();
  await row.getByText("保留的日常", { exact: true }).waitFor();
  const deleteReply = page.waitForResponse((response) => response.request().method() === "DELETE" && response.url().includes("everyday-fragments"));
  await releaseDelete();
  await (await deleteReply).finished();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  record(`${name}: stale DELETE cannot remove new records`, {}, (await row.innerText()).includes("保留的日常"));
  record(`${name}: CRUD never refreshes or changes Journey list`, { journeyRequests },
    journeyRequests.length === 0 && JSON.stringify(before) === JSON.stringify(await journeySnapshot()));
  page.off("request", watchJourneys);
}

async function currentHomeMarker(page) {
  return page.locator(`[data-home-base-period-id="${CURRENT_HOME.id}"]`);
}

async function clickProjectedHome(page, marker) {
  const box = await marker.boundingBox();
  if (!box) throw new Error("Projected Home marker has no pointer geometry");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const owner = await page.evaluate(({ x, y }) => {
    const hit = document.elementFromPoint(x, y);
    return {
      tag: hit?.tagName ?? null,
      className: hit instanceof Element ? hit.getAttribute("class") : null,
      homeOwnsHit: Boolean(hit?.closest?.(".living-atlas-globe__home-base")),
      sceneOwnsHit: Boolean(hit?.closest?.(".particle-earth-scene") || hit?.matches?.('canvas[data-three-scene="particle-earth"]')),
    };
  }, { x, y });
  if (owner.homeOwnsHit || !owner.sceneOwnsHit) {
    throw new Error(`Projected Home pointer is not renderer-owned: ${JSON.stringify(owner)}`);
  }
  await page.mouse.click(x, y);
  return owner;
}

async function closeContext(page) {
  const context = page.locator("[data-home-base-context]");
  if (await context.count()) {
    await context.getByRole("button", { name: "关闭常住地信息" }).click();
    await context.waitFor({ state: "detached", timeout: 5_000 });
  }
}

async function homeMarkerCenter(marker) {
  const box = await marker.boundingBox();
  if (!box) throw new Error("Projected Home marker has no pointer geometry");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function revealHomeCityLabel(page, marker) {
  await homeMarkerCenter(marker);
  await page.waitForFunction(() => [...document.querySelectorAll(".particle-earth-city")].some((node) => (
    node.textContent?.includes("北京") && getComputedStyle(node).display !== "none"
  )), null, { timeout: 5_000 });
  return page.evaluate(() => {
    const markerNode = document.querySelector('[data-home-base-presence="current"]');
    const city = [...document.querySelectorAll(".particle-earth-city")].find((node) => (
      node.textContent?.includes("北京") && getComputedStyle(node).display !== "none"
    ));
    if (!(markerNode instanceof HTMLElement) || !(city instanceof SVGTextElement)) return null;
    const home = markerNode.getBoundingClientRect();
    const label = city.getBoundingClientRect();
    const left = Math.max(home.left, label.left);
    const right = Math.min(home.right, label.right);
    const top = Math.max(home.top, label.top);
    const bottom = Math.min(home.bottom, label.bottom);
    if (right <= left || bottom <= top) return null;
    const x = (left + right) / 2;
    const y = (top + bottom) / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      x, y,
      hitCity: Boolean(hit?.closest?.(".particle-earth-city")),
      cityLat: city.getAttribute("data-city-lat"),
      cityLon: city.getAttribute("data-city-lon"),
    };
  });
}

try {
  // Desktop pointer + keyboard activation and semantic non-ownership.
  const desktop = await openOwner({ width: 1280, height: 860 });
  const page = desktop.page;
  const marker = await currentHomeMarker(page);
  const markerMetrics = await marker.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      width: rect.width,
      height: rect.height,
      label: element.getAttribute("aria-label"),
      tabIndex: element.tabIndex,
    };
  });
  // Pointer ownership is measured on the unobscured geographic surface. The
  // ordinary desktop active card legitimately sits above part of the globe;
  // globe-focus removes that competing UI without changing the projected Home
  // anchor or inventing a second interaction path.
  await page.locator(".living-atlas__globe-focus").click();
  await page.waitForFunction(() => document.querySelector(".living-atlas")?.getAttribute("data-globe-focus") === "on");
  const desktopPointerOwner = await clickProjectedHome(page, marker);
  const context = page.locator("[data-home-base-context]");
  await context.waitFor({ state: "visible", timeout: 5_000 });
  const currentContext = await context.evaluate((element) => ({
    periodId: element.getAttribute("data-home-base-period-id"),
    presence: element.getAttribute("data-home-base-presence"),
    text: element.textContent ?? "",
    role: element.getAttribute("role"),
    modal: element.getAttribute("aria-modal"),
    coordinates: /\b-?\d{1,3}\.\d{3,}\b/.test(element.textContent ?? ""),
  }));
  await page.screenshot({ path: `${captureDir}/01-desktop-current-context.png`, fullPage: false });
  record("desktop pointer opens exact current Home context without a modal or coordinates", {
    markerMetrics, currentContext, desktopPointerOwner,
  }, Boolean(
    markerMetrics.width >= 44
    && markerMetrics.height >= 44
    && markerMetrics.tabIndex === 0
    && desktopPointerOwner.sceneOwnsHit
    && !desktopPointerOwner.homeOwnsHit
    && markerMetrics.label?.includes("当前常住地")
    && currentContext.periodId === CURRENT_HOME.id
    && currentContext.presence === "current"
    && currentContext.text.includes("常住地 · 北京")
    && currentContext.text.includes("2025-01-01 起")
    && !currentContext.coordinates
    && currentContext.role === null
    && currentContext.modal === null
  ));

  await fragmentQa(desktop, "desktop");
  const beforeHistory = structuredClone(desktop.fragments.rows);
  const writesBeforeHistory = desktop.fragments.requests.filter((request) => request.method !== "GET").length;
  await closeContext(page);
  await page.locator(".living-atlas__globe-focus-exit").click();
  await page.waitForFunction(() => document.querySelector(".living-atlas")?.getAttribute("data-globe-focus") === "off");
  await marker.focus();
  await page.keyboard.press("Enter");
  await context.waitFor({ state: "visible", timeout: 5_000 });
  record("desktop keyboard activation opens the same current Home context", {
    periodId: await context.getAttribute("data-home-base-period-id"),
  }, (await context.getAttribute("data-home-base-period-id")) === CURRENT_HOME.id);

  // Story is a newer narrative owner. It closes Home context and closing Story
  // does not resurrect an old Home intent.
  await page.locator(".living-atlas__active-actions button", { hasText: "打开故事" }).click();
  await page.locator(".journey-story").waitFor({ state: "visible", timeout: 15_000 });
  const duringStory = await page.locator("[data-home-base-context]").count();
  const homeTargetsDuringStory = await page.locator("[data-home-base-period-id]").count();
  await page.locator(".journey-story__close").click();
  await page.locator(".journey-story").waitFor({ state: "detached", timeout: 10_000 });
  const afterStory = await page.locator("[data-home-base-context]").count();
  record("Story disables Home activation and old Home context does not auto-return", {
    duringStory, homeTargetsDuringStory, afterStory,
  }, duringStory === 0 && homeTargetsDuringStory === 0 && afterStory === 0);

  // Playback is the same ownership boundary. Pointer Home activation was
  // already proven on an unobscured globe above; the active Journey card is a
  // legitimate higher visual layer here, so use Home's keyboard target to open
  // context before Playback takes ownership rather than clicking through UI.
  const playbackHomeMarker = await currentHomeMarker(page);
  await playbackHomeMarker.focus();
  await page.keyboard.press("Enter");
  await context.waitFor({ state: "visible", timeout: 5_000 });
  await page.locator(".living-atlas__active-play").click();
  await page.locator(".living-atlas__playback-mode-menu button", { hasText: "完整播放" }).first().click();
  await page.locator(".journey-playback").waitFor({ state: "visible", timeout: 20_000 });
  const duringPlayback = await page.locator("[data-home-base-context]").count();
  // ST-065 only proves Playback ownership. Escape dismissal is a separate
  // release-candidate regression family (#356), so close through Playback's
  // explicit product control rather than coupling this lane to that contract.
  await page.locator('.journey-playback button[aria-label="退出播放"]').click();
  await page.locator(".journey-playback").waitFor({ state: "detached", timeout: 20_000 });
  const returnedStory = page.locator(".journey-story");
  if (await returnedStory.isVisible()) {
    await returnedStory.locator(".journey-story__close").click();
    await returnedStory.waitFor({ state: "detached", timeout: 10_000 });
  }
  const afterPlayback = await page.locator("[data-home-base-context]").count();
  record("Playback immediately wins context ownership and Home does not auto-return", {
    duringPlayback, afterPlayback,
  }, duringPlayback === 0 && afterPlayback === 0);

  // Rewind to the earliest dated Journey while globe focus owns the composition.
  // That date falls inside the historical Guangzhou Home period. The same marker
  // activation must now resolve the historical period rather than today's Home.
  await page.locator(".living-atlas__globe-focus").click();
  const scrubber = page.locator(".globe-time-scrubber__track");
  await scrubber.waitFor({ state: "visible", timeout: 10_000 });
  await scrubber.focus();
  await page.keyboard.press("Home");
  const historicalMarker = page.locator(`[data-home-base-period-id="${HISTORICAL_HOME.id}"]`);
  await historicalMarker.waitFor({ state: "visible", timeout: 15_000 });
  // The historical Journey point intentionally shares this Home coordinate; the
  // fixture is geographically separated from current Beijing so the opening
  // Home-pointer check is not accidentally owned by this historical Route Point.
  // Pointer activation must keep the existing Route Point owner; keyboard Home
  // activation remains available and clears that subordinate point context.
  await clickProjectedHome(page, historicalMarker);
  const overlappingRoutePointContext = page.locator("[data-route-point-context]");
  await overlappingRoutePointContext.waitFor({ state: "visible", timeout: 5_000 });
  record("overlapping Home pointer preserves Route Point ownership", {
    routePointId: await overlappingRoutePointContext.getAttribute("data-route-point-id"),
    homeContextCount: await page.locator("[data-home-base-context]").count(),
  }, (await overlappingRoutePointContext.getAttribute("data-route-point-id")) === `${journeys[0].id}-point`
    && (await page.locator("[data-home-base-context]").count()) === 0);
  await historicalMarker.focus();
  await page.keyboard.press("Enter");
  await context.waitFor({ state: "visible", timeout: 5_000 });
  const historicalContext = await context.evaluate((element) => ({
    periodId: element.getAttribute("data-home-base-period-id"),
    presence: element.getAttribute("data-home-base-presence"),
    text: element.textContent ?? "",
  }));
  await page.screenshot({ path: `${captureDir}/02-desktop-historical-context.png`, fullPage: false });
  record("rewind exposes and activates the exact historical Home period", { historicalContext }, Boolean(
    historicalContext.periodId === HISTORICAL_HOME.id
    && historicalContext.presence === "period-context"
    && historicalContext.text.includes("常住地 · 成都")
    && historicalContext.text.includes("2022-01-01–2024-12-31")
    && historicalContext.text.includes("历史生活阶段")
  ));
  await context.getByRole("button", { name: "日常", exact: true }).click();
  await context.getByText("保留的日常", { exact: true }).waitFor();
  record("changing visible Home preserves unassociated fragment truth", {},
    JSON.stringify(beforeHistory) === JSON.stringify(desktop.fragments.rows)
    && desktop.fragments.requests.filter((request) => request.method !== "GET").length === writesBeforeHistory);
  await closeContext(page);
  await page.locator(".living-atlas__globe-focus-exit").click();
  await page.close();

  // City text is painted over the same geographic surface. Zoom from the Home
  // region so the Beijing label becomes eligible, then require an actual label
  // hit inside Home's 44 px target to use the renderer's one arbitration path.
  const arbitration = await openOwner({ width: 1280, height: 800 });
  const arbitrationPage = arbitration.page;
  await arbitrationPage.locator(".living-atlas__globe-focus").click();
  await arbitrationPage.waitForFunction(() => document.querySelector(".living-atlas")?.getAttribute("data-globe-focus") === "on");
  const arbitrationMarker = await currentHomeMarker(arbitrationPage);
  const cityHomeOverlap = await revealHomeCityLabel(arbitrationPage, arbitrationMarker);
  record("deterministic city label physically overlaps Home and owns the hit", { cityHomeOverlap }, Boolean(
    cityHomeOverlap?.hitCity && cityHomeOverlap.cityLat && cityHomeOverlap.cityLon
  ));
  if (!cityHomeOverlap?.hitCity) {
    throw new Error(`Beijing city label did not overlap Home hit area: ${JSON.stringify(cityHomeOverlap)}`);
  }

  // Wheel after the SVG city glyph is proven to own the hit. That exercises
  // the delegated renderer wheel path rather than a nearby canvas coordinate.
  const beforeCityWheelZoom = await arbitrationPage.evaluate(() => window.__particleEarthDebug?.().zoom ?? null);
  await arbitrationPage.mouse.move(cityHomeOverlap.x, cityHomeOverlap.y);
  await arbitrationPage.mouse.wheel(0, -240);
  await arbitrationPage.waitForFunction((previous) => {
    const current = window.__particleEarthDebug?.().zoom;
    return typeof current === "number" && previous !== null && current > previous;
  }, beforeCityWheelZoom, { timeout: 5_000 });
  const afterCityWheelZoom = await arbitrationPage.evaluate(() => window.__particleEarthDebug?.().zoom ?? null);
  record("wheel beginning on city/Home overlap stays canonical renderer zoom", {
    beforeCityWheelZoom, afterCityWheelZoom,
  }, typeof beforeCityWheelZoom === "number"
    && typeof afterCityWheelZoom === "number"
    && afterCityWheelZoom > beforeCityWheelZoom);

  // Zoom legitimately moves the projection, so re-read the physical overlap.
  const postWheelOverlap = await revealHomeCityLabel(arbitrationPage, arbitrationMarker);
  if (!postWheelOverlap?.hitCity) {
    throw new Error(`Beijing city/Home overlap disappeared after renderer-owned wheel: ${JSON.stringify(postWheelOverlap)}`);
  }
  await arbitrationPage.mouse.click(postWheelOverlap.x, postWheelOverlap.y);
  const arbitrationContext = arbitrationPage.locator("[data-home-base-context]");
  await arbitrationContext.waitFor({ state: "visible", timeout: 5_000 });
  record("ordinary city-label contact inside Home region resolves to Home after higher renderer owners yield", {
    periodId: await arbitrationContext.getAttribute("data-home-base-period-id"),
  }, (await arbitrationContext.getAttribute("data-home-base-period-id")) === CURRENT_HOME.id);
  await closeContext(arbitrationPage);

  const beforeDrag = await arbitrationPage.evaluate(() => window.__particleEarthDebug?.() ?? null);
  await arbitrationPage.mouse.move(postWheelOverlap.x, postWheelOverlap.y);
  await arbitrationPage.mouse.down();
  await arbitrationPage.mouse.move(postWheelOverlap.x + 64, postWheelOverlap.y + 20, { steps: 5 });
  await arbitrationPage.mouse.up();
  const afterDrag = await arbitrationPage.evaluate(() => window.__particleEarthDebug?.() ?? null);
  record("drag beginning in city/Home overlap remains the canonical globe gesture", {
    before: beforeDrag ? { rotationX: beforeDrag.rotationX, rotationY: beforeDrag.rotationY } : null,
    after: afterDrag ? {
      rotationX: afterDrag.rotationX,
      rotationY: afterDrag.rotationY,
      manualFocusOwner: afterDrag.manualFocusOwner,
      dragAngularDisplacement: afterDrag.dragAngularDisplacement,
    } : null,
    homeContextCount: await arbitrationPage.locator("[data-home-base-context]").count(),
  }, Boolean(
    afterDrag?.manualFocusOwner
    && afterDrag.dragAngularDisplacement?.total > 0
    && (await arbitrationPage.locator("[data-home-base-context]").count()) === 0
  ));
  await arbitrationPage.close();

  // Globe coordinate-picking is the highest owner. Recreate the same physical
  // city/Home overlap, enter the existing composer pick mode, and require that
  // the city coordinate is accepted without ever opening Home context.
  const globePick = await openOwner({ width: 1280, height: 800 });
  const globePickPage = globePick.page;
  await globePickPage.locator(".living-atlas__globe-focus").click();
  await globePickPage.waitForFunction(() => document.querySelector(".living-atlas")?.getAttribute("data-globe-focus") === "on");
  const globePickMarker = await currentHomeMarker(globePickPage);
  const globePickOverlap = await revealHomeCityLabel(globePickPage, globePickMarker);
  if (!globePickOverlap?.hitCity) {
    throw new Error(`Globe-pick city/Home overlap unavailable: ${JSON.stringify(globePickOverlap)}`);
  }
  await globePickPage.locator(".living-atlas__globe-focus-exit").click();
  await globePickPage.getByRole("button", { name: "记录旅程" }).click();
  await globePickPage.locator(".journey-composer").waitFor({ state: "visible", timeout: 5_000 });
  await globePickPage.getByRole("button", { name: /直接在地球上取点/ }).click();
  await globePickPage.waitForFunction(() => document.querySelector(".living-atlas")?.classList.contains("is-globe-picking"));
  const pickingCity = globePickPage.locator(".particle-earth-city").filter({ hasText: "北京" }).first();
  await pickingCity.waitFor({ state: "visible", timeout: 5_000 });
  await pickingCity.click();
  await globePickPage.waitForFunction(() => !document.querySelector(".living-atlas")?.classList.contains("is-globe-picking"), null, { timeout: 5_000 });
  const acceptedRoutePoint = globePickPage.locator(".journey-route-draft li:not(.is-empty)").first();
  const acceptedCoordinates = [
    Number(await acceptedRoutePoint.getAttribute("data-route-point-latitude")),
    Number(await acceptedRoutePoint.getAttribute("data-route-point-longitude")),
  ];
  const expectedCityCoordinates = [Number(globePickOverlap.cityLat), Number(globePickOverlap.cityLon)];
  const cityCoordinatePreserved = acceptedCoordinates.length === 2
    && acceptedCoordinates.every(Number.isFinite)
    && expectedCityCoordinates.every(Number.isFinite)
    && Math.abs(acceptedCoordinates[0] - expectedCityCoordinates[0]) <= 0.0001
    && Math.abs(acceptedCoordinates[1] - expectedCityCoordinates[1]) <= 0.0001;
  record("globe coordinate-pick wins over Home and preserves the selected city coordinate", {
    homeContextCount: await globePickPage.locator("[data-home-base-context]").count(),
    acceptedCoordinates,
    expectedCityCoordinates,
  }, (await globePickPage.locator("[data-home-base-context]").count()) === 0 && cityCoordinatePreserved);
  await globePickPage.close();

  // Compact mobile uses the same geographic marker; no Home tab/tool is added.
  // Compact mobile proves the same Home context through its accessible keyboard
  // target while Route Point pointer precedence remains independently covered.
  const mobile = await openOwner({ width: 390, height: 844 }, { journeyRows: mobileJourneys });
  const mobilePage = mobile.page;
  const mobileMarker = await currentHomeMarker(mobilePage);
  await mobileMarker.focus();
  await mobilePage.keyboard.press("Enter");
  const mobileContext = mobilePage.locator("[data-home-base-context]");
  await mobileContext.waitFor({ state: "visible", timeout: 5_000 });
  const mobilePlacement = await mobilePage.evaluate(() => {
    const node = document.querySelector("[data-home-base-context]");
    const chrome = document.querySelector(".mobile-v2__chrome");
    const marker = document.querySelector('[data-home-base-presence="current"]');
    if (!(node instanceof HTMLElement) || !(marker instanceof HTMLElement)) return null;
    const rect = node.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();
    const chromeRect = chrome?.getBoundingClientRect();
    return {
      mobileMode: document.querySelector(".living-atlas")?.getAttribute("data-mobile-v2"),
      inViewport: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
      aboveChrome: chromeRect ? rect.bottom <= chromeRect.top + 1 : true,
      markerHit: Math.min(markerRect.width, markerRect.height),
      permanentHomeTabs: [...document.querySelectorAll("button")]
        .filter((button) => /Home Base|常住地/.test(button.textContent ?? "") && !button.matches(".living-atlas-globe__home-base")).length,
      suggestionsWhileContextOpen: document.querySelectorAll(".living-atlas__home-base-suggestion").length,
    };
  });
  await mobilePage.screenshot({ path: `${captureDir}/03-mobile-current-context.png`, fullPage: false });
  record("compact mobile keyboard activation opens the same context above native chrome with no permanent Home tab", {
    mobilePlacement,
  }, Boolean(
    mobilePlacement
    && mobilePlacement.mobileMode === "on"
    && mobilePlacement.inViewport
    && mobilePlacement.aboveChrome
    && mobilePlacement.markerHit >= 44
    && mobilePlacement.permanentHomeTabs === 0
    && mobilePlacement.suggestionsWhileContextOpen === 0
  ));
  await fragmentQa(mobile, "mobile");
  await closeContext(mobilePage);
  await mobilePage.close();

  record("owner browser pages have no page errors", {
    desktop: desktop.pageErrors,
    mobile: mobile.pageErrors,
  }, desktop.pageErrors.length === 0 && mobile.pageErrors.length === 0);
} catch (error) {
  // The accumulated checks are this lane's only diagnostic record; a thrown
  // step must not take them down with it (#439). Print first, then rethrow so
  // the original failure and the non-zero exit are unchanged.
  console.log(JSON.stringify({ checks }, null, 2));
  throw error;
} finally {
  await browser.close();
}

console.log(JSON.stringify({ checks }, null, 2));
if (failed) process.exit(1);
