import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createOwnerAtlasView, GUEST_ATLAS_VIEW_CAPABILITIES, resolveAtlasView, type AtlasView } from "./atlasView";
import { exportPrivateJourneyFilm, FILM_MAX_ASSET_BYTES, journeyFilmFilename, journeyFilmIdentity, readBoundedFilmBlob, type JourneyFilmEncoder, type JourneyFilmExportOptions } from "./journeyFilmExport";
import { projectFilmRoute } from "./journeyFilmCanvas";
import type { Journey } from "./types";

const bytes = new TextEncoder().encode("source fixture");
function fixture(): Journey {
  return {
    id: "journey-film", atlasId: "atlas-one", title: "海边的一天", startedOn: "2026-10-01", endedOn: null,
    note: "", lightColor: "#fff", revision: 1, createdByUserId: "owner", createdAt: "2026-10-01", updatedAt: "2026-10-01",
    routePoints: [0, 1].map((index) => ({ id: `p${index}`, journeyId: "journey-film", sortOrder: index, latitude: 22, longitude: 114 + index,
      label: `途径点${index}`, isStop: true, note: index ? "海风很轻。" : null, occurredAt: null, createdAt: "2026-10-01" })),
    media: [{ id: "photo-one", journeyId: "journey-film", routePointId: "p1", sortOrder: 0,
      fileName: "photo.jpg", mimeType: "image/jpeg", bytes: bytes.length, createdAt: "2026-10-01",
      contentHashVerified: true, contentHash: createHash("sha256").update(bytes).digest("hex") }],
  };
}
function options(signal = new AbortController().signal): JourneyFilmExportOptions {
  return { presetSeconds: 15, aspect: "portrait", includeCover: false, includeRoutePointNotes: false,
    reducedMotion: false, signal, onProgress: vi.fn() };
}
function transport(journey: Journey) {
  let current = journey, allowed = true;
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    const path = String(url);
    if (!allowed && path.startsWith("/api/")) return Response.json({ error: "AUTH_REQUIRED" }, { status: 401 });
    if (path === "/api/journeys/journey-film") return Response.json({ journey: current });
    if (path.includes("/read-url")) return Response.json({ url: "https://storage.example/original", expiresAt: new Date(Date.now() + 60000).toISOString() });
    if (path === "https://storage.example/original") return new Response(bytes, { headers: { "content-type": "image/jpeg" } });
    if (path.includes("cover-reveal")) return Response.json({ derivative: null, reason: "NO_READY_DERIVATIVE" });
    throw new Error("Unexpected request: " + path);
  });
  return { fetcher, change: (value: Journey) => { current = value; }, revoke: () => { allowed = false; } };
}
const encode: JourneyFilmEncoder = async (input) => {
  for (const asset of input.journey.media) await input.readMedia(asset);
  input.onFrame(input.film.manifest.totalFrames);
  return new Blob(["synthetic encoder output"], { type: "video/mp4" });
};

