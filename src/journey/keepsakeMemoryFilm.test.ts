import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { buildKeepsakeRenderManifest } from "./journeyKeepsake";
import { buildKeepsakePrivateRenderPlan } from "./keepsakePrivateRender";
import type { Journey } from "./types";
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

it("paginates explicit newlines without losing author text or overflowing a caption card", () => {
  const { plan, context } = fixture();
  const text = "第一行\n第二行\n第三行\n第四行\n第五行\n第六行\n最后一行";
  context.routePoints[1].note = text;
  const film = buildMemoryFilm(plan, context, { includeRoutePointNotes: true });
  const pages = [...film.captions.values()];
  assert(pages.length >= 3);
  assert.equal(pages.join(""), text);
  assert(pages.every((page) => (page.match(/\n/g) ?? []).length <= 3));
});


function viaFixture(stops: number[], mediaOwners: number[] = []): Journey {
  return {
    id: "via-journey", atlasId: "atlas", title: "途中", startedOn: "2026-10-01", endedOn: null,
    note: "", lightColor: "#fff", revision: 1, createdByUserId: "owner", createdAt: "2026-10-01", updatedAt: "2026-10-01",
    routePoints: [0, 1, 2, 3, 4].map((index) => ({
      id: `via-${index}`, journeyId: "via-journey", sortOrder: index,
      latitude: 22 + index / 10, longitude: 114 + index / 10, label: `途径点${index}`,
      isStop: stops.includes(index), note: `点${index}的感想。`, occurredAt: null, createdAt: "2026-10-01",
    })),
    media: mediaOwners.map((owner, index) => ({
      id: `via-photo-${index}`, journeyId: "via-journey", routePointId: `via-${owner}`,
      fileName: `${index}.jpg`, mimeType: "image/jpeg", bytes: 100, sortOrder: index, createdAt: "2026-10-01",
    })),
  };
}
function viaPlan(journey: Journey) {
  const plan = buildKeepsakePrivateRenderPlan(buildKeepsakeRenderManifest(journey, 30));
  const context: AuthorizedKeepsakeJourneyContext = {
    journeyId: journey.id, journeyRevision: journey.revision, narrativeSnapshot: plan.narrativeSnapshot,
    routePoints: journey.routePoints.map((point) => ({ routePointId: point.id, latitude: point.latitude,
      longitude: point.longitude, label: point.label, note: point.note ?? null })),
  };
  return { plan, context };
}
function sceneForCaption(film: ReturnType<typeof buildMemoryFilm>, text: string) {
  const cue = [...film.captions].find(([, value]) => value === text)?.[0];
  assert(cue, `missing caption: ${text}`);
  const matches = film.manifest.shots.filter((shot) => shot.captionCues.some((entry) => entry.id === cue));
  assert.equal(matches.length, 1);
  return matches[0].sourceSceneIndex;
}
describe("all authorized Route Point notes, not arrival-only", () => {
  for (const fps of [24, 30] as const) {
    it(`includes media-bearing and shape-only vias exactly once at ${fps} fps`, () => {
      const journey = viaFixture([0, 4], [0, 2, 4]);
      const { plan, context } = viaPlan(journey);
      const original = structuredClone(plan);
      const film = buildMemoryFilm(plan, context, { includeRoutePointNotes: true, fps });
      assert.deepEqual(plan, original);
      assert.deepEqual(film.manifest.shots.map((shot) => shot.sourceSceneIndex), plan.scenes.map((_, index) => index));
      assert.deepEqual([...film.captions.values()].sort(), journey.routePoints.map((point) => point.note!).sort());
      for (const point of journey.routePoints) {
        const scene = plan.scenes[sceneForCaption(film, point.note!)].scene;
        if (point.isStop) assert(scene.kind === "map" && scene.role === "arrival" && scene.routePointId === point.id);
        else if (point.id === "via-2") assert(scene.kind === "media" && scene.routePointId === point.id);
        else assert(scene.kind === "map" && scene.role === "travel");
      }
      for (let index = 1; index < film.manifest.shots.length; index++) {
        assert.equal(film.manifest.shots[index].startFrame, film.manifest.shots[index - 1].endFrame);
      }
      assert(!JSON.stringify(film.manifest).includes("感想"));
      for (const shot of film.manifest.shots) for (const cue of shot.captionCues) {
        assert(cue.endFrame > cue.startFrame);
        assert.equal(sampleMemoryFilmFrame(film.manifest, cue.startFrame).captionId, cue.id);
        assert.equal(sampleMemoryFilmFrame(film.manifest, cue.endFrame - 1).captionId, cue.id);
      }
    });
  }
  it("finds a noted via inside a multi-point leg and preserves note order", () => {
    const journey = viaFixture([0, 4]);
    const { plan, context } = viaPlan(journey);
    const film = buildMemoryFilm(plan, context, { includeRoutePointNotes: true });
    const travel = plan.scenes.find(({ scene }) => scene.kind === "map" && scene.role === "travel");
    assert(travel);
    for (const index of [1, 2, 3]) assert.equal(sceneForCaption(film, journey.routePoints[index].note!), travel.index);
    const pages = film.manifest.shots[travel.index].captionCues.map((cue) => film.captions.get(cue.id));
    assert.deepEqual(pages, journey.routePoints.slice(1, 4).map((point) => point.note));
  });
  it("keeps leading and trailing via notes without inventing Stops", () => {
    const journey = viaFixture([1, 3]);
    const { plan, context } = viaPlan(journey);
    const film = buildMemoryFilm(plan, context, { includeRoutePointNotes: true });
    assert.equal(film.captions.size, 5);
    const first = plan.scenes[sceneForCaption(film, journey.routePoints[0].note!)].scene;
    const last = plan.scenes[sceneForCaption(film, journey.routePoints[4].note!)].scene;
    assert(first.kind === "map" && first.role === "travel");
    assert(last.kind === "map" && last.role === "outro");
    assert.equal(plan.scenes.filter(({ scene }) => scene.kind === "map" && scene.role === "arrival").length, 2);
  });
  it("exports all-via note-only Journeys on the overview without changing the v1 plan", () => {
    const journey = viaFixture([]);
    const { plan, context } = viaPlan(journey);
    const before = structuredClone(plan);
    const film = buildMemoryFilm(plan, context, { includeRoutePointNotes: true });
    assert.deepEqual(plan, before);
    assert.deepEqual([...film.captions.values()], journey.routePoints.map((point) => point.note));
    assert.equal(plan.scenes.length, 2);
    const scene = plan.scenes[sceneForCaption(film, journey.routePoints[2].note!)].scene;
    assert(scene.kind === "map" && scene.role === "intro");
  });
  it("uses canonical media ownership for a via grouped under a Stop chapter", () => {
    const journey = viaFixture([0, 4], [0, 2, 4]);
    journey.routePoints[2].stayAnchorRoutePointId = journey.routePoints[0].id;
    const { plan, context } = viaPlan(journey);
    const film = buildMemoryFilm(plan, context, { includeRoutePointNotes: true });
    const scene = plan.scenes[sceneForCaption(film, journey.routePoints[2].note!)].scene;
    assert(scene.kind === "media" && scene.routePointId === journey.routePoints[2].id);
    assert.equal([...film.captions.values()].filter((value) => value === journey.routePoints[2].note).length, 1);
  });
  it("does not leak notes outside the pinned narrative or silently omit missing via context", () => {
    const { plan, context } = viaPlan(viaFixture([0, 4]));
    const extra = { ...context.routePoints[0], routePointId: "unrelated", note: "not in this Journey" };
    const film = buildMemoryFilm(plan, { ...context, routePoints: [...context.routePoints, extra] }, { includeRoutePointNotes: true });
    assert(![...film.captions.values()].includes(extra.note));
    assert.throws(() => buildMemoryFilm(plan, { ...context, routePoints: context.routePoints.filter((point) => point.routePointId !== "via-2") },
      { includeRoutePointNotes: true }), /point_missing/);
  });
  it("paginates long via notes completely and leaves opt-out timing unchanged", () => {
    const journey = viaFixture([0, 4]);
    for (const point of journey.routePoints) point.note = null;
    journey.routePoints[2].note = "途".repeat(150);
    const { plan, context } = viaPlan(journey);
    const film = buildMemoryFilm(plan, context, { includeRoutePointNotes: true });
    assert.equal([...film.captions.values()].join(""), journey.routePoints[2].note);
    assert.equal(film.captions.size, 3);
    assert.equal(buildMemoryFilm(plan, context).captions.size, 0);
    assert.equal(buildMemoryFilm(plan, context).manifest.totalFrames, Math.round(plan.actualDurationMs * 30 / 1000));
    context.routePoints[2].note = "途".repeat(8001);
    assert.throws(() => buildMemoryFilm(plan, context, { includeRoutePointNotes: true }), /note_too_long/);
  });
});
