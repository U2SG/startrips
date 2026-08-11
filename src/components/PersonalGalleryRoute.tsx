import { IconArrowLeft, IconPlus } from "@tabler/icons-react";
import {
  HangingGallery,
  type HangingGalleryItem,
} from "../../templates/personal-gallery";
import type { PersonalMoment } from "../experience/types";

interface PersonalGalleryRouteProps {
  moments: PersonalMoment[];
  selectedMomentId: string | null;
  reduceMotion: boolean;
  onOpen: (momentId: string) => void;
  onBackToEarth: () => void;
  onAddMoment: () => void;
}

export function buildPersonalGalleryItems(
  moments: readonly PersonalMoment[],
): HangingGalleryItem[] {
  return moments.map((moment) => ({
    id: moment.id,
    title: moment.title,
    date: [moment.place, moment.year].filter(Boolean).join(" · "),
    imageUrl: moment.imageUrl,
    previewUrl: moment.previewUrl,
  }));
}

export function PersonalGalleryRoute({
  moments,
  selectedMomentId,
  reduceMotion,
  onOpen,
  onBackToEarth,
  onAddMoment,
}: PersonalGalleryRouteProps) {
  const items = buildPersonalGalleryItems(moments);

  return (
    <section className="personal-gallery-route" aria-label="我的个人艺术展厅">
      <header className="personal-gallery-header">
        <button type="button" data-action="back-earth" onClick={onBackToEarth}>
          <IconArrowLeft size={16} stroke={1.4} />
          <span>EARTH</span>
        </button>
        <div>
          <strong>ART LOOKS BACK</strong>
          <small>PRIVATE GALLERY · SESSION PREVIEW</small>
        </div>
        <button type="button" data-action="add-moment" onClick={onAddMoment}>
          <IconPlus size={16} stroke={1.4} />
          <span>ADD A MOMENT</span>
        </button>
      </header>

      {items.length > 0 ? (
        <HangingGallery
          items={items}
          active
          quality="low"
          reduceMotion={reduceMotion}
          initialItemId={selectedMomentId ?? items[0].id}
          onOpen={onOpen}
          openLabel="打开这个瞬间"
        />
      ) : (
        <div className="personal-gallery-empty">
          <span>PRIVATE GALLERY / EMPTY</span>
          <h1>这里还没有<br />属于你的艺术瞬间。</h1>
          <button type="button" onClick={onAddMoment}>放入第一个瞬间</button>
        </div>
      )}
    </section>
  );
}
