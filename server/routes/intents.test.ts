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
    itineraryRecognitionDriver: "disabled",
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

const STORY_JOURNEY_ID = "5e3c1a2b-0000-4000-8000-0000000000aa";
const routePointLabels = vi.hoisted(() => ({
  list: vi.fn(async (_atlasId: string, _journeyId: string): Promise<Array<{ id: string; label: string }> | null> => [
    { id: "7b0b6f1e-0000-4000-8000-000000000001", label: "成都" },
    { id: "7b0b6f1e-0000-4000-8000-000000000002", label: "理塘" },
  ]),
}));

vi.mock("../config", () => config);
vi.mock("../authorization/atlas-access", () => ({
  requireAtlasAccess: vi.fn(async () => ({ atlas: { id: "atlas-1" } })),
}));
vi.mock("../repositories/journey-repository", () => ({
  listJourneyShareCandidatesForAtlas: candidates.list,
  listJourneyRoutePointLabelsForAtlas: routePointLabels.list,
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
const { requireAtlasAccess } = await import("../authorization/atlas-access");

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
  routePointLabels.list.mockClear();
  mediaFilter.list.mockReset();
  mediaFilter.save.mockClear();
  config.serverConfig.intentVisionModel = null;
  config.serverConfig.itineraryRecognitionDriver = "disabled";
  vi.mocked(requireAtlasAccess).mockClear();
  delete shareIntentDependencies.fetcher;
  delete shareIntentDependencies.now;
  delete shareIntentDependencies.storage;
});

describe("GET /api/intents/capabilities", () => {
  it("reports a configured provider", async () => {
    const response = await app.request("/api/intents/capabilities");
    expect(await response.json()).toEqual({
      share: { configured: true, mediaFilter: false },
      routeOrder: { configured: true },
      router: { configured: true, intents: ["share", "route-order", "assign-photos", "navigate", "globe-focus"] },
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("reports a disabled provider truthfully", async () => {
    config.serverConfig.intentDriver = "disabled";
    const response = await app.request("/api/intents/capabilities");
    expect(await response.json()).toEqual({
      share: { configured: false, mediaFilter: false },
      routeOrder: { configured: false },
      router: { configured: false, intents: [] },
    });
  });

  it("offers the media filter only with a vision model on an http-model provider", async () => {
    config.serverConfig.intentVisionModel = "vision-1";
    expect(await (await app.request("/api/intents/capabilities")).json())
      .toEqual({
        share: { configured: true, mediaFilter: true },
        routeOrder: { configured: true },
        router: {
          configured: true,
          intents: ["share", "share-photos-filter", "route-order", "assign-photos", "navigate", "globe-focus"],
        },
      });
    config.serverConfig.intentDriver = "disabled";
    expect(await (await app.request("/api/intents/capabilities")).json())
      .toEqual({
        share: { configured: false, mediaFilter: false },
        routeOrder: { configured: false },
        router: { configured: false, intents: [] },
      });
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

describe("POST /api/intents/route-order", () => {
  const POINTS = [
    { id: "draft-a", label: "成都" },
    { id: "draft-b", label: "理塘" },
    { id: "draft-c", label: "稻城" },
  ];

  function reorder(body: unknown) {
    return app.request("/api/intents/route-order", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("answers a permutation mapped back to the client's ids, under the Journey edit permission", async () => {
    upstream.mockResolvedValueOnce(answer({ order: ["p3", "p2", "p1"], unmatched: null }));
    const response = await reorder({ text: " 倒过来 ", points: POINTS });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      proposal: { order: ["draft-c", "draft-b", "draft-a"], unmatched: null },
      model: "intent-1",
    });
    expect(requireAtlasAccess).toHaveBeenLastCalledWith(expect.anything(), "update");
    const user = JSON.parse(JSON.parse(String(upstream.mock.calls[0][1]?.body)).messages[1].content);
    // Only the sentence and labels, with positional ids: never the client's ids.
    expect(user).toEqual({
      sentence: "倒过来",
      points: [
        { position: 1, id: "p1", label: "成都" },
        { position: 2, id: "p2", label: "理塘" },
        { position: 3, id: "p3", label: "稻城" },
      ],
    });
  });

  it.each([
    ["a duplicate", ["p1", "p1", "p3"]],
    ["an unknown id", ["p1", "p2", "p9"]],
    ["a missing id", ["p2", "p1"]],
    ["a client id", ["draft-c", "draft-b", "draft-a"]],
  ])("answers no proposal when the model's order has %s", async (_label, order) => {
    upstream.mockResolvedValueOnce(answer({ order, unmatched: null }));
    const response = await reorder({ text: "把稻城移到理塘前面", points: POINTS });
    expect(response.status).toBe(200);
    const { proposal } = await response.json();
    expect(proposal.order).toBeNull();
    expect(proposal.unmatched).toEqual(expect.any(String));
  });

  it.each([
    ["empty text", { text: "  ", points: POINTS }],
    ["too long text", { text: "序".repeat(201), points: POINTS }],
    ["one point", { text: "倒过来", points: POINTS.slice(0, 1) }],
    ["too many points", {
      text: "倒过来",
      points: Array.from({ length: 65 }, (_value, index) => ({ id: `d-${index}`, label: `站 ${index}` })),
    }],
    ["duplicate ids", { text: "倒过来", points: [POINTS[0], { ...POINTS[1], id: "draft-a" }] }],
    ["an over-long label", { text: "倒过来", points: [POINTS[0], { id: "draft-b", label: "长".repeat(81) }] }],
    ["a missing label", { text: "倒过来", points: [POINTS[0], { id: "draft-b" }] }],
  ])("refuses %s with 400 before any provider call", async (_label, body) => {
    const response = await reorder(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "INVALID_ROUTE_ORDER_INTENT" });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("answers 503 INTENT_UNAVAILABLE when disabled", async () => {
    config.serverConfig.intentDriver = "disabled";
    const response = await reorder({ text: "倒过来", points: POINTS });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "INTENT_UNAVAILABLE", stage: "route-order-intent" });
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe("POST /api/intents/assign-media", () => {
  function assign(body: unknown) {
    return app.request("/api/intents/assign-media", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("answers a Route Point of the session Atlas's Journey, under the move permission", async () => {
    upstream.mockResolvedValueOnce(answer({ target: "p2", alternatives: ["p1"], unmatched: null }));
    const response = await assign({ text: "这两张是在理塘拍的", journeyId: STORY_JOURNEY_ID, selectionCount: 2 });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      proposal: {
        target: { routePointId: "7b0b6f1e-0000-4000-8000-000000000002", label: "理塘" },
        alternatives: [{ routePointId: "7b0b6f1e-0000-4000-8000-000000000001", label: "成都" }],
        unmatched: null,
      },
      model: "intent-1",
    });
    expect(requireAtlasAccess).toHaveBeenLastCalledWith(expect.anything(), "update");
    expect(routePointLabels.list).toHaveBeenCalledWith("atlas-1", STORY_JOURNEY_ID);
    const raw = JSON.parse(String(upstream.mock.calls[0][1]?.body)).messages[1].content as string;
    expect(raw).not.toContain("7b0b6f1e");
    expect(raw).not.toContain(STORY_JOURNEY_ID);
  });

  it("answers 404 for a Journey of another Atlas, before any provider call", async () => {
    routePointLabels.list.mockResolvedValueOnce(null);
    const response = await assign({ text: "理塘", journeyId: STORY_JOURNEY_ID, selectionCount: 2 });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "JOURNEY_NOT_FOUND" });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses an invalid request and a disabled provider before any provider call", async () => {
    const invalid = await assign({ text: "理塘", journeyId: STORY_JOURNEY_ID, selectionCount: 0 });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: "INVALID_ASSIGN_MEDIA_INTENT" });
    config.serverConfig.intentDriver = "disabled";
    const disabled = await assign({ text: "理塘", journeyId: STORY_JOURNEY_ID, selectionCount: 2 });
    expect(disabled.status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
    expect(routePointLabels.list).not.toHaveBeenCalled();
  });
});

describe("POST /api/intents/route", () => {
  const ALL = ["create-journey", "share", "share-photos-filter", "route-order", "navigate", "globe-focus"];

  function route(text: unknown, context: Record<string, unknown> = { intents: ALL }) {
    return app.request("/api/intents/route", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, context }),
    });
  }

  function sentBody(call: number) {
    return JSON.parse(String(upstream.mock.calls[call][1]?.body)) as {
      messages: Array<{ role: string; content: string }>;
      response_format: { json_schema: { schema: unknown } };
    };
  }

  function stageOneInput() {
    return JSON.parse(sentBody(0).messages[1].content) as {
      intents: Array<{ id: string; description: string }>;
      sentence: string;
    };
  }

  function checkedPermissions() {
    return vi.mocked(requireAtlasAccess).mock.calls.map((call) => call[1]);
  }

  beforeEach(() => {
    config.serverConfig.itineraryRecognitionDriver = "http-model";
    config.serverConfig.intentVisionModel = "vision-1";
  });

  it("classifies with only the sentence and the offered intents, then reads the share under create", async () => {
    upstream
      .mockResolvedValueOnce(answer({ intent: "share", unmatched: null }))
      .mockResolvedValueOnce(answer({ journeyIds: ["j-2", "nope"], expiry: "7d", mediaFilter: null, unmatched: null }));
    const response = await route("  分享上海那段，7 天  ");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      intent: "share",
      proposal: { journeyIds: ["j-2"], expiry: "7d", mediaFilter: null, unmatched: null },
      unmatched: null,
      model: "intent-1",
    });
    const stageOne = stageOneInput();
    expect(stageOne.sentence).toBe("分享上海那段，7 天");
    expect(stageOne.intents.map((intent) => intent.id)).toEqual(ALL);
    // No title, date or id of a Journey reaches stage 1.
    const raw = sentBody(0).messages[1].content;
    expect(raw).not.toContain("夏夜抵达上海");
    expect(raw).not.toContain("j-2");
    expect(raw).not.toContain("2026-06-12");
    expect(sentBody(0).response_format.json_schema.schema).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["intent", "unmatched"],
      properties: { intent: { type: "string" }, unmatched: { type: ["string", "null"] } },
    });
    expect(checkedPermissions()).toEqual(["read", "create"]);
  });

  it("re-checks each intent's own permission before its stage", async () => {
    const expected: Array<[string, string, unknown]> = [
      ["create-journey", "create", { sentence: "上个月从成都去稻城" }],
      ["globe-focus", "read", {}],
    ];
    for (const [intent, permission, proposal] of expected) {
      vi.mocked(requireAtlasAccess).mockClear();
      upstream.mockReset();
      upstream.mockResolvedValueOnce(answer({ intent, unmatched: null }));
      const response = await route("上个月从成都去稻城");
      expect(await response.json()).toMatchObject({ intent, proposal });
      expect(checkedPermissions()).toEqual(["read", permission]);
      // Neither needs a second provider call.
      expect(upstream).toHaveBeenCalledTimes(1);
    }
  });

  it("never calls the second stage when the intent's permission is refused", async () => {
    upstream.mockResolvedValueOnce(answer({ intent: "route-order", unmatched: null }));
    vi.mocked(requireAtlasAccess)
      .mockImplementationOnce(async () => ({ atlas: { id: "atlas-1" } }) as never)
      .mockImplementationOnce(async () => { throw new ShareIntentError("FORBIDDEN", "No", 403); });
    const response = await route("把成都放到最后", {
      intents: ALL,
      composerPoints: [{ id: "a", label: "成都" }, { id: "b", label: "理塘" }],
    });

    expect(response.status).toBe(403);
    expect(checkedPermissions()).toEqual(["read", "update"]);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("reads a route order against the client's draft points", async () => {
    upstream
      .mockResolvedValueOnce(answer({ intent: "route-order", unmatched: null }))
      .mockResolvedValueOnce(answer({ order: ["p2", "p1"], unmatched: null }));
    const response = await route("把成都放到最后", {
      intents: ALL,
      composerPoints: [{ id: "draft-a", label: "成都" }, { id: "draft-b", label: "理塘" }],
    });

    expect(await response.json()).toMatchObject({
      intent: "route-order",
      proposal: { order: ["draft-b", "draft-a"], unmatched: null },
    });
    // Stage 1 never saw the labels.
    expect(sentBody(0).messages[1].content).not.toContain("理塘");
  });

  it("refuses a route order without a valid draft as a 400 after classifying", async () => {
    upstream.mockResolvedValueOnce(answer({ intent: "route-order", unmatched: null }));
    const response = await route("倒过来", { intents: ALL, composerPoints: [{ id: "a", label: "x" }] });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "INVALID_ROUTE_ORDER_INTENT" });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("narrows navigation to the candidates it was shown", async () => {
    upstream
      .mockResolvedValueOnce(answer({ intent: "navigate", unmatched: null }))
      .mockResolvedValueOnce(answer({ journeyId: "j-1", unmatched: null }));
    expect(await (await route("打开东京那段")).json()).toMatchObject({
      intent: "navigate",
      proposal: { journeyId: "j-1", unmatched: null },
    });
    expect(checkedPermissions()).toEqual(["read", "read"]);
    const stageTwo = JSON.parse(sentBody(1).messages[1].content) as { candidates: unknown };
    expect(stageTwo.candidates).toEqual([
      { id: "j-3", title: "海风经过深圳湾", startedOn: "2026-08-20", endedOn: null },
      { id: "j-2", title: "夏夜抵达上海", startedOn: "2026-06-12", endedOn: null },
      { id: "j-1", title: "东京冬日散步", startedOn: "2025-12-28", endedOn: null },
    ]);

    upstream.mockReset();
    upstream
      .mockResolvedValueOnce(answer({ intent: "navigate", unmatched: null }))
      .mockResolvedValueOnce(answer({ journeyId: "invented", unmatched: null }));
    const narrowed = await (await route("打开巴黎那段")).json() as {
      proposal: { journeyId: string | null; unmatched: string | null };
    };
    expect(narrowed.proposal.journeyId).toBeNull();
    expect(narrowed.proposal.unmatched).toBeTruthy();
  });

  it("forces the no-people filter for share-photos-filter", async () => {
    upstream
      .mockResolvedValueOnce(answer({ intent: "share-photos-filter", unmatched: null }))
      .mockResolvedValueOnce(answer({ journeyIds: ["j-3"], expiry: null, mediaFilter: null, unmatched: null }));
    const body = await (await route("只分享深圳湾的风景照")).json() as { proposal: unknown };
    expect(body.proposal).toEqual({ journeyIds: ["j-3"], expiry: null, mediaFilter: "no-people", unmatched: null });
  });

  it("drops intents the server does not route, and never offers them to the model", async () => {
    config.serverConfig.intentVisionModel = null;
    config.serverConfig.itineraryRecognitionDriver = "disabled";
    upstream.mockResolvedValueOnce(answer({ intent: "unsupported", unmatched: "暂不支持" }));
    const response = await route("把这些照片放到第二站", {
      intents: ["assign-photos", "everyday-fragment", "create-journey", "share-photos-filter", "share", "share"],
    });

    expect(await response.json()).toEqual({ intent: "unsupported", proposal: null, unmatched: "暂不支持", model: "intent-1" });
    expect(stageOneInput().intents.map((intent) => intent.id)).toEqual(["share"]);
  });

  it("refuses a request that offers nothing this server routes, before any provider call", async () => {
    const response = await route("随便", { intents: ["assign-photos", "everyday-fragment"] });
    expect(response.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("treats an intent that was not offered as a malformed answer", async () => {
    upstream.mockResolvedValueOnce(answer({ intent: "navigate", unmatched: null }));
    const response = await route("打开东京", { intents: ["share"] });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: "INTENT_MALFORMED", stage: "intent-router" });
    expect(checkedPermissions()).toEqual(["read"]);
  });

  it("refuses a sentence longer than every offered intent allows, before any provider call", async () => {
    const response = await route("长".repeat(301), { intents: ["share", "navigate"] });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "INTENT_TEXT_TOO_LONG", limit: 300 });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("re-validates the chosen intent's own length limit", async () => {
    upstream.mockResolvedValueOnce(answer({ intent: "share", unmatched: null }));
    const response = await route("长".repeat(400));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ intent: "share", error: "INTENT_TEXT_TOO_LONG", limit: 300 });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("answers 503 when the router is not configured", async () => {
    config.serverConfig.intentDriver = "disabled";
    const response = await route("分享");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "INTENT_UNAVAILABLE" });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("answers 409 while a sentence of the same Atlas is being read, and releases the guard", async () => {
    let release!: (response: Response) => void;
    upstream.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
    const first = route("只看地球");
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(1));
    const second = await route("只看地球");
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: "INTENT_ROUTE_BUSY" });
    release(answer({ intent: "globe-focus", unmatched: null }));
    expect((await first).status).toBe(200);

    upstream.mockResolvedValueOnce(answer({ intent: "globe-focus", unmatched: null }));
    expect((await route("只看地球")).status).toBe(200);
  });

  describe("assign-photos", () => {
    const STORY = { intents: ["assign-photos", "globe-focus"], activeJourneyId: STORY_JOURNEY_ID, selectionCount: 2 };

    it("reads the Story selection's target under update, with labels only in stage 2", async () => {
      upstream
        .mockResolvedValueOnce(answer({ intent: "assign-photos", unmatched: null }))
        .mockResolvedValueOnce(answer({ target: "journey", alternatives: [], unmatched: null }));
      const response = await route("这两张不属于任何地点", STORY);

      expect(await response.json()).toEqual({
        intent: "assign-photos",
        proposal: { target: { routePointId: null, label: "旅程散页" }, alternatives: [], unmatched: null },
        unmatched: null,
        model: "intent-1",
      });
      expect(checkedPermissions()).toEqual(["read", "update"]);
      expect(stageOneInput().intents.map((intent) => intent.id)).toEqual(["assign-photos", "globe-focus"]);
      expect(sentBody(0).messages[1].content).not.toContain("成都");
      expect(sentBody(1).messages[1].content).toContain("成都");
    });

    it("is never offered without a Story selection", async () => {
      for (const context of [
        { intents: ["assign-photos", "globe-focus"] },
        { ...STORY, selectionCount: 0 },
        { ...STORY, activeJourneyId: null },
      ]) {
        upstream.mockReset();
        upstream.mockResolvedValueOnce(answer({ intent: "globe-focus", unmatched: null }));
        await route("只看地球", context);
        expect(stageOneInput().intents.map((intent) => intent.id)).toEqual(["globe-focus"]);
      }
      const nothing = await route("放到理塘", { intents: ["assign-photos"] });
      expect(nothing.status).toBe(400);
    });

    it("answers 404 for a Journey of another Atlas, before stage 2", async () => {
      upstream.mockResolvedValueOnce(answer({ intent: "assign-photos", unmatched: null }));
      routePointLabels.list.mockResolvedValueOnce(null);
      const response = await route("放到理塘", STORY);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ intent: "assign-photos", error: "JOURNEY_NOT_FOUND" });
      expect(upstream).toHaveBeenCalledTimes(1);
    });
  });
});
