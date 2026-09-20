import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  EarthExperienceMenuEntry,
  earthExperienceEntryBusy,
  earthExperienceEntryLabel,
  nextEarthExperience,
} from "./EarthExperienceProvider";
import {
  applyEarthExperienceRead,
  earthExperienceStateForAccount,
  effectiveEarthExperiencePolicy,
  EARTH_EXPERIENCE_PREFERENCE_PATH,
  INITIAL_EARTH_EXPERIENCE_STATE,
  saveEarthExperiencePreference,
  type EarthExperienceState,
} from "./earthExperiencePreferenceState";

const authGateway = readFileSync(new URL("../auth/AuthGateway.tsx", import.meta.url), "utf8");
const main = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
const provider = readFileSync(new URL("./EarthExperienceProvider.tsx", import.meta.url), "utf8");
const sharedAtlas = readFileSync(new URL("./sharedAtlas.ts", import.meta.url), "utf8");
const sharedAtlasView = readFileSync(new URL("./SharedAtlasView.tsx", import.meta.url), "utf8");

type Sent = { url: string; method?: string; body: unknown };

function stored(
  earthExperience: "default" | "particle-only",
  revision: number,
  accountKey = "user-a",
): EarthExperienceState {
  return applyEarthExperienceRead(
    earthExperienceStateForAccount(INITIAL_EARTH_EXPERIENCE_STATE, accountKey),
    accountKey,
    { ok: true, record: { earthExperience, revision } },
  );
}

function stubFetch(sent: Sent[], answer: () => Response | Error): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({
      url: String(input),
      method: init?.method,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const outcome = answer();
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }) as typeof fetch;
}

