import { describe, expect, it } from "vitest";
import fixture from "../Fixtures/bridge.json";
import { buildJourneyTimeline, resolveJourneyTimelineSelection } from "../../../src/journey/globeTimeline";
import { GLOBE_IDLE_RESUME_DELAY_MS, getGlobeIdleRotationDelta } from "../../../src/scene/ParticleEarthScene";
import { acceptsSnapshot, decodeSnapshot, renderJourneys } from "./bridge";

describe("the same redacted fixture as Swift", () => {
  it("decodes stable IDs and preserves server point order", () => {
    const snapshot = decodeSnapshot(fixture.snapshot);
    expect(renderJourneys(snapshot)[0].routePoints.map((point) => point.id)).toEqual(["point-a", "point-b"]);
    expect(snapshot.selection?.assetId).toBeNull();
    expect(snapshot.journeys[0].media[0].routePointId).toBe("point-a");
  });
  it("scrubs the same fixture between actual Route Points, and leaves idle rotation to the renderer", () => {
    const journeys = renderJourneys(decodeSnapshot(fixture.snapshot));
    const { entries } = buildJourneyTimeline(journeys);
    expect(resolveJourneyTimelineSelection(entries, 0)?.pointIndex).toBe(0);
    expect(resolveJourneyTimelineSelection(entries, 1)?.pointIndex).toBe(1);
    expect(GLOBE_IDLE_RESUME_DELAY_MS).toBe(20_000);
    expect(getGlobeIdleRotationDelta(1 / 60, 19_999, false, false)).toBe(0);
    expect(getGlobeIdleRotationDelta(1 / 60, 20_001, false, false)).toBeGreaterThan(0);
    expect(getGlobeIdleRotationDelta(1 / 60, 20_001, true, false)).toBe(0);
  });
  it("drops late revisions and rebuilds a new process snapshot", () => {
    const snapshot = decodeSnapshot(fixture.snapshot);
    expect(acceptsSnapshot(snapshot, { ...snapshot, revision: snapshot.revision - 1 })).toBe(false);
    expect(acceptsSnapshot(null, snapshot)).toBe(true);
    expect(acceptsSnapshot(snapshot, { ...snapshot, scopeId: "guest-scope", revision: 0 })).toBe(true);
  });
  it("rejects invalid identity, revision, coordinates and cross-point media", () => {
    for (const mutate of [
      (value: typeof fixture.snapshot) => { value.version = 2; },
      (value: typeof fixture.snapshot) => { value.revision = -1; },
      (value: typeof fixture.snapshot) => { value.journeys[0].routePoints[0].latitude = 91; },
      (value: typeof fixture.snapshot) => { value.selection.journeyId = "other"; },
      (value: typeof fixture.snapshot) => { value.journeys[0].media[0].routePointId = "other"; },
      (value: typeof fixture.snapshot) => { value.selection.revision = 100; },
    ]) {
      const value = structuredClone(fixture.snapshot); mutate(value);
      expect(() => decodeSnapshot(value)).toThrow();
    }
  });
});
