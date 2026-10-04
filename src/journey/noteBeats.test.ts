import { describe, expect, it } from "vitest";
import {
  buildPlaybackSteps,
  committedPlaybackPosition,
  isMeaningfulPlaybackStep,
  phaseForStep,
  playbackCameraTargetForStep,
  playbackMediaForPoint,
  playbackNoteBeatRoutePointIds,
  playbackReducer,
  playbackStepCaption,
  playbackStepIdentity,
  routePointProvenanceLabel,
  storySequenceForJourney,
  type PlaybackStep,
} from "./journeyPlayback";
import { buildPlaybackPlan, playbackStepDurationForTempo } from "./journeyPlaybackPlan";
import { buildKeepsakeNarrativeSnapshot, buildKeepsakeRenderManifest } from "./journeyKeepsake";
import {
  NARRATIVE_TIMING_PROFILES,
  NOTE_BEAT_LONG_NOTE_CHARS,
  isLongNarrativeNote,
  resolveNoteBeatDwellMs,
} from "./narrativeTiming";
import {
  prepareQuickRecapPlaybackResult,
  quickRecapNoteBeats,
  quickRecapStepDurationMs,
} from "./quickRecapPlayback";
import {
  storyAutoplayStepMs,
  storyCursorForJourney,
  storyInitialCursorSelection,
  storyInitialMediaSelection,
} from "./storyMediaPolicy";
import type { Journey, JourneyMediaAsset, RoutePoint } from "./types";

// #595 acceptance fixture: grouping changes the chapter, never who owns a note.
//
//   S  Stop, own note + media
//   A  grouped under S, short note + media
//   B  grouped under S, note only
//   C  grouped under S, long note + media
//   T  Stop with media
//   V  ungrouped via, note only (a transit note beat, #514)
//   U  Stop with media
const createdAt = "2026-10-04T00:00:00.000Z";
const LONG_NOTE = "长".repeat(NOTE_BEAT_LONG_NOTE_CHARS + 20);

function point(
  id: string,
  index: number,
  note: string | null,
  options: Partial<RoutePoint> = {},
): RoutePoint {
  return {
    id,
    journeyId: "journey-notes",
    sortOrder: index,
    label: id,
    latitude: 30 + index * 0.01,
    longitude: 104 + index * 0.01,
    occurredAt: null,
    note,
    isStop: true,
    createdAt,
    ...options,
  };
}

function asset(id: string, routePointId: string | null, sortOrder: number, mimeType = "image/jpeg"): JourneyMediaAsset {
  return {
    id,
    journeyId: "journey-notes",
    routePointId,
    storageDriver: "test",
    storageKey: id,
    fileName: `${id}.jpg`,
    mimeType,
    bytes: 128,
    sortOrder,
    uploadedByUserId: "user-1",
    createdAt,
  };
}

const grouped = (stop: string): Partial<RoutePoint> => ({ isStop: false, stayAnchorRoutePointId: stop });

const notesJourney: Journey = {
  id: "journey-notes",
  atlasId: "atlas-1",
  title: "Grouped notes",
  startedOn: "2026-10-01",
  endedOn: null,
  note: "",
  lightColor: "#f4ce73",
  revision: 3,
  createdByUserId: "user-1",
  createdAt,
  updatedAt: createdAt,
  coverMediaAssetId: null,
  routePoints: [
    point("S", 0, "Stop 自己的感想"),
    point("A", 1, "A 的感想", grouped("S")),
    point("B", 2, "B 只有一句话", grouped("S")),
    point("C", 3, LONG_NOTE, grouped("S")),
    point("T", 4, null),
    point("V", 5, "路过 V 时想到的", { isStop: false }),
    point("U", 6, null),
  ],
  media: [
    // Upload order deliberately differs from route order.
    asset("c1", "C", 0),
    asset("s1", "S", 1),
    asset("a1", "A", 2),
    asset("t1", "T", 3),
    asset("u1", "U", 4),
    asset("track", null, 5, "audio/mpeg"),
  ],
};

const steps = buildPlaybackSteps(notesJourney);
const indexOf = (id: string) => notesJourney.routePoints.findIndex((candidate) => candidate.id === id);
const noteStep = (id: string) => steps.find(
  (step): step is Extract<PlaybackStep, { kind: "note" }> => step.kind === "note" && step.pointIndex === indexOf(id),
)!;
const describeStep = (step: PlaybackStep) => {
  switch (step.kind) {
    case "stop": return `stop:${notesJourney.routePoints[step.pointIndex].id}`;
    case "media": return `media:${playbackMediaForPoint(notesJourney, step.pointIndex)[step.mediaIndex]?.id}`;
    case "note": return `note:${notesJourney.routePoints[step.pointIndex].id}`;
    case "travel": return `travel:${step.from ?? step.to - 1}->${step.to}`;
    default: return step.kind;
  }
};

