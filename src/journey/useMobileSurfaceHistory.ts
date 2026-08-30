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

function scheduleHistoryReconcile() {
  if (typeof window === "undefined" || reconcileScheduled || historyMovePending) return;
  reconcileScheduled = true;
  queueMicrotask(() => {
    reconcileScheduled = false;
    if (historyMovePending) return;

    const stack = readStack(window.history.state);
    let staleTopCount = 0;
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      if (activeTokens.has(stack[index])) break;
      staleTopCount += 1;
    }
    if (staleTopCount === 0) return;

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

    const token = `${surface}:${++surfaceSequence}`;
    const baseState = asHistoryState(window.history.state);
    const stack = readStack(baseState);
    activeTokens.add(token);
    window.history.pushState({
      ...baseState,
      [STACK_KEY]: [...stack, token],
      [SESSION_KEY]: documentSession,
    }, "");
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
    };

    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      const ownedToken = tokenRef.current;
      if (!ownedToken) return;
      tokenRef.current = null;
      entryActiveRef.current = false;
      activeTokens.delete(ownedToken);
      scheduleHistoryReconcile();
    };
  }, [active, surface]);
}
