import { describe, expect, it, vi } from "vitest";

// The full app module pulls in the better-auth client, which needs a browser
// runtime; mock the gateway module so the pure helpers can be imported in the
// node test environment. The capability contract moved to ./atlasView (#200),
// so what is stubbed here is only the account slot and the cinematic hook.
vi.mock("../auth/AuthGateway", () => ({
  MobileAccountActionSlot: () => null,
  useAtlasCinematicIsolation: () => () => undefined,
}));

import { readFileSync } from "node:fs";
import {
  atlasCinematicIsolationActive,
  captureUnknownCreateObservationOwnership,
  closeUnknownCreateWithCurrentAtlasTruth,
  explicitSelectedJourneyIdForHomeCamera,
  capturePlaybackEntryForContext,
  globeFocusState,
  homeBaseInferenceInputsReady,
  homeBaseSuggestionCanBeConfirmed,
  loadJourneyRowsWithOptionalHome,
  mergeConfirmedHomeBasePeriod,
  nextPlaybackCameraCommand,
  nextPlaybackReleaseFocusRevision,
  nextInitialHomeCameraFocusRevision,
  playbackEntryNeedsPreparation,
  playbackCameraUsesPointFocus,
  playbackFocusPointForCameraTarget,
  playbackFocusRouteForCameraTarget,
  quickRecapPlanningContentFingerprint,
  nextAtlasNotice,
  pendingPlaybackStoryRestore,
  railContentSignature,
  releaseStalePlaybackSession,
  resolveInitialAtlasHomeCameraIntent,
  resolveInitialHomeOwnedFocusPoint,
  resolveAtlasHomeTimelineContext,
  resolveOrdinaryAtlasHomePresence,
  resolvePlaybackOwnership,
  resolveMobilePlaybackPresentation,
  resolveUnknownCreateObservationOwnership,
  showsGlobeDetailControls,
} from "./LivingAtlasApp";
import { playbackHoldReason, playbackMediaGate } from "./JourneyPlaybackOverlay";
import { resolvePlaybackReturn } from "./playbackReturn";
import { buildJourneyTimeline, resolveJourneyTimelineSelection } from "./globeTimeline";
import type { HomeBasePeriod } from "./homeBase";
import { resolveHomeBasePresence } from "./homeBasePresence";
import { inferHomeBaseCandidate } from "./homeBaseInference";
import {
  homeBaseConfirmationDraft,
  resolveHomeBaseSuggestion,
} from "./homeBaseSuggestion";
import type { Journey } from "./types";

// #8 globe focus mode: the root class/data contract drives the layout CSS
// (sidebars hidden, globe raised, exit control visible). The full app mounts
// async and is covered by the browser QA script; this keeps the toggle logic
// pure and unit-tested.
describe("globeFocusState (#8)", () => {
  it("is off by default and carries the data attribute for layout CSS", () => {
    expect(globeFocusState(false)).toEqual({
      className: "",
      dataAttribute: "off",
    });
  });

  it("adds the focus class and flips the data attribute when enabled", () => {
    expect(globeFocusState(true)).toEqual({
      className: " is-globe-focus",
      dataAttribute: "on",
    });
  });
});

const atlasCurrentHome: HomeBasePeriod = {
  id: "home-shenzhen",
  label: "Shenzhen",
  latitude: 22.5431,
  longitude: 114.0579,
  startedOn: "2026-01-01",
  endedOn: null,
  source: "manual",
};

describe("ordinary Atlas Home runtime (ST-056)", () => {
  it("presents one effective Home entry and none when private periods are absent", () => {
    const presented = resolveOrdinaryAtlasHomePresence([atlasCurrentHome], "regional", "2026-09-10")
      .filter((entry) => entry.presence !== "absent");
    expect(presented).toHaveLength(1);
    expect(presented[0]).toMatchObject({ periodId: atlasCurrentHome.id, presence: "current" });
    expect(resolveOrdinaryAtlasHomePresence([], "regional", "2026-09-10")).toEqual([]);
  });

  it("distinguishes explicit Journey ownership from the default derived cursor selection", () => {
    expect(explicitSelectedJourneyIdForHomeCamera(false, "derived-journey")).toBeNull();
    expect(explicitSelectedJourneyIdForHomeCamera(true, "selected-journey")).toBe("selected-journey");
  });

  it("follows Globe Rewind dates and all-time state instead of pinning Home to today", () => {
    const timeDomain = {
      minTime: Date.UTC(2020, 0, 1),
      maxTime: Date.UTC(2020, 0, 11),
    };
    expect(resolveAtlasHomeTimelineContext({
      cursor: 1,
      timeDomain,
      timelineRevision: 0,
      hasExplicitSelection: false,
      effectiveDate: "2026-09-10",
    })).toEqual({ kind: "ordinary", date: "2026-09-10" });
    expect(resolveAtlasHomeTimelineContext({
      cursor: 0.5,
      timeDomain,
      timelineRevision: 1,
      hasExplicitSelection: false,
      effectiveDate: "2026-09-10",
    })).toEqual({ kind: "date", date: "2020-01-06" });
    expect(resolveAtlasHomeTimelineContext({
      cursor: 1,
      timeDomain,
      timelineRevision: 0,
      hasExplicitSelection: true,
      effectiveDate: "2026-09-10",
    })).toEqual({ kind: "date", date: "2020-01-11" });
    expect(resolveAtlasHomeTimelineContext({
      cursor: 1,
      timeDomain,
      timelineRevision: 1,
      hasExplicitSelection: false,
      effectiveDate: "2026-09-10",
    })).toEqual({ kind: "all-time", date: "2026-09-10" });

    const historicalHome: HomeBasePeriod = {
      ...atlasCurrentHome,
      id: "home-2020",
      label: "Old Home",
      startedOn: "2019-01-01",
      endedOn: "2021-01-01",
    };
    const rewindPresence = resolveHomeBasePresence({
      periods: [historicalHome, atlasCurrentHome],
      semanticZoom: "regional",
      timeline: { kind: "date", date: "2020-01-06" },
    });
    expect(rewindPresence.find((entry) => entry.periodId === historicalHome.id)?.presence).toBe("period-context");
    expect(rewindPresence.find((entry) => entry.periodId === atlasCurrentHome.id)?.presence).toBe("absent");
    const allTimePresence = resolveHomeBasePresence({
      periods: [historicalHome, atlasCurrentHome],
      semanticZoom: "regional",
      timeline: { kind: "all-time", date: "2026-09-10" },
    });
    expect(allTimePresence.find((entry) => entry.periodId === historicalHome.id)?.presence).toBe("trace");
    expect(allTimePresence.find((entry) => entry.periodId === atlasCurrentHome.id)?.presence).toBe("current");
  });

  it("advances the semantic revision when async Home seeding clears stale fallback focus", () => {
    expect(nextInitialHomeCameraFocusRevision(0)).toBe(1);
    expect(nextInitialHomeCameraFocusRevision(7)).toBe(8);
    const source = readFileSync(new URL("./LivingAtlasApp.tsx", import.meta.url), "utf8");
    expect(source).toContain("setInitialHomeCameraRevision(nextInitialHomeCameraFocusRevision)");
    expect(source).toContain("+ initialHomeCameraRevision");
  });

  it("seeds Home camera only for a fresh, unclaimed Atlas with no selected Journey", () => {
    const base = {
      periods: [atlasCurrentHome],
      effectiveDate: "2026-09-10",
      atlasIsFresh: true,
      hasManualCameraInteraction: false,
      selectedJourneyId: null,
    };
    expect(resolveInitialAtlasHomeCameraIntent(base)).toMatchObject({
      kind: "initial-home",
      homeBaseId: atlasCurrentHome.id,
      latitude: atlasCurrentHome.latitude,
      longitude: atlasCurrentHome.longitude,
    });
    expect(resolveInitialAtlasHomeCameraIntent({ ...base, hasManualCameraInteraction: true })).toBeNull();
    expect(resolveInitialAtlasHomeCameraIntent({ ...base, selectedJourneyId: "journey-1" })).toBeNull();
    expect(resolveInitialAtlasHomeCameraIntent({ ...base, atlasIsFresh: false })).toBeNull();
  });

  it("suppresses the untouched timeline point while Home owns the fresh Atlas camera, then restores explicit point focus", () => {
    const journeyWithPoint: Journey = {
      id: "journey-latest",
      atlasId: "atlas-1",
      title: "Latest Journey",
      startedOn: "2026-08-25",
      endedOn: null,
      note: "",
      lightColor: "#8ad9d0",
      revision: 1,
      createdByUserId: "user-1",
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
      routePoints: [{
        id: "point-latest",
        journeyId: "journey-latest",
        sortOrder: 0,
        latitude: 31.2304,
        longitude: 121.4737,
        label: "Shanghai",
        isStop: true,
        occurredAt: "2026-08-25T12:00:00.000Z",
        note: null,
        createdAt: "2026-08-25T00:00:00.000Z",
      }],
      media: [],
    };
    const timeline = buildJourneyTimeline([journeyWithPoint]);
    const untouchedSelection = resolveJourneyTimelineSelection(timeline.entries, 1);
    expect(untouchedSelection).toMatchObject({ journeyId: journeyWithPoint.id, pointIndex: 0 });

    const presentation = resolveMobilePlaybackPresentation([journeyWithPoint], untouchedSelection);
    expect(presentation.focusPoint).toEqual({ lat: 31.2304, lon: 121.4737 });
    const derivedJourneyOwner = explicitSelectedJourneyIdForHomeCamera(
      false,
      untouchedSelection?.journeyId ?? null,
    );
    const homeIntent = resolveInitialAtlasHomeCameraIntent({
      periods: [atlasCurrentHome],
      effectiveDate: "2026-09-10",
      atlasIsFresh: true,
      hasManualCameraInteraction: false,
      selectedJourneyId: derivedJourneyOwner,
    });
    const homeAnchor = homeIntent
      ? { lat: homeIntent.latitude, lon: homeIntent.longitude }
      : null;
    expect(homeAnchor).toEqual({ lat: atlasCurrentHome.latitude, lon: atlasCurrentHome.longitude });
    expect(resolveInitialHomeOwnedFocusPoint(presentation.focusPoint, homeAnchor)).toBeNull();

    const explicitJourneyOwner = explicitSelectedJourneyIdForHomeCamera(true, journeyWithPoint.id);
    expect(resolveInitialAtlasHomeCameraIntent({
      periods: [atlasCurrentHome],
      effectiveDate: "2026-09-10",
      atlasIsFresh: true,
      hasManualCameraInteraction: false,
      selectedJourneyId: explicitJourneyOwner,
    })).toBeNull();
    expect(resolveInitialHomeOwnedFocusPoint(presentation.focusPoint, null))
      .toEqual({ lat: 31.2304, lon: 121.4737 });

    const source = readFileSync(new URL("./LivingAtlasApp.tsx", import.meta.url), "utf8");
    expect(source).toContain("focusPoint={playbackCameraUsesPointFocus(playbackCameraTarget)");
    expect(source).toContain("resolveInitialHomeOwnedFocusPoint(focusPoint, initialHomeCameraAnchor)");
  });

  it("passes Home only from the private Home source and publishes semantic/manual camera ownership", () => {
    const source = readFileSync(new URL("./LivingAtlasApp.tsx", import.meta.url), "utf8");
    expect(source).toContain("homeBasePresence={listHomeBasePeriods ? {");
    expect(source).toContain("onSemanticZoomChange={setAtlasSemanticZoom}");
    expect(source).toContain("onManualCameraInteraction={claimManualAtlasCamera}");
    expect(source).toContain("initialHomeCameraAnchor ? null : focusRoute");
    expect(source).toContain("initialCameraAnchor={initialHomeCameraAnchor}");
    expect(source).toContain("timeCursor.hasExplicitSelection");
    expect(source).toContain("timeCursor.timelineRevision > 0");
    expect(source).toContain("timeline: atlasHomeTimelineContext");
    expect(source).toContain("playbackActive || timeCursor.timelineRevision > 0");
    expect(source).toContain("Math.max(focusRevision + initialHomeCameraRevision, playbackReleaseFocusRevision)");
    expect(source).toContain('inert={view !== "planet" || undefined}');
    const cursorSource = readFileSync(new URL("./useGlobeTimeCursor.ts", import.meta.url), "utf8");
    expect(cursorSource).toContain("hasExplicitSelection: selectionOwner !== null");
  });
});