describe("Playback note beats (#595)", () => {
  it("plays a Stop chapter in canonical member order: Stop note, A, B (note-only), C", () => {
    expect(steps.map(describeStep)).toEqual([
      "intro",
      "stop:S", "media:s1", "media:a1", "note:B", "note:C", "media:c1",
      "travel:0->4", "stop:T", "media:t1",
      // The ungrouped note-only via is a transit beat: no arrival, and the
      // travel leg still runs from the previous chapter to the next one.
      "note:V",
      "travel:4->6", "stop:U", "media:u1",
      "outro",
    ]);
    expect(noteStep("B").chapterPointIndex).toBe(indexOf("S"));
    expect(noteStep("V").chapterPointIndex).toBeNull();
  });

  it("decides note beats by ownership: note-only and long notes, never a Stop", () => {
    expect([...playbackNoteBeatRoutePointIds(notesJourney)].sort()).toEqual(["B", "C", "V"]);
    expect(isLongNarrativeNote(LONG_NOTE)).toBe(true);
    expect(isLongNarrativeNote("A 的感想")).toBe(false);
  });

  it("captions media with the media's own Route Point, not the chapter Stop", () => {
    const mediaStep = (id: string) => steps.find((step) => step.kind === "media"
      && playbackMediaForPoint(notesJourney, step.pointIndex)[step.mediaIndex]?.id === id);
    expect(playbackStepCaption(notesJourney, mediaStep("s1"))).toEqual({ routePointId: "S", label: "S", note: "Stop 自己的感想" });
    // The child's short note rides with its own media; the Stop's is not repeated.
    expect(playbackStepCaption(notesJourney, mediaStep("a1"))).toEqual({ routePointId: "A", label: "S · A", note: "A 的感想" });
    // A long note had its own beat before the media, so it does not cover it.
    expect(playbackStepCaption(notesJourney, mediaStep("c1"))).toEqual({ routePointId: "C", label: "S · C", note: null });
    expect(playbackStepCaption(notesJourney, noteStep("C"))).toEqual({ routePointId: "C", label: "S · C", note: LONG_NOTE });
    expect(playbackStepCaption(notesJourney, noteStep("B"))?.label).toBe("S · B");
    expect(playbackStepCaption(notesJourney, noteStep("V"))?.label).toBe("V");
    expect(playbackStepCaption(notesJourney, steps.find((step) => step.kind === "stop"))?.note).toBe("Stop 自己的感想");
  });

  it("keeps a Stop's own long note on its arrival and its own media, never as an extra beat", () => {
    const longStop: Journey = {
      ...notesJourney,
      routePoints: notesJourney.routePoints.map((candidate) => (
        candidate.id === "S" ? { ...candidate, note: LONG_NOTE } : candidate
      )),
    };
    const longSteps = buildPlaybackSteps(longStop);
    expect(longSteps.filter((step) => step.kind === "note")
      .map((step) => longStop.routePoints[step.pointIndex].id)).toEqual(["B", "C", "V"]);
    const s1 = longSteps.find((step) => step.kind === "media"
      && playbackMediaForPoint(longStop, step.pointIndex)[step.mediaIndex]?.id === "s1");
    expect(playbackStepCaption(longStop, s1)?.note).toBe(LONG_NOTE);
  });

  it("handles a note beat in every step-kind switch", () => {
    const b = noteStep("B");
    const v = noteStep("V");
    expect(phaseForStep(b)).toEqual({ type: "note", pointIndex: indexOf("B") });
    expect(playbackStepIdentity(notesJourney, b)).toBe("note:B");
    expect(isMeaningfulPlaybackStep(b)).toBe(true);
    // A grouped note keeps the camera on its Stop; a transit note on its via.
    expect(playbackCameraTargetForStep(b, notesJourney)).toEqual({ kind: "point", pointIndex: indexOf("S") });
    expect(playbackCameraTargetForStep(v, notesJourney)).toEqual({ kind: "point", pointIndex: indexOf("V") });
    // Returning from a note goes to the Route Point that owns it.
    expect(committedPlaybackPosition(notesJourney, b)).toEqual({
      journeyId: notesJourney.id, routePointId: "B", assetId: null,
    });
    const plan = buildPlaybackPlan(notesJourney);
    const segment = plan.segments.find((candidate) => candidate.id === "note:B");
    expect(segment).toMatchObject({ kind: "note", routePointId: "B", durationMs: resolveNoteBeatDwellMs("B 只有一句话".length) });
    expect(plan.meaningfulStepIndexes).toContain(steps.indexOf(b));
  });

  it("lets next land on a grouped note beat between its media neighbours", () => {
    const a1Index = steps.findIndex((step) => describeStep(step) === "media:a1");
    const next = playbackReducer(notesJourney, { stepIndex: a1Index, phase: phaseForStep(steps[a1Index]), paused: false }, { type: "next" });
    expect(describeStep(steps[next.stepIndex])).toBe("note:B");
  });
});

