export type MediaPresentationStyle = "classic" | "note-overlay" | "book" | "book-3d" | "stream";

export const MEDIA_PRESENTATION_STYLES: readonly MediaPresentationStyle[] = ["classic", "note-overlay", "book", "book-3d", "stream"];

export function isMediaPresentationStyle(value: unknown): value is MediaPresentationStyle {
  return MEDIA_PRESENTATION_STYLES.includes(value as MediaPresentationStyle);
}

export function parseMediaPresentationStyle(value: unknown): MediaPresentationStyle {
  return isMediaPresentationStyle(value) ? value : "classic";
}