const playbackJourney: Journey = {
  id: "journey-1",
  atlasId: "atlas-1",
  title: "Playback entry",
  startedOn: "2026-08-25",
  endedOn: null,
  note: "",
  lightColor: "#f4ce73",
  revision: 1,
  createdByUserId: "user-1",
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
  routePoints: [],
  media: [],
};



describe("Story to Playback return entry (#245)", () => {
  it("captures the currently observed Story asset separately from the entry route", () => {
    const entry = capturePlaybackEntryForContext(
      playbackJourney.id,
      playbackJourney.id,
      "point-a",
      {
        journeyId: playbackJourney.id,
        routePointId: "point-d",
        assetId: "asset-d",
        storySnapState: "expanded",
      },
      11,
    );
    expect(entry).toMatchObject({
      journeyId: playbackJourney.id,
      routePointId: "point-d",
      assetId: "asset-d",
      intentRevision: 11,
      source: "story",
      storySnapState: "expanded",
    });
  });

  it("captures Atlas entry without inventing Story media identity", () => {
    expect(capturePlaybackEntryForContext(
      playbackJourney.id,
      null,
      null,
      null,
      12,
    )).toEqual({
      journeyId: playbackJourney.id,
      routePointId: null,
      assetId: null,
      intentRevision: 12,
      source: "atlas",
      storySnapState: "closed",
    });
  });

  it("keeps last Story observation separate from an Atlas playback entry source", () => {
    expect(capturePlaybackEntryForContext(
      playbackJourney.id,
      null,
      null,
      {
        journeyId: playbackJourney.id,
        routePointId: "point-d",
        assetId: "asset-d",
        storySnapState: "expanded",
      },
      12,
    )).toMatchObject({
      routePointId: "point-d",
      assetId: "asset-d",
      source: "atlas",
      storySnapState: "expanded",
    });
  });

  it("retains the pre-entry Story identity while soundtrack preparation is pending", () => {
    const entry = capturePlaybackEntryForContext(
      playbackJourney.id,
      playbackJourney.id,
      "point-a",
      {
        journeyId: playbackJourney.id,
        routePointId: "point-d",
        assetId: "asset-d",
        storySnapState: "in-context",
      },
      13,
    );
    expect(pendingPlaybackStoryRestore(entry)).toEqual({
      journeyId: playbackJourney.id,
      routePointId: "point-d",
      assetId: "asset-d",
    });
  });

  it("does not invent a Story restore for Atlas-origin preparation", () => {
    const entry = capturePlaybackEntryForContext(playbackJourney.id, null, null, null, 14);
    expect(pendingPlaybackStoryRestore(entry)).toBeNull();
  });

  it("returns the currently observed D asset instead of the Story entry route A", () => {
    const returnJourney: Journey = {
      ...playbackJourney,
      routePoints: [
        { id: "point-a", journeyId: playbackJourney.id, sortOrder: 0, latitude: 1, longitude: 2, label: "A", isStop: true, occurredAt: null, createdAt: playbackJourney.createdAt },
        { id: "point-d", journeyId: playbackJourney.id, sortOrder: 1, latitude: 3, longitude: 4, label: "D", isStop: true, occurredAt: null, createdAt: playbackJourney.createdAt },
      ],
      media: [{
        id: "asset-d", journeyId: playbackJourney.id, routePointId: "point-d", storageDriver: "s3", storageKey: "d",
        fileName: "d.jpg", mimeType: "image/jpeg", bytes: 1, sortOrder: 0, uploadedByUserId: "user-1", createdAt: playbackJourney.createdAt,
      }],
    };
    const entry = capturePlaybackEntryForContext(
      returnJourney.id,
      returnJourney.id,
      "point-a",
      {
        journeyId: returnJourney.id,
        routePointId: "point-d",
        assetId: "asset-d",
        storySnapState: "expanded",
      },
      15,
    );

    expect(resolvePlaybackReturn({
      entry,
      // Intro/whole-Journey playback has not committed a more specific point,
      // so the Story observation remains the meaningful position.
      committedPosition: { journeyId: returnJourney.id, routePointId: null, assetId: null },
      reason: "exited",
      currentIntentRevision: 15,
      journeys: [returnJourney],
    })).toMatchObject({
      surface: "story",
      journeyId: returnJourney.id,
      routePointId: "point-d",
      assetId: "asset-d",
      storySnapState: "expanded",
    });
  });
});

describe("resolvePlaybackOwnership", () => {
  it("requires the playback id to resolve before granting cinematic ownership", () => {
    expect(resolvePlaybackOwnership([playbackJourney], playbackJourney.id, true)).toEqual({
      journey: playbackJourney,
      active: true,
      releaseStaleState: false,
    });
    expect(resolvePlaybackOwnership([], playbackJourney.id, true)).toEqual({
      journey: null,
      active: false,
      releaseStaleState: true,
    });
  });

  it("waits for the initial Journey load to settle before releasing stale state", () => {
    const ownership = resolvePlaybackOwnership([], playbackJourney.id, false);
    expect(ownership).toEqual({
      journey: null,
      active: false,
      releaseStaleState: false,
    });
    const session = {
      journeyId: playbackJourney.id,
      soundtrackRead: { url: "signed-track" },
      cameraCommand: { target: { kind: "route" as const }, revision: 7 },
    };
    expect(releaseStalePlaybackSession(session, ownership.releaseStaleState)).toBe(session);
  });

  it("keeps an ordinary settled state inactive without scheduling cleanup", () => {
    expect(resolvePlaybackOwnership([playbackJourney], null, true)).toEqual({
      journey: null,
      active: false,
      releaseStaleState: false,
    });
  });

  it("atomically releases playback state after the active Journey disappears", () => {
    const session = {
      journeyId: playbackJourney.id,
      soundtrackRead: { url: "signed-track" },
      cameraCommand: { target: { kind: "route" as const }, revision: 7 },
    };
    const before = resolvePlaybackOwnership([playbackJourney], session.journeyId, true);
    expect(before.active).toBe(true);

    const after = resolvePlaybackOwnership([], session.journeyId, true);
    expect(after.active).toBe(false);
    expect(releaseStalePlaybackSession(session, after.releaseStaleState)).toEqual({
      journeyId: null,
      soundtrackRead: null,
      cameraCommand: null,
    });
  });
});



