import { applyPose } from "../brand/StartripsSignatureMotion";
import { sampleStartripsPullPose, STARTRIPS_PULL_PHASES as P } from "../brand/startripsPullClip";
import { COVER_MARK_TONE } from "./journeyBook3dPainter";
import type { JourneyBook3dScene } from "./journeyBook3dScene";
import { goatPullCoverProgress, goatPullStaging, type MarkFrame } from "./journeyBookGoatPull";

/** The v12 mark's viewBox: 170 × 150 units; the goat's hooves stand at y 0, centred on x 695. */
const MARK_UNITS_WIDE = 170;
const MARK_UNITS_HIGH = 150;
const MARK_CENTRE_X = 695;
/** The goat's muzzle (the v12 `frontMuzzle` ellipse) and the pivots `applyPose` turns the head and the whole goat about. */
const MUZZLE = { cx: 667.7509, cy: -89.0317, rx: 10.3927, ry: 7.1, rotateDeg: 3.2728 } as const;
const HEAD_PIVOT = { x: 682, y: -88 } as const;
const HIND_HOOF = { x: 744, y: 0 } as const;

type Point = { x: number; y: number };

function rotateAbout(point: Point, pivot: Point, degrees: number): Point {
  const angle = (degrees * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = point.x - pivot.x;
  const dy = point.y - pivot.y;
  return { x: pivot.x + dx * cos - dy * sin, y: pivot.y + dx * sin + dy * cos };
}

/**
 * Where the posed goat's muzzle tip is, relative to the point between its
 * hooves, in stage px: the muzzle's centre through the head turn, the lean and
 * the root shift, then out to the ellipse's extreme in the direction the goat
 * faces (`facing` −1 faces the fore-edge, to the right on screen).
 */
function muzzleOffset(pose: ReturnType<typeof sampleStartripsPullPose>, scaleX: number, scaleY: number, facing: number): Point {
  const headed = rotateAbout({ x: MUZZLE.cx, y: MUZZLE.cy }, HEAD_PIVOT, pose.headRotateDeg);
  const leaned = rotateAbout(headed, HIND_HOOF, pose.rootRotateDeg);
  const angle = ((MUZZLE.rotateDeg + pose.headRotateDeg + pose.rootRotateDeg) * Math.PI) / 180;
  const reach = Math.hypot(MUZZLE.rx * Math.cos(angle), MUZZLE.ry * Math.sin(angle));
  const tipX = leaned.x + pose.rootX - reach;
  return { x: scaleX * facing * (tipX - MARK_CENTRE_X), y: scaleY * (leaned.y + pose.rootY) };
}
const STARLIGHT = "#fff8e7";
/** Below upright the cover lies back down when the goat is interrupted; past it, it completes the turn. */
const UPRIGHT = 0.5;

export type GoatPullStatus = "playing" | "released" | "interrupted" | "done";

export type GoatPullFrame = {
  status: GoatPullStatus;
  elapsedMs: number;
  progress: number;
  frame: number;
  /** performance.now() when an input ended the performance. */
  endedAt: number | null;
  /** DEV QA: the muzzle tip as placed, and the cover's fore-edge (head, middle, foot) this frame, in stage px. */
  grip?: Point | null;
  foreEdge?: Point[] | null;
};

export type GoatPull = {
  /** Any input: the goat lets go and leaves at once, the cover returns to the reader from its current angle. */
  interrupt(): void;
  /** QA: hold the performance at `elapsedMs` (scrubbing performances only). */
  scrub(elapsedMs: number): void;
  /** Stop at once with nothing left behind (unmount, a new scene). */
  dispose(): void;
};

function hexChannels(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}
const FROM_TONE = hexChannels(COVER_MARK_TONE);
const TO_TONE = hexChannels(STARLIGHT);

function tone(mix: number): string {
  const [r, g, b] = FROM_TONE.map((from, index) => Math.round(from + (TO_TONE[index] - from) * mix));
  return `rgb(${r} ${g} ${b})`;
}

/**
 * Play the goat pull on a closed front cover. The book's own frame loop runs
 * it (`scene.drive`): each frame the clip sets the cover's angle, the goat's
 * pose and its place, read back from the deformed cover mesh, then the book
 * renders, so the overlay and the paper never disagree by a frame. At
 * `release` the cover is handed to the book's ordinary turn. Any pointer,
 * wheel or key input interrupts it (window capture, ahead of the book's own
 * handlers, so the reader's action proceeds on the released cover).
 */
export function startGoatPull(options: {
  scene: JourneyBook3dScene;
  overlay: SVGSVGElement;
  mark: MarkFrame;
  /** QA: the clock is frozen and moved by `scrub`; the cover is never handed back. */
  scrubbing?: boolean;
  /** The cover now completes its turn to the first spread. */
  onRelease: () => void;
  /** The goat is gone. */
  onEnd: (status: "done" | "interrupted") => void;
  /** An input is about to interrupt the performance (before the book sees it). */
  onInterrupt?: (event: Event) => void;
  onFrame?: (frame: GoatPullFrame) => void;
}): GoatPull {
  const { scene, overlay, mark, scrubbing = false } = options;
  const place = overlay.querySelector<SVGGElement>("[data-goat-place]");
  let status: GoatPullStatus = "playing";
  let scrubMs = 0;
  let elapsed = 0;
  let frame = 0;
  let endedAt: number | null = null;
  let opacity = 0;
  let grip: Point | null = null;

  const foreEdge = () => [0, 0.5, 1].map((v) => scene.coverPoint(1, v)).filter((point): point is Point => point !== null);
  const report = () => options.onFrame?.({
    status, elapsedMs: elapsed, progress: scene.progress, frame, endedAt,
    grip, foreEdge: status === "playing" ? foreEdge() : null,
  });

  function stage(t: number) {
    const staging = goatPullStaging(t, mark);
    const markPx = scene.coverRestPoint(staging.u, mark.y + mark.height).y - scene.coverRestPoint(staging.u, mark.y).y;
    // Its stamp's size on screen (as wide as the mark, as high as the tilted
    // cover shows it), grown by `staging.scale` once awake.
    const scaleY = (markPx / MARK_UNITS_HIGH) * staging.scale;
    const scaleX = ((scene.coverRestPoint(staging.u + mark.width / 2, staging.v).x
      - scene.coverRestPoint(staging.u - mark.width / 2, staging.v).x) / MARK_UNITS_WIDE) * staging.scale;
    const pose = sampleStartripsPullPose(t);
    let { x, y } = scene.coverPoint(staging.u, staging.v) ?? scene.coverRestPoint(staging.u, staging.v);
    const muzzle = muzzleOffset(pose, scaleX, scaleY, staging.facing);
    if (staging.attach > 0) {
      // Gripping, the muzzle hooks the board's fore-edge wherever it is: the
      // goat is placed from the edge, read from the cover's own mesh.
      const edge = scene.coverPoint(1, staging.gripV) ?? scene.coverRestPoint(1, staging.gripV);
      x += (edge.x - muzzle.x - x) * staging.attach;
      y += (edge.y - muzzle.y - y) * staging.attach;
    }
    grip = staging.attach >= 1 && staging.hop === 0 ? { x: x + muzzle.x, y: y + muzzle.y } : null;
    if (staging.hop > 0) {
      const land = scene.coverRestPoint(1 + mark.width, 1);
      x += (land.x - x) * staging.hop;
      y += (land.y - y) * staging.hop - staging.hopLift * markPx;
    }
    applyPose(overlay, pose);
    place?.setAttribute(
      "transform",
      `translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${(scaleX * staging.facing).toFixed(4)} ${scaleY.toFixed(4)}) translate(${-MARK_CENTRE_X} 0)`,
    );
    opacity = staging.opacity;
    overlay.style.opacity = opacity.toFixed(3);
    overlay.style.color = tone(staging.tone);
  }

  function hide() {
    overlay.style.display = "none";
  }

  function stopListening() {
    window.removeEventListener("pointerdown", onInput, { capture: true });
    window.removeEventListener("wheel", onInput, { capture: true });
    window.removeEventListener("keydown", onInput, { capture: true });
  }

  function finish(end: "done" | "interrupted") {
    status = end;
    stopListening();
    hide();
    report();
    options.onEnd(end);
  }

  // The clip advances by the book's own clamped frame step, as its turns do:
  // on a device that drops frames it slows down rather than skipping a tug.
  const driver = (deltaSeconds: number): boolean => {
    if (status !== "playing" && status !== "released") return false;
    elapsed = scrubbing ? scrubMs : elapsed + deltaSeconds * 1000;
    if (status === "playing") {
      if (!scrubbing && elapsed >= P.release) {
        status = "released";
        scene.endDrag(1);
        options.onRelease();
      } else {
        scene.dragTo(goatPullCoverProgress(elapsed), true);
      }
    }
    stage(elapsed);
    frame += 1;
    if (!scrubbing && elapsed >= P.end) {
      finish("done");
      return false;
    }
    report();
    return !scrubbing;
  };

  /**
   * Any input: the goat lets go at once. It leaves the screen in the input's
   * own handler, with no fade, so its release never waits on the book's
   * WebGL frames; the cover is handed back from its current angle.
   */
  function interrupt() {
    if (status !== "playing" && status !== "released") return;
    hide();
    if (status === "playing") {
      if (!scrubbing && scene.progress >= UPRIGHT) {
        scene.endDrag(1);
        options.onRelease();
      } else {
        scene.layDown();
      }
    }
    status = "interrupted";
    endedAt = performance.now();
    scene.drive(null);
    stopListening();
    report();
    options.onEnd("interrupted");
  }

  function onInput(event: Event) {
    if (status !== "playing" && status !== "released") return;
    options.onInterrupt?.(event);
    interrupt();
  }

  window.addEventListener("pointerdown", onInput, { capture: true });
  window.addEventListener("wheel", onInput, { capture: true, passive: true });
  window.addEventListener("keydown", onInput, { capture: true });

  overlay.style.display = "";
  scene.beginDrag();
  // Place the goat over its emboss before the first frame.
  stage(0);
  scene.drive(driver);

  return {
    interrupt,
    scrub(elapsedMs: number) {
      if (!scrubbing || status !== "playing") return;
      scrubMs = Math.max(0, elapsedMs);
      scene.drive(driver);
    },
    dispose() {
      const holding = status === "playing";
      if (holding || status === "released") status = "interrupted";
      stopListening();
      scene.drive(null);
      // Call before the scene is disposed: a held cover is let down.
      if (holding) scene.layDown();
      hide();
    },
  };
}
