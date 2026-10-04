import { useCallback, useEffect, useReducer, useRef } from "react";
import { prefersReducedMotion } from "../motion/preferences";
import { StartripsWordmark, type StartripsBrandState } from "./StartripsBrandMark";
import { StartripsSignatureMotion } from "./StartripsSignatureMotion";
import { SIGNATURE_MOMENT_FADE_MS, signatureMomentReducer, type SignatureMomentPhase } from "./signatureMoment";

export function useStartripsSignatureMoment() {
  const [phase, dispatch] = useReducer(signatureMomentReducer, "idle");

  useEffect(() => {
    if (phase !== "leaving") return;
    const timeout = window.setTimeout(() => dispatch({ type: "faded" }), SIGNATURE_MOMENT_FADE_MS);
    return () => window.clearTimeout(timeout);
  }, [phase]);

  // The preference is read at play time so a change made since mount is
  // honoured; a change during playback is handled by the clip runtime, which
  // settles as `reduced` and ends the moment.
  const play = useCallback(() => dispatch({ type: "play", reducedMotion: prefersReducedMotion() }), []);
  const end = useCallback(() => dispatch({ type: "end" }), []);
  const release = useCallback(() => dispatch({ type: "release" }), []);

  return { phase, play, end, release };
}

/**
 * The Atlas wordmark as a control: activating it plays the `full` clip once,
 * in place, over the exact same geometry (both share the v12 viewBox), so the
 * mark itself comes alive without a takeover, backdrop or layout change. The
 * static art is hidden only while the clip runs; any pointerdown/keydown
 * (including Escape) or the clip's own end settles to the rest pose, which is
 * the static mark, and fades the overlay out.
 */
export function StartripsWordmarkSignatureButton({ size, state }: {
  size: number;
  state: StartripsBrandState;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { phase, play, end } = useStartripsSignatureMoment();
  const handleEnd = useCallback(() => {
    end();
    // Focus normally never left the button. If the platform did not focus it
    // on click (Safari), hand focus back rather than leaving it on <body>.
    const button = buttonRef.current;
    const active = document.activeElement;
    if (button?.isConnected && (!active || active === document.body)) button.focus({ preventScroll: true });
  }, [end]);

  return (
    <button
      ref={buttonRef}
      type="button"
      className={`startrips-signature-trigger${phase === "playing" ? " is-signature-playing" : ""}`}
      aria-label="播放 Startrips 动画"
      onClick={play}
    >
      <span className="startrips-signature-trigger__art">
        <StartripsWordmark size={size} state={state} />
        <StartripsSignatureMoment phase={phase} size={size} onEnd={handleEnd} />
      </span>
    </button>
  );
}

/**
 * Decorative overlay for one `full` clip. Mounted only while a moment is
 * active, so no clip runtime, listener or frame exists at rest.
 */
export function StartripsSignatureMoment({ phase, size, className = "", onEnd }: {
  phase: SignatureMomentPhase;
  size: number;
  className?: string;
  onEnd: () => void;
}) {
  if (phase === "idle") return null;
  return (
    <span className={`startrips-signature-moment is-${phase} ${className}`} aria-hidden="true">
      <StartripsSignatureMotion clip="full" size={size} title="" onEnd={onEnd} />
    </span>
  );
}
