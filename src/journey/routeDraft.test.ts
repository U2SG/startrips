import { describe, expect, it } from "vitest";
import {
  appendRoutePoint,
  moveRoutePoint,
  removeRoutePoint,
  routeDraftToInput,
  suggestPointLabel,
  toggleRouteStop,
  updateRoutePoint,
  type RouteDraftPoint,
} from "./routeDraft";

const beijing: RouteDraftPoint = {
  draftId: "beijing",
  id: "11111111-1111-4111-8111-111111111111",
  latitude: 39.9042,
  longitude: 116.4074,
  label: "Beijing",
  isStop: true,
  occurredAt: null,
};

const ulanBator: RouteDraftPoint = {
  draftId: "ulan-bator",
  latitude: 47.8864,
  longitude: 106.9057,
  label: "Ulaanbaatar",
  isStop: true,
  occurredAt: null,
};

describe("route draft operations", () => {
  it("appends, updates, reorders, toggles, and removes without mutating input", () => {
    const original = [beijing];
    const appended = appendRoutePoint(original, ulanBator);
    const moved = moveRoutePoint(appended, "ulan-bator", -1);
    const updated = updateRoutePoint(moved, "beijing", { label: " Beijing " });
    const toggled = toggleRouteStop(updated, "ulan-bator");
    const removed = removeRoutePoint(toggled, "beijing");

    expect(original).toEqual([beijing]);
    expect(moved.map((point) => point.draftId)).toEqual([
      "ulan-bator",
      "beijing",
    ]);
    expect(routeDraftToInput(updated)[1].label).toBe("Beijing");
    expect(routeDraftToInput(updated)[1].id).toBe(beijing.id);
    expect(toggled[0].isStop).toBe(false);
    expect(removed.map((point) => point.draftId)).toEqual(["ulan-bator"]);
  });

  it("leaves ordering unchanged at either boundary", () => {
    const points = [beijing, ulanBator];
    expect(moveRoutePoint(points, "beijing", -1)).toEqual(points);
    expect(moveRoutePoint(points, "ulan-bator", 1)).toEqual(points);
  });

  it("fills only an empty point label with a reverse-geocoded suggestion", () => {
    const unnamed: RouteDraftPoint = { ...ulanBator, label: "" };
    const named = suggestPointLabel([unnamed, beijing], "ulan-bator", "  Shenzhen ");
    expect(named[0].label).toBe("Shenzhen");
    expect(named[1].label).toBe("Beijing");

    expect(suggestPointLabel([beijing], "beijing", "Tokyo")[0].label).toBe("Beijing");
    expect(suggestPointLabel([unnamed], "missing", "Tokyo")[0].label).toBe("");
    expect(suggestPointLabel([unnamed], "ulan-bator", "   ")[0].label).toBe("");
  });

  it("carries route-point notes through updates and the input payload (#10)", () => {
    const withNote: RouteDraftPoint = {
      ...beijing,
      note: "风很大，只记得那一刻特别安静。",
    };
    const updated = updateRoutePoint([withNote], "beijing", {
      note: "第二次来的时候，已经能认出山脊的轮廓。",
    });
    expect(updated[0].note).toBe("第二次来的时候，已经能认出山脊的轮廓。");

    const cleared = updateRoutePoint([withNote], "beijing", { note: "" });
    expect(cleared[0].note).toBe("");

    // routeDraftToInput spreads the note through, so the whole-list replace
    // never drops it.
    expect(routeDraftToInput([withNote])[0].note).toBe("风很大，只记得那一刻特别安静。");
  });
});
