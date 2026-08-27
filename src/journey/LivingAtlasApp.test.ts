import { describe, expect, it, vi } from "vitest";

// The full app module pulls in the better-auth client, which needs a browser
// runtime; mock the auth capability hook so the pure focus-state helper can
// be imported in the node test environment.
vi.mock("../auth/AuthGateway", () => ({
  useAtlasCapabilities: () => ({ canDeleteJourney: false }),
}));

import { readFileSync } from "node:fs";
import {
  globeFocusState,
  nextPlaybackCameraCommand,
  playbackEntryNeedsPreparation,
  playbackFocusPointForCameraTarget,
  playbackFocusRouteForCameraTarget,
} from "./LivingAtlasApp";
import { playbackMediaGate } from "./JourneyPlaybackOverlay";
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
  });

  it("increments a camera command revision even for the same route target", () => {
    const first = nextPlaybackCameraCommand(null, { kind: "route" });
    const second = nextPlaybackCameraCommand(first, { kind: "route" });
    expect(first).toEqual({ target: { kind: "route" }, revision: 1 });
    expect(second).toEqual({ target: { kind: "route" }, revision: 2 });
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
    const ready = { status: "ready" as const, url: "signed-image" };
    expect(playbackMediaGate(ready, { status: "error", message: "decode failed" }, true))
      .toBe("error");
    expect(playbackMediaGate(ready, { status: "decoded" }, true)).toBe("ready");
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
