import { createHmac, timingSafeEqual } from "node:crypto";
import { safeReturnPath, validProviderId } from "./identity-policy";

/**
 * #349: the server-held half of an explicit provider bind.
 *
 * The PKCE code verifier must never travel through the browser address bar or
 * through the provider's redirect -- that is the whole point of PKCE -- so it
 * lives in an HttpOnly, SameSite=Lax cookie for the ten minutes the
 * authorization round trip may take. `Lax` is required and sufficient: the
 * return from Google is a top-level GET navigation.
 *
 * The cookie is signed for the same reason `provider-proof.ts` signs its
 * token: the callback trusts every field in it -- which user, which session,
 * which single-use link intent, where the browser may be handed back to -- so
 * a value the browser could author would be a bind of the attacker's choosing.
 * The shape deliberately mirrors that module rather than sharing a helper with
 * it, so neither context can be replayed as the other.
 */
const BIND_STATE_CONTEXT = "startrips-identity-bind-state-v1";

export const IDENTITY_BIND_STATE_MAX_AGE_MS = 10 * 60 * 1000;
export const IDENTITY_BIND_COOKIE = "startrips.identity_bind";
export const IDENTITY_BIND_COOKIE_PATH = "/api/account-identities";

export type IdentityBindState = {
  version: 1;
  providerId: string;
  actionId: string;
  userId: string;
  sessionId: string;
  state: string;
  codeVerifier: string;
  returnPath: string;
  issuedAt: number;
  expiresAt: number;
};

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function signature(secret: string, encodedPayload: string): Buffer {
  return createHmac("sha256", secret)
    .update(BIND_STATE_CONTEXT)
    .update("\n")
    .update(encodedPayload)
    .digest();
}

export function issueIdentityBindState(
  secret: string,
  input: Omit<IdentityBindState, "version" | "issuedAt" | "expiresAt">,
  now = Date.now(),
): string {
  const payload: IdentityBindState = {
    version: 1,
    ...input,
    issuedAt: now,
    expiresAt: now + IDENTITY_BIND_STATE_MAX_AGE_MS,
  };
  const encoded = base64url(JSON.stringify(payload));
  return `${encoded}.${signature(secret, encoded).toString("base64url")}`;
}

export function readIdentityBindState(
  secret: string,
  token: string,
  now = Date.now(),
): IdentityBindState | null {
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const bind = parsed as Partial<IdentityBindState>;
  if (
    bind.version !== 1
    || !validProviderId(bind.providerId)
    || typeof bind.actionId !== "string"
    || bind.actionId.length < 1
    || bind.actionId.length > 128
    || typeof bind.userId !== "string"
    || typeof bind.sessionId !== "string"
    || typeof bind.state !== "string"
    || bind.state.length < 16
    || typeof bind.codeVerifier !== "string"
    || bind.codeVerifier.length < 43
    || bind.codeVerifier.length > 128
    || safeReturnPath(bind.returnPath) === null
    || typeof bind.issuedAt !== "number"
    || typeof bind.expiresAt !== "number"
    || bind.issuedAt > now + 30_000
    || bind.expiresAt < now
    || bind.expiresAt - bind.issuedAt > IDENTITY_BIND_STATE_MAX_AGE_MS
  ) return null;
  return bind as IdentityBindState;
}
