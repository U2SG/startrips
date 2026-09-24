import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
// Direct authenticated routes are loaded after a fresh Vite navigation in CI.
// Keep a bounded readiness budget above the old 4s window so cold transforms do
// not create false reds while a genuinely missing control still fails quickly.
const DIRECT_GATE_READY_TIMEOUT_MS = 8_000;
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
  await page.waitForFunction(() => {
    const bodyStyle = getComputedStyle(document.body);
    const htmlStyle = getComputedStyle(document.documentElement);
    return bodyStyle.marginTop === "0px"
      && bodyStyle.marginRight === "0px"
      && bodyStyle.marginBottom === "0px"
      && bodyStyle.marginLeft === "0px"
      && htmlStyle.overflowX === "hidden"
      && htmlStyle.overflowY === "hidden";
  }, null, { timeout: 4_000 });
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
    failed: overlaps.length > 0
      || snapshot.cardOverflow > 1
      || snapshot.overflowX > 0
      || snapshot.overflowY > 0
      || smallTouchTargets.length > 0,
  };
  if (result.failed) failed = true;
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
  journeysDelayMs = 0,
  multiPage = false,
  reducedMotion = "reduce",
  sessionDelayMs = 0,
  waitForAuthCard = true,
} = {}) {
  const context = multiPage
    ? await browser.newContext({
      viewport: { width: 390, height: 844 },
      reducedMotion,
    })
    : null;
  const gatewayPage = context
    ? await context.newPage()
    : await browser.newPage({
      viewport: { width: 390, height: 844 },
      reducedMotion,
    });
  const errors = [];
  let authenticated = initialAuthenticated;
  let signInRequests = 0;
  let postSignInSessionRequests = 0;
  let failedPostSignInSessionResponses = 0;
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
      if (!authenticated && sessionDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, sessionDelayMs));
      }
      if (authenticated) postSignInSessionRequests += 1;
      if (authenticated && failAfterSignIn) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "qa session refresh failed" }) });
        failedPostSignInSessionResponses += 1;
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
  // #332: the Earth experience hydration read every signed-in mount issues.
  // Unstubbed it falls through to no API and logs a 500 the console assertions catch.
  await gatewayPage.route("**/api/account-preferences/earth-experience", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ earthExperience: "default", revision: 0, updatedAt: null }),
  }));
  await gatewayPage.route("**/api/atlases/current", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ atlas: { id: "qa-atlas", title: "QA Atlas", dedication: "" }, role: "owner" }),
  }));
  await gatewayPage.route("**/api/journeys", async (route) => {
    if (journeysDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, journeysDelayMs));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ journeys: [] }),
    });
  });
  await gatewayPage.route("**/api/home-bases/dismissal", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ dismissals: [] }),
  }));
  await gatewayPage.route("**/api/home-bases", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ periods: [] }),
  }));
  await gatewayPage.goto(`${origin}${initialPath}`, { waitUntil: "domcontentloaded", timeout: 8_000 });
  if (!initialAuthenticated && waitForAuthCard) {
    await gatewayPage.locator(".auth-card--login-v3").waitFor({ state: "visible", timeout: 4_000 });
  }
  return {
    page: gatewayPage,
    errors,
    metrics() { return { signInRequests, postSignInSessionRequests, failedPostSignInSessionResponses }; },
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

async function waitForGatewayMetric(gateway, predicate, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const metrics = gateway.metrics();
    if (predicate(metrics)) return metrics;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return gateway.metrics();
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
    try {
      // `goto(..., waitUntil: "domcontentloaded")` returns before Vite/React
      // necessarily finishes hydrating the route on a cold or CPU-throttled
      // CI runner. Four seconds has proven too tight for this direct-gate
      // assertion even when the route is healthy; match the navigation budget
      // so a real missing control still fails deterministically instead of
      // turning runner scheduling jitter into a red main build.
      await target.waitFor({ state: "visible", timeout: DIRECT_GATE_READY_TIMEOUT_MS });
    } catch (error) {
      const diagnostics = await gateway.page.evaluate(() => ({
        href: window.location.href,
        pathname: window.location.pathname,
        readyState: document.readyState,
        bodyText: document.body?.innerText?.slice(0, 800) ?? "",
        authGateCount: document.querySelectorAll(".auth-gate").length,
        passwordInputCount: document.querySelectorAll('input[type="password"]').length,
        persistentEarthStage: document.querySelector("[data-persistent-earth-host]")?.getAttribute("data-stage") ?? null,
      }));
      throw new Error(
        `Direct gateway target ${targetSelector} did not become visible: ${JSON.stringify(diagnostics)}`,
        { cause: error },
      );
    }
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

async function verifyResetPasswordCancellation() {
  console.error("[qa-login-v3] reset password cancellation");
  const gateway = await createGatewayPage({
    initialPath: "/reset-password?token=qa-reset-token&qaState=login-gateway&qaLite=1",
    waitForAuthCard: false,
  });
  let releaseResponse;
  try {
    let resetRequests = 0;
    let requestCaptured;
    const intercepted = new Promise((resolve) => { requestCaptured = resolve; });
    await gateway.page.route("**/api/auth/reset-password", async (route) => {
      resetRequests += 1;
      if (resetRequests === 2) {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ code: "INVALID_TOKEN", message: "Invalid token" }),
        });
        return;
      }
      await new Promise((resolve) => {
        releaseResponse = resolve;
        requestCaptured();
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: true }),
      });
    });
    await gateway.page.locator('input[autocomplete="new-password"]').fill("qa-new-password-123");
    const requestStarted = gateway.page.waitForRequest((request) => (
      new URL(request.url()).pathname === "/api/auth/reset-password"
    ), { timeout: 4_000 });
    await gateway.page.getByRole("button", { name: "更新密码" }).click();
    await requestStarted;
    await intercepted;
    const cancel = gateway.page.getByRole("button", { name: "取消等待" });
    await cancel.waitFor({ state: "visible", timeout: 4_000 });
    const pending = {
      busy: await gateway.page.locator(".auth-card").getAttribute("aria-busy"),
      submitDisabled: await gateway.page.getByRole("button", { name: "请稍候…" }).isDisabled(),
    };
    // A real pointer click checks that the recovery control is reachable.
    await cancel.click();
    const alert = gateway.page.getByRole("alert");
    await alert.waitFor({ state: "visible", timeout: 4_000 });
    const responseReceived = gateway.page.waitForResponse((response) => (
      new URL(response.url()).pathname === "/api/auth/reset-password"
    ), { timeout: 4_000 });
    releaseResponse();
    await responseReceived;
    await gateway.page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
    const recovered = {
      busy: await gateway.page.locator(".auth-card").getAttribute("aria-busy"),
      alert: await alert.textContent(),
      submitEnabled: await gateway.page.getByRole("button", { name: "更新密码" }).isEnabled(),
      requestAgainVisible: await gateway.page.getByRole("link", { name: "重新申请重置链接" }).isVisible(),
      successVisible: await gateway.page.getByRole("status").count() > 0,
    };
    const retryResponse = gateway.page.waitForResponse((response) => (
      new URL(response.url()).pathname === "/api/auth/reset-password" && response.status() === 400
    ), { timeout: 4_000 });
    await gateway.page.getByRole("button", { name: "更新密码" }).click();
    await retryResponse;
    await gateway.page.waitForFunction(() => (
      document.querySelector('[role="alert"]')?.textContent?.includes("前一次提交结果仍未确认")
    ), null, { timeout: 4_000 });
    const retry = {
      alert: await alert.textContent(),
      requestAgainVisible: await gateway.page.getByRole("link", { name: "重新申请重置链接" }).isVisible(),
      returnLoginVisible: await gateway.page.getByRole("link", { name: "返回登录" }).isVisible(),
      submitGone: await gateway.page.getByRole("button", { name: "更新密码" }).count() === 0,
    };
    const unexpectedErrors = gateway.errors.filter((message) => !message.includes("400 (Bad Request)"));
    return {
      label: "reset-password-cancel-late-success-retry-invalid-token",
      pending,
      recovered,
      retry,
      errors: unexpectedErrors,
      failed: pending.busy !== "true"
        || !pending.submitDisabled
        || recovered.busy !== "false"
        || !recovered.alert?.includes("无法确认密码是否已更新")
        || !recovered.submitEnabled
        || !recovered.requestAgainVisible
        || recovered.successVisible
        || resetRequests !== 2
        || !retry.alert?.includes("前一次提交结果仍未确认")
        || !retry.alert?.includes("前一次提交的密码尝试登录")
        || !retry.requestAgainVisible
        || !retry.returnLoginVisible
        || !retry.submitGone
        || unexpectedErrors.length > 0,
    };
  } finally {
    releaseResponse?.();
    await gateway.close();
  }
}

