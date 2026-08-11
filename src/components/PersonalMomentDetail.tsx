import {
  IconArrowLeft,
  IconMapPin,
  IconWorld,
} from "@tabler/icons-react";
import type { PersonalMoment } from "../experience/types";

interface PersonalMomentDetailProps {
  moment: PersonalMoment;
  onBack: () => void;
  onBackToEarth: () => void;
}

export function PersonalMomentDetail({
  moment,
  onBack,
  onBackToEarth,
}: PersonalMomentDetailProps) {
  return (
    <section className="personal-moment-detail" aria-label={`${moment.title}个人艺术瞬间详情`}>
      <header className="personal-moment-detail__header">
        <button type="button" data-action="back-gallery" onClick={onBack}>
          <IconArrowLeft size={16} stroke={1.4} />
          返回私人展厅
        </button>
        <span>MY ART MOMENT · PERSONAL RECORD</span>
        <button type="button" data-action="back-earth" onClick={onBackToEarth}>
          <IconWorld size={16} stroke={1.4} />
          回到艺术地球
        </button>
      </header>

      <article className="personal-moment-detail__record">
        <figure>
          <img src={moment.imageUrl} alt={moment.title} />
          <figcaption>PERSONAL VIEW / NOT PUBLIC</figcaption>
        </figure>
        <div className="personal-moment-detail__copy">
          <span>001 · YOUR POINT</span>
          <h1>{moment.title}</h1>
          {moment.note ? <blockquote>“{moment.note}”</blockquote> : null}
          <dl>
            <div><dt>YEAR</dt><dd>{moment.year || "未记录"}</dd></div>
            <div><dt>PLACE</dt><dd><IconMapPin size={14} stroke={1.4} />{moment.place || "未记录"}</dd></div>
            <div><dt>COORDINATE</dt><dd>{moment.point.lat.toFixed(2)}° · {moment.point.lon.toFixed(2)}°</dd></div>
            <div><dt>VISIBILITY</dt><dd>PRIVATE SESSION</dd></div>
          </dl>
          <p>这件作品只存在于当前私人会话，不会被公开发布。</p>
        </div>
      </article>
    </section>
  );
}
