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
import { REVEAL_RENDER_BUDGET, RENDERER_MAX_PIXELS, resolveRevealBudget } from "./revealBudget";
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
        maxPixels: RENDERER_MAX_PIXELS,
        maxTextureSize: budget.maxTextureSize,
      });
    } catch (error) {
      // The WebGL2 probe can succeed and the real renderer still fail to be
      // built - a rejected option, a compile error, a context allocation the
      // driver refuses. A second `request` event would be ignored here (the
      // lifecycle already owns this revision), so this settles explicitly.
      publish(
        coverRevealReducer(requested, {
          type: "renderer-failed",
          revision,
          reason: (error as Error).message,
        }),
        imageRef.current,
      );
      return undefined;
    }
    flowRef.current = flow;
    publish(requested, flow.canvas);

    /** Release the renderer and its context. Safe to call more than once. */
    const release = () => {
      if (flow.disposed) return;
      const context = flow.canvas.getContext("webgl2");
      flow.dispose();
      context?.getExtension("WEBGL_lose_context")?.loseContext();
      if (flowRef.current === flow) flowRef.current = null;
    };

    const dispatch = (event: Parameters<typeof coverRevealReducer>[1]) => {
      // A load failure and a lost renderer both have nothing left to paint, so
      // the renderer goes away before the state that mounts the original-cover
      // image is published. Only while the renderer still owns the screen,
      // though: the same guard the lifecycle applies. Disposing after a reveal
      // has settled would detach the canvas still showing the finished cover
      // without publishing anything to replace it.
      const owning = stateRef.current.phase === "preparing"
        || stateRef.current.phase === "revealing";
      if (owning && (event.type === "failed" || event.type === "renderer-failed")) release();
      // A released renderer's canvas is detached and unpainted, so it is not a
      // surface any caller should be handed.
      publish(coverRevealReducer(stateRef.current, event), flow.disposed ? null : flow.canvas);
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
    // The vendored renderer pauses on `webglcontextlost` and, on restoration,
    // repaints without restarting playback - so an unhandled context loss would
    // strand the viewer on a partial reveal frame forever. #367 settles renderer
    // failure and context loss on the original cover instead.
    const onWarning = (event: Event) => {
      const detail = (event as CustomEvent<{ message: string }>).detail;
      dispatch({ type: "renderer-failed", revision, reason: detail.message });
    };
    flow.addEventListener("images", onImages);
    flow.addEventListener("warning", onWarning);
    flow.addEventListener("progress", onProgress);
    flow.addEventListener("complete", onComplete);
    flow.addEventListener("error", onError);

    // The renderer pauses itself when the tab is hidden but never restarts, so
    // without this the reveal would sit forever on a half-dissolved generated
    // image - exactly the state the canonical cover is supposed to replace.
    const onVisibility = () => {
      if (document.hidden || flow.disposed) return;
      if (stateRef.current.phase !== "revealing" || flow.playing) return;
      void flow.resume().catch(() => {
        // If playback cannot be restarted, end honestly on the cover rather
        // than leaving the generated image on screen.
        if (flow.disposed) return;
        flow.seek(1);
        dispatch({ type: "complete", revision });
      });
    };
    document.addEventListener("visibilitychange", onVisibility);

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
      flow.removeEventListener("warning", onWarning);
      flow.removeEventListener("progress", onProgress);
      flow.removeEventListener("complete", onComplete);
      flow.removeEventListener("error", onError);
      document.removeEventListener("visibilitychange", onVisibility);
      release();
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

  // Derived from the lifecycle, not from a ref: these are exactly the settle
  // reasons that have no painted canvas to show the cover on.
  const showsImage = state.phase === "settled"
    && (state.settleReason === "reduced-motion"
      || state.settleReason === "no-webgl2"
      || state.settleReason === "load-failed"
      || state.settleReason === "renderer-failed");

  return (
    <div
      ref={containerRef}
      className={className}
      data-cover-reveal-phase={state.phase}
      data-cover-reveal-degraded={state.degraded ? "true" : "false"}
      data-cover-reveal-settle-reason={state.settleReason ?? ""}
      data-cover-reveal-budget-pixels={budgetPixels ?? ""}
      data-cover-reveal-max-pixels={REVEAL_RENDER_BUDGET.maxDrawingBufferPixels}
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
