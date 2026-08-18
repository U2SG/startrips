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
