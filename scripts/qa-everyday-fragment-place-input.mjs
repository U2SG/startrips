// #497 / ST-139 — dedicated Everyday Fragment place-search QA.
// This module stays separate from qa-home-base-context.mjs so the parallel
// Home/Atlas owner keeps sole ownership of that shared regression body.
import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
const CURRENT_HOME = {
  id: "11111111-aaaa-4111-8111-111111111111",
  label: "北京",
  latitude: 39.9075,
  longitude: 116.39723,
  startedOn: "2025-01-01",
  endedOn: null,
  source: "manual",
};
const ATTRIBUTION = {
  label: "OpenStreetMap contributors",
  url: "https://www.openstreetmap.org/copyright",
};
const SHENZHEN_BAY = {
  id: "shenzhen-bay",
  label: "Shenzhen Bay",
  labelLocal: "深圳湾",
  labelEnglish: "Shenzhen Bay",
  context: "Shenzhen, Guangdong",
  countryCode: "CN",
  latitude: 22.5001,
  longitude: 113.9442,
};
const NEW_HARBOR = {
  id: "new-harbor",
  label: "New Harbor",
  labelLocal: "新港",
  labelEnglish: "New Harbor",
  context: "Shenzhen, Guangdong",
  countryCode: "CN",
  latitude: 22.5188,
  longitude: 113.9512,
};
const OLD_PLACE = {
  id: "old-place",
  label: "Old Place",
  labelLocal: "旧地点",
  labelEnglish: "Old Place",
  context: "Shenzhen, Guangdong",
  countryCode: "CN",
  latitude: 22.4,
  longitude: 113.8,
};

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

function searchPayload(result) {
  return { results: result ? [result] : [], attribution: ATTRIBUTION };
}

async function installOwnerApi(page) {
  const fragments = { rows: [], requests: [] };
  const heldSearchRoutes = [];

  await page.route(/\/api\/everyday-fragments(?:\/[^/?]+)?(?:\?.*)?$/, async (route) => {
    const method = route.request().method();
    const body = method === "POST" || method === "PUT" ? route.request().postDataJSON() : null;
    const id = new URL(route.request().url()).pathname.split("/")[3];
    fragments.requests.push({ method, id, body });
    if (method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ fragments: structuredClone(fragments.rows) }),
      });
      return;
    }
    if (method === "DELETE") {
      fragments.rows = fragments.rows.filter((row) => row.id !== id);
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    const fragment = {
      ...body,
      id: id ?? `33333333-cccc-4333-8333-${String(fragments.requests.length).padStart(12, "0")}`,
    };
    fragments.rows = [...fragments.rows.filter((row) => row.id !== fragment.id), fragment];
    await route.fulfill({
      status: method === "POST" ? 201 : 200,
      contentType: "application/json",
      body: JSON.stringify({ fragment }),
    });
  });

  await page.route("**/api/locations/search?*", async (route) => {
    const query = new URL(route.request().url()).searchParams.get("q") ?? "";
    if (query === "slow-old" || query === "slow-cancel") {
      heldSearchRoutes.push({ query, route });
      return;
    }
    if (query === "disabled") {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "LOCATION_SEARCH_UNAVAILABLE", message: "provider unavailable" }),
      });
      return;
    }
    if (query === "rate") {
      await route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({ error: "LOCATION_SEARCH_RATE_LIMITED", message: "搜索太频繁，请稍后再试。" }),
      });
      return;
    }
    const result = query === "深圳湾" ? SHENZHEN_BAY : query === "new" ? NEW_HARBOR : null;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(searchPayload(result)),
    });
  });

  const session = {
    session: {
      id: "qa-fragment-place-session",
      userId: "qa-user",
      token: "qa-token",
      expiresAt: "2027-01-01T00:00:00.000Z",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      activeOrganizationId: "qa-org",
    },
    user: {
      id: "qa-user",
      name: "QA Traveler",
      email: "qa@example.com",
      emailVerified: true,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
  };
  await page.route("**/api/auth/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/get-session")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(session) });
    }
    if (pathname.endsWith("/organization/list")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ id: "qa-org", name: "QA Atlas", slug: "qa-atlas" }]),
      });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.route("**/api/account-preferences/earth-experience", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ earthExperience: "default", revision: 0, updatedAt: null }),
  }));
  await page.route("**/api/atlases/current", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ atlas: { id: "qa-atlas", title: "QA Atlas", dedication: "同行记忆" }, role: "owner" }),
  }));
  await page.route("**/api/journeys", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ journeys: [] }),
  }));
  await page.route("**/api/home-bases/dismissal", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ dismissals: [] }),
  }));
  await page.route("**/api/home-bases", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ periods: [CURRENT_HOME] }),
  }));

  return { fragments, heldSearchRoutes };
}