describe("unknown-create confirmation close", () => {
  it("refreshes Atlas server truth without consuming the unresolved attempt", async () => {
    const pendingFile = { name: "pending.jpg", size: 12, type: "image/jpeg" } as File;
    const attempt = {
      input: {
        title: "Night train",
        startedOn: "2026-08-11",
        endedOn: null,
        note: "",
        lightColor: "#f4ce73",
        routePoints: [{
          latitude: 31.2304,
          longitude: 121.4737,
          label: "Shanghai",
          isStop: true,
          occurredAt: null,
        }],
      },
      knownJourneyIdsBeforeCreate: ["known-before-attempt"],
      mode: "confirmation-required" as const,
      routePoints: [{
        draftId: "draft-shanghai",
        latitude: 31.2304,
        longitude: 121.4737,
        label: "Shanghai",
        isStop: true,
        occurredAt: null,
      }],
      mediaFiles: [{ file: pendingFile, routePointDraftId: "draft-shanghai" }],
    };
    const candidate = { ...playbackJourney, id: "other-writer-candidate" };
    const preservedAttempts: typeof attempt[] = [];
    let atlasVisibleJourneys: Journey[] = [];
    const closeComposer = vi.fn();
    const createAgain = vi.fn();
    const uploadPendingMedia = vi.fn();
    const onSaved = vi.fn();
    const handoffArrival = vi.fn();

    await closeUnknownCreateWithCurrentAtlasTruth({
      attempt,
      preserveAttempt: (next) => {
        if (next) preservedAttempts.push(next as typeof attempt);
      },
      closeComposer,
      refreshAtlas: async () => {
        atlasVisibleJourneys = [candidate];
        return atlasVisibleJourneys;
      },
    });

    expect(closeComposer).toHaveBeenCalledTimes(1);
    expect(atlasVisibleJourneys.map((journey) => journey.id)).toEqual(["other-writer-candidate"]);
    expect(preservedAttempts).toEqual([attempt]);
    expect(preservedAttempts[0].mode).toBe("confirmation-required");
    expect(preservedAttempts[0].mediaFiles?.[0].file).toBe(pendingFile);
    expect(preservedAttempts[0].mediaFiles?.[0].routePointDraftId).toBe("draft-shanghai");
    expect(createAgain).not.toHaveBeenCalled();
    expect(uploadPendingMedia).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(handoffArrival).not.toHaveBeenCalled();

    const semanticState = resolveUnknownCreateObservationOwnership({
      journeys: atlasVisibleJourneys,
      timelineSelection: { journeyId: candidate.id, pointIndex: null },
      selectionRevision: 0,
      timelineRevision: 0,
      preserved: {
        activeJourneyId: null,
        selection: null,
        selectionRevision: 0,
        timelineRevision: 0,
      },
    });
    expect(semanticState.activeJourneyId).toBeNull();
    expect(resolveMobilePlaybackPresentation(
      atlasVisibleJourneys,
      semanticState.selection,
      semanticState.fallbackJourneyId,
    ).journey).toBeNull();
  });
});

describe("unknown-create verification focus ownership", () => {
  const candidate = { ...playbackJourney, id: "unproven-candidate" };
  const otherCandidate = { ...playbackJourney, id: "other-unproven-candidate" };

  it("keeps a first-Journey candidate visible but semantically neutral", () => {
    const state = resolveUnknownCreateObservationOwnership({
      journeys: [candidate],
      timelineSelection: { journeyId: candidate.id, pointIndex: null },
      selectionRevision: 0,
      timelineRevision: 0,
      preserved: {
        activeJourneyId: null,
        selection: null,
        selectionRevision: 0,
        timelineRevision: 0,
      },
    });

    expect(state.observationOnly).toBe(true);
    expect(state.activeJourneyId).toBeNull();
    expect(state.selection).toBeNull();
    expect(resolveMobilePlaybackPresentation(
      [candidate],
      state.selection,
      state.fallbackJourneyId,
    ).activeRouteId).toBeNull();
  });

  it("keeps every ambiguous candidate observation-only", () => {
    const state = resolveUnknownCreateObservationOwnership({
      journeys: [candidate, otherCandidate],
      timelineSelection: { journeyId: otherCandidate.id, pointIndex: null },
      selectionRevision: 4,
      timelineRevision: 7,
      preserved: {
        activeJourneyId: null,
        selection: null,
        selectionRevision: 4,
        timelineRevision: 7,
      },
    });

    expect(state.activeJourneyId).toBeNull();
    expect(state.selection).toBeNull();
    expect(resolveMobilePlaybackPresentation(
      [candidate, otherCandidate],
      state.selection,
      state.fallbackJourneyId,
    ).journey).toBeNull();
  });

  it("keeps repeated first-Journey verification neutral when the raw cursor defaults to the candidate", () => {
    const firstPass = resolveUnknownCreateObservationOwnership({
      journeys: [candidate],
      timelineSelection: { journeyId: candidate.id, pointIndex: null },
      selectionRevision: 0,
      timelineRevision: 0,
      preserved: {
        activeJourneyId: null,
        selection: null,
        selectionRevision: 0,
        timelineRevision: 0,
      },
    });
    const repeatedClose = captureUnknownCreateObservationOwnership({
      semanticOwnership: firstPass,
      selectionRevision: 0,
      timelineRevision: 0,
    });
    const secondPass = resolveUnknownCreateObservationOwnership({
      journeys: [candidate],
      timelineSelection: { journeyId: candidate.id, pointIndex: null },
      selectionRevision: 0,
      timelineRevision: 0,
      preserved: repeatedClose,
    });

    expect(repeatedClose.selection).toBeNull();
    expect(secondPass.observationOnly).toBe(true);
    expect(secondPass.activeJourneyId).toBeNull();
    expect(secondPass.selection).toBeNull();
    expect(resolveMobilePlaybackPresentation(
      [candidate],
      secondPass.selection,
      secondPass.fallbackJourneyId,
    ).activeRouteId).toBeNull();
  });

  it("keeps repeated ambiguous verification observation-only despite raw cursor defaulting", () => {
    const firstPass = resolveUnknownCreateObservationOwnership({
      journeys: [candidate, otherCandidate],
      timelineSelection: { journeyId: otherCandidate.id, pointIndex: null },
      selectionRevision: 4,
      timelineRevision: 7,
      preserved: {
        activeJourneyId: null,
        selection: null,
        selectionRevision: 4,
        timelineRevision: 7,
      },
    });
    const repeatedClose = captureUnknownCreateObservationOwnership({
      semanticOwnership: firstPass,
      selectionRevision: 4,
      timelineRevision: 7,
    });
    const secondPass = resolveUnknownCreateObservationOwnership({
      journeys: [candidate, otherCandidate],
      timelineSelection: { journeyId: otherCandidate.id, pointIndex: null },
      selectionRevision: 4,
      timelineRevision: 7,
      preserved: repeatedClose,
    });

    expect(repeatedClose.selection).toBeNull();
    expect(secondPass.activeJourneyId).toBeNull();
    expect(secondPass.selection).toBeNull();
    expect(resolveMobilePlaybackPresentation(
      [candidate, otherCandidate],
      secondPass.selection,
      secondPass.fallbackJourneyId,
    ).journey).toBeNull();
  });

  it("preserves the pre-close current owner instead of switching to a recovery candidate", () => {
    const existing = { ...playbackJourney, id: "existing-owner" };
    const state = resolveUnknownCreateObservationOwnership({
      journeys: [existing, candidate],
      timelineSelection: { journeyId: candidate.id, pointIndex: null },
      selectionRevision: 2,
      timelineRevision: 3,
      preserved: {
        activeJourneyId: existing.id,
        selection: { journeyId: existing.id, pointIndex: null },
        selectionRevision: 2,
        timelineRevision: 3,
      },
    });

    expect(state.activeJourneyId).toBe(existing.id);
    expect(state.selection?.journeyId).toBe(existing.id);
    expect(resolveMobilePlaybackPresentation(
      [existing, candidate],
      state.selection,
      state.fallbackJourneyId,
    ).activeRouteId).toBe(existing.id);
  });

  it("releases observation-only ownership after an explicit selection revision", () => {
    const state = resolveUnknownCreateObservationOwnership({
      journeys: [candidate],
      timelineSelection: { journeyId: candidate.id, pointIndex: null },
      selectionRevision: 1,
      timelineRevision: 0,
      preserved: {
        activeJourneyId: null,
        selection: null,
        selectionRevision: 0,
        timelineRevision: 0,
      },
    });

    expect(state.observationOnly).toBe(false);
    expect(state.activeJourneyId).toBe(candidate.id);
  });
});