describe("owner Journey film export", () => {
  it("reads the owner snapshot and original bytes, never a preview or a mutation", async () => {
    const api = transport(fixture());
    const runOptions = options();
    const artifact = await exportPrivateJourneyFilm("journey-film", runOptions, { ...api, encode });
    expect(artifact.filename).toBe("Startrips-海边的一天.mp4");
    expect(artifact.blob.type).toBe("video/mp4");
    expect(runOptions.onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: "validating" }));
    expect(api.fetcher.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
    expect(api.fetcher.mock.calls.find(([url]) => String(url).startsWith("https://"))?.[1]?.credentials).toBe("omit");
    await artifact.verify(new AbortController().signal);
  });
  it("keeps captions opt-in and reports the actual owner read boundary", async () => {
    const api = transport(fixture());
    const inspect: JourneyFilmEncoder = async (input) => {
      expect(input.film.manifest.privacy.mediaResolution).toBe("authorized-owner-fetch");
      expect([...input.film.captions.values()]).toEqual(["海风很轻。"]);
      expect(JSON.stringify(input.film.manifest)).not.toContain("海风");
      return encode(input);
    };
    await exportPrivateJourneyFilm("journey-film", { ...options(), includeRoutePointNotes: true }, { ...api, encode: inspect });
  });
  it("rejects cancellation before any request", async () => {
    const controller = new AbortController(); controller.abort();
    const api = transport(fixture());
    await expect(exportPrivateJourneyFilm("journey-film", options(controller.signal), { ...api, encode })).rejects.toMatchObject({ name: "AbortError" });
    expect(api.fetcher).not.toHaveBeenCalled();
  });
  it("does not return a partial artifact after cancellation during encode", async () => {
    const controller = new AbortController(), api = transport(fixture());
    await expect(exportPrivateJourneyFilm("journey-film", options(controller.signal), { ...api, encode: async (input) => {
      const result = await encode(input); controller.abort(); return result;
    } })).rejects.toMatchObject({ name: "AbortError" });
  });
  it.each(["title", "note", "media", "cover", "atlas"])("rejects %s changes even without a revision bump", async (kind) => {
    const journey = fixture(), api = transport(journey);
    const changed = structuredClone(journey);
    if (kind === "title") changed.title = "edited";
    if (kind === "note") changed.routePoints[1].note = "edited";
    if (kind === "media") changed.media[0].routePointId = "p0";
    if (kind === "cover") changed.coverMediaAssetId = "new-cover";
    if (kind === "atlas") changed.atlasId = "other-atlas";
    await expect(exportPrivateJourneyFilm("journey-film", options(), { ...api, encode: async (input) => {
      const result = await encode(input); api.change(changed); return result;
    } })).rejects.toThrow("journey_film_changed");
  });
  it("rejects revoked access after rendering and before a later download", async () => {
    const api = transport(fixture());
    const artifact = await exportPrivateJourneyFilm("journey-film", options(), { ...api, encode });
    api.revoke();
    await expect(artifact.verify(new AbortController().signal)).rejects.toMatchObject({ status: 401 });
    const other = transport(fixture());
    await expect(exportPrivateJourneyFilm("journey-film", options(), { ...other, encode: async (input) => {
      const result = await encode(input); other.revoke(); return result;
    } })).rejects.toMatchObject({ status: 401 });
  });
  it("rejects mismatched stored source hashes rather than rendering other bytes", async () => {
    const journey = fixture(); journey.media[0].contentHash = "a".repeat(64);
    await expect(exportPrivateJourneyFilm("journey-film", options(), { ...transport(journey), encode })).rejects.toThrow("journey_film_source_changed");
  });
  it("rejects oversized sources before signing them", async () => {
    const journey = fixture(); journey.media[0].bytes = FILM_MAX_ASSET_BYTES + 1;
    const api = transport(journey);
    await expect(exportPrivateJourneyFilm("journey-film", options(), { ...api, encode })).rejects.toThrow("journey_film_source_limit");
    expect(api.fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects overlong captions instead of silently dropping their text", async () => {
    const journey = fixture(); journey.routePoints[1].note = "长".repeat(1000);
    await expect(exportPrivateJourneyFilm("journey-film", { ...options(), includeRoutePointNotes: true }, { ...transport(journey), encode })).rejects.toThrow("journey_film_duration_limit");
  });
  it("uses the original when no approved creative cover is ready", async () => {
    await exportPrivateJourneyFilm("journey-film", { ...options(), includeCover: true }, { ...transport(fixture()), encode: async (input) => {
      expect(input.readOpening).toBeNull(); expect(input.film.manifest.cover).toBeNull(); return encode(input);
    } });
  });
  it("never supplies an export client to read-only or guest views", () => {
    expect(createOwnerAtlasView().exportJourneyFilm).toBeTypeOf("function");
    expect(createOwnerAtlasView({ canEditJourney: false }).exportJourneyFilm).toBeNull();
    const guest: AtlasView = { capabilities: GUEST_ATLAS_VIEW_CAPABILITIES, listJourneys: async () => [],
      listHomeBasePeriods: null, listHomeBaseDismissals: null, readMedia: vi.fn(), mutations: null };
    const fallback = vi.fn(createOwnerAtlasView);
    expect(resolveAtlasView(guest, fallback).exportJourneyFilm).toBeUndefined();
    expect(fallback).not.toHaveBeenCalled();
  });
  it("bounds streamed bytes even when Content-Length is absent or untrue", async () => {
    await expect(readBoundedFilmBlob(new Response(bytes), 3, new AbortController().signal)).rejects.toThrow("journey_film_source_limit");
    await expect(readBoundedFilmBlob(new Response(bytes, { headers: { "content-length": "100" } }), 30, new AbortController().signal)).rejects.toThrow("journey_film_source_limit");
  });
  it("projects a dateline crossing locally and protects filenames", () => {
    const points = fixture().routePoints; points[0].longitude = 179; points[1].longitude = -179;
    const projected = projectFilmRoute(points);
    expect(projected[0].x).toBeLessThan(projected[1].x);
    expect(journeyFilmFilename('旅程/<>:*?.')).toMatch(/^Startrips-[^<>:"/\\|?*]+\.mp4$/);
    expect(journeyFilmIdentity(fixture())).toBe(journeyFilmIdentity(structuredClone(fixture())));
  });
});


describe("creative film integration", () => {
  const recipes = [
    ["ink-wash-poster", "ink-wash-memory", "reveal-flow-ink-wash-v1"],
    ["poetic-line-memory", "poetic-line-memory", "brush-sweep"],
    ["paper-collage-memory", "paper-collage-memory", "guided-ribbon"],
  ];
  it.each(recipes)("exports %s with refreshed capabilities and a pinned recipe", async (kind, recipeId, presetId) => {
    const journey = fixture(), api = transport(journey);
    let reads = 0;
    const display = () => ({ derivative: {
      id: "derivative", journeyId: journey.id, sourceMediaAssetId: journey.media[0].id,
      sourceContentHash: journey.media[0].contentHash, generationKind: kind, generationVersion: 1,
      presetId, mimeType: "image/jpeg", width: 32, height: 48,
    }, display: { url: `https://storage.example/opening?read=${++reads}`, expiresAt: new Date(Date.now() + 60000).toISOString() } });
    const fetcher: typeof fetch = async (url, init) => {
      if (String(url).includes("/api/cover-reveal/")) return Response.json(display());
      if (String(url).startsWith("https://storage.example/opening")) {
        expect(String(url)).toContain("read=2"); return new Response(bytes);
      }
      return api.fetcher(url, init);
    };
    const artifact = await exportPrivateJourneyFilm(journey.id, { ...options(), includeCover: true }, { fetcher, encode: async (input) => {
      expect(input.film.manifest.cover?.recipeId).toBe(recipeId);
      expect(input.readOpening).not.toBeNull();
      await input.readOpening!();
      const source = input.journey.media[0];
      expect(await input.readMedia(source)).toBe(await input.readMedia(source));
      return new Blob(["encoded"], { type: "video/mp4" });
    } });
    expect(reads).toBe(3); // plan, immediate pre-decode, completion
    await artifact.verify(new AbortController().signal);
    expect(reads).toBe(4);
    expect(api.fetcher.mock.calls.filter(([url]) => String(url) === "https://storage.example/original")).toHaveLength(1);
  });
  it("rejects a changed recipe during pre-decode re-signing", async () => {
    const journey = fixture(), api = transport(journey); let reads = 0;
    const fetcher: typeof fetch = async (url, init) => {
      if (String(url).includes("/api/cover-reveal/")) return Response.json({
        derivative: { id: ++reads === 1 ? "old" : "new", journeyId: journey.id, sourceMediaAssetId: journey.media[0].id,
          sourceContentHash: journey.media[0].contentHash, generationKind: "ink-wash-poster", generationVersion: 1,
          presetId: "reveal-flow-ink-wash-v1", mimeType: "image/jpeg", width: 32, height: 48 },
        display: { url: "https://storage.example/unread", expiresAt: new Date(Date.now() + 60000).toISOString() },
      });
      return api.fetcher(url, init);
    };
    await expect(exportPrivateJourneyFilm(journey.id, { ...options(), includeCover: true }, { fetcher, encode: async (input) => {
      await input.readOpening!(); return new Blob(["bad"], { type: "video/mp4" });
    } })).rejects.toThrow("journey_film_changed");
    expect(api.fetcher.mock.calls.some(([url]) => String(url).includes("unread"))).toBe(false);
  });
  it("cancels an in-flight stalled body read instead of waiting for another chunk", async () => {
    const controller = new AbortController(); let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    const reading = readBoundedFilmBlob(response, 1000, controller.signal);
    controller.abort();
    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
  });
  it("does not even request cover capabilities for reduced motion", async () => {
    const api = transport(fixture());
    await exportPrivateJourneyFilm("journey-film", { ...options(), reducedMotion: true, includeCover: true }, { ...api, encode });
    expect(api.fetcher.mock.calls.some(([url]) => String(url).includes("cover-reveal"))).toBe(false);
  });
});


describe("page-owned export lifetime", () => {
  it("holds the page-wide slot across abort/remount until old teardown settles", async () => {
    const first = transport(fixture()), next = transport(fixture());
    const controller = new AbortController();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const cleanup = new Promise<void>((resolve) => { release = resolve; });
    const oldEncoder: JourneyFilmEncoder = async ({ signal }) => {
      entered();
      await cleanup; // cancellation starts disposal, but does not complete it
      signal.throwIfAborted();
      return new Blob(["unreachable"], { type: "video/mp4" });
    };
    const oldRun = exportPrivateJourneyFilm("journey-film", options(controller.signal), { ...first, encode: oldEncoder });
    const oldResult = oldRun.catch((error: unknown) => error);
    const nextEncoder = vi.fn(encode);
    try {
      await started;
      controller.abort(); // closing the old mount aborts its lifetime controller
      await expect(exportPrivateJourneyFilm("journey-film", options(), { ...next, encode: nextEncoder })).rejects.toThrow("journey_film_busy");
      await expect(exportPrivateJourneyFilm("another-journey", options(), { ...next, encode: nextEncoder })).rejects.toThrow("journey_film_busy");
      expect(next.fetcher).not.toHaveBeenCalled();
      expect(nextEncoder).not.toHaveBeenCalled();
      const cancelled = new AbortController(); cancelled.abort();
      await expect(exportPrivateJourneyFilm("journey-film", options(cancelled.signal), { ...next, encode: nextEncoder })).rejects.toMatchObject({ name: "AbortError" });
      // A rejected second caller cannot release the first caller's resource slot.
      await expect(exportPrivateJourneyFilm("journey-film", options(), { ...next, encode: nextEncoder })).rejects.toThrow("journey_film_busy");
    } finally { controller.abort(); release(); await oldResult; }
    expect(await oldResult).toMatchObject({ name: "AbortError" });
    const artifact = await exportPrivateJourneyFilm("journey-film", options(), { ...next, encode: nextEncoder });
    expect(nextEncoder).toHaveBeenCalledOnce();
    expect(artifact.blob.type).toBe("video/mp4");
  });
  it.each(["prepare", "encode"])("releases ownership after a %s failure", async (stage) => {
    const failed = new Error("fixture failure");
    const api = transport(fixture());
    const failingFetch: typeof fetch = async () => { throw failed; };
    const failingEncoder: JourneyFilmEncoder = async () => { throw failed; };
    await expect(exportPrivateJourneyFilm("journey-film", options(), {
      fetcher: stage === "prepare" ? failingFetch : api.fetcher,
      encode: stage === "encode" ? failingEncoder : encode,
    })).rejects.toThrow();
    const artifact = await exportPrivateJourneyFilm("journey-film", options(), { ...api, encode });
    expect(artifact.blob.type).toBe("video/mp4");
  });
});


it("the actual owner export includes a noted non-Stop waypoint inside a travel span", async () => {
  const journey = fixture();
  journey.routePoints.splice(1, 0, {
    ...journey.routePoints[0], id: "transit-note", isStop: false, note: "路上的感想。",
    latitude: 22, longitude: 114.5, sortOrder: 1,
  });
  journey.routePoints.forEach((point, index) => { point.sortOrder = index; });
  const api = transport(journey);
  const inspect: JourneyFilmEncoder = async (input) => {
    expect([...input.film.captions.values()]).toEqual(["路上的感想。", "海风很轻。"]);
    expect(input.sourcePlan.scenes.some(({ scene }) => scene.kind === "map" && scene.role === "arrival" && scene.routePointId === "transit-note")).toBe(false);
    return encode(input);
  };
  const artifact = await exportPrivateJourneyFilm(journey.id, { ...options(), includeRoutePointNotes: true }, { ...api, encode: inspect });
  expect(artifact.blob.type).toBe("video/mp4");
  const changed = structuredClone(journey);
  changed.routePoints[1].note = "已经编辑";
  api.change(changed);
  await expect(artifact.verify(new AbortController().signal)).rejects.toThrow("journey_film_changed");
});
