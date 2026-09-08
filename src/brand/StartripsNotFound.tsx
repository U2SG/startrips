import { IconArrowLeft } from "@tabler/icons-react";
import { StartripsJourneyCue, StartripsWordmark } from "./StartripsBrandMark";

export function StartripsNotFound() {
  return (
    <main className="startrips-not-found">
      <StartripsWordmark size={36} companion={false} />
      <section aria-labelledby="not-found-title">
        <StartripsJourneyCue state="rest" size={112} />
        <p className="startrips-not-found__code">404</p>
        <h1 id="not-found-title">这条路，暂时没有故事</h1>
        <p>页面可能已移动，或链接不完整。回到图谱，继续下一段旅程。</p>
        <a href="/"><IconArrowLeft size={18} stroke={1.35} aria-hidden="true" />返回 Startrips</a>
      </section>
      <small>同一片星空，还有故事等你。</small>
    </main>
  );
}
