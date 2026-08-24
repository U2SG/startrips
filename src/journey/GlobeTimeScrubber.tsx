import { useRef } from "react";
import { IconPlayerPause, IconPlayerPlay, IconHistory } from "@tabler/icons-react";
import type { GlobeTimeCursor } from "./useGlobeTimeCursor";

/**
 * #21 Globe Rewind — a minimal time axis shown in globe focus mode. One thin
 * track with year ticks and a cursor; hover/touch reveals the date. The user
 * can scrub (pointer) or press play to replay the whole planet from the
 * first journey to now. It is deliberately not a player dock: no chrome
 * beyond the track, a play/pause, and the year label.
 */
export function GlobeTimeScrubber({
  cursor,
  playing,
  stops,
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

  const yearLabel = formatCursorYear(cursor, stops);

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
          role="slider"
          aria-label="时间轴"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(cursor * 100)}
          aria-valuetext={yearLabel}
          tabIndex={0}
        >
          <span className="globe-time-scrubber__fill" style={{ width: `${cursor * 100}%` }} />
          <span className="globe-time-scrubber__cursor" style={{ left: `${cursor * 100}%` }}>
            <IconHistory size={11} stroke={1.5} aria-hidden="true" />
          </span>
        </div>
        <div className="globe-time-scrubber__ticks" aria-hidden="true">
          <span>2019</span>
          <span>2021</span>
          <span>2024</span>
          <span>现在</span>
        </div>
      </div>
      <span className="globe-time-scrubber__date" aria-hidden="true">{yearLabel}</span>
    </div>
  );
}

function formatCursorYear(cursor: number, stops: readonly number[]): string {
  if (stops.length === 0) return "现在";
  if (cursor >= 1) return "现在";
  const maxStop = stops.at(-1) ?? 1;
  // Approximate year from the cursor fraction over the timeline.
  const year = 2019 + Math.round((cursor / Math.max(0.0001, maxStop)) * 6);
  return `${year}`;
}
