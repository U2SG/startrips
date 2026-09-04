import { describe, expect, it, vi } from "vitest";

vi.mock("./auth", () => ({
  auth: {
    handler: vi.fn(async () => new Response(null, { status: 204 })),
  },
}));

vi.mock("./db/client", () => ({
  db: {
    execute: vi.fn(async () => []),
  },
}));

vi.mock("./request-log", () => ({
  requestLog: async (_context: unknown, next: () => Promise<void>) => next(),
}));

vi.mock("./routes/atlases", async () => {
  const { Hono } = await import("hono");
  const atlasRoutes = new Hono();
  atlasRoutes.get("/", (context) => context.json({ ok: true }));
  return { atlasRoutes };
});

vi.mock("./routes/journeys", async () => {
  const { Hono } = await import("hono");
  return { journeyRoutes: new Hono() };
});

vi.mock("./routes/locations", async () => {
  const { Hono } = await import("hono");
  return { locationRoutes: new Hono() };
});

vi.mock("./routes/mapstyle", async () => {
  const { Hono } = await import("hono");
  return { mapStyleRoutes: new Hono() };
});

vi.mock("./routes/shares", async () => {
  const { Hono } = await import("hono");
  return { shareRoutes: new Hono(), sharedRoutes: new Hono() };
});

vi.mock("./routes/uploads", async () => {
  const { Hono } = await import("hono");
  return { uploadRoutes: new Hono() };
});

import { app } from "./app";

describe("global API throttling", () => {
  it("does not rate-limit ordinary product requests by client IP", async () => {
    for (let index = 0; index < 100; index += 1) {
      const response = await app.request("http://localhost/api/no-global-limit-probe", {
        headers: { "x-forwarded-for": "203.0.113.10" },
      });
      expect(response.status).toBe(404);
      expect(response.status).not.toBe(429);
    }
  });
});
