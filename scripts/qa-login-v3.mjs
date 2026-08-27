import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
const browser = await launchQaBrowser({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
  reducedMotion: "reduce",
});
const results = [];
const consoleErrors = [];
const pageErrors = [];
let failed = false;

page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => pageErrors.push(error.message));
await page.route("**/api/auth/get-session", (route) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: "null",
}));

function overlapPairs(items) {
  const pairs = [];
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i];
      const b = items[j];
      const overlapX = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
      const overlapY = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      if (overlapX > 2 && overlapY > 2) {
        pairs.push({ a: a.name, b: b.name, area: Math.round(overlapX * overlapY) });
      }
    }
  }
  return pairs;
}

async function clickText(text) {
  await page.evaluate((label) => {
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === label)
      ?.click();
  }, text);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
}

async function ensureSignIn() {
  const mode = await page.locator(".auth-card--login-v3").evaluate((element) => (
    element.classList.contains("is-sign-in") ? "sign-in"
      : element.classList.contains("is-sign-up") ? "sign-up"
        : "forgot"
  ));
  if (mode === "sign-up") await clickText("已有账号，去登录");
  else if (mode === "forgot") await clickText("返回登录");
}

async function scan(label, mobile) {
  const snapshot = await page.evaluate(() => {
    const card = document.querySelector(".auth-card--login-v3");
    if (!card) return null;
    const controls = [...card.querySelectorAll("button, input")]
      .filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && Number(style.opacity) > 0.05
          && rect.width > 1
          && rect.height > 1;
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          name: (element.getAttribute("aria-label") || element.textContent || element.tagName)
            .trim().replace(/\s+/g, " ").slice(0, 80),
          tag: element.tagName,
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        };
      });
    const rect = card.getBoundingClientRect();
    return {
      card: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      cardOverflow: Math.max(0, card.scrollHeight - card.clientHeight),
      overflowX: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      overflowY: Math.max(0, document.documentElement.scrollHeight - innerHeight),
      controls,
    };
  });
  if (!snapshot) throw new Error(`Missing login card for ${label}`);
  const overlaps = overlapPairs(snapshot.controls);
  const smallTouchTargets = mobile
    ? snapshot.controls
      .filter((control) => (control.tag === "BUTTON" || control.tag === "INPUT") && control.height < 43.5)
      .map((control) => ({ name: control.name, height: Math.round(control.height) }))
    : [];
  const result = {
    label,
    card: {
      x: Math.round(snapshot.card.x),
      y: Math.round(snapshot.card.y),
      width: Math.round(snapshot.card.width),
      height: Math.round(snapshot.card.height),
    },
    overlaps,
    cardOverflow: snapshot.cardOverflow,
    overflowX: snapshot.overflowX,
    overflowY: snapshot.overflowY,
    smallTouchTargets,
  };
  if (
    overlaps.length
    || snapshot.cardOverflow > 1
    || snapshot.overflowX > 0
    || snapshot.overflowY > 0
    || smallTouchTargets.length
  ) failed = true;
  results.push(result);
}

async function verifyViewport(name, viewport, mobile) {
  console.error(`[qa-login-v3] ${name}`);
  await page.setViewportSize(viewport);
  await ensureSignIn();
  await scan(`${name}-sign-in`, mobile);
  await clickText("没有账号，先注册");
  await scan(`${name}-sign-up`, mobile);
  await clickText("忘记密码");
  await scan(`${name}-forgot`, mobile);
}

const gatewaySession = {
  session: {
    id: "qa-session",
    userId: "qa-user",
    token: "qa-token",
    expiresAt: "2026-08-27T00:00:00.000Z",
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
    activeOrganizationId: "qa-org",
  },
  user: {
    id: "qa-user",
    name: "QA Traveler",
    email: "qa@example.com",
    emailVerified: true,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
  },
};

