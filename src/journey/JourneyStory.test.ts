import {
  mediaForRoutePoint,
  storyChapterMedia,
  storySelectionContainsRoutePointMedia,
} from "./storyMediaPolicy";
import {
  mobileStoryExpandedForLayout,
  storyGlobeCoverState,
  mobileStoryHistoryLayers,
  journeyDeleteDescription,
} from "./storySurfacePolicy";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStoryAutoplayFallbackController,
  JourneyStory,
  mediaEvidenceCoordinateCorrection,
  mediaEvidenceLocationText,
  recordedEvidenceForPlacementRead,
  finalizeMediaDragCommit,
  scheduleCancelableMediaDragSettle,
  scheduleCancelableDeferredFullscreenEntry,
  cancelPendingStoryMediaOwners,
  mediaMoveUndoForSelection,
  mediaMoveUndoNeedsServerReconcile,
  reorderInvalidatesMediaMoveUndo,
  retainMediaMoveUndoAfterError,
  replaceJourneySoundtrack,
} from "./JourneyStory";
import { JourneyApiError, readMediaEvidence, writeMediaDisplayState } from "./journeyApi";
import { createPlacementAnalysisAuthority, placementAnalysisScope, runPlacementAnalysisBatch } from "./placementAnalysisAuthority";
import type { Journey, JourneyMediaAsset, MediaEvidenceRecord } from "./types";

const journey: Journey = {
  id: "journey-1",
  atlasId: "atlas-1",
  title: "Across the island",
  startedOn: "2026-08-11",
  endedOn: null,
  note: "A quiet route home.",
  lightColor: "#f4ce73",
  revision: 1,
  createdByUserId: "user-1",
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
  routePoints: [],
  media: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("media evidence bridge (#334)", () => {
  it("persists only normalized coordinate evidence and preserves timezone semantics", () => {
    const recorded = recordedEvidenceForPlacementRead({
      status: "signal",
      signal: {
        latitude: 22.543096,
        longitude: 114.057865,
        spatialSource: "exif",
        spatialGranularity: "coordinate",
        accuracyMeters: 7.5,
        captureTimeSource: "exif-original",
        timezoneState: "offset-known",
        capturedLocal: "2026-09-30T12:34:56.789",
        capturedAt: "2026-09-30T04:34:56.789Z",
        offsetMinutes: 480,
      },
    });
    expect(recorded).toEqual({
      spatial: {
        source: "exif",
        granularity: "coordinate",
        latitude: 22.543096,
        longitude: 114.057865,
        accuracyMeters: 7.5,
        label: null,
      },
      captureTime: {
        source: "exif-original",
        timezone: "offset-known",
        local: "2026-09-30T12:34:56.789",
        instant: "2026-09-30T04:34:56.789Z",
        offsetMinutes: 480,
      },
    });
    expect(recordedEvidenceForPlacementRead({ status: "unsupported-format" })).toBeUndefined();
    expect(recordedEvidenceForPlacementRead({
      status: "signal",
      signal: { spatialSource: "exif", spatialGranularity: "unknown" },
    })).toBeUndefined();
  });

  it("never presents city or unknown evidence as a precise coordinate", () => {
    const evidence: MediaEvidenceRecord = {
      mediaAssetId: "asset-city",
      revision: 1,
      recorded: {
        spatial: { source: "imported", granularity: "city", latitude: null, longitude: null, accuracyMeters: null, label: "Honolulu" },
        captureTime: { source: "unknown", timezone: "unknown", local: null, instant: null, offsetMinutes: null },
      },
      display: { hidden: false, correction: null },
      effective: { source: "recorded", provenance: "imported", granularity: "city", latitude: null, longitude: null, accuracyMeters: null, label: "Honolulu" },
      updatedAt: null,
    };
    expect(mediaEvidenceLocationText(evidence)).toContain("城市级（非精确坐标）");
    const unknownRecorded = {
      ...evidence,
      recorded: { ...evidence.recorded, spatial: { ...evidence.recorded.spatial, granularity: "unknown" as const, label: null } },
      effective: null,
    };
    expect(mediaEvidenceLocationText(unknownRecorded)).toBe("没有可靠拍摄地点");
    expect(mediaEvidenceLocationText({
      ...unknownRecorded,
      display: {
        hidden: false,
        correction: { granularity: "coordinate", latitude: 22.6, longitude: 114.1, label: null },
      },
      effective: {
        source: "user-correction",
        provenance: null,
        granularity: "coordinate",
        latitude: 22.6,
        longitude: 114.1,
        accuracyMeters: null,
        label: null,
      },
    })).toContain("用户纠正");
  });

  it("rejects blank coordinate editor inputs instead of emitting a false 0,0 correction", () => {
    expect(mediaEvidenceCoordinateCorrection("", "")).toBeNull();
    expect(mediaEvidenceCoordinateCorrection("   ", "\t")).toBeNull();
    expect(mediaEvidenceCoordinateCorrection("", "114.1")).toBeNull();
    expect(mediaEvidenceCoordinateCorrection("22.6", "")).toBeNull();
    expect(mediaEvidenceCoordinateCorrection("0", "0")).toEqual({
      granularity: "coordinate",
      latitude: 0,
      longitude: 0,
      label: null,
    });

    const storySource = readFileSync(new URL("./JourneyStory.tsx", import.meta.url), "utf8");
    const start = storySource.indexOf("function saveCoordinateCorrection()");
    const end = storySource.indexOf("\n  return (", start);
    const saveSource = storySource.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(saveSource).toContain("mediaEvidenceCoordinateCorrection(latitude, longitude)");
    expect(saveSource).not.toContain("Number(latitude)");
    expect(saveSource).not.toContain("Number(longitude)");
  });

  it("writes a correction, refetches it, and can hide the effective location", async () => {
    let evidence: MediaEvidenceRecord = {
      mediaAssetId: "asset-1",
      revision: 1,
      recorded: {
        spatial: { source: "exif", granularity: "coordinate", latitude: 22.5, longitude: 114, accuracyMeters: null, label: null },
        captureTime: { source: "unknown", timezone: "unknown", local: null, instant: null, offsetMinutes: null },
      },
      display: { hidden: false, correction: null },
      effective: { source: "recorded", provenance: "exif", granularity: "coordinate", latitude: 22.5, longitude: 114, accuracyMeters: null, label: null },
      updatedAt: null,
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path !== "/api/media-evidence/asset-1") {
        if (path !== "/api/media-evidence/asset-1/display") throw new Error("unexpected media evidence request");
        const body = JSON.parse(String(init?.body));
        expect(body.correction?.granularity).not.toBe("unknown");
        expect(body.expectedRevision).toBe(evidence.revision);
        const display = { hidden: body.hidden, correction: body.correction };
        evidence = {
          ...evidence,
          revision: evidence.revision + 1,
          display,
          effective: display.hidden ? null : display.correction ? {
            source: "user-correction",
            provenance: null,
            granularity: display.correction.granularity,
            latitude: display.correction.latitude,
            longitude: display.correction.longitude,
            accuracyMeters: null,
            label: display.correction.label,
          } : evidence.effective,
        };
      }
      return Response.json({ evidence });
    }) as unknown as typeof fetch;

    const initial = await readMediaEvidence("asset-1", fetcher);
    const correction = { granularity: "coordinate" as const, latitude: 22.6, longitude: 114.1, label: null };
    await writeMediaDisplayState("asset-1", initial.revision, { hidden: false, correction }, fetcher);
    const corrected = await readMediaEvidence("asset-1", fetcher);
    expect(corrected.effective?.source).toBe("user-correction");
    await writeMediaDisplayState("asset-1", corrected.revision, { ...corrected.display, hidden: true }, fetcher);
    const hidden = await readMediaEvidence("asset-1", fetcher);
    expect(hidden.display.hidden).toBe(true);
    expect(hidden.effective).toBeNull();
  });

  it("forwards cancellation to owner-private media evidence reads", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      return Response.json({ evidence: { mediaAssetId: "asset-abort" } });
    }) as unknown as typeof fetch;

    await readMediaEvidence("asset-abort", fetcher, controller.signal);

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps the shared surface away from owner-private media evidence endpoints", () => {
    const storySource = readFileSync(new URL("./JourneyStory.tsx", import.meta.url), "utf8");
    const sharedSource = readFileSync(new URL("./SharedAtlasView.tsx", import.meta.url), "utf8");
    expect(storySource).toContain("manageMedia.readMediaEvidence");
    expect(storySource).toContain("manageMedia.writeMediaDisplayState");
    expect(sharedSource).not.toContain("/api/media-evidence");
  });
});

