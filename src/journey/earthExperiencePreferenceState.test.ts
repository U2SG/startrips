import { describe, expect, it } from "vitest";
import {
  applyEarthExperienceRead,
  applyEarthExperienceWrite,
  earthExperienceStateForAccount,
  effectiveEarthExperiencePolicy,
  EARTH_EXPERIENCE_PREFERENCE_PATH,
  INITIAL_EARTH_EXPERIENCE_STATE,
  markEarthExperienceSaving,
  readEarthExperiencePreference,
  writeEarthExperiencePreference,
  type EarthExperienceResult,
  type EarthExperienceState,
} from "./earthExperiencePreferenceState";

function signedIn(accountKey = "user-a"): EarthExperienceState {
  return earthExperienceStateForAccount(INITIAL_EARTH_EXPERIENCE_STATE, accountKey);
}

function ok(earthExperience: "default" | "particle-only", revision: number): EarthExperienceResult {
  return { ok: true, record: { earthExperience, revision } };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Earth experience hydration", () => {
  it("stays particle-interactive-safe until the stored value is known", () => {
    // The unresolved state must not preload or mount a detailed Earth on an
    // optimistic default, so the policy #331 reads is particle-only.
    expect(signedIn().status).toBe("pending");
    expect(effectiveEarthExperiencePolicy(signedIn())).toBe("particle-only");
  });

  it("adopts default only from a response that confirms no stored row", () => {
    const hydrated = applyEarthExperienceRead(signedIn(), "user-a", ok("default", 0));
    expect(hydrated.known).toBe("default");
    expect(hydrated.status).toBe("resolved");
    expect(effectiveEarthExperiencePolicy(hydrated)).toBe("default");
  });

  it("applies a stored particle-only value", () => {
    const hydrated = applyEarthExperienceRead(signedIn(), "user-a", ok("particle-only", 3));
    expect(effectiveEarthExperiencePolicy(hydrated)).toBe("particle-only");
  });

  it("never lets a failed read overwrite an already-known particle-only value", () => {
    const known = applyEarthExperienceRead(signedIn(), "user-a", ok("particle-only", 3));
    const failed = applyEarthExperienceRead(known, "user-a", { ok: false, reason: "unreachable" });
    expect(failed.known).toBe("particle-only");
    expect(effectiveEarthExperiencePolicy(failed)).toBe("particle-only");
    expect(failed.status).toBe("unavailable");
  });

  it("falls back to the documented absence value when a read fails with nothing known", () => {
    const failed = applyEarthExperienceRead(signedIn(), "user-a", { ok: false, reason: "unreachable" });
    expect(failed.known).toBeNull();
    expect(effectiveEarthExperiencePolicy(failed)).toBe("default");
  });

  it("resolves a signed-out tree immediately instead of holding the pending state", () => {
    const guest = earthExperienceStateForAccount(signedIn(), null);
    expect(guest.status).toBe("resolved");
    expect(effectiveEarthExperiencePolicy(guest)).toBe("default");
  });
});

describe("Earth experience revision guard", () => {
  it("discards a response whose revision lost the race", () => {
    const current = applyEarthExperienceRead(signedIn(), "user-a", ok("particle-only", 4));
    const stale = applyEarthExperienceRead(current, "user-a", ok("default", 2));
    expect(stale.known).toBe("particle-only");
    expect(stale.revision).toBe(4);
    expect(stale.status).toBe("resolved");
  });

  it("keeps an equal revision applicable, because a same-value write is honest", () => {
    const current = applyEarthExperienceRead(signedIn(), "user-a", ok("particle-only", 4));
    const same = applyEarthExperienceWrite(current, "user-a", ok("particle-only", 4));
    expect(same.known).toBe("particle-only");
    expect(same.save).toBe("idle");
  });

  it("reports a failed write as not persisted and changes nothing", () => {
    const current = applyEarthExperienceRead(signedIn(), "user-a", ok("default", 1));
    const failed = applyEarthExperienceWrite(
      markEarthExperienceSaving(current),
      "user-a",
      { ok: false, reason: "unreachable" },
    );
    expect(failed.save).toBe("failed");
    expect(failed.known).toBe("default");
    expect(effectiveEarthExperiencePolicy(failed)).toBe("default");
  });
});

describe("Earth experience account isolation", () => {
  it("discards the previous account's value the moment the session names another", () => {
    // This grades the state function, not the sign-out path: signOut() reloads
    // the page, which clears memory anyway. This is what protects an in-place
    // account swap, where nothing reloads.
    const accountA = applyEarthExperienceRead(signedIn("user-a"), "user-a", ok("particle-only", 7));
    const accountB = earthExperienceStateForAccount(accountA, "user-b");
    expect(accountB.known).toBeNull();
    expect(accountB.revision).toBeNull();
    expect(accountB.status).toBe("pending");
    expect(effectiveEarthExperiencePolicy(accountB)).toBe("particle-only");
  });

  it("drops a late response addressed to an account this tree has left", () => {
    const accountB = earthExperienceStateForAccount(signedIn("user-a"), "user-b");
    expect(applyEarthExperienceRead(accountB, "user-a", ok("particle-only", 7))).toBe(accountB);
    expect(applyEarthExperienceWrite(accountB, "user-a", ok("particle-only", 8))).toBe(accountB);
  });

  it("keeps the same state object when the account has not changed", () => {
    const accountA = signedIn("user-a");
    expect(earthExperienceStateForAccount(accountA, "user-a")).toBe(accountA);
  });
});

describe("Earth experience requests", () => {
  it("reads the owner-only endpoint with the session cookie", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const result = await readEarthExperiencePreference(undefined, (async (input, init) => {
      calls.push([String(input), init]);
      return jsonResponse({ earthExperience: "particle-only", revision: 2, updatedAt: null });
    }) as typeof fetch);

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(EARTH_EXPERIENCE_PREFERENCE_PATH);
    expect(calls[0][1]?.method).toBe("GET");
    expect(calls[0][1]?.credentials).toBe("include");
    expect(result).toEqual({ ok: true, record: { earthExperience: "particle-only", revision: 2 } });
  });

  it("writes the chosen value as the only body field", async () => {
    const calls: Array<RequestInit | undefined> = [];
    const result = await writeEarthExperiencePreference("particle-only", undefined, (async (input, init) => {
      expect(String(input)).toBe(EARTH_EXPERIENCE_PREFERENCE_PATH);
      calls.push(init);
      return jsonResponse({ earthExperience: "particle-only", revision: 5, updatedAt: null });
    }) as typeof fetch);

    expect(calls[0]?.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]?.body))).toEqual({ earthExperience: "particle-only" });
    expect(result).toEqual({ ok: true, record: { earthExperience: "particle-only", revision: 5 } });
  });

  it("reports 401, a refused value, a malformed body and a dead network as failures", async () => {
    const answers: Array<[Response | Error, string]> = [
      [jsonResponse({ error: "UNAUTHORIZED" }, 401), "unauthorized"],
      [jsonResponse({ error: "INVALID_EARTH_EXPERIENCE" }, 400), "rejected"],
      [jsonResponse({ earthExperience: "Particle-Only", revision: 1 }), "rejected"],
      [jsonResponse({ earthExperience: "particle-only", revision: "1" }), "rejected"],
      [new Error("offline"), "unreachable"],
    ];
    for (const [answer, reason] of answers) {
      const result = await readEarthExperiencePreference(undefined, (async () => {
        if (answer instanceof Error) throw answer;
        return answer;
      }) as typeof fetch);
      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.reason).toBe(reason);
    }
  });
});