async function verifyResetPasswordMailLinkHappyPath() {
  console.error("[qa-login-v3] reset password emitted-mail happy path");
  const email = `qa-reset-happy-${randomUUID()}@example.test`;
  const originalPassword = "qa-original-password-123";
  const replacementPassword = "qa-replacement-password-456";
  const authStore = {
    user: [],
    session: [],
    account: [],
    verification: [],
  };
  let verificationMailResolve;
  let resetMailResolve;
  const verificationMailPromise = new Promise((resolve) => { verificationMailResolve = resolve; });
  const resetMailPromise = new Promise((resolve) => { resetMailResolve = resolve; });
  const qaAuth = betterAuth({
    appName: "Startrips QA",
    baseURL: origin,
    secret: "qa-only-startrips-reset-secret-with-more-than-thirty-two-bytes",
    database: memoryAdapter(authStore),
    trustedOrigins: [origin],
    advanced: {
      cookiePrefix: "startrips",
      useSecureCookies: false,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      expiresIn: 60 * 60,
      async sendVerificationEmail({ user, url }) {
        if (user.email === email) verificationMailResolve(url);
      },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      async sendResetPassword({ user, url }) {
        if (user.email === email) resetMailResolve(url);
      },
    },
  });

  const authRequest = async (pathOrUrl, { method = "GET", body, cookie } = {}) => {
    const url = pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")
      ? pathOrUrl
      : `${origin}${pathOrUrl}`;
    const headers = new Headers({ origin });
    if (body !== undefined) headers.set("content-type", "application/json");
    if (cookie) headers.set("cookie", cookie);
    return qaAuth.handler(new Request(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    }));
  };

  const awaitMail = async (promise, label) => Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} was not emitted`)), 4_000);
    }),
  ]);

  const fulfillFromAuth = async (route) => {
    const request = route.request();
    const headers = new Headers(request.headers());
    headers.set("origin", origin);
    const response = await qaAuth.handler(new Request(request.url(), {
      method: request.method(),
      headers,
      body: ["GET", "HEAD"].includes(request.method()) ? undefined : request.postData() ?? undefined,
      redirect: "manual",
    }));
    const responseHeaders = {};
    response.headers.forEach((value, key) => { responseHeaders[key] = value; });
    await route.fulfill({
      status: response.status,
      headers: responseHeaders,
      body: Buffer.from(await response.arrayBuffer()),
    });
  };

  const flowConsole = [];
  let requestPayloadValid = false;
  let resetPayloadValid = false;
  let requestGateway = null;
  let resetGateway = null;
  try {
    const signUp = await authRequest("/api/auth/sign-up/email", {
      method: "POST",
      body: { name: "QA Reset Traveler", email, password: originalPassword },
    });
    const verificationMailLink = await awaitMail(verificationMailPromise, "verification mail");
    const verificationUrl = new URL(verificationMailLink);
    const verificationTargetValid = verificationUrl.origin === origin
      && verificationUrl.pathname === "/api/auth/verify-email"
      && verificationUrl.searchParams.has("token");
    const verified = verificationTargetValid
      ? await authRequest(verificationMailLink)
      : null;

    const initialSignIn = await authRequest("/api/auth/sign-in/email", {
      method: "POST",
      body: { email, password: originalPassword },
    });
    const initialSignInBody = initialSignIn.status === 200 ? await initialSignIn.json() : null;
    const initialUserId = initialSignInBody?.user?.id ?? null;
    const setCookie = initialSignIn.headers.get("set-cookie") ?? "";
    const sessionMatch = setCookie.match(/(?:__Secure-)?startrips\.session_token=[^;,\s]+/);
    const oldSessionCookie = sessionMatch?.[0] ?? null;
    const beforeResetSession = oldSessionCookie
      ? await authRequest("/api/auth/get-session", { cookie: oldSessionCookie })
      : null;
    const beforeResetSessionBody = beforeResetSession?.status === 200
      ? await beforeResetSession.json()
      : null;

    requestGateway = await createGatewayPage({
      initialPath: "/?qaState=login-gateway&qaLite=1",
    });
    requestGateway.page.on("console", (message) => flowConsole.push(message.text()));
    await requestGateway.page.route("**/api/auth/request-password-reset", async (route) => {
      const body = route.request().postDataJSON() ?? {};
      const redirect = typeof body.redirectTo === "string" ? new URL(body.redirectTo) : null;
      requestPayloadValid = body.email === email
        && redirect?.origin === origin
        && redirect.pathname === "/reset-password";
      await fulfillFromAuth(route);
    });

    await requestGateway.page.getByRole("button", { name: "忘记密码" }).click();
    await requestGateway.page.locator('input[type="email"]').fill(email);
    const requested = requestGateway.page.waitForResponse((response) => (
      new URL(response.url()).pathname === "/api/auth/request-password-reset"
    ), { timeout: 4_000 });
    await requestGateway.page.getByRole("button", { name: "发送重置链接" }).click();
    const requestResponse = await requested;
    await requestGateway.page.getByRole("status").waitFor({ state: "visible", timeout: 4_000 });

    const resetMailLink = await awaitMail(resetMailPromise, "password reset mail");
    const mailUrl = new URL(resetMailLink);
    const resetEndpointPrefix = "/api/auth/reset-password/";
    const encodedResetToken = mailUrl.pathname.startsWith(resetEndpointPrefix)
      ? mailUrl.pathname.slice(resetEndpointPrefix.length)
      : "";
    const resetToken = encodedResetToken ? decodeURIComponent(encodedResetToken) : "";
    const callbackValue = mailUrl.searchParams.get("callbackURL");
    const callbackUrl = callbackValue ? new URL(callbackValue, origin) : null;
    const legalMailLink = mailUrl.origin === origin
      && mailUrl.pathname.startsWith(resetEndpointPrefix)
      && Boolean(resetToken)
      && callbackUrl?.origin === origin
      && callbackUrl.pathname === "/reset-password";
    const mailRedirect = legalMailLink && resetToken
      ? await authRequest(resetMailLink)
      : null;
    const redirectValue = mailRedirect?.headers.get("location") ?? "";
    const redirectUrl = redirectValue ? new URL(redirectValue, origin) : null;
    const redirectToken = redirectUrl?.searchParams.get("token") ?? "";
    const legalResetTarget = Boolean(mailRedirect)
      && mailRedirect.status >= 300
      && mailRedirect.status < 400
      && redirectUrl?.origin === origin
      && redirectUrl.pathname === "/reset-password"
      && redirectToken === resetToken;
    if (!legalMailLink || !resetToken || !legalResetTarget || !redirectUrl) {
      return {
        label: "reset-password-emitted-mail-happy-path",
        mail: {
          captured: Boolean(resetMailLink),
          legalTarget: legalMailLink,
          legalRedirect: legalResetTarget,
          requestAccepted: requestResponse.status() === 200,
          requestPayloadValid,
        },
        setup: {
          signUpAccepted: signUp.status === 200,
          verificationTargetValid,
          verificationAccepted: Boolean(verified && verified.status >= 200 && verified.status < 400),
        },
        failed: true,
      };
    }

    redirectUrl.searchParams.set("qaState", "login-gateway");
    redirectUrl.searchParams.set("qaLite", "1");
    resetGateway = await createGatewayPage({
      initialPath: `${redirectUrl.pathname}${redirectUrl.search}`,
      waitForAuthCard: false,
    });
    resetGateway.page.on("console", (message) => flowConsole.push(message.text()));
    await resetGateway.page.route("**/api/auth/reset-password", async (route) => {
      const body = route.request().postDataJSON() ?? {};
      resetPayloadValid = body.token === resetToken
        && body.newPassword === replacementPassword;
      await fulfillFromAuth(route);
    });
    await resetGateway.page.locator('input[autocomplete="new-password"]').fill(replacementPassword);
    const resetResponsePromise = resetGateway.page.waitForResponse((response) => (
      new URL(response.url()).pathname === "/api/auth/reset-password"
    ), { timeout: 4_000 });
    await resetGateway.page.getByRole("button", { name: "更新密码" }).click();
    const resetResponse = await resetResponsePromise;
    const resetStatus = resetGateway.page.getByRole("status");
    await resetStatus.waitFor({ state: "visible", timeout: 4_000 });
    const resetMessage = await resetStatus.textContent();

    const afterResetSession = oldSessionCookie
      ? await authRequest("/api/auth/get-session", { cookie: oldSessionCookie })
      : null;
    const afterResetSessionBody = afterResetSession?.status === 200
      ? await afterResetSession.json()
      : null;
    const oldSessionRevoked = Boolean(beforeResetSessionBody?.user?.id)
      && !afterResetSessionBody?.user?.id;

    const oldPasswordLogin = await authRequest("/api/auth/sign-in/email", {
      method: "POST",
      body: { email, password: originalPassword },
    });
    const newPasswordLogin = await authRequest("/api/auth/sign-in/email", {
      method: "POST",
      body: { email, password: replacementPassword },
    });
    const newPasswordBody = newPasswordLogin.status === 200
      ? await newPasswordLogin.json()
      : null;
    const stableUser = Boolean(initialUserId)
      && newPasswordBody?.user?.id === initialUserId;

    const allErrors = [
      ...(requestGateway?.errors ?? []),
      ...(resetGateway?.errors ?? []),
    ];
    const unexpectedErrors = allErrors.filter((message) => !message.includes("401"));
    const tokenLeakDetected = flowConsole.some((message) => message.includes(resetToken))
      || allErrors.some((message) => message.includes(resetToken));

    return {
      label: "reset-password-emitted-mail-happy-path",
      setup: {
        signUpAccepted: signUp.status === 200,
        verificationTargetValid,
        verificationAccepted: Boolean(verified && verified.status >= 200 && verified.status < 400),
      },
      mail: {
        captured: true,
        legalTarget: true,
        legalRedirect: true,
        callbackPath: callbackUrl.pathname,
        tokenPresent: true,
        requestAccepted: requestResponse.status() === 200,
        requestPayloadValid,
      },
      reset: {
        accepted: resetResponse.status() === 200,
        payloadBoundToEmittedMail: resetPayloadValid,
        successVisible: resetMessage?.includes("密码已更新") ?? false,
      },
      session: {
        existedBeforeReset: Boolean(beforeResetSessionBody?.user?.id),
        oldSessionRevoked,
      },
      signIn: {
        oldPasswordRejected: oldPasswordLogin.status !== 200,
        newPasswordAccepted: newPasswordLogin.status === 200,
        stableUser,
      },
      tokenLeakDetected,
      errors: unexpectedErrors,
      failed: signUp.status !== 200
        || !verificationTargetValid
        || !verified
        || verified.status < 200
        || verified.status >= 400
        || initialSignIn.status !== 200
        || !initialUserId
        || !oldSessionCookie
        || !beforeResetSessionBody?.user?.id
        || requestResponse.status() !== 200
        || !requestPayloadValid
        || resetResponse.status() !== 200
        || !resetPayloadValid
        || !resetMessage?.includes("密码已更新")
        || !oldSessionRevoked
        || oldPasswordLogin.status === 200
        || newPasswordLogin.status !== 200
        || !stableUser
        || tokenLeakDetected
        || unexpectedErrors.length > 0,
    };
  } finally {
    await resetGateway?.close();
    await requestGateway?.close();
  }
}

async function verifyLoginEarthIntroRotationContinuity() {
  console.error("[qa-login-v3] login earth intro rotation continuity");
  const gateway = await createGatewayPage({
    initialPath: "/?qaState=login-gateway",
    reducedMotion: "no-preference",
    sessionDelayMs: 1_200,
    waitForAuthCard: false,
  });
  try {
    await gateway.page.locator('canvas[data-three-scene="particle-earth"]').waitFor({
      state: "attached",
      timeout: 6_000,
    });
    await gateway.page.waitForFunction(() => typeof window.__particleEarthDebug === "function", null, {
      timeout: 6_000,
    });
    const samples = [];
    for (let index = 0; index < 20; index += 1) {
      samples.push(await gateway.page.evaluate(() => window.__particleEarthDebug?.() ?? null));
      await gateway.page.waitForTimeout(120);
    }
    const modes = samples.map((sample) => sample?.mode ?? null);
    const modeTransitions = modes.slice(1).reduce((count, mode, index) => (
      mode !== modes[index] ? count + 1 : count
    ), 0);
    const rotationYs = samples
      .map((sample) => sample?.rotationY)
      .filter((value) => Number.isFinite(value));
    const maxAbsRotationY = rotationYs.length
      ? Math.max(...rotationYs.map((value) => Math.abs(value)))
      : Number.POSITIVE_INFINITY;
    const rotationSpan = rotationYs.length
      ? Math.max(...rotationYs) - Math.min(...rotationYs)
      : Number.POSITIVE_INFINITY;
    const unexpectedErrors = gateway.errors.filter((message) => !message.includes("favicon"));
    return {
      label: "login-earth-intro-rotation-continuity",
      samples: samples.map((sample) => ({ mode: sample?.mode ?? null, rotationY: sample?.rotationY ?? null })),
      maxAbsRotationY,
      rotationSpan,
      modeTransitions,
      errors: unexpectedErrors,
      failed: rotationYs.length !== samples.length
        || modes[0] !== "archiveBurst"
        || modes.at(-1) !== "particleSphere"
        || modeTransitions !== 1
        || maxAbsRotationY > 0.03
        || rotationSpan > 0.02
        || unexpectedErrors.length > 0,
    };
  } finally {
    await gateway.close();
  }
}

async function verifyBrandLoaderContinuity() {
  console.error("[qa-login-v3] brand loader continuity");
  const gateway = await createGatewayPage({
    initialAuthenticated: true,
    initialPath: "/?qaState=final-acceptance&qaLite=1",
    journeysDelayMs: 1_200,
  });
  try {
    const loader = gateway.page.locator(".living-atlas.is-loading .startrips-brand-loader");
    await loader.waitFor({ state: "visible", timeout: 5_000 });
    await loader.locator(".startrips-signature-motion").waitFor({ state: "visible" });
    await gateway.page.waitForFunction(() => (
      document.querySelector("[data-persistent-earth-host]")?.getAttribute("data-stage") === "atlas"
    ), null, { timeout: 5_000 });
    const loading = await gateway.page.evaluate(() => {
      const host = document.querySelector("[data-persistent-earth-host]");
      const surface = document.querySelector(".living-atlas.is-loading");
      const signature = document.querySelector(".startrips-brand-loader .startrips-signature-motion");
      const art = signature?.querySelector(".startrips-signature-motion__svg");
      const bbox = art instanceof SVGGraphicsElement ? art.getBBox() : null;
      window.__qaBrandLoaderHost = host;
      return {
        hostStage: host?.getAttribute("data-stage") ?? null,
        hasPersistentEarth: Boolean(document.querySelector('[data-three-scene="particle-earth"]')),
        backgroundColor: surface ? getComputedStyle(surface).backgroundColor : null,
        backgroundImage: surface ? getComputedStyle(surface).backgroundImage : null,
        brandVersion: signature?.getAttribute("data-brand-version") ?? null,
        signatureClip: signature?.getAttribute("data-signature-clip") ?? null,
        signatureStatus: signature?.getAttribute("data-signature-status") ?? null,
        signatureDriverCount: Number(signature?.getAttribute("data-signature-driver-count") ?? "NaN"),
        artReady: Boolean(bbox && bbox.width > 100 && bbox.height > 40),
        artAnimation: art ? getComputedStyle(art).animationName : null,
        artOpacity: art ? getComputedStyle(art).opacity : null,
        legacyBrandNodes: document.querySelectorAll(
          ".startrips-wordmark__lamb, .startrips-wordmark__star, .startrips-loading-points",
        ).length,
      };
    });
    await gateway.page.locator(".living-atlas[data-journey-count]").waitFor({ state: "attached", timeout: 5_000 });
    const settled = await gateway.page.evaluate(() => ({
      sameHost: window.__qaBrandLoaderHost === document.querySelector("[data-persistent-earth-host]"),
      hostStage: document.querySelector("[data-persistent-earth-host]")?.getAttribute("data-stage") ?? null,
      hasPersistentEarth: Boolean(document.querySelector('[data-three-scene="particle-earth"]')),
    }));
    const unexpectedErrors = gateway.errors.filter((message) => !message.includes("favicon"));
    return {
      label: "brand-loader-persistent-earth-reduced-motion",
      loading,
      settled,
      errors: unexpectedErrors,
      failed: loading.hostStage !== "atlas"
        || !loading.hasPersistentEarth
        || loading.backgroundColor !== "rgba(0, 0, 0, 0)"
        || loading.backgroundImage !== "none"
        || loading.brandVersion !== "12"
        || loading.signatureClip !== "loading"
        || loading.signatureStatus !== "reduced"
        || loading.signatureDriverCount !== 0
        || !loading.artReady
        || loading.artAnimation !== "none"
        || loading.artOpacity !== "1"
        || loading.legacyBrandNodes !== 0
        || !settled.sameHost
        || settled.hostStage !== "atlas"
        || !settled.hasPersistentEarth
        || unexpectedErrors.length > 0,
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
    // Keep this QA deterministic against the app's current same-origin style
    // proxy. It previously intercepted the upstream /styles/fiord URL, so
    // switching the production default to /api/mapstyle made CI accidentally
    // hit the real proxy/upstream and fail on network availability.
    await gateway.page.route(
      /\/api\/mapstyle\?path=styles(?:%2F|\/)fiord(?:$|&)/i,
      (route) => route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          version: 8,
          name: "QA empty detailed-earth style",
          sources: {},
          layers: [],
        }),
      }),
    );
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

    // Mobile V2 retires the detail utility cluster, but #308 still requires one
    // non-gesture Semantic Dive path for keyboard/switch users. Prove that the
    // renderer-agnostic intent is independently mounted and exposes a touch-safe
    // focus target before crossing the responsive boundary.
    const mobileDiveIntent = gateway.page.locator('[data-earth-dive-intent="true"]');
    if (await mobileDiveIntent.count() !== 1) {
      throw new Error("compact mobile Semantic Earth Dive keyboard intent is missing or duplicated");
    }
    await gateway.page.evaluate(() => {
      document.querySelector("[data-qa-mobile-dive-tab-sentinel]")?.remove();
      const controls = document.querySelector(".living-atlas-globe__controls");
      if (!controls?.parentElement) return;
      const sentinel = document.createElement("button");
      sentinel.type = "button";
      sentinel.dataset.qaMobileDiveTabSentinel = "true";
      sentinel.textContent = "qa-before-mobile-semantic-dive";
      sentinel.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0";
      controls.parentElement.insertBefore(sentinel, controls);
      sentinel.focus();
    });
    await gateway.page.keyboard.press("Tab");
    const mobileDiveIntentState = await mobileDiveIntent.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      const name = button.getAttribute("aria-label") ?? "";
      return {
        name,
        focused: document.activeElement === button,
        focusVisible: button.matches(":focus-visible"),
        width: rect.width,
        height: rect.height,
        visible: style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0.01,
        forbiddenModeLanguage: /真实地图|REGION MAP|ART GLOBE|particle|detail/i.test(name),
      };
    });
    await gateway.page.evaluate(() => document.querySelector("[data-qa-mobile-dive-tab-sentinel]")?.remove());
    if (!mobileDiveIntentState.focused
      || !mobileDiveIntentState.focusVisible
      || !mobileDiveIntentState.visible
      || mobileDiveIntentState.width < 43.5
      || mobileDiveIntentState.height < 43.5
      || mobileDiveIntentState.forbiddenModeLanguage) {
      throw new Error(`compact mobile Semantic Earth Dive keyboard intent is not actionable: ${JSON.stringify(mobileDiveIntentState)}`);
    }

    // Keep the real drag/wheel ownership assertion above at 390x844, then cross
    // the responsive boundary on the same page before exercising the full
    // particle -> detail -> particle round trip. The persistent Earth contract
    // requires the canvas/controller to survive that viewport transition too.
    await gateway.page.setViewportSize({ width: 768, height: 1024 });
    await gateway.page.waitForFunction(() => (
      document.querySelector(".living-atlas")?.getAttribute("data-mobile-v2") === "off"
    ), null, { timeout: 5_000 });
    await gateway.page.evaluate(() => new Promise((resolve) => (
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    )));
    const desktopBoundary = await gateway.page.evaluate(() => {
      const canvas = document.querySelector('canvas[data-three-scene="particle-earth"]');
      return {
        sameCanvas: window.__qaDetailEarthCanvas === canvas,
        sameControllerDebug: window.__qaDetailEarthDebug === window.__particleEarthDebug,
        mobileV2: document.querySelector(".living-atlas")?.getAttribute("data-mobile-v2") ?? null,
        debug: window.__particleEarthDebug?.() ?? null,
      };
    });
    if (!desktopBoundary.sameCanvas || !desktopBoundary.sameControllerDebug || desktopBoundary.mobileV2 !== "off") {
      throw new Error(`persistent particle-earth responsive handoff failed: ${JSON.stringify(desktopBoundary)}`);
    }

    const diveIntent = gateway.page.locator('[data-earth-dive-intent="true"]');
    if (await diveIntent.count() !== 1) {
      throw new Error("Semantic Earth Dive keyboard intent affordance is missing or duplicated");
    }
    await diveIntent.focus();
    const diveIntentState = await diveIntent.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const name = button.getAttribute("aria-label") ?? "";
      return {
        name,
        focused: document.activeElement === button,
        visible: getComputedStyle(button).visibility !== "hidden" && Number(getComputedStyle(button).opacity) > 0.01,
        hitOwned: hit === button || button.contains(hit),
        hitTag: hit?.tagName ?? null,
        hitClass: hit instanceof HTMLElement || hit instanceof SVGElement ? hit.getAttribute("class") : null,
        hitAriaLabel: hit instanceof Element ? hit.getAttribute("aria-label") : null,
        buttonPointerEvents: getComputedStyle(button).pointerEvents,
        buttonRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        forbiddenModeLanguage: /真实地图|REGION MAP|ART GLOBE|particle|detail/i.test(name),
      };
    });
    if (!diveIntentState.focused || !diveIntentState.visible || !diveIntentState.hitOwned || diveIntentState.forbiddenModeLanguage) {
      throw new Error(`Semantic Earth Dive keyboard intent is not actionable: ${JSON.stringify(diveIntentState)}`);
    }
    await gateway.page.keyboard.press("Enter");
    try {
      await gateway.page.locator(".detailed-earth-map").waitFor({
        state: "attached",
        timeout: 4_000,
      });
    } catch (error) {
      const mountDebug = await gateway.page.evaluate(() => ({
        earthMode: document.querySelector(".living-atlas-globe")?.getAttribute("data-earth-mode") ?? null,
        globeClass: document.querySelector(".living-atlas-globe")?.className ?? null,
        earthDive: document.querySelector(".living-atlas-globe")?.getAttribute("data-earth-dive") ?? null,
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
          earthDive: document.querySelector(".living-atlas-globe")?.getAttribute("data-earth-dive") ?? null,
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

    await diveIntent.focus();
    const returnIntentName = await diveIntent.getAttribute("aria-label");
    if (!returnIntentName || /真实地图|REGION MAP|ART GLOBE|particle|detail/i.test(returnIntentName)) {
      throw new Error(`Semantic Earth Dive return intent leaked renderer terminology: ${returnIntentName}`);
    }
    await gateway.page.keyboard.press("Enter");
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
      desktopBoundary,
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
        || !desktopBoundary.sameCanvas
        || !desktopBoundary.sameControllerDebug
        || desktopBoundary.mobileV2 !== "off"
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
    } else if (focusedCase === "brand-loader") {
      focusedResult = await verifyBrandLoaderContinuity();
    } else if (focusedCase === "login-earth-intro") {
      focusedResult = await verifyLoginEarthIntroRotationContinuity();
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
  // DOMContentLoaded can precede the async DEV fixture and React commit.
  // Wait for the rendered nodes; handoff deliberately makes them invisible.
  await page.waitForFunction(() => (
    document.querySelector(".auth-card--login-v3")
    && document.querySelector("[data-login-v3-scene][data-login-v3-handoff]")
    && document.querySelector(".auth-v3-scene__earth")
  ), null, { timeout: 8_000 });
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
  const resetPasswordCancellation = await verifyResetPasswordCancellation();
  if (resetPasswordCancellation.failed) failed = true;
  results.push(resetPasswordCancellation);
  const resetPasswordHappyPath = await verifyResetPasswordMailLinkHappyPath();
  if (resetPasswordHappyPath.failed) failed = true;
  results.push(resetPasswordHappyPath);
  const invitationPointers = await verifyAuthenticatedDirectGate(
    "gateway-authenticated-invitation-pointer-ownership",
    "/accept-invitation?id=qa-invitation",
    ".auth-primary",
  );
  if (invitationPointers.failed) failed = true;
  results.push(invitationPointers);

  const loginEarthIntroContinuity = await verifyLoginEarthIntroRotationContinuity();
  if (loginEarthIntroContinuity.failed) failed = true;
  results.push(loginEarthIntroContinuity);

  const brandLoaderContinuity = await verifyBrandLoaderContinuity();
  if (brandLoaderContinuity.failed) failed = true;
  results.push(brandLoaderContinuity);

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
    const completedRefetchMetrics = await waitForGatewayMetric(
      failedGateway,
      (metrics) => metrics.failedPostSignInSessionResponses >= 1,
    );
    await failedGateway.page.locator(".auth-continuity.is-login").waitFor({ timeout: 4_000 });
    await failedGateway.page.locator(".auth-card--login-v3").waitFor({ state: "visible", timeout: 4_000 });
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
        || completedRefetchMetrics.failedPostSignInSessionResponses < 1
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
} catch (error) {
  // The accumulated results are this lane's only diagnostic record; a thrown
  // step must not take them down with it (#439). Print first, then rethrow so
  // the original failure and the non-zero exit are unchanged.
  console.log(JSON.stringify(results, null, 2));
  throw error;
} finally {
  await browser.close();
}

console.log(JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
