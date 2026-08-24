import { flushSync } from "react-dom";
import { prefersReducedMotion } from "../preferences";

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => {
    finished: Promise<void>;
  };
};

/**
 * ML-04 Shared-Element Morph.
 *
 * Morphs the clicked journey rail card into the active journey card using the
 * View Transitions API. The rail card carries the `journey-card` view name in
 * the old snapshot, and the active card carries it in the new snapshot, so the
 * browser interpolates geometry between the two. Falls back to a plain state
 * update when the API or reduced motion is unavailable.
 */
export function morphJourneyCard(
  source: HTMLElement | null,
  hasExistingActiveCard: boolean,
  update: () => void,
): void {
  const doc = document as ViewTransitionDocument;
  if (
    !doc.startViewTransition
    || prefersReducedMotion()
    || (!source && !hasExistingActiveCard)
  ) {
    update();
    return;
  }
  if (!hasExistingActiveCard && source) {
    source.style.viewTransitionName = "journey-card";
  }
  const transition = doc.startViewTransition(() => {
    // The new snapshot must not contain the source card's view name twice.
    if (source) source.style.viewTransitionName = "";
    flushSync(update);
  });
  void transition.finished.catch(() => undefined);
}

/**
 * #18 Shared-Element Transition.
 *
 * Runs a state update inside `startViewTransition` so the browser morphs one
 * element into another. The caller sets `viewTransitionName` on the source
 * element before calling (old snapshot), and the new snapshot must contain an
 * element with the same name (e.g. the story hero or fullscreen stage).
 *
 * Rules:
 * - one active shared element at a time;
 * - reduced motion falls back to a plain update (short crossfade handled by
 *   CSS);
 * - the returned finish promise is swallowed so a cancelled transition never
 *   rejects the caller.
 *
 * The transition never remounts the WebGL scene — it only wraps a React state
 * update.
 */
export function runSharedElementTransition(
  update: () => void,
): void {
  const doc = typeof document === "undefined"
    ? undefined
    : document as ViewTransitionDocument;
  if (!doc?.startViewTransition || prefersReducedMotion()) {
    update();
    return;
  }
  const transition = doc.startViewTransition(() => {
    flushSync(update);
  });
  void transition.finished.catch(() => undefined);
}
