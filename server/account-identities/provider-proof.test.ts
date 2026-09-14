import { describe, expect, it } from "vitest";
import {
  issueVerifiedProviderIdentityProof,
  verifyProviderIdentityProof,
} from "./provider-proof";

const SECRET = "test-provider-proof-secret";
const NOW = Date.parse("2026-09-13T12:00:00Z");

function issue() {
  return issueVerifiedProviderIdentityProof(SECRET, {
    actionId: "action-1",
    userId: "user-1",
    sessionId: "session-1",
    identity: {
      providerId: "google",
      subject: "provider-subject-1",
      email: "same@example.test",
      emailVerified: true,
    },
  }, NOW);
}

describe("provider identity proof", () => {
  it("binds provider subject proof to the action, user, session and expiry", () => {
    const proof = verifyProviderIdentityProof(SECRET, issue(), NOW + 1_000);
    expect(proof).toMatchObject({
      actionId: "action-1",
      userId: "user-1",
      sessionId: "session-1",
      identity: {
        providerId: "google",
        subject: "provider-subject-1",
        email: "same@example.test",
        emailVerified: true,
      },
    });
    expect(proof?.nonce).toBeTruthy();
  });

  it("fails closed on tampering, the wrong secret and expiry", () => {
    const token = issue();
    const [payload, signature] = token.split(".");
    expect(verifyProviderIdentityProof(SECRET, `${payload}x.${signature}`, NOW)).toBeNull();
    expect(verifyProviderIdentityProof("wrong-secret", token, NOW)).toBeNull();
    expect(verifyProviderIdentityProof(SECRET, token, NOW + 6 * 60 * 1000)).toBeNull();
  });
});
