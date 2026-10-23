import { describe, expect, it } from "vitest";
import type { RouteDraftPoint } from "./routeDraft";
import {
  applyRouteOrder,
  routeOrderConsequences,
  routeOrderErrorMessage,
  routeOrderIntentPoints,
  routeOrderPreviewRows,
  sameRouteDraftOrder,
  sameRouteOrderBasis,
} from "./routeOrderIntent";
import type { JourneyInput } from "./types";

function point(draftId: string, label: string, patch: Partial<RouteDraftPoint> = {}): RouteDraftPoint {
  return { draftId, latitude: 30, longitude: 100, label, isStop: true, occurredAt: null, ...patch };
}

const CHENGDU = point("a", "成都");
const LITANG = point("b", "理塘");
const DAOCHENG = point("c", "稻城");
const POINTS = [CHENGDU, LITANG, DAOCHENG];

const INPUT: JourneyInput = {
  title: "川西小环线",
  startedOn: "2026-09-01",
  endedOn: null,
  note: "",
  lightColor: "#f4ce73",
  routePoints: [],
};

describe("route order request points", () => {
  it("sends only the draft id and the trimmed label, cut at 80 characters", () => {
    const long = point("d", ` ${"长".repeat(90)} `, { note: "private", occurredAt: "2026-09-01T00:00:00.000Z" });
    expect(routeOrderIntentPoints([CHENGDU, long])).toEqual([
      { id: "a", label: "成都" },
      { id: "d", label: "长".repeat(80) },
    ]);
  });

  it("matches a basis only while ids, order and sent labels are unchanged", () => {
    const basis = routeOrderIntentPoints(POINTS);
    expect(sameRouteOrderBasis(POINTS, basis)).toBe(true);
    expect(sameRouteOrderBasis([point("a", " 成都 "), LITANG, DAOCHENG], basis)).toBe(true);
    expect(sameRouteOrderBasis([CHENGDU, point("b", "新都桥"), DAOCHENG], basis)).toBe(false);
    expect(sameRouteOrderBasis([CHENGDU, DAOCHENG, LITANG], basis)).toBe(false);
    expect(sameRouteOrderBasis([CHENGDU, LITANG], basis)).toBe(false);
  });
});

describe("applyRouteOrder", () => {
  it("reorders whole points", () => {
    expect(applyRouteOrder(POINTS, ["c", "b", "a"])).toEqual([DAOCHENG, LITANG, CHENGDU]);
  });

  it.each([
    ["a duplicate", ["a", "a", "c"]],
    ["an unknown id", ["a", "b", "x"]],
    ["a missing id", ["a", "b"]],
    ["an extra id", ["a", "b", "c", "c"]],
  ])("refuses an order with %s", (_label, order) => {
    expect(applyRouteOrder(POINTS, order)).toBeNull();
  });

  it("compares draft orders exactly", () => {
    expect(sameRouteDraftOrder(POINTS, ["a", "b", "c"])).toBe(true);
    expect(sameRouteDraftOrder(POINTS, ["a", "c", "b"])).toBe(false);
    expect(sameRouteDraftOrder(POINTS, ["a", "b"])).toBe(false);
  });
});

describe("routeOrderPreviewRows", () => {
  it("marks moved points with their old and new positions", () => {
    expect(routeOrderPreviewRows(POINTS, ["a", "c", "b"])).toEqual([
      { draftId: "a", label: "成都", from: 1, to: 1, moved: false },
      { draftId: "c", label: "稻城", from: 3, to: 2, moved: true },
      { draftId: "b", label: "理塘", from: 2, to: 3, moved: true },
    ]);
  });

  it("names an unnamed point by its current position", () => {
    const rows = routeOrderPreviewRows([CHENGDU, point("u", "  ")], ["u", "a"]);
    expect(rows?.[0]).toMatchObject({ label: "途径点 2", from: 2, to: 1 });
  });

  it("answers null for a non-permutation", () => {
    expect(routeOrderPreviewRows(POINTS, ["a", "a", "b"])).toBeNull();
  });
});

describe("routeOrderConsequences", () => {
  it("says nothing for a reorder that breaks nothing", () => {
    expect(routeOrderConsequences(INPUT, POINTS, [DAOCHENG, LITANG, CHENGDU])).toEqual([]);
  });

  it("warns when Route Point times would go backwards", () => {
    const timed = [
      point("a", "成都", { occurredAt: "2026-09-01T08:00:00.000Z" }),
      point("b", "理塘", { occurredAt: "2026-09-02T08:00:00.000Z" }),
    ];
    const notes = routeOrderConsequences(INPUT, timed, [timed[1], timed[0]]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("时间会倒退");
  });

  it("does not repeat a time problem the draft already had", () => {
    const backwards = [
      point("a", "成都", { occurredAt: "2026-09-03T08:00:00.000Z" }),
      point("b", "理塘", { occurredAt: "2026-09-02T08:00:00.000Z" }),
      point("c", "稻城"),
    ];
    expect(routeOrderConsequences(INPUT, backwards, [backwards[0], backwards[2], backwards[1]])).toEqual([]);
  });

  it("names a stay whose Stop would no longer be adjacent", () => {
    const stop = point("s", "理塘", { id: "11111111-1111-4111-8111-111111111111" });
    const stay = point("v", "毛垭草原", { isStop: false, stayAnchorRoutePointId: stop.id });
    const other = point("o", "稻城");
    const current = [stop, stay, other];
    const notes = routeOrderConsequences(INPUT, current, [stay, other, stop]);
    expect(notes).toEqual([expect.stringContaining("「毛垭草原」")]);
  });
});

describe("routeOrderErrorMessage", () => {
  it("maps server codes to member-facing words and never stays silent", () => {
    expect(routeOrderErrorMessage({ code: "INTENT_TIMEOUT" })).toContain("超时");
    expect(routeOrderErrorMessage({ code: "INTENT_UNAVAILABLE" })).toContain("暂时不能");
    expect(routeOrderErrorMessage({ code: "INVALID_ROUTE_ORDER_INTENT" })).toContain("200");
    expect(routeOrderErrorMessage(new Error("boom"))).toContain("暂时无法理解");
  });
});
