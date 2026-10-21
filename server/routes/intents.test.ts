import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * One-sentence share, the HTTP surface. No PostgreSQL and no network: the
 * Atlas boundary, the configuration, the candidate list and the provider are
 * all handed in, because what is under test is the guard, the truthful degrade
 * and the narrowing of the model's answer.
 */

const config = vi.hoisted(() => ({
  serverConfig: {
    intentDriver: "disabled",
    intentBaseUrl: null as string | null,
    intentApiKey: null as string | null,
    intentModel: null as string | null,
    intentTimeoutMs: 30_000,
  },
}));

const candidates = vi.hoisted(() => ({
  list: vi.fn(async (_atlasId: string, _limit: number) => [
    { id: "j-3", title: "海风经过深圳湾", startedOn: "2026-08-20", endedOn: null },
    { id: "j-2", title: "夏夜抵达上海", startedOn: "2026-06-12", endedOn: null },
    { id: "j-1", title: "东京冬日散步", startedOn: "2025-12-28", endedOn: null },
  ]),
}));

vi.mock("../config", () => config);
vi.mock("../authorization/atlas-access", () => ({
  requireAtlasAccess: vi.fn(async () => ({ atlas: { id: "atlas-1" } })),
}));
vi.mock("../repositories/journey-repository", () => ({
  listJourneyShareCandidatesForAtlas: candidates.list,
}));
vi.mock("./shares", () => ({ MAX_SHARE_JOURNEYS: 64 }));

const { intentRoutes, shareIntentDependencies, MAX_SHARE_INTENT_CANDIDATES } = await import("./intents");
const { ShareIntentError } = await import("../intents/create-share-intent");

// The same mapping `server/app.ts` answers with.
const app = new Hono()
  .route("/api/intents", intentRoutes)
  .onError((error, context) => {
    if (error instanceof ShareIntentError) {
      return context.json({ error: error.code, message: error.message }, error.status as 400);
    }
    throw error;
  });

const upstream = vi.fn<typeof fetch>();

function propose(text: unknown) {
  return app.request("/api/intents/share", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

function answer(value: unknown) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), {
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  Object.assign(config.serverConfig, {
    intentDriver: "http-model",
    intentBaseUrl: "https://model.example/v1",
    intentApiKey: "intent-key",
    intentModel: "intent-1",
  });
  shareIntentDependencies.fetcher = upstream;
  shareIntentDependencies.now = () => new Date("2026-10-21T08:00:00Z");
});

afterEach(() => {
  upstream.mockReset();
  candidates.list.mockClear();
  delete shareIntentDependencies.fetcher;
  delete shareIntentDependencies.now;
});

describe("GET /api/intents/capabilities", () => {
  it("reports a configured provider", async () => {
    const response = await app.request("/api/intents/capabilities");
    expect(await response.json()).toEqual({ share: { configured: true } });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("reports a disabled provider truthfully", async () => {
    config.serverConfig.intentDriver = "disabled";
    const response = await app.request("/api/intents/capabilities");
    expect(await response.json()).toEqual({ share: { configured: false } });
  });
});

describe("POST /api/intents/share", () => {
  it("answers a bounded proposal and records the model", async () => {
    upstream.mockResolvedValueOnce(answer({
      journeyIds: ["j-1", "not-a-candidate", "j-3", "j-1"],
      expiry: "30d",
      unmatched: null,
    }));
    const response = await propose("  分享今年的两段旅程，30 天有效  ");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      proposal: { journeyIds: ["j-3", "j-1"], expiry: "30d", unmatched: null },
      model: "intent-1",
    });
    expect(candidates.list).toHaveBeenCalledWith("atlas-1", MAX_SHARE_INTENT_CANDIDATES);
    const user = JSON.parse(JSON.parse(String(upstream.mock.calls[0][1]?.body)).messages[1].content);
    expect(user.today).toBe("2026-10-21");
    expect(user.sentence).toBe("分享今年的两段旅程，30 天有效");
    expect(Object.keys(user.candidates[0]).sort()).toEqual(["endedOn", "id", "startedOn", "title"]);
  });

  it.each([["empty", "   "], ["too long", "旅".repeat(301)], ["not a string", 42]])(
    "refuses %s text with 400 before any provider call",
    async (_label, text) => {
      const response = await propose(text);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "INVALID_SHARE_INTENT" });
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it("answers 503 INTENT_UNAVAILABLE when disabled, without reading candidates", async () => {
    config.serverConfig.intentDriver = "disabled";
    const response = await propose("分享最近的旅程");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "INTENT_UNAVAILABLE" });
    expect(candidates.list).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses an expiry outside the presets as a 502", async () => {
    upstream.mockResolvedValueOnce(answer({ journeyIds: ["j-3"], expiry: "1y", unmatched: null }));
    const response = await propose("分享深圳湾，一年有效");
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: "INTENT_MALFORMED" });
  });
});
