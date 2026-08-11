import { useEffect, useRef } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function useModalFocus<T extends HTMLElement>(
  onClose: () => void,
  active = true,
) {
  const rootRef = useRef<T>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!active) return;
    const root = rootRef.current;
    if (!root) return;

    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const inerted: Array<{ element: HTMLElement; previous: boolean }> = [];
    const overlay = root.parentElement;
    const atlas = root.closest(".living-atlas");
    if (atlas && overlay) {
      for (const child of atlas.children) {
        if (!(child instanceof HTMLElement) || child === overlay) continue;
        inerted.push({ element: child, previous: child.inert });
        child.inert = true;
      }
    }
    const accountDock = document.querySelector<HTMLElement>(".account-dock");
    if (accountDock) {
      inerted.push({ element: accountDock, previous: accountDock.inert });
      accountDock.inert = true;
    }

    const focusable = () => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
    (focusable()[0] ?? root).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const candidates = focusable();
      if (candidates.length === 0) {
        event.preventDefault();
        root.focus();
        return;
      }
      const first = candidates[0];
      const last = candidates[candidates.length - 1];
      const current = document.activeElement;
      if (event.shiftKey && (current === first || !root.contains(current))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || !root.contains(current))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      for (const entry of inerted) entry.element.inert = entry.previous;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [active]);

  return rootRef;
}
