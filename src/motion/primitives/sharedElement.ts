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
 * The transition never remounts the WebGL scene 鈥?it only wraps a React state
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
export type SharedElementMorphOptions = {
  source: HTMLElement | null;
  resolveTarget: () => HTMLElement | null;
  update: () => void;
  name: string;
  durationMs?: number;
};

let sharedElementMorphActive = false;

/**
 * #18 complete shared-element primitive.
 *
 * Uses the View Transitions API when available. Unsupported browsers get a
 * WAAPI fixed-clone/FLIP-style fallback that animates the exact source pixels
 * into the target rect. Reduced-motion intentionally skips the spatial morph
 * and lets the surrounding UI use its short crossfade.
 */
export function runSharedElementMorph({
  source,
  resolveTarget,
  update,
  name,
  durationMs = 560,
}: SharedElementMorphOptions): void {
  const doc = typeof document === "undefined"
    ? undefined
    : document as ViewTransitionDocument;

  if (!source || prefersReducedMotion()) {
    update();
    return;
  }
  // Repeated clicks during one spatial morph are ignored for only the motion
  // window; the rest of the app remains interactive.
  if (sharedElementMorphActive) return;
  sharedElementMorphActive = true;

  const release = () => {
    sharedElementMorphActive = false;
  };

  if (doc?.startViewTransition) {
    let target: HTMLElement | null = null;
    const previousSourceName = source.style.viewTransitionName;
    source.style.viewTransitionName = name;
    const transition = doc.startViewTransition(() => {
      source.style.viewTransitionName = previousSourceName;
      flushSync(update);
      target = resolveTarget();
      if (target) target.style.viewTransitionName = name;
    });
    void transition.finished
      .catch(() => undefined)
      .finally(() => {
        if (target?.style.viewTransitionName === name) {
          target.style.viewTransitionName = "";
        }
        source.style.viewTransitionName = previousSourceName;
        release();
      });
    return;
  }

  runFlipFallback(source, resolveTarget, update, durationMs, release);
}

function runFlipFallback(
  source: HTMLElement,
  resolveTarget: () => HTMLElement | null,
  update: () => void,
  durationMs: number,
  release: () => void,
) {
  const sourceRect = source.getBoundingClientRect();
  if (!hasRenderableRect(sourceRect) || typeof source.cloneNode !== "function") {
    update();
    release();
    return;
  }

  const clone = source.cloneNode(true) as HTMLElement;
  clone.removeAttribute("id");
  clone.setAttribute("aria-hidden", "true");
  const computed = getComputedStyle(source);
  Object.assign(clone.style, {
    position: "fixed",
    zIndex: "2147483000",
    pointerEvents: "none",
    margin: "0",
    left: `${sourceRect.left}px`,
    top: `${sourceRect.top}px`,
    width: `${sourceRect.width}px`,
    height: `${sourceRect.height}px`,
    maxWidth: "none",
    maxHeight: "none",
    objectFit: computed.objectFit,
    objectPosition: computed.objectPosition,
    borderRadius: computed.borderRadius,
    transformOrigin: "top left",
    boxSizing: "border-box",
  });
  document.body.appendChild(clone);

  const previousSourceVisibility = source.style.visibility;
  source.style.visibility = "hidden";
  flushSync(update);
  const target = resolveTarget();
  const targetRect = target?.getBoundingClientRect();
  const previousTargetVisibility = target?.style.visibility ?? "";
  if (target) target.style.visibility = "hidden";

  let animation: Animation | null = null;
  let settled = false;
  const cleanup = () => {
    if (settled) return;
    settled = true;
    source.style.visibility = previousSourceVisibility;
    if (target) target.style.visibility = previousTargetVisibility;
    clone.remove();
    window.removeEventListener("resize", cancelForLayoutChange);
    window.removeEventListener("orientationchange", cancelForLayoutChange);
    release();
  };
  const cancelForLayoutChange = () => {
    animation?.cancel();
    cleanup();
  };
  window.addEventListener("resize", cancelForLayoutChange, { once: true });
  window.addEventListener("orientationchange", cancelForLayoutChange, { once: true });

  if (!targetRect || !hasRenderableRect(targetRect) || !isViewportVisible(targetRect)) {
    if (typeof clone.animate !== "function") {
      cleanup();
      return;
    }
    animation = clone.animate(
      [{ opacity: 1 }, { opacity: 0 }],
      { duration: Math.min(220, durationMs), easing: "ease-out", fill: "forwards" },
    );
  } else if (typeof clone.animate === "function") {
    animation = clone.animate([
      {
        left: `${sourceRect.left}px`,
        top: `${sourceRect.top}px`,
        width: `${sourceRect.width}px`,
        height: `${sourceRect.height}px`,
        borderRadius: computed.borderRadius,
        opacity: 1,
      },
      {
        left: `${targetRect.left}px`,
        top: `${targetRect.top}px`,
        width: `${targetRect.width}px`,
        height: `${targetRect.height}px`,
        borderRadius: target ? getComputedStyle(target).borderRadius : computed.borderRadius,
        opacity: 1,
      },
    ], {
      duration: durationMs,
      easing: "cubic-bezier(0.16, 1, 0.3, 1)",
      fill: "forwards",
    });
  }

  if (!animation) {
    cleanup();
    return;
  }
  void animation.finished.catch(() => undefined).finally(cleanup);
}

function hasRenderableRect(rect: DOMRect) {
  return rect.width > 1 && rect.height > 1;
}

function isViewportVisible(rect: DOMRect) {
  return rect.right > 0
    && rect.bottom > 0
    && rect.left < window.innerWidth
    && rect.top < window.innerHeight;
}
