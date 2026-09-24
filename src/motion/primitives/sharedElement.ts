import { flushSync } from "react-dom";
import { onMotionPreferenceChange, prefersReducedMotion } from "../preferences";

type ViewTransitionHandle = {
  ready: Promise<void>;
  finished: Promise<void>;
  skipTransition: () => void;
};

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => ViewTransitionHandle;
};

let activeCardTransition: ViewTransitionHandle | null = null;

function skipActiveCardTransition() {
  const transition = activeCardTransition;
  activeCardTransition = null;
  transition?.skipTransition();
}

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
  skipActiveCardTransition();
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
  activeCardTransition = transition;
  // Skipping an obsolete snapshot rejects ready independently of finished.
  void transition.ready.catch(() => undefined);
  const clearTransition = () => {
    if (activeCardTransition === transition) activeCardTransition = null;
  };
  void transition.finished.then(clearTransition, clearTransition);
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
  void transition.ready.catch(() => undefined);
  void transition.finished.catch(() => undefined);
}
export type SharedElementMorphOptions = {
  source: HTMLElement | null;
  resolveTarget: () => HTMLElement | null;
  update: () => void;
  /** Called after the destination is committed, before it can paint. */
  afterUpdate?: () => void;
  name: string;
  durationMs?: number;
  /** A signed video read/seek can take longer than the geometry animation. */
  readinessTimeoutMs?: number;
  /** Keep a decoded snapshot while an asynchronous media target seeks even
   * when the viewer requests reduced motion. No geometry animation runs. */
  holdSnapshotForReducedMotion?: boolean;
  /** The destination's picture bounds before it is decoded. Used only by the
   * reduced-motion snapshot so it can fill the new stage while waiting. */
  resolvePendingTargetBounds?: () => DOMRect | null;
  /** Keep the source while an asynchronous target is loading, only for as
   * long as the caller's original destination is still the current intent. */
  isTargetCurrent?: () => boolean;
  /** Presentation-only geometry may be created for a handoff. Tie its lifetime
   * to this morph owner rather than introducing a second cleanup timer. */
  onCleanup?: () => void;
  /** Other pixels representing the source frame must leave with the source. */
  claimSource?: () => HTMLElement | readonly HTMLElement[] | null;
  /**
   * #489 C/V6: the destination that is not presentable YET. `update()` reveals
   * the destination surface, and its picture starts painting the moment the
   * browser decodes it - which is before the readiness attribute that lets
   * `resolveTarget` claim it. The recorded reveal-then-hide-then-smaller-reopen
   * is exactly that window: the final picture painted at its final geometry,
   * then this primitive hid it and flew a clone in from the source. Returning
   * the destination's own element here lets the morph own it from the update
   * onwards, so it never paints ahead of the handoff. Kept resolvable on
   * purpose: the claim suppresses painting without making `canPresent` reject
   * it, so the morph still lands on it.
   */
  claimDestination?: () => HTMLElement | readonly HTMLElement[] | null;
};

let cancelActiveMorph: (() => void) | null = null;

export function cancelSharedElementMorph(): void {
  cancelActiveMorph?.();
}

/**
 * #18 complete shared-element primitive.
 *
 * Owns one source clone and one destination, rather than a document snapshot.
 * The Atlas card has its own view-transition-name; a document transition here
 * would also lift that whole card above the Story's blurred backdrop. Keep
 * View Transitions for morphJourneyCard, and use an element-only handoff here.
 */
type MorphScrollContainer = { contains: (node: Node | null) => boolean };

/**
 * #429: a scroll only invalidates a live morph when it can actually move the
 * geometry being interpolated - the document scroller, or a scroll container
 * that holds the source or the already-resolved target. A scroll inside an
 * unrelated subtree cannot. The Route Point context panel owns its own
 * `overflow-y` and, in the compact layout where its content exceeds the
 * panel's max height, a scroll event is routinely still queued when its entry
 * is clicked; that scroll would otherwise reach the capture-phase listener and
 * destroy the observation aperture the same click just published.
 */
