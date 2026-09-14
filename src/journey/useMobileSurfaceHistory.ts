import { useEffect, useRef } from "react";

const STACK_KEY = "__startripsMobileSurfaceStack";
const SESSION_KEY = "__startripsMobileSurfaceSession";
const documentSession = typeof crypto !== "undefined" && "randomUUID" in crypto
  ? crypto.randomUUID()
  : `mobile-surface-${Date.now()}-${Math.random().toString(36).slice(2)}`;

type HistoryState = Record<string, unknown> & {
  [STACK_KEY]?: string[];
  [SESSION_KEY]?: string;
};

function asHistoryState(value: unknown): HistoryState {
  return value && typeof value === "object" ? value as HistoryState : {};
}

function readStack(value: unknown) {
  const state = asHistoryState(value);
  if (state[SESSION_KEY] !== documentSession) return [];
  const stack = state[STACK_KEY];
  return Array.isArray(stack) ? stack.filter((entry): entry is string => typeof entry === "string") : [];
}

let surfaceSequence = 0;
const activeTokens = new Set<string>();
let reconcileScheduled = false;
let historyMovePending = false;
const historySettledListeners = new Set<() => void>();

export function shouldDeferMobileSurfaceHistoryWrite(
  scheduled: boolean,
  movePending: boolean,
) {
  return scheduled || movePending;
}

function notifyHistorySettled() {
  if (shouldDeferMobileSurfaceHistoryWrite(reconcileScheduled, historyMovePending)) return;
  const listeners = [...historySettledListeners];
  historySettledListeners.clear();
  for (const listener of listeners) listener();
}

function runWhenHistorySettled(callback: () => void) {
  if (!shouldDeferMobileSurfaceHistoryWrite(reconcileScheduled, historyMovePending)) {
    callback();
    return () => undefined;
  }
  historySettledListeners.add(callback);
  return () => {
    historySettledListeners.delete(callback);
  };
}

export function nextMobileSurfaceHistoryWrite(
  stack: readonly string[],
  active: ReadonlySet<string>,
  token: string,
): { mode: "push" | "replace"; stack: string[] } {
  let staleSuffixStart = stack.length;
  while (staleSuffixStart > 0 && !active.has(stack[staleSuffixStart - 1])) {
    staleSuffixStart -= 1;
  }
  if (staleSuffixStart < stack.length) {
    return { mode: "replace", stack: [...stack.slice(0, staleSuffixStart), token] };
  }
  return { mode: "push", stack: [...stack, token] };
}

export function countStaleMobileSurfaceHistorySuffix(
  stack: readonly string[],
  active: ReadonlySet<string>,
) {
  let count = 0;
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    if (active.has(stack[index])) break;
    count += 1;
  }
  return count;
}

function scheduleHistoryReconcile() {
  if (typeof window === "undefined" || reconcileScheduled || historyMovePending) return;
  reconcileScheduled = true;
  queueMicrotask(() => {
    reconcileScheduled = false;
    if (historyMovePending) return;

    const stack = readStack(window.history.state);
    const staleTopCount = countStaleMobileSurfaceHistorySuffix(stack, activeTokens);
    if (staleTopCount === 0) {
      notifyHistorySettled();
      return;
    }

    // Every token in the contiguous stale suffix represents one same-document
    // Startrips pushState entry. Collapse that owned suffix in one navigation so
    // multi-layer breakpoint/unmount cleanup cannot overrun into an unrelated
    // browser document.
    historyMovePending = true;
    window.history.go(-staleTopCount);
  });
}

if (typeof window !== "undefined") {
  const currentState = asHistoryState(window.history.state);
  const inheritedStack = currentState[STACK_KEY];
  if (
    currentState[SESSION_KEY] !== documentSession
    && Array.isArray(inheritedStack)
    && inheritedStack.length > 0
  ) {
    window.history.replaceState({
      ...currentState,
      [STACK_KEY]: [],
      [SESSION_KEY]: documentSession,
    }, "");
  }
  window.addEventListener("popstate", () => {
    historyMovePending = false;
    // A replacement can require more than one owned history hop: closing the
    // replacement first lands on an older Story/sheet state, which is already
    // stale in React. Re-run reconciliation after each owned navigation until
    // the top token is live (or no Startrips token remains).
    scheduleHistoryReconcile();
  });
}

/**
 * Own one same-URL browser-history entry for a visible mobile surface.
 * Nested surfaces inherit the current token stack, so Back only closes layers
 * whose tokens disappear while parent layers remain registered underneath.
 */
export function useMobileSurfaceHistory(
  active: boolean,
  surface: string,
  onHistoryClose: () => boolean | void,
) {
  const onHistoryCloseRef = useRef(onHistoryClose);
  const tokenRef = useRef<string | null>(null);
  const entryActiveRef = useRef(false);

  useEffect(() => {
    onHistoryCloseRef.current = onHistoryClose;
  }, [onHistoryClose]);

  useEffect(() => {
    if (!active || typeof window === "undefined") return;

    let disposed = false;
    let releaseRegisteredEntry: (() => void) | null = null;
    const registerEntry = () => {
      if (disposed) return;
      const token = `${surface}:${++surfaceSequence}`;
      const baseState = asHistoryState(window.history.state);
      const stack = readStack(baseState);
      const write = nextMobileSurfaceHistoryWrite(stack, activeTokens, token);
      activeTokens.add(token);
      const nextState = {
        ...baseState,
        [STACK_KEY]: write.stack,
        [SESSION_KEY]: documentSession,
      };
      if (write.mode === "replace") window.history.replaceState(nextState, "");
      else window.history.pushState(nextState, "");
      tokenRef.current = token;
      entryActiveRef.current = true;

      const onPopState = (event: PopStateEvent) => {
        if (!entryActiveRef.current) return;
        if (readStack(event.state).includes(token)) return;
        const closed = onHistoryCloseRef.current();
        if (closed === false) {
          // The surface is temporarily non-dismissible (for example while a
          // mutation is pending). Restore the same owned history layer so a Back
          // press cannot consume navigation state while leaving the UI mounted.
          const baseState = asHistoryState(window.history.state);
          const stack = readStack(baseState);
          window.history.pushState({
            ...baseState,
            [STACK_KEY]: [...stack, token],
            [SESSION_KEY]: documentSession,
          }, "");
          return;
        }
        entryActiveRef.current = false;
        tokenRef.current = null;
        activeTokens.delete(token);
        // A top-level replacement can leave the outgoing surface's older
        // pushState entry immediately underneath the incoming one. After Back
        // closes the incoming owner, collapse only that now-stale Startrips
        // suffix so the same action settles on the pre-surface history state
        // instead of consuming a later Back on an invisible ghost token.
        scheduleHistoryReconcile();
      };

      window.addEventListener("popstate", onPopState);
      releaseRegisteredEntry = () => {
        window.removeEventListener("popstate", onPopState);
        const ownedToken = tokenRef.current;
        if (!ownedToken) return;
        tokenRef.current = null;
        entryActiveRef.current = false;
        activeTokens.delete(ownedToken);
        scheduleHistoryReconcile();
      };
    };

    // A replacement close may already have started an owned history traversal.
    // Writing the next surface token into the entry being left makes the
    // eventual popstate look like a Back against the freshly reopened surface.
    // Register only after the reconciliation chain has reached its stable entry.
    const cancelDeferredRegistration = runWhenHistorySettled(registerEntry);
    return () => {
      disposed = true;
      cancelDeferredRegistration();
      releaseRegisteredEntry?.();
    };
  }, [active, surface]);
}