describe("Story shared-element ownership", () => {
  it("does not start a fullscreen morph during Story scope initialization", () => {
    const source = readFileSync(new URL("./JourneyStory.tsx", import.meta.url), "utf8");
    const start = source.indexOf("const nextInitialMedia = storyInitialMediaSelection");
    const end = source.indexOf("setMediaReads({});", start);
    const initialization = source.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(initialization).toContain("setFullscreen(false)");
    expect(initialization).toContain("setFullscreenControlsHidden(false)");
    expect(initialization).not.toContain("exitFullscreen()");
    expect(initialization).not.toContain("presentFullscreen(");
  });
});

describe("mobile Story sheet expand motion", () => {
  function cssRule(css: string, selector: string) {
    const start = css.indexOf(`${selector} {`);
    expect(start, selector).toBeGreaterThan(0);
    return css.slice(start, css.indexOf("}", start));
  }

  it("slides on translate and never animates the sheet's height", () => {
    const css = readFileSync(new URL("../styles/living-atlas.css", import.meta.url), "utf8");
    const collapsed = cssRule(css, "  .journey-story");
    const offset = cssRule(css, '  .journey-story[data-story-layout="mobile"]');
    const expanded = cssRule(css, "  .journey-story-backdrop.is-story-expanded .journey-story");

    expect(collapsed).toContain("height: var(--journey-story-sheet-extent);");
    expect(collapsed).toContain("translate var(--motion-content, 560ms)");
    expect(collapsed).toContain("height 0s linear var(--motion-content, 560ms)");
    expect(collapsed).not.toMatch(/height var\(--motion/);
    expect(offset).toContain("translate: 0 calc(100% - var(--journey-story-sheet-extent) - 1px);");
    expect(expanded).toContain("translate: none;");
    expect(expanded).toContain("transition: translate var(--motion-content, 560ms)");
    expect(expanded).not.toContain("height var(");
  });

  it("releases the cover hold when the translate slide ends", () => {
    const source = readFileSync(new URL("./JourneyStory.tsx", import.meta.url), "utf8");
    expect(source).toContain('event.propertyName === "translate"');
  });
});

describe("Quick Recap fallback focus ownership", () => {
  it("resolves the live Full Playback action after the responsive handoff frame", () => {
    const source = readFileSync(new URL("./JourneyStory.tsx", import.meta.url), "utf8");
    const focusStart = source.indexOf('if (quickRecap?.state !== "over-budget") return;');
    const focusEnd = source.indexOf('}, [quickRecap?.state, mobileLayout]);', focusStart);
    const focusSource = source.slice(focusStart, focusEnd);

    expect(focusStart).toBeGreaterThan(0);
    expect(focusEnd).toBeGreaterThan(focusStart);
    expect(focusSource).toContain("window.requestAnimationFrame(() => {");
    expect(focusSource).toContain("quickRecapFullActionRef.current?.focus({ preventScroll: true });");
    expect(focusSource).not.toContain("const action = quickRecapFullActionRef.current");
  });
});

describe("mobile media delete focus ownership (#427)", () => {
  it("waits for the committed current Story trigger to become genuinely focusable", () => {
    const source = readFileSync(new URL("./JourneyStory.tsx", import.meta.url), "utf8");
    const closeStart = source.indexOf("function closeMobileMediaDelete()");
    const closeEnd = source.indexOf("function closeJourneyDelete()", closeStart);
    const closeSource = source.slice(closeStart, closeEnd);

    expect(closeStart).toBeGreaterThan(0);
    expect(closeSource).toContain('setMediaDeleteState("idle")');
    expect(closeSource).not.toContain("requestAnimationFrame");
    expect(closeSource).not.toContain("document.querySelector");

    const trapStart = source.indexOf("const mobileMediaSheetRef = useNestedModalFocus");
    const manageFocusStart = source.indexOf(
      "const focusTarget = mobileManageMode",
      trapStart,
    );
    const transitionStart = source.indexOf(
      "const previousMediaDeleteState = previousMediaDeleteStateRef.current",
      manageFocusStart,
    );
    const restoreStart = source.indexOf(
      "if (!restoreMobileMediaDeleteFocusRef.current) return;",
      transitionStart,
    );
    const restoreEnd = source.indexOf(
      "useEffect(() => {",
      restoreStart + 1,
    );
    expect(trapStart).toBeGreaterThan(0);
    expect(manageFocusStart).toBeGreaterThan(trapStart);
    expect(transitionStart).toBeGreaterThan(manageFocusStart);
    expect(restoreStart).toBeGreaterThan(transitionStart);
    expect(restoreEnd).toBeGreaterThan(restoreStart);

    const transitionEffectStart = source.lastIndexOf("useLayoutEffect(() =>", transitionStart);
    expect(transitionEffectStart).toBeGreaterThan(manageFocusStart);
    const transitionSource = source.slice(transitionEffectStart, restoreStart);
    expect(transitionSource).toContain("useLayoutEffect(() =>");
    expect(transitionSource).toContain('previousMediaDeleteState !== "idle"');
    expect(transitionSource).toContain('mediaDeleteState === "idle"');
    expect(transitionSource).toContain("(mobileManageMode || desktopEditing)");

    const restoreSource = source.slice(restoreStart, restoreEnd);
    expect(restoreSource).toContain('style?.visibility !== "hidden"');
    expect(restoreSource).toContain('style?.display !== "none"');
    expect(restoreSource).toContain("target.getClientRects().length > 0");
    expect(restoreSource).toContain("window.requestAnimationFrame(focusCurrentOwner)");
    expect(restoreSource).toContain("document.activeElement !== target");
    const activeOwnerCheck = restoreSource.indexOf("if (document.activeElement !== target)");
    const successfulClear = restoreSource.indexOf(
      "restoreMobileMediaDeleteFocusRef.current = false",
      activeOwnerCheck,
    );
    expect(activeOwnerCheck).toBeGreaterThan(0);
    expect(successfulClear).toBeGreaterThan(activeOwnerCheck);
  });
});

describe("finalizeMediaDragCommit (#65)", () => {
  it("commits the new semantic owner before removing the visible drag layers", () => {
    const events: string[] = [];
    finalizeMediaDragCommit(
      () => events.push("commit"),
      () => events.push("cleanup"),
      (callback) => {
        events.push("flush-start");
        callback();
        events.push("flush-end");
      },
    );

    expect(events).toEqual(["flush-start", "commit", "flush-end", "cleanup"]);
  });
});

describe("scheduleCancelableMediaDragSettle (#140)", () => {
  it("cancels stale settle work before it can commit into a new Story scope", () => {
    const events: string[] = [];
    const scheduled: { current: (() => void) | null } = { current: null };
    const cancel = scheduleCancelableMediaDragSettle(
      () => events.push("commit"),
      () => events.push("cleanup"),
      220,
      (callback) => {
        scheduled.current = callback;
        return 7;
      },
      (timerId) => events.push(`clear:${timerId}`),
    );

    cancel();
    scheduled.current?.();
    cancel();

    expect(events).toEqual(["clear:7", "cleanup"]);
  });

  it("runs the settle once and makes later cancellation a no-op", () => {
    const events: string[] = [];
    const scheduled: { current: (() => void) | null } = { current: null };
    const cancel = scheduleCancelableMediaDragSettle(
      () => events.push("commit"),
      () => events.push("cleanup"),
      220,
      (callback) => {
        scheduled.current = callback;
        return 11;
      },
      (timerId) => events.push(`clear:${timerId}`),
    );

    scheduled.current?.();
    cancel();

    expect(events).toEqual(["commit"]);
  });
});

describe("scheduleCancelableDeferredFullscreenEntry (#239)", () => {
  it("cancels deferred fullscreen work before the deadline", () => {
    const events: string[] = [];
    const scheduled: { current: (() => void) | null } = { current: null };
    const cancel = scheduleCancelableDeferredFullscreenEntry(
      () => events.push("fullscreen"),
      4,
      () => 4,
      220,
      (callback, delay) => {
        events.push(`schedule:${delay}`);
        scheduled.current = callback;
        return 17;
      },
      (timerId) => events.push(`clear:${timerId}`),
    );

    cancel();
    scheduled.current?.();

    expect(events).toEqual(["schedule:220", "clear:17"]);
  });

  it("drops a stale captured Story scope revision even if the timer fires", () => {
    const run = vi.fn();
    const scheduled: { current: (() => void) | null } = { current: null };
    let revision = 8;
    scheduleCancelableDeferredFullscreenEntry(
      run,
      revision,
      () => revision,
      220,
      (callback) => {
        scheduled.current = callback;
        return 19;
      },
      () => undefined,
    );

    revision += 1;
    scheduled.current?.();

    expect(run).not.toHaveBeenCalled();
  });

  it("keeps reduced-motion delay zero deferred and cancellable", () => {
    const run = vi.fn();
    const scheduled: { current: (() => void) | null } = { current: null };
    const delays: number[] = [];
    const cancel = scheduleCancelableDeferredFullscreenEntry(
      run,
      1,
      () => 1,
      0,
      (callback, delay) => {
        delays.push(delay);
        scheduled.current = callback;
        return 23;
      },
      () => undefined,
    );

    expect(run).not.toHaveBeenCalled();
    expect(delays).toEqual([0]);
    cancel();
    scheduled.current?.();
    expect(run).not.toHaveBeenCalled();
  });

  it("one Story cancellation clears drag settle and deferred fullscreen owners", () => {
    const events: string[] = [];
    cancelPendingStoryMediaOwners(
      () => events.push("drag-settle"),
      () => events.push("deferred-fullscreen"),
    );
    expect(events).toEqual(["drag-settle", "deferred-fullscreen"]);
  });
});

function asset(
  id: string,
  mimeType: string,
  sortOrder: number,
  fileName = `${id}.bin`,
): JourneyMediaAsset {
  return {
    id,
    journeyId: journey.id,
    routePointId: null,
    fileName,
    mimeType,
    bytes: 128,
    sortOrder,
    createdAt: journey.createdAt,
  };
}

describe("media move Undo review regressions", () => {
  it("reconciles server state when a retained Undo retry reports stale", () => {
    expect(mediaMoveUndoNeedsServerReconcile(
      new JourneyApiError(409, "MEDIA_MOVE_UNDO_STALE", "stale"),
    )).toBe(true);
    expect(mediaMoveUndoNeedsServerReconcile(
      new JourneyApiError(400, "INVALID_MEDIA_MOVE_UNDO", "invalid"),
    )).toBe(false);
  });

  it("does not invalidate Undo for rejected cross-chapter drag reorder", () => {
    const pointA = { ...asset("point-a-media", "image/jpeg", 0), routePointId: "point-a" };
    const pointB = { ...asset("point-b-media", "image/jpeg", 1), routePointId: "point-b" };
    const pointASecond = { ...asset("point-a-second", "image/jpeg", 2), routePointId: "point-a" };

    expect(reorderInvalidatesMediaMoveUndo([pointA, pointB], pointA.id, pointB.id)).toBe(false);
    expect(reorderInvalidatesMediaMoveUndo([pointA, pointASecond], pointA.id, pointASecond.id)).toBe(true);
  });
});

describe("retainMediaMoveUndoAfterError", () => {
  it("keeps the descriptor for network and retryable HTTP failures", () => {
    expect(retainMediaMoveUndoAfterError(new TypeError("network failed"))).toBe(true);
    expect(retainMediaMoveUndoAfterError(new JourneyApiError(503, "REQUEST_FAILED", "retry"))).toBe(true);
    expect(retainMediaMoveUndoAfterError(new JourneyApiError(429, "RATE_LIMITED", "retry"))).toBe(true);
  });

  it("drops the descriptor for confirmed stale or other non-retryable failures", () => {
    expect(retainMediaMoveUndoAfterError(
      new JourneyApiError(409, "MEDIA_MOVE_UNDO_STALE", "stale"),
    )).toBe(false);
    expect(retainMediaMoveUndoAfterError(
      new JourneyApiError(400, "INVALID_MEDIA_MOVE_UNDO", "invalid"),
    )).toBe(false);
  });
});

describe("createStoryAutoplayFallbackController (#204 review)", () => {
  it("ignores a delayed play rejection after the owning effect is disposed", () => {
    const scheduled: string[] = [];
    const cleared: number[] = [];
    const controller = createStoryAutoplayFallbackController(
      () => { scheduled.push("armed"); return 41; },
      (timer) => cleared.push(timer),
    );

    controller.dispose();
    controller.arm();

    expect(scheduled).toEqual([]);
    expect(cleared).toEqual([]);
  });

  it("cancels a transient watchdog and allows a later stall to re-arm it", () => {
    const scheduled: number[] = [];
    const cleared: number[] = [];
    let nextTimer = 42;
    const controller = createStoryAutoplayFallbackController(
      () => { scheduled.push(nextTimer); return nextTimer++; },
      (timer) => cleared.push(timer),
    );

    controller.arm();
    controller.cancel();
    controller.arm();

    expect(scheduled).toEqual([42, 43]);
    expect(cleared).toEqual([42]);
  });

  it("clears an already-armed fallback and cannot re-arm after disposal", () => {
    const scheduled: string[] = [];
    const cleared: number[] = [];
    const controller = createStoryAutoplayFallbackController(
      () => { scheduled.push("armed"); return 42; },
      (timer) => cleared.push(timer),
    );

    controller.arm();
    controller.dispose();
    controller.arm();

    expect(scheduled).toEqual(["armed"]);
    expect(cleared).toEqual([42]);
  });
});

describe("aggregate organizer ownership (#76 review)", () => {
  it("keeps organizer reorder neighbors within the active ownership chapter", () => {
    const pointA1 = { ...asset("a1", "image/jpeg", 0), routePointId: "point-a" };
    const pointB = { ...asset("b", "image/jpeg", 1), routePointId: "point-b" };
    const pointA2 = { ...asset("a2", "image/jpeg", 2), routePointId: "point-a" };
    expect(storyChapterMedia([pointA1, pointA2, pointB], pointA1).map((item) => item.id))
      .toEqual(["a1", "a2"]);
  });

  it("offers the journey-level destination when aggregate selection includes chapter media", () => {
    const intro = asset("intro", "image/jpeg", 0);
    const point = { ...asset("point", "image/jpeg", 1), routePointId: "point-a" };
    expect(storySelectionContainsRoutePointMedia([intro, point], new Set([point.id])))
      .toBe(true);
    expect(storySelectionContainsRoutePointMedia([intro, point], new Set([intro.id])))
      .toBe(false);
  });

  it("captures mixed previous ownership and full order for server-backed move undo", () => {
    const intro = asset("intro", "image/jpeg", 0);
    const pointA = { ...asset("point-a-media", "image/jpeg", 1), routePointId: "point-a" };
    const pointB = { ...asset("point-b-media", "video/mp4", 2), routePointId: "point-b" };
    const track = asset("track", "audio/mpeg", 3);
    const source: Journey = { ...journey, media: [intro, pointA, pointB, track] };

    expect(mediaMoveUndoForSelection(
      source,
      [pointB.id, intro.id],
      "point-a",
    )).toEqual({
      journeyId: source.id,
      expectedRoutePointId: "point-a",
      assignments: [
        { assetId: intro.id, routePointId: null },
        { assetId: pointB.id, routePointId: "point-b" },
      ],
      assetOrder: [intro.id, pointA.id, pointB.id, track.id],
    });
    expect(mediaMoveUndoForSelection(source, ["missing"], "point-a")).toBeNull();
  });
});

describe("replaceJourneySoundtrack", () => {
  const file = { name: "night.mp3", size: 64, type: "audio/mpeg" } as File;

  it("uploads and confirms the new track before removing the old one", async () => {
    const calls: string[] = [];
    const previous = asset("old-track", "audio/mpeg", 0, "old.mp3");
    const upload = vi.fn(async () => {
      calls.push("upload");
      return { uploadedCount: 1, mediaErrors: [], assets: [] };
    });
    const refresh = vi.fn(async () => {
      calls.push("refresh");
      return journey;
    });
    const remove = vi.fn(async () => {
      calls.push("remove");
    });

    const result = await replaceJourneySoundtrack({
      journeyId: journey.id,
      file,
      previous,
      upload: upload as never,
      refresh,
      remove,
    });

    expect(calls).toEqual(["upload", "refresh", "remove", "refresh"]);
    expect(remove).toHaveBeenCalledWith("old-track");
    expect(result).toMatchObject({
      uploaded: true,
      refreshFailed: false,
      cleanupFailed: false,
    });
  });

  it("keeps the track when replacing it with the exact same file", async () => {
    // Soundtracks are always small enough to be content hashed, so the server
    // deduplicates this upload to the asset that is already active.
    const previous = asset("old-track", "audio/mpeg", 0, "night.mp3");
    const remove = vi.fn();
    const result = await replaceJourneySoundtrack({
      journeyId: journey.id,
      file,
      previous,
      upload: (async () => ({
        uploadedCount: 1,
        mediaErrors: [],
        assets: [{
          id: previous.id,
          journeyId: journey.id,
          routePointId: null,
          fileName: "night.mp3",
          mimeType: "audio/mpeg",
          bytes: 64,
        }],
      })) as never,
      refresh: async () => journey,
      remove,
    });

    expect(remove).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      uploaded: true,
      unchanged: true,
      cleanupFailed: false,
    });
  });

  it("still replaces when the upload resolves to a different asset", async () => {
    const previous = asset("old-track", "audio/mpeg", 0, "old.mp3");
    const remove = vi.fn();
    const result = await replaceJourneySoundtrack({
      journeyId: journey.id,
      file,
      previous,
      upload: (async () => ({
        uploadedCount: 1,
        mediaErrors: [],
        assets: [{
          id: "new-track",
          journeyId: journey.id,
          routePointId: null,
          fileName: "night.mp3",
          mimeType: "audio/mpeg",
          bytes: 64,
        }],
      })) as never,
      refresh: async () => journey,
      remove,
    });

    expect(remove).toHaveBeenCalledWith("old-track");
    expect(result).toMatchObject({ uploaded: true, unchanged: false });
  });

  it("keeps the previous track when the new upload fails", async () => {
    const remove = vi.fn();
    const refresh = vi.fn();
    const result = await replaceJourneySoundtrack({
      journeyId: journey.id,
      file,
      previous: asset("old-track", "audio/mpeg", 0, "old.mp3"),
      upload: (async () => ({
        uploadedCount: 0,
        mediaErrors: [{ fileIndex: 0, fileName: "night.mp3", message: "storage unavailable" }],
        assets: [],
      })) as never,
      refresh,
      remove,
    });

    expect(remove).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      uploaded: false,
      uploadError: "storage unavailable",
    });
  });

  it("reports a failed cleanup without discarding the new track", async () => {
    const result = await replaceJourneySoundtrack({
      journeyId: journey.id,
      file,
      previous: asset("old-track", "audio/mpeg", 0, "old.mp3"),
      upload: (async () => ({ uploadedCount: 1, mediaErrors: [], assets: [] })) as never,
      refresh: async () => journey,
      remove: async () => {
        throw new Error("delete failed");
      },
    });

    expect(result).toMatchObject({ uploaded: true, cleanupFailed: true });
  });

  it("skips removal for a journey that had no soundtrack", async () => {
    const remove = vi.fn();
    const result = await replaceJourneySoundtrack({
      journeyId: journey.id,
      file,
      previous: null,
      upload: (async () => ({ uploadedCount: 1, mediaErrors: [], assets: [] })) as never,
      refresh: async () => null,
      remove,
    });

    expect(remove).not.toHaveBeenCalled();
    // A refresh that returns nothing is reported, not silently swallowed.
    expect(result).toMatchObject({ uploaded: true, refreshFailed: true });
  });
});

