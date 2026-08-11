import type { KeyboardEvent, WheelEvent } from "react";
import type { ArchiveRecord } from "../experience/types";
import { ArchiveHud } from "./ArchiveHud";
import { ArchiveTimeline } from "./ArchiveTimeline";

interface ArchiveShellProps {
  records: ArchiveRecord[];
  selectedId: string;
  onSelect: (artworkId: string) => void;
  onOpen: (artworkId: string) => void;
}

export function ArchiveShell({ records, selectedId, onSelect, onOpen }: ArchiveShellProps) {
  const selectedIndex = Math.max(0, records.findIndex((record) => record.id === selectedId));

  const selectOffset = (offset: number) => {
    const nextIndex = (selectedIndex + offset + records.length) % records.length;
    onSelect(records[nextIndex].id);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      selectOffset(-1);
    } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      selectOffset(1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      onOpen(records[selectedIndex].id);
    }
  };

  const handleWheel = (event: WheelEvent<HTMLElement>) => {
    if (Math.abs(event.deltaY) < 8) return;
    selectOffset(event.deltaY > 0 ? 1 : -1);
  };

  return (
    <section
      className="archive-shell"
      aria-label="世界艺术档案"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onWheel={handleWheel}
    >
      <ArchiveHud records={records} selectedId={selectedId} onOpen={onOpen} />
      <ArchiveTimeline records={records} selectedIndex={selectedIndex} onSelect={(index) => onSelect(records[index].id)} />
      <div className="archive-controls">
        <span>PLAY THE ATLAS</span>
        <p>拖动世界，跟随一束让你停下来的光。</p>
        <div>
          <button type="button" onClick={() => selectOffset(-1)} aria-label="上一件作品">PREV</button>
          <button type="button" onClick={() => onOpen(records[selectedIndex].id)}>ENTER</button>
          <button type="button" onClick={() => selectOffset(1)} aria-label="下一件作品">NEXT</button>
        </div>
      </div>
    </section>
  );
}