describe("optional Home hydration", () => {
  it("lets Journeys resolve while private Home history remains pending", async () => {
    let resolveHome!: (periods: []) => void;
    const homePending = new Promise<[]>((resolve) => { resolveHome = resolve; });
    const onHomeBasePeriods = vi.fn();

    const rows = await loadJourneyRowsWithOptionalHome({
      listJourneys: async () => [playbackJourney],
      listHomeBasePeriods: () => homePending,
      isCurrent: () => true,
      onHomeBasePeriods,
    });

    expect(rows).toEqual([playbackJourney]);
    expect(onHomeBasePeriods).not.toHaveBeenCalled();
    resolveHome([]);
    // The detached hydration intentionally crosses the Promise.resolve() start
    // boundary and then the Home request boundary before committing. Drain both
    // microtasks without making Journey readiness await Home in production.
    await homePending;
    await Promise.resolve();
    await Promise.resolve();
    expect(onHomeBasePeriods).toHaveBeenCalledWith([]);
  });

  it("drops detached private Home reads once a newer load owns the view", async () => {
    let resolvePeriods!: (periods: []) => void;
    let resolveDismissals!: (dismissals: []) => void;
    const periodsPending = new Promise<[]>((resolve) => { resolvePeriods = resolve; });
    const dismissalsPending = new Promise<[]>((resolve) => { resolveDismissals = resolve; });
    const onHomeBasePeriods = vi.fn();
    const onHomeBaseDismissals = vi.fn();
    let current = true;

    const rows = await loadJourneyRowsWithOptionalHome({
      listJourneys: async () => [playbackJourney],
      listHomeBasePeriods: () => periodsPending,
      listHomeBaseDismissals: () => dismissalsPending,
      isCurrent: () => current,
      onHomeBasePeriods,
      onHomeBaseDismissals,
    });

    expect(rows).toEqual([playbackJourney]);
    current = false;
    resolvePeriods([]);
    resolveDismissals([]);
    await Promise.all([periodsPending, dismissalsPending]);
    await Promise.resolve();
    await Promise.resolve();
    expect(onHomeBasePeriods).not.toHaveBeenCalled();
    expect(onHomeBaseDismissals).not.toHaveBeenCalled();
  });

  it("keeps guest/read-only views free of private Home hydration", async () => {
    const onHomeBasePeriods = vi.fn();
    await loadJourneyRowsWithOptionalHome({
      listJourneys: async () => [playbackJourney],
      listHomeBasePeriods: null,
      isCurrent: () => true,
      onHomeBasePeriods,
    });
    expect(onHomeBasePeriods).toHaveBeenCalledWith([]);
  });
});

describe("playbackFocusPointForCameraTarget", () => {
  const journeyWithPoints: Journey = {
    ...playbackJourney,
    routePoints: [{
      id: "point-0",
      journeyId: playbackJourney.id,
      sortOrder: 0,
      latitude: 22.5431,
      longitude: 114.0579,
      label: "Shenzhen",
      isStop: true,
      occurredAt: null,
      note: null,
      createdAt: "2026-08-25T00:00:00.000Z",
    }],
  };

  it("releases point focus for intro/outro route framing", () => {
    expect(playbackFocusPointForCameraTarget(journeyWithPoints, { kind: "route" })).toBeNull();
  });

  it("maps point camera ownership to the route point coordinates", () => {
    expect(playbackFocusPointForCameraTarget(
      journeyWithPoints,
      { kind: "point", pointIndex: 0 },
    )).toEqual({ lat: 22.5431, lon: 114.0579 });
  });

  it("maps private Home camera context directly without fabricating a Route Point", () => {
    expect(playbackFocusPointForCameraTarget(journeyWithPoints, {
      kind: "home",
      homeBaseId: "home-shenzhen",
      latitude: 22.5431,
      longitude: 114.0579,
      anchor: { x: 1, y: 2, z: 3 },
    })).toEqual({ lat: 22.5431, lon: 114.0579 });
  });

  it("lets Home camera context own the globe point channel without owning route geometry", () => {
    expect(playbackCameraUsesPointFocus({ kind: "home", homeBaseId: "h", latitude: 1, longitude: 2, anchor: { x: 1, y: 0, z: 0 } })).toBe(true);
    expect(playbackCameraUsesPointFocus({ kind: "point", pointIndex: 0 })).toBe(true);
    expect(playbackCameraUsesPointFocus({ kind: "route" })).toBe(false);
  });

  it("fails closed for a missing route point", () => {
    expect(playbackFocusPointForCameraTarget(
      journeyWithPoints,
      { kind: "point", pointIndex: 4 },
    )).toBeNull();
  });

  it("keeps route ownership explicit instead of collapsing it to a null point", () => {
    const route = {
      id: journeyWithPoints.id,
      color: journeyWithPoints.lightColor,
      points: journeyWithPoints.routePoints.map((point) => ({
        id: point.id,
        lat: point.latitude,
        lon: point.longitude,
        isStop: point.isStop,
      })),
    };
    expect(playbackFocusRouteForCameraTarget(route, { kind: "route" })).toBe(route);
    expect(playbackFocusRouteForCameraTarget(route, { kind: "point", pointIndex: 0 })).toBeNull();
    expect(playbackFocusRouteForCameraTarget(route, { kind: "home", homeBaseId: "h", latitude: 1, longitude: 2, anchor: { x: 1, y: 0, z: 0 } })).toBeNull();
  });

  it("increments a camera command revision even for the same route target", () => {
    const first = nextPlaybackCameraCommand(null, { kind: "route" });
    const second = nextPlaybackCameraCommand(first, { kind: "route" });
    const afterNormalFocus = nextPlaybackCameraCommand(null, { kind: "route" }, 100_123);
    expect(first).toEqual({ target: { kind: "route" }, revision: 1 });
    expect(second).toEqual({ target: { kind: "route" }, revision: 2 });
    expect(afterNormalFocus).toEqual({ target: { kind: "route" }, revision: 100_124 });
  });

  it("hands normal focus a revision above stale playback ownership", () => {
    const released = nextPlaybackReleaseFocusRevision(0, 120_004, 3_002);
    expect(released).toBe(120_005);
    expect(nextPlaybackCameraCommand(null, { kind: "route" }, released).revision).toBe(120_006);
  });
});

describe("Mobile V2 playback presentation", () => {
  const first: Journey = {
    ...playbackJourney,
    id: "journey-a",
    title: "A",
    routePoints: [
      {
        id: "a-0",
        journeyId: "journey-a",
        sortOrder: 0,
        latitude: 22.5431,
        longitude: 114.0579,
        label: "Shenzhen",
        isStop: true,
        occurredAt: null,
        createdAt: playbackJourney.createdAt,
      },
      {
        id: "a-1",
        journeyId: "journey-a",
        sortOrder: 1,
        latitude: 31.2304,
        longitude: 121.4737,
        label: "Shanghai",
        isStop: true,
        occurredAt: null,
        createdAt: playbackJourney.createdAt,
      },
    ],
  };
  const second: Journey = {
    ...playbackJourney,
    id: "journey-b",
    title: "B",
    routePoints: [{
      id: "b-0",
      journeyId: "journey-b",
      sortOrder: 0,
      latitude: 35.6762,
      longitude: 139.6503,
      label: "Tokyo",
      isStop: true,
      occurredAt: null,
      createdAt: playbackJourney.createdAt,
    }],
  };

  it("derives chip journey, active route, route point and globe target from the same selection", () => {
    const presentation = resolveMobilePlaybackPresentation(
      [first, second],
      { journeyId: "journey-a", pointIndex: 1 },
    );
    expect(presentation.journey?.id).toBe("journey-a");
    expect(presentation.activeRouteId).toBe("journey-a");
    expect(presentation.point?.id).toBe("a-1");
    expect(presentation.focusPoint).toEqual({ lat: 31.2304, lon: 121.4737 });
  });

  it("moves the globe target when the authoritative journey changes", () => {
    const presentation = resolveMobilePlaybackPresentation(
      [first, second],
      { journeyId: "journey-b", pointIndex: 0 },
    );
    expect(presentation.journey?.id).toBe("journey-b");
    expect(presentation.activeRouteId).toBe("journey-b");
    expect(presentation.focusPoint).toEqual({ lat: 35.6762, lon: 139.6503 });
    expect(presentation.focusRevision).toBeGreaterThan(1000);
  });

  it("publishes one route intent for a whole Journey selection", () => {
    const presentation = resolveMobilePlaybackPresentation(
      [first, second],
      { journeyId: "journey-a", pointIndex: null },
    );
    expect(presentation.focusPoint).toBeNull();
    expect(presentation.activeRouteId).toBe("journey-a");
  });

  it("publishes one point intent for a route-point selection", () => {
    const presentation = resolveMobilePlaybackPresentation(
      [first, second],
      { journeyId: "journey-a", pointIndex: 1 },
    );
    expect(presentation.focusPoint).toEqual({ lat: 31.2304, lon: 121.4737 });
  });

  it("keeps the persistent mobile chrome within the design budget and safe area", () => {
    const css = readFileSync(new URL("../styles/living-atlas.css", import.meta.url), "utf8");
    const mobileChrome = css.slice(
      css.indexOf(".mobile-v2__chrome"),
      css.indexOf(".mobile-v2__journey-chip"),
    );
    expect(mobileChrome).toContain("height: 118px;");
    expect(mobileChrome).toContain("env(safe-area-inset-bottom)");
  });

  it("keeps the desktop playback chooser within short viewports", () => {
    const css = readFileSync(new URL("../styles/living-atlas.css", import.meta.url), "utf8");
    const constrainedCard = css.slice(
      css.indexOf(".living-atlas__active.has-playback-menu"),
      css.indexOf(".living-atlas__playback-mode-menu"),
    );
    expect(constrainedCard).toContain("max-height: calc(100svh");
    expect(constrainedCard).toContain("overflow-y: auto;");
  });
});

