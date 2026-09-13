import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const PROVIDER_PROOF_CONTEXT = "startrips-provider-identity-proof-v1";
export const PROVIDER_IDENTITY_PROOF_MAX_AGE_MS = 5 * 60 * 1000;

export type VerifiedProviderIdentity = {
  providerId: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
};

export type ProviderIdentityProof = {
  version: 1;
  actionId: string;
  userId: string;
  sessionId: string;
  identity: VerifiedProviderIdentity;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
};

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function signature(secret: string, encodedPayload: string): Buffer {
  return createHmac("sha256", secret)
    .update(PROVIDER_PROOF_CONTEXT)
    .update("\n")
    .update(encodedPayload)
    .digest();
}

export function issueVerifiedProviderIdentityProof(
  secret: string,
  input: Omit<ProviderIdentityProof, "version" | "nonce" | "issuedAt" | "expiresAt">,
  now = Date.now(),
): string {
  const payload: ProviderIdentityProof = {
    version: 1,
    ...input,
    nonce: randomUUID(),
    issuedAt: now,
    expiresAt: now + PROVIDER_IDENTITY_PROOF_MAX_AGE_MS,
  };
  const encoded = base64url(JSON.stringify(payload));
  return `${encoded}.${signature(secret, encoded).toString("base64url")}`;
}

export function verifyProviderIdentityProof(
  secret: string,
  token: string,
  now = Date.now(),
): ProviderIdentityProof | null {
  const separator = token.lastIndexOf(".");
  if (separator <= 0 || separator === token.length - 1) return null;
  const encoded = token.slice(0, separator);
  let provided: Buffer;
  try {
    provided = Buffer.from(token.slice(separator + 1), "base64url");
  } catch {
    return null;
  }
  const expected = signature(secret, encoded);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const proof = payload as Partial<ProviderIdentityProof>;
  if (
    proof.version !== 1
    || typeof proof.actionId !== "string"
    || typeof proof.userId !== "string"
    || typeof proof.sessionId !== "string"
    || typeof proof.nonce !== "string"
    || typeof proof.issuedAt !== "number"
    || typeof proof.expiresAt !== "number"
    || proof.issuedAt > now + 30_000
    || proof.expiresAt < now
    || proof.expiresAt - proof.issuedAt > PROVIDER_IDENTITY_PROOF_MAX_AGE_MS
    || !proof.identity
    || typeof proof.identity !== "object"
    || typeof proof.identity.providerId !== "string"
    || !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(proof.identity.providerId)
    || typeof proof.identity.subject !== "string"
    || proof.identity.subject.length < 1
    || proof.identity.subject.length > 512
    || proof.identity.subject.trim() !== proof.identity.subject
    || (proof.identity.email !== null && (typeof proof.identity.email !== "string" || proof.identity.email.length < 3 || proof.identity.email.length > 320))
    || typeof proof.identity.emailVerified !== "boolean"
    || (proof.identity.emailVerified && proof.identity.email === null)
  ) return null;
  return proof as ProviderIdentityProof;
}
