import { describe, expect, it } from "vitest";
import {
  AccountEmailChangeRefusal,
  accountEmailChangeRefusalSurface,
  accountEmailChangeRefusalText,
  accountEmailChangeSurface,
  canStartAccountEmailChange,
  isRetryableAccountEmailChangeProofError,
  cancelAccountEmailChange,
  consumeAccountEmailChangeProof,
  loadAccountEmailChange,
  readAccountEmailChangeProof,
  startAccountEmailChange,
  type AccountEmailChangeView,
} from "./accountEmailChange";

function change(overrides: Partial<AccountEmailChangeView> = {}): AccountEmailChangeView {
  return {
    id: "change-1",
    currentEmail: "old@startrips.test",
    proposedEmail: "new@startrips.test",
    status: "pending",
    oldConfirmedAt: null,
    newVerifiedAt: null,
    expiresAt: "2026-10-03T01:00:00Z",
    closedAt: null,
    createdAt: "2026-10-03T00:00:00Z",
    updatedAt: "2026-10-03T00:00:00Z",
    ...overrides,
  };
}

const BASE_URL = "/api/account-identities/email-change";
const REVERIFY_URL = "/api/account-identities/reverify/password";

type Reply = { status?: number; body: unknown };

function stubFetch(replies: Record<string, Reply>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const reply = replies[url];
    if (!reply) throw new Error(`unexpected request: ${url}`);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function sentBody(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

describe("account email change", () => {
  it("maps the transaction lifecycle onto truthful account surfaces", () => {
    expect(accountEmailChangeSurface(null)).toBe("email-change");
    expect(accountEmailChangeSurface(change())).toBe("email-change-pending");
    expect(accountEmailChangeSurface(change({ oldConfirmedAt: "now" })))
      .toBe("email-change-verifying-new");
    expect(accountEmailChangeSurface(change({ newVerifiedAt: "now" })))
      .toBe("email-change-verifying-old");
    expect(accountEmailChangeSurface(change({ status: "completed" })))
      .toBe("email-change-completed");
    expect(accountEmailChangeSurface(change({ status: "cancelled" })))
      .toBe("email-change-cancelled");
    for (const status of ["replaced", "expired", "conflicted"] as const) {
      expect(accountEmailChangeSurface(change({ status }))).toBe("email-change-conflicted");
    }
  });

  it("permits a fresh change only after the transaction status is known", () => {
    expect(canStartAccountEmailChange(null, false)).toBe(false);
    expect(canStartAccountEmailChange(null)).toBe(true);
    expect(canStartAccountEmailChange(change())).toBe(false);
    expect(canStartAccountEmailChange(change({ status: "completed" }))).toBe(true);
    expect(canStartAccountEmailChange(change({ status: "cancelled" }))).toBe(true);
  });

  it("keeps proof capabilities retryable only for transient failures", () => {
    expect(isRetryableAccountEmailChangeProofError(new TypeError("network"))).toBe(true);
    expect(isRetryableAccountEmailChangeProofError(new AccountEmailChangeRefusal("REQUEST_FAILED_500"))).toBe(true);
    expect(isRetryableAccountEmailChangeProofError(new AccountEmailChangeRefusal("REQUEST_FAILED_429"))).toBe(true);
    expect(isRetryableAccountEmailChangeProofError(new AccountEmailChangeRefusal("EMAIL_CHANGE_PROOF_INVALID"))).toBe(false);
  });

  it("keeps recovery and delivery failure as distinct truthful surfaces", () => {
    expect(accountEmailChangeRefusalSurface("EMAIL_CHANGE_RECOVERY_REQUIRED"))
      .toBe("email-change-recovery-required");
    expect(accountEmailChangeRefusalSurface("EMAIL_CHANGE_DELIVERY_FAILED"))
      .toBe("email-change-delivery-failed");
    expect(accountEmailChangeRefusalText("EMAIL_CHANGE_RECOVERY_REQUIRED"))
      .not.toBe(accountEmailChangeRefusalText("EMAIL_CHANGE_DELIVERY_FAILED"));
    expect(accountEmailChangeRefusalSurface("EMAIL_CHANGE_ACCOUNT_CHANGED"))
      .toBe("email-change-conflicted");
  });

  it("reads only bounded old/new proof fragments", () => {
    const token = "t".repeat(48);
    expect(readAccountEmailChangeProof("#stage=old&token=" + token)).toEqual({ stage: "old", token });
    expect(readAccountEmailChangeProof("#stage=new&token=" + token)).toEqual({ stage: "new", token });
    expect(readAccountEmailChangeProof("#stage=other&token=" + token)).toBeNull();
    expect(readAccountEmailChangeProof("#stage=old&token=short")).toBeNull();
    expect(readAccountEmailChangeProof("#stage=old&token=" + "t".repeat(513))).toBeNull();
  });

  it("loads the latest transaction with the authenticated session", async () => {
    const latest = change();
    const { fetchImpl, calls } = stubFetch({ [BASE_URL]: { body: { change: latest } } });
    expect(await loadAccountEmailChange({ fetchImpl })).toEqual(latest);
    expect(calls[0]?.url).toBe(BASE_URL);
    expect(calls[0]?.init?.credentials).toBe("include");
  });

  it("posts proof capabilities in bodies and keeps cancel capability-free", async () => {
    const oldProof = "o".repeat(48);
    const next = change({ oldConfirmedAt: "2026-10-03T00:10:00Z" });
    const cancelled = change({ status: "cancelled", closedAt: "2026-10-03T00:12:00Z" });
    const { fetchImpl, calls } = stubFetch({
      [BASE_URL + "/confirm-old"]: { body: { change: next, completed: false } },
      [BASE_URL + "/cancel"]: { body: { change: cancelled } },
    });
    expect(await consumeAccountEmailChangeProof({ stage: "old", token: oldProof }, { fetchImpl }))
      .toEqual({ change: next, completed: false });
    expect(await cancelAccountEmailChange({ fetchImpl })).toEqual(cancelled);
    expect(sentBody(calls[0]?.init)).toEqual({ token: oldProof });
    expect(sentBody(calls[1]?.init)).toEqual({});
    expect(calls.every((call) => !call.url.includes(oldProof) && !call.url.includes("?"))).toBe(true);
  });

  it("spends the recent-control grant on start without putting it in the URL", async () => {
    const { fetchImpl, calls } = stubFetch({
      [REVERIFY_URL]: { body: { reverificationToken: "grant-fixture" } },
      [BASE_URL]: { status: 201, body: { change: change() } },
    });
    await startAccountEmailChange({
      newEmail: "new@startrips.test",
      reverification: { kind: "password", password: "fixture" },
      oldAddressAvailable: true,
    }, { fetchImpl });
    expect(calls.map((call) => call.url)).toEqual([REVERIFY_URL, BASE_URL]);
    expect(sentBody(calls[1]?.init).reverificationToken).toBe("grant-fixture");
    expect(calls.every((call) => !call.url.includes("grant-fixture"))).toBe(true);
  });

  it("keeps completed server state when session refresh observes revocation", async () => {
    const proof = "n".repeat(48);
    const completed = change({
      status: "completed",
      oldConfirmedAt: "2026-10-03T00:10:00Z",
      newVerifiedAt: "2026-10-03T00:11:00Z",
      closedAt: "2026-10-03T00:11:00Z",
    });
    const { fetchImpl } = stubFetch({
      [BASE_URL + "/verify-new"]: { body: { change: completed, completed: true } },
    });
    let refreshes = 0;
    expect(await consumeAccountEmailChangeProof(
      { stage: "new", token: proof },
      { fetchImpl, refreshSession: async () => { refreshes += 1; throw new Error("revoked"); } },
    )).toEqual({ change: completed, completed: true });
    expect(refreshes).toBe(1);
  });

  it("keeps server refusals typed for account-surface recovery handling", async () => {
    const { fetchImpl } = stubFetch({
      [BASE_URL]: { status: 401, body: { error: "UNAUTHORIZED" } },
    });
    await expect(loadAccountEmailChange({ fetchImpl })).rejects
      .toBeInstanceOf(AccountEmailChangeRefusal);
  });
});