async function openFragmentForm(viewport) {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(10_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const api = await installOwnerApi(page);
  await page.goto(`${origin}/?qaState=atlas-gateway&qaMode=globe-chrome`, { waitUntil: "domcontentloaded" });
  await page.locator(".living-atlas").waitFor({ state: "visible", timeout: 30_000 });
  const marker = page.locator(`[data-home-base-period-id="${CURRENT_HOME.id}"]`);
  await marker.waitFor({ state: "visible", timeout: 30_000 });
  await marker.focus();
  await page.keyboard.press("Enter");
  const context = page.locator("[data-home-base-context]");
  await context.waitFor({ state: "visible", timeout: 10_000 });
  const surface = context.locator("[data-everyday-fragments]");
  await surface.getByRole("button", { name: "日常", exact: true }).click();
  const list = surface.locator("#everyday-fragments-list");
  await list.getByText("还没有日常，记下某一天、某个地方。", { exact: true }).waitFor();
  await list.getByRole("button", { name: "记录日常", exact: true }).click();
  const form = list.getByRole("form", { name: "记录日常", exact: true });
  await form.waitFor();
  return { page, context, surface, list, form, pageErrors, ...api };
}

async function search(form, query) {
  const input = form.getByRole("combobox");
  await input.fill(query);
  await form.getByRole("button", { name: "搜索", exact: true }).click();
  return input;
}

async function waitForHeldSearch(heldSearchRoutes, query) {
  const deadline = Date.now() + 5_000;
  while (!heldSearchRoutes.some((entry) => entry.query === query)) {
    if (Date.now() > deadline) throw new Error(`Expected held search request for ${query}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function releaseHeld(heldSearchRoutes, query, result) {
  const index = heldSearchRoutes.findIndex((entry) => entry.query === query);
  if (index < 0) throw new Error(`No held search route for ${query}`);
  const [{ route }] = heldSearchRoutes.splice(index, 1);
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(searchPayload(result)),
  }).catch(() => {});
}

async function assertTouchTargets(viewport, name) {
  const owner = await openFragmentForm(viewport);
  const { page, form, pageErrors } = owner;
  await search(form, "深圳湾");
  await form.getByRole("option", { name: /Shenzhen Bay/ }).waitFor();
  const targets = await form.locator("button, input, textarea, summary").evaluateAll((nodes) => nodes
    .filter((node) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    })
    .map((node) => {
      const rect = node.getBoundingClientRect();
      return { tag: node.tagName, text: node.textContent, width: rect.width, height: rect.height };
    }));
  record(`${name}: place form touch targets are at least 44px`, { targets },
    targets.length > 0 && targets.every((target) => target.width >= 44 && target.height >= 44));
  record(`${name}: place form has no page errors`, { pageErrors }, pageErrors.length === 0);
  await page.close();
}

try {
  const owner = await openFragmentForm({ width: 1280, height: 860 });
  const { page, list, fragments, heldSearchRoutes, pageErrors } = owner;
  let form = owner.form;

  await form.getByLabel("日期", { exact: true }).fill("2026-09-30");
  const searchInput = await search(form, "深圳湾");
  await form.getByRole("option", { name: /Shenzhen Bay/ }).waitFor();
  const attributionVisible = await form.getByRole("link", { name: /地点数据 OpenStreetMap contributors/ }).isVisible();
  await searchInput.focus();
  await page.keyboard.press("Enter");
  await form.getByText("深圳湾", { exact: true }).waitFor();
  await form.getByRole("button", { name: "保存日常", exact: true }).click();
  const createdRow = list.locator("[data-everyday-fragment-id]").first();
  await createdRow.getByText("深圳湾", { exact: true }).waitFor();
  const createRequest = fragments.requests.find((request) => request.method === "POST");
  record("explicit search result creates a fragment without manual coordinates", {
    attributionVisible,
    createRequest,
  }, Boolean(
    attributionVisible
    && createRequest
    && createRequest.body.latitude === SHENZHEN_BAY.latitude
    && createRequest.body.longitude === SHENZHEN_BAY.longitude
    && createRequest.body.placeLabel === "深圳湾"
  ));

  await createdRow.getByRole("button", { name: "编辑", exact: true }).click();
  form = createdRow.getByRole("form", { name: "编辑日常", exact: true });
  const persistedBeforeSearch = {
    query: await form.getByRole("combobox").inputValue(),
    latitude: await form.getByLabel("纬度", { exact: true }).inputValue(),
    longitude: await form.getByLabel("经度", { exact: true }).inputValue(),
    place: await form.getByLabel("地点（选填）", { exact: true }).inputValue(),
  };
  const putsBefore = fragments.requests.filter((request) => request.method === "PUT").length;
  await search(form, "new");
  await form.getByRole("option", { name: /New Harbor/ }).waitFor();
  const persistedAfterSuggestions = {
    latitude: await form.getByLabel("纬度", { exact: true }).inputValue(),
    longitude: await form.getByLabel("经度", { exact: true }).inputValue(),
  };
  await form.getByRole("button", { name: "保存日常", exact: true }).click();
  const mismatchAlert = await form.getByRole("alert").innerText();
  const putsAfter = fragments.requests.filter((request) => request.method === "PUT").length;
  record("editing preserves persisted coordinates and an unconfirmed replacement query cannot save them", {
    persistedBeforeSearch,
    persistedAfterSuggestions,
    mismatchAlert,
    putsBefore,
    putsAfter,
  }, persistedBeforeSearch.query === "深圳湾"
    && persistedBeforeSearch.latitude === String(SHENZHEN_BAY.latitude)
    && persistedBeforeSearch.longitude === String(SHENZHEN_BAY.longitude)
    && persistedBeforeSearch.place === "深圳湾"
    && persistedAfterSuggestions.latitude === persistedBeforeSearch.latitude
    && persistedAfterSuggestions.longitude === persistedBeforeSearch.longitude
    && mismatchAlert.includes("请先从搜索结果确认地点")
    && putsAfter === putsBefore);
  await form.getByRole("button", { name: "取消", exact: true }).click();

  await list.getByRole("button", { name: "记录日常", exact: true }).click();
  form = list.getByRole("form", { name: "记录日常", exact: true });
  const oldSearch = form.getByRole("combobox");
  await oldSearch.fill("slow-old");
  await form.getByRole("button", { name: "搜索", exact: true }).click();
  await waitForHeldSearch(heldSearchRoutes, "slow-old");
  await oldSearch.fill("new");
  await form.getByRole("button", { name: "搜索", exact: true }).click();
  await form.getByRole("option", { name: /New Harbor/ }).waitFor();
  await releaseHeld(heldSearchRoutes, "slow-old", OLD_PLACE);
  await page.waitForTimeout(25);
  record("a stale older search cannot replace the newer result", {
    newCount: await form.getByRole("option", { name: /New Harbor/ }).count(),
    oldCount: await form.getByRole("option", { name: /Old Place/ }).count(),
  }, (await form.getByRole("option", { name: /New Harbor/ }).count()) === 1
    && (await form.getByRole("option", { name: /Old Place/ }).count()) === 0);

  await search(form, "disabled");
  const disabledMessage = await form.getByRole("status").innerText();
  await search(form, "rate");
  const rateMessage = await form.getByRole("status").innerText();
  record("provider-disabled and rate-limit states use recoverable shared vocabulary", {
    disabledMessage,
    rateMessage,
  }, disabledMessage.includes("未启用地点搜索") && rateMessage.includes("搜索太频繁"));

  const cancelSearch = form.getByRole("combobox");
  await cancelSearch.fill("slow-cancel");
  await form.getByRole("button", { name: "搜索", exact: true }).click();
  await waitForHeldSearch(heldSearchRoutes, "slow-cancel");
  await form.getByRole("button", { name: "取消", exact: true }).click();
  await form.waitFor({ state: "detached" });
  await releaseHeld(heldSearchRoutes, "slow-cancel", OLD_PLACE);
  await page.waitForTimeout(25);
  record("cancel/unmount invalidates the pending place search", {
    formCount: await list.getByRole("form", { name: "记录日常", exact: true }).count(),
  }, (await list.getByRole("form", { name: "记录日常", exact: true }).count()) === 0);

  await list.getByRole("button", { name: "记录日常", exact: true }).click();
  form = list.getByRole("form", { name: "记录日常", exact: true });
  await form.getByLabel("日期", { exact: true }).fill("2026-10-01");
  await form.locator("summary").click();
  await form.getByLabel("纬度", { exact: true }).fill("22.5431");
  await form.getByLabel("经度", { exact: true }).fill("114.0579");
  await form.getByLabel("地点（选填）", { exact: true }).fill("深圳");
  await form.getByRole("button", { name: "保存日常", exact: true }).click();
  await list.getByText("深圳", { exact: true }).waitFor();
  const manualCreate = fragments.requests.filter((request) => request.method === "POST").at(-1);
  record("manual coordinate fallback remains authoritative", { manualCreate }, Boolean(
    manualCreate
    && manualCreate.body.latitude === 22.5431
    && manualCreate.body.longitude === 114.0579
    && manualCreate.body.placeLabel === "深圳"
  ));
  record("desktop place-search flow has no page errors", { pageErrors }, pageErrors.length === 0);
  await page.close();

  await assertTouchTargets({ width: 390, height: 844 }, "portrait");
  await assertTouchTargets({ width: 844, height: 390 }, "landscape");
} catch (error) {
  console.log(JSON.stringify({ checks }, null, 2));
  throw error;
} finally {
  await browser.close();
}

console.log(JSON.stringify({ checks }, null, 2));
if (failed) process.exit(1);
