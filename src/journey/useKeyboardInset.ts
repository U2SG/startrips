import { useEffect } from "react";

/**
 * How far the soft keyboard reaches up from the bottom of the layout viewport.
 * Mobile browsers shrink only the visual viewport when it opens, so a control
 * pinned to the layout bottom would sit under the keyboard.
 */
export function keyboardInset(layoutHeight: number, visualHeight: number, visualOffsetTop: number) {
  return Math.max(0, Math.round(layoutHeight - visualHeight - visualOffsetTop));
}

/**
 * Publishes `--mobile-keyboard-inset` on a bottom dock while a text field
 * inside it holds focus, so the dock (and the card floating above it) rides
 * on top of the keyboard. Any other field on the page leaves the dock where
 * it is, so the globe framing that measures the dock does not move with it.
 */
export function useKeyboardInset(element: HTMLElement | null) {
  useEffect(() => {
    const viewport = typeof window === "undefined" ? undefined : window.visualViewport;
    if (!element || !viewport) return;
    let applied = -1;
    const update = () => {
      const active = document.activeElement;
      const typing = active instanceof HTMLInputElement && element.contains(active);
      const inset = typing ? keyboardInset(window.innerHeight, viewport.height, viewport.offsetTop) : 0;
      if (inset === applied) return;
      applied = inset;
      element.style.setProperty("--mobile-keyboard-inset", `${inset}px`);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    element.addEventListener("focusin", update);
    element.addEventListener("focusout", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      element.removeEventListener("focusin", update);
      element.removeEventListener("focusout", update);
      element.style.removeProperty("--mobile-keyboard-inset");
    };
  }, [element]);
}
