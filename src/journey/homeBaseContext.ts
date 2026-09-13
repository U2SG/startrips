import type { HomeBasePeriod } from "./homeBase";
import type { ResolvedHomeBasePresence } from "./homeBasePresence";

export type HomeBaseContextModel = {
  periodId: string;
  label: string;
  presence: Exclude<ResolvedHomeBasePresence["presence"], "absent">;
  heading: string;
  periodLabel: string;
  statusLabel: string;
};

function homeBasePeriodLabel(period: HomeBasePeriod) {
  return period.endedOn
    ? `${period.startedOn}–${period.endedOn}`
    : `${period.startedOn} 起`;
}

/**
 * #233 / ST-065: one private, context-first summary for the already-rendered
 * Home anchor. It consumes the same resolved presence that owns the visible
 * marker; it never invents a second temporal/currentness authority.
 */
export function resolveHomeBaseContext(input: {
  periodId: string | null;
  periods: readonly HomeBasePeriod[];
  presence: readonly ResolvedHomeBasePresence[];
}): HomeBaseContextModel | null {
  if (!input.periodId) return null;
  const period = input.periods.find((candidate) => candidate.id === input.periodId);
  const resolved = input.presence.find((candidate) => candidate.periodId === input.periodId);
  if (!period || !resolved || resolved.presence === "absent") return null;
  const current = resolved.presence === "current";
  return {
    periodId: period.id,
    label: period.label,
    presence: resolved.presence,
    heading: `常住地 · ${period.label}`,
    periodLabel: homeBasePeriodLabel(period),
    statusLabel: current ? "当前生活阶段" : "历史生活阶段",
  };
}
