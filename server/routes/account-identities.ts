import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { auth } from "../auth";
import { serverConfig } from "../config";
import {
  AccountIdentityError,
  completeIdentityLink,
  createIdentityLinkIntent,
  createPasswordReverificationGrant,
  listAccountIdentityMethods,
  recordIdentityRefusal,
  unlinkAccountIdentity,
} from "../account-identities/account-identity-repository";
import {
  safeReturnPath,
  validProviderId,
} from "../account-identities/identity-policy";
import {
  IDENTITY_BIND_COOKIE,
  IDENTITY_BIND_COOKIE_PATH,
  IDENTITY_BIND_STATE_MAX_AGE_MS,
  issueIdentityBindState,
  readIdentityBindState,
} from "../account-identities/identity-bind-state";
import {
  issueVerifiedProviderIdentityProof,
  verifyProviderIdentityProof,
} from "../account-identities/provider-proof";
import {
  configuredSocialProviderIds,
  createBindProvider,
  identityBindRedirectUri,
} from "../account-identities/social-providers";
import { consumePasswordReverificationBudget } from "../account-identities/reverification-rate-limit";
import { clientAddress } from "../share-rate-limit";
import { readJsonObject } from "./json-body";

export type AccountIdentityRouteOptions = {
  usableProviderIds?: ReadonlySet<string>;
  linkableProviderIds?: ReadonlySet<string>;
  proofSecret?: string;
};

/**
 * What the bind callback reports back to the app, always in the URL FRAGMENT.
 *
 * A fragment never reaches a server, a proxy log or a `Referer` header, which
 * is what makes it the one place a five-minute single-use provider proof may
 * ride. The client reads it once and clears it with `history.replaceState`.
 */
const IDENTITY_BIND_RESULT_PARAM = "identityLink";
const IDENTITY_BIND_PROOF_PARAM = "identityLinkProof";
const IDENTITY_BIND_ERROR_PARAM = "identityLinkError";

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin === serverConfig.appOrigin;
}

function refusalStatus(error: AccountIdentityError): 400 | 403 | 404 | 409 {
  switch (error.code) {
    case "IDENTITY_ACCOUNT_NOT_FOUND":
      return 404;
    case "IDENTITY_ACTION_SESSION_CHANGED":
    case "IDENTITY_PROVIDER_MISMATCH":
    case "IDENTITY_PROVIDER_NOT_CONFIGURED":
      return 403;
    case "IDENTITY_ACTION_INVALID":
      return 400;
    default:
      return 409;
  }
}

async function requireSession(request: Request) {
  return await auth.api.getSession({ headers: request.headers });
}

