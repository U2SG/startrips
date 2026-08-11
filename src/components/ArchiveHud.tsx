import type { ArchiveRecord } from "../experience/types";

interface ArchiveHudProps {
  records: ArchiveRecord[];
  selectedId: string;
  onOpen: (artworkId: string) => void;
}

const nodeSpecs = [
  { id: "china-han-dancer", code: "R01", slot: "northwest" },
  { id: "greek-amphora", code: "R02", slot: "north" },
  { id: "hokusai-wave", code: "R03", slot: "northeast" },
  { id: "egypt-coffin", code: "R04", slot: "east" },
  { id: "mughal-akbarnama", code: "R05", slot: "southeast" },
  { id: "china-eastern-zhou-hu", code: "R06", slot: "south" },
  { id: "china-handscroll", code: "R07", slot: "southwest" },
  { id: "prehistoric-hands", code: "R08", slot: "west" },
] as const;

const displayNames: Record<string, string> = {
  "china-han-dancer": "西汉女舞俑",
  "greek-amphora": "阿提卡双耳瓶",
  "hokusai-wave": "神奈川冲浪里",
  "egypt-coffin": "彩绘埃及棺木",
  "mughal-akbarnama": "阿克巴大帝纪事",
  "china-eastern-zhou-hu": "嵌铜青铜壶",
  "china-handscroll": "中国古代手卷",
  "prehistoric-hands": "手之洞岩画",
};

export function ArchiveHud({ records, selectedId, onOpen }: ArchiveHudProps) {
  const recordById = new Map(records.map((record) => [record.id, record]));

  return (
    <div className="archive-hud" aria-label="世界艺术档案信号">
      <p className="archive-hud-kicker">ARCHIVE RECORDS / LIVE</p>
      {nodeSpecs.map(({ id, code, slot }) => {
        const record = recordById.get(id);
        if (!record) return null;

        return (
          <button
            className={`archive-node archive-node-${slot}${selectedId === id ? " is-selected" : ""}`}
            key={id}
            type="button"
            onClick={() => onOpen(id)}
            aria-label={`打开${displayNames[id] ?? record.title}`}
          >
            <b>{displayNames[id] ?? record.title}</b>
            <i>{code}</i>
            <small>{record.year} · {record.region}</small>
          </button>
        );
      })}
    </div>
  );
}