describe("JourneyStory", () => {
  it("opens desktop Story in reading mode with an explicit edit entry", () => {
    const markup = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [journey],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onDelete: () => undefined,
      onMediaAdded: () => null,
    }));

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-label="退出旅程故事"');
    expect(markup).toContain('class="journey-story__close"');
    expect(markup).toContain('data-story-layout="desktop"');
    expect(markup).not.toContain('data-story-editing="true"');
    expect(markup).toContain('aria-label="编辑故事"');
    expect(markup).not.toContain(">退出<");
    expect(markup).not.toContain("添加照片或视频");
    expect(markup).not.toContain('type="file"');
    expect(markup).not.toContain("编辑旅程");
    expect(markup).not.toContain("删除旅程");
    expect(markup).not.toContain('aria-label="旅程媒体"');
    expect(markup).not.toContain("journey-story__empty-media");
    expect(markup).not.toContain("ROUTE POINTS");
    expect(markup).not.toContain("story-media-rail");
    expect(markup).not.toContain("确认删除");
    expect(journeyDeleteDescription(journey)).toBe(
      "先从图谱隐藏；7 天内可撤销，之后才会清理路线和 0 个私有媒体。",
    );
  });

  it("opens a selected route point and scopes its media", () => {
    const pointJourney: Journey = {
      ...journey,
      routePoints: [{
        id: "point-1",
        journeyId: journey.id,
        sortOrder: 0,
        latitude: 22.5431,
        longitude: 114.0579,
        label: "深圳",
        isStop: true,
        occurredAt: null,
        createdAt: journey.createdAt,
      }],
      media: [{
        id: "media-1",
        journeyId: journey.id,
        routePointId: "point-1",
        fileName: "photo.jpg",
        mimeType: "image/jpeg",
        bytes: 128,
        sortOrder: 0,
        createdAt: journey.createdAt,
      }],
    };

    expect(mediaForRoutePoint(pointJourney, "point-1")).toHaveLength(1);
    expect(mediaForRoutePoint(pointJourney, null)).toHaveLength(0);
    const markup = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [pointJourney],
      journeyId: pointJourney.id,
      routePointId: "point-1",
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));
    expect(markup).toContain('data-route-point-id="point-1"');
    expect(markup).toContain("深圳");
    expect(markup).toContain('aria-label="旅程媒体"');
    expect(markup).not.toContain("1 个媒体片段");
    expect(markup).not.toContain('aria-label="删除这段媒体"');
    expect(markup).not.toContain("删除这段媒体？");
  });

  it("hides the media removal control when the scoped media is empty", () => {
    const markup = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [journey],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));

    expect(markup).not.toContain('aria-label="删除这段媒体"');
    expect(markup).not.toContain("删除这段媒体？");
    expect(markup).not.toContain('aria-label="向前调整媒体顺序"');
    expect(markup).not.toContain('aria-label="旅程媒体"');
    expect(markup).not.toContain("journey-story__empty-media");
  });

  it("keeps desktop picture navigation separate from fullscreen and playback controls", () => {
    const multiMediaJourney: Journey = {
      ...journey,
      media: [
        {
          id: "media-1",
          journeyId: journey.id,
          routePointId: null,
          fileName: "first.jpg",
          mimeType: "image/jpeg",
          bytes: 128,
          sortOrder: 0,
          createdAt: journey.createdAt,
        },
        {
          id: "media-2",
          journeyId: journey.id,
          routePointId: null,
          fileName: "second.jpg",
          mimeType: "image/jpeg",
          bytes: 128,
          sortOrder: 1,
          createdAt: journey.createdAt,
        },
      ],
    };

    const markup = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [multiMediaJourney],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));

    expect(markup).not.toContain('aria-label="向前调整媒体顺序"');
    expect(markup).not.toContain('aria-label="向后调整媒体顺序"');
    expect(markup).not.toContain('aria-label="删除这段媒体"');
    expect(markup).not.toContain('aria-label="上一个媒体"');
    expect(markup).not.toContain('aria-label="下一个媒体"');
    expect(markup).toContain('aria-label="编辑故事"');
    expect(markup).toContain('aria-label="自动浏览当前媒体"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain('aria-label="全屏查看媒体"');
    expect(markup).toContain('aria-label="first.jpg。左侧上一张，右侧下一张，方向键切换"');
    expect(markup).toContain('aria-keyshortcuts="ArrowLeft ArrowRight"');
    const mediaNavigation = markup.match(/<nav class="journey-story__media-nav"[^>]*>([\s\S]*?)<\/nav>/)?.[1];
    expect(mediaNavigation).toBeDefined();
    expect(mediaNavigation?.match(/<button\b/g)).toHaveLength(2);
    expect(mediaNavigation).not.toContain("1 / 2");
  });

  it("reports only expanded/fullscreen Story as opaque globe cover while transitions stay live", () => {
    expect(storyGlobeCoverState({ mobileLayout: true, mobileStoryExpanded: false, fullscreen: false, coverTransitionActive: false }))
      .toEqual({ opaqueMediaCover: false, coverTransitionActive: false });
    expect(storyGlobeCoverState({ mobileLayout: true, mobileStoryExpanded: true, fullscreen: false, coverTransitionActive: true }))
      .toEqual({ opaqueMediaCover: true, coverTransitionActive: true });
    expect(storyGlobeCoverState({ mobileLayout: false, mobileStoryExpanded: true, fullscreen: false, coverTransitionActive: false }))
      .toEqual({ opaqueMediaCover: false, coverTransitionActive: false });
    expect(storyGlobeCoverState({ mobileLayout: true, mobileStoryExpanded: false, fullscreen: true, coverTransitionActive: true }))
      .toEqual({ opaqueMediaCover: true, coverTransitionActive: false });
  });

  it("clears expanded Story state across a compact breakpoint round trip", () => {
    const expandedOnMobile = mobileStoryExpandedForLayout(true, true);
    const afterDesktop = mobileStoryExpandedForLayout(false, expandedOnMobile);
    const backOnMobile = mobileStoryExpandedForLayout(true, afterDesktop);

    expect(expandedOnMobile).toBe(true);
    expect(afterDesktop).toBe(false);
    expect(backOnMobile).toBe(false);
  });

  it("orders migrated mobile mutation history under Manage while keeping Viewer fullscreen independent", () => {
    const migratedJourneyDelete = mobileStoryHistoryLayers({
      mobileLayout: true,
      mobileManageMode: false,
      fullscreen: false,
      mediaMenuOpen: false,
      mediaDeleteOpen: false,
      journeyDeleteOpen: true,
    });
    expect(migratedJourneyDelete).toEqual({
      manage: false,
      mediaSurface: false,
      journeyDelete: false,
    });

    const settledJourneyDelete = mobileStoryHistoryLayers({
      mobileLayout: true,
      mobileManageMode: true,
      fullscreen: false,
      mediaMenuOpen: false,
      mediaDeleteOpen: false,
      journeyDeleteOpen: true,
    });
    expect(settledJourneyDelete).toEqual({
      manage: true,
      mediaSurface: false,
      journeyDelete: true,
    });

    const migratedMediaDelete = mobileStoryHistoryLayers({
      mobileLayout: true,
      mobileManageMode: false,
      fullscreen: false,
      mediaMenuOpen: false,
      mediaDeleteOpen: true,
      journeyDeleteOpen: false,
    });
    expect(migratedMediaDelete.mediaSurface).toBe(false);
    expect(mobileStoryHistoryLayers({
      mobileLayout: true,
      mobileManageMode: true,
      fullscreen: false,
      mediaMenuOpen: false,
      mediaDeleteOpen: true,
      journeyDeleteOpen: false,
    }).mediaSurface).toBe(true);

    expect(mobileStoryHistoryLayers({
      mobileLayout: true,
      mobileManageMode: false,
      fullscreen: true,
      mediaMenuOpen: false,
      mediaDeleteOpen: false,
      journeyDeleteOpen: false,
    }).mediaSurface).toBe(true);
  });

  it("keeps the mobile media stage gesture-first instead of rendering the desktop toolbar", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    const mobileJourney: Journey = {
      ...journey,
      media: [
        asset("media-1", "image/jpeg", 0, "first.jpg"),
        asset("media-2", "image/jpeg", 1, "second.jpg"),
      ],
    };

    const markup = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [mobileJourney],
      journeyId: mobileJourney.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));

    expect(markup).toContain('data-mobile-layout="true"');
    expect(markup).toContain('data-mobile-mode="viewer"');
    expect(markup).toContain('data-mobile-presentation="in-context"');
    expect(markup).toContain('aria-label="展开旅程故事"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="管理旅程"');
    expect(markup).not.toContain('aria-label="管理当前媒体"');
    expect(markup).not.toContain("添加照片或视频");
    expect(markup).not.toContain("编辑旅程");
    expect(markup).not.toContain("删除旅程");
    expect(markup).not.toContain('aria-label="向前调整媒体顺序"');
    expect(markup).not.toContain('aria-label="向后调整媒体顺序"');
    expect(markup).not.toContain("journey-story__media-nav");
    // #204 CFAA: fullscreen keeps a persistent, hidden stage so its video node
    // can be authorized during the entry gesture; its nav may exist in SSR but
    // must remain inside the hidden overlay until fullscreen is entered.
    expect(markup).toContain('<div hidden="" style="display:none" class="journey-story-fullscreen');
    expect(markup).toContain('class="journey-story-fullscreen__nav"');
    expect(markup).not.toContain("全部照片");
    // #199: playback is the one Viewer control that survives the toolbar cut.
    expect(markup).toContain("journey-story__mobile-media-play");
    expect(markup).toContain('aria-label="自动浏览当前媒体"');
    expect(markup).not.toContain("journey-story__mobile-media-sheet");
  });

  it("keeps mobile Story playback in the Viewer cluster only for multi-media scopes (#199)", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));

    const single = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [{ ...journey, media: [asset("media-1", "image/jpeg", 0)] }],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));
    // One asset is not a sequence, so the control would promise nothing.
    expect(single).not.toContain("journey-story__mobile-media-play");
    expect(single).toContain('aria-label="管理旅程"');

    const sequence = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [{
        ...journey,
        media: [
          asset("media-1", "image/jpeg", 0),
          asset("media-2", "video/mp4", 1),
        ],
      }],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));
    // Mixed image/video still reads as one playable sequence, and the control
    // sits in the Viewer action cluster rather than the management sheet.
    expect(sequence).toContain('class="icon-action-button journey-story__mobile-media-play"');
    expect(sequence).toContain('aria-label="自动浏览当前媒体"');
    expect(sequence).toContain('aria-pressed="false"');
    expect(sequence).not.toContain("journey-story__mobile-media-sheet");
    expect(
      sequence.indexOf("journey-story__mobile-media-play"),
    ).toBeGreaterThan(sequence.indexOf('class="journey-story__mobile-media-actions"'));
    expect(
      sequence.indexOf("journey-story__mobile-media-play"),
    ).toBeLessThan(sequence.indexOf("journey-story__mobile-media-menu-trigger"));
  });

  it("gives mobile Viewer the immersive entry the manage sheet used to own (#199)", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));

    const render = (media: JourneyMediaAsset[]) => renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [{ ...journey, media }],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));

    const sequence = render([
      asset("media-1", "image/jpeg", 0),
      asset("media-2", "video/mp4", 1),
    ]);
    expect(sequence).toContain('class="icon-action-button journey-story__mobile-media-fullscreen"');
    expect(sequence).toContain('aria-label="沉浸查看媒体"');
    // Immersive viewing is a viewing action: it sits in the Viewer cluster and
    // the management sheet is not even mounted here.
    expect(sequence).not.toContain("journey-story__mobile-media-sheet");
    // Focus order follows the rendered row: immersive, playback, management.
    expect(
      sequence.indexOf("journey-story__mobile-media-fullscreen"),
    ).toBeGreaterThan(sequence.indexOf('class="journey-story__mobile-media-actions"'));
    expect(
      sequence.indexOf("journey-story__mobile-media-fullscreen"),
    ).toBeLessThan(sequence.indexOf("journey-story__mobile-media-play"));
    expect(
      sequence.indexOf("journey-story__mobile-media-play"),
    ).toBeLessThan(sequence.indexOf("journey-story__mobile-media-menu-trigger"));

    // A single asset has no sequence to play, so the immersive entry takes the
    // playback slot rather than leaving a hole in the row.
    const single = render([asset("media-1", "image/jpeg", 0)]);
    expect(single).toContain("journey-story__mobile-media-fullscreen is-compact");
    expect(single).not.toContain("journey-story__mobile-media-play");
    expect(single).toContain('aria-label="沉浸查看媒体"');

    // The words that used to name the management-sheet action are gone from the
    // product entirely; the Viewer entry is media-aware and count-independent.
    for (const markup of [sequence, single]) {
      expect(markup).not.toContain("沉浸播放</");
      expect(markup).not.toContain("沉浸查看</");
      expect(markup).not.toContain("自动播放照片");
    }
  });

  it("keeps mobile management reachable when the selected media scope is empty", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    const markup = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [{ ...journey, media: [] }],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));

    expect(markup).toContain('data-mobile-mode="viewer"');
    expect(markup).toContain('aria-label="管理旅程"');
    expect(markup).toContain('data-story-layout="mobile"');
    expect(markup).not.toContain('aria-label="旅程媒体"');
    expect(markup).not.toContain("journey-story__empty-media");
    expect(markup).not.toContain("添加照片或视频");
    vi.unstubAllGlobals();
  });

  it("keeps singleton and multi-media reading views free of the editing overview", () => {
    const single = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [{ ...journey, media: [asset("media-1", "image/jpeg", 0)] }],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));
    expect(single).not.toContain("全部照片");
    expect(single).toContain('aria-label="编辑故事"');
    expect(single).toContain('aria-label="旅程媒体"');
    expect(single).toContain('aria-pressed="false"');

    const many: Journey = {
      ...journey,
      media: [
        asset("media-1", "image/jpeg", 0),
        asset("media-2", "image/jpeg", 1),
        asset("media-3", "video/mp4", 2),
      ],
    };
    const markup = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [many],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));
    expect(markup).not.toContain("全部照片");
    expect(markup).toContain('aria-label="编辑故事"');
    expect(markup).toContain('aria-pressed="false"');
    // The editable grid only appears after entering Story editing.
    expect(markup).not.toContain("journey-story__media-grid");
    expect(markup).not.toContain("story-media-organizer");
    expect(markup).not.toContain("story-media-rail");
    expect(markup).not.toContain("3 个媒体片段");
  });

  it("keeps a soundtrack out of the photo counts and shows it as audio", () => {
    const scored: Journey = {
      ...journey,
      media: [
        asset("media-1", "image/jpeg", 0),
        asset("media-2", "image/jpeg", 1),
        asset("track", "audio/mpeg", 2, "night-route.mp3"),
      ],
    };
    const markup = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [scored],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));

    expect(markup).not.toContain("JOURNEY SOUNDTRACK");
    // #7: the presentation strips the file extension — the UI shows the
    // friendly name, never `night-route.mp3`.
    expect(markup).toContain("night-route");
    expect(markup).not.toContain("night-route.mp3");
    expect(markup).not.toContain("替换配乐");
    expect(markup).not.toContain("移除配乐");
    // Audio never becomes a third item in the visual reading sequence.
    expect(markup).toContain('data-media-page-id="media-1"');
    expect(markup).toContain('data-media-page-id="media-2"');
    expect(markup).not.toContain('data-media-page-id="track"');
    // The light strip replaces the native control bar. (The <audio> playback
    // engine only mounts once the signed read resolves at runtime.)
    expect(markup).toContain("journey-story__soundtrack-light");
  });

  it("keeps a soundtrack-only journey silent and free of a broken cover", () => {
    const soundtrackOnly: Journey = {
      ...journey,
      media: [asset("track", "audio/mpeg", 0, "night-route.mp3")],
    };
    const markup = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [soundtrackOnly],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));

    expect(markup).not.toContain("整段旅程还没有媒体");
    expect(markup).not.toContain('aria-label="旅程媒体"');
    expect(markup).not.toContain("journey-story__empty-media");
    expect(markup).toContain("night-route");
    expect(markup).not.toContain("night-route.mp3");
    expect(markup).not.toContain("全部照片");
    expect(markup).not.toContain('aria-label="删除这段媒体"');
    expect(markup).not.toContain('aria-label="向前调整媒体顺序"');
  });

  it("omits empty soundtrack controls from the reading view", () => {
    const markup = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [journey],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));

    expect(markup).not.toContain("还没有配乐，幻灯片会安静播放");
    expect(markup).not.toContain("上传配乐");
    expect(markup).not.toContain("journey-story__soundtrack");
    expect(markup).not.toContain("<audio");
    expect(markup).not.toContain("移除配乐");
  });

  it("keeps Story editing reachable without a journey deletion callback", () => {
    const markup = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [journey],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));

    expect(markup).toContain('aria-label="编辑故事"');
    expect(markup).not.toContain("编辑旅程");
    expect(markup).not.toContain("删除旅程");
  });
});

