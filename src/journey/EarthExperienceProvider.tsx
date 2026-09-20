import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { EarthExperiencePreference } from "./earthExperiencePreference";
import {
  applyEarthExperienceRead,
  earthExperienceStateForAccount,
  effectiveEarthExperiencePolicy,
  INITIAL_EARTH_EXPERIENCE_STATE,
  readEarthExperiencePreference,
  saveEarthExperiencePreference,
  type EarthExperienceState,
} from "./earthExperiencePreferenceState";

/**
 * #332: who holds the Earth experience preference in the browser.
 *
 * It is mounted around `AuthGateway`, above the per-Atlas `WorkspaceGate`, for
 * two reasons the issue states directly: the preference belongs to the person,
 * so switching Atlas must not re-read or reset it, and the account menu inside
 * the gateway and the Atlas below it must read ONE value rather than each
 * keeping their own.
 *
 * The guest share view is mounted outside this provider entirely, so that tree
 * has no reader, no writer and nothing to fetch.
 */

export type EarthExperienceAccess = {
  /** The single policy input #331 consumes. */
  policy: EarthExperiencePreference;
  /** Only ever a server-confirmed value; null while nothing is known. */
  known: EarthExperiencePreference | null;
  status: EarthExperienceState["status"];
  save: EarthExperienceState["save"];
  /** Whether an account exists to store a choice against at all. */
  storable: boolean;
  /** Resolves to whether the value is now DURABLE, never optimistically true. */
  setPreference: (value: EarthExperiencePreference) => Promise<boolean>;
};

const GUEST_ACCESS: EarthExperienceAccess = {
  policy: "default",
  known: null,
  status: "resolved",
  save: "idle",
  storable: false,
  setPreference: async () => false,
};

const EarthExperienceContext = createContext<EarthExperienceAccess>(GUEST_ACCESS);

export function useEarthExperiencePreference(): EarthExperienceAccess {
  return useContext(EarthExperienceContext);
}

/**
 * The session identity is a prop rather than a `useSession()` call here so the
 * rules below stay importable — and therefore testable — outside a browser.
 * `src/main.tsx` owns the binding to the real session.
 *
 * @param accountKey stable Better Auth user id, or null when signed out.
 * @param sessionResolved false while the session itself is still unknown.
 */
export function EarthExperiencePreferenceProvider({ accountKey, sessionResolved, children }: {
  accountKey: string | null;
  sessionResolved: boolean;
  children: ReactNode;
}) {
  const [state, setState] = useState<EarthExperienceState>(INITIAL_EARTH_EXPERIENCE_STATE);

  useEffect(() => {
    // Until the session resolves there is no account to read for, and the
    // initial pending state is already the safe one.
    if (!sessionResolved) return;
    // The account edge lands BEFORE the request: account A's value is gone
    // from this tree the moment the session names somebody else, not when the
    // next response arrives.
    setState((current) => earthExperienceStateForAccount(current, accountKey));
    if (accountKey === null) return;
    const controller = new AbortController();
    // Once per account per session: the dependencies are the session identity,
    // not the Atlas, so switching Atlas re-reads nothing.
    void readEarthExperiencePreference(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setState((current) => applyEarthExperienceRead(current, accountKey, result));
    });
    return () => controller.abort();
  }, [accountKey, sessionResolved]);

  const setPreference = useCallback(
    // The whole write sequence lives in the state module, so what one
    // activation of the menu entry does is graded there rather than only in a
    // browser. This component contributes the setter and the account identity.
    (value: EarthExperiencePreference) => saveEarthExperiencePreference(value, accountKey, setState),
    [accountKey],
  );

  const access = useMemo<EarthExperienceAccess>(() => ({
    policy: effectiveEarthExperiencePolicy(state),
    known: state.known,
    status: state.status,
    save: state.save,
    storable: accountKey !== null,
    setPreference,
  }), [accountKey, setPreference, state]);

  return (
    <EarthExperienceContext.Provider value={access}>
      {children}
    </EarthExperienceContext.Provider>
  );
}

/** What one activation of the entry chooses: the other of the two values. */
export function nextEarthExperience(policy: EarthExperiencePreference): EarthExperiencePreference {
  return policy === "particle-only" ? "default" : "particle-only";
}

/** The value in force, named the way the account menu names it. */
export function earthExperienceEntryLabel(policy: EarthExperiencePreference): string {
  return policy === "particle-only" ? "仅粒子" : "默认";
}

/**
 * Unresolved is not "default". Offering the toggle before the stored value is
 * known would let one click write the value this person never chose, so the
 * entry states that it is still reading instead of guessing.
 */
export function earthExperienceEntryBusy(access: Pick<EarthExperienceAccess, "status" | "save">): boolean {
  return access.status === "pending" || access.save === "saving";
}

/**
 * The account-menu entry, in the desktop dock and the mobile sheet.
 *
 * One toggle rather than a pair of options: the preference has exactly two
 * values and the menu it joins is a short list of single actions. The label
 * names the value in force, so the control states the current answer instead
 * of only offering a change.
 */
export function EarthExperienceMenuEntry({ surface, policy, busy, onToggle }: {
  surface: "dock" | "sheet";
  policy: EarthExperiencePreference;
  busy: boolean;
  onToggle: () => void;
}) {
  const label = busy ? "读取中…" : earthExperienceEntryLabel(policy);
  return (
    <button
      type="button"
      data-earth-experience-entry={surface}
      data-earth-experience-value={policy}
      aria-busy={busy || undefined}
      disabled={busy}
      onClick={onToggle}
    >
      {surface === "sheet"
        ? <><span>地球呈现</span><small>{label}</small></>
        : <>地球呈现：{label}</>}
    </button>
  );
}
