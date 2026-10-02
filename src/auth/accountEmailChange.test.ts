import { describe, expect, it } from "vitest";
import {
  accountEmailChangeSurface,
  readAccountEmailChangeProof,
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

  it("reads only bounded old/new proof fragments", () => {
    const token = "t".repeat(48);
    expect(readAccountEmailChangeProof("#stage=old&token=" + token)).toEqual({ stage: "old", token });
    expect(readAccountEmailChangeProof("#stage=new&token=" + token)).toEqual({ stage: "new", token });
    expect(readAccountEmailChangeProof("#stage=other&token=" + token)).toBeNull();
    expect(readAccountEmailChangeProof("#stage=old&token=short")).toBeNull();
    expect(readAccountEmailChangeProof("#stage=old&token=" + "t".repeat(513))).toBeNull();
  });
});
