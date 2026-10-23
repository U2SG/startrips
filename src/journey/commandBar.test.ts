import { describe, expect, it } from "vitest";
import {
  COMMAND_BAR_TIMEOUT_TEXT,
  commandBarExpiryLabel,
  commandBarFailure,
  commandBarLatencyStage,
  commandBarOfferedIntents,
  commandBarShareExpiry,
  commandBarShareJourneys,
  commandBarWaitCopy,
  type CommandSurfaceContext,
} from "./commandBar";
import type { CommandIntent } from "./journeyApi";
import { JourneyApiError } from "./journeyApi";
import { undoRouteOrder } from "./routeOrderIntent";
import type { RouteDraftPoint } from "./routeDraft";

const ROUTED: CommandIntent[] = [
  "create-journey",
  "share",
  "share-photos-filter",
  "route-order",
  "navigate",
  "globe-focus",
];

const ATLAS: CommandSurfaceContext = {
  surface: "atlas",
  canCreateJourney: true,
  canShare: true,
  journeyCount: 3,
  composerPointCount: 0,
};

describe("commandBarOfferedIntents", () => {
  it("offers everything but the reorder on the Atlas", () => {
    expect(commandBarOfferedIntents(ROUTED, ATLAS))
      .toEqual(["create-journey", "share", "share-photos-filter", "navigate", "globe-focus"]);
  });

  it("offers only what the server routes", () => {
    expect(commandBarOfferedIntents(["share", "globe-focus"], ATLAS)).toEqual(["share", "globe-focus"]);
  });

  it("drops what the member cannot do or has nothing to act on", () => {
    expect(commandBarOfferedIntents(ROUTED, { ...ATLAS, canCreateJourney: false, canShare: false }))
      .toEqual(["navigate", "globe-focus"]);
    expect(commandBarOfferedIntents(ROUTED, { ...ATLAS, journeyCount: 0 }))
      .toEqual(["create-journey", "globe-focus"]);
  });

  it("offers only the reorder in the Composer, and only for 2 to 64 Route Points", () => {
    const composer = { ...ATLAS, surface: "composer" as const };
    expect(commandBarOfferedIntents(ROUTED, { ...composer, composerPointCount: 2 })).toEqual(["route-order"]);
    expect(commandBarOfferedIntents(ROUTED, { ...composer, composerPointCount: 1 })).toEqual([]);
    expect(commandBarOfferedIntents(ROUTED, { ...composer, composerPointCount: 65 })).toEqual([]);
  });

  it("offers only sharing over the share dialog", () => {
    expect(commandBarOfferedIntents(ROUTED, { ...ATLAS, surface: "share" }))
      .toEqual(["share", "share-photos-filter"]);
  });
});

describe("command bar latency", () => {
  it("stays quiet under 300ms, cues until 2s, then stages", () => {
    expect(commandBarLatencyStage(0)).toBe("quiet");
    expect(commandBarLatencyStage(299)).toBe("quiet");
    expect(commandBarLatencyStage(300)).toBe("cue");
    expect(commandBarLatencyStage(1_999)).toBe("cue");
    expect(commandBarLatencyStage(2_000)).toBe("staged");
    expect(commandBarWaitCopy(100)).toBeNull();
    expect(commandBarWaitCopy(500)).toBe("正在理解…");
    expect(commandBarWaitCopy(3_000)).not.toBe("正在理解…");
    expect(commandBarWaitCopy(40_000)).toContain("手动");
  });
});

describe("commandBarFailure", () => {
  it("hides the bar on 503 and names the busy and provider failures in Chinese", () => {
    expect(commandBarFailure(new JourneyApiError(503, "INTENT_UNAVAILABLE", "x")).refetchCapabilities).toBe(true);
    expect(commandBarFailure(new JourneyApiError(409, "INTENT_ROUTE_BUSY", "x")))
      .toEqual({ text: "正在处理上一张，请稍候再试。", refetchCapabilities: false });
    for (const status of [502, 504]) {
      const failure = commandBarFailure(new JourneyApiError(status, "INTENT_FAILED", "The intent router answered 500"));
      expect(failure.refetchCapabilities).toBe(false);
      expect(failure.text).not.toContain("intent");
      expect(failure.text).toContain("「");
    }
    expect(COMMAND_BAR_TIMEOUT_TEXT).toContain("「");
  });
});

describe("share proposals on the card", () => {
  const journeys = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("narrows to the listed Journeys in list order", () => {
    expect(commandBarShareJourneys({ journeyIds: ["c", "x", "a", "a"] }, journeys))
      .toEqual([{ id: "a" }, { id: "c" }]);
  });

  it("defaults the expiry to 7 days and labels it as the dialog does", () => {
    expect(commandBarShareExpiry({ expiry: null })).toBe("7d");
    expect(commandBarExpiryLabel("30d")).toBe("有效期 30 天");
  });
});

describe("undoRouteOrder", () => {
  const point = (draftId: string): RouteDraftPoint => ({
    draftId, latitude: 30, longitude: 100, label: draftId, isStop: true, occurredAt: null,
  });
  const [a, b, c] = [point("a"), point("b"), point("c")];

  it("restores the previous order while the applied order still stands", () => {
    expect(undoRouteOrder([c, a, b], ["c", "a", "b"], ["a", "b", "c"])?.map((p) => p.draftId))
      .toEqual(["a", "b", "c"]);
  });

  it("is void once the draft changed after applying", () => {
    expect(undoRouteOrder([a, c, b], ["c", "a", "b"], ["a", "b", "c"])).toBeNull();
    expect(undoRouteOrder([c, a], ["c", "a", "b"], ["a", "b", "c"])).toBeNull();
  });
});