// #76: the Route Point rail names the CURRENT chapter, which follows the media
// on screen. The Route Point Story was opened on is still the management/upload
// target, but it must not keep looking active once the cursor has crossed into
// another Route Point.
describe("chapter rail follows the presented media across Route Points (#76)", () => {
  const crossingPoint = (id: string, sortOrder: number) => ({
    id,
    journeyId: journey.id,
    sortOrder,
    label: `Stop ${id}`,
    latitude: sortOrder,
    longitude: sortOrder,
    occurredAt: null,
    note: null,
    isStop: true,
    createdAt: journey.createdAt,
  });
  const crossingJourney: Journey = {
    ...journey,
    routePoints: [crossingPoint("point-a", 0), crossingPoint("point-b", 1)],
    media: [
      { ...asset("a1", "image/jpeg", 0, "a1.jpg"), routePointId: "point-a" },
      { ...asset("b1", "image/jpeg", 1, "b1.jpg"), routePointId: "point-b" },
    ],
  };

  // The Route Point buttons that currently read as the active chapter, by
  // either the class that paints them or the ARIA current marker.
  const activePoints = (markup: string) =>
    [...markup.matchAll(/<button[^>]*data-route-point-id="([^"]+)"[^>]*>/g)]
      .filter((match) => /\bis-active\b/.test(match[0]) || /aria-current="step"/.test(match[0]))
      .map((match) => match[1]);

  const renderAt = (routePointId: string | null, initialAssetId: string | null) =>
    renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [crossingJourney],
      journeyId: journey.id,
      routePointId,
      initialAssetId,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));

  it("marks exactly one Route Point active when the cursor sits on its media", () => {
    const onA = renderAt("point-a", null);
    expect(activePoints(onA)).toEqual(["point-a"]);

    // Opened on A, but the observation is B's media: the chapter has crossed.
    const crossed = renderAt("point-a", "b1");
    expect(activePoints(crossed)).toEqual(["point-b"]);
  });

  it("never marks two Route Points active at once", () => {
    for (const markup of [renderAt("point-a", null), renderAt("point-a", "b1"), renderAt("point-b", null)]) {
      const active = activePoints(markup);
      expect(active).toHaveLength(1);
    }
  });

  it("keeps the whole-Journey chip current only while no Route Point is on screen", () => {
    // Journey-level intro media means no Route Point is the chapter.
    const introOnly: Journey = {
      ...journey,
      routePoints: [crossingPoint("point-a", 0)],
      media: [{ ...asset("intro", "image/jpeg", 0, "intro.jpg"), routePointId: null }],
    };
    const markup = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [introOnly],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));
    // Journey-level intro media means no Route Point is the chapter, so the
    // whole-Journey chip is the current one.
    const pressed = [...markup.matchAll(/<button[^>]*aria-pressed="true"[^>]*>/g)].map((match) => match[0]);
    expect(pressed).toHaveLength(1);
    expect(pressed[0]).not.toContain("data-route-point-id");
  });

  it("moves the current chip off the whole-Journey chip once a Route Point is on screen", () => {
    const onAPoint: Journey = {
      ...journey,
      routePoints: [crossingPoint("point-a", 0)],
      media: [{ ...asset("a1", "image/jpeg", 0, "a1.jpg"), routePointId: "point-a" }],
    };
    const markup = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [onAPoint],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onEdit: () => undefined,
      onMediaAdded: () => null,
    }));
    const pressed = [...markup.matchAll(/<button[^>]*aria-pressed="true"[^>]*>/g)].map((match) => match[0]);
    expect(pressed).toHaveLength(1);
    expect(pressed[0]).toContain('data-route-point-id="point-a"');
  });
});

