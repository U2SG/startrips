import { describe, expect, it } from "vitest";
import {
  arbitrateRouteLabels,
  compareRouteLabelCandidates,
  isCoincidentLabelAnchor,
  isPlaceLabelRedundant,
  isRouteLabelEligible,
  normalizeLabelIdentity,
  PLACE_LABEL_VICINITY_PX,
  routeLabelAttentionPriority,
  routeLabelPositionRole,
  selectEvictableRouteLabel,
  type RouteLabelCandidate,
  type RouteLabelPositionRole,
} from "./labelArbitration";
import { resolveRoutePointPresentation } from "./routePresentation";

const journeyId = "journey-southwest";

function candidate({
  pointIndex,
  pointCount = 6,
  isStop = true,
  selection = null,
  narrativeSelection = null,
  temporalReveal,
  positionRole,
}: {
  pointIndex: number;
  pointCount?: number;
  isStop?: boolean;
  selection?: { journeyId: string; pointIndex: number } | null;
  narrativeSelection?: { journeyId: string; pointIndex: number } | null;
  temporalReveal?: { journeys: Map<string, number>; points: Map<string, number> };
  positionRole?: RouteLabelPositionRole;
}): RouteLabelCandidate {
  return {
    pointIndex,
    positionRole: positionRole ?? routeLabelPositionRole(pointIndex, pointCount),
    presentation: resolveRoutePointPresentation({
      routeId: journeyId,
      routePointId: `point-${pointIndex}`,
      pointIndex,
      isStop,
      selection,
      narrativeSelection,
      temporalReveal,
    }),
  };
}

describe("route label arbitration (#374)", () => {
  it("ranks the narrative current point above the chosen record and both above endpoints", () => {
    const narrativeCurrent = candidate({
      pointIndex: 2,
      narrativeSelection: { journeyId, pointIndex: 2 },
    });
    const selected = candidate({
      pointIndex: 3,
      isStop: false,
      selection: { journeyId, pointIndex: 3 },
    });
    const origin = candidate({ pointIndex: 0 });
    const destination = candidate({ pointIndex: 5 });
    const intermediateStop = candidate({ pointIndex: 1 });
    const intermediatePassthrough = candidate({ pointIndex: 4, isStop: false });

    expect(routeLabelAttentionPriority(narrativeCurrent)).toBe(4);
    expect(routeLabelAttentionPriority(selected)).toBe(3);
    expect(routeLabelAttentionPriority(origin)).toBe(2);
    expect(routeLabelAttentionPriority(destination)).toBe(2);
    expect(routeLabelAttentionPriority(intermediateStop)).toBe(1);
    expect(routeLabelAttentionPriority(intermediatePassthrough)).toBe(0);

    // An optional endpoint label never outranks the current point.
    expect(compareRouteLabelCandidates(origin, narrativeCurrent)).toBeGreaterThan(0);
    expect(arbitrateRouteLabels(
      [origin, destination, intermediateStop, selected, narrativeCurrent],
      { compactMobileLayout: false },
    )).toEqual([2, 3, 0, 5, 1]);
  });

  it("orders identical input identically, so a still globe cannot flicker", () => {
    const candidates = [4, 1, 5, 0, 2].map((pointIndex) => candidate({ pointIndex }));
    const first = arbitrateRouteLabels(candidates, { compactMobileLayout: false });
    const second = arbitrateRouteLabels([...candidates].reverse(), { compactMobileLayout: false });
    expect(first).toEqual([0, 5, 1, 2, 4]);
    expect(second).toEqual(first);
  });

  it("keeps intermediate context optional and makes the compact posture stricter", () => {
    const intermediateStop = candidate({ pointIndex: 2 });
    const intermediatePassthrough = candidate({ pointIndex: 3, isStop: false });
    const destination = candidate({ pointIndex: 5 });
    const current = candidate({
      pointIndex: 2,
      narrativeSelection: { journeyId, pointIndex: 2 },
    });

    expect(isRouteLabelEligible(intermediateStop, { compactMobileLayout: false })).toBe(true);
    expect(isRouteLabelEligible(intermediatePassthrough, { compactMobileLayout: false })).toBe(false);
    expect(isRouteLabelEligible(intermediateStop, { compactMobileLayout: true })).toBe(false);
    // The attended point and the route's endpoints survive the stricter density.
    expect(isRouteLabelEligible(current, { compactMobileLayout: true })).toBe(true);
    expect(isRouteLabelEligible(destination, { compactMobileLayout: true })).toBe(true);
  });

  it("never reveals a label the Rewind has not reached, even for the chosen record", () => {
    const temporalReveal = {
      journeys: new Map([[journeyId, 0.3]]),
      points: new Map([
        [`${journeyId}:0`, 1],
        [`${journeyId}:1`, 0.4],
        [`${journeyId}:2`, 0],
        [`${journeyId}:5`, 0],
      ]),
    };
    const revealed = candidate({ pointIndex: 1, temporalReveal });
    const future = candidate({
      pointIndex: 2,
      temporalReveal,
      selection: { journeyId, pointIndex: 2 },
    });
    const futureDestination = candidate({ pointIndex: 5, temporalReveal });

    expect(isRouteLabelEligible(revealed, { compactMobileLayout: false })).toBe(true);
    expect(isRouteLabelEligible(future, { compactMobileLayout: false })).toBe(false);
    expect(isRouteLabelEligible(futureDestination, { compactMobileLayout: false })).toBe(false);
    expect(arbitrateRouteLabels(
      [revealed, future, futureDestination],
      { compactMobileLayout: false },
    )).toEqual([1]);
  });

  it("keeps two Route Points that share a label but not a coordinate separate", () => {
    const first = candidate({ pointIndex: 0 });
    const second = candidate({ pointIndex: 5 });
    expect(arbitrateRouteLabels([first, second], { compactMobileLayout: false }))
      .toEqual([0, 5]);
    // Same name, different projected anchors: both keep their own turn.
    expect(isCoincidentLabelAnchor({ x: 220, y: 140 }, { x: 640, y: 410 })).toBe(false);
  });

  it("recycles the last ordinary label slot for an attended point, never an attended one", () => {
    // A Journey with more labeled Stops than the pool holds: every slot is
    // filled with ordinary candidates before anything is chosen.
    const ordinaryPool = [0, 1, 2, 3, 4].map((pointIndex) => ({
      pointIndex,
      attentionRole: "ordinary" as const,
    }));
    expect(selectEvictableRouteLabel(ordinaryPool)).toBe(4);

    // The chosen record and the narrative current point keep their slots; the
    // highest-index ordinary one gives way.
    expect(selectEvictableRouteLabel([
      { pointIndex: 0, attentionRole: "ordinary" },
      { pointIndex: 7, attentionRole: "selected" },
      { pointIndex: 3, attentionRole: "ordinary" },
      { pointIndex: 9, attentionRole: "narrative-current" },
    ])).toBe(3);

    // Deterministic: input order never changes the victim.
    expect(selectEvictableRouteLabel([...ordinaryPool].reverse())).toBe(4);

    // Nothing to recycle rather than evicting an attended label.
    expect(selectEvictableRouteLabel([
      { pointIndex: 2, attentionRole: "selected" },
      { pointIndex: 6, attentionRole: "narrative-current" },
    ])).toBeNull();
    expect(selectEvictableRouteLabel([])).toBeNull();
  });

  it("treats only a shared projected anchor as coincident", () => {
    expect(isCoincidentLabelAnchor({ x: 320.2, y: 210.4 }, { x: 320.5, y: 210.9 })).toBe(true);
    expect(isCoincidentLabelAnchor({ x: 320, y: 210 }, { x: 322, y: 210 })).toBe(false);
  });
});

