import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  APPLE_CLIENT_SECRET_LIFETIME_SECONDS,
  APPLE_CLIENT_SECRET_MAX_LIFETIME_SECONDS,
  APPLE_CLIENT_SECRET_RENEW_BEFORE_SECONDS,
  createAppleClientSecret,
  createAppleClientSecretSource,
} from "./apple-client-secret";

const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
});

const CREDENTIAL = {
  serviceId: "com.example.startrips.web",
  teamId: "TEAM123456",
  keyId: "KEY7890123",
  privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};

const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);

function decode(secret: string) {
  const [header, payload] = secret.split(".");
  return {
    header: JSON.parse(Buffer.from(header, "base64url").toString("utf8")),
    payload: JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
  };
}

describe("Apple client secret", () => {
  it("mints the claim set Apple's token endpoint requires", () => {
    const { header, payload } = decode(createAppleClientSecret(CREDENTIAL, NOW));
    expect(header).toEqual({ alg: "ES256", kid: CREDENTIAL.keyId, typ: "JWT" });
    expect(payload).toEqual({
      iss: CREDENTIAL.teamId,
      sub: CREDENTIAL.serviceId,
      aud: "https://appleid.apple.com",
      iat: Math.floor(NOW / 1000),
      exp: Math.floor(NOW / 1000) + APPLE_CLIENT_SECRET_LIFETIME_SECONDS,
    });
  });

  it("signs a JOSE r||s signature the downloaded key verifies", () => {
    const secret = createAppleClientSecret(CREDENTIAL, NOW);
    const [header, payload, signature] = secret.split(".");
    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${payload}`),
        {
          key: createPublicKey(publicKey.export({ type: "spki", format: "pem" }).toString()),
          dsaEncoding: "ieee-p1363",
        },
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
  });

  it("refuses a lifetime Apple would reject", () => {
    expect(() => createAppleClientSecret(
      CREDENTIAL,
      NOW,
      APPLE_CLIENT_SECRET_MAX_LIFETIME_SECONDS + 1,
    )).toThrow("between 1 second and six months");
  });

  it("reuses one secret across a burst and re-mints before it expires", () => {
    const source = createAppleClientSecretSource(CREDENTIAL);
    const first = source.current(NOW);
    expect(source.current(NOW + 1_000)).toBe(first);

    const renewAt = NOW
      + (APPLE_CLIENT_SECRET_LIFETIME_SECONDS
        - APPLE_CLIENT_SECRET_RENEW_BEFORE_SECONDS) * 1000;
    const renewed = source.current(renewAt);
    expect(renewed).not.toBe(first);
    // The replacement is still live when the one it replaced expires, so a
    // long-running process never presents an expired secret.
    expect(decode(renewed).payload.exp * 1000)
      .toBeGreaterThan(decode(first).payload.exp * 1000);
  });
});
