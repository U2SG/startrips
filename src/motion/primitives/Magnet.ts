import { useRef, type PointerEvent } from "react";
import { prefersReducedMotion } from "../preferences";

/**
 * ML-13 Magnet (React Bits adaptation).
 *
 * Attaches a subtle magnetic pull to any element: the element drifts toward
 * the cursor while hovered and springs back on leave. Only mouse pointers
 * pull; touch and pen input are ignored so a tap never leaves the element
 * displaced. Honors reduced motion. The element must carry a
 * `transition: transform ...` for the spring-back; handlers are meant to be
 * spread onto the element itself:
 *
 *   const { ref, onPointerMove, onPointerLeave } = useMagnet(16);
 *   <button ref={ref} onPointerMove={onPointerMove} onPointerLeave={onPointerLeave}>
 */
export function useMagnet<T extends HTMLElement>(strength = 16) {
  const ref = useRef<T | null>(null);

  const onPointerMove = (event: PointerEvent<T>) => {
    if (event.pointerType !== "mouse") return;
    const element = ref.current;
    if (!element || prefersReducedMotion()) return;
    const bounds = element.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return;
    const x = (event.clientX - (bounds.left + bounds.width / 2)) / bounds.width;
    const y = (event.clientY - (bounds.top + bounds.height / 2)) / bounds.height;
    element.style.transform =
      `translate(${(x * strength).toFixed(2)}px, ${(y * strength).toFixed(2)}px)`;
  };

  const onPointerLeave = () => {
    const element = ref.current;
    if (element) element.style.transform = "";
  };

  return { ref, onPointerMove, onPointerLeave };
}
