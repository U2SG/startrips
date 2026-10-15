import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { requestMediaPresentationPreference } from "./mediaPresentationPreference";
import type { MediaPresentationStyle } from "./mediaPresentationStyle";

type PresentationAccess = {
  style: MediaPresentationStyle;
  busy: boolean;
  error: string;
  select: ((style: MediaPresentationStyle, onConfirmed?: () => void) => Promise<void>) | null;
  retry: (onConfirmed?: () => void) => void;
  recover: (style: MediaPresentationStyle) => void;
  registerChangeGuard?: (guard: () => boolean) => () => void;
};

const PresentationContext = createContext<PresentationAccess | null>(null);
export const useMediaPresentationAccess = () => useContext(PresentationContext);

/** Account and reader changes must both preserve an unfinished Story edit. */
export function useMediaPresentationChangeGuard(blocked: boolean) {
  const register = useMediaPresentationAccess()?.registerChangeGuard;
  const current = useRef(blocked);
  current.current = blocked;
  useEffect(() => register?.(() => current.current), [register]);
}


export function MediaPresentationPreferenceProvider({ accountKey, sessionResolved, children }: {
  accountKey: string | null;
  sessionResolved: boolean;
  children: ReactNode;
}) {
  const [state, setState] = useState<{
    accountKey: string | null;
    style: MediaPresentationStyle;
    recovery: MediaPresentationStyle | null;
    status: "loading" | "ready" | "error";
    saving: boolean;
    error: string;
    retryStyle: MediaPresentationStyle | null;
  }>({ accountKey: null, style: "classic", recovery: null, status: "loading", saving: false, error: "", retryStyle: null });
  const [attempt, setAttempt] = useState(0);
  const owner = sessionResolved ? accountKey : state.accountKey;
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const writing = useRef<AbortController | null>(null);
  const changeGuards = useRef(new Set<() => boolean>());
  const registerChangeGuard = useCallback((guard: () => boolean) => {
    changeGuards.current.add(guard);
    return () => { changeGuards.current.delete(guard); };
  }, []);


  useEffect(() => {
    if (!sessionResolved) return;
    const controller = new AbortController();
    setState({ accountKey, style: "classic", recovery: null, status: accountKey ? "loading" : "ready", saving: false, error: "", retryStyle: null });
    if (accountKey) {
      void requestMediaPresentationPreference(undefined, controller.signal).then(
        (style) => {
          if (!controller.signal.aborted) setState((value) => value.accountKey === accountKey ? { ...value, style, status: "ready", error: "" } : value);
        },
        () => {
          if (!controller.signal.aborted) setState((value) => value.accountKey === accountKey ? { ...value, status: "error", error: "无法读取媒体呈现设置，请重试。" } : value);
        },
      );
    }
    return () => {
      controller.abort();
      writing.current?.abort();
      writing.current = null;
    };
  }, [accountKey, sessionResolved, attempt]);

  async function select(style: MediaPresentationStyle, onConfirmed?: () => void) {
    if (!accountKey || !sessionResolved || state.accountKey !== accountKey || state.status !== "ready" || writing.current) return;
    if ([...changeGuards.current].some((guard) => guard())) {
      setState((value) => ({ ...value, retryStyle: style, error: "请先保存或放弃当前编辑，完成正在进行的操作后再切换媒体呈现。" }));
      return;
    }
    const controller = new AbortController();
    writing.current = controller;
    setState((value) => ({ ...value, saving: true, error: "", retryStyle: null }));
    try {
      const saved = await requestMediaPresentationPreference(style, controller.signal);
      if (!controller.signal.aborted && currentOwner.current === accountKey) {
        onConfirmed?.();
        setState((value) => value.accountKey === accountKey ? { ...value, style: saved, recovery: null, saving: false, error: "", retryStyle: null } : value);
      }
    } catch {
      if (!controller.signal.aborted && currentOwner.current === accountKey) {
        setState((value) => value.accountKey === accountKey ? { ...value, saving: false, error: "无法确认设置已保存，请重试。", retryStyle: style } : value);
      }
    } finally {
      if (writing.current === controller) writing.current = null;
    }
  }

  function retry(onConfirmed?: () => void) {
    if (!accountKey || !sessionResolved || state.accountKey !== accountKey || writing.current) return;
    // The failed request belongs to the preference owner, not whichever UI
    // happens to display its error. Do not retain a closed surface's callback.
    if (state.status === "error") {
      // A successful read may replace the local editor with another reader.
      // Account's Retry must respect the same unfinished work as a saved change.
      if ([...changeGuards.current].some((guard) => guard())) {
        setState((value) => ({ ...value, error: "请先保存或放弃当前编辑，完成正在进行的操作后再切换媒体呈现。" }));
        return;
      }
      setAttempt((value) => value + 1);
    }
    else if (state.status === "ready" && state.error && state.retryStyle) {
      void select(state.retryStyle, onConfirmed);
    }
  }

  const owned = state.accountKey === owner;
  return (
    <PresentationContext.Provider value={owner === null ? null : {
      style: owned ? state.recovery ?? state.style : "classic",
      busy: !sessionResolved || !owned || state.status === "loading" || state.saving,
      error: owned ? state.error : "",
      select: accountKey && sessionResolved && owned && state.status === "ready" ? select : null,
      retry,
      registerChangeGuard,
      recover: (style) => setState((value) => value.accountKey === currentOwner.current ? { ...value, recovery: style, error: "", retryStyle: null } : value),
    }}>
      {children}
    </PresentationContext.Provider>
  );
}

/** Share policy is supplied by the grant read, never by this viewer's account or URL. */
export function SharedMediaPresentationProvider({ style, children }: { style: MediaPresentationStyle; children: ReactNode }) {
  const [recovery, setRecovery] = useState<{ forStyle: MediaPresentationStyle; value: MediaPresentationStyle } | null>(null);
  useEffect(() => setRecovery(null), [style]);
  return (
    <PresentationContext.Provider value={{ style: recovery?.forStyle === style ? recovery.value : style, busy: false, error: "", select: null, retry: () => undefined, recover: (value) => setRecovery({ forStyle: style, value }) }}>
      {children}
    </PresentationContext.Provider>
  );
}

