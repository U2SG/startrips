import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { HomeBasePeriod } from "../journey/homeBase";
import {
  HOME_BASE_LAYER_EMPHASIS_CEILING,
  SELECTED_JOURNEY_EMPHASIS_WEIGHT,
  resolveHomeBasePresence,
} from "../journey/homeBasePresence";
import { buildHomeBasePresenceLayer, HOME_BASE_TOUCH_TARGET_PX } from "./homeBasePresenceLayer";

const PERIOD: HomeBasePeriod = {
  id: "home-shenzhen", label: "深圳", latitude: 22.5431, longitude: 114.0579,
  startedOn: "2026-01-01", endedOn: null, source: "manual",
};

describe("buildHomeBasePresenceLayer (ST-056)", () => {
  it("drops absent periods, reuses the resolver anchor exactly and emits decided copy", () => {
    const resolved = resolveHomeBasePresence({
      periods: [PERIOD], semanticZoom: "regional", timeline: { kind: "ordinary", date: "2026-09-10" },
    });
    const [drawn] = buildHomeBasePresenceLayer({ presence: resolved, periods: [PERIOD], effectiveDate: "2026-09-10" });
    expect(drawn.anchor).toBe(resolved[0].anchor);
    expect(drawn.label).toBe("常住地 · 深圳");
    expect(drawn.accessibleName).toContain("当前常住地：深圳");
    expect(drawn.touchTargetPx).toBe(HOME_BASE_TOUCH_TARGET_PX);
    expect(drawn.touchTargetPx).toBeGreaterThanOrEqual(44);

    const absent = resolveHomeBasePresence({
      periods: [PERIOD], semanticZoom: "regional", timeline: { kind: "date", date: "2025-12-31" },
    });
    expect(buildHomeBasePresenceLayer({ presence: absent, periods: [PERIOD], effectiveDate: "2025-12-31" })).toEqual([]);
  });

  it("emits no label when the resolver suppresses it and stays quieter than selected Journey focus", () => {
    const resolved = resolveHomeBasePresence({
      periods: [{ ...PERIOD, endedOn: "2026-01-01" }],
      semanticZoom: "planet", timeline: { kind: "all-time", date: "2026-09-10" },
    });
    const [drawn] = buildHomeBasePresenceLayer({
      presence: resolved, periods: [{ ...PERIOD, endedOn: "2026-01-01" }], effectiveDate: "2026-09-10",
    });
    expect(drawn.label).toBeNull();
    expect(drawn.emphasisWeight).toBeLessThanOrEqual(HOME_BASE_LAYER_EMPHASIS_CEILING);
    expect(drawn.emphasisWeight).toBeLessThan(SELECTED_JOURNEY_EMPHASIS_WEIGHT);
  });

  it("does not create a second endedOn-based currentness authority", () => {
    const source = readFileSync("src/scene/homeBasePresenceLayer.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(source).not.toContain("endedOn");
    expect(source).toContain("homeBaseAccessibleName");
  });
  it("introduces no new color literal in the pure Home layer", () => {
    const source = readFileSync("src/scene/homeBasePresenceLayer.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(source).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/i);
  });
});
