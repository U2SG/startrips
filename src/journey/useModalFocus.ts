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

export function modalSurfaceFor(root: HTMLElement, atlas: Element | null) {
  return root.parentElement === atlas ? root : root.parentElement;
}

/**
 * #250: `inert` on a background surface has more than one possible owner. React
 * inerts the mobile Journey sheet layer for as long as any Story is open, and a
 * nested trap (an expanded Story, a picker over a sheet) starts while that flag
 * is already set. Capturing it as a `previous` value and writing it back at
 * cleanup resurrects an interaction lock whose owner released it in the very
 * commit that tore the trap down.
 *
 * The invariant is ownership, not syntax: a trap may only release and reapply
 * `inert` it actually claimed, so an element that is already inert on
 * activation is left entirely alone — its external owner, whether React or an
 * outer trap, keeps it for exactly as long as that owner needs it.
 *
 * Returns the release function for what this trap claimed.
 */
export function claimInertOwnership(targets: Iterable<HTMLElement>) {
  const claimed: HTMLElement[] = [];
  for (const target of targets) {
    if (target.inert) continue;
    target.inert = true;
    claimed.push(target);
  }
  return () => {
    for (const target of claimed) target.inert = false;
  };
}

/**
 * Focus ownership for a modal surface nested inside an already-trapped parent.
 * The nested surface is expected to carry `data-focus-trap-exempt` so the
 * parent's Tab handler yields while focus is inside this layer.
 */
export function useNestedModalFocus<T extends HTMLElement>(
  active: boolean,
  layerKey: string | number | null = null,
) {
  const rootRef = useRef<T>(null);

  useEffect(() => {
    if (!active) return;
    const root = rootRef.current;
    if (!root) return;

    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusable = () => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)]
      .filter(isModalFocusCandidate);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const candidates = focusable();
      if (candidates.length === 0) {
        event.preventDefault();
        root.focus({ preventScroll: true });
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

    const initial = focusable()[0];
    if (initial) initial.focus({ preventScroll: true });
    else root.focus({ preventScroll: true });
    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (previousFocus?.isConnected && !previousFocus.closest("[inert]")) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, [active, layerKey]);

  return rootRef;
}

export function useModalFocus<T extends HTMLElement>(
  onClose: () => void,
  active = true,
  trapSuspended = false,
) {
  const rootRef = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  const trapActiveRef = useRef(false);
  const pendingFocusRestoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const restorePendingFocus = () => {
    const target = pendingFocusRestoreRef.current;
    pendingFocusRestoreRef.current = null;
    if (target?.isConnected && !target.closest("[inert]")) {
      target.focus({ preventScroll: true });
    }
  };

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

      // React runs effect cleanups in declaration order. If the trap is still
      // active, its background siblings are still inert at this point, so a
      // focus() here would be rejected by Chromium. Hand the target to the
      // trap cleanup; if the trap was already suspended, restore immediately.
      pendingFocusRestoreRef.current = previousFocus;
      if (!trapActiveRef.current) restorePendingFocus();
    };
  }, [active]);

  // Focus-trap lifecycle: background inerting and keyboard ownership can be
  // suspended independently while another interaction surface (the globe)
  // needs to become reachable without closing the modal itself.
  useEffect(() => {
    if (!active || trapSuspended) return;
    const root = rootRef.current;
    if (!root) return;

    const background: HTMLElement[] = [];
    const atlas = root.closest(".living-atlas") ?? document.querySelector(".living-atlas");
    // Some dialogs (Story/Composer) are portaled to document.body while their
    // background Atlas stays in the application tree. Fall back to the live
    // Atlas root so portaled modals still inert the underlying app surface.
    // Non-portaled dialogs can keep using their local modal wrapper.
    const modalSurface = modalSurfaceFor(root, atlas);
    if (atlas && modalSurface) {
      for (const child of atlas.children) {
        if (!(child instanceof HTMLElement) || child === modalSurface) continue;
        background.push(child);
      }
    }
    const accountDock = document.querySelector<HTMLElement>(".account-dock");
    if (accountDock) background.push(accountDock);
    // The Atlas children and the account dock go through one claim path, so
    // neither can drift into reasserting an externally owned flag.
    const releaseInert = claimInertOwnership(background);

    trapActiveRef.current = true;
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
      releaseInert();
      trapActiveRef.current = false;

      // A modal close queues its opener above; restore only after every inert
      // state owned by this trap has been released. Suspension has no queued
      // target, so globe-pick handoff never steals focus back into the modal.
      restorePendingFocus();
    };
  }, [active, trapSuspended]);

  return rootRef;
}
