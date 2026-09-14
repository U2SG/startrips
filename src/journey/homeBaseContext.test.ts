import { describe, expect, it } from "vitest";
import type { HomeBasePeriod } from "./homeBase";
import type { ResolvedHomeBasePresence } from "./homeBasePresence";
import { resolveHomeBaseContext } from "./homeBaseContext";

const currentPeriod: HomeBasePeriod = {
  id: "home-current", label: "深圳", latitude: 22.5431, longitude: 114.0579,
  startedOn: "2025-01-01", endedOn: null, source: "manual",
};
const historicalPeriod: HomeBasePeriod = {
  id: "home-history", label: "广州", latitude: 23.1291, longitude: 113.2644,
  startedOn: "2022-01-01", endedOn: "2024-12-31", source: "manual",
};
function presence(period: HomeBasePeriod, level: ResolvedHomeBasePresence["presence"]): ResolvedHomeBasePresence {
  return {
    periodId: period.id, presence: level, relativeWeight: 1, emphasisWeight: 0.4,
    latitude: period.latitude, longitude: period.longitude, anchor: {} as ResolvedHomeBasePresence["anchor"],
    labelVisible: level === "current" || level === "period-context",
  };
}

describe("resolveHomeBaseContext (ST-065)", () => {
  it("presents the exact confirmed current Home period without coordinates or fabricated Journey identity", () => {
    expect(resolveHomeBaseContext({
      periodId: currentPeriod.id,
      periods: [historicalPeriod, currentPeriod],
      presence: [presence(historicalPeriod, "absent"), presence(currentPeriod, "current")],
    })).toEqual({
      periodId: "home-current",
      label: "深圳",
      presence: "current",
      heading: "常住地 · 深圳",
      periodLabel: "2025-01-01 起",
      statusLabel: "当前生活阶段",
    });
  });

  it("keeps an activated historical Home tied to that historical period", () => {
    expect(resolveHomeBaseContext({
      periodId: historicalPeriod.id,
      periods: [historicalPeriod, currentPeriod],
      presence: [presence(historicalPeriod, "period-context"), presence(currentPeriod, "absent")],
    })).toMatchObject({
      periodId: "home-history",
      heading: "常住地 · 广州",
      periodLabel: "2022-01-01–2024-12-31",
      statusLabel: "历史生活阶段",
    });
  });

  it("refuses a period that is no longer present in the current Atlas context", () => {
    expect(resolveHomeBaseContext({
      periodId: historicalPeriod.id,
      periods: [historicalPeriod, currentPeriod],
      presence: [presence(historicalPeriod, "absent"), presence(currentPeriod, "current")],
    })).toBeNull();
  });
});
