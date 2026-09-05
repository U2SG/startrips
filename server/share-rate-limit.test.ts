import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  ShareAccessError,
  generateShareToken,
  shareUnavailable,
} from "./authorization/share-access";
import {
  FixedWindowCounter,
  createShareRateLimiter,
  isMediaReadPath,
} from "./share-rate-limit";

const LIMITS = {
  windowSeconds: 60,
  dataMaxRequests: 3,
  mediaMaxRequests: 5,
  unknownTokenMaxRequests: 2,
};

/**
 * A stand-in for the guest routes, shaped like the real ones in the way that
 * matters here: `/dead` THROWS `ShareAccessError` the way
 * `requireActiveShareGrant` does and lets `onError` turn it into the generic
 * 404, while `/assets/gone/read-url` RETURNS the asset-side 404 the route
 * builds itself. The limiter has to tell those two apart, and it can only do
 * that because one is a throw and the other is a response.
 *
 * A stub rather than the real routes keeps this a test of the budget
 * arithmetic with no database in it; the integration suite drives the real
 * ones.
 */
function limitedApp(overrides: Partial<typeof LIMITS> = {}) {
  const app = new Hono();
  app.use("*", createShareRateLimiter({ ...LIMITS, ...overrides }));
  app.get("/journeys", (context) => context.json({ journeys: [] }));
  app.get("/dead", () => {
    throw shareUnavailable();
  });
  app.get("/assets/:assetId/read-url", (context) =>
    context.req.param("assetId") === "gone"
      ? context.json(
        { error: "MEDIA_UNAVAILABLE", message: "Media unavailable" },
        404,
      )
      : context.json({ url: "https://storage.example/object" }));
  // The same mapping `server/app.ts` applies, so a thrown grant failure
  // reaches the caller as the one generic unavailable body.
  app.onError((error, context) => {
    if (error instanceof ShareAccessError) {
      return context.json({ error: error.code, message: error.message }, error.status);
    }
    throw error;
  });
  return app;
}

function guestRequest(
  app: Hono,
  path: string,
  options: { token?: string; address?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.address) headers["x-forwarded-for"] = options.address;
  return app.request(`http://localhost${path}`, { headers });
}

