import { MOBILE_CLASSIC_VIEWS, useMobileClassicView } from "./mobileClassicView";

export function MobileClassicViewMenuEntry({ surface }: { surface: "dock" | "sheet" }) {
  const [view, cycle] = useMobileClassicView();
  const definition = MOBILE_CLASSIC_VIEWS.find((candidate) => candidate.id === view)!;
  return (
    <button
      type="button"
      data-mobile-classic-view-entry={surface}
      data-mobile-classic-view-value={view}
      aria-label={`切换经典视图，当前 ${definition.letter} ${definition.label}`}
      title="手机经典视图：A 轻量经典 / B 单手操作 / C 照片优先 / D 地球优先"
      onClick={cycle}
    >
      <span>经典视图</span><small>{definition.letter} · {definition.label}</small>
    </button>
  );
}