async function createGatewayPage({
  failAfterSignIn = false,
  initialAuthenticated = false,
  initialPath = "/?qaState=login-gateway&qaLite=1",
  multiPage = false,
} = {}) {
  const context = multiPage
    ? await browser.newContext({
      viewport: { width: 390, height: 844 },
      reducedMotion: "reduce",
    })
    : null;
  const gatewayPage = context
    ? await context.newPage()
    : await browser.newPage({
      viewport: { width: 390, height: 844 },
      reducedMotion: "reduce",
    });
  const errors = [];
  let authenticated = initialAuthenticated;
  let signInRequests = 0;
  let postSignInSessionRequests = 0;
  gatewayPage.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  gatewayPage.on("pageerror", (error) => errors.push(error.message));
  await gatewayPage.route("**/api/auth/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/sign-in/email")) {
      signInRequests += 1;
      authenticated = true;
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      return;
    }
    if (pathname.endsWith("/get-session")) {
      if (authenticated) postSignInSessionRequests += 1;
      if (authenticated && failAfterSignIn) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "qa session refresh failed" }) });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(authenticated ? gatewaySession : null),
      });
      return;
    }
    if (pathname.endsWith("/organization/list")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ id: "qa-org", name: "QA Atlas", slug: "qa-atlas" }]),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await gatewayPage.route("**/api/atlases/current", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ atlas: { id: "qa-atlas", title: "QA Atlas", dedication: "" }, role: "owner" }),
  }));
  await gatewayPage.route("**/api/journeys", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ journeys: [] }),
  }));
  await gatewayPage.goto(`${origin}${initialPath}`, { waitUntil: "domcontentloaded", timeout: 8_000 });
  if (!initialAuthenticated) {
    await gatewayPage.locator(".auth-card--login-v3").waitFor({ state: "visible", timeout: 4_000 });
  }
  return {
    page: gatewayPage,
    errors,
    metrics() { return { signInRequests, postSignInSessionRequests }; },
    gainSession() { authenticated = true; },
    loseSession() { authenticated = false; },
    async close() {
      if (context) await context.close();
      else await gatewayPage.close();
    },
  };
}

async function submitGatewayLogin(gatewayPage) {
  await gatewayPage.locator('input[type="email"]').fill("qa@example.com");
  await gatewayPage.locator('input[type="password"]').fill("password1234");
  await gatewayPage.getByRole("button", { name: "登录", exact: true }).click();
}

async function broadcastSessionRefresh(targetPage, trigger) {
  console.error(`[qa-login-v3] broadcast:${trigger}:new-page`);
  const signalPage = await targetPage.context().newPage();
  try {
    await signalPage.route("**/api/auth/get-session", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "null",
    }));
    console.error(`[qa-login-v3] broadcast:${trigger}:goto`);
    await signalPage.goto(`${origin}/?qaState=login-v3&qaPhase=ready&qaLite=1`, {
      waitUntil: "domcontentloaded",
      timeout: 8_000,
    });
    console.error(`[qa-login-v3] broadcast:${trigger}:storage-write`);
    await signalPage.evaluate((sessionTrigger) => {
      localStorage.setItem("better-auth.message", JSON.stringify({
        event: "session",
        data: { trigger: sessionTrigger },
        clientId: "qa-login-v3-signal-page",
        timestamp: Math.floor(Date.now() / 1_000),
      }));
    }, trigger);
    console.error(`[qa-login-v3] broadcast:${trigger}:written`);
  } finally {
    console.error(`[qa-login-v3] broadcast:${trigger}:close`);
    await signalPage.close();
    console.error(`[qa-login-v3] broadcast:${trigger}:closed`);
  }
}

async function verifyAuthenticatedDirectGate(label, path, targetSelector) {
  const separator = path.includes("?") ? "&" : "?";
  const gateway = await createGatewayPage({
    initialAuthenticated: true,
    initialPath: `${path}${separator}qaState=login-gateway&qaLite=1`,
  });
  try {
    const target = gateway.page.locator(targetSelector);
    await target.waitFor({ state: "visible", timeout: 4_000 });
    await gateway.page.waitForFunction(() => (
      document.querySelector("[data-persistent-earth-host]")?.getAttribute("data-stage") === "atlas"
    ));
    // Playwright hover includes hit-target/actionability checks, so this fails
    // if the root pass-through layer still blocks the direct AuthGateway gate.
    await target.hover();
    const metrics = await target.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        pointerEvents: getComputedStyle(element).pointerEvents,
        hitTargetOwned: hit === element || element.contains(hit),
        hostStage: document.querySelector("[data-persistent-earth-host]")?.getAttribute("data-stage") ?? null,
      };
    });
    return {
      label,
      ...metrics,
      errors: gateway.errors,
      failed: metrics.pointerEvents === "none"
        || !metrics.hitTargetOwned
        || metrics.hostStage !== "atlas"
        || gateway.errors.length > 0,
    };
  } finally {
    await gateway.close();
  }
}

