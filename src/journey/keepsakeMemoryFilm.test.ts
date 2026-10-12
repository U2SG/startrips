import assert from "node:assert/strict";
import { it } from "vitest";
import type { AuthorizedKeepsakeJourneyContext, KeepsakePrivateRenderPlan } from "./keepsakePrivateRender";
import { buildMemoryFilm, renderMemoryFilmFrame, sampleMemoryFilmFrame, type MemoryFilmCoverPin } from "./keepsakeMemoryFilm";

function fixture() {
  const snapshot = { routePointIds: ["p0", "p1"], visualMedia: [{ mediaAssetId: "m1", routePointId: "p1" }] };
  const drafts: KeepsakePrivateRenderPlan["scenes"][number]["scene"][] = [
    { kind: "map", role: "intro", durationMs: 1001 },
    { kind: "map", role: "travel", pointIndex: 1, fromRoutePointId: "p0", toRoutePointId: "p1", durationMs: 701 },
    { kind: "map", role: "arrival", pointIndex: 1, routePointId: "p1", durationMs: 901 },
    { kind: "media", pointIndex: 1, routePointId: "p1", mediaAssetId: "m1", mediaType: "image", durationMs: 1501 },
    { kind: "map", role: "outro", durationMs: 1101 },
  ];
  let time = 0;
  const scenes = drafts.map((scene, index) => {
    const startMs = time; time += scene.durationMs;
    return { index, startMs, endMs: time, scene };
  });
  const plan: KeepsakePrivateRenderPlan = {
    version: 1, journeyId: "j1", journeyRevision: 3, narrativeSnapshot: snapshot,
    output: { width: 1080, height: 1920 }, targetDurationMs: 15000,
    actualDurationMs: time, scenes, mediaAssetIds: ["m1"],
  };
  const context: AuthorizedKeepsakeJourneyContext = {
    journeyId: "j1", journeyRevision: 3, narrativeSnapshot: structuredClone(snapshot),
    routePoints: [
      { routePointId: "p0", latitude: 22.5, longitude: 114.0, label: "深圳", note: null },
      { routePointId: "p1", latitude: 22.3, longitude: 114.2, label: "香港", note: "傍晚的海风。" },
    ],
  };
  const cover: MemoryFilmCoverPin = { derivativeId: "d1", sourceMediaAssetId: "m1", recipeId: "ink-wash-memory", recipeVersion: 1 };
  return { plan, context, cover };
}
it("keeps the canonical scene order and never mutates a v1 plan", () => {
  const { plan, context } = fixture();
  const before = structuredClone(plan);
  const film = buildMemoryFilm(plan, context);
  assert.deepEqual(plan, before);
  assert.deepEqual(film.manifest.shots.map((shot) => shot.sourceSceneIndex), [0, 1, 2, 3, 4]);
  assert.equal(film.manifest.version, 2);
  assert.equal(film.manifest.privacy.artifactVisibility, "private");
});
for (const fps of [24, 30] as const) {
  it(`uses cumulative frame boundaries without gaps or drift at ${fps} fps`, () => {
    const { plan, context } = fixture();
    const { manifest } = buildMemoryFilm(plan, context, { fps });
    assert.equal(manifest.totalFrames, Math.round(plan.actualDurationMs * fps / 1000));
    assert.equal(manifest.shots[0].startFrame, 0);
    for (let index = 1; index < manifest.shots.length; index++) {
      assert.equal(manifest.shots[index].startFrame, manifest.shots[index - 1].endFrame);
    }
    for (let frame = 0; frame < manifest.totalFrames; frame++) {
      const sample = sampleMemoryFilmFrame(manifest, frame);
      assert(sample.sourceProgress >= 0 && sample.sourceProgress <= 1);
    }
  });
}
it("omits note text by default and keeps opt-in text out of serialized manifests", () => {
  const { plan, context } = fixture();
  assert.equal(buildMemoryFilm(plan, context).captions.size, 0);
  const film = buildMemoryFilm(plan, context, { includeRoutePointNotes: true });
  assert.deepEqual([...film.captions.values()], ["傍晚的海风。"]);
  assert(!JSON.stringify(film.manifest).includes("海风"));
  assert(!JSON.stringify(film.manifest).includes("latitude"));
  assert(!JSON.stringify(film.manifest).includes("storage"));
  assert(film.manifest.totalFrames > Math.round(plan.actualDurationMs * film.manifest.fps / 1000));
});
it("paginates long notes without dropping text or splitting grapheme clusters", () => {
  const { plan, context } = fixture();
  const text = "👩‍👩‍👦".repeat(70) + "家人的旅行";
  context.routePoints[1].note = text;
  const film = buildMemoryFilm(plan, context, { includeRoutePointNotes: true });
  assert.equal(film.captions.size, 2);
  assert.equal([...film.captions.values()].join(""), text);
  assert.equal([...film.captions.values()][0], "👩‍👩‍👦".repeat(64));
  const cues = film.manifest.shots[2].captionCues;
  assert.equal(cues[0].endFrame, cues[1].startFrame);
  assert.equal(cues[1].endFrame, film.manifest.shots[2].endFrame);
});
it("rejects excess note text instead of silently truncating", () => {
  const { plan, context } = fixture();
  context.routePoints[1].note = "长".repeat(8001);
  assert.throws(() => buildMemoryFilm(plan, context, { includeRoutePointNotes: true }), /note_too_long/);
});
it("requires exact journey, revision and narrative context", () => {
  const { plan, context } = fixture();
  assert.throws(() => buildMemoryFilm(plan, { ...context, journeyId: "other" }), /context_mismatch/);
  assert.throws(() => buildMemoryFilm(plan, { ...context, journeyRevision: 4 }), /context_mismatch/);
  context.narrativeSnapshot.routePointIds.reverse();
  assert.throws(() => buildMemoryFilm(plan, context), /context_mismatch/);
});
it("rejects missing points, stale cover pins, invalid durations and disordered scenes", () => {
  const { plan, context, cover } = fixture();
  assert.throws(() => buildMemoryFilm(plan, { ...context, routePoints: [] }), /point_missing/);
  assert.throws(() => buildMemoryFilm(plan, context, {}, { ...cover, sourceMediaAssetId: "other" }), /cover_pin_invalid/);
  const changed = structuredClone(plan); changed.scenes[1].startMs += 1;
  assert.throws(() => buildMemoryFilm(changed, context), /timeline_invalid/);
  const invalid = structuredClone(plan); invalid.actualDurationMs += 1;
  assert.throws(() => buildMemoryFilm(invalid, context), /duration_mismatch/);
});
it("reveals once and ends the cover shot on the unchanged original", () => {
  const { plan, context, cover } = fixture();
  const { manifest } = buildMemoryFilm(plan, context, {}, cover);
  const shot = manifest.shots[3];
  assert.equal(manifest.shots.filter((value) => value.openingDerivativeId).length, 1);
  assert.equal(sampleMemoryFilmFrame(manifest, shot.startFrame).openingOpacity, 1);
  assert.equal(sampleMemoryFilmFrame(manifest, shot.endFrame - 1).openingOpacity, 0);
  const middle = Math.floor((shot.startFrame + shot.endFrame) / 2);
  assert.equal(sampleMemoryFilmFrame(manifest, middle).openingOpacity, 0);
});
it("reduced motion skips the derivative and sends the flag to the source renderer", async () => {
  const { plan, context, cover } = fixture();
  const film = buildMemoryFilm(plan, context, { reducedMotion: true }, cover);
  assert.equal(film.manifest.cover, null);
  await renderMemoryFilmFrame(film, film.manifest.shots[3].startFrame, {
    renderOriginalScene: (_index, _progress, reduced) => { assert.equal(reduced, true); },
    compositeOpening: () => { assert.fail("must not animate the opening"); },
    drawCaption: () => { assert.fail("notes were not enabled"); },
  });
});
it("draws original, then derivative, and draws only explicitly enabled captions", async () => {
  const { plan, context, cover } = fixture();
  const film = buildMemoryFilm(plan, context, { includeRoutePointNotes: true }, cover);
  const calls: string[] = [];
  const renderer = {
    renderOriginalScene: () => { calls.push("original"); },
    compositeOpening: () => { calls.push("opening"); },
    drawCaption: (text: string) => { calls.push(text); },
  };
  await renderMemoryFilmFrame(film, film.manifest.shots[3].startFrame, renderer);
  assert.deepEqual(calls, ["original", "opening"]);
  calls.length = 0;
  await renderMemoryFilmFrame(film, film.manifest.shots[2].startFrame, renderer);
  assert.deepEqual(calls, ["original", "傍晚的海风。"]);
});
it("rejects out-of-range frames and is reproducible when sampled in reverse", () => {
  const { plan, context, cover } = fixture();
  const film = buildMemoryFilm(plan, context, {}, cover);
  for (const frame of [-1, NaN, 0.5, film.manifest.totalFrames]) assert.throws(() => sampleMemoryFilmFrame(film.manifest, frame));
  const frames = [0, 5, 50, film.manifest.totalFrames - 1];
  const forward = frames.map((frame) => sampleMemoryFilmFrame(film.manifest, frame));
  assert.deepEqual([...frames].reverse().map((frame) => sampleMemoryFilmFrame(film.manifest, frame)).reverse(), forward);
});

it("projects identity fields instead of spreading private runtime data into the manifest", () => {
  const { plan, context, cover } = fixture();
  const runtimeCover = { ...cover, bytes: new Uint8Array([7, 8, 9]), url: "https://private.example/signed", note: "private marker" };
  const runtimePlan = { ...plan, narrativeSnapshot: { ...plan.narrativeSnapshot, secret: "private marker",
    visualMedia: plan.narrativeSnapshot.visualMedia.map((item) => ({ ...item, storageKey: "private marker" })),
  } };
  const film = buildMemoryFilm(runtimePlan, context, {}, runtimeCover);
  assert.deepEqual(film.manifest.cover, cover);
  assert.deepEqual(film.manifest.narrativeSnapshot, context.narrativeSnapshot);
  const text = JSON.stringify(film.manifest);
  assert(!text.includes("private marker"));
  assert(!text.includes("https://"));
  assert(!text.includes("bytes"));
});
