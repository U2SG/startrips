import {
  IconArrowUpRight,
  IconPlus,
} from "@tabler/icons-react";
import { useEffect, useRef, type CSSProperties } from "react";
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
    return `${stops[0].label} → ${stops[stops.length - 1].label}`;
  }
  if (stops.length === 1) return stops[0].label;
  return `${journey.routePoints.length} 个途经点`;
}

function mediaSummary(journey: Journey) {
  if (journey.media.length === 0) return "还没有影像";
  return `${journey.media.length} 段媒体`;
}

export function JourneyTimeline({
  journeys,
  activeJourneyId,
  onSelect,
  onOpenStory,
  onCreate,
}: JourneyTimelineProps) {
  const groups = groupJourneysByYear(journeys);
  const activeCardRef = useRef<HTMLLIElement | null>(null);

  // Bring the active journey into view when the timeline opens, so a selected
  // journey from the globe is never left off-screen in the rail.
  useEffect(() => {
    activeCardRef.current?.scrollIntoView({
      inline: "center",
      block: "nearest",
    });
  }, [activeJourneyId]);

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
                <li
                  key={journey.id}
                  ref={journey.id === activeJourneyId ? activeCardRef : undefined}
                  className={journey.id === activeJourneyId ? "is-active" : ""}
                  style={{ "--journey-color": journey.lightColor } as CSSProperties}
                >
                  <button type="button" className="journey-timeline__select" onClick={() => onSelect(journey.id)} aria-pressed={journey.id === activeJourneyId}>
                    <time>{journey.startedOn.slice(5).replace("-", ".")}</time>
                    <strong>{journey.title}</strong>
                    <span>{routeSummary(journey)}</span>
                    <small>{mediaSummary(journey)}</small>
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