export function scrollInvalidatesSharedElementMorph(
  scrolled: MorphScrollContainer | null,
  documentScroller: boolean,
  source: Node,
  target: Node | null,
): boolean {
  if (documentScroller) return true;
  if (!scrolled) return false;
  return scrolled.contains(source) || (target !== null && scrolled.contains(target));
}

export function runSharedElementMorph({
  source,
  resolveTarget,
  update,
  afterUpdate,
  name,
  durationMs = 560,
  readinessTimeoutMs = durationMs,
  holdSnapshotForReducedMotion = false,
  resolvePendingTargetBounds,
  isTargetCurrent,
  onCleanup,
  claimSource,
  claimDestination,
}: SharedElementMorphOptions): () => void {
  // A rail-to-card snapshot may still be above the document when Story opens.
  // End that snapshot before the media clone takes ownership of the handoff.
  skipActiveCardTransition();
  // A close or a newer selection always wins, including non-animated updates.
  // Never discard the user's state update because an older morph is active.
  cancelActiveMorph?.();
  let externalCleanupDone = false;
  const cleanupExternal = () => {
    if (externalCleanupDone) return;
    externalCleanupDone = true;
    onCleanup?.();
  };
  const updateWithoutMorph = () => {
    try {
      if (afterUpdate) flushSync(update);
      else update();
      afterUpdate?.();
    } finally { cleanupExternal(); }
  };
  const reducedMotion = prefersReducedMotion();
  if (!source || typeof document === "undefined" || (reducedMotion && !holdSnapshotForReducedMotion)) {
    updateWithoutMorph();
    return () => undefined;
  }
  const sourceRect = mediaRect(source);
  if (!canPresent(source, sourceRect) || typeof source.cloneNode !== "function") {
    updateWithoutMorph();
    return () => undefined;
  }

  const clone = snapshotSource(source);
  if (!clone) {
    updateWithoutMorph();
    return () => undefined;
  }
  // A clone must never resolve as the destination or enter keyboard focus.
  for (const node of [clone, ...clone.querySelectorAll<HTMLElement>("*")]) {
    node.removeAttribute("id");
    node.removeAttribute("data-shared-media-id");
    node.removeAttribute("data-shared-journey-cover");
    node.removeAttribute("role");
    node.setAttribute("tabindex", "-1");
    node.style.viewTransitionName = "none";
  }
  clone.dataset.sharedElementClone = name;
  clone.setAttribute("aria-hidden", "true");
  clone.inert = true;
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
    // mediaRect already removes contain letterboxing. Cover works at that
    // aspect ratio and also recreates the crop when returning to a card.
    objectFit: computed.objectFit === "contain" || computed.objectFit === "scale-down" ? "cover" : computed.objectFit,
    objectPosition: computed.objectPosition,
    borderRadius: computed.borderRadius,
    transform: "none",
    transformOrigin: "top left",
    boxSizing: "border-box",
  });
  document.body.appendChild(clone);

  const previousSourceVisibility = source.style.visibility;
  source.style.visibility = "hidden";
  let target: HTMLElement | null = null;
  let previousTargetVisibility = "";
  const claimed = new Map<HTMLElement, { opacity: string; pageId: string | undefined }>();
  let animation: Animation | null = null;
  let observer: MutationObserver | null = null;
  let readinessTimer = 0;
  let stopMotionPreference: () => void = () => undefined;
  let settled = false;
  const claimNodes = (nodes: HTMLElement | readonly HTMLElement[] | null | undefined) => {
    for (const element of nodes ? (nodes instanceof HTMLElement ? [nodes] : nodes) : []) {
      if (!element.isConnected) continue;
      if (!claimed.has(element)) claimed.set(element, {
        opacity: element.style.opacity, pageId: element.dataset.mediaPageId,
      });
      if (element.style.opacity !== "0") element.style.opacity = "0";
    }
  };
  claimNodes(claimSource?.());
  const releaseClaim = () => {
    for (const [element, original] of claimed) {
      if (element.dataset.mediaPageId === original.pageId) element.style.opacity = original.opacity;
      else element.style.removeProperty("opacity");
    }
    claimed.clear();
  };
  /** Own the destination before it can paint, not after it already has. */
  const claimPendingDestination = () => {
    if (settled || !claimDestination) return;
    claimNodes(claimDestination());
  };
  const positionReducedSnapshot = () => {
    if (!reducedMotion || !resolvePendingTargetBounds) return;
    const bounds = resolvePendingTargetBounds();
    if (!bounds || !hasRenderableRect(bounds)) return;
    const scale = Math.min(bounds.width / sourceRect.width, bounds.height / sourceRect.height);
    const width = sourceRect.width * scale;
    const height = sourceRect.height * scale;
    const cssPx = (value: number) => `${Math.round(value * 100) / 100}px`;
    const geometry = {
      left: cssPx(bounds.left + (bounds.width - width) / 2),
      top: cssPx(bounds.top + (bounds.height - height) / 2),
      width: cssPx(width), height: cssPx(height),
    };
    for (const key of ["left", "top", "width", "height"] as const) {
      if (clone.style[key] !== geometry[key]) clone.style[key] = geometry[key];
    }
  };
  const cleanup = () => {
    if (settled) return;
    settled = true;
    window.clearTimeout(readinessTimer);
    observer?.disconnect();
    stopMotionPreference();
    animation?.cancel();
    if (source.style.visibility === "hidden") source.style.visibility = previousSourceVisibility;
    if (target?.style.visibility === "hidden") target.style.visibility = previousTargetVisibility;
    releaseClaim();
    clone.remove();
    window.removeEventListener("resize", cleanup);
    window.removeEventListener("orientationchange", cleanup);
    window.removeEventListener("blur", cleanup);
    document.removeEventListener("scroll", onScroll, true);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    if (cancelActiveMorph === cleanup) cancelActiveMorph = null;
    cleanupExternal();
  };
  const onVisibilityChange = () => { if (document.hidden) cleanup(); };
  const onScroll = (event: Event) => {
    const scrolled = event.target;
    if (scrollInvalidatesSharedElementMorph(
      scrolled instanceof Element ? scrolled : null,
      scrolled === document || scrolled === document.scrollingElement,
      source,
      target,
    )) cleanup();
  };
  const advance = () => {
    if (settled) return;
    if (isTargetCurrent && !isTargetCurrent()) {
      cleanup();
      return;
    }
    claimNodes(claimSource?.());
    claimPendingDestination();
    const candidate = resolveTarget();
    if (target) {
      if (candidate !== target || !target.isConnected) cleanup();
      return;
    }
    const targetRect = candidate ? mediaRect(candidate) : null;
    if (!candidate || !targetRect || !canPresent(candidate, targetRect)) {
      if (!isTargetCurrent) cleanup();
      else {
        claimPendingDestination();
        positionReducedSnapshot();
      }
      return;
    }
    target = candidate;
    window.clearTimeout(readinessTimer);
    previousTargetVisibility = target.style.visibility;
    // The claimed page and the target stay visually suppressed until the clone
    // finishes. A live video must not paint or accept native input under it.
    target.style.visibility = "hidden";
    if (reducedMotion) { cleanup(); return; }
    if (typeof clone.animate !== "function") {
      cleanup();
      return;
    }
    const framesFor = (destination: DOMRect) => [
        { left: `${sourceRect.left}px`, top: `${sourceRect.top}px`,
          width: `${sourceRect.width}px`, height: `${sourceRect.height}px`, borderRadius: computed.borderRadius },
        { left: `${destination.left}px`, top: `${destination.top}px`,
          width: `${destination.width}px`, height: `${destination.height}px`, borderRadius: getComputedStyle(candidate).borderRadius },
      ];
    try {
      animation = clone.animate(framesFor(targetRect), {
        duration: durationMs, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "forwards",
      });
      void animation.finished.then(cleanup, cleanup);
    } catch {
      cleanup();
    }
  };
  cancelActiveMorph = cleanup;
  window.addEventListener("resize", cleanup);
  window.addEventListener("orientationchange", cleanup);
  window.addEventListener("blur", cleanup);
  document.addEventListener("scroll", onScroll, true);
  document.addEventListener("visibilitychange", onVisibilityChange);
  stopMotionPreference = onMotionPreferenceChange((reduced) => { if (reduced) cleanup(); });
  // Waiting for a destination is bounded. Video callers can allow seek/decode
  // longer than the geometry motion and publish a recoverable error first.
  readinessTimer = window.setTimeout(cleanup, readinessTimeoutMs);
  try {
    flushSync(update);
    if (settled) return cleanup;
    // Synchronous, before the browser can paint the commit that just revealed
    // the destination surface.
    claimPendingDestination();
    afterUpdate?.();
    observer = new MutationObserver(advance);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ["data-shared-media-id", "data-media-page-id", "data-media-page-ready", "data-media-incoming", "data-video-handoff-ready", "role", "hidden", "aria-hidden", "src", "style", "class"] });
    advance();
  } catch (error) {
    cleanup();
    throw error;
  }
  return cleanup;
}

