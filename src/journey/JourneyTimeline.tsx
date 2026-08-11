import {
  IconArrowUpRight,
  IconPlus,
} from "@tabler/icons-react";
import type { CSSProperties } from "react";
import { groupJourneysByYear } from "./journeyModel";
import type { Journey } from "./types";

type JourneyTimelineProps = {
  journeys: readonly Journey[];
  activeJourneyId: string | null;
  onSelect: (journeyId: string) => void;
  onOpenStory: (journeyId: string) => void;
  onCreate: () => void;
};

function routeSummary(journey: Journey) {
  const stops = journey.routePoints.filter((point) => point.isStop);
  if (stops.length > 1) {
    return `${stops[0].label} 至 ${stops[stops.length - 1].label}`;
  }
  if (stops.length === 1) return stops[0].label;
  return `${journey.routePoints.length} 个途经点`;
}

export function JourneyTimeline({
  journeys,
  activeJourneyId,
  onSelect,
  onOpenStory,
  onCreate,
}: JourneyTimelineProps) {
  const groups = groupJourneysByYear(journeys);

  return (
    <section className="journey-timeline" aria-labelledby="journey-timeline-title">
      <header>
        <p>CHRONOLOGICAL ORBIT</p>
        <h2 id="journey-timeline-title">旅程时间线</h2>
      </header>
      <div className="journey-timeline__rail">
        {groups.map((group) => (
          <section key={group.year} className="journey-timeline__year" aria-labelledby={`journey-year-${group.year}`}>
            <h3 id={`journey-year-${group.year}`}>{group.year}</h3>
            <ol>
              {group.journeys.map((journey) => (
                <li key={journey.id} className={journey.id === activeJourneyId ? "is-active" : ""} style={{ "--journey-color": journey.lightColor } as CSSProperties}>
                  <button type="button" className="journey-timeline__select" onClick={() => onSelect(journey.id)} aria-pressed={journey.id === activeJourneyId}>
                    <time>{journey.startedOn.slice(5).replace("-", ".")}</time>
                    <strong>{journey.title}</strong>
                    <span>{routeSummary(journey)}</span>
                  </button>
                  <button type="button" className="journey-timeline__story" onClick={() => onOpenStory(journey.id)}>打开故事<IconArrowUpRight size={15} stroke={1.35} aria-hidden="true" /></button>
                </li>
              ))}
            </ol>
          </section>
        ))}
        <button type="button" className="journey-timeline__future" onClick={onCreate}>
          <IconPlus size={24} stroke={1.2} aria-hidden="true" /><strong>下一段旅程</strong><small>路线还没有发生</small>
        </button>
      </div>
    </section>
  );
}
