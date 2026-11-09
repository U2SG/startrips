import { useState, type ReactNode } from "react";

type Props = { pointId: string; first: boolean; ids: string[]; renderMedia: (ids: string[]) => ReactNode };
export function JournalPlaceMedia(props: Props) {
  return props.first ? <PlaceGallery key={props.pointId} {...props} />
    : <a href={`#journal-place-media-${props.pointId}`}>查看该地点已有照片/视频（本页合并展示）</a>;
}

function PlaceGallery({ pointId, ids, renderMedia }: Props) {
  const [open, setOpen] = useState(false);
  const anchor = `journal-place-media-${pointId}`;
  return <details id={anchor} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary tabIndex={0}>该地点已有照片/视频（{ids.length}）</summary>
    <p className="daily-journal__muted">地点资料，不代表在本次事件拍摄；同一地点在本页只展示一次。</p>
    {open ? renderMedia(ids) : null}
  </details>;
}
