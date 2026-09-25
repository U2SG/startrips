import { describe, expect, it } from "vitest";
import {
  accountIdentityLoginUsable,
  accountIdentityRecoveryChannel,
  buildIdentityMethods,
  hasUsableLoginAfterRemoval,
  redactIdentityEmail,
  safeReturnPath,
  validProviderId,
  type AccountIdentityAccount,
  type AccountIdentityOwnership,
} from "./identity-policy";

const NOW = new Date("2026-09-13T12:00:00Z");
const accounts: AccountIdentityAccount[] = [
  { id: "credential", providerId: "credential", accountId: "user-1", password: "hashed", },
  { id: "google", providerId: "google", accountId: "google-subject", password: null },
];
const ownerships: AccountIdentityOwnership[] = [{
  accountRecordId: "google",
  providerId: "google",
  providerSubject: "google-subject",
  providerEmail: "relay-user@example.test",
  providerEmailVerified: true,
  verifiedAt: NOW,
}];

describe("account identity policy", () => {
  it("counts only actually usable password/provider methods", () => {
    expect(accountIdentityLoginUsable(accounts[0]!, undefined, true, new Set())).toBe(true);
    expect(accountIdentityLoginUsable({ ...accounts[0]!, password: null }, undefined, true, new Set())).toBe(false);
    expect(accountIdentityLoginUsable(accounts[0]!, undefined, false, new Set())).toBe(false);
    expect(accountIdentityLoginUsable(accounts[1]!, ownerships[0], true, new Set(["google"]))).toBe(true);
    expect(accountIdentityLoginUsable(accounts[1]!, ownerships[0], true, new Set())).toBe(false);
    expect(accountIdentityLoginUsable(accounts[1]!, { ...ownerships[0]!, providerEmailVerified: false }, true, new Set(["google"]))).toBe(false);
    expect(accountIdentityLoginUsable(accounts[1]!, { ...ownerships[0]!, providerEmail: null }, true, new Set(["google"]))).toBe(false);
  });

  it("protects the last usable method rather than the last raw account row", () => {
    const incompleteProvider = [{ ...ownerships[0]!, providerEmailVerified: false }];
    expect(hasUsableLoginAfterRemoval("credential", accounts, incompleteProvider, true, new Set(["google"]))).toBe(false);
    expect(hasUsableLoginAfterRemoval("credential", accounts, ownerships, true, new Set(["google"]))).toBe(true);
  });

  describe("#486 login usability versus recovery reachability", () => {
    // A bind-time claim years old, on a relay-shaped address whose delivery
    // may have been revoked since -- nothing in the row says it still arrives.
    const staleProvider: AccountIdentityOwnership = {
      accountRecordId: "apple",
      providerId: "apple",
      providerSubject: "apple-subject",
      providerEmail: "relay-user@privaterelay.appleid.com",
      providerEmailVerified: true,
      verifiedAt: new Date("2021-01-01T00:00:00Z"),
    };
    const appleAccount: AccountIdentityAccount = {
      id: "apple",
      providerId: "apple",
      accountId: "apple-subject",
      password: null,
    };
    const providers = new Set(["apple"]);

    it("keeps a provider login usable however old its email verification is", () => {
      expect(accountIdentityLoginUsable(appleAccount, staleProvider, false, providers)).toBe(true);
    });

    it("never treats a bind-time provider email claim as a reachable recovery channel", () => {
      expect(accountIdentityRecoveryChannel(appleAccount, true)).toBe(false);
      expect(accountIdentityRecoveryChannel(accounts[1]!, true)).toBe(false);
      // The two dimensions diverge on the same row.
      expect(accountIdentityLoginUsable(appleAccount, staleProvider, true, providers))
        .not.toBe(accountIdentityRecoveryChannel(appleAccount, true));
    });

    it("reads the Account's own verified address as the credential recovery channel", () => {
      expect(accountIdentityRecoveryChannel(accounts[0]!, true)).toBe(true);
      expect(accountIdentityRecoveryChannel(accounts[0]!, false)).toBe(false);
    });

    it("guards unlink on the remaining login, not on provider email reachability", () => {
      const providerOnly = [appleAccount, { ...appleAccount, id: "google", providerId: "google", accountId: "google-subject" }];
      const both = [staleProvider, { ...staleProvider, accountRecordId: "google", providerId: "google", providerSubject: "google-subject" }];
      const configured = new Set(["apple", "google"]);
      expect(hasUsableLoginAfterRemoval("google", providerOnly, both, false, configured)).toBe(true);
      expect(hasUsableLoginAfterRemoval("google", providerOnly, both, false, new Set(["google"]))).toBe(false);
      expect(buildIdentityMethods(providerOnly, both, "owner@example.test", false, configured)
        .map((method) => [method.id, method.usable, method.canUnlink]))
        .toEqual([["apple", true, true], ["google", true, true]]);
    });
  });

  it("returns redacted method metadata only and derives canUnlink from usability", () => {
    expect(buildIdentityMethods(
      accounts,
      ownerships,
      "owner@example.test",
      true,
      new Set(["google"]),
    )).toEqual([
      {
        id: "credential",
        type: "password",
        providerId: "credential",
        emailHint: "ow…@example.test",
        verified: true,
        usable: true,
        canUnlink: false,
      },
      {
        id: "google",
        type: "provider",
        providerId: "google",
        emailHint: "re…@example.test",
        verified: true,
        usable: true,
        canUnlink: true,
      },
    ]);
  });

  it("does not expose invalid emails and accepts only bounded provider namespaces", () => {
    expect(redactIdentityEmail("invalid")).toBeNull();
    expect(redactIdentityEmail(null)).toBeNull();
    expect(validProviderId("google")).toBe(true);
    expect(validProviderId("oidc.example-1")).toBe(true);
    expect(validProviderId("Google")).toBe(false);
    expect(validProviderId("../google")).toBe(false);
  });
});

describe("safeReturnPath", () => {
  it("accepts a same-document path", () => {
    expect(safeReturnPath("/")).toBe("/");
    expect(safeReturnPath("/account?panel=identity")).toBe("/account?panel=identity");
  });

  it("rejects every way out of the origin", () => {
    // An absolute URL is never accepted, so no prefix comparison against
    // appOrigin can be fooled by a lookalike host.
    expect(safeReturnPath("https://evil.test/")).toBeNull();
    expect(safeReturnPath("http://127.0.0.1:5173.evil.test/")).toBeNull();
    // Authority-relative forms leave the origin without naming a scheme.
    expect(safeReturnPath("//evil.test/")).toBeNull();
    expect(safeReturnPath("/\\evil.test/")).toBeNull();
    expect(safeReturnPath("javascript:alert(1)")).toBeNull();
    expect(safeReturnPath("account")).toBeNull();
  });

  it("rejects a value that could split a Location header", () => {
    expect(safeReturnPath("/account\r\nLocation: https://evil.test/")).toBeNull();
    expect(safeReturnPath("/account\u0000")).toBeNull();
  });

  it("rejects a non-string or an unbounded value", () => {
    expect(safeReturnPath(undefined)).toBeNull();
    expect(safeReturnPath(12)).toBeNull();
    expect(safeReturnPath("")).toBeNull();
    expect(safeReturnPath(`/${"a".repeat(512)}`)).toBeNull();
  });
});
