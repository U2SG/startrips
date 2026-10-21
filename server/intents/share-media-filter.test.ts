import { describe, expect, it, vi } from "vitest";
import { ShareIntentError } from "./create-share-intent";
import {
  createHttpPersonClassifier,
  filterShareMediaWithoutPeople,
  MAX_SHARE_MEDIA_FILTER_UNCLASSIFIED,
  SHARE_MEDIA_FILTER_CONCURRENCY,
  SHARE_MEDIA_PERSON_SYSTEM_PROMPT,
  type ShareMediaFilterAsset,
} from "./share-media-filter";

/**
 * "只分享风景图": the conservative filter and its bounds. No storage, no
 * database and no network: the preview reader, the classifier and the cache
 * writer are all handed in.
 */

function photo(id: string, overrides: Partial<ShareMediaFilterAsset> = {}): ShareMediaFilterAsset {
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

const PREVIEW = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

function dependencies() {
  return {
    readPreview: vi.fn(async (_asset: ShareMediaFilterAsset): Promise<Uint8Array | null> => PREVIEW),
    classify: vi.fn(async (_imageDataUrl: string): Promise<boolean> => false),
    saveResults: vi.fn(
      async (_results: Array<{ assetId: string; hasPerson: boolean }>): Promise<void> => undefined,
    ),
  };
}

describe("share media filter", () => {
  it("shares only photos answered without a person, in the order given", async () => {
    const deps = dependencies();
    deps.classify.mockResolvedValueOnce(false).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const result = await filterShareMediaWithoutPeople(
      [photo("a"), photo("b"), photo("c")],
      { ...deps, concurrency: 1 },
    );
    expect(result).toEqual({
      assetIds: ["a", "c"],
      excludedCount: 1,
      unclassifiedCount: 0,
      remaining: 0,
      checkedCount: 3,
      failedAssetIds: [],
    });
    expect(deps.saveResults).toHaveBeenCalledWith([
      { assetId: "a", hasPerson: false },
      { assetId: "b", hasPerson: true },
      { assetId: "c", hasPerson: false },
    ]);
  });

  it("sends the stored preview inline as a data URL", async () => {
    const deps = dependencies();
    await filterShareMediaWithoutPeople([photo("a", { previewMimeType: "image/webp" })], deps);
    expect(deps.classify).toHaveBeenCalledWith(
      `data:image/webp;base64,${Buffer.from(PREVIEW).toString("base64")}`,
    );
  });

  it("excludes videos and other media without reading or sending them", async () => {
    const deps = dependencies();
    const result = await filterShareMediaWithoutPeople([
      photo("a"),
      photo("clip", { mimeType: "video/mp4" }),
      photo("song", { mimeType: "audio/mpeg", previewState: "none", previewStorageKey: null }),
    ], deps);
    expect(result).toMatchObject({ assetIds: ["a"], excludedCount: 2, unclassifiedCount: 0, remaining: 0 });
    expect(deps.readPreview).toHaveBeenCalledTimes(1);
    expect(deps.classify).toHaveBeenCalledTimes(1);
  });

  it("uses a cached answer instead of the provider", async () => {
    const deps = dependencies();
    const result = await filterShareMediaWithoutPeople([
      photo("landscape", { cachedHasPerson: false }),
      photo("portrait", { cachedHasPerson: true }),
    ], deps);
    expect(result).toMatchObject({
      assetIds: ["landscape"],
      excludedCount: 1,
      unclassifiedCount: 0,
      remaining: 0,
      checkedCount: 0,
    });
    expect(deps.readPreview).not.toHaveBeenCalled();
    expect(deps.classify).not.toHaveBeenCalled();
    expect(deps.saveResults).not.toHaveBeenCalled();
  });

  it("excludes and counts a photo the provider failed on, and caches nothing for it", async () => {
    const deps = dependencies();
    deps.classify.mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce(false);
    const result = await filterShareMediaWithoutPeople(
      [photo("failed"), photo("fine")],
      { ...deps, concurrency: 1 },
    );
    expect(result).toMatchObject({
      assetIds: ["fine"],
      excludedCount: 1,
      unclassifiedCount: 1,
      failedAssetIds: ["failed"],
    });
    expect(deps.saveResults).toHaveBeenCalledWith([{ assetId: "fine", hasPerson: false }]);
  });

  it("excludes and counts a photo with no readable preview, without calling the provider", async () => {
    const deps = dependencies();
    deps.readPreview.mockResolvedValueOnce(null);
    const result = await filterShareMediaWithoutPeople([
      photo("not-ready", { previewState: "pending" }),
      photo("missing-object"),
    ], deps);
    expect(result).toMatchObject({ assetIds: [], excludedCount: 2, unclassifiedCount: 2, remaining: 0 });
    // The preview that could not be read is reported, so a loop skips it;
    // the one that was never ready was never part of a batch.
    expect(result.failedAssetIds).toEqual(["missing-object"]);
    expect(deps.classify).not.toHaveBeenCalled();
  });

  it("treats answers the cache could not keep as failures, so a loop does not ask again", async () => {
    const deps = dependencies();
    deps.saveResults.mockRejectedValue(new Error("db"));
    const result = await filterShareMediaWithoutPeople([photo("a")], deps);
    expect(result).toMatchObject({ assetIds: [], unclassifiedCount: 1, failedAssetIds: ["a"] });
  });

  it("judges one batch per call and shares nothing until none remain", async () => {
    const deps = dependencies();
    const assets = Array.from({ length: 60 }, (_, index) => photo(`p-${index}`));
    // Cached photos are never part of a batch.
    assets.push(photo("cached", { cachedHasPerson: false }));

    const first = await filterShareMediaWithoutPeople(assets, deps);
    expect(first).toMatchObject({
      assetIds: [],
      remaining: 12,
      checkedCount: MAX_SHARE_MEDIA_FILTER_UNCLASSIFIED,
      failedAssetIds: [],
    });
    expect(first.excludedCount).toBe(assets.length);
    expect(deps.classify).toHaveBeenCalledTimes(48);
    // The first 48 in list order, all written to the cache.
    expect(deps.saveResults.mock.calls[0][0].map((entry) => entry.assetId))
      .toEqual(assets.slice(0, 48).map((asset) => asset.id));

    // The next call sees those answers cached and judges the last 12.
    const answered = new Set(deps.saveResults.mock.calls[0][0].map((entry) => entry.assetId));
    const second = await filterShareMediaWithoutPeople(
      assets.map((asset) => answered.has(asset.id) ? { ...asset, cachedHasPerson: false } : asset),
      deps,
    );
    expect(second).toMatchObject({ remaining: 0, checkedCount: 12, unclassifiedCount: 0 });
    expect(second.assetIds).toHaveLength(61);
    expect(deps.classify).toHaveBeenCalledTimes(60);
  });

  it("excludes skipped failures without asking again or counting them as remaining", async () => {
    const deps = dependencies();
    deps.classify.mockRejectedValueOnce(new Error("timeout"));
    const assets = [photo("broken"), photo("fine")];
    const first = await filterShareMediaWithoutPeople(assets, { ...deps, concurrency: 1, maxUnclassified: 1 });
    expect(first).toMatchObject({ assetIds: [], remaining: 1, failedAssetIds: ["broken"] });

    const second = await filterShareMediaWithoutPeople(assets, {
      ...deps,
      concurrency: 1,
      maxUnclassified: 1,
      skipAssetIds: new Set(first.failedAssetIds),
    });
    expect(second).toEqual({
      assetIds: ["fine"],
      excludedCount: 1,
      unclassifiedCount: 1,
      remaining: 0,
      checkedCount: 1,
      failedAssetIds: [],
    });
    expect(deps.classify).toHaveBeenCalledTimes(2);
  });

  it("never has more provider calls in flight than the concurrency bound", async () => {
    let inFlight = 0;
    let peak = 0;
    const deps = dependencies();
    deps.classify.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return false;
    });
    const assets = Array.from({ length: 10 }, (_, index) => photo(`p-${index}`));
    const result = await filterShareMediaWithoutPeople(assets, deps);
    expect(result.assetIds).toHaveLength(10);
    expect(deps.classify).toHaveBeenCalledTimes(10);
    expect(peak).toBe(SHARE_MEDIA_FILTER_CONCURRENCY);
  });
});