async function verifyPersistentGatewaySceneContinuity() {
  console.error("[qa-login-v3] persistent-earth:start");
  const gateway = await createGatewayPage({
    initialPath: "/?qaState=final-acceptance&qaPhase=ready",
    multiPage: true,
  });
  try {
    await gateway.page.waitForFunction(() => {
      const debug = window.__particleEarthDebug?.();
      return debug?.quality === "low" && debug.particleCount === 12_000;
    }, null, { timeout: 15_000 });
    console.error("[qa-login-v3] persistent-earth:login-low-ready");
    const login = await gateway.page.evaluate(() => {
      const host = document.querySelector("[data-persistent-earth-host]");
      const canvas = document.querySelector('canvas[data-three-scene="particle-earth"]');
      window.__qaPersistentEarthCanvas = canvas;
      window.__qaPersistentEarthDebug = window.__particleEarthDebug;
      window.__qaPersistentEarthStages = [host?.getAttribute("data-stage") ?? null];
      const observer = new MutationObserver(() => {
        const stage = host?.getAttribute("data-stage") ?? null;
        if (window.__qaPersistentEarthStages.at(-1) !== stage) window.__qaPersistentEarthStages.push(stage);
      });
      if (host) observer.observe(host, { attributes: true, attributeFilter: ["data-stage"] });
      window.__qaPersistentEarthObserver = observer;
      return {
        stage: host?.getAttribute("data-stage") ?? null,
        debug: window.__particleEarthDebug?.() ?? null,
        href: window.location.href,
        authCard: Boolean(document.querySelector(".auth-card--login-v3")),
        emailInputs: document.querySelectorAll('input[type="email"]').length,
        passwordInputs: document.querySelectorAll('input[type="password"]').length,
        bodyText: document.body.textContent?.trim().slice(0, 240) ?? "",
      };
    });
    if (!login.authCard || login.passwordInputs !== 1) {
      throw new Error(`persistent login surface disappeared before session transition: ${JSON.stringify(login)}`);
    }
    gateway.gainSession();
    console.error("[qa-login-v3] persistent-earth:broadcast-session-gain");
    await broadcastSessionRefresh(gateway.page, "qa-session-gain");
    console.error("[qa-login-v3] persistent-earth:broadcast-complete");
    await gateway.page.locator(".auth-continuity.is-released").waitFor({ timeout: 15_000 });
    console.error("[qa-login-v3] persistent-earth:atlas-released");
    try {
      await gateway.page.waitForFunction(() => (
        document.querySelector("[data-persistent-earth-host]")?.getAttribute("data-stage") === "atlas"
        && window.__particleEarthDebug?.().quality === "high"
      ), null, { timeout: 5_000 });
    } catch (error) {
      const stageDebug = await gateway.page.evaluate(() => ({
        stage: document.querySelector("[data-persistent-earth-host]")?.getAttribute("data-stage") ?? null,
        shellStage: document.querySelector("[data-persistent-earth-stage]")?.getAttribute("data-persistent-earth-stage") ?? null,
        continuityClass: document.querySelector(".auth-continuity")?.className ?? null,
        atlasLoaded: Boolean(document.querySelector(".living-atlas")),
        debug: window.__particleEarthDebug?.() ?? null,
      }));
      throw new Error(`persistent earth did not enter atlas quality: ${JSON.stringify(stageDebug)}`, { cause: error });
    }
    try {
      await gateway.page.waitForFunction(() => (
        window.__particleEarthDebug?.().particleCount === 28_000
      ), null, { timeout: 30_000 });
    } catch (error) {
      const qualityDebug = await gateway.page.evaluate(() => ({
        stage: document.querySelector("[data-persistent-earth-host]")?.getAttribute("data-stage") ?? null,
        debug: window.__particleEarthDebug?.() ?? null,
      }));
      throw new Error(`persistent earth high-quality rebuild did not settle: ${JSON.stringify(qualityDebug)}`, { cause: error });
    }
    const atlas = await gateway.page.evaluate(() => {
      const canvas = document.querySelector('canvas[data-three-scene="particle-earth"]');
      const result = {
        sameCanvas: window.__qaPersistentEarthCanvas === canvas,
        sameControllerDebug: window.__qaPersistentEarthDebug === window.__particleEarthDebug,
        stages: window.__qaPersistentEarthStages ?? [],
        debug: window.__particleEarthDebug?.() ?? null,
      };
      window.__qaPersistentEarthObserver?.disconnect();
      return result;
    });
    const unexpectedErrors = gateway.errors.filter((message) => !message.includes("favicon"));
    return {
      label: "gateway-persistent-earth-quality-continuity",
      login,
      atlas,
      errors: unexpectedErrors,
      failed: login.stage !== "login"
        || login.debug?.quality !== "low"
        || login.debug?.particleCount !== 12_000
        || !atlas.sameCanvas
        || !atlas.sameControllerDebug
        || atlas.debug?.quality !== "high"
        || atlas.debug?.particleCount !== 28_000
        || atlas.debug?.canvases !== 1
        || unexpectedErrors.length > 0,
    };
  } finally {
    await gateway.close();
  }
}