describe("Route Point context integration (#291)", () => {
  const appSource = readFileSync(new URL("./LivingAtlasApp.tsx", import.meta.url), "utf8");

  it("reveals context from route-point activation without claiming camera or focus revision", () => {
    const start = appSource.indexOf("onJourneyRoutePointActivate={(journeyId, routePointId) => {");
    const end = appSource.indexOf("onGlobePointPick=", start);
    const handler = appSource.slice(start, end);

    expect(start).toBeGreaterThan(0);
    expect(handler).toContain("revealRoutePointContext(journeyId, routePointId)");
    expect(handler).not.toContain("timeCursor.selectPoint");
    expect(handler).not.toContain("setStoryJourneyId");
    expect(handler).not.toContain("setStoryRoutePointId");
    expect(handler).not.toContain("focusRevision");
    expect(handler).not.toContain("cameraCommand");
  });

  it("keeps representative-media readiness inside context ownership", () => {
    const start = appSource.indexOf("function RoutePointContextRepresentative");
    const end = appSource.indexOf("export function playbackFocusPointForCameraTarget", start);
    const representative = appSource.slice(start, end);

    expect(start).toBeGreaterThan(0);
    expect(representative).toContain("let cancelled = false");
    expect(representative).toContain("if (!cancelled) setRead");
    expect(representative).not.toContain("timeCursor");
    expect(representative).not.toContain("focusRevision");
    expect(representative).not.toContain("cameraCommand");
  });

  it("opens Story through the existing identity-preserving entry", () => {
    const start = appSource.indexOf('className="living-atlas__route-point-context-entry"');
    const entry = appSource.slice(start, start + 500);
    expect(start).toBeGreaterThan(0);
    expect(entry).toContain("openJourneyStory(context.journeyId, context.routePointId)");
  });

  it("hands the representative asset off from live Route Point geometry instead of stored x/y", () => {
    const helperStart = appSource.indexOf("function createPlaceMediaObservationElement");
    const helperEnd = appSource.indexOf("export function playbackFocusPointForCameraTarget", helperStart);
    const helper = appSource.slice(helperStart, helperEnd);
    const openStart = appSource.indexOf("function openJourneyStory(journeyId: string, routePointId: string | null)");
    const closeStart = appSource.indexOf("function closeJourneyStory", openStart);
    const open = appSource.slice(openStart, closeStart);
    const close = appSource.slice(closeStart, appSource.indexOf("const homeNarrativeContextForJourney", closeStart));

    expect(helperStart).toBeGreaterThan(0);
    expect(helper).toContain("liveRoutePointMarker(journeyId, routePointId)");
    expect(helper).toContain("marker.getBoundingClientRect()");
    expect(helper).toContain("resolvePlaceMediaObservationRect(");
    expect(open).toContain("routePointRepresentativeVisual(sharedAssetId)");
    expect(open).toContain("setStoryInitialAssetId(routePointId ? sharedAssetId : null)");
    expect(open).toContain("createPlaceMediaObservationElement({");
    expect(open).toContain("onCleanup: observationSource ? () => observationSource.remove() : undefined");
    expect(close).toContain("storyObservationRef.current");
    expect(close).toContain("createPlaceMediaObservationElement({");
    expect(close).toContain("paintSource: false");
    expect(close).toContain("resolvePlaceMediaReturnRoutePointId({");
    expect(close).toContain("storyObservationRef.current");
    expect(close).toContain("activeJourneyIdRef.current");
    expect(close).toContain("journeysRef.current");
    expect(close).toContain("revealRoutePointContext(journeyId, returnRoutePointId)");
    expect(close).not.toContain("routePointContextSelectionRef.current");
    expect(helper).not.toContain("setState");
  });

  it("keeps video entry on same-asset preview identity when a preview is available", () => {
    const start = appSource.indexOf("function RoutePointContextRepresentative");
    const end = appSource.indexOf("function liveRoutePointMarker", start);
    const representative = appSource.slice(start, end);
    expect(representative).toContain("readMedia(asset.id)");
    expect(representative).toContain("read.preview?.url ?? (imageAsset ? read.url : null)");
    expect(representative).toContain("data-route-point-context-representative={asset.id}");
  });

  it("drops context outside planet view and refreshes retained context from the latest Journey", () => {
    const refreshStart = appSource.indexOf("const intent = routePointContextSelection.intent;");
    const refreshBlock = appSource.slice(refreshStart, refreshStart + 900);
    const renderStart = appSource.indexOf('{view === "planet" && routePointContextSelection.context');

    expect(refreshStart).toBeGreaterThan(0);
    expect(refreshBlock).toContain("buildRoutePointContext(journey, intent.routePointId)");
    expect(refreshBlock).toContain("resolveRoutePointContextSelection(");
    expect(refreshBlock).toContain('view !== "planet"');
    expect(refreshBlock).toContain("clearRoutePointContext()");
    expect(renderStart).toBeGreaterThan(0);
  });

  it("keeps long context notes reachable within the clipped Atlas viewport", () => {
    const css = readFileSync(new URL("../styles/living-atlas.css", import.meta.url), "utf8");
    const start = css.indexOf(".living-atlas__route-point-context {");
    const rule = css.slice(start, css.indexOf("}", start));

    expect(start).toBeGreaterThan(0);
    expect(rule).toContain("max-height:");
    expect(rule).toContain("overflow-y: auto;");
    expect(rule).toContain("overscroll-behavior: contain;");
  });
});

describe("Quick Recap over-budget choice (ST-011)", () => {
  const appSource = readFileSync(new URL("./LivingAtlasApp.tsx", import.meta.url), "utf8");

  it("stops before playback-entry, soundtrack preparation, or Full Playback ownership", () => {
    const branchStart = appSource.indexOf('if (!quickRecap && preparation.fallbackReason === "over-budget")');
    const branchEnd = appSource.indexOf("if (!quickRecap) {", branchStart + 1);
    const branch = appSource.slice(branchStart, branchEnd);
    const playbackEntryStart = appSource.indexOf("const continuingPending =", branchStart);

    expect(branchStart).toBeGreaterThan(0);
    expect(branch).toContain("setPlaybackOverBudgetChoice({");
    expect(branch).toContain("setPlaybackModeMenuJourneyId(journeyId)");
    expect(branch).toContain("return;");
    expect(branch).not.toContain('mode = "full"');
    expect(branch).not.toContain("cachedSoundtrackRead");
    expect(branch).not.toContain("prefetchSoundtrackRead");
    expect(playbackEntryStart).toBeGreaterThan(branchEnd);
  });

  it("offers an explicit accessible Full Playback action while preserving no-visual-media fallback", () => {
    expect(appSource).toContain('data-quick-recap-fallback-message="over-budget"');
    expect(appSource).toContain('data-quick-recap-fallback="over-budget"');
    expect(appSource).toContain('aria-label="完整播放"');
    expect(appSource).toContain("ref={playbackOverBudgetActionRef}");
    expect(appSource).toContain("playbackOverBudgetActionRef.current?.focus()");
    expect(appSource).toContain("当前回顾时长放不下所有必要的旅程点。");
    expect(appSource).toContain("这段旅程还没有可用于快速回顾的照片或视频，已切换为完整播放。");
  });

  it("keys a stored overflow decision to current Quick Recap planning truth", () => {
    expect(appSource).toContain("activeJourneyQuickRecapPlanningFingerprint");
    expect(appSource).toContain("[activeJourney?.id, activeJourneyQuickRecapPlanningFingerprint]");
    expect(appSource).toContain("current.planningContentFingerprint === activeJourneyQuickRecapPlanningFingerprint");
    expect(appSource).not.toContain("[activeJourney?.revision]");
  });

  it("changes the planning fingerprint for same-revision media topology and route geometry edits", () => {
    const planningJourney: Journey = {
      ...playbackJourney,
      coverMediaAssetId: null,
      routePoints: [
        {
          id: "point-a", journeyId: playbackJourney.id, sortOrder: 0, latitude: 22.54, longitude: 114.05,
          label: "A", isStop: true, occurredAt: null, note: "short note", createdAt: playbackJourney.createdAt,
        },
        {
          id: "point-b", journeyId: playbackJourney.id, sortOrder: 1, latitude: 39.90, longitude: 116.40,
          label: "B", isStop: true, occurredAt: null, note: "second note", createdAt: playbackJourney.createdAt,
        },
      ],
      media: [
        {
          id: "asset-a", journeyId: playbackJourney.id, routePointId: "point-a", storageDriver: "test",
          storageKey: "a", fileName: "a.jpg", mimeType: "image/jpeg", bytes: 1, sortOrder: 0,
          uploadedByUserId: "user-1", createdAt: playbackJourney.createdAt,
        },
        {
          id: "asset-b", journeyId: playbackJourney.id, routePointId: "point-b", storageDriver: "test",
          storageKey: "b", fileName: "b.jpg", mimeType: "image/jpeg", bytes: 1, sortOrder: 1,
          uploadedByUserId: "user-1", createdAt: playbackJourney.createdAt,
        },
      ],
    };
    const baseline = quickRecapPlanningContentFingerprint(planningJourney);
    const reordered: Journey = {
      ...planningJourney,
      media: planningJourney.media.map((asset) => asset.id === "asset-a"
        ? { ...asset, sortOrder: 2 }
        : { ...asset, sortOrder: 0 }),
    };
    const moved: Journey = {
      ...planningJourney,
      media: planningJourney.media.map((asset) => asset.id === "asset-b"
        ? { ...asset, routePointId: "point-a" }
        : asset),
    };
    const fewer: Journey = { ...planningJourney, media: planningJourney.media.slice(0, 1) };
    const geometryChanged: Journey = {
      ...planningJourney,
      routePoints: planningJourney.routePoints.map((point) => point.id === "point-b"
        ? { ...point, latitude: point.latitude + 1 }
        : point),
    };

    expect(quickRecapPlanningContentFingerprint(reordered)).not.toBe(baseline);
    expect(quickRecapPlanningContentFingerprint(moved)).not.toBe(baseline);
    expect(quickRecapPlanningContentFingerprint(fewer)).not.toBe(baseline);
    expect(quickRecapPlanningContentFingerprint(geometryChanged)).not.toBe(baseline);
    expect(quickRecapPlanningContentFingerprint({ ...planningJourney, revision: planningJourney.revision + 1 })).not.toBe(baseline);
    expect(quickRecapPlanningContentFingerprint({ ...planningJourney, updatedAt: "later" })).toBe(baseline);
  });
});