describe("placement analysis supersession (#113)", () => {
  const point = (id: string, owner = "journey-1") => ({
    id, journeyId: owner, sortOrder: 0, label: id, latitude: 1, longitude: 1, occurredAt: null, note: null, isStop: true, createdAt: journey.createdAt,
  });
  const withPoints = (base: Journey, ids: string[]): Journey => ({ ...base, routePoints: ids.map((id) => point(id, base.id)) });

  it("drops Journey A analysis after Journey B becomes the scope, so late A cannot review or upload", () => {
    const authority = createPlacementAnalysisAuthority();
    const journeyA = withPoints(journey, ["a1"]);
    const journeyB = withPoints({ ...journey, id: "journey-2", title: "B" }, ["b1"]);
    const a = placementAnalysisScope([journeyA, journeyB], journeyA.id, "a1");
    authority.syncScope(a);
    const intentA = authority.start(a);
    const b = placementAnalysisScope([journeyA, journeyB], journeyB.id, "b1");
    authority.syncScope(b);
    const review = vi.fn();
    const upload = vi.fn();
    if (authority.isCurrent(intentA, b)) { review(); upload(); }
    expect(review).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("keeps analysis B active when stale A reaches finally", () => {
    const authority = createPlacementAnalysisAuthority();
    const scope = placementAnalysisScope([withPoints(journey, ["p1"])], journey.id, "p1");
    authority.syncScope(scope);
    const intentA = authority.start(scope);
    const intentB = authority.start(scope);
    expect(authority.isCurrent(intentA, scope)).toBe(false);
    expect(authority.isCurrent(intentB, scope)).toBe(true);
  });

  it("invalidates an analysis when the same Journey switches Route Point", () => {
    const authority = createPlacementAnalysisAuthority();
    const current = withPoints(journey, ["p1", "p2"]);
    const p1 = placementAnalysisScope([current], current.id, "p1");
    authority.syncScope(p1);
    const intent = authority.start(p1);
    const p2 = placementAnalysisScope([current], current.id, "p2");
    authority.syncScope(p2);
    expect(authority.isCurrent(intent, p2)).toBe(false);
  });

  it("invalidates analysis when its Journey or captured Route Point leaves current membership", () => {
    const authority = createPlacementAnalysisAuthority();
    const current = withPoints(journey, ["p1"]);
    const scope = placementAnalysisScope([current], current.id, "p1");
    authority.syncScope(scope);
    const intent = authority.start(scope);
    const deleted = placementAnalysisScope([], current.id, "p1");
    authority.syncScope(deleted);
    expect(deleted.valid).toBe(false);
    expect(authority.isCurrent(intent, deleted)).toBe(false);
  });

  it("invalidates same-ID analysis when placement-relevant Journey or Route Point truth changes", () => {
    const authority = createPlacementAnalysisAuthority();
    const current = {
      ...withPoints(journey, ["p1"]),
      startedOn: "2026-01-01",
      endedOn: "2026-01-03",
      routePoints: [{ ...point("p1"), latitude: 22.54, longitude: 114.06, occurredAt: "2026-01-02T10:00:00Z" }],
    };
    const scope = placementAnalysisScope([current], current.id, "p1");
    authority.syncScope(scope);
    const oldIntent = authority.start(scope);

    const changed = {
      ...current,
      endedOn: "2026-01-04",
      routePoints: [{ ...current.routePoints[0], latitude: 22.60, longitude: 114.12, occurredAt: "2026-01-02T12:00:00Z" }],
    };
    const changedScope = placementAnalysisScope([changed], changed.id, "p1");
    expect(changedScope.journeyMembershipKey).toBe(scope.journeyMembershipKey);
    expect(changedScope.routePointMembershipKey).toBe(scope.routePointMembershipKey);
    expect(changedScope.placementTruthKey).not.toBe(scope.placementTruthKey);
    authority.syncScope(changedScope);
    const newerIntent = authority.start(changedScope);

    const staleReview = vi.fn();
    const staleUpload = vi.fn();
    const staleFinallyClear = vi.fn();
    if (authority.isCurrent(oldIntent, changedScope)) {
      staleReview();
      staleUpload();
      staleFinallyClear();
    }
    expect(staleReview).not.toHaveBeenCalled();
    expect(staleUpload).not.toHaveBeenCalled();
    expect(staleFinallyClear).not.toHaveBeenCalled();
    expect(authority.isCurrent(newerIntent, changedScope)).toBe(true);
  });

  it("invalidates when a Route Point on another suggestion-target Journey disappears", () => {
    const authority = createPlacementAnalysisAuthority();
    const current = withPoints(journey, ["p1"]);
    const other = withPoints({ ...journey, id: "journey-2", title: "B" }, ["b1"]);
    const scope = placementAnalysisScope([current, other], current.id, "p1");
    authority.syncScope(scope);
    const intent = authority.start(scope);
    const changed = placementAnalysisScope([current, withPoints(other, [])], current.id, "p1");
    authority.syncScope(changed);
    expect(authority.isCurrent(intent, changed)).toBe(false);
  });

  it("rejects every late commit after Story unmount", () => {
    const authority = createPlacementAnalysisAuthority();
    const current = withPoints(journey, ["p1"]);
    const scope = placementAnalysisScope([current], current.id, "p1");
    authority.syncScope(scope);
    const intent = authority.start(scope);
    authority.dispose();
    expect(authority.isCurrent(intent, scope)).toBe(false);
  });

  it("reactivates with a fresh revision after StrictMode cleanup/setup replay", () => {
    const authority = createPlacementAnalysisAuthority();
    const current = withPoints(journey, ["p1"]);
    const scope = placementAnalysisScope([current], current.id, "p1");
    authority.syncScope(scope);
    const preReplayIntent = authority.start(scope);

    authority.dispose();
    expect(authority.isCurrent(preReplayIntent, scope)).toBe(false);

    authority.resume(scope);
    expect(authority.isCurrent(preReplayIntent, scope)).toBe(false);
    const postReplayIntent = authority.start(scope);
    expect(authority.isCurrent(postReplayIntent, scope)).toBe(true);
  });

  it("keeps the unchanged #86 current-scope happy path authoritative", () => {
    const authority = createPlacementAnalysisAuthority();
    const current = withPoints(journey, ["p1"]);
    const scope = placementAnalysisScope([current], current.id, "p1");
    authority.syncScope(scope);
    const intent = authority.start(scope);
    expect(authority.isCurrent(intent, scope)).toBe(true);
  });

  it("bounds metadata reads and discards normalized evidence after the batch is superseded", async () => {
    const authority = createPlacementAnalysisAuthority();
    const current = withPoints(journey, ["p1"]);
    const scope = placementAnalysisScope([current], current.id, "p1");
    authority.syncScope(scope);
    const intent = authority.start(scope);
    let active = 0;
    let peak = 0;
    const started: number[] = [];
    const releases: Array<() => void> = [];
    const batch = runPlacementAnalysisBatch(
      authority,
      intent,
      () => scope,
      [0, 1, 2, 3, 4, 5],
      async (_item, index) => {
        started.push(index);
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return {
          status: "signal" as const,
          signal: {
            latitude: 22.2783,
            longitude: 114.1747,
            spatialSource: "exif" as const,
            spatialGranularity: "coordinate" as const,
            accuracyMeters: 5,
          },
        };
      },
      2,
    );

    expect(started).toEqual([0, 1]);
    authority.invalidate(scope);
    releases.splice(0).forEach((release) => release());

    expect(await batch).toBeNull();
    expect(started).toEqual([0, 1]);
    expect(peak).toBe(2);
  });
});

describe("Story fullscreen shared-element wiring (#459)", () => {
  it("keeps Story mobile/video fullscreen on the guarded shared-element path (#459)", () => {
    const source = readFileSync(new URL("./JourneyStory.tsx", import.meta.url), "utf8");
    const start = source.indexOf("function presentFullscreen(nextFullscreen: boolean)");
    const end = source.indexOf("\n  function ", start + 1);
    const presentFullscreen = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(presentFullscreen).toContain("runSharedElementMorph({");
    expect(presentFullscreen).toContain("isTargetCurrent: () =>");
    expect(presentFullscreen).toContain("storyFullscreenTargetIsCurrent({");
    expect(presentFullscreen).toContain("claimSource: sourceVideo");
    expect(presentFullscreen).toContain("const sourceVideo = source instanceof HTMLVideoElement ? source : null;");
    expect(presentFullscreen).toContain("previousHandoff?.restoreSource?.()");
    expect(presentFullscreen).toContain("videoHandoff.restoreSource?.()");
    expect(presentFullscreen).not.toContain("reportStageMediaError");
    expect(presentFullscreen).not.toContain("keepTargetInteractive");
    expect(presentFullscreen).not.toMatch(/if \(mobileLayout\)[\s\S]{0,160}setFullscreen/);
  });
});
