import type { CSSProperties } from "react";
import type { ArchiveRecord } from "../experience/types";

interface ArchiveTimelineProps {
  records: ArchiveRecord[];
  selectedIndex: number;
  onSelect: (index: number) => void;
}

type TickStyle = CSSProperties & { "--tick-index": number };

export function ArchiveTimeline({ records, selectedIndex, onSelect }: ArchiveTimelineProps) {
  const selected = records[selectedIndex];

  return (
    <aside className="archive-timeline" aria-label="档案时间索引">
      <span className="archive-timeline-label">WORLD TIME</span>
      <div className="archive-timeline-dial">
        {Array.from({ length: 29 }, (_, index) => (
          <i key={index} style={{ "--tick-index": index } as TickStyle} aria-hidden="true" />
        ))}
      </div>
      <div className="archive-timeline-cursor" aria-live="polite">
        <strong>{String(selectedIndex + 1).padStart(2, "0")}</strong>
        <small>{selected?.year ?? "ARCHIVE"}</small>
      </div>
      <input
        type="range"
        min="0"
        max={Math.max(0, records.length - 1)}
        value={selectedIndex}
        onChange={(event) => onSelect(Number(event.currentTarget.value))}
        aria-label="选择档案年代"
      />
    </aside>
  );
}