describe("playbackEntryNeedsPreparation (PR #24 review)", () => {
  it("starts a silent journey immediately instead of waiting for soundtrack preparation", () => {
    expect(playbackEntryNeedsPreparation(playbackJourney, null)).toBe(false);
  });

  it("only waits when the journey has a soundtrack and no cached read", () => {
    const withSoundtrack: Journey = {
      ...playbackJourney,
      media: [{
        id: "track-1",
        journeyId: playbackJourney.id,
        routePointId: null,
        storageDriver: "test",
        storageKey: "track-1",
        fileName: "journey.mp3",
        mimeType: "audio/mpeg",
        bytes: 128,
        sortOrder: 0,
        uploadedByUserId: "user-1",
        createdAt: "2026-08-25T00:00:00.000Z",
      }],
    };
    expect(playbackEntryNeedsPreparation(withSoundtrack, null)).toBe(true);
    expect(playbackEntryNeedsPreparation(withSoundtrack, { url: "signed-track" })).toBe(false);
  });
});

describe("playbackMediaGate (PR #24 review)", () => {
  it("keeps pending media held but treats signed-read failures as settled errors", () => {
    expect(playbackMediaGate(undefined, undefined, true)).toBe("waiting");
    expect(playbackMediaGate({ status: "loading" }, undefined, true)).toBe("waiting");
    expect(playbackMediaGate({ status: "error", message: "read failed" }, undefined, true))
      .toBe("error");
  });

  it("treats decode failure as settled and decoded images as ready", () => {
    const ready = {
      status: "ready" as const,
      url: "signed-image",
      issuedAt: 0,
      expiresAt: 900_000,
    };
    expect(playbackMediaGate(ready, { status: "error", message: "decode failed" }, true))
      .toBe("error");
    expect(playbackMediaGate(ready, { status: "decoded" }, true)).toBe("ready");
  });
});

describe("playbackHoldReason (#197)", () => {
  const image = {
    id: "asset-image",
    journeyId: "journey",
    routePointId: "point",
    storageDriver: "qa",
    storageKey: "qa/image",
    fileName: "image.png",
    mimeType: "image/png",
    bytes: 68,
    sortOrder: 0,
    uploadedByUserId: "user",
    createdAt: "2026-09-05T00:00:00.000Z",
  };
  const video = { ...image, id: "asset-video", fileName: "clip.mp4", mimeType: "video/mp4" };
  const base = {
    stepKind: "media" as const,
    asset: image,
    gate: "ready" as const,
    videoPlaybackFailed: false,
    trimStatus: null,
  };

  it("reports a decode hold only while an image beat is still waiting", () => {
    expect(playbackHoldReason({ ...base, gate: "waiting" })).toBe("decode");
    expect(playbackHoldReason({ ...base, gate: "ready" })).toBe("none");
    // A settled read/decode failure releases the beat so the media step can
    // render its recoverable error state instead of deadlocking.
    expect(playbackHoldReason({ ...base, gate: "error" })).toBe("none");
  });

  it("reports a stop beat's wait on its first image, and nothing for other phases", () => {
    expect(playbackHoldReason({ ...base, stepKind: "stop", gate: "waiting" })).toBe("decode");
    expect(playbackHoldReason({ ...base, stepKind: "stop", gate: "ready" })).toBe("none");
    // A stop step with no image to wait on, and every non-media phase, are free.
    expect(playbackHoldReason({ ...base, stepKind: "stop", asset: null, gate: "waiting" }))
      .toBe("none");
    expect(playbackHoldReason({ ...base, stepKind: "travel", gate: "waiting" })).toBe("none");
    expect(playbackHoldReason({ ...base, stepKind: "intro", gate: "waiting" })).toBe("none");
    expect(playbackHoldReason({ ...base, stepKind: undefined, asset: null })).toBe("none");
  });

  it("ignores a stale read settling behind the post-seek hold target", () => {
    const currentRead = { status: "loading" as const };
    const staleCompletion = {
      status: "ready" as const,
      url: "stale-signed-image",
      issuedAt: 0,
      expiresAt: 900_000,
    };
    const before = playbackHoldReason({
      ...base,
      gate: playbackMediaGate(currentRead, undefined, true),
    });
    // The old asset may populate its cache entry, but that entry is not an input
    // to the CURRENT step's hold decision after the seek.
    expect(staleCompletion.status).toBe("ready");
    const afterStaleCompletion = playbackHoldReason({
      ...base,
      gate: playbackMediaGate(currentRead, undefined, true),
    });

    expect(before).toBe("decode");
    expect(afterStaleCompletion).toBe(before);
  });

  it("separates a video beat's own runtime and a trim's positioning from a decode hold", () => {
    // An untrimmed video beat is held until `ended`: that is the element owning
    // its runtime, not a lookahead that ran out, so #197's capture must not
    // count it as a decode hold.
    expect(playbackHoldReason({ ...base, asset: video })).toBe("video");
    expect(playbackHoldReason({ ...base, asset: video, videoPlaybackFailed: true })).toBe("none");
    expect(playbackHoldReason({ ...base, asset: video, trimStatus: "positioning" })).toBe("trim");
    expect(playbackHoldReason({ ...base, asset: video, trimStatus: "buffering" })).toBe("trim");
    expect(playbackHoldReason({ ...base, asset: video, trimStatus: "playing" })).toBe("none");
  });
});

describe("Quiet Core route presentation", () => {
  it("uses one normalized temporal leader and leg draw without perpetual route loops", () => {
    const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");
    const atlasCss = readFileSync(new URL("../styles/living-atlas.css", import.meta.url), "utf8");
    const scene = readFileSync(new URL("../scene/ParticleEarthScene.tsx", import.meta.url), "utf8");

    expect(css).toContain(
      ".particle-earth-route.is-style-quiet-core[data-temporal-reveal] .particle-earth-route__travel-leader",
    );
    expect(css).toContain(
      "stroke-dashoffset: calc(-1 * var(--journey-temporal-progress, 0));",
    );
    expect(css).toContain(
      "stroke-dashoffset: calc(1 - var(--journey-leg-temporal-progress, 0));",
    );
    expect(scene).toContain('leaderPath.setAttribute("pathLength", "1")');
    expect(scene).toContain('path.setAttribute("pathLength", "1")');
    expect(scene).not.toContain("particle-earth-route__strand-a");
    expect(scene).not.toContain("particle-earth-route__point-ring");
    expect(`${css}\n${atlasCss}`).not.toContain("motionStrandA");
    expect(`${css}\n${atlasCss}`).not.toContain("motionStrandB");
    expect(`${css}\n${atlasCss}`).not.toContain("motionJourneyPointTwinkle");
    expect(`${css}\n${atlasCss}`).not.toContain("motionClusterPulse");
  });

  it("sequences destination arrival after the shared route travel duration", () => {
    const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");
    const authority = css.indexOf(
      "--journey-route-travel-duration: var(--motion-journey, 980ms);",
    );
    const drawRule = css.indexOf(
      "animation: motionRouteDraw var(--journey-route-travel-duration)",
      authority,
    );
    const leaderRule = css.indexOf(
      "animation: motionRouteLeader var(--journey-route-travel-duration) linear 1 both;",
      drawRule,
    );
    const arrivalRule = css.indexOf(
      "animation: motionRouteArrival var(--journey-route-arrival-duration) var(--motion-ease-out, ease) var(--journey-route-travel-duration) 1 both;",
      leaderRule,
    );

    expect(authority).toBeGreaterThanOrEqual(0);
    expect(drawRule).toBeGreaterThan(authority);
    expect(leaderRule).toBeGreaterThan(drawRule);
    expect(arrivalRule).toBeGreaterThan(leaderRule);
    expect(css).not.toContain(
      "animation: motionRouteArrival var(--motion-content, 560ms) var(--motion-ease-out, ease) 1 both;",
    );
  });

  it("lets camera focus own attention before the one-shot route draw and leader", () => {
    const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");
    const drawRule = css.indexOf(
      ".particle-earth-route.is-style-quiet-core.is-active:not([data-temporal-reveal]) .particle-earth-route__core,",
    );
    const leaderRule = css.indexOf(
      ".particle-earth-route.is-style-quiet-core.is-active:not([data-temporal-reveal]) .particle-earth-route__travel-leader",
      drawRule,
    );
    const flyingRule = css.indexOf(
      '.particle-earth-scene[data-route-focus-phase="flying"]',
      leaderRule,
    );
    expect(drawRule).toBeGreaterThanOrEqual(0);
    expect(leaderRule).toBeGreaterThan(drawRule);
    expect(flyingRule).toBeGreaterThan(leaderRule);
    expect(css.slice(leaderRule, flyingRule)).toContain(
      "animation: motionRouteLeader var(--journey-route-travel-duration) linear 1 both;",
    );
    const flyingBlock = css.slice(flyingRule, css.indexOf("@keyframes motionRouteDraw", flyingRule));
    expect(flyingBlock).toContain("animation: none;");
    expect(flyingBlock).toContain("stroke-dashoffset: 1;");
    expect(flyingBlock).toContain("opacity: 0;");
  });

  it("keeps reduced motion semantically complete without a travelling packet", () => {
    const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");
    const leaderKeyframes = css.indexOf("@keyframes motionRouteLeader");
    const reducedMotion = css.indexOf("@media (prefers-reduced-motion: reduce)", leaderKeyframes);
    expect(leaderKeyframes).toBeGreaterThanOrEqual(0);
    expect(reducedMotion).toBeGreaterThan(leaderKeyframes);
    const reducedBlock = css.slice(reducedMotion, reducedMotion + 900);
    expect(reducedBlock).toContain("stroke-dashoffset: 0;");
    expect(reducedBlock).toContain(".particle-earth-route__travel-leader");
    expect(reducedBlock).toContain("opacity: 0 !important;");
  });
});

