import { useEffect, useRef } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function isModalFocusCandidate(candidate: HTMLElement) {
  return !candidate.closest("[inert]")
    && candidate.getClientRects().length > 0
    && getComputedStyle(candidate).visibility !== "hidden";
}

/**
 * Review P2: whether an element lives inside a nested focus trap (e.g. the
 * fullscreen overlay rendered as a sibling of the story dialog). The dialog's
 * own Tab redirect must not steal focus from a nested trap's controls.
 */
export function isInsideNestedTrap(element: Element | null) {
  return Boolean(element?.closest("[data-focus-trap-exempt]"));
}

export function useModalFocus<T extends HTMLElement>(
  onClose: () => void,
  active = true,
  trapSuspended = false,
) {
  const rootRef = useRef<T>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Modal lifecycle ownership: body scroll lock and final focus restoration
  // belong to the dialog for its entire open lifetime. Temporarily suspending
  // the focus trap (e.g. globe point-picking) must not tear this lifecycle down.
  useEffect(() => {
    if (!active) return;
    const root = rootRef.current;
    if (!root) return;

    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    const previousPaddingRight = document.body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = "hidden";
    if (scrollbarWidth > 0) document.body.style.paddingRight = `${scrollbarWidth}px`;

    return () => {
      document.body.style.overflow = previousOverflow;
      document.body.style.paddingRight = previousPaddingRight;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [active]);

  // Focus-trap lifecycle: background inerting and keyboard ownership can be
  // suspended independently while another interaction surface (the globe)
  // needs to become reachable without closing the modal itself.
  useEffect(() => {
    if (!active || trapSuspended) return;
    const root = rootRef.current;
    if (!root) return;

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

    const focusable = () => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)]
      .filter(isModalFocusCandidate);
    root.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      if (isInsideNestedTrap(document.activeElement)) return;

      const candidates = focusable();
      if (candidates.length === 0) {
        event.preventDefault();
        root.focus();
        return;
      }
      const first = candidates[0];
      const last = candidates[candidates.length - 1];
      const current = document.activeElement;
      if (event.shiftKey && (
        current === root
        || current === first
        || !root.contains(current)
      )) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (
        current === root
        || current === last
        || !root.contains(current)
      )) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      for (const entry of inerted) entry.element.inert = entry.previous;
    };
  }, [active, trapSuspended]);

  return rootRef;
}
