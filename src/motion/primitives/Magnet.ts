import { useRef, type MouseEvent } from "react";
import { prefersReducedMotion } from "../preferences";

/**
 * ML-13 Magnet (React Bits adaptation).
 *
 * Attaches a subtle magnetic pull to any element: the element drifts toward
 * the cursor while hovered and springs back on leave. Works on touch
 * devices (no pointermove) and honors reduced motion. The element must
 * carry a `transition: transform ...` for the spring-back; handlers are
 * meant to be spread onto the element itself:
 *
 *   const { ref, onMouseMove, onMouseLeave } = useMagnet(16);
 *   <button ref={ref} onMouseMove={onMouseMove} onMouseLeave={onMouseLeave}>
 */
export function useMagnet<T extends HTMLElement>(strength = 16) {
  const ref = useRef<T | null>(null);

  const onMouseMove = (event: MouseEvent<T>) => {
    const element = ref.current;
    if (!element || prefersReducedMotion()) return;
    const bounds = element.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return;
    const x = (event.clientX - (bounds.left + bounds.width / 2)) / bounds.width;
    const y = (event.clientY - (bounds.top + bounds.height / 2)) / bounds.height;
    element.style.transform =
      `translate(${(x * strength).toFixed(2)}px, ${(y * strength).toFixed(2)}px)`;
  };

  const onMouseLeave = () => {
    const element = ref.current;
    if (element) element.style.transform = "";
  };

  return { ref, onMouseMove, onMouseLeave };
}
