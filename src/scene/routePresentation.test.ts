import { describe, expect, it } from "vitest";
import {
  narrativeCurrentRoutePointIndex,
  resolveRouteAttentionRole,
  resolveRoutePointPresentation,
  routePointIsSelected,
  routePointMarkerRadiusPx,
  routePointTemporalProgress,
} from "./routePresentation";

const reveal = {
  journeys: new Map([["journey-a", 0.45], ["journey-b", 1]]),
  points: new Map([
    ["journey-a:0", 1],
    ["journey-a:1", 1],
    ["journey-a:2", 0.4],
    ["journey-a:3", 0],
    ["journey-b:0", 1],
  ]),
};

describe("route presentation roles (#373)", () => {
  it("keeps Stop semantics independent from selection and narrative attention", () => {
    expect(resolveRoutePointPresentation({
      routeId: "journey-a",
      routePointId: "a-1",
      pointIndex: 1,
      pointCount: 4,
      isStop: false,
      selection: { journeyId: "journey-a", routePointId: "a-1", pointIndex: 1 },
      temporalReveal: reveal,
    })).toEqual({
      semanticRole: "passthrough",
      attentionRole: "selected",
      temporalVisible: true,
      temporalProgress: 1,
    });

    expect(resolveRoutePointPresentation({
      routeId: "journey-a",
      routePointId: "a-2",
      pointIndex: 2,
      pointCount: 4,
      isStop: true,
      selection: { journeyId: "journey-a", routePointId: "a-1", pointIndex: 1 },
      temporalReveal: reveal,
    })).toEqual({
      semanticRole: "stop",
      attentionRole: "narrative-current",
      temporalVisible: true,
      temporalProgress: 0.4,
    });
  });

  it("derives narrative current only while the existing Journey reveal is in flight", () => {
    expect(narrativeCurrentRoutePointIndex("journey-a", 4, reveal)).toBe(2);
    expect(narrativeCurrentRoutePointIndex("journey-b", 1, reveal)).toBeNull();
    expect(narrativeCurrentRoutePointIndex("journey-a", 4, undefined)).toBeNull();
  });

  it("keeps future points absent and fully visited points ordinary", () => {
    expect(routePointTemporalProgress("journey-a", 3, reveal)).toBe(0);
    expect(resolveRoutePointPresentation({
      routeId: "journey-a",
      routePointId: "future",
      pointIndex: 3,
      pointCount: 4,
      isStop: false,
      selection: null,
      temporalReveal: reveal,
    })).toMatchObject({ temporalVisible: false, attentionRole: "ordinary" });
    expect(resolveRouteAttentionRole({
      routeId: "journey-b",
      selectedRouteId: null,
      temporalReveal: reveal,
    })).toBe("ordinary");
  });

  it("selects by Route Point identity before index and never crosses Journey scope", () => {
    const selection = { journeyId: "journey-a", routePointId: "shared-id", pointIndex: 7 };
    expect(routePointIsSelected({ routeId: "journey-a", routePointId: "shared-id", pointIndex: 2, selection })).toBe(true);
    expect(routePointIsSelected({ routeId: "journey-a", routePointId: "other", pointIndex: 7, selection })).toBe(false);
    expect(routePointIsSelected({ routeId: "journey-b", routePointId: "shared-id", pointIndex: 7, selection })).toBe(false);
  });

  it("keeps marker optical radius bounded in CSS-pixel space", () => {
    expect(routePointMarkerRadiusPx({
      semanticRole: "passthrough",
      attentionRole: "ordinary",
      temporalVisible: true,
      temporalProgress: 1,
    })).toBe(2.1);
    expect(routePointMarkerRadiusPx({
      semanticRole: "stop",
      attentionRole: "ordinary",
      temporalVisible: true,
      temporalProgress: 1,
    })).toBe(2.55);
    expect(routePointMarkerRadiusPx({
      semanticRole: "stop",
      attentionRole: "selected",
      temporalVisible: true,
      temporalProgress: 1,
    })).toBe(3);
    expect(routePointMarkerRadiusPx({
      semanticRole: "passthrough",
      attentionRole: "narrative-current",
      temporalVisible: true,
      temporalProgress: 0.4,
    })).toBe(3.2);
  });
  it("lets narrative current outrank browse selection without mutating either authority", () => {
    expect(resolveRouteAttentionRole({
      routeId: "journey-a",
      selectedRouteId: "journey-a",
      temporalReveal: reveal,
    })).toBe("narrative-current");
    expect(resolveRouteAttentionRole({
      routeId: "journey-b",
      selectedRouteId: "journey-b",
      temporalReveal: reveal,
    })).toBe("selected");
  });
});