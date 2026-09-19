import { useCallback, useMemo, useRef, useState } from "react";
import { CoverRevealStage, type CoverRevealSurface } from "./CoverRevealStage";
import type { CoverRevealState, RevealPresetId } from "./coverRevealFlow";

/**
 * #367 slice 3: a dev-only deterministic harness for the cover reveal.
 *
 * It mounts no product surface. Its job is to make four things observable to
 * `scripts/qa-cover-reveal.mjs` in a real browser: the first painted frame, the
 * final frame, an interruption, and what is left behind after teardown.
 *
 * The image pair is two flat colours generated in the page, so "which image is
 * on screen" is a single sampled pixel rather than an image-diff judgement.
 */
const GENERATED_FIRST_COLOR = { r: 214, g: 74, b: 42 };
const ORIGINAL_COVER_COLOR = { r: 36, g: 92, b: 176 };

function solidImage(color: { r: number; g: number; b: number }): string {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is unavailable in this QA preview.");
  context.fillStyle = `rgb(${color.r},${color.g},${color.b})`;
  context.fillRect(0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

type Sample = { r: number; g: number; b: number } | null;

function sampleSurface(surface: CoverRevealSurface): Sample {
  if (!surface) return null;
  if (surface instanceof HTMLImageElement && !surface.complete) return null;
  const width = surface instanceof HTMLCanvasElement ? surface.width : surface.naturalWidth;
  const height = surface instanceof HTMLCanvasElement ? surface.height : surface.naturalHeight;
  if (!width || !height) return null;
  const probe = document.createElement("canvas");
  probe.width = 1;
  probe.height = 1;
  const context = probe.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  try {
    // Sample the centre. A WebGL drawing buffer without preserveDrawingBuffer
    // is only readable inside the task that painted it, which is why every
    // caller of this helper runs synchronously from a lifecycle publish.
    context.drawImage(surface, Math.floor(width / 2), Math.floor(height / 2), 1, 1, 0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    // An image element can report its dimensions before its pixels are ready,
    // and drawing it then leaves the probe fully transparent. That is "not yet",
    // not "black", so the caller retries rather than recording a false frame.
    if (a === 0) return null;
    return { r, g, b };
  } catch {
    return null;
  }
}

/** Which of the two fixture images a sampled pixel is closest to. */
function classify(sample: Sample): "generated-first" | "original-cover" | "blend" | "none" {
  if (!sample) return "none";
  const distance = (color: { r: number; g: number; b: number }) => (
    Math.abs(sample.r - color.r) + Math.abs(sample.g - color.g) + Math.abs(sample.b - color.b)
  );
  const first = distance(GENERATED_FIRST_COLOR);
  const cover = distance(ORIGINAL_COVER_COLOR);
  if (first <= 24) return "generated-first";
  if (cover <= 24) return "original-cover";
  return "blend";
}

type DebugFrame = {
  phase: CoverRevealState["phase"];
  progress: number;
  sample: Sample;
  image: ReturnType<typeof classify>;
};

type DebugState = {
  phase: CoverRevealState["phase"];
  settleReason: CoverRevealState["settleReason"];
  degraded: boolean;
  reducedMotion: boolean;
  backend: CoverRevealState["backend"];
  frameCount: number;
  progress: number;
  firstFrame: DebugFrame | null;
  lastFrame: DebugFrame | null;
  frames: number;
  mounted: boolean;
  pendingAnimationFrames: number;
  canvasConnected: boolean | null;
  webglContextLost: boolean | null;
};

declare global {
  interface Window {
    __coverRevealDebug?: () => DebugState;
  }
}

export function CoverRevealQaPreview() {
  instrumentAnimationFrames();
  const params = new URLSearchParams(window.location.search);
  const mode = params.get("qaMode");
  // `construct-failure` hands the stage a preset the vendored renderer rejects
  // in the first statement of its constructor, before any canvas exists. That is
  // the deterministic stand-in for a renderer that cannot be built at all even
  // though the WebGL2 probe succeeded.
  const preset = (mode === "construct-failure"
    ? "not-a-supported-preset"
    : params.get("qaPreset") ?? "ink-bloom") as RevealPresetId;

  const pair = useMemo(() => ({
    // `load-failure` points the generated asset at a path that cannot decode,
    // leaving the canonical cover valid - the case where the reveal must hand
    // the viewer the real cover instead of an unpainted canvas.
    generatedFirst: mode === "load-failure"
      ? "/__cover-reveal-qa-missing.png"
      : solidImage(GENERATED_FIRST_COLOR),
    originalCover: solidImage(ORIGINAL_COVER_COLOR),
  }), [mode]);

  const [mounted, setMounted] = useState(true);
  const debugRef = useRef<DebugState>({
    phase: "idle",
    settleReason: null,
    degraded: false,
    reducedMotion: false,
    backend: null,
    frameCount: 0,
    progress: 0,
    firstFrame: null,
    lastFrame: null,
    frames: 0,
    mounted: true,
    pendingAnimationFrames: 0,
    canvasConnected: null,
    webglContextLost: null,
  });
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const handleStateChange = useCallback((state: CoverRevealState, surface: CoverRevealSurface) => {
    if (surface instanceof HTMLCanvasElement) canvasRef.current = surface;
    const debug = debugRef.current;
    debug.phase = state.phase;
    debug.settleReason = state.settleReason;
    debug.degraded = state.degraded;
    debug.reducedMotion = state.reducedMotion;
    debug.backend = state.backend;
    debug.frameCount = state.frameCount;
    debug.progress = state.progress;

    if (state.phase === "revealing" || state.phase === "settled") {
      const sample = sampleSurface(surface);
      if (sample) {
        const frame: DebugFrame = {
          phase: state.phase,
          progress: state.progress,
          sample,
          image: classify(sample),
        };
        debug.frames += 1;
        if (!debug.firstFrame) debug.firstFrame = frame;
        debug.lastFrame = frame;
      }
    }
  }, []);

  // The settled surface in a degraded or reduced-motion run is a plain image
  // element, which only decodes after React has committed it, so its sample is
  // taken on demand rather than during the publish.
  const sampleSettledImage = useCallback(() => {
    const image = document.querySelector<HTMLImageElement>('[data-cover-reveal-image="original-cover"]');
    if (!image) return;
    const sample = sampleSurface(image);
    if (!sample) return;
    const frame: DebugFrame = {
      phase: "settled",
      progress: debugRef.current.progress,
      sample,
      image: classify(sample),
    };
    debugRef.current.frames += 1;
    if (!debugRef.current.firstFrame) debugRef.current.firstFrame = frame;
    debugRef.current.lastFrame = frame;
  }, []);

  window.__coverRevealDebug = () => {
    // Sample the image surface whenever there is no live canvas left to read:
    // after teardown, and after any settle that released the renderer - a
    // failed generated asset leaves a stale, already-removed canvas reference.
    if (!mounted || (debugRef.current.phase === "settled" && !canvasRef.current?.isConnected)) {
      sampleSettledImage();
    }
    const canvas = canvasRef.current;
    return {
      ...debugRef.current,
      mounted,
      pendingAnimationFrames: pendingAnimationFrames(),
      canvasConnected: canvas ? canvas.isConnected : null,
      webglContextLost: canvas ? Boolean(canvas.getContext("webgl2")?.isContextLost()) : null,
    };
  };

  return (
    <main className="living-atlas" data-qa-cover-reveal="true" style={{ background: "#0a0a0a" }}>
      <div style={{ width: 640, height: 400, margin: "24px auto" }}>
        {mounted ? (
          <CoverRevealStage
            pair={pair}
            preset={preset}
            revision={1}
            forceReducedMotion={mode === "reduced-motion" ? true : undefined}
            forceNoWebgl2={mode === "no-webgl2" ? true : undefined}
            onStateChange={handleStateChange}
            className="cover-reveal-qa__stage"
          />
        ) : null}
      </div>
      <button type="button" data-qa-cover-reveal-teardown="true" onClick={() => setMounted(false)}>
        Tear down the reveal
      </button>
    </main>
  );
}

/**
 * Counts animation-frame callbacks that were requested and have neither run nor
 * been cancelled, so a leaked reveal loop keeps this number above zero after
 * teardown.
 *
 * Installed from the component rather than at module scope on purpose. A
 * module-scope patch would run as soon as this module were evaluated and wrap
 * every animation frame the persistent globe and the rest of the product
 * schedule; keeping it inside the component means only the lazily loaded
 * `?qaState=cover-reveal` preview ever instruments anything.
 */
let outstandingAnimationFrames = 0;
let instrumented = false;
const liveHandles = new Set<number>();
const pendingAnimationFrames = () => outstandingAnimationFrames;

function instrumentAnimationFrames() {
  if (instrumented) return;
  instrumented = true;
  const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
  const nativeCancelAnimationFrame = window.cancelAnimationFrame.bind(window);

  window.requestAnimationFrame = (callback: FrameRequestCallback) => {
    const handle = nativeRequestAnimationFrame((time) => {
      if (liveHandles.delete(handle)) outstandingAnimationFrames -= 1;
      callback(time);
    });
    liveHandles.add(handle);
    outstandingAnimationFrames += 1;
    return handle;
  };

  window.cancelAnimationFrame = (handle: number) => {
    if (liveHandles.delete(handle)) outstandingAnimationFrames -= 1;
    nativeCancelAnimationFrame(handle);
  };
}
