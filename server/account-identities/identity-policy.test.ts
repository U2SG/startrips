import { describe, expect, it } from "vitest";
import {
  accountIdentityUsable,
  buildIdentityMethods,
  hasUsableLoginAfterRemoval,
  redactIdentityEmail,
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
    expect(accountIdentityUsable(accounts[0]!, undefined, true, new Set())).toBe(true);
    expect(accountIdentityUsable({ ...accounts[0]!, password: null }, undefined, true, new Set())).toBe(false);
    expect(accountIdentityUsable(accounts[0]!, undefined, false, new Set())).toBe(false);
    expect(accountIdentityUsable(accounts[1]!, ownerships[0], true, new Set(["google"]))).toBe(true);
    expect(accountIdentityUsable(accounts[1]!, ownerships[0], true, new Set())).toBe(false);
    expect(accountIdentityUsable(accounts[1]!, { ...ownerships[0]!, providerEmailVerified: false }, true, new Set(["google"]))).toBe(false);
    expect(accountIdentityUsable(accounts[1]!, { ...ownerships[0]!, providerEmail: null }, true, new Set(["google"]))).toBe(false);
  });

  it("protects the last usable method rather than the last raw account row", () => {
    const incompleteProvider = [{ ...ownerships[0]!, providerEmailVerified: false }];
    expect(hasUsableLoginAfterRemoval("credential", accounts, incompleteProvider, true, new Set(["google"]))).toBe(false);
    expect(hasUsableLoginAfterRemoval("credential", accounts, ownerships, true, new Set(["google"]))).toBe(true);
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
        canUnlink: true,
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
