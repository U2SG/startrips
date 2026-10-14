import { useMediaPresentationAccess } from "./MediaPresentationProvider";
import { MEDIA_PRESENTATION_STYLES, mediaPresentationLabel, useMediaPresentationStyle, writeMediaPresentationStyle } from "./mediaPresentation";
import type { MediaPresentationStyle } from "./mediaPresentationStyle";
import "../styles/story-presentation-picker.css";

/** One direct chooser on every reader, using the same confirmed preference as Account. */
export function StoryPresentationPicker({ disabled = false, onOpenClassic }: {
  disabled?: boolean;
  /** Read-only shared readers keep an explicit local recovery, never an account write. */
  onOpenClassic?: () => void;
}) {
  const access = useMediaPresentationAccess();
  const style = useMediaPresentationStyle();
  const choose = (next: MediaPresentationStyle) => {
    if (access?.select) void access.select(next);
    else if (!access) {
      writeMediaPresentationStyle(next);
      if (next === "classic") onOpenClassic?.();
    }
  };
  if (access && !access.select && !access.busy && !access.error) {
    return onOpenClassic ? <button type="button" className="story-presentation-picker__fallback"
      onClick={onOpenClassic}>经典视图</button> : null;
  }
  return <div className="story-presentation-picker">
    <select aria-label="切换媒体呈现" value={style}
      disabled={disabled || Boolean(access?.busy) || Boolean(access && !access.select)}
      onChange={(event) => choose(event.currentTarget.value as MediaPresentationStyle)}>
      {MEDIA_PRESENTATION_STYLES.map((value) => <option key={value} value={value}>
        {value === "classic" ? "经典视图" : mediaPresentationLabel(value)}
      </option>)}
    </select>
    {access?.error ? <span role="status" className="story-presentation-picker__error">
      {access.error}<button type="button" disabled={disabled || access.busy}
        onClick={() => access.retry()}>重试</button>
    </span> : null}
  </div>;
}
