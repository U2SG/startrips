import { useSyncExternalStore } from "react";
import { isSharedAtlasPathname } from "./sharedAtlas";
import { useMediaPresentationAccess } from "./MediaPresentationProvider";
import { MEDIA_PRESENTATION_STYLES, parseMediaPresentationStyle, type MediaPresentationStyle } from "./mediaPresentationStyle";
export { MEDIA_PRESENTATION_STYLES, parseMediaPresentationStyle, type MediaPresentationStyle } from "./mediaPresentationStyle";
import "../styles/journey-reader.css";

/**
 * How Story presents a Journey's photos, videos and notes.
 *
 * - `classic`: the existing Story media stage, unchanged.
 * - `note-overlay`: the existing stage, with the Route Point note revealed
 *   over the picture instead of below it.
 * - `book`: the Journey Book reader, which opens in place of Story.
 * - `stream`: the Journey Stream reader (after Undertow), in place of Story.
 * - `book-3d`: the Journey Book with real bending paper (Three.js).
 *
 * Production uses the account preference provider; shared viewers use the
 * latest policy returned by the grant read. The browser store below remains
 * a fallback for standalone previews, outside either production provider.
 */
const STORAGE_KEY = "startrips.media-presentation";
export const MEDIA_PRESENTATION_QUERY = "mediaPresentation";

/** The style a link asks for, or null when it asks for none or an unknown one. */
export function mediaPresentationFromSearch(search: string): MediaPresentationStyle | null {
  const value = new URLSearchParams(search).get(MEDIA_PRESENTATION_QUERY);
  return value !== null && MEDIA_PRESENTATION_STYLES.includes(value as MediaPresentationStyle)
    ? value as MediaPresentationStyle
    : null;
}

/** What one activation of the menu entry chooses: the next style, wrapping. */
export function nextMediaPresentationStyle(style: MediaPresentationStyle): MediaPresentationStyle {
  const index = MEDIA_PRESENTATION_STYLES.indexOf(style);
  return MEDIA_PRESENTATION_STYLES[(index + 1) % MEDIA_PRESENTATION_STYLES.length];
}

export function mediaPresentationLabel(style: MediaPresentationStyle): string {
  if (style === "note-overlay") return "图上感想";
  if (style === "book") return "旅程之书";
  if (style === "book-3d") return "立体之书";
  if (style === "stream") return "旅程之流";
  return "默认";
}

const listeners = new Set<() => void>();
let memoryStyle: MediaPresentationStyle | null = null;
// Read once, when the app loads, before any later history change can drop it.
const sharedStyle = typeof window !== "undefined" && isSharedAtlasPathname(window.location.pathname)
  ? mediaPresentationFromSearch(window.location.search) ?? "classic"
  : null;
let linkedStyle = typeof window === "undefined" || sharedStyle !== null
  ? null : mediaPresentationFromSearch(window.location.search);

export function readMediaPresentationStyle(): MediaPresentationStyle {
  if (sharedStyle !== null) return memoryStyle ?? sharedStyle;
  if (linkedStyle) {
    // Adopted silently: this runs while React reads the value, so it must not
    // notify subscribers.
    persistStyle(linkedStyle);
    linkedStyle = null;
  }
  if (memoryStyle) return memoryStyle;
  try {
    return parseMediaPresentationStyle(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return "classic";
  }
}

function persistStyle(style: MediaPresentationStyle): void {
  // Kept in memory as well, so a browser that refuses storage still honours
  // the choice for the rest of this visit.
  memoryStyle = style;
  // Reader recovery may choose a fallback for this visit, without changing
  // either the shared link or the recipient's own preference.
  if (sharedStyle !== null) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, style);
  } catch {
    // Storage blocked: the in-memory value above still applies.
  }
}

export function writeMediaPresentationStyle(style: MediaPresentationStyle): void {
  persistStyle(style);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (sharedStyle !== null || event.key !== STORAGE_KEY) return;
    memoryStyle = null;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useMediaPresentationStyle(): MediaPresentationStyle {
  const access = useMediaPresentationAccess();
  return useSyncExternalStore(
    access ? () => () => undefined : subscribe,
    access ? () => access.style : readMediaPresentationStyle,
    () => access?.style ?? "classic",
  );
}

export function useMediaPresentationRecovery(): (style: MediaPresentationStyle) => void {
  const access = useMediaPresentationAccess();
  return access?.recover ?? writeMediaPresentationStyle;
}

/**
 * The account-menu entry, in the desktop dock and the mobile sheet. One
 * activation moves to the next style; the label names the style in force.
 */
export function MediaPresentationMenuEntry({ surface, onConfirmed }: { surface: "dock" | "sheet"; onConfirmed?: () => void }) {
  const access = useMediaPresentationAccess();
  const style = useMediaPresentationStyle();
  const label = mediaPresentationLabel(style);
  return (
    <button
      type="button"
      data-media-presentation-entry={surface}
      data-media-presentation-value={style}
      disabled={access ? access.busy || (!access.select && !access.error) : false}
      onClick={() => {
        if (!access) {
          onConfirmed?.();
          writeMediaPresentationStyle(nextMediaPresentationStyle(style));
        } else if (access.select) {
          // Release the account modal before a confirmed preference mounts a
          // different reader. A rejected save retains its previous presentation.
          void access.select(nextMediaPresentationStyle(style), onConfirmed);
        } else access.retry();
      }}
    >
      <span>媒体呈现</span><small role={access?.error ? "status" : undefined}>{access?.busy ? "请稍候…" : access?.error || label}</small>
    </button>
  );
}
