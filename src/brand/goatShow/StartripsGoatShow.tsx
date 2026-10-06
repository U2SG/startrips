import { useEffect, useId, useMemo, useRef } from "react";
import { createSignatureFrameRuntime } from "../startripsSignatureRuntime";
import type { StartripsSignatureEndStatus } from "../StartripsSignatureMotion";
import { DUR, attrs, frame, svg, type GoatShowState } from "./goatShowEngine";

// The show's stage: 20 units left of the wordmark and 175 units above it, so
// the climb onto the column has room. The wordmark's own viewBox is
// "0 -125 780 176", so one wordmark pixel is size / 176 units here as well.
const VIEWBOX = "-20 -300 820 360";
const WORDMARK_HEIGHT = 176;
const LISTENER_COUNT = 4;

function applyFrame(parts: Map<string, Element>, state: GoatShowState) {
  const values = attrs(state);
  for (const [part, value] of Object.entries(values)) parts.get(part)?.setAttribute("transform", value);
  parts.get("notch")?.setAttribute("height", String(Math.round(state.trips.notch * 1000) / 1000));
}

/**
 * The goat show that plays when the Atlas wordmark is clicked: the goat leaps
 * onto "trips", tips it into a column, boops the star into a halo, rides the
 * column back down and leaps home into the lockup. Decorative only.
 *
 * It sits exactly over the static wordmark (same baseline and scale) and
 * deliberately draws above and beyond it. It runs on the shared signature
 * frame runtime, so a hidden or offscreen page suspends it, any pointerdown or
 * keydown settles it to the rest lockup, and reduced motion never plays it.
 */
export function StartripsGoatShow({ size, onEnd }: {
  size: number;
  /** Called once when the show settles, is interrupted, or is reduced. */
  onEnd?: (status: StartripsSignatureEndStatus) => void;
}) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;
  // useId output contains characters that are not safe in url(#…).
  const clipId = `startrips-goat-show-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const markup = useMemo(
    () => svg("startrips-goat-show__svg", frame(0), VIEWBOX, "", clipId).replaceAll('class="goat-fill"', 'fill="currentColor"'),
    [clipId],
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const parts = new Map<string, Element>();
    root.querySelectorAll("[data-part]").forEach((element) => {
      parts.set(element.getAttribute("data-part") ?? "", element);
    });
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    let inViewport = true;
    let visible = !document.hidden;
    let ended = false;

    const runtime = createSignatureFrameRuntime({
      durationMs: DUR,
      loop: false,
      sample: frame,
      reduced: media.matches,
      scheduler: {
        now: () => performance.now(),
        requestFrame: (callback) => requestAnimationFrame(callback),
        cancelFrame: (id) => cancelAnimationFrame(id),
      },
      onPose: (state) => applyFrame(parts, state),
      onState: (state) => {
        root.dataset.signatureStatus = state.status;
        root.dataset.signatureDriverCount = String(state.driverCount);
        root.dataset.signatureListenerCount = String(LISTENER_COUNT);
        root.dataset.signatureElapsedMs = state.elapsedMs.toFixed(1);
        root.dataset.signatureClipDurationMs = String(DUR);
        if (state.status !== "running" && state.status !== "suspended" && !ended) {
          ended = true;
          onEndRef.current?.(state.status);
        }
      },
    });

    const syncSuspension = () => runtime.setSuspended(!visible || !inViewport);
    const interrupt = () => runtime.interrupt();
    const visibility = () => {
      visible = !document.hidden;
      syncSuspension();
    };
    const reduced = () => runtime.setReduced(media.matches);
    const observer = new IntersectionObserver((entries) => {
      inViewport = entries[0]?.isIntersecting ?? true;
      syncSuspension();
    }, { threshold: 0.01 });

    observer.observe(root);
    window.addEventListener("pointerdown", interrupt, { capture: true });
    window.addEventListener("keydown", interrupt, { capture: true });
    document.addEventListener("visibilitychange", visibility);
    media.addEventListener("change", reduced);

    syncSuspension();
    runtime.start();

    return () => {
      runtime.dispose();
      observer.disconnect();
      window.removeEventListener("pointerdown", interrupt, { capture: true });
      window.removeEventListener("keydown", interrupt, { capture: true });
      document.removeEventListener("visibilitychange", visibility);
      media.removeEventListener("change", reduced);
    };
  }, [markup]);

  const units = (value: number) => (value * size) / WORDMARK_HEIGHT;
  return (
    <span
      ref={rootRef}
      className="startrips-goat-show"
      aria-hidden="true"
      style={{ left: units(-20), top: units(-175), width: units(820), height: units(360) }}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
