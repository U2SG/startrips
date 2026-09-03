import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { UNMATCHED_ROUTE, requestLog } from "./request-log";

const RESET_TOKEN = "reset-token-a1b2c3d4e5f6";
const SHARE_TOKEN = "share-token-9z8y7x6w5v4u";
const ASSET_ID = "asset-6f2c1d40";

/**
 * Mirrors the composition of `server/app.ts`: the logger wraps everything, two
 * short-circuiting middlewares sit under `/api/*`, Better Auth is mounted as a
 * catch-all, and the media routes arrive through a nested `.route()` sub-app.
 */
function buildApp(overrides?: { onError?: boolean; blockAll?: boolean }) {
  const app = new Hono();
  app.use("*", requestLog);
  app.use("/api/*", async (context, next) => {
    if (overrides?.blockAll) {
      return context.json({ error: "RATE_LIMITED" }, 429);
    }
    return next();
  });

  app.on(["GET", "POST"], "/api/auth/*", (context) => context.json({ ok: true }));

  const uploadRoutes = new Hono();
  uploadRoutes.get("/assets/:id/read-url", (context) => context.json({ ok: true }));
  app.route("/api/uploads", uploadRoutes);

  const shareRoutes = new Hono();
  shareRoutes.get("/:token/assets/:assetId/read-url", (context) =>
    context.json({ ok: true }),
  );
  shareRoutes.get("/:token/broken", () => {
    throw new Error("share lookup failed");
  });
  shareRoutes.get("/:token/rejected", () => {
    // A non-Error throw is the only input Hono propagates past the failing
    // handler, so it is the only way the logger's own catch branch runs.
    throw "share lookup rejected";
  });
  app.route("/api/shared", shareRoutes);

  app.notFound((context) => context.json({ error: "Not found" }, 404));
  if (overrides?.onError !== false) {
    app.onError((_error, context) => context.json({ error: "Internal" }, 500));
  }
  return app;
}

function captureLogs() {
  return {
    info: vi.spyOn(console, "info").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
  };
}

function lines(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls.map((call) => call.join(" "));
}

describe("request logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs the auth catch-all pattern instead of the mailed reset token", async () => {
    const logs = captureLogs();
    const response = await buildApp().request(
      `/api/auth/reset-password/${RESET_TOKEN}?callbackURL=%2Freset-password`,
    );

    expect(response.status).toBe(200);
    expect(lines(logs.info)).toHaveLength(1);
    expect(lines(logs.info)[0]).toContain("GET /api/auth/* 200");
    expect(lines(logs.info)[0]).not.toContain(RESET_TOKEN);
    expect(lines(logs.info)[0]).not.toContain("reset-password");
  });

  it("logs the parameter pattern of a nested sub-app route", async () => {
    const logs = captureLogs();
    const response = await buildApp().request(
      `/api/uploads/assets/${ASSET_ID}/read-url`,
    );

    expect(response.status).toBe(200);
    expect(lines(logs.info)[0])
      .toContain("GET /api/uploads/assets/:id/read-url 200");
    expect(lines(logs.info)[0]).not.toContain(ASSET_ID);
  });

  it("keeps a share token and asset id out of the log line", async () => {
    const logs = captureLogs();
    const response = await buildApp().request(
      `/api/shared/${SHARE_TOKEN}/assets/${ASSET_ID}/read-url`,
    );

    expect(response.status).toBe(200);
    expect(lines(logs.info)[0])
      .toContain("GET /api/shared/:token/assets/:assetId/read-url 200");
    expect(lines(logs.info)[0]).not.toContain(SHARE_TOKEN);
    expect(lines(logs.info)[0]).not.toContain(ASSET_ID);
  });

  it("keeps the token out of the log when the handler throws an Error", async () => {
    const logs = captureLogs();
    const response = await buildApp().request(`/api/shared/${SHARE_TOKEN}/broken`);

    // Hono's compose resolves an `Error` at the failing dispatch level via
    // `onError`, so the outer logger observes a normal 500 rather than a throw.
    expect(response.status).toBe(500);
    expect(lines(logs.error)).toHaveLength(0);
    expect(lines(logs.info)[0]).toContain("GET /api/shared/:token/broken 500");
    expect(lines(logs.info)[0]).not.toContain(SHARE_TOKEN);
  });

  it("keeps the token out of the failed branch when a throw propagates", async () => {
    const logs = captureLogs();
    await expect(
      buildApp({ onError: false })
        .request(`/api/shared/${SHARE_TOKEN}/rejected`),
    ).rejects.toBeDefined();

    expect(lines(logs.error)).toHaveLength(1);
    expect(lines(logs.error)[0])
      .toContain("GET /api/shared/:token/rejected failed");
    expect(lines(logs.error)[0]).not.toContain(SHARE_TOKEN);
  });

  it("logs the handler pattern when middleware answers before the handler", async () => {
    const logs = captureLogs();
    const response = await buildApp({ blockAll: true })
      .request(`/api/shared/${SHARE_TOKEN}/assets/${ASSET_ID}/read-url`);

    expect(response.status).toBe(429);
    expect(lines(logs.info)[0])
      .toContain("GET /api/shared/:token/assets/:assetId/read-url 429");
    expect(lines(logs.info)[0]).not.toContain(SHARE_TOKEN);
  });

  it("logs a placeholder instead of the raw path of an unmatched request", async () => {
    const logs = captureLogs();
    const app = buildApp();
    const response = await app.request(`/api/nope/${SHARE_TOKEN}`);
    const rootResponse = await app.request(`/reset-password/${RESET_TOKEN}`);

    expect(response.status).toBe(404);
    expect(rootResponse.status).toBe(404);
    expect(lines(logs.info)).toHaveLength(2);
    for (const line of lines(logs.info)) {
      expect(line).toContain(`GET ${UNMATCHED_ROUTE} 404`);
      expect(line).not.toContain(SHARE_TOKEN);
      expect(line).not.toContain(RESET_TOKEN);
      expect(line).not.toContain("/api/nope");
    }
  });
});
