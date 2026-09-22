import { describe, expect, it } from "vitest";
import {
  AccountIdentityRefusal,
  PENDING_BIND_STORAGE_KEY,
  beginProviderBind,
  bindableProviders,
  finishProviderBind,
  readProviderBindReturn,
  socialSignInErrorText,
  unlinkProviderIdentity,
  type BindStorage,
} from "./accountIdentityLink";

function memoryStorage(initial: Record<string, string> = {}): BindStorage & { entries: Record<string, string> } {
  const entries = { ...initial };
  return {
    entries,
    getItem: (key) => entries[key] ?? null,
    setItem: (key, value) => { entries[key] = value; },
    removeItem: (key) => { delete entries[key]; },
  };
}

type Route = { status?: number; body?: unknown };

function fakeFetch(routes: Record<string, Route>) {
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    const route = routes[url];
    if (!route) return new Response(JSON.stringify({ error: "NO_ROUTE" }), { status: 404 });
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const REVERIFY = "/api/account-identities/reverify/password";
const INTENTS = "/api/account-identities/link-intents";
const AUTHORIZE = "/api/account-identities/providers/google/authorize";
const COMPLETE = "/api/account-identities/link/complete";

describe("bindableProviders", () => {
  it("offers only a configured provider that is not already bound", () => {
    expect(bindableProviders({
      availableLinkProviders: ["google"],
      methods: [{
        id: "a", type: "password", providerId: "credential", emailHint: null,
        verified: true, usable: true, canUnlink: false,
      }],
    })).toEqual(["google"]);
    expect(bindableProviders({
      availableLinkProviders: ["google"],
      methods: [{
        id: "b", type: "provider", providerId: "google", emailHint: "te…@example.test",
        verified: true, usable: true, canUnlink: true,
      }],
    })).toEqual([]);
  });
});

describe("beginProviderBind", () => {
  it("spends the password for a grant, the grant for an intent, then stores only the intent", async () => {
    const storage = memoryStorage();
    const { fetchImpl, calls } = fakeFetch({
      [REVERIFY]: { body: { reverificationToken: "grant-1" } },
      [INTENTS]: { body: { actionId: "action-1", intentToken: "intent-1" } },
      [AUTHORIZE]: { body: { authorizationUrl: "https://accounts.google.test/o/oauth2/v2/auth?state=x" } },
    });

    const url = await beginProviderBind(
      { providerId: "google", password: "correct-horse-battery", returnPath: "/account" },
      { fetchImpl, storage },
    );

    expect(url).toContain("accounts.google.test");
    expect(calls.map((call) => call.url)).toEqual([REVERIFY, INTENTS, AUTHORIZE]);
    expect(calls[2]!.body).toMatchObject({ actionId: "action-1", returnPath: "/account" });
    const stored = JSON.parse(storage.entries[PENDING_BIND_STORAGE_KEY]!) as Record<string, unknown>;
    expect(stored).toEqual({ providerId: "google", intentToken: "intent-1" });
    // The password and the recent-control grant are gone with the call frame.
    expect(JSON.stringify(storage.entries)).not.toContain("grant-1");
    expect(JSON.stringify(storage.entries)).not.toContain("correct-horse-battery");
  });

  it("surfaces the server's refusal code and stores nothing", async () => {
    const storage = memoryStorage();
    const { fetchImpl } = fakeFetch({
      [REVERIFY]: { status: 403, body: { error: "IDENTITY_REVERIFY_FAILED" } },
    });
    await expect(beginProviderBind(
      { providerId: "google", password: "wrong", returnPath: "/account" },
      { fetchImpl, storage },
    )).rejects.toBeInstanceOf(AccountIdentityRefusal);
    expect(storage.entries[PENDING_BIND_STORAGE_KEY]).toBeUndefined();
  });
});

describe("readProviderBindReturn", () => {
  it("reads a proof, an error and nothing at all", () => {
    expect(readProviderBindReturn("#identityLink=proof&identityLinkProof=abc.def"))
      .toEqual({ kind: "proof", proof: "abc.def" });
    expect(readProviderBindReturn("#identityLink=error&identityLinkError=IDENTITY_PROVIDER_REFUSED"))
      .toEqual({ kind: "error", code: "IDENTITY_PROVIDER_REFUSED" });
    expect(readProviderBindReturn("#panel=journey")).toBeNull();
    expect(readProviderBindReturn("")).toBeNull();
  });
});

describe("finishProviderBind", () => {
  it("completes with the stored intent and clears it", async () => {
    const storage = memoryStorage({
      [PENDING_BIND_STORAGE_KEY]: JSON.stringify({ providerId: "google", intentToken: "intent-1" }),
    });
    const { fetchImpl, calls } = fakeFetch({
      [COMPLETE]: { body: { status: true, linked: true, alreadyLinked: false } },
    });

    const outcome = await finishProviderBind(
      { kind: "proof", proof: "abc.def" },
      { fetchImpl, storage },
    );

    expect(outcome).toEqual({ providerId: "google", linked: true, alreadyLinked: false });
    expect(calls[0]!.body).toEqual({ intentToken: "intent-1", providerProof: "abc.def" });
    expect(storage.entries[PENDING_BIND_STORAGE_KEY]).toBeUndefined();
  });

  it("clears the intent on a cancelled return without calling the server", async () => {
    const storage = memoryStorage({
      [PENDING_BIND_STORAGE_KEY]: JSON.stringify({ providerId: "google", intentToken: "intent-1" }),
    });
    const { fetchImpl, calls } = fakeFetch({});

    await expect(finishProviderBind(
      { kind: "error", code: "IDENTITY_PROVIDER_REFUSED" },
      { fetchImpl, storage },
    )).rejects.toMatchObject({ code: "IDENTITY_PROVIDER_REFUSED" });
    expect(calls).toHaveLength(0);
    expect(storage.entries[PENDING_BIND_STORAGE_KEY]).toBeUndefined();
  });

  it("refuses a return with no intent behind it", async () => {
    const { fetchImpl, calls } = fakeFetch({});
    await expect(finishProviderBind(
      { kind: "proof", proof: "abc.def" },
      { fetchImpl, storage: memoryStorage() },
    )).rejects.toMatchObject({ code: "IDENTITY_BIND_INTENT_MISSING" });
    expect(calls).toHaveLength(0);
  });
});

describe("unlinkProviderIdentity", () => {
  it("spends a fresh grant on the existing delete endpoint", async () => {
    const { fetchImpl, calls } = fakeFetch({
      [REVERIFY]: { body: { reverificationToken: "grant-2" } },
      "/api/account-identities/account-7": { body: { status: true, unlinked: true } },
    });

    const outcome = await unlinkProviderIdentity(
      { accountRecordId: "account-7", password: "correct-horse-battery" },
      { fetchImpl },
    );

    expect(outcome).toEqual({ unlinked: true, alreadyUnlinked: false });
    expect(calls[1]!.body).toEqual({ reverificationToken: "grant-2" });
  });
});

describe("social sign-in refusals", () => {
  // The provider is configured with `disableImplicitSignUp`, so this code is
  // what a sign-in with an unrecognised Google account comes back as. Telling
  // that person to retry would loop them forever; the message names the route
  // that works.
  it("sends an unregistered provider account to the sign-up route", () => {
    expect(socialSignInErrorText("signup_disabled")).toContain("注册");
    expect(socialSignInErrorText("signup_disabled"))
      .not.toBe(socialSignInErrorText("account_not_linked"));
    expect(socialSignInErrorText("signup_disabled")).not.toBe(socialSignInErrorText("unknown"));
  });
});