function record(earthExperience: string, revision: number) {
  return new Response(JSON.stringify({ earthExperience, revision, updatedAt: null }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Earth experience account-menu entry", () => {
  it("renders the stored value in the desktop dock and the mobile sheet", () => {
    const dock = renderToStaticMarkup(createElement(EarthExperienceMenuEntry, {
      surface: "dock",
      policy: "particle-only",
      busy: false,
      onToggle: () => undefined,
    }));
    expect(dock).toContain('data-earth-experience-entry="dock"');
    expect(dock).toContain('data-earth-experience-value="particle-only"');
    expect(dock).toContain(earthExperienceEntryLabel("particle-only"));
    expect(dock).not.toContain("disabled");

    const sheet = renderToStaticMarkup(createElement(EarthExperienceMenuEntry, {
      surface: "sheet",
      policy: "default",
      busy: false,
      onToggle: () => undefined,
    }));
    expect(sheet).toContain('data-earth-experience-entry="sheet"');
    expect(sheet).toContain("<span>地球呈现</span>");
    expect(sheet).toContain(`<small>${earthExperienceEntryLabel("default")}</small>`);
  });

  it("issues exactly one PUT of the chosen value when the entry is activated", async () => {
    // The production chain, minus the React shell: the entry's click runs the
    // account menu's toggle, which is the provider's `setPreference`, which is
    // `saveEarthExperiencePreference`. Only `fetch` is a stub, so the request
    // asserted here is the one the module itself builds and sends.
    let state = stored("default", 0);
    const sent: Sent[] = [];
    const fetchImpl = stubFetch(sent, () => record("particle-only", 1));

    let pending: Promise<boolean> | null = null;
    const entry = EarthExperienceMenuEntry({
      surface: "dock",
      policy: effectiveEarthExperiencePolicy(state),
      busy: earthExperienceEntryBusy(state),
      onToggle: () => {
        pending = saveEarthExperiencePreference(
          nextEarthExperience(effectiveEarthExperiencePolicy(state)),
          state.accountKey,
          (update) => { state = update(state); },
          fetchImpl,
        );
      },
    });
    (entry.props as { onClick: () => void }).onClick();
    expect(pending).not.toBeNull();
    const persisted = await (pending as unknown as Promise<boolean>);

    expect(sent).toEqual([{
      url: EARTH_EXPERIENCE_PREFERENCE_PATH,
      method: "PUT",
      body: { earthExperience: "particle-only" },
    }]);
    expect(persisted).toBe(true);
    // The chosen value is what the Atlas renders next, and it came from the
    // server's answer rather than an optimistic local flip.
    expect(state.known).toBe("particle-only");
    expect(effectiveEarthExperiencePolicy(state)).toBe("particle-only");
    expect(state.save).toBe("idle");
  });

  it("reports a write that did not land instead of claiming it persisted", async () => {
    let state = stored("default", 1);
    const sent: Sent[] = [];
    const persisted = await saveEarthExperiencePreference(
      "particle-only",
      "user-a",
      (update) => { state = update(state); },
      stubFetch(sent, () => new Error("offline")),
    );

    expect(persisted).toBe(false);
    expect(state.save).toBe("failed");
    // Nothing is durable, so nothing local moved: the effective policy is still
    // the last value that actually reached storage.
    expect(state.known).toBe("default");
    expect(effectiveEarthExperiencePolicy(state)).toBe("default");
    // And the account menu says so rather than showing the choice as taken.
    expect(authGateway).toContain("const persisted = await earthExperience.setPreference(next);");
    expect(authGateway).toContain("地球呈现未能保存，选择未生效。");
  });

  it("discards a PUT answer whose revision lost the race to a newer local value", async () => {
    let state = stored("particle-only", 4);
    const sent: Sent[] = [];
    await saveEarthExperiencePreference(
      "default",
      "user-a",
      (update) => { state = update(state); },
      stubFetch(sent, () => record("default", 2)),
    );

    expect(state.known).toBe("particle-only");
    expect(state.revision).toBe(4);
  });

  it("sends nothing at all when there is no account to store a choice against", async () => {
    const sent: Sent[] = [];
    const persisted = await saveEarthExperiencePreference(
      "particle-only",
      null,
      () => undefined,
      stubFetch(sent, () => record("particle-only", 1)),
    );
    expect(persisted).toBe(false);
    expect(sent).toEqual([]);
  });

  it("refuses to call a write saved once the session has named another account", async () => {
    // The PUT proves the DEPARTED account's row is durable. That is not the
    // same claim as "the setting you are looking at was saved", so the menu
    // must not report success to the account that replaced it.
    let state = stored("default", 1, "user-a");
    const sent: Sent[] = [];
    let owner = "user-a";
    const persisted = await saveEarthExperiencePreference(
      "particle-only",
      "user-a",
      (update) => { state = update(state); },
      stubFetch(sent, () => {
        owner = "user-b";
        return record("particle-only", 2);
      }),
      () => owner === "user-a",
    );

    expect(sent).toHaveLength(1);
    expect(persisted).toBe(false);
  });

  it("chooses the other of the two values", () => {
    expect(nextEarthExperience("default")).toBe("particle-only");
    expect(nextEarthExperience("particle-only")).toBe("default");
    expect(authGateway).toContain("const next = nextEarthExperience(earthExperience.policy);");
  });

  it("refuses to offer a choice before the stored value is known", () => {
    expect(earthExperienceEntryBusy({ status: "pending", save: "idle" })).toBe(true);
    expect(earthExperienceEntryBusy({ status: "resolved", save: "saving" })).toBe(true);
    expect(earthExperienceEntryBusy({ status: "resolved", save: "idle" })).toBe(false);
    expect(earthExperienceEntryBusy({ status: "unavailable", save: "failed" })).toBe(false);

    const busy = renderToStaticMarkup(createElement(EarthExperienceMenuEntry, {
      surface: "dock",
      policy: "particle-only",
      busy: true,
      onToggle: () => undefined,
    }));
    expect(busy).toContain("disabled");
    expect(busy).toContain('aria-busy="true"');
  });

  it("sits inside both account-menu action lists, next to the existing actions", () => {
    for (const container of ["account-dock__actions", "account-sheet__actions"]) {
      const list = authGateway.indexOf(container);
      const entry = authGateway.indexOf("<EarthExperienceMenuEntry", list);
      const signOut = authGateway.indexOf("authClient.signOut()", entry);
      expect(list).toBeGreaterThan(-1);
      expect(entry).toBeGreaterThan(list);
      expect(signOut).toBeGreaterThan(entry);
    }
  });
});

describe("Earth experience hydration wiring", () => {
  it("resolves the policy from the session and threads it into the Atlas", () => {
    expect(main).toContain("const session = authClient.useSession();");
    expect(main).toContain("accountKey={session.data?.user.id ?? null}");
    expect(main).toContain("sessionResolved={!session.isPending}");
    expect(main).toContain("const { policy } = useEarthExperiencePreference();");
    expect(main).toContain("<LivingAtlasApp earthExperiencePolicy={policy} />");
    // The product path is the wrapper, not the bare Atlas that would keep the
    // hardcoded default.
    expect(main).toContain("    : OwnerLivingAtlasApp;");
  });

  it("applies the account edge during render, not after paint", () => {
    // An effect runs after the frame is committed, so an account swap that
    // keeps the tree mounted - two accounts sharing an active organization -
    // would otherwise render account A's policy for account B once. The
    // rendered access is normalized against the current account instead.
    expect(provider).toContain(
      "const owned = earthExperienceStateForAccount(state, sessionResolved ? accountKey : state.accountKey);",
    );
    expect(provider).toContain("policy: effectiveEarthExperiencePolicy(owned),");
    expect(provider).not.toContain("policy: effectiveEarthExperiencePolicy(state),");
    // A momentarily pending session holds the account rather than reading it as
    // signed out, so a known particle-only person is never resolved to the
    // absence value and handed a detailed Earth.
    const swapped = earthExperienceStateForAccount(stored("default", 3, "user-a"), "user-b");
    expect(swapped.known).toBeNull();
    expect(effectiveEarthExperiencePolicy(swapped)).toBe("particle-only");
    const held = earthExperienceStateForAccount(stored("particle-only", 3, "user-a"), "user-a");
    expect(effectiveEarthExperiencePolicy(held)).toBe("particle-only");
  });

  it("mounts the provider around the gateway, above the per-Atlas workspace", () => {
    const providerMount = main.indexOf("<SessionEarthExperienceProvider>");
    const gateway = main.indexOf("<AuthGateway>", providerMount);
    const close = main.indexOf("</SessionEarthExperienceProvider>");
    expect(providerMount).toBeGreaterThan(-1);
    expect(gateway).toBeGreaterThan(providerMount);
    expect(close).toBeGreaterThan(main.indexOf("</AuthGateway>"));
    // Switching Atlas remounts WorkspaceGate, so the one read must be keyed by
    // the stable user and the resolved session - never by the organization.
    expect(provider).toContain("}, [accountKey, sessionResolved]);");
    expect(provider).not.toContain("organization");
  });
});

describe("Earth experience guest boundary", () => {
  it("never reaches the account preference endpoint from the share viewer", () => {
    for (const source of [sharedAtlas, sharedAtlasView]) {
      expect(source).not.toContain("account-preferences");
      expect(source).not.toContain("EarthExperience");
    }
  });

  it("mounts the share viewer outside the provider, so a guest has no reader", () => {
    const sharedBranch = main.indexOf("<SharedAtlasView");
    const providerMount = main.indexOf("<SessionEarthExperienceProvider>");
    // The guest branch is rendered before - and never inside - the provider
    // branch, so the guest tree holds neither a reader nor a writer.
    expect(sharedBranch).toBeGreaterThan(-1);
    expect(sharedBranch).toBeLessThan(providerMount);
    const guestTree = main.slice(sharedBranch, providerMount);
    expect(guestTree).not.toContain("EarthExperience");
  });
});