describe("http person classifier", () => {
  function completion(answer: unknown, status = 200) {
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(answer) } }],
    }), { status, headers: { "content-type": "application/json" } });
  }

  function classifier(fetcher: typeof fetch) {
    return createHttpPersonClassifier({
      baseUrl: "https://model.example/v1/",
      apiKey: "intent-key",
      model: "vision-1",
      timeoutMs: 30_000,
      fetcher,
    });
  }

  it("posts the image inline with a strict boolean schema", async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) =>
      completion({ hasRecognizablePerson: true }));
    const dataUrl = "data:image/jpeg;base64,/9j/2Q==";
    await expect(classifier(fetcher as unknown as typeof fetch)(dataUrl)).resolves.toBe(true);

    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://model.example/v1/chat/completions");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("vision-1");
    expect(body.messages[0].content).toBe(SHARE_MEDIA_PERSON_SYSTEM_PROMPT);
    expect(body.messages[1].content[0]).toEqual({ type: "image_url", image_url: { url: dataUrl } });
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema.required).toEqual(["hasRecognizablePerson"]);
    // Only the inline image; no URL the provider could fetch.
    expect(String(init.body)).not.toContain("https://storage");
  });

  it.each([
    ["a non-boolean answer", completion({ hasRecognizablePerson: "no" })],
    ["a provider error", completion({}, 500)],
  ])("throws on %s", async (_label, response) => {
    const fetcher = vi.fn(async () => response);
    await expect(classifier(fetcher as unknown as typeof fetch)("data:image/jpeg;base64,AA=="))
      .rejects.toBeInstanceOf(ShareIntentError);
  });
});
