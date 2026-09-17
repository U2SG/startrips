import { describe, expect, it } from "vitest";
import {
  resolveRouteAttentionRole,
  resolveRoutePointPresentation,
  routePointIsNarrativeCurrent,
  routePointIsSelected,
  routePointMarkerRadiusPx,
  routePointTemporalProgress,
} from "./routePresentation";

const reveal = {
  journeys: new Map([["journey-a", 0.45], ["journey-b", 0.35]]),
  points: new Map([
    ["journey-a:0", 1],
    ["journey-a:1", 1],
    ["journey-a:2", 0.4],
    ["journey-a:3", 0],
    ["journey-b:0", 0.5],
  ]),
};

describe("route presentation roles (#373)", () => {
  it("keeps Stop semantics independent from selection and narrative attention", () => {
    const narrativeSelection = { journeyId: "journey-a", routePointId: "a-2", pointIndex: 2 };
    expect(resolveRoutePointPresentation({
      routeId: "journey-a",
      routePointId: "a-1",
      pointIndex: 1,
      isStop: false,
      selection: { journeyId: "journey-a", routePointId: "a-1", pointIndex: 1 },
      narrativeSelection,
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
      isStop: true,
      selection: { journeyId: "journey-a", routePointId: "a-1", pointIndex: 1 },
      narrativeSelection,
      temporalReveal: reveal,
    })).toEqual({
      semanticRole: "stop",
      attentionRole: "narrative-current",
      temporalVisible: true,
      temporalProgress: 0.4,
    });
  });

  it("uses the cursor-owned narrative point instead of reconstructing current from route index", () => {
    const narrativeSelection = { journeyId: "journey-a", routePointId: "a-0", pointIndex: 0 };
    expect(routePointIsNarrativeCurrent({
      routeId: "journey-a",
      routePointId: "a-0",
      pointIndex: 0,
      narrativeSelection,
    })).toBe(true);
    expect(routePointIsNarrativeCurrent({
      routeId: "journey-a",
      routePointId: "a-2",
      pointIndex: 2,
      narrativeSelection,
    })).toBe(false);
  });

  it("keeps future points absent even if an inconsistent narrative selection names them", () => {
    expect(routePointTemporalProgress("journey-a", 3, reveal)).toBe(0);
    expect(resolveRoutePointPresentation({
      routeId: "journey-a",
      routePointId: "future",
      pointIndex: 3,
      isStop: false,
      selection: null,
      narrativeSelection: { journeyId: "journey-a", routePointId: "future", pointIndex: 3 },
      temporalReveal: reveal,
    })).toMatchObject({ temporalVisible: false, attentionRole: "ordinary" });
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

  it("lets the one cursor-owned Journey outrank browse selection even when reveal ranges overlap", () => {
    expect(resolveRouteAttentionRole({
      routeId: "journey-a",
      selectedRouteId: "journey-a",
      narrativeRouteId: "journey-b",
    })).toBe("selected");
    expect(resolveRouteAttentionRole({
      routeId: "journey-b",
      selectedRouteId: "journey-a",
      narrativeRouteId: "journey-b",
    })).toBe("narrative-current");
    expect(resolveRouteAttentionRole({
      routeId: "journey-c",
      selectedRouteId: "journey-a",
      narrativeRouteId: "journey-b",
    })).toBe("ordinary");
  });
});
