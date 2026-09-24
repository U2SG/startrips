import { describe, expect, it } from "vitest";
import { resolvePasswordResetOutcome } from "./passwordResetOutcome";

describe("password reset outcome", () => {
  it("reports success only when the endpoint confirms the write", () => {
    expect(resolvePasswordResetOutcome({ kind: "response", data: { status: true } })).toBe("success");
    expect(resolvePasswordResetOutcome({ kind: "response", data: { status: false } })).toBe("unconfirmed");
    expect(resolvePasswordResetOutcome({ kind: "response", data: null })).toBe("unconfirmed");
    expect(resolvePasswordResetOutcome({
      kind: "response",
      data: { status: true },
      error: { code: "SERVER_ERROR" },
    })).toBe("unconfirmed");
  });

  it("treats the library's shared malformed, expired and spent token code as a link to replace", () => {
    expect(resolvePasswordResetOutcome({
      kind: "response",
      error: { code: "INVALID_TOKEN" },
    })).toBe("invalid-link");
  });

  it("keeps password validation recoverable without claiming that the link expired", () => {
    expect(resolvePasswordResetOutcome({
      kind: "response",
      error: { code: "PASSWORD_TOO_SHORT" },
    })).toBe("password-too-short");
    expect(resolvePasswordResetOutcome({
      kind: "response",
      error: { code: "PASSWORD_TOO_LONG" },
    })).toBe("password-too-long");
  });

  it("keeps a thrown request distinct from an unconfirmed server response", () => {
    expect(resolvePasswordResetOutcome({ kind: "exception" })).toBe("connection-lost");
    expect(resolvePasswordResetOutcome({
      kind: "response",
      error: { code: "INTERNAL_SERVER_ERROR" },
    })).toBe("unconfirmed");
  });
});