describe("Mobile V2 particle-earth pointer ownership", () => {
  it("lets empty-state visuals pass gestures through while keeping the CTA interactive", () => {
    const css = readFileSync(new URL("../styles/living-atlas.css", import.meta.url), "utf8");
    const emptyRule = css.indexOf(".living-atlas.is-mobile-v2 .living-atlas__empty {");
    const buttonRule = css.indexOf(".living-atlas.is-mobile-v2 .living-atlas__empty button {", emptyRule);
    expect(emptyRule).toBeGreaterThanOrEqual(0);
    expect(buttonRule).toBeGreaterThan(emptyRule);
    expect(css.slice(emptyRule, buttonRule)).toContain("pointer-events: none;");
    expect(css.slice(buttonRule, css.indexOf("}", buttonRule) + 1)).toContain("pointer-events: auto;");
  });
});

describe("railContentSignature (rail overflow hint freshness)", () => {
  it("changes when a same-count edit alters what the rail renders", () => {
    const before = railContentSignature([playbackJourney]);
    const renamed = railContentSignature([
      { ...playbackJourney, title: "一条被改得很长很长、足以在旅程栏换行的旅程标题" },
    ]);
    expect(renamed).not.toBe(before);
  });

  it("changes when a same-count edit moves the start date", () => {
    const before = railContentSignature([playbackJourney]);
    const redated = railContentSignature([{ ...playbackJourney, startedOn: "2024-01-05" }]);
    expect(redated).not.toBe(before);
  });

  it("stays stable when the rail content is unchanged", () => {
    expect(railContentSignature([playbackJourney]))
      .toBe(railContentSignature([{ ...playbackJourney }]));
  });

  it("still tracks count changes", () => {
    const two = railContentSignature([playbackJourney, { ...playbackJourney, id: "journey-2" }]);
    expect(two).not.toBe(railContentSignature([playbackJourney]));
  });
});

describe("atlas notice auto-dismiss identity", () => {
  it("assigns a fresh identity when the same message is published again", () => {
    const first = nextAtlasNotice(null, "旅程修改已保存。");
    const second = nextAtlasNotice(first, "旅程修改已保存。");

    expect(second.message).toBe(first.message);
    expect(second.id).toBe(first.id + 1);
  });
});

// #308: renderer-mode chrome is gone. This resolver now controls only the
// detail-stage cluster and keyboard-only Dive affordance while #253 still owns
// focus-mode isolation and compact mobile stays gesture-first.
describe("globe detail-control ownership (#308)", () => {
  it("keeps the detail-control owner mounted in ordinary desktop Atlas", () => {
    expect(showsGlobeDetailControls(false, false)).toBe(true);
  });

  it("withholds it in globe focus mode, so no node and no layout slot exist", () => {
    expect(showsGlobeDetailControls(false, true)).toBe(false);
  });

  it("keeps compact mobile without it, focus mode or not", () => {
    expect(showsGlobeDetailControls(true, false)).toBe(false);
    expect(showsGlobeDetailControls(true, true)).toBe(false);
  });

  it("isolates the account dock for either reason", () => {
    expect(atlasCinematicIsolationActive(true, false)).toBe(true);
    expect(atlasCinematicIsolationActive(false, true)).toBe(true);
  });

  it("keeps the dock isolated when playback ends inside focus mode", () => {
    expect(atlasCinematicIsolationActive(true, true)).toBe(true);
    expect(atlasCinematicIsolationActive(false, true)).toBe(true);
  });

  it("releases the dock only when neither owner holds the stage", () => {
    expect(atlasCinematicIsolationActive(false, false)).toBe(false);
  });

  // The browser lane grades the rendered geometry; Chromium resolves `right`
  // on a positioned element to a used length even when the rule says `auto`,
  // so "no right anchor on desktop" is asserted against the stylesheet itself.
  it("anchors the return control to the top-left safe area, with no right edge", () => {
    const css = readFileSync(new URL("../styles/living-atlas.css", import.meta.url), "utf8");
    // Anchor on the newline so this reads the control's own rule, not the
    // `.living-atlas > .living-atlas__globe-focus-exit` pointer-events rule.
    const start = css.indexOf("\n.living-atlas__globe-focus-exit {");
    const rule = css.slice(start, css.indexOf("}", start));

    expect(start).toBeGreaterThan(0);
    expect(rule).toContain("left: calc(env(safe-area-inset-left)");
    expect(rule).toContain("top: calc(env(safe-area-inset-top)");
    expect(rule).toContain("min-width: 44px;");
    expect(rule).toContain("min-height: 44px;");
    expect(rule).not.toMatch(/(^|\s)right:/);
  });
});

describe("ST-060 the Home Base suggestion card is quiet and non-modal", () => {
  it("renders beside the Atlas timeline without an overlay, a dialog role or a focus trap", () => {
    const source = readFileSync(new URL("./LivingAtlasApp.tsx", import.meta.url), "utf8");
    const card = source.slice(
      source.indexOf("living-atlas__home-base-suggestion motion-fade-through"),
      source.indexOf("{view === \"planet\" && journeys.length === 0"),
    );
    expect(card.length).toBeGreaterThan(0);
    expect(card).not.toContain("role=\"dialog\"");
    expect(card).not.toContain("aria-modal");
    expect(card).not.toContain("inert");
    expect(card).not.toContain("useModalFocus");
    // The condition is the decision's own, so a second call site cannot forget
    // the Story/Playback suppression.
    expect(source).toContain("homeBaseSuggestion?.visible");
    expect(source).toContain("narrativeSurfaceActive: storyJourneyId !== null || playbackActive");
  });

  it("keeps the same quiet suggestion reachable in compact mobile Atlas mode", () => {
    const source = readFileSync(new URL("./LivingAtlasApp.tsx", import.meta.url), "utf8");
    const css = readFileSync(new URL("../styles/living-atlas.css", import.meta.url), "utf8");
    expect(source).toContain('(isMobileV2 && view === "planet")');
    expect(source).toContain('data-home-base-surface={isMobileV2 ? "mobile-atlas" : "timeline"}');
    const mobileRule = css.slice(
      css.indexOf('.living-atlas[data-mobile-v2="on"] .living-atlas__home-base-suggestion {'),
      css.indexOf('.living-atlas[data-mobile-v2="on"] .living-atlas__home-base-suggestion h2'),
    );
    expect(mobileRule).toContain("bottom: calc(env(safe-area-inset-bottom) + 142px)");
    expect(mobileRule).toContain("left: 12px");
    expect(mobileRule).toContain("right: 12px");
    expect(mobileRule).not.toContain("position: fixed");
  });

  it("recomputes from the frozen inference core rather than holding its own thresholds", () => {
    const source = readFileSync(new URL("./LivingAtlasApp.tsx", import.meta.url), "utf8");
    const suggestionSource = readFileSync(new URL("./homeBaseSuggestion.ts", import.meta.url), "utf8");
    expect(source).toContain("homeBaseInferenceEvidenceBoundaryAfterRecordedHistory(");
    expect(source).toContain("inferHomeBaseCandidateWithDismissals({");
    expect(source).toContain("evaluationDate: homeEffectiveDate");
    expect(suggestionSource).toContain("const baseline = inferHomeBaseCandidate(input)");
    expect(suggestionSource).toContain("inferHomeBaseCandidate({ ...input, dismissal })");
    // No threshold literal is re-stated outside the frozen core.
    expect(source).not.toContain("HOME_BASE_SUGGESTED_MIN_JOURNEYS");
    expect(source).not.toContain("HOME_BASE_CLUSTER_RADIUS_KM");
    expect(suggestionSource).not.toContain("HOME_BASE_SUGGESTED_MIN_JOURNEYS");
  });

  it("persists the answer before taking the card down", () => {
    const source = readFileSync(new URL("./LivingAtlasApp.tsx", import.meta.url), "utf8");
    const dismiss = source.slice(source.indexOf("const dismissHomeBaseSuggestion"));
    expect(dismiss.indexOf("mutations.recordHomeBaseDismissal"))
      .toBeLessThan(dismiss.indexOf("setHomeBaseDismissals((current)"));
  });
});