function snapshotSource(source: HTMLElement): HTMLElement | null {
  if (source instanceof HTMLVideoElement) {
    if (source.readyState < 2 || !source.videoWidth || !source.videoHeight) return null;
    const canvas = document.createElement("canvas");
    canvas.width = source.videoWidth;
    canvas.height = source.videoHeight;
    try {
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.drawImage(source, 0, 0);
      return canvas;
    } catch { return null; }
  }
  const clone = source.cloneNode(true) as HTMLElement;
  if (source instanceof HTMLImageElement && clone instanceof HTMLImageElement) {
    clone.removeAttribute("srcset");
    clone.src = source.currentSrc || source.src;
  }
  return clone;
}

/** Contained photos have letterboxing in their DOM box; hand off at the pixels,
 * otherwise a cover-cropped clone would snap when the real image is revealed. */
function mediaRect(element: HTMLElement): DOMRect {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const width = element instanceof HTMLImageElement ? element.naturalWidth
    : element instanceof HTMLVideoElement ? element.videoWidth : 0;
  const height = element instanceof HTMLImageElement ? element.naturalHeight
    : element instanceof HTMLVideoElement ? element.videoHeight : 0;
  if (!width || !height || (style.objectFit !== "contain" && style.objectFit !== "scale-down")) return rect;
  const scale = Math.min(rect.width / width, rect.height / height, style.objectFit === "scale-down" ? 1 : Infinity);
  const paintedWidth = width * scale, paintedHeight = height * scale;
  const [x = "50%", y = "50%"] = style.objectPosition.split(/\s+/);
  const offset = (value: string, space: number) => value.endsWith("%") ? space * Number.parseFloat(value) / 100
    : value === "center" ? space / 2 : value === "right" || value === "bottom" ? space
      : Number.parseFloat(value) || 0;
  return new DOMRect(rect.left + offset(x, rect.width - paintedWidth), rect.top + offset(y, rect.height - paintedHeight), paintedWidth, paintedHeight);
}

function canPresent(element: HTMLElement, rect: DOMRect) {
  if (element instanceof HTMLImageElement && (!element.complete || !element.naturalWidth)) return false;
  if (element instanceof HTMLVideoElement && element.readyState < 2) return false;
  // The visible Atlas card content is aria-hidden because its hit-area button
  // supplies the accessible name. ARIA exclusion does not mean unpainted.
  return element.isConnected && !element.closest("[hidden]")
    && getComputedStyle(element).visibility !== "hidden"
    && hasRenderableRect(rect) && isViewportVisible(rect);
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