describe("guest share rate limiting", () => {
  it("charges data reads to the grant, not to the recipient's address", async () => {
    const app = limitedApp();
    const token = generateShareToken();
    // Four different recipients of one forwarded link. The budget is the
    // link's, so the fourth request is refused even though every address is
    // seen for the first time.
    const statuses: number[] = [];
    for (const address of ["203.0.113.1", "203.0.113.2", "198.51.100.7", "192.0.2.9"]) {
      const response = await guestRequest(app, "/journeys", { token, address });
      statuses.push(response.status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it("gives each grant its own budget", async () => {
    const app = limitedApp();
    const first = generateShareToken();
    const second = generateShareToken();
    for (let index = 0; index < LIMITS.dataMaxRequests; index += 1) {
      expect((await guestRequest(app, "/journeys", { token: first })).status)
        .toBe(200);
    }
    expect((await guestRequest(app, "/journeys", { token: first })).status)
      .toBe(429);
    // A second link is untouched by the first one exhausting its budget.
    expect((await guestRequest(app, "/journeys", { token: second })).status)
      .toBe(200);
  });

  it("counts media issuance against its own budget, not the data one", async () => {
    const app = limitedApp();
    const token = generateShareToken();
    // #197 prefetch bursts must not consume the payload-refresh budget: five
    // media reads is past `dataMaxRequests` and still inside `mediaMaxRequests`.
    for (let index = 0; index < LIMITS.mediaMaxRequests; index += 1) {
      const response = await guestRequest(
        app,
        `/assets/asset-${index}/read-url`,
        { token },
      );
      expect(response.status).toBe(200);
    }
    expect((await guestRequest(app, "/assets/next/read-url", { token })).status)
      .toBe(429);
    // The data budget was never touched by any of them.
    expect((await guestRequest(app, "/journeys", { token })).status).toBe(200);
  });

  it("refuses a token-guessing flood by address and answers Retry-After", async () => {
    const app = limitedApp();
    const address = "203.0.113.55";
    for (let index = 0; index < LIMITS.unknownTokenMaxRequests; index += 1) {
      // Each attempt is a different token, so nothing about the flood is
      // charged to a grant; only the address budget accumulates.
      const response = await guestRequest(app, "/dead", {
        token: generateShareToken(),
        address,
      });
      expect(response.status).toBe(404);
    }
    const refused = await guestRequest(app, "/dead", {
      token: generateShareToken(),
      address,
    });
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe("60");
    expect(await refused.json()).toEqual({
      error: "RATE_LIMITED",
      message: "Too many requests",
    });
    // A different address is unaffected: the budget is the caller's.
    expect((await guestRequest(app, "/dead", {
      token: generateShareToken(),
      address: "198.51.100.4",
    })).status).toBe(404);
  });

  it("bounds a CONCURRENT token-guessing batch, not only a serial one", async () => {
    const app = limitedApp();
    const address = "203.0.113.66";
    // The reason the address budget is reserved before the handler rather
    // than charged after it: every request in one batch would otherwise read
    // an un-charged counter and pass, so the ceiling would cap nothing an
    // attacker could simply send all at once — and each of those requests
    // costs a database lookup, which is what the budget exists to bound.
    const statuses = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const response = await guestRequest(app, "/dead", {
          token: generateShareToken(),
          address,
        });
        return response.status;
      }),
    );
    expect(statuses.filter((status) => status === 404))
      .toHaveLength(LIMITS.unknownTokenMaxRequests);
    expect(statuses.filter((status) => status === 429))
      .toHaveLength(10 - LIMITS.unknownTokenMaxRequests);
  });

  it("charges a bearer-less request to the address budget too", async () => {
    const app = limitedApp();
    const address = "203.0.113.77";
    for (let index = 0; index < LIMITS.unknownTokenMaxRequests; index += 1) {
      expect((await guestRequest(app, "/dead", { address })).status).toBe(404);
    }
    expect((await guestRequest(app, "/dead", { address })).status).toBe(429);
  });

  it("never spends the probe budget on a working link", async () => {
    const app = limitedApp({ dataMaxRequests: 50, mediaMaxRequests: 50 });
    const token = generateShareToken();
    const address = "203.0.113.90";
    for (let index = 0; index < 20; index += 1) {
      expect((await guestRequest(app, "/journeys", { token, address })).status)
        .toBe(200);
    }
    // Twenty successful reads later the address still has its full probe
    // budget: a recipient behind a shared NAT is never mistaken for a flood.
    for (let index = 0; index < LIMITS.unknownTokenMaxRequests; index += 1) {
      expect((await guestRequest(app, "/dead", { address })).status).toBe(404);
    }
    expect((await guestRequest(app, "/dead", { address })).status).toBe(429);
  });

  it("does not charge the probe budget for a withdrawn asset", async () => {
    const app = limitedApp();
    const token = generateShareToken();
    const address = "203.0.113.91";
    // The owner moved these photos out of the shared Journey. The link works;
    // this is #200's live-scope state, not an attack, so the caller keeps its
    // whole probe budget.
    for (let index = 0; index < 4; index += 1) {
      expect((await guestRequest(app, "/assets/gone/read-url", {
        token,
        address,
      })).status).toBe(404);
    }
    for (let index = 0; index < LIMITS.unknownTokenMaxRequests; index += 1) {
      expect((await guestRequest(app, "/dead", { address })).status).toBe(404);
    }
    expect((await guestRequest(app, "/dead", { address })).status).toBe(429);
  });

  it("applies no address budget when no address can be determined", async () => {
    const app = limitedApp();
    // `app.request()` has no socket and sends no `x-forwarded-for`, so the
    // address is unknown. That must skip the budget rather than collapse every
    // caller onto one key, which would throttle the whole deployment at once.
    for (let index = 0; index < LIMITS.unknownTokenMaxRequests + 5; index += 1) {
      expect((await guestRequest(app, "/dead")).status).toBe(404);
    }
  });

  it("leaves ordinary guest traffic untouched below the budget", async () => {
    const app = limitedApp();
    const token = generateShareToken();
    const response = await guestRequest(app, "/journeys", { token });
    expect(response.status).toBe(200);
    expect(response.headers.get("Retry-After")).toBeNull();
  });
});

describe("isMediaReadPath", () => {
  it("separates media issuance from every other guest route", () => {
    expect(isMediaReadPath("/api/shared/assets/abc/read-url")).toBe(true);
    expect(isMediaReadPath("/api/shared/journeys")).toBe(false);
    expect(isMediaReadPath("/api/shared/grant")).toBe(false);
  });
});

describe("FixedWindowCounter", () => {
  it("rolls the window and forgets the previous count", () => {
    const counter = new FixedWindowCounter(60_000);
    expect(counter.hit("k", 2, 0)).toBe(true);
    expect(counter.hit("k", 2, 1_000)).toBe(true);
    expect(counter.hit("k", 2, 2_000)).toBe(false);
    // A whole window later the key starts over.
    expect(counter.hit("k", 2, 60_000)).toBe(true);
  });

  it("gives one charge back without wiping the window", () => {
    const counter = new FixedWindowCounter(60_000);
    expect(counter.hit("k", 2, 0)).toBe(true);
    expect(counter.hit("k", 2, 0)).toBe(true);
    counter.release("k", 0);
    // One charge back, not the whole window: the earlier charge survives, so
    // a valid request cannot reset a flood of invalid ones.
    expect(counter.hit("k", 2, 0)).toBe(true);
    expect(counter.hit("k", 2, 0)).toBe(false);
  });

  it("never releases below zero", () => {
    const counter = new FixedWindowCounter(60_000);
    counter.hit("k", 2, 0);
    counter.release("k", 0);
    counter.release("k", 0);
    counter.release("k", 0);
    expect(counter.hit("k", 1, 0)).toBe(true);
    expect(counter.hit("k", 1, 0)).toBe(false);
  });

  it("forgets a key so a garbage token leaves no entry behind", () => {
    const counter = new FixedWindowCounter(60_000);
    expect(counter.hit("k", 1, 0)).toBe(true);
    expect(counter.hit("k", 1, 0)).toBe(false);
    counter.forget("k");
    expect(counter.hit("k", 1, 0)).toBe(true);
  });

  it("prunes expired keys once the map reaches its cap", () => {
    const counter = new FixedWindowCounter(60_000, 4);
    for (let index = 0; index < 4; index += 1) {
      counter.hit(`old-${index}`, 1, 0);
    }
    // A whole window later, admitting a fifth key sweeps the four stale ones,
    // so the map is bounded by traffic inside one window rather than by all
    // traffic ever seen. A swept key starts over, which is what `true` means.
    expect(counter.hit("fresh", 1, 60_000)).toBe(true);
    for (let index = 0; index < 4; index += 1) {
      expect(counter.hit(`old-${index}`, 1, 60_000)).toBe(true);
    }
  });

  it("evicts the oldest window when one window's keys reach the cap", () => {
    // The case a sweep cannot help with: every key is fresh, so nothing is
    // expired to remove. Without an eviction the map would grow without bound
    // on exactly the traffic shape this cap exists for — a flood of distinct
    // bearer tokens inside one window.
    const counter = new FixedWindowCounter(60_000, 4);
    for (let index = 0; index < 4; index += 1) {
      counter.hit(`key-${index}`, 1, index);
    }
    counter.hit("newest", 1, 10);
    // `key-0` started first, so it is the one that went.
    expect(counter.hit("key-0", 1, 10)).toBe(true);
    // `newest` is still counted, and so is a key that was not evicted.
    expect(counter.hit("newest", 1, 10)).toBe(false);
    expect(counter.hit("key-3", 1, 10)).toBe(false);
  });
});