describe("ST-060 the suggestion waits for every private read it depends on", () => {
  const ready = {
    periodsReader: true,
    periodsRead: true,
    dismissalReader: true,
    dismissalRead: true,
    journeyCount: 3,
  };

  it("computes nothing until the Home history read has landed", () => {
    expect(homeBaseInferenceInputsReady(ready)).toBe(true);
    // An unread history is indistinguishable from an empty one, and an empty
    // one makes a member who already confirmed a Home Base look like a
    // first-time candidate.
    expect(homeBaseInferenceInputsReady({ ...ready, periodsRead: false })).toBe(false);
  });

  it("computes nothing until the recorded dismissal has landed", () => {
    expect(homeBaseInferenceInputsReady({ ...ready, dismissalRead: false })).toBe(false);
    // Shared mode has no dismissal reader at all, so there is nothing to wait
    // for; the period reader alone decides.
    expect(homeBaseInferenceInputsReady({
      ...ready,
      dismissalReader: false,
      dismissalRead: false,
    })).toBe(true);
  });

  it("computes nothing without a Home history reader or without Journeys", () => {
    expect(homeBaseInferenceInputsReady({ ...ready, periodsReader: false })).toBe(false);
    expect(homeBaseInferenceInputsReady({ ...ready, journeyCount: 0 })).toBe(false);
  });
});

describe("ST-060 refresh readiness ownership", () => {
  it("re-arms both private reads before launching a refreshed Atlas load", () => {
    const source = readFileSync(new URL("./LivingAtlasApp.tsx", import.meta.url), "utf8");
    const start = source.indexOf("const load = useCallback(async (quiet = false");
    const block = source.slice(start, start + 1_600);
    const resetPeriods = block.indexOf("setHomeBasePeriodsRead(false)");
    const resetDismissal = block.indexOf("setHomeBaseDismissals(listHomeBaseDismissals ? undefined : [])");
    const launch = block.indexOf("loadJourneyRowsWithOptionalHome({");

    expect(start).toBeGreaterThan(0);
    expect(resetPeriods).toBeGreaterThan(0);
    expect(resetDismissal).toBeGreaterThan(0);
    expect(launch).toBeGreaterThan(resetPeriods);
    expect(launch).toBeGreaterThan(resetDismissal);
  });
});

describe("ST-060 a confirmed period closes the one it replaces locally", () => {
  const open: HomeBasePeriod = {
    id: "period-open",
    startedOn: "2024-01-01",
    endedOn: null,
    label: "杭州",
    latitude: 30.25,
    longitude: 120.17,
    source: "manual",
  };
  const confirmed: HomeBasePeriod = {
    id: "period-new",
    startedOn: "2026-03-01",
    endedOn: null,
    label: "上海",
    latitude: 31.23,
    longitude: 121.47,
    source: "suggested-confirmed",
  };

  it("closes the previous open period on the new period's own start day", () => {
    const merged = mergeConfirmedHomeBasePeriod([open], confirmed);
    expect(merged.filter((period) => period.endedOn === null)).toEqual([confirmed]);
    expect(merged.find((period) => period.id === "period-open")?.endedOn).toBe("2026-03-01");
  });

  it("keeps the replaced period rather than dropping its dates", () => {
    const merged = mergeConfirmedHomeBasePeriod([open], confirmed);
    expect(merged).toHaveLength(2);
    expect(merged.find((period) => period.id === "period-open")?.startedOn).toBe("2024-01-01");
  });

  it("leaves already-closed periods untouched and replaces its own row", () => {
    const closed: HomeBasePeriod = { ...open, id: "period-closed", endedOn: "2023-06-01" };
    const merged = mergeConfirmedHomeBasePeriod([closed, confirmed], {
      ...confirmed,
      label: "南京",
    });
    expect(merged.find((period) => period.id === "period-closed")?.endedOn).toBe("2023-06-01");
    expect(merged.filter((period) => period.id === "period-new")).toHaveLength(1);
    expect(merged.find((period) => period.id === "period-new")?.label).toBe("南京");
  });
});

describe("ST-060 a successful confirmation takes the card down on its own", () => {
  const SHENZHEN = { latitude: 22.5431, longitude: 114.0579 };
  const GUANGZHOU = { latitude: 23.1291, longitude: 113.2644 };
  const EVALUATION_DATE = "2026-06-01";

  function endpointJourney(id: string, startedOn: string, at = SHENZHEN) {
    return {
      id,
      startedOn,
      endedOn: startedOn,
      routePoints: [
        { id: `${id}-start`, sortOrder: 0, latitude: at.latitude, longitude: at.longitude },
        { id: `${id}-end`, sortOrder: 1, latitude: at.latitude, longitude: at.longitude },
      ],
    };
  }

  const journeys = [
    endpointJourney("j1", "2026-01-01"),
    endpointJourney("j2", "2026-02-01"),
    endpointJourney("j3", "2026-03-01"),
    endpointJourney("j4", "2026-04-01"),
  ];

  /**
   * The shell's own derivation, in one place: the open period out of the list
   * is what the core is told, and the core's answer is what the surface reads.
   * The proposition under test is the whole chain, not the list alone — a
   * merged list that still resolves to a visible card would leave the member
   * one click away from a duplicate write, which is exactly the review finding.
   */
  function cardFor(periods: readonly HomeBasePeriod[]) {
    const current = periods.find((period) => period.endedOn === null) ?? null;
    const result = inferHomeBaseCandidate({
      journeys,
      confirmedPeriod: current,
      evaluationDate: EVALUATION_DATE,
    });
    return {
      result,
      decision: resolveHomeBaseSuggestion({
        result,
        placeLabel: "深圳",
        confirmedPlaceLabel: current?.label ?? null,
      }),
    };
  }

  function periodFromConfirmation(id: string, periods: readonly HomeBasePeriod[]) {
    const { result, decision } = cardFor(periods);
    const draft = homeBaseConfirmationDraft(decision, result);
    expect(draft).not.toBeNull();
    return { id, ...draft } as HomeBasePeriod;
  }

  it("never offers a confirmation whose inferred period overlaps bounded Home history", () => {
    const result = inferHomeBaseCandidate({
      journeys,
      confirmedPeriod: null,
      evaluationDate: EVALUATION_DATE,
    });
    const decision = resolveHomeBaseSuggestion({ result, placeLabel: "深圳" });
    const historical: HomeBasePeriod = {
      id: "period-history",
      startedOn: "2025-01-01",
      endedOn: "2026-05-01",
      label: "深圳",
      latitude: SHENZHEN.latitude,
      longitude: SHENZHEN.longitude,
      source: "manual",
    };
    expect(decision.visible).toBe(true);
    expect(homeBaseSuggestionCanBeConfirmed({ decision, result, periods: [historical] })).toBe(false);
  });

  it("still offers a first confirmation when its inferred period starts after bounded history", () => {
    const result = inferHomeBaseCandidate({
      journeys,
      confirmedPeriod: null,
      evaluationDate: EVALUATION_DATE,
    });
    const decision = resolveHomeBaseSuggestion({ result, placeLabel: "深圳" });
    const historical: HomeBasePeriod = {
      id: "period-history",
      startedOn: "2024-01-01",
      endedOn: "2025-12-31",
      label: "广州",
      latitude: GUANGZHOU.latitude,
      longitude: GUANGZHOU.longitude,
      source: "manual",
    };
    expect(homeBaseSuggestionCanBeConfirmed({ decision, result, periods: [historical] })).toBe(true);
  });

  it("hides the first-time card once the returned period is merged in", () => {
    expect(cardFor([]).decision.visible).toBe(true);
    const confirmed = periodFromConfirmation("period-new", []);
    // Only the returned period is folded in; the best-effort history refresh
    // is allowed to fail without the card surviving it.
    const merged = mergeConfirmedHomeBasePeriod([], confirmed);
    expect(cardFor(merged).decision.visible).toBe(false);
    expect(cardFor(merged).decision.primaryAction).toBeNull();
  });

  it("hides the move card and keeps the period it replaced bounded", () => {
    const previous: HomeBasePeriod = {
      id: "period-open",
      startedOn: "2025-01-01",
      endedOn: null,
      label: "广州",
      latitude: GUANGZHOU.latitude,
      longitude: GUANGZHOU.longitude,
      source: "manual",
    };
    const before = cardFor([previous]).decision;
    expect(before.visible).toBe(true);
    expect(before.variant).toBe("move");

    const confirmed = periodFromConfirmation("period-moved", [previous]);
    const merged = mergeConfirmedHomeBasePeriod([previous], confirmed);
    expect(cardFor(merged).decision.visible).toBe(false);
    // #231 semantics locally: the replaced period survives with its own dates
    // rather than being overwritten.
    const replaced = merged.find((period) => period.id === "period-open");
    expect(replaced?.startedOn).toBe("2025-01-01");
    expect(replaced?.endedOn).toBe(confirmed.startedOn);
  });
});
