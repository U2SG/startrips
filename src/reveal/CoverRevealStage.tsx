import { useCallback, useEffect, useRef, useState } from "react";
import {
  coverRevealReducer,
  initialCoverRevealState,
  planCoverReveal,
  type CoverRevealBackend,
  type CoverRevealImagePair,
  type CoverRevealState,
  type RevealPresetId,
} from "./coverRevealFlow";
import { REVEAL_RENDER_BUDGET, resolveRevealBudget } from "./revealBudget";
import { RevealFlow } from "./vendor/index.js";

/** The surface currently showing the cover: the reveal canvas, or a plain image. */
export type CoverRevealSurface = HTMLCanvasElement | HTMLImageElement | null;

export type CoverRevealStageProps = {
  pair: CoverRevealImagePair;
  preset?: RevealPresetId;
  /**
   * Bumped by the caller whenever the cover or its generated companion changes.
   * Everything the previous revision had in flight stops counting immediately.
   */
  revision: number;
  /** Overrides the media query. Only the dev preview passes this. */
  forceReducedMotion?: boolean;
  /** Pretend WebGL2 is missing, to exercise the honest fallback. */
  forceNoWebgl2?: boolean;
  /**
   * Called synchronously as the lifecycle moves, with the live surface, so a
   * caller can sample the painted frame before the browser composites it.
   */
  onStateChange?: (state: CoverRevealState, surface: CoverRevealSurface) => void;
  className?: string;
};

function detectBackend(): CoverRevealBackend {
  try {
    const probe = document.createElement("canvas");
    const gl = probe.getContext("webgl2");
    return gl ? "webgl2" : "unavailable";
  } catch {
    return "unavailable";
  }
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * #367 slice 3: binds the pure cover reveal lifecycle to the vendored renderer.
 *
 * This component mounts no product surface on its own — it is the reusable
 * piece the Journey opening (a later slice under #367) will hold. It owns three
 * things the lifecycle cannot own by itself: the WebGL2 decision, the render
 * budget passed to the renderer, and complete teardown.
 */
export function CoverRevealStage({
  pair,
  preset = "ink-bloom",
  revision,
  forceReducedMotion,
  forceNoWebgl2,
  onStateChange,
  className,
}: CoverRevealStageProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [budgetPixels, setBudgetPixels] = useState<number | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const stateRef = useRef<CoverRevealState>(initialCoverRevealState);
  const flowRef = useRef<InstanceType<typeof RevealFlow> | null>(null);
  const [state, setState] = useState<CoverRevealState>(initialCoverRevealState);

  // Held in a ref so an inline caller callback cannot re-run the effect and
  // rebuild the renderer on every render.
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;

  const publish = useCallback((next: CoverRevealState, surface: CoverRevealSurface) => {
    if (next === stateRef.current) return;
    stateRef.current = next;
    onStateChangeRef.current?.(next, surface);
    setState(next);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const backend: CoverRevealBackend = forceNoWebgl2 ? "unavailable" : detectBackend();
    const reducedMotion = forceReducedMotion ?? prefersReducedMotion();
    const request = { revision, pair, preset, reducedMotion, backend };
    const plan = planCoverReveal(request);

    stateRef.current = initialCoverRevealState;
    const requested = coverRevealReducer(initialCoverRevealState, { type: "request", request });

    if (plan.mode === "immediate") {
      // No renderer is constructed at all: there is nothing honest to animate.
      publish(requested, imageRef.current);
      return undefined;
    }

    const budget = resolveRevealBudget({
      viewportWidth: container.clientWidth || window.innerWidth,
      viewportHeight: container.clientHeight || window.innerHeight,
      deviceDpr: window.devicePixelRatio || 1,
    });
    setBudgetPixels(budget.drawingBufferPixels);

    let flow: InstanceType<typeof RevealFlow>;
    try {
      flow = new RevealFlow({
        container,
        preset,
        // We own the degraded decision, so never let the renderer silently
        // substitute its Canvas2D cross-fade for a reveal.
        fallback: false,
        respectReducedMotion: true,
        // The caps, not the resolved values: the renderer re-applies exactly
        // this arithmetic whenever its container is resized.
        maxDpr: REVEAL_RENDER_BUDGET.maxDpr,
        maxPixels: REVEAL_RENDER_BUDGET.maxDrawingBufferPixels,
        maxTextureSize: budget.maxTextureSize,
      });
    } catch {
      publish(
        coverRevealReducer(requested, { type: "request", request: { ...request, backend: "unavailable" } }),
        imageRef.current,
      );
      return undefined;
    }
    flowRef.current = flow;
    publish(requested, flow.canvas);

    const dispatch = (event: Parameters<typeof coverRevealReducer>[1]) => {
      publish(coverRevealReducer(stateRef.current, event), flow.canvas);
    };
    const onImages = () => dispatch({ type: "images-loaded", revision });
    const onProgress = (event: Event) => {
      const detail = (event as CustomEvent<{ progress: number }>).detail;
      dispatch({ type: "frame", revision, progress: detail.progress });
    };
    const onComplete = () => dispatch({ type: "complete", revision });
    const onError = (event: Event) => {
      const detail = (event as CustomEvent<{ message: string }>).detail;
      dispatch({ type: "failed", revision, reason: detail.message });
    };
    flow.addEventListener("images", onImages);
    flow.addEventListener("progress", onProgress);
    flow.addEventListener("complete", onComplete);
    flow.addEventListener("error", onError);

    let cancelled = false;
    void (async () => {
      try {
        await flow.setImages(pair.generatedFirst, pair.originalCover);
        if (cancelled || flow.disposed) return;
        await flow.play();
      } catch (error) {
        if (cancelled || flow.disposed) return;
        dispatch({ type: "failed", revision, reason: (error as Error).message });
      }
    })();

    return () => {
      cancelled = true;
      flow.removeEventListener("images", onImages);
      flow.removeEventListener("progress", onProgress);
      flow.removeEventListener("complete", onComplete);
      flow.removeEventListener("error", onError);
      // Hold the context before disposal so the GPU resource can be released
      // explicitly rather than left to collection.
      const gl = flow.canvas.getContext("webgl2");
      flow.dispose();
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
      flowRef.current = null;
    };
  }, [pair, preset, revision, forceReducedMotion, forceNoWebgl2, publish]);

  /** A viewer interruption ends the reveal at the canonical cover, at once. */
  const interrupt = useCallback(() => {
    const flow = flowRef.current;
    if (flow && !flow.disposed) {
      flow.pause();
      flow.seek(1);
    }
    publish(
      coverRevealReducer(stateRef.current, { type: "interrupt", revision }),
      flow?.canvas ?? imageRef.current,
    );
  }, [publish, revision]);

  const showsImage = state.phase === "settled" && !flowRef.current;

  return (
    <div
      ref={containerRef}
      className={className}
      data-cover-reveal-phase={state.phase}
      data-cover-reveal-degraded={state.degraded ? "true" : "false"}
      data-cover-reveal-settle-reason={state.settleReason ?? ""}
      data-cover-reveal-budget-pixels={budgetPixels ?? ""}
      style={{ width: "100%", height: "100%" }}
      onPointerDown={interrupt}
      onKeyDown={(event) => {
        if (event.key === "Escape" || event.key === "Enter" || event.key === " ") interrupt();
      }}
      role="presentation"
    >
      {showsImage ? (
        <img
          ref={imageRef}
          src={pair.originalCover}
          alt=""
          data-cover-reveal-image="original-cover"
          style={{ display: "block", width: "100%", height: "100%", objectFit: "contain" }}
        />
      ) : null}
    </div>
  );
}