describe("Story and Playback agree on note semantics (#595)", () => {
  const collapse = (ids: (string | null)[]) => ids
    .filter((id): id is string => id !== null)
    .filter((id, index, all) => index === 0 || all[index - 1] !== id);

  it("present the same Route Points in the same canonical order", () => {
    const story = storySequenceForJourney(notesJourney).map((entry) => entry.routePointId);
    const playback = steps.flatMap((step) => {
      if (step.kind === "media") return [playbackMediaForPoint(notesJourney, step.pointIndex)[step.mediaIndex]?.routePointId ?? null];
      if (step.kind === "note") return [notesJourney.routePoints[step.pointIndex].id];
      if (step.kind === "stop" && step.media.length === 0) return [notesJourney.routePoints[step.pointIndex].id];
      return [];
    });
    expect(collapse(story)).toEqual(["S", "A", "B", "C", "T", "V", "U"]);
    expect(collapse(playback)).toEqual(collapse(story));
  });

  it("carries chapter provenance on every Story entry", () => {
    const entries = storySequenceForJourney(notesJourney);
    const b = entries.find((entry) => entry.routePointId === "B")!;
    expect(b).toMatchObject({ role: "note", chapterRoutePointId: "S", note: "B 只有一句话" });
    expect(entries.find((entry) => entry.routePointId === "V")).toMatchObject({ role: "note", chapterRoutePointId: "V" });
    expect(routePointProvenanceLabel(notesJourney, "B", "S")).toBe("S · B");
    expect(routePointProvenanceLabel(notesJourney, "S", "S")).toBe("S");
  });

  it("dwells on a note for the same time in Story autoplay and Playback", () => {
    const cursor = storyCursorForJourney(notesJourney, false);
    const storyB = cursor.entries.find((entry) => entry.role === "note" && entry.routePointId === "B");
    const expected = resolveNoteBeatDwellMs("B 只有一句话".length);
    expect(storyAutoplayStepMs(storyB)).toBe(expected);
    for (const tempo of ["fast", "standard", "immersive"] as const) {
      expect(playbackStepDurationForTempo(notesJourney, noteStep("B"), NARRATIVE_TIMING_PROFILES.full[tempo])).toBe(expected);
    }
    expect(resolveNoteBeatDwellMs(0)).toBe(3_500);
    expect(resolveNoteBeatDwellMs(100)).toBe(5_300);
    expect(resolveNoteBeatDwellMs(500)).toBe(9_000);
  });

  it("reopens Story on the note entry a Playback return names", () => {
    const position = committedPlaybackPosition(notesJourney, noteStep("B"));
    const media = storyInitialMediaSelection(notesJourney, position.routePointId, position.assetId);
    const opened = storyInitialCursorSelection(notesJourney, media, {
      routePointId: position.routePointId, assetId: position.assetId, presentJourneyCoverOpening: false,
    });
    expect(opened.pageId).toBe("note:B");
    expect(opened.assetId).toBeNull();
  });
});

describe("Keepsake stays byte-identical with note beats (#595)", () => {
  it("adds no scene and changes no byte of the manifest", () => {
    expect(steps.some((step) => step.kind === "note")).toBe(true);
    // The same Journey without any non-Stop note produces no note beat at all.
    const withoutNotes: Journey = {
      ...notesJourney,
      routePoints: notesJourney.routePoints.map((candidate) => (
        candidate.isStop ? candidate : { ...candidate, note: null }
      )),
    };
    expect(buildPlaybackSteps(withoutNotes).some((step) => step.kind === "note")).toBe(false);
    for (const preset of [15, 30, 60] as const) {
      expect(JSON.stringify(buildKeepsakeRenderManifest(notesJourney, preset)))
        .toBe(JSON.stringify(buildKeepsakeRenderManifest(withoutNotes, preset)));
    }
    expect(JSON.stringify(buildKeepsakeNarrativeSnapshot(notesJourney)))
      .toBe(JSON.stringify(buildKeepsakeNarrativeSnapshot(withoutNotes)));
  });
});

describe("Quick Recap budgets every note beat (#595)", () => {
  it("reserves the note beats before choosing media and plays them all", () => {
    const beats = quickRecapNoteBeats(notesJourney);
    expect([...beats.routePointIds].sort()).toEqual(["B", "C", "V"]);
    expect(beats.durationMs).toBe(
      resolveNoteBeatDwellMs("B 只有一句话".length)
      + resolveNoteBeatDwellMs(LONG_NOTE.length)
      + resolveNoteBeatDwellMs("路过 V 时想到的".length),
    );
    const result = prepareQuickRecapPlaybackResult(notesJourney, { generatedAt: createdAt });
    expect(result.fallbackReason).toBeNull();
    const prepared = result.playback!;
    const recapSteps = buildPlaybackSteps(prepared.journey);
    const recapNotes = recapSteps.filter((step) => step.kind === "note")
      .map((step) => notesJourney.routePoints[step.pointIndex].id);
    expect(recapNotes).toEqual(["B", "C", "V"]);
    for (const step of recapSteps.filter((candidate) => candidate.kind === "note")) {
      expect(quickRecapStepDurationMs(prepared.journey, step, prepared.plan)).toBe(
        resolveNoteBeatDwellMs(notesJourney.routePoints[step.pointIndex].note!.trim().length),
      );
    }
  });

  it("falls back instead of dropping a note when the notes alone overrun the target", () => {
    const result = prepareQuickRecapPlaybackResult(notesJourney, { generatedAt: createdAt, targetDurationMs: 8_000 });
    expect(result.fallbackReason).toBe("over-budget");
  });
});
