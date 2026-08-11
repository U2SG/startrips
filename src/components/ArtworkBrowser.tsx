import { useEffect } from "react";
import type { ArchiveRecord } from "../experience/types";

interface ArtworkBrowserProps {
  records: ArchiveRecord[];
  selectedId: string;
  onSelect: (artworkId: string) => void;
  onOpen: (artworkId: string) => void;
  onBack: () => void;
}

export function getArchiveNeighbor(
  records: ArchiveRecord[],
  selectedId: string,
  offset: number,
) {
  const selectedIndex = Math.max(0, records.findIndex((record) => record.id === selectedId));
  return records[(selectedIndex + offset + records.length) % records.length];
}

export function ArtworkBrowser({ records, selectedId, onSelect, onOpen, onBack }: ArtworkBrowserProps) {
  const selected = records.find((record) => record.id === selectedId) ?? records[0];
  const previous = getArchiveNeighbor(records, selected.id, -1);
  const next = getArchiveNeighbor(records, selected.id, 1);
  const selectedIndex = records.indexOf(selected);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") onSelect(previous.id);
      if (event.key === "ArrowRight") onSelect(next.id);
      if (event.key === "Enter") onOpen(selected.id);
      if (event.key === "Escape") onBack();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [next.id, onBack, onOpen, onSelect, previous.id, selected.id]);

  return (
    <section
      className="artwork-browser"
      aria-label="艺术档案作品浏览"
      onWheel={(event) => {
        if (Math.abs(event.deltaY) < 8) return;
        onSelect(event.deltaY > 0 ? next.id : previous.id);
      }}
    >
      <button className="artwork-browser-index" type="button" onClick={onBack}>
        <span>WORLD INDEX</span>
        <small>{records.length} 件作品</small>
      </button>

      <div className="artwork-browser-lane">
        <button className="artwork-browser-card is-previous" type="button" onClick={() => onSelect(previous.id)}>
          <img src={previous.imageUrl} alt={previous.title} />
        </button>
        <button className="artwork-browser-card is-selected" type="button" onClick={() => onOpen(selected.id)}>
          <img src={selected.imageUrl} alt={selected.title} />
        </button>
        <button className="artwork-browser-card is-next" type="button" onClick={() => onSelect(next.id)}>
          <img src={next.imageUrl} alt={next.title} />
        </button>
      </div>

      <p className="artwork-browser-instruction">SCROLL TO WALK</p>
      <div className="artwork-browser-selection" aria-live="polite">
        <span>{selected.year}</span>
        <strong>{selected.title}</strong>
        <small>{selected.region}</small>
      </div>
      <nav className="artwork-browser-pager" aria-label="作品导航">
        <button type="button" onClick={() => onSelect(previous.id)} aria-label="上一件作品">←</button>
        <span>{String(selectedIndex + 1).padStart(2, "0")} / {String(records.length).padStart(2, "0")}</span>
        <button type="button" onClick={() => onSelect(next.id)} aria-label="下一件作品">→</button>
      </nav>
    </section>
  );
}
