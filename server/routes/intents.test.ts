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
    intentVisionModel: null as string | null,
    intentTimeoutMs: 30_000,
    mediaPreviewMaxBytes: 1024,
  },
}));

const mediaFilter = vi.hoisted(() => ({
  list: vi.fn(async (_atlasId: string, _journeyIds: readonly string[], _model: string): Promise<unknown[] | null> => []),
  save: vi.fn(async (_results: unknown, _model: string) => undefined),
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
vi.mock("../repositories/share-media-filter-repository", () => ({
  listShareMediaFilterAssets: mediaFilter.list,
  saveShareMediaClassifications: mediaFilter.save,
}));
vi.mock("../storage/storage-registry", () => ({
  getMultipartStorage: () => { throw new Error("tests hand in storage"); },
}));
vi.mock("./shares", () => ({ MAX_SHARE_JOURNEYS: 64, MAX_SHARE_MEDIA_ASSETS: 2000 }));

const { intentRoutes, shareIntentDependencies, MAX_SHARE_INTENT_CANDIDATES } = await import("./intents");
const { ShareIntentError } = await import("../intents/create-share-intent");

// The same mapping `server/app.ts` answers with.
const app = new Hono()
  .route("/api/intents", intentRoutes)
  .onError((error, context) => {
    if (error instanceof ShareIntentError) {
      return context.json(
        { error: error.code, stage: error.stage, message: error.message },
        error.status as 400,
      );
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
  mediaFilter.list.mockReset();
  mediaFilter.save.mockClear();
  config.serverConfig.intentVisionModel = null;
  delete shareIntentDependencies.fetcher;
  delete shareIntentDependencies.now;
  delete shareIntentDependencies.storage;
});

describe("GET /api/intents/capabilities", () => {
  it("reports a configured provider", async () => {
    const response = await app.request("/api/intents/capabilities");
    expect(await response.json()).toEqual({ share: { configured: true, mediaFilter: false } });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("reports a disabled provider truthfully", async () => {
    config.serverConfig.intentDriver = "disabled";
    const response = await app.request("/api/intents/capabilities");
    expect(await response.json()).toEqual({ share: { configured: false, mediaFilter: false } });
  });

  it("offers the media filter only with a vision model on an http-model provider", async () => {
    config.serverConfig.intentVisionModel = "vision-1";
    expect(await (await app.request("/api/intents/capabilities")).json())
      .toEqual({ share: { configured: true, mediaFilter: true } });
    config.serverConfig.intentDriver = "disabled";
    expect(await (await app.request("/api/intents/capabilities")).json())
      .toEqual({ share: { configured: false, mediaFilter: false } });
  });
});

describe("POST /api/intents/share", () => {
  it("answers a bounded proposal and records the model", async () => {
    upstream.mockResolvedValueOnce(answer({
      journeyIds: ["j-1", "not-a-candidate", "j-3", "j-1"],
      expiry: "30d",
      mediaFilter: null,
      unmatched: null,
    }));
    const response = await propose("  分享今年的两段旅程，30 天有效  ");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      proposal: { journeyIds: ["j-3", "j-1"], expiry: "30d", mediaFilter: null, unmatched: null },
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
    expect(await response.json()).toMatchObject({ error: "INTENT_UNAVAILABLE", stage: "share-intent" });
    expect(candidates.list).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses an expiry outside the presets as a 502", async () => {
    upstream.mockResolvedValueOnce(answer({ journeyIds: ["j-3"], expiry: "1y", mediaFilter: null, unmatched: null }));
    const response = await propose("分享深圳湾，一年有效");
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: "INTENT_MALFORMED" });
  });
});

describe("POST /api/intents/share/media", () => {
  const JOURNEY = "11111111-1111-4111-8111-111111111111";
  const readObjectHead = vi.fn(async (input: { key: string; maxBytes: number }) =>
    ({ exists: true as const, bytes: new Uint8Array([input.key.length, 1, 2]) }));

  function asset(id: string, overrides: Record<string, unknown> = {}) {
    return {
      id,
      mimeType: "image/jpeg",
      storageDriver: "s3",
      previewStorageKey: `previews/${id}.jpg`,
      previewMimeType: "image/jpeg",
      previewState: "ready",
      cachedHasPerson: null,
      ...overrides,
    };
  }

  function filter(journeyIds: unknown, skipAssetIds?: unknown) {
    return app.request("/api/intents/share/media", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ journeyIds, ...(skipAssetIds === undefined ? {} : { skipAssetIds }) }),
    });
  }

  beforeEach(() => {
    config.serverConfig.intentVisionModel = "vision-1";
    readObjectHead.mockClear();
    shareIntentDependencies.storage = () => ({ readObjectHead });
  });

  it.each([["none", []], ["a malformed id", ["j-1"]], ["a duplicate", [JOURNEY, JOURNEY]], ["not an array", JOURNEY]])(
    "refuses %s with 400 before reading any media",
    async (_label, journeyIds) => {
      const response = await filter(journeyIds);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "INVALID_SHARE_MEDIA_FILTER" });
      expect(mediaFilter.list).not.toHaveBeenCalled();
    },
  );

  it.each([["not an array", "x"], ["a malformed id", ["broken"]]])(
    "refuses skipAssetIds that is %s with 400 before reading any media",
    async (_label, skipAssetIds) => {
      const response = await filter([JOURNEY], skipAssetIds);
      expect(response.status).toBe(400);
      expect(mediaFilter.list).not.toHaveBeenCalled();
    },
  );

  it("answers 503 without a vision model and reads nothing", async () => {
    config.serverConfig.intentVisionModel = null;
    const response = await filter([JOURNEY]);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "MEDIA_FILTER_UNAVAILABLE", stage: "share-intent" });
    expect(mediaFilter.list).not.toHaveBeenCalled();
  });

  it("answers 404 when a Journey is not a live Journey of the session Atlas", async () => {
    mediaFilter.list.mockResolvedValueOnce(null);
    const response = await filter([JOURNEY]);
    expect(response.status).toBe(404);
    expect(mediaFilter.list).toHaveBeenCalledWith("atlas-1", [JOURNEY], "vision-1");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("judges uncached photos from their previews and excludes people, failures and videos", async () => {
    mediaFilter.list.mockResolvedValueOnce([
      asset("landscape"),
      asset("portrait"),
      asset("broken"),
      asset("cached-landscape", { cachedHasPerson: false }),
      asset("clip", { mimeType: "video/mp4" }),
    ]);
    upstream.mockImplementation(async (_url, init) => {
      const image = JSON.parse(String(init?.body)).messages[1].content[0].image_url.url as string;
      expect(image.startsWith("data:image/jpeg;base64,")).toBe(true);
      const bytes = Buffer.from(image.split(",")[1], "base64");
      const key = bytes[0]; // the stub writes the key length as the first byte
      if (key === "previews/broken.jpg".length) return new Response("{}", { status: 500 });
      return answer({ hasRecognizablePerson: key === "previews/portrait.jpg".length });
    });

    const response = await filter([JOURNEY]);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      assetIds: ["landscape", "cached-landscape"],
      excludedCount: 3,
      unclassifiedCount: 1,
      remaining: 0,
      checkedCount: 3,
      failedAssetIds: ["broken"],
    });
    expect(upstream).toHaveBeenCalledTimes(3);
    expect(readObjectHead).toHaveBeenCalledWith({ key: "previews/landscape.jpg", maxBytes: 1025 });
    expect(mediaFilter.save).toHaveBeenCalledWith(
      expect.arrayContaining([
        { assetId: "landscape", hasPerson: false },
        { assetId: "portrait", hasPerson: true },
      ]),
      "vision-1",
    );
  });

  it("does not judge a preview larger than the ceiling", async () => {
    mediaFilter.list.mockResolvedValueOnce([asset("oversized")]);
    readObjectHead.mockResolvedValueOnce({ exists: true, bytes: new Uint8Array(1025) });
    expect(await (await filter([JOURNEY])).json()).toEqual({
      assetIds: [],
      excludedCount: 1,
      unclassifiedCount: 1,
      remaining: 0,
      checkedCount: 1,
      failedAssetIds: ["oversized"],
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("does not send a skipped photo again and excludes it", async () => {
    const SKIPPED = "22222222-2222-4222-8222-222222222222";
    mediaFilter.list.mockResolvedValueOnce([asset(SKIPPED)]);
    expect(await (await filter([JOURNEY], [SKIPPED])).json()).toMatchObject({
      assetIds: [],
      unclassifiedCount: 1,
      remaining: 0,
      checkedCount: 0,
    });
    expect(readObjectHead).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });

  it("answers 409 while the same Atlas is already being checked, and releases the guard", async () => {
    let release: (assets: unknown[]) => void = () => undefined;
    mediaFilter.list.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = filter([JOURNEY]);
    await vi.waitFor(() => expect(mediaFilter.list).toHaveBeenCalledTimes(1));

    const busy = await filter([JOURNEY]);
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ error: "SHARE_MEDIA_FILTER_BUSY" });
    expect(mediaFilter.list).toHaveBeenCalledTimes(1);

    release([]);
    expect((await first).status).toBe(200);
    mediaFilter.list.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    // Released on every exit, the 404 included.
    expect((await filter([JOURNEY])).status).toBe(404);
    expect((await filter([JOURNEY])).status).toBe(404);
  });
});
