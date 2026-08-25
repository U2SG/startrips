import { describe, expect, it, vi } from "vitest";

// The full app module pulls in the better-auth client, which needs a browser
// runtime; mock the auth capability hook so the pure focus-state helper can
// be imported in the node test environment.
vi.mock("../auth/AuthGateway", () => ({
  useAtlasCapabilities: () => ({ canDeleteJourney: false }),
}));

import { readFileSync } from "node:fs";
import { globeFocusState, playbackEntryNeedsPreparation } from "./LivingAtlasApp";
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
  });
});