function stringField(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function createAccountIdentityRoutes(options: AccountIdentityRouteOptions = {}) {
  const routes = new Hono();
  const usableProviderIds = options.usableProviderIds ?? new Set<string>();
  const linkableProviderIds = options.linkableProviderIds ?? usableProviderIds;
  const proofSecret = options.proofSecret ?? serverConfig.authSecret;

  function bindReturn(returnPath: string, params: Record<string, string>) {
    const fragment = new URLSearchParams(params).toString();
    return `${serverConfig.appOrigin}${returnPath}#${fragment}`;
  }

  routes.get("/", async (context) => {
    const session = await requireSession(context.req.raw);
    if (!session) return context.json({ error: "UNAUTHORIZED" }, 401);
    const methods = await listAccountIdentityMethods(session.user.id, usableProviderIds);
    // Read live rather than snapshotting at construction: `link-intents` and
    // `link/complete` gate on `linkableProviderIds.has(...)` at request time.
    // Their format gate runs ahead of that set gate, so a configured id that
    // `validProviderId` cannot parse is refused as an invalid request and is
    // never advertised here. Every advertised provider is one those writes accept.
    const availableLinkProviders = [...linkableProviderIds].filter(validProviderId).sort();
    return context.json({ methods, availableLinkProviders });
  });

  // The sign-in gate renders its provider button from this, so it has to be
  // readable without a session. It exposes only which providers this
  // deployment configured -- the same fact the button itself would reveal.
  routes.get("/providers", (context) => context.json({
    signInProviders: [...linkableProviderIds].filter(validProviderId).sort(),
  }));

  routes.post("/reverify/password", async (context) => {
    if (!sameOrigin(context.req.raw)) return context.json({ error: "IDENTITY_ORIGIN_REQUIRED" }, 403);
    const session = await requireSession(context.req.raw);
    if (!session) return context.json({ error: "UNAUTHORIZED" }, 401);
    const body = await readJsonObject(() => context.req.json());
    const password = body && stringField(body, "password");
    if (!password) return context.json({ error: "INVALID_IDENTITY_REVERIFY" }, 400);
    const budget = await consumePasswordReverificationBudget({
      userId: session.user.id,
      sessionId: session.session.id,
      address: clientAddress(context),
    });
    if (!budget.allowed) {
      context.header("Retry-After", String(budget.retryAfterSeconds));
      return context.json({ error: "IDENTITY_REVERIFY_RATE_LIMITED" }, 429);
    }
    try {
      await auth.api.verifyPassword({
        body: { password },
        headers: context.req.raw.headers,
      });
    } catch {
      await recordIdentityRefusal({
        userId: session.user.id,
        event: "reverify",
        reason: "IDENTITY_REVERIFY_FAILED",
      });
      return context.json({ error: "IDENTITY_REVERIFY_FAILED" }, 403);
    }
    const grant = await createPasswordReverificationGrant(
      session.user.id,
      session.session.id,
    );
    return context.json({
      reverificationToken: grant.token,
      expiresAt: grant.expiresAt.toISOString(),
    });
  });

  routes.post("/link-intents", async (context) => {
    if (!sameOrigin(context.req.raw)) return context.json({ error: "IDENTITY_ORIGIN_REQUIRED" }, 403);
    const session = await requireSession(context.req.raw);
    if (!session) return context.json({ error: "UNAUTHORIZED" }, 401);
    const body = await readJsonObject(() => context.req.json());
    const providerId = body && stringField(body, "providerId");
    const reverificationToken = body && stringField(body, "reverificationToken");
    if (!providerId || !validProviderId(providerId) || !reverificationToken) {
      return context.json({ error: "INVALID_IDENTITY_LINK_INTENT" }, 400);
    }
    if (!linkableProviderIds.has(providerId)) {
      await recordIdentityRefusal({
        userId: session.user.id,
        event: "link-intent",
        providerId,
        reason: "IDENTITY_PROVIDER_NOT_CONFIGURED",
      });
      return context.json({ error: "IDENTITY_PROVIDER_NOT_CONFIGURED" }, 403);
    }
    try {
      const intent = await createIdentityLinkIntent({
        userId: session.user.id,
        sessionId: session.session.id,
        providerId,
        reverificationToken,
      });
      return context.json({
        actionId: intent.actionId,
        intentToken: intent.token,
        expiresAt: intent.expiresAt.toISOString(),
      });
    } catch (error) {
      if (!(error instanceof AccountIdentityError)) throw error;
      await recordIdentityRefusal({
        userId: session.user.id,
        event: "link-intent",
        providerId,
        reason: error.code,
      });
      return context.json({ error: error.code }, refusalStatus(error));
    }
  });

  routes.post("/link/complete", async (context) => {
    if (!sameOrigin(context.req.raw)) return context.json({ error: "IDENTITY_ORIGIN_REQUIRED" }, 403);
    const session = await requireSession(context.req.raw);
    if (!session) return context.json({ error: "UNAUTHORIZED" }, 401);
    const body = await readJsonObject(() => context.req.json());
    const intentToken = body && stringField(body, "intentToken");
    const providerProof = body && stringField(body, "providerProof");
    if (!intentToken || !providerProof) {
      return context.json({ error: "INVALID_IDENTITY_LINK_PROOF" }, 400);
    }
    const proof = verifyProviderIdentityProof(proofSecret, providerProof);
    if (!proof) return context.json({ error: "IDENTITY_PROVIDER_PROOF_INVALID" }, 403);
    if (!linkableProviderIds.has(proof.identity.providerId)) {
      return context.json({ error: "IDENTITY_PROVIDER_NOT_CONFIGURED" }, 403);
    }
    if (proof.userId !== session.user.id || proof.sessionId !== session.session.id) {
      await recordIdentityRefusal({
        userId: session.user.id,
        event: "link",
        providerId: proof.identity.providerId,
        reason: "IDENTITY_ACTION_SESSION_CHANGED",
      });
      return context.json({ error: "IDENTITY_ACTION_SESSION_CHANGED" }, 403);
    }
    try {
      const result = await completeIdentityLink({
        userId: session.user.id,
        sessionId: session.session.id,
        intentToken,
        proof,
      });
      return context.json({ status: true, accountId: result.accountRecordId, linked: result.linked, alreadyLinked: result.alreadyLinked });
    } catch (error) {
      if (!(error instanceof AccountIdentityError)) throw error;
      await recordIdentityRefusal({
        userId: session.user.id,
        event: "link",
        providerId: proof.identity.providerId,
        reason: error.code,
      });
      return context.json({ error: error.code }, refusalStatus(error));
    }
  });

  // #349 step one of an explicit bind: hand the browser an authorization URL
  // for a link intent this session already holds. The PKCE verifier and the
  // decision of WHICH user, session and intent this round trip belongs to stay
  // in a signed HttpOnly cookie, so nothing the browser can rewrite is trusted
  // when the provider hands it back.
  routes.post("/providers/:providerId/authorize", async (context) => {
    if (!sameOrigin(context.req.raw)) return context.json({ error: "IDENTITY_ORIGIN_REQUIRED" }, 403);
    const session = await requireSession(context.req.raw);
    if (!session) return context.json({ error: "UNAUTHORIZED" }, 401);
    const providerId = context.req.param("providerId");
    const body = await readJsonObject(() => context.req.json());
    const actionId = body && stringField(body, "actionId");
    const returnPath = safeReturnPath(body?.returnPath);
    if (!validProviderId(providerId) || !actionId || actionId.length > 128 || !returnPath) {
      return context.json({ error: "INVALID_IDENTITY_LINK_AUTHORIZE" }, 400);
    }
    const provider = linkableProviderIds.has(providerId) ? createBindProvider(providerId) : null;
    if (!provider) {
      await recordIdentityRefusal({
        userId: session.user.id,
        event: "link-intent",
        providerId,
        reason: "IDENTITY_PROVIDER_NOT_CONFIGURED",
      });
      return context.json({ error: "IDENTITY_PROVIDER_NOT_CONFIGURED" }, 403);
    }
    const state = randomBytes(32).toString("base64url");
    // 86 characters, inside RFC 7636's 43..128 range.
    const codeVerifier = randomBytes(64).toString("base64url");
    const authorizationUrl = await provider.createAuthorizationURL({
      state,
      codeVerifier,
      redirectURI: identityBindRedirectUri(providerId),
    });
    setCookie(context, IDENTITY_BIND_COOKIE, issueIdentityBindState(proofSecret, {
      providerId,
      actionId,
      userId: session.user.id,
      sessionId: session.session.id,
      state,
      codeVerifier,
      returnPath,
    }), {
      path: IDENTITY_BIND_COOKIE_PATH,
      httpOnly: true,
      // The return from the provider is a top-level GET navigation, which
      // Lax allows and Strict would drop.
      sameSite: "Lax",
      secure: serverConfig.production,
      maxAge: IDENTITY_BIND_STATE_MAX_AGE_MS / 1000,
    });
    return context.json({ authorizationUrl: authorizationUrl.toString() });
  });

  // Step two: the provider hands the browser back here. Every exit is a
  // redirect to the app path the cookie recorded, so a person who cancelled,
  // was refused, or came back to a different account lands somewhere that can
  // explain it rather than on a raw JSON error.
  routes.get("/providers/:providerId/callback", async (context) => {
    const providerId = context.req.param("providerId");
    const cookie = getCookie(context, IDENTITY_BIND_COOKIE);
    // One authorization round trip, one cookie. Clearing it before anything
    // else is what makes a duplicate callback -- a refresh, a resent redirect
    // -- land on a spent flow instead of a second exchange.
    deleteCookie(context, IDENTITY_BIND_COOKIE, { path: IDENTITY_BIND_COOKIE_PATH });
    const bind = cookie ? readIdentityBindState(proofSecret, cookie) : null;
    if (!bind || bind.providerId !== providerId) {
      return context.json({ error: "IDENTITY_BIND_STATE_INVALID" }, 403);
    }
    const fail = async (code: string) => {
      await recordIdentityRefusal({
        userId: bind.userId,
        event: "link",
        providerId,
        actionId: bind.actionId,
        reason: code,
      });
      return context.redirect(bindReturn(bind.returnPath, {
        [IDENTITY_BIND_RESULT_PARAM]: "error",
        [IDENTITY_BIND_ERROR_PARAM]: code,
      }), 302);
    };
    const session = await requireSession(context.req.raw);
    if (!session) return await fail("UNAUTHORIZED");
    // The person signed out, or signed in as somebody else, while the provider
    // had the tab. The proof this callback could mint would belong to a
    // session that no longer exists, so stop before the exchange.
    if (session.user.id !== bind.userId || session.session.id !== bind.sessionId) {
      return await fail("IDENTITY_ACTION_SESSION_CHANGED");
    }
    if (context.req.query("state") !== bind.state) {
      return await fail("IDENTITY_BIND_STATE_INVALID");
    }
    // The provider's own error is attacker-influenced text; it selects one of
    // our codes and is never reflected.
    if (context.req.query("error")) return await fail("IDENTITY_PROVIDER_REFUSED");
    const code = context.req.query("code");
    if (!code) return await fail("IDENTITY_PROVIDER_REFUSED");
    const provider = linkableProviderIds.has(providerId) ? createBindProvider(providerId) : null;
    if (!provider) return await fail("IDENTITY_PROVIDER_NOT_CONFIGURED");
    let subject = "";
    let email: string | null = null;
    let emailVerified = false;
    try {
      const tokens = await provider.validateAuthorizationCode({
        code,
        codeVerifier: bind.codeVerifier,
        redirectURI: identityBindRedirectUri(providerId),
      });
      const info = tokens ? await provider.getUserInfo(tokens) : null;
      if (info && info.user.id !== undefined && info.user.id !== null) {
        subject = String(info.user.id);
        email = info.user.email ?? null;
        emailVerified = Boolean(info.user.emailVerified) && email !== null;
      }
    } catch {
      // A connection dropped mid-exchange is indistinguishable from a refused
      // one here, and both leave no identity state behind: the intent is still
      // unconsumed, so the person can simply start the bind again.
      return await fail("IDENTITY_PROVIDER_UNAVAILABLE");
    }
    if (!subject) return await fail("IDENTITY_PROVIDER_UNAVAILABLE");
    const providerProof = issueVerifiedProviderIdentityProof(proofSecret, {
      actionId: bind.actionId,
      userId: bind.userId,
      sessionId: bind.sessionId,
      identity: { providerId, subject, email, emailVerified },
    });
    return context.redirect(bindReturn(bind.returnPath, {
      [IDENTITY_BIND_RESULT_PARAM]: "proof",
      [IDENTITY_BIND_PROOF_PARAM]: providerProof,
    }), 302);
  });

  routes.delete("/:accountRecordId", async (context) => {
    if (!sameOrigin(context.req.raw)) return context.json({ error: "IDENTITY_ORIGIN_REQUIRED" }, 403);
    const session = await requireSession(context.req.raw);
    if (!session) return context.json({ error: "UNAUTHORIZED" }, 401);
    const body = await readJsonObject(() => context.req.json());
    const reverificationToken = body && stringField(body, "reverificationToken");
    if (!reverificationToken) return context.json({ error: "INVALID_IDENTITY_UNLINK" }, 400);
    const accountRecordId = context.req.param("accountRecordId");
    try {
      const result = await unlinkAccountIdentity({
        userId: session.user.id,
        sessionId: session.session.id,
        accountRecordId,
        reverificationToken,
        usableProviderIds,
      });
      return context.json({ status: true, ...result });
    } catch (error) {
      if (!(error instanceof AccountIdentityError)) throw error;
      await recordIdentityRefusal({
        userId: session.user.id,
        event: "unlink",
        accountRecordId,
        reason: error.code,
      });
      return context.json({ error: error.code }, refusalStatus(error));
    }
  });

  return routes;
}

// #349: the explicitly configured provider ids this deployment has, which is
// empty whenever no Google client is configured. Both sets are the same one:
// a provider Startrips accepts as a usable login is exactly a provider it
// lets somebody bind.
const SOCIAL_PROVIDER_IDS = configuredSocialProviderIds();

export const accountIdentityRoutes = createAccountIdentityRoutes({
  usableProviderIds: SOCIAL_PROVIDER_IDS,
  linkableProviderIds: SOCIAL_PROVIDER_IDS,
});
