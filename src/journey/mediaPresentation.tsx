import { useSyncExternalStore } from "react";
import "../styles/journey-reader.css";

/**
 * #393 device trial: how Story presents a Journey's photos, videos and notes.
 *
 * - `classic`: the existing Story media stage, unchanged.
 * - `note-overlay`: the existing stage, with the Route Point note revealed
 *   over the picture instead of below it.
 * - `book`: the Journey Book reader, which opens in place of Story.
 * - `stream`: the Journey Stream reader (after Undertow), in place of Story.
 *
 * This is a per-device trial switch, not an account preference: it lives in
 * this browser only so the variants can be compared on a real device and
 * removed once one of them is chosen. Missing or unreadable storage means
 * `classic`, never a guess.
 *
 * A link may carry `?mediaPresentation=<style>`: opening it adopts that style
 * on this device. It is the only way to switch where the account menu is not
 * available, such as a guest share link.
 */
export type MediaPresentationStyle = "classic" | "note-overlay" | "book" | "stream";

export const MEDIA_PRESENTATION_STYLES: readonly MediaPresentationStyle[] = ["classic", "note-overlay", "book", "stream"];

const STORAGE_KEY = "startrips.media-presentation";
export const MEDIA_PRESENTATION_QUERY = "mediaPresentation";

/** The style a link asks for, or null when it asks for none or an unknown one. */
export function mediaPresentationFromSearch(search: string): MediaPresentationStyle | null {
  const value = new URLSearchParams(search).get(MEDIA_PRESENTATION_QUERY);
  return value !== null && MEDIA_PRESENTATION_STYLES.includes(value as MediaPresentationStyle)
    ? value as MediaPresentationStyle
    : null;
}

export function parseMediaPresentationStyle(value: unknown): MediaPresentationStyle {
  return MEDIA_PRESENTATION_STYLES.includes(value as MediaPresentationStyle)
    ? value as MediaPresentationStyle
    : "classic";
}

/** What one activation of the menu entry chooses: the next style, wrapping. */
export function nextMediaPresentationStyle(style: MediaPresentationStyle): MediaPresentationStyle {
  const index = MEDIA_PRESENTATION_STYLES.indexOf(style);
  return MEDIA_PRESENTATION_STYLES[(index + 1) % MEDIA_PRESENTATION_STYLES.length];
}

export function mediaPresentationLabel(style: MediaPresentationStyle): string {
  if (style === "note-overlay") return "图上感想";
  if (style === "book") return "旅程之书";
  if (style === "stream") return "旅程之流";
  return "默认";
}

const listeners = new Set<() => void>();
let memoryStyle: MediaPresentationStyle | null = null;
// Read once, when the app loads, before any later history change can drop it.
let linkedStyle = typeof window === "undefined" ? null : mediaPresentationFromSearch(window.location.search);

function readStoredStyle(): MediaPresentationStyle {
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
    if (event.key !== STORAGE_KEY) return;
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
  return useSyncExternalStore(subscribe, readStoredStyle, () => "classic");
}

/**
 * The account-menu entry, in the desktop dock and the mobile sheet. One
 * activation moves to the next style; the label names the style in force.
 */
export function MediaPresentationMenuEntry({ surface }: { surface: "dock" | "sheet" }) {
  const style = useMediaPresentationStyle();
  const label = mediaPresentationLabel(style);
  return (
    <button
      type="button"
      data-media-presentation-entry={surface}
      data-media-presentation-value={style}
      onClick={() => writeMediaPresentationStyle(nextMediaPresentationStyle(style))}
    >
      {surface === "sheet"
        ? <><span>媒体呈现</span><small>{label}（本机试用）</small></>
        : <>媒体呈现：{label}</>}
    </button>
  );
}
