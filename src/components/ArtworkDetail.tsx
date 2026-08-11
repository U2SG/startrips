import { useEffect } from "react";
import { IconPhotoPlus } from "@tabler/icons-react";
import type { ArchiveRecord } from "../experience/types";
import { SculptureCutout } from "./SculptureCutout";

interface ArtworkDetailProps {
  artwork: ArchiveRecord;
  onBack: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onUseAsContext: () => void;
}

export function ArtworkDetail({
  artwork,
  onBack,
  onPrevious,
  onNext,
  onUseAsContext,
}: ArtworkDetailProps) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onBack();
      if (event.key === "ArrowLeft") onPrevious();
      if (event.key === "ArrowRight") onNext();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onBack, onNext, onPrevious]);

  return (
    <section className="artwork-detail" aria-label={`${artwork.title}作品详情`}>
      <button className="artwork-detail-back" type="button" onClick={onBack}>
        返回作品场 <small>ESC</small>
      </button>
      <figure className="artwork-detail-stage">
        <div className="artwork-detail-media">
          <SculptureCutout
            className="artwork-detail-cutout"
            src={artwork.imageUrl}
            alt={artwork.description ?? artwork.title}
          />
        </div>
        <figcaption className="artwork-detail-copy">
          <small>{artwork.year} · {artwork.culture ?? artwork.region}</small>
          <h1>{artwork.title}</h1>
          <p>{artwork.description}</p>
          <dl>
            <div><dt>作者 / 工坊</dt><dd>{artwork.artist}</dd></div>
            <div><dt>媒介</dt><dd>{artwork.medium ?? "馆藏记录"}</dd></div>
            {artwork.accessionNumber ? (
              <div><dt>馆藏编号</dt><dd>{artwork.accessionNumber}</dd></div>
            ) : null}
          </dl>
          <div className="artwork-detail-actions">
            <button type="button" onClick={onUseAsContext}>
              <IconPhotoPlus size={15} stroke={1.5} />
              ADD YOUR VIEW
            </button>
            {artwork.collectionUrl ? (
              <a href={artwork.collectionUrl} target="_blank" rel="noreferrer">查看馆藏来源</a>
            ) : null}
          </div>
        </figcaption>
      </figure>
      <nav className="artwork-detail-pager" aria-label="作品详情导航">
        <button type="button" onClick={onPrevious}>PREV</button>
        <button type="button" onClick={onNext}>NEXT</button>
      </nav>
    </section>
  );
}
