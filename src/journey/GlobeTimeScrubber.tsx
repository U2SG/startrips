import { useRef } from "react";
import { IconPlayerPause, IconPlayerPlay, IconHistory } from "@tabler/icons-react";
import type { GlobeTimeCursor } from "./useGlobeTimeCursor";

type TimeDomain = GlobeTimeCursor["timeDomain"];

const KEY_STEP = 0.01;
const PAGE_STEP = 0.1;
const TICK_POSITIONS = [0, 1 / 3, 2 / 3, 1] as const;

/**
 * #21 Globe Rewind — a minimal time axis shown in globe focus mode. One thin
 * track with date ticks and a cursor; hover/touch reveals the date. The user
 * can scrub (pointer/keyboard) or press play to replay the whole planet from
 * the first dated journey to the latest dated moment.
 */
export function GlobeTimeScrubber({
  cursor,
  playing,
  timeDomain,
  play,
  pause,
  seek,
}: GlobeTimeCursor) {
  const trackRef = useRef<HTMLDivElement>(null);

  const onPointerDown = (event: React.PointerEvent) => {
    const track = trackRef.current;
    if (!track) return;
    const move = (clientX: number) => {
      const rect = track.getBoundingClientRect();
      const value = (clientX - rect.left) / Math.max(1, rect.width);
      seek(Math.min(1, Math.max(0, value)));
    };
    move(event.clientX);
    const onMove = (moveEvent: PointerEvent) => move(moveEvent.clientX);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const next = cursorForSliderKey(event.key, cursor);
    if (next === null) return;
    event.preventDefault();
    seek(next);
  };

  const dateLabel = formatCursorDate(cursor, timeDomain);
  const tickLabels = timelineTickLabels(timeDomain);

  return (
    <div className="globe-time-scrubber" role="group" aria-label="时间回溯">
      <button
        type="button"
        className="globe-time-scrubber__play"
        onClick={playing ? pause : play}
        aria-label={playing ? "暂停时间回溯" : "回放我的星球"}
        aria-pressed={playing}
      >
        {playing
          ? <IconPlayerPause size={15} stroke={1.4} aria-hidden="true" />
          : <IconPlayerPlay size={15} stroke={1.4} aria-hidden="true" />}
      </button>
      <div className="globe-time-scrubber__track-wrap">
        <div
          ref={trackRef}
          className="globe-time-scrubber__track"
          onPointerDown={onPointerDown}
          onKeyDown={onKeyDown}
          role="slider"
          aria-label="时间轴"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(cursor * 100)}
          aria-valuetext={dateLabel}
          tabIndex={0}
        >
          <span className="globe-time-scrubber__fill" style={{ width: `${cursor * 100}%` }} />
          <span className="globe-time-scrubber__cursor" style={{ left: `${cursor * 100}%` }}>
            <IconHistory size={11} stroke={1.5} aria-hidden="true" />
          </span>
        </div>
        <div className="globe-time-scrubber__ticks" aria-hidden="true">
          {tickLabels.map((label, index) => <span key={`${index}-${label}`}>{label}</span>)}
        </div>
      </div>
      <span className="globe-time-scrubber__date" aria-hidden="true">{dateLabel}</span>
    </div>
  );
}

export function cursorForSliderKey(key: string, cursor: number): number | null {
  switch (key) {
    case "ArrowLeft":
    case "ArrowDown":
      return clampCursor(cursor - KEY_STEP);
    case "ArrowRight":
    case "ArrowUp":
      return clampCursor(cursor + KEY_STEP);
    case "PageDown":
      return clampCursor(cursor - PAGE_STEP);
    case "PageUp":
      return clampCursor(cursor + PAGE_STEP);
    case "Home":
      return 0;
    case "End":
      return 1;
    default:
      return null;
  }
}

export function formatCursorDate(cursor: number, timeDomain: TimeDomain): string {
  if (!timeDomain) return "暂无日期";
  return formatUtcDate(cursorToTimestamp(cursor, timeDomain));
}

export function timelineTickLabels(timeDomain: TimeDomain): string[] {
  if (!timeDomain) return ["暂无", "—", "—", "日期"];
  return TICK_POSITIONS.map((cursor) => (
    formatUtcDate(cursorToTimestamp(cursor, timeDomain))
  ));
}

function cursorToTimestamp(cursor: number, timeDomain: NonNullable<TimeDomain>) {
  const { minTime, maxTime } = timeDomain;
  return minTime + clampCursor(cursor) * Math.max(0, maxTime - minTime);
}

function formatUtcDate(timestamp: number) {
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function clampCursor(value: number) {
  return Math.min(1, Math.max(0, value));
}
