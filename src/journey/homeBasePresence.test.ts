import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MOTION_REDUCED_QUERY } from "../motion/preferences";
import { GEOGRAPHIC_SURFACE_RADIUS, routePointAnchor } from "../scene/geo";
import type { GlobeSemanticZoom } from "../scene/semanticZoom";
import type { HomeBasePeriod } from "./homeBase";
import {
  HOME_BASE_LAYER_EMPHASIS_CEILING,
  HOME_BASE_PRESENCE_WEIGHTS,
  SELECTED_JOURNEY_EMPHASIS_WEIGHT,
  homeBaseAccessibleName,
  homeBaseLabel,
  homeBaseMotionDescriptor,
  resolveHomeBasePresence,
  resolvedHomeBaseEmphasisWeight,
  type HomeBasePresenceLevel,
} from "./homeBasePresence";

const CURRENT_HOME: HomeBasePeriod = {
  id: "home-shenzhen",
  label: "深圳",
  latitude: 22.5431,
  longitude: 114.0579,
  startedOn: "2026-01-01",
  endedOn: null,
  source: "manual",
};

const HISTORICAL_HOME: HomeBasePeriod = {
  id: "home-guangzhou",
  label: "广州",
  latitude: 23.1291,
  longitude: 113.2644,
  startedOn: "2022-01-01",
  endedOn: "2026-01-01",
  source: "suggested-confirmed",
};

const ZOOMS: readonly GlobeSemanticZoom[] = ["planet", "macro", "regional", "local"];

describe("resolveHomeBasePresence (#233)", () => {
  it("resolves the open-ended period as current in ordinary Atlas context", () => {
    const [resolved] = resolveHomeBasePresence({
      periods: [CURRENT_HOME],
      semanticZoom: "regional",
      timeline: { kind: "ordinary", date: "2026-09-10" },
    });
    expect(resolved).toMatchObject({
      periodId: CURRENT_HOME.id,
      presence: "current",
      relativeWeight: 1,
      labelVisible: true,
    });
  });

  it("keeps the effective old Home current until a future move boundary", () => {
    const moveDate = "2030-01-01";
    const oldHome: HomeBasePeriod = { ...CURRENT_HOME, id: "home-old", endedOn: moveDate };
    const futureHome: HomeBasePeriod = {
      ...CURRENT_HOME,
      id: "home-future",
      label: "东京",
      latitude: 35.6762,
      longitude: 139.6503,
      startedOn: moveDate,
      endedOn: null,
    };
    const before = resolveHomeBasePresence({
      periods: [oldHome, futureHome],
      semanticZoom: "regional",
      timeline: { kind: "ordinary", date: "2029-12-31" },
    });
    const boundary = resolveHomeBasePresence({
      periods: [oldHome, futureHome],
      semanticZoom: "regional",
      timeline: { kind: "ordinary", date: moveDate },
    });
    expect(before.map(({ periodId, presence }) => [periodId, presence])).toEqual([
      [oldHome.id, "current"],
      [futureHome.id, "absent"],
    ]);
    expect(boundary.map(({ periodId, presence }) => [periodId, presence])).toEqual([
      [oldHome.id, "absent"],
      [futureHome.id, "current"],
    ]);
  });

  it("reveals an ended period only when the timeline reaches its life span", () => {
    const during = resolveHomeBasePresence({
      periods: [HISTORICAL_HOME],
      semanticZoom: "regional",
      timeline: { kind: "date", date: "2024-10-01" },
    })[0];
    const after = resolveHomeBasePresence({
      periods: [HISTORICAL_HOME],
      semanticZoom: "regional",
      timeline: { kind: "date", date: "2026-02-01" },
    })[0];
    expect(during.presence).toBe("period-context");
    expect(during.labelVisible).toBe(true);
    expect(after.presence).toBe("absent");
    expect(after.labelVisible).toBe(false);
  });

  it("keeps every prior Home as an unlabeled trace in all-time view", () => {
    const resolved = resolveHomeBasePresence({
      periods: [HISTORICAL_HOME, { ...HISTORICAL_HOME, id: "home-hk", startedOn: "2018-01-01", endedOn: "2022-01-01" }],
      semanticZoom: "local",
      timeline: { kind: "all-time", date: "2026-09-10" },
    });
    expect(resolved.map((item) => item.presence)).toEqual(["trace", "trace"]);
    expect(resolved.every((item) => item.labelVisible === false)).toBe(true);
  });

  it("is deterministic and side-effect free for the same input", () => {
    const periods = [Object.freeze({ ...HISTORICAL_HOME }), Object.freeze({ ...CURRENT_HOME })] as const;
    const before = JSON.stringify(periods);
    const input = { periods, semanticZoom: "regional" as const, timeline: { kind: "all-time" as const, date: "2026-09-10" } };
    expect(resolveHomeBasePresence(input)).toEqual(resolveHomeBasePresence(input));
    expect(JSON.stringify(periods)).toBe(before);
  });

  it("keeps one canonical geographic anchor at every semantic zoom", () => {
    const canonical = routePointAnchor(
      CURRENT_HOME.latitude,
      CURRENT_HOME.longitude,
      GEOGRAPHIC_SURFACE_RADIUS,
    );
    for (const semanticZoom of ZOOMS) {
      const resolved = resolveHomeBasePresence({
        periods: [CURRENT_HOME],
        semanticZoom,
        timeline: { kind: "ordinary", date: "2026-09-10" },
      })[0];
      expect(resolved.anchor.toArray()).toEqual(canonical.toArray());
      expect(resolved.anchor.length()).toBeCloseTo(GEOGRAPHIC_SURFACE_RADIUS, 12);
    }
  });

  it("uses the exact V1 relative weights while keeping Home below selected Journey emphasis", () => {
    expect(HOME_BASE_PRESENCE_WEIGHTS).toEqual({
      current: 1,
      "period-context": 0.65,
      trace: 0.15,
      absent: 0,
    });
    expect(HOME_BASE_LAYER_EMPHASIS_CEILING).toBeLessThan(SELECTED_JOURNEY_EMPHASIS_WEIGHT);
    expect(resolvedHomeBaseEmphasisWeight("current")).toBeLessThan(SELECTED_JOURNEY_EMPHASIS_WEIGHT);
  });

  it("formats the decided label and includes the historical span in accessibility copy", () => {
    expect(homeBaseLabel(CURRENT_HOME)).toBe("常住地 · 深圳");
    expect(homeBaseAccessibleName(CURRENT_HOME)).toContain("当前常住地：深圳");
    expect(homeBaseAccessibleName(HISTORICAL_HOME)).toContain("2022-01-01–2026-01-01");
  });

  it("uses no ambient animation in V1 and reduced motion never changes semantic presence", () => {
    const levels: readonly HomeBasePresenceLevel[] = ["current", "period-context", "trace", "absent"];
    for (const level of levels) {
      const regular = homeBaseMotionDescriptor(level, false);
      const reduced = homeBaseMotionDescriptor(level, true);
      expect(regular).toMatchObject({ presence: level, ambientAnimation: "none" });
      expect(reduced).toMatchObject({ presence: level, ambientAnimation: "none" });
      expect(reduced.presence).toBe(regular.presence);
      expect(reduced.reducedMotionQuery).toBe(MOTION_REDUCED_QUERY);
    }
  });

  it("introduces no Home-specific colour literal", () => {
    for (const path of [
      "src/journey/homeBasePresence.ts",
      "src/journey/homeBaseCameraPolicy.ts",
    ]) {
      const source = readFileSync(path, "utf8");
      const codeOnly = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(codeOnly, path).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    }
  });
});
