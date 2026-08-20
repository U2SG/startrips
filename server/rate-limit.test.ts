import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createAnonymousRateLimiter } from "./rate-limit";

function buildApp(
  overrides?: { windowSeconds?: number; maxRequests?: number },
) {
  const app = new Hono();
  app.use(
    "/api/*",
    createAnonymousRateLimiter({
      windowSeconds: overrides?.windowSeconds ?? 60,
      maxRequests: overrides?.maxRequests ?? 3,
    }),
  );
  app.get("/api/atlases/current", (context) => context.json({ ok: true }));
  app.get("/api/health", (context) => context.json({ status: "ok" }));
  app.get("/api/auth/session", (context) => context.json({ ok: true }));
  return app;
}

function anonymous(headers: Record<string, string> = {}) {
  return { headers: { "x-forwarded-for": "203.0.113.10", ...headers } };
}

describe("anonymous API rate limiting", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("blocks unauthenticated requests beyond the per-window limit", async () => {
    const app = buildApp({ maxRequests: 3 });
    for (let index = 0; index < 3; index += 1) {
      expect((await app.request("/api/atlases/current", anonymous())).status)
        .toBe(200);
    }

    const blocked = await app.request("/api/atlases/current", anonymous());
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
    expect((await blocked.json()).error).toBe("RATE_LIMITED");
  });

  it("keeps separate budgets for separate client addresses", async () => {
    const app = buildApp({ maxRequests: 1 });
    expect(
      (await app.request("/api/atlases/current", anonymous())).status,
    ).toBe(200);
    expect(
      (await app.request("/api/atlases/current", anonymous())).status,
    ).toBe(429);
    expect(
      (
        await app.request("/api/atlases/current", anonymous({
          "x-forwarded-for": "203.0.113.11",
        }))
      ).status,
    ).toBe(200);
  });

  it("does not trust an unverified session cookie to bypass the budget", async () => {
    const app = buildApp({ maxRequests: 1 });
    const headers = {
      cookie: "startrips.session_token=signed-token",
      "x-forwarded-for": "203.0.113.10",
    };
    expect((await app.request("/api/atlases/current", { headers })).status)
      .toBe(200);
    expect((await app.request("/api/atlases/current", { headers })).status)
      .toBe(429);
  });

  it("exempts health and auth routes from the anonymous budget", async () => {
    const app = buildApp({ maxRequests: 1 });
    await app.request("/api/atlases/current", anonymous());
    expect((await app.request("/api/atlases/current", anonymous())).status)
      .toBe(429);
    expect((await app.request("/api/health", anonymous())).status).toBe(200);
    expect((await app.request("/api/auth/session", anonymous())).status)
      .toBe(200);
  });

  it("resets the budget when the window rolls over", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T12:00:00.000Z"));
    const app = buildApp({ maxRequests: 1 });

    expect((await app.request("/api/atlases/current", anonymous())).status)
      .toBe(200);
    expect((await app.request("/api/atlases/current", anonymous())).status)
      .toBe(429);

    vi.setSystemTime(new Date("2026-08-14T12:01:01.000Z"));
    expect((await app.request("/api/atlases/current", anonymous())).status)
      .toBe(200);
  });
});
