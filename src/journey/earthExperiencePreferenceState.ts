import {
  DEFAULT_EARTH_EXPERIENCE,
  isEarthExperiencePreference,
  type EarthExperiencePreference,
} from "./earthExperiencePreference";

/**
 * #332: the client half of the Earth experience preference.
 *
 * `#387` made the value durable and `#331` made `particle-only` mean
 * something at runtime. What was missing is the part in between: reading the
 * stored value on load, letting a person change it, and deciding what the
 * Dive is allowed to do while the answer is still in flight.
 *
 * Everything here is pure or takes its `fetch` as an argument, so the rules
 * that decide what renders are testable without a browser: the React provider
 * in `EarthExperienceProvider.tsx` only owns the session wiring.
 */

export const EARTH_EXPERIENCE_PREFERENCE_PATH = "/api/account-preferences/earth-experience";

/** What the server said, reduced to the two fields a client may act on. */
export type EarthExperienceRecord = {
  earthExperience: EarthExperiencePreference;
  revision: number;
};

export type EarthExperienceResult =
  | { ok: true; record: EarthExperienceRecord }
  | { ok: false; reason: "unauthorized" | "rejected" | "unreachable" };

/**
 * `known` is only ever a value the SERVER confirmed. A pending read is not a
 * value and a failed write is not a value, which is what keeps a failure from
 * quietly overwriting a preference this person already proved they have.
 */
export type EarthExperienceState = {
  /** Stable Better Auth user id, or null while signed out. */
  accountKey: string | null;
  known: EarthExperiencePreference | null;
  /** Highest revision ever accepted, so a response that lost a race is dropped. */
  revision: number | null;
  status: "pending" | "resolved" | "unavailable";
  save: "idle" | "saving" | "failed";
};

export const INITIAL_EARTH_EXPERIENCE_STATE: EarthExperienceState = {
  accountKey: null,
  known: null,
  revision: null,
  status: "pending",
  save: "idle",
};

/**
 * Switching account discards the previous person's value outright rather than
 * carrying it until the next read resolves. Account A's particle-only choice
 * must never be what account B's first frame renders, and a signed-out tree
 * has nothing to read at all, so it resolves immediately to the documented
 * absence value instead of holding the safe pending state forever.
 */
export function earthExperienceStateForAccount(
  state: EarthExperienceState,
  accountKey: string | null,
): EarthExperienceState {
  if (state.accountKey === accountKey) return state;
  return {
    accountKey,
    known: null,
    revision: null,
    status: accountKey === null ? "resolved" : "pending",
    save: "idle",
  };
}

function accept(
  state: EarthExperienceState,
  record: EarthExperienceRecord,
): EarthExperienceState {
  // A response whose revision is BELOW one already observed lost a race: it
  // describes a state that has since been superseded, so it is dropped rather
  // than applied. An equal revision is the honest same-value answer the
  // contract documents and stays applicable.
  if (state.revision !== null && record.revision < state.revision) {
    return { ...state, status: "resolved", save: "idle" };
  }
  return {
    ...state,
    known: record.earthExperience,
    revision: record.revision,
    status: "resolved",
    save: "idle",
  };
}

/** A response that belongs to an account this tree has already left. */
function foreign(state: EarthExperienceState, accountKey: string | null): boolean {
  return state.accountKey !== accountKey;
}

export function applyEarthExperienceRead(
  state: EarthExperienceState,
  accountKey: string | null,
  result: EarthExperienceResult,
): EarthExperienceState {
  if (foreign(state, accountKey)) return state;
  if (result.ok) return accept(state, result.record);
  // A failed read never becomes a value. If nothing is known yet the effective
  // policy falls back to the documented absence value; if a value IS known,
  // keeping it is the whole point — a dropped request must not silently turn
  // someone's particle-only Earth back into a detailed one.
  return { ...state, status: "unavailable" };
}

export function applyEarthExperienceWrite(
  state: EarthExperienceState,
  accountKey: string | null,
  result: EarthExperienceResult,
): EarthExperienceState {
  if (foreign(state, accountKey)) return state;
  if (result.ok) return accept(state, result.record);
  // Nothing is durable, so nothing local changes and the caller is told so.
  return { ...state, save: "failed" };
}

export function markEarthExperienceSaving(
  state: EarthExperienceState,
): EarthExperienceState {
  return { ...state, save: "saving" };
}

/**
 * The single policy input #331 consumes.
 *
 * While the read is unresolved the answer is `particle-only`: that is the
 * particle-interactive-safe state, and it is what keeps the product from
 * preloading and mounting a detailed Earth on an optimistic default only to
 * retract it a moment later for someone who chose never to load one.
 */
export function effectiveEarthExperiencePolicy(
  state: EarthExperienceState,
): EarthExperiencePreference {
  if (state.known !== null) return state.known;
  if (state.status === "pending") return "particle-only";
  return DEFAULT_EARTH_EXPERIENCE;
}

function readRecord(payload: unknown): EarthExperienceRecord | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { earthExperience, revision } = payload as Record<string, unknown>;
  if (!isEarthExperiencePreference(earthExperience)) return null;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) return null;
  return { earthExperience, revision };
}

async function requestEarthExperience(
  fetchImpl: typeof fetch,
  init: RequestInit,
): Promise<EarthExperienceResult> {
  let response: Response;
  try {
    response = await fetchImpl(EARTH_EXPERIENCE_PREFERENCE_PATH, {
      credentials: "include",
      ...init,
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (response.status === 401) return { ok: false, reason: "unauthorized" };
  if (!response.ok) return { ok: false, reason: "rejected" };
  const payload = await response.json().catch(() => null);
  const record = readRecord(payload);
  // An answer this client cannot validate is not an answer. Treating a
  // malformed body as a value would be exactly the silent override the
  // contract forbids.
  return record ? { ok: true, record } : { ok: false, reason: "rejected" };
}

export function readEarthExperiencePreference(
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<EarthExperienceResult> {
  return requestEarthExperience(fetchImpl, { method: "GET", signal });
}

export function writeEarthExperiencePreference(
  earthExperience: EarthExperiencePreference,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<EarthExperienceResult> {
  return requestEarthExperience(fetchImpl, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ earthExperience }),
    signal,
  });
}

/**
 * One activation of the account-menu entry, end to end.
 *
 * The provider owns nothing but the `useState` setter it hands in here, so the
 * whole sequence a click performs — announce the write, send it, accept or
 * refuse the answer, and report whether the value is now DURABLE — is
 * exercisable with a stub `fetch` and no browser. The boolean is the server's
 * answer, never an optimistic one: `false` means the choice did not persist.
 */
export async function saveEarthExperiencePreference(
  value: EarthExperiencePreference,
  accountKey: string | null,
  applyState: (update: (state: EarthExperienceState) => EarthExperienceState) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  // Signed out there is no account to store a choice against, so nothing is
  // sent and nothing is claimed.
  if (accountKey === null) return false;
  applyState(markEarthExperienceSaving);
  const result = await writeEarthExperiencePreference(value, undefined, fetchImpl);
  applyState((current) => applyEarthExperienceWrite(current, accountKey, result));
  return result.ok;
}