async function verifyDetailedEarthParticleContinuity() {
  const gateway = await createGatewayPage({
    initialAuthenticated: true,
    initialPath: "/?qaState=final-acceptance",
  });
  try {
    await gateway.page.route("**/styles/fiord*", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        version: 8,
        name: "QA empty detailed-earth style",
        sources: {},
        layers: [],
      }),
    }));
    await gateway.page.locator(".auth-continuity.is-released").waitFor({ timeout: 15_000 });
    await gateway.page.waitForFunction(() => (
      document.querySelector("[data-persistent-earth-host]")?.getAttribute("data-stage") === "atlas"
      && document.querySelector("[data-persistent-earth-host]")?.getAttribute("data-interactive") === "true"
      && window.__particleEarthDebug?.().quality === "high"
      && window.__particleEarthDebug?.().canvases === 1
    ), null, { timeout: 15_000 });
    await gateway.page.evaluate(() => new Promise((resolve) => (
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    )));

    const before = await gateway.page.evaluate(() => {
      const canvas = document.querySelector('canvas[data-three-scene="particle-earth"]');
      window.__qaDetailEarthCanvas = canvas;
      window.__qaDetailEarthDebug = window.__particleEarthDebug;
      return {
        sameCanvas: Boolean(canvas),
        debug: window.__particleEarthDebug?.() ?? null,
      };
    });
    const canvas = gateway.page.locator('canvas[data-three-scene="particle-earth"]');
    const box = await canvas.boundingBox();
    if (!box) throw new Error("persistent particle-earth canvas has no browser bounds");
    const startX = box.x + box.width * 0.52;
    const startY = box.y + box.height * 0.54;
    const pointerOwnership = await gateway.page.evaluate(({ x, y }) => {
      const describe = (element) => {
        if (!(element instanceof Element)) return null;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName,
          className: element.getAttribute("class"),
          ariaLabel: element.getAttribute("aria-label"),
          pointerEvents: style.pointerEvents,
          zIndex: style.zIndex,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        };
      };
      const canvas = document.querySelector('canvas[data-three-scene="particle-earth"]');
      const stack = document.elementsFromPoint(x, y).slice(0, 8).map(describe);
      const hit = document.elementFromPoint(x, y);
      return {
        hit: describe(hit),
        stack,
        canvasHitOwned: hit === canvas || Boolean(canvas && hit && canvas.contains(hit)),
      };
    }, { x: startX, y: startY });
    await gateway.page.mouse.move(startX, startY);
    await gateway.page.mouse.down();
    await gateway.page.mouse.move(startX + 52, startY + 28, { steps: 5 });
    await gateway.page.mouse.up();
    await gateway.page.mouse.wheel(0, -360);
    await gateway.page.waitForTimeout(250);
    const interacted = await gateway.page.evaluate(() => window.__particleEarthDebug?.() ?? null);
    const rotationChanged = Boolean(interacted) && (
      Math.abs(interacted.rotationX - (before.debug?.rotationX ?? 0)) > 0.01
      || Math.abs(interacted.rotationY - (before.debug?.rotationY ?? 0)) > 0.01
    );
    const zoomChanged = Boolean(interacted)
      && Math.abs(interacted.zoom - (before.debug?.zoom ?? 1)) > 0.01;
    if (!pointerOwnership.canvasHitOwned || !rotationChanged || !zoomChanged) {
      throw new Error(`persistent particle-earth interaction blocked: ${JSON.stringify({
        pointerOwnership,
        before: before.debug,
        interacted,
        rotationChanged,
        zoomChanged,
      })}`);
    }

    const detailModeButton = gateway.page.getByRole("button", { name: "深入真实地图" });
    const detailModeHit = await detailModeButton.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        hitOwned: hit === button || button.contains(hit),
        hitTag: hit?.tagName ?? null,
        hitClass: hit instanceof HTMLElement || hit instanceof SVGElement ? hit.getAttribute("class") : null,
        hitAriaLabel: hit instanceof Element ? hit.getAttribute("aria-label") : null,
        buttonPointerEvents: getComputedStyle(button).pointerEvents,
        buttonRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      };
    });
    if (!detailModeHit.hitOwned) {
      throw new Error(`detailed-earth mode control is covered: ${JSON.stringify(detailModeHit)}`);
    }
    await detailModeButton.click();
    try {
      await gateway.page.locator(".detailed-earth-map").waitFor({
        state: "attached",
        timeout: 4_000,
      });
    } catch (error) {
      const mountDebug = await gateway.page.evaluate(() => ({
        earthMode: document.querySelector(".living-atlas-globe")?.getAttribute("data-earth-mode") ?? null,
        globeClass: document.querySelector(".living-atlas-globe")?.className ?? null,
        transitionStatus: document.querySelector(".living-atlas-globe__transition-status")?.textContent?.trim() ?? null,
        controlLabels: [...document.querySelectorAll(".living-atlas-globe__controls button")].map((button) => button.getAttribute("aria-label") || button.textContent?.trim() || ""),
      }));
      throw new Error(`detailed-earth map did not mount: ${JSON.stringify({ ...mountDebug, errors: gateway.errors })}`, { cause: error });
    }
    try {
      await gateway.page.locator('.detailed-earth-map[data-map-ready="true"]').waitFor({
        state: "attached",
        timeout: 8_000,
      });
    } catch (error) {
      const mapDebug = await gateway.page.evaluate(() => {
        const map = document.querySelector(".detailed-earth-map");
        return {
          mapReady: map?.getAttribute("data-map-ready") ?? null,
          mapError: map?.getAttribute("data-map-error") ?? null,
          earthMode: document.querySelector(".living-atlas-globe")?.getAttribute("data-earth-mode") ?? null,
          globeClass: document.querySelector(".living-atlas-globe")?.className ?? null,
          transitionStatus: document.querySelector(".living-atlas-globe__transition-status")?.textContent?.trim() ?? null,
        };
      });
      throw new Error(`detailed-earth map did not become ready: ${JSON.stringify(mapDebug)}`, { cause: error });
    }
    await gateway.page.waitForFunction(() => (
      document.querySelector(".living-atlas-globe")?.getAttribute("data-earth-mode") === "detail"
    ), null, { timeout: 5_000 });
    const detail = await gateway.page.evaluate(() => {
      const canvas = document.querySelector('canvas[data-three-scene="particle-earth"]');
      return {
        sameCanvas: window.__qaDetailEarthCanvas === canvas,
        sameControllerDebug: window.__qaDetailEarthDebug === window.__particleEarthDebug,
        debug: window.__particleEarthDebug?.() ?? null,
        detailReady: document.querySelector(".detailed-earth-map")?.getAttribute("data-map-ready") ?? null,
      };
    });

    await gateway.page.getByRole("button", { name: "返回粒子地球" }).click();
    await gateway.page.waitForFunction(() => (
      document.querySelector(".living-atlas-globe")?.getAttribute("data-earth-mode") === "particle"
    ), null, { timeout: 5_000 });
    await gateway.page.evaluate(() => new Promise((resolve) => (
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    )));
    const returned = await gateway.page.evaluate(() => {
      const canvas = document.querySelector('canvas[data-three-scene="particle-earth"]');
      return {
        sameCanvas: window.__qaDetailEarthCanvas === canvas,
        sameControllerDebug: window.__qaDetailEarthDebug === window.__particleEarthDebug,
        debug: window.__particleEarthDebug?.() ?? null,
      };
    });
    const preserves = (value, expected, tolerance) => (
      typeof value === "number"
      && typeof expected === "number"
      && Math.abs(value - expected) <= tolerance
    );
    const interactionApplied = Boolean(
      interacted
      && before.debug
      && (
        Math.abs(interacted.rotationX - before.debug.rotationX) > 0.01
        || Math.abs(interacted.rotationY - before.debug.rotationY) > 0.01
      )
      && Math.abs(interacted.zoom - before.debug.zoom) > 0.01
    );
    const rotationsRemainValid = [
      detail.debug?.rotationX,
      detail.debug?.rotationY,
      returned.debug?.rotationX,
      returned.debug?.rotationY,
    ].every((value) => typeof value === "number" && Number.isFinite(value));
    const unexpectedErrors = gateway.errors.filter((message) => !message.includes("favicon"));
    return {
      label: "particle-detail-particle-controller-continuity",
      before,
      pointerOwnership,
      interacted,
      rotationChanged,
      zoomChanged,
      detail,
      returned,
      errors: unexpectedErrors,
      failed: !before.sameCanvas
        || !interacted
        || !detail.sameCanvas
        || !detail.sameControllerDebug
        || detail.detailReady !== "true"
        || !returned.sameCanvas
        || !returned.sameControllerDebug
        || returned.debug?.canvases !== 1
        || !interactionApplied
        || !rotationsRemainValid
        || !preserves(detail.debug?.zoom, interacted.zoom, 0.003)
        || !preserves(returned.debug?.zoom, interacted.zoom, 0.003)
        || unexpectedErrors.length > 0,
    };
  } finally {
    await gateway.close();
  }
}

