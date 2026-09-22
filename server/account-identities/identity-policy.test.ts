import { describe, expect, it } from "vitest";
import {
  accountIdentityUsable,
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
