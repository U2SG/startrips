import { IconArrowBackUp, IconDownload } from "@tabler/icons-react";
import type { PersonalMoment } from "../experience/types";

interface PointPlacedConfirmationProps {
  moment: PersonalMoment;
  onReturn: () => void;
  onAddAnother: () => void;
}

export function PointPlacedConfirmation({
  moment,
  onReturn,
  onAddAnother,
}: PointPlacedConfirmationProps) {
  return (
    <section className="point-confirmation">
      <img className="point-confirmation__backdrop" src={moment.imageUrl} alt="" aria-hidden="true" />
      <div className="point-confirmation__stars" aria-hidden="true" />
      <div className="point-confirmation__pixel-copy" aria-hidden="true">
        <span>YOUR</span><span>ART</span><span>HERE</span>
        <small>你的艺术瞬间已经亮起。</small>
      </div>

      <div className="point-confirmation__secondary" aria-hidden="true">
        <img src={moment.imageUrl} alt="" />
      </div>

      <article className="generated-record">
        <span>MY ART MOMENT · SESSION PREVIEW</span>
        <img src={moment.imageUrl} alt={moment.title} />
        <p>{moment.year} · {moment.place}</p>
        <h1>{moment.title}</h1>
        {moment.note ? <blockquote>“{moment.note}”</blockquote> : null}
      </article>

      <div className="point-confirmation__message">
        <h2>把这个艺术<br />瞬间带走。</h2>
        <p>你的观看已经成为艺术地球上的一个新光点。</p>
      </div>

      <div className="point-confirmation__actions">
        <a href={moment.imageUrl} download={`${moment.title || "art-moment"}.jpg`}>
          <IconDownload size={16} />
          保存我的艺术瞬间
        </a>
        <button type="button" onClick={onAddAnother}>放入另一个瞬间</button>
        <button type="button" onClick={onReturn}>
          <IconArrowBackUp size={16} />
          回到艺术地球
        </button>
      </div>
    </section>
  );
}
