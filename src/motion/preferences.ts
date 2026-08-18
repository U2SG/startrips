export const MOTION_REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && window.matchMedia(MOTION_REDUCED_QUERY).matches;
}

export function onMotionPreferenceChange(
  callback: (reduced: boolean) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const media = window.matchMedia(MOTION_REDUCED_QUERY);
  const handler = () => callback(media.matches);
  media.addEventListener("change", handler);
  return () => media.removeEventListener("change", handler);
}
