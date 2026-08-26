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

async function createGatewayPage({ failAfterSignIn = false } = {}) {
  const gatewayPage = await browser.newPage({
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
  });
  const errors = [];
  let authenticated = false;
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
  await gatewayPage.goto(`${origin}/?qaState=login-gateway&qaLite=1`, { waitUntil: "domcontentloaded", timeout: 8_000 });
  await gatewayPage.locator(".auth-card--login-v3").waitFor({ state: "visible", timeout: 4_000 });
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