const focusedCase = process.env.QA_LOGIN_CASE?.trim() ?? "";
if (focusedCase) {
  let focusedResult;
  try {
    if (focusedCase === "persistent-earth") {
      focusedResult = await verifyPersistentGatewaySceneContinuity();
    } else if (focusedCase === "detail-map") {
      focusedResult = await verifyDetailedEarthParticleContinuity();
    } else {
      throw new Error(`Unknown QA_LOGIN_CASE: ${focusedCase}`);
    }
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify([focusedResult], null, 2));
  process.exit(focusedResult?.failed ? 1 : 0);
}

try {
  await page.goto(`${origin}/?qaState=login-v3&qaPhase=ready&qaLite=1`, {
    waitUntil: "domcontentloaded",
    timeout: 8_000,
  });
  await page.locator(".auth-card--login-v3").waitFor({ state: "visible", timeout: 4_000 });

  await verifyViewport("desktop", { width: 1280, height: 720 }, false);
  await verifyViewport("tablet", { width: 768, height: 1024 }, false);
  await verifyViewport("mobile", { width: 390, height: 844 }, true);
  await verifyViewport("mobile-compact", { width: 360, height: 800 }, true);

  console.error("[qa-login-v3] intro");
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(`${origin}/?qaState=login-v3&qaLite=1`, { waitUntil: "domcontentloaded", timeout: 8_000 });
  const introCard = page.locator(".auth-card--login-v3");
  await introCard.waitFor({ state: "attached", timeout: 4_000 });
  const before = await introCard.evaluate((element) => ({
    ready: element.classList.contains("is-ready"),
    animationName: getComputedStyle(element).animationName,
  }));
  await page.locator('input[type="email"]').focus();
  await page.waitForTimeout(30);
  const after = await introCard.evaluate((element) => ({
    ready: element.classList.contains("is-ready"),
    opacity: getComputedStyle(element).opacity,
    animationName: getComputedStyle(element).animationName,
  }));
  const introResult = { label: "intro-interaction", before, after, failed: false };
  if (
    before.ready
    || !before.animationName.includes("auth-v3-card-reveal")
    || !after.ready
    || Number(after.opacity) < 0.99
  ) {
    failed = true;
    introResult.failed = true;
  }
  results.push(introResult);

  console.error("[qa-login-v3] handoff");
  await page.goto(`${origin}/?qaState=login-v3&qaPhase=handoff&qaLite=1`, {
    waitUntil: "domcontentloaded",
    timeout: 8_000,
  });
  const handoff = await page.evaluate(() => {
    const card = document.querySelector(".auth-card--login-v3");
    const scene = document.querySelector("[data-login-v3-scene]");
    const earth = document.querySelector(".auth-v3-scene__earth");
    return {
      cardHandoff: card?.classList.contains("is-handoff") ?? false,
      sceneHandoff: scene?.getAttribute("data-login-v3-handoff"),
      cardPointerEvents: card ? getComputedStyle(card).pointerEvents : null,
      cardAnimation: card ? getComputedStyle(card).animationName : null,
      earthAnimation: earth ? getComputedStyle(earth).animationName : null,
    };
  });
  const handoffResult = { label: "handoff", ...handoff, failed: false };
  if (
    !handoff.cardHandoff
    || handoff.sceneHandoff !== "true"
    || handoff.cardPointerEvents !== "none"
    || !handoff.cardAnimation?.includes("auth-v3-panel-dissolve")
    || !handoff.earthAnimation?.includes("auth-v3-earth-expand")
  ) {
    failed = true;
    handoffResult.failed = true;
  }
  results.push(handoffResult);

  console.error("[qa-login-v3] authenticated direct gateway controls");
  const resetPasswordPointers = await verifyAuthenticatedDirectGate(
    "gateway-authenticated-reset-password-pointer-ownership",
    "/reset-password?token=qa-reset-token",
    'input[type="password"]',
  );
  if (resetPasswordPointers.failed) failed = true;
  results.push(resetPasswordPointers);
  const invitationPointers = await verifyAuthenticatedDirectGate(
    "gateway-authenticated-invitation-pointer-ownership",
    "/accept-invitation?id=qa-invitation",
    ".auth-primary",
  );
  if (invitationPointers.failed) failed = true;
  results.push(invitationPointers);

  console.error("[qa-login-v3] persistent earth quality continuity");
  const persistentEarthContinuity = await verifyPersistentGatewaySceneContinuity();
  if (persistentEarthContinuity.failed) failed = true;
  results.push(persistentEarthContinuity);

  console.error("[qa-login-v3] particle/detail controller continuity");
  const detailedEarthContinuity = await verifyDetailedEarthParticleContinuity();
  if (detailedEarthContinuity.failed) failed = true;
  results.push(detailedEarthContinuity);

  console.error("[qa-login-v3] gateway refetch failure recovery");
  const failedGateway = await createGatewayPage({ failAfterSignIn: true });
  try {
    await submitGatewayLogin(failedGateway.page);
    await failedGateway.page.waitForTimeout(350);
    await failedGateway.page.locator(".auth-continuity.is-login").waitFor({ timeout: 4_000 });
    const recovery = await failedGateway.page.evaluate(() => {
      const card = document.querySelector(".auth-card--login-v3");
      return {
        handoff: card?.classList.contains("is-handoff") ?? true,
        pointerEvents: card ? getComputedStyle(card).pointerEvents : null,
      };
    });
    const recoveryMetrics = failedGateway.metrics();
    const unexpectedRecoveryErrors = failedGateway.errors.filter((message) => (
      !message.includes("500 (Internal Server Error)")
    ));
    const recoveryResult = {
      label: "gateway-refetch-failure-recovery",
      ...recovery,
      ...recoveryMetrics,
      expectedNetworkErrors: failedGateway.errors.length - unexpectedRecoveryErrors.length,
      errors: unexpectedRecoveryErrors,
      failed: recovery.handoff
        || recovery.pointerEvents === "none"
        || recoveryMetrics.signInRequests < 1
        || recoveryMetrics.postSignInSessionRequests < 1
        || unexpectedRecoveryErrors.length > 0,
    };
    if (recoveryResult.failed) failed = true;
    results.push(recoveryResult);
  } finally {
    await failedGateway.close();
  }

  console.error("[qa-login-v3] gateway session loss recovery");
  const releasedGateway = await createGatewayPage({ multiPage: true });
  try {
    await submitGatewayLogin(releasedGateway.page);
    await releasedGateway.page.locator(".auth-continuity.is-released").waitFor({ timeout: 15_000 });
    releasedGateway.loseSession();
    await broadcastSessionRefresh(releasedGateway.page, "qa-session-loss");
    await releasedGateway.page.locator(".auth-continuity.is-login").waitFor({ timeout: 5_000 });
    const sessionLoss = await releasedGateway.page.evaluate(() => {
      const card = document.querySelector(".auth-card--login-v3");
      return {
        handoff: card?.classList.contains("is-handoff") ?? true,
        pointerEvents: card ? getComputedStyle(card).pointerEvents : null,
      };
    });
    const sessionLossResult = {
      label: "gateway-session-loss-recovery",
      ...sessionLoss,
      errors: releasedGateway.errors,
      failed: sessionLoss.handoff || sessionLoss.pointerEvents === "none" || releasedGateway.errors.length > 0,
    };
    if (sessionLossResult.failed) failed = true;
    results.push(sessionLossResult);
  } finally {
    await releasedGateway.close();
  }

  if (consoleErrors.length || pageErrors.length) {
    failed = true;
    results.push({ label: "runtime-errors", consoleErrors, pageErrors });
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
