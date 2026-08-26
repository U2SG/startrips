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
} = {}) {
  const gatewayPage = await browser.newPage({
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
  await gatewayPage.goto(`${origin}${initialPath}`, { waitUntil: "domcontentloaded", timeout: 8_000 });
  if (!initialAuthenticated) {
    await gatewayPage.locator(".auth-card--login-v3").waitFor({ state: "visible", timeout: 4_000 });
  }
  return {
    page: gatewayPage,
    errors,
    metrics() { return { signInRequests, postSignInSessionRequests }; },
    loseSession() { authenticated = false; },
  };
}

async function submitGatewayLogin(gatewayPage) {
  await gatewayPage.locator('input[type="email"]').fill("qa@example.com");
  await gatewayPage.locator('input[type="password"]').fill("password1234");
  await gatewayPage.getByRole("button", { name: "登录", exact: true }).click();
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
    await gateway.page.close();
  }
}

async function verifyPersistentGatewaySceneContinuity() {
  const gateway = await createGatewayPage({ initialPath: "/?qaState=login-gateway&qaPhase=ready" });
  try {
    await gateway.page.waitForFunction(() => {
      const debug = window.__particleEarthDebug?.();
      return debug?.quality === "low" && debug.particleCount === 12_000;
    }, null, { timeout: 15_000 });
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
      throw new Error(`persistent login surface disappeared before sign-in: ${JSON.stringify(login)}`);
    }
    const email = gateway.page.locator('input[type="email"]');
    await email.fill("qa@example.com");
    await gateway.page.keyboard.press("Tab");
    const passwordFocused = await gateway.page.evaluate(() => (
      document.activeElement instanceof HTMLInputElement && document.activeElement.type === "password"
    ));
    if (!passwordFocused) {
      throw new Error("persistent login keyboard flow did not reach password");
    }
    await gateway.page.keyboard.type("password1234");
    await gateway.page.keyboard.press("Enter");
    await gateway.page.locator(".auth-continuity.is-released").waitFor({ timeout: 15_000 });
    await gateway.page.waitForFunction(() => {
      const debug = window.__particleEarthDebug?.();
      return debug?.quality === "high" && debug.particleCount === 28_000;
    }, null, { timeout: 15_000 });
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
        || !atlas.stages.includes("handoff")
        || atlas.debug?.quality !== "high"
        || atlas.debug?.particleCount !== 28_000
        || atlas.debug?.canvases !== 1
        || unexpectedErrors.length > 0,
    };
  } finally {
    await gateway.page.close();
  }
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
    await failedGateway.page.close();
  }

  console.error("[qa-login-v3] gateway session loss recovery");
  const releasedGateway = await createGatewayPage();
  try {
    await submitGatewayLogin(releasedGateway.page);
    await releasedGateway.page.locator(".auth-continuity.is-released").waitFor({ timeout: 15_000 });
    releasedGateway.loseSession();
    // Better Auth rate-limits focus/visibility refetches for five seconds after
    // a session request. A synthetic visibilitychange immediately after the
    // handoff is therefore intentionally ignored and makes this QA flaky.
    // Use Better Auth's cross-tab session notification path instead: storage
    // session events trigger an immediate refetch without the focus throttle.
    await releasedGateway.page.evaluate(() => {
      window.dispatchEvent(new StorageEvent("storage", {
        key: "better-auth.message",
        newValue: JSON.stringify({
          event: "session",
          data: { trigger: "qa-session-loss" },
          clientId: "qa-login-v3",
          timestamp: Math.floor(Date.now() / 1_000),
        }),
      }));
    });
    await releasedGateway.page.locator(".auth-continuity.is-login").waitFor({ timeout: 4_000 });
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
    await releasedGateway.page.close();
  }

  if (consoleErrors.length || pageErrors.length) {
    failed = true;
    results.push({ label: "runtime-errors", consoleErrors, pageErrors });
  }
} finally {
  void browser.close();
}

console.log(JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
