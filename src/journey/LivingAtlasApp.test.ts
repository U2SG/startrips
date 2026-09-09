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
  capturePlaybackEntryForContext,
  globeFocusState,
  loadJourneyRowsWithOptionalHome,
  nextPlaybackCameraCommand,
  nextPlaybackReleaseFocusRevision,
  playbackEntryNeedsPreparation,
  playbackCameraUsesPointFocus,
  playbackFocusPointForCameraTarget,
  playbackFocusRouteForCameraTarget,
  nextAtlasNotice,
  pendingPlaybackStoryRestore,
  railContentSignature,
  releaseStalePlaybackSession,
  resolvePlaybackOwnership,
  resolveMobilePlaybackPresentation,
  showsGlobeModeChrome,
} from "./LivingAtlasApp";
import { playbackHoldReason, playbackMediaGate } from "./JourneyPlaybackOverlay";
import { resolvePlaybackReturn } from "./playbackReturn";
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
    await Promise.resolve();
    expect(onHomeBasePeriods).toHaveBeenCalledWith([]);
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

describe("rewind route CSS (PR #24 review)", () => {
  it("places the temporal-reveal override after strands active/muted opacity rules", () => {
    const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");
    const lastStyleOpacityRule = css.lastIndexOf(
      ".particle-earth-route.is-style-strands.is-muted .particle-earth-route__strand-b",
    );
    const rewindOverride = css.lastIndexOf(
      ".particle-earth-route.is-style-strands[data-temporal-reveal] .particle-earth-route__glow",
    );
    expect(lastStyleOpacityRule).toBeGreaterThanOrEqual(0);
    expect(rewindOverride).toBeGreaterThan(lastStyleOpacityRule);
    expect(css.slice(rewindOverride)).toContain(
      ".particle-earth-route.is-style-strands[data-temporal-reveal] .particle-earth-route__flow",
    );
    expect(css.slice(rewindOverride)).toContain("opacity: 0;");
    const focusFlightLocator = css.indexOf(
      '.particle-earth-scene[data-route-focus-phase="flying"]',
    );
    const focusFlightBlock = css.slice(focusFlightLocator, rewindOverride);
    expect(focusFlightBlock).toContain(":not([data-temporal-reveal])");
  });
});

describe("route focus-flight choreography", () => {
  it("holds the active route draw while the camera is flying", () => {
    const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");
    const drawRule = css.indexOf(
      ".particle-earth-route.is-style-strands.is-active .particle-earth-route__core,",
    );
    const flyingRule = css.indexOf(
      '.particle-earth-scene[data-route-focus-phase="flying"]',
      drawRule,
    );
    expect(drawRule).toBeGreaterThanOrEqual(0);
    expect(flyingRule).toBeGreaterThan(drawRule);
    const flyingBlock = css.slice(flyingRule, css.indexOf("@keyframes motionRouteDraw", flyingRule));
    expect(flyingBlock).toContain(
      ".particle-earth-route.is-style-strands.is-active:not([data-temporal-reveal])",
    );
    expect(flyingBlock).toContain("animation: none;");
    expect(flyingBlock).toContain("stroke-dashoffset: 1200;");
    expect(flyingBlock).toContain("animation-play-state: paused;");
    expect(flyingBlock).toContain("opacity: 0;");
  });

  it("lets reduced motion reveal the final route immediately", () => {
    const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");
    const flyingRule = css.indexOf(
      '.particle-earth-scene[data-route-focus-phase="flying"]',
    );
    const reducedMotion = css.indexOf("@media (prefers-reduced-motion: reduce)", flyingRule);
    expect(reducedMotion).toBeGreaterThan(flyingRule);
    const reducedBlock = css.slice(reducedMotion, css.indexOf("}", reducedMotion) + 1);
    expect(reducedBlock).toContain("animation: none;");
    expect(reducedBlock).toContain("stroke-dashoffset: 0;");
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

// #253: globe focus mode is the wrong place for the permanent `深入真实地图 /
// REGION MAP` product-model control, and for the account dock. Both answers
// come from one expression each, so a future mode cannot half-apply them.
describe("globe focus-mode chrome ownership (#253)", () => {
  it("renders the globe mode chrome in ordinary desktop Atlas", () => {
    expect(showsGlobeModeChrome(false, false)).toBe(true);
  });

  it("withholds it in globe focus mode, so no node and no layout slot exist", () => {
    expect(showsGlobeModeChrome(false, true)).toBe(false);
  });

  it("keeps compact mobile without it, focus mode or not", () => {
    expect(showsGlobeModeChrome(true, false)).toBe(false);
    expect(showsGlobeModeChrome(true, true)).toBe(false);
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
