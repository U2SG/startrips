import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "../preferences";

type CountUpProps = {
  value: number;
  /** Value to start counting from on first render; defaults to `value`
   *  so the number only animates on later changes. */
  initialValue?: number;
  duration?: number;
  format?: (value: number) => string;
};

/**
 * ML-13 CountUp (React Bits adaptation).
 *
 * Animates a number toward `value` with an ease-out curve whenever it
 * changes. Pass `initialValue` to decide the first-render starting point;
 * reduced-motion users see the final value immediately.
 */
export function CountUp({
  value,
  initialValue,
  duration = 800,
  format = (next) => String(next),
}: CountUpProps) {
  const [display, setDisplay] = useState(initialValue ?? value);
  const previousRef = useRef(initialValue ?? value);

  useEffect(() => {
    const from = previousRef.current;
    const to = value;
    if (from === to || prefersReducedMotion()) {
      previousRef.current = to;
      setDisplay(to);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 4);
      setDisplay(Math.round(from + (to - from) * eased));
      if (progress < 1) {
        frame = requestAnimationFrame(tick);
      } else {
        previousRef.current = to;
        setDisplay(to);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [duration, value]);

  return <>{format(display)}</>;
}