describe("place label arbitration (#374)", () => {
  it("compares label identity across case, diacritics and punctuation", () => {
    expect(normalizeLabelIdentity("Los Angeles")).toBe("losangeles");
    expect(normalizeLabelIdentity("  los-angeles ")).toBe("losangeles");
    expect(normalizeLabelIdentity("Zürich")).toBe(normalizeLabelIdentity("Zurich"));
    expect(normalizeLabelIdentity("洛杉矶")).toBe("洛杉矶");
    expect(normalizeLabelIdentity("  -- ")).toBe("");
  });

  it("suppresses a nearby equivalent place label and keeps the Route Point label", () => {
    const placedRouteLabels = [
      { identity: normalizeLabelIdentity("Los Angeles"), anchor: { x: 500, y: 300 } },
    ];
    expect(isPlaceLabelRedundant({
      names: ["Los Angeles", null],
      anchor: { x: 512, y: 308 },
      placedRouteLabels,
    })).toBe(true);
    expect(isPlaceLabelRedundant({
      names: ["Los Angeles", "洛杉矶"],
      anchor: { x: 500 + PLACE_LABEL_VICINITY_PX + 1, y: 300 },
      placedRouteLabels,
    })).toBe(false);
  });

  it("never deduplicates by name alone or by vicinity alone", () => {
    const placedRouteLabels = [
      { identity: normalizeLabelIdentity("Los Angeles"), anchor: { x: 500, y: 300 } },
    ];
    // Same name on the other side of the viewport: a different place keeps its label.
    expect(isPlaceLabelRedundant({
      names: ["Los Angeles"],
      anchor: { x: 1180, y: 660 },
      placedRouteLabels,
    })).toBe(false);
    // A different place in the same vicinity keeps its label.
    expect(isPlaceLabelRedundant({
      names: ["Long Beach"],
      anchor: { x: 506, y: 304 },
      placedRouteLabels,
    })).toBe(false);
    // A Route Point with no readable label suppresses nothing.
    expect(isPlaceLabelRedundant({
      names: ["Los Angeles"],
      anchor: { x: 500, y: 300 },
      placedRouteLabels: [{ identity: "", anchor: { x: 500, y: 300 } }],
    })).toBe(false);
    expect(isPlaceLabelRedundant({
      names: [null, undefined, ""],
      anchor: { x: 500, y: 300 },
      placedRouteLabels,
    })).toBe(false);
  });

  it("matches the localized place name as well as the dataset name", () => {
    const placedRouteLabels = [
      { identity: normalizeLabelIdentity("洛杉矶"), anchor: { x: 500, y: 300 } },
    ];
    expect(isPlaceLabelRedundant({
      names: ["Los Angeles", "洛杉矶"],
      anchor: { x: 520, y: 312 },
      placedRouteLabels,
    })).toBe(true);
  });
});
