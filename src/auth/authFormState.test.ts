import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AUTH_FORM_STATUSES, authExceptionEvent, authFormReducer, authProviderErrorEvent, authServiceErrorEvent, createAuthFormState } from "./authFormState";


describe("auth form state machine", () => {
  it("exposes every recoverable authentication state", () => {
    expect(AUTH_FORM_STATUSES).toEqual([
      "idle",
      "submitting",
      "validation-error",
      "network-error",
      "rate-limited",
      "verification-required",
      "email-sent",
      "authenticated",
    ]);
  });

  it("makes duplicate submit a no-op while submitting", () => {
    const started = authFormReducer(createAuthFormState(), { type: "submit" });
    expect(authFormReducer(started, { type: "submit" })).toBe(started);
  });

  it("ignores a stale response after mode switch", () => {
    const started = authFormReducer(createAuthFormState("sign-in"), { type: "submit" });
    const switched = authFormReducer(started, { type: "switch-mode", mode: "sign-up" });
    const stale = authFormReducer(switched, { type: "authenticated", requestId: started.requestId });
    expect(stale).toBe(switched);
    expect(stale.status).toBe("idle");
  });

  it("classifies a 429 response as rate limited", () => {
    const started = authFormReducer(createAuthFormState(), { type: "submit" });
    const event = authServiceErrorEvent(started.requestId, { status: 429 }, "a@b.test");
    expect(authFormReducer(started, event).status).toBe("rate-limited");
  });

  it("classifies provider throttling without losing provider refusal text", () => {
    const started = authFormReducer(createAuthFormState(), { type: "submit" });
    expect(authProviderErrorEvent(started.requestId, { status: 429 }, "provider refused").type).toBe("rate-limited");
    expect(authProviderErrorEvent(started.requestId, { code: "signup_disabled" }, "provider refused")).toMatchObject({
      type: "validation-error",
      message: "provider refused",
    });
  });

  it("leaves submitting after exceptions and cancellation", () => {
    for (const error of [new Error("offline"), { name: "AbortError" }]) {
      const started = authFormReducer(createAuthFormState(), { type: "submit" });
      const next = authFormReducer(started, authExceptionEvent(started.requestId, error));
      expect(next.status).toBe("network-error");
    }
  });

  it("maps an unverified-email refusal to verification recovery", () => {
    const started = authFormReducer(createAuthFormState(), { type: "submit" });
    const code = ["EMAIL", "NOT", "VERIFIED"].join("_");
    const event = authServiceErrorEvent(started.requestId, { code }, "a@b.test");
    const next = authFormReducer(started, event);
    expect(next.status).toBe("verification-required");
    expect(next.verificationEmail).toBe("a@b.test");
  });

  it("keeps verification recovery available when resend is rate limited", () => {
    const started = authFormReducer(createAuthFormState(), { type: "submit" });
    const verification = authFormReducer(started, {
      type: "verification-required",
      requestId: started.requestId,
      email: "a@b.test",
    });
    const resend = authFormReducer(verification, { type: "submit" });
    const limited = authFormReducer(resend, authServiceErrorEvent(resend.requestId, { status: 429 }, "a@b.test"));
    expect(limited.status).toBe("rate-limited");
    expect(limited.verificationEmail).toBe("a@b.test");
  });

  it("keeps the password field out of URL, logs, and persistent browser storage", () => {
    const auth = readFileSync("src/auth/AuthGateway.tsx", "utf8");
    const form = auth.slice(auth.indexOf("function AuthForm"), auth.indexOf("const RESET_PASSWORD_MESSAGES"));
    expect(form).toContain('type="password"');
    expect(form).not.toContain("console.");
    expect(form).not.toContain("localStorage");
    expect(form).not.toContain("sessionStorage");
    expect(form).not.toContain('searchParams.set("password"');
  });
});
