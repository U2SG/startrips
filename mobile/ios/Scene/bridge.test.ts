import { describe, expect, it } from "vitest";
import fixture from "../Fixtures/bridge.json";
import { acceptsSnapshot, CAMERA_RESUME_MS, decodeSnapshot, renderJourneys } from "./bridge";

describe("the same redacted fixture as Swift", () => {
  it("decodes stable IDs and preserves server point order", () => {
    const snapshot = decodeSnapshot(fixture.snapshot);
    expect(renderJourneys(snapshot)[0].routePoints.map((point) => point.id)).toEqual(["point-a", "point-b"]);
    expect(snapshot.selection?.assetId).toBeNull();
    expect(snapshot.journeys[0].media[0].routePointId).toBe("point-a");
    expect(CAMERA_RESUME_MS).toBe(20_000);
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
