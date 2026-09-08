import { IconPhoto, IconPlayerPlay, IconSparkle } from "@tabler/icons-react";
import type { JourneyMediaAsset } from "./types";
import "../styles/story-media-rail.css";

type RailRead = { status: "ready"; url: string } | { status: "loading" | "error" };

/** A bounded view of the sequence; opening the rail never downloads the album. */
export function StoryMediaRail({ media, currentId, requestedId, reads, disabled, onSelect, onOrganize }: {
  media: readonly JourneyMediaAsset[];
  currentId: string | null;
  requestedId: string | null;
  reads: Record<string, RailRead>;
  disabled: boolean;
  onSelect: (index: number) => void;
  onOrganize?: () => void;
}) {
  if (media.length < 2 && !onOrganize) return null;
  const current = Math.max(0, media.findIndex((asset) => asset.id === currentId));
  const start = Math.max(0, Math.min(current - 2, media.length - 5));
  return (
    <nav className="story-media-rail" aria-label="浏览旅程媒体">
      <div className="story-media-rail__heading">
        <span>旅程片段</span>
        <span>{media.length ? current + 1 : 0} <span aria-hidden="true">/</span> {media.length}</span>
      </div>
      {media.length > 0 ? <ol>
        {media.slice(start, start + 5).map((asset, offset) => {
          const read = reads[asset.id];
          const isCurrent = asset.id === currentId;
          const isVideo = asset.mimeType.startsWith("video/");
          const pending = asset.id === requestedId && !isCurrent;
          return (
            <li key={asset.id}>
              <button type="button" disabled={disabled} aria-current={isCurrent ? "true" : undefined}
                aria-label={`查看第 ${start + offset + 1} 个${isVideo ? "视频" : "照片"}：${asset.fileName}`}
                aria-busy={pending || undefined} onClick={() => onSelect(start + offset)}>
                {!isVideo && read?.status === "ready" ? <img src={read.url} alt="" decoding="async" /> : (
                  isVideo ? <IconPlayerPlay size={20} stroke={1.35} aria-hidden="true" />
                    : <IconPhoto size={20} stroke={1.35} aria-hidden="true" />
                )}
                <span className="story-media-rail__number">{String(start + offset + 1).padStart(2, "0")}</span>
                {isCurrent ? <IconSparkle className="story-media-rail__star" size={12} aria-hidden="true" /> : null}
              </button>
            </li>
          );
        })}
      </ol> : null}
      {onOrganize ? <button className="story-media-rail__organize" type="button" disabled={disabled} onClick={onOrganize}>整理媒体 · 移动与排序</button> : null}
    </nav>
  );
}
