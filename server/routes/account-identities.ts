import { randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { auth } from "../auth";
import { serverConfig } from "../config";
import {
  AccountIdentityError,
  completeIdentityLink,
  createIdentityLinkIntent,
  createPasswordReverificationGrant,
  identitySessionIsCurrent,
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
  bindableSocialProviderIds,
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

/**
 * #504: the one set of attributes the bind cookie is issued AND cleared with.
 *
 * `SameSite=None` because Apple returns with `response_mode=form_post`, a
 * cross-site POST on which a browser sends no `Lax` cookie; the owner took
 * this on #504 for Google's GET return as well rather than splitting the
 * cookie per provider. `None` is only honoured with `Secure`, so `secure` is
 * unconditional: browsers treat `http://127.0.0.1` as a secure context for
 * this, and every other `APP_ORIGIN` is HTTPS. The deletion carries the same
 * attributes so a browser accepts it on that cross-site response too.
 */
const IDENTITY_BIND_COOKIE_ATTRIBUTES = {
  path: IDENTITY_BIND_COOKIE_PATH,
  httpOnly: true,
  sameSite: "None",
  secure: true,
} as const;

/** What a provider hands back, from the query of a GET or the body of a form_post. */
type BindCallbackParams = {
  state: string | null;
  code: string | null;
  error: string | null;
};

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
  //
  // #350: this is the SIGN-IN set, so it reads `usableProviderIds`. It read
  // `linkableProviderIds` while Google made the two identical; the two are
  // separate questions even when #504 makes them agree again.
  routes.get("/providers", (context) => context.json({
    signInProviders: [...usableProviderIds].filter(validProviderId).sort(),
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
    // 86 characters, inside RFC 7636's 43..128 range. #504: only for a
    // provider that takes PKCE -- see `IdentityBindProvider.pkce`.
    const codeVerifier = provider.pkce ? randomBytes(64).toString("base64url") : null;
    const authorizationUrl = await provider.createAuthorizationURL({
      state,
      codeVerifier: codeVerifier ?? undefined,
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
      ...IDENTITY_BIND_COOKIE_ATTRIBUTES,
      maxAge: IDENTITY_BIND_STATE_MAX_AGE_MS / 1000,
    });
    return context.json({ authorizationUrl: authorizationUrl.toString() });
  });

  // Step two: the provider hands the browser back here. Every exit is a
  // redirect to the app path the cookie recorded, so a person who cancelled,
  // was refused, or came back to a different account lands somewhere that can
  // explain it rather than on a raw JSON error.
  //
  // #504: one core behind two methods. Google returns with a GET carrying the
  // parameters in the query; Apple returns with `response_mode=form_post`, a
  // cross-site POST carrying them in the body. There is no `sameOrigin` gate
  // on either: the Origin of that POST is Apple's. What authenticates the
  // return is the signed, single-use bind cookie plus a `state` only that
  // cookie and the provider's authorization URL ever held.
  async function finishBindCallback(
    context: Context,
    providerId: string,
    params: BindCallbackParams,
    formPost: boolean,
  ) {
    const cookie = getCookie(context, IDENTITY_BIND_COOKIE);
    // One authorization round trip, one cookie. Clearing it before anything
    // else is what makes a duplicate callback -- a refresh, a resent redirect
    // -- land on a spent flow instead of a second exchange.
    deleteCookie(context, IDENTITY_BIND_COOKIE, IDENTITY_BIND_COOKIE_ATTRIBUTES);
    const bind = cookie ? readIdentityBindState(proofSecret, cookie) : null;
    if (!bind || bind.providerId !== providerId) {
      return context.json({ error: "IDENTITY_BIND_STATE_INVALID" }, 403);
    }
    // 303 turns the browser's follow-up to a form_post into a GET of the app.
    const redirectStatus = formPost ? 303 : 302;
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
      }), redirectStatus);
    };
    // The person signed out, or signed in as somebody else, while the provider
    // had the tab. The proof this callback could mint would belong to a
    // session that no longer exists, so stop before the exchange.
    //
    // #504: a cross-site form_post carries no Better Auth session cookie --
    // that cookie is `SameSite=Lax` -- so there the signed cookie's session is
    // checked against the session table instead. A session cookie that IS
    // present is still compared, on either method.
    const session = await requireSession(context.req.raw);
    if (session) {
      if (session.user.id !== bind.userId || session.session.id !== bind.sessionId) {
        return await fail("IDENTITY_ACTION_SESSION_CHANGED");
      }
    } else if (!formPost) {
      return await fail("UNAUTHORIZED");
    } else if (!(await identitySessionIsCurrent(bind.userId, bind.sessionId))) {
      return await fail("IDENTITY_ACTION_SESSION_CHANGED");
    }
    if (params.state !== bind.state) {
      return await fail("IDENTITY_BIND_STATE_INVALID");
    }
    // The provider's own error is attacker-influenced text; it selects one of
    // our codes and is never reflected. Apple's cancel is
    // `user_cancelled_authorize`; it lands here like Google's `access_denied`.
    if (params.error) return await fail("IDENTITY_PROVIDER_REFUSED");
    const code = params.code;
    if (!code) return await fail("IDENTITY_PROVIDER_REFUSED");
    const provider = linkableProviderIds.has(providerId) ? createBindProvider(providerId) : null;
    if (!provider) return await fail("IDENTITY_PROVIDER_NOT_CONFIGURED");
    // The signed cookie records whether a verifier was minted; it has to agree
    // with the provider's PKCE policy, so a flow started under one policy can
    // never be exchanged under the other.
    if (provider.pkce !== (bind.codeVerifier !== null)) {
      return await fail("IDENTITY_BIND_STATE_INVALID");
    }
    let subject = "";
    let email: string | null = null;
    let emailVerified = false;
    try {
      const tokens = await provider.validateAuthorizationCode({
        code,
        codeVerifier: bind.codeVerifier ?? undefined,
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
    }), redirectStatus);
  }

  routes.get("/providers/:providerId/callback", (context) =>
    finishBindCallback(context, context.req.param("providerId"), {
      state: context.req.query("state") || null,
      code: context.req.query("code") || null,
      error: context.req.query("error") || null,
    }, false));

  // #504: Apple's `form_post` return. Only `state`, `code` and `error` are
  // read. The body's `id_token` is never believed -- the identity comes from
  // the token this server exchanges the code for and then verifies -- and its
  // first-authorization `user` JSON is not identity material.
  routes.post("/providers/:providerId/callback", async (context) => {
    let body: Record<string, unknown> = {};
    try {
      body = await context.req.parseBody();
    } catch {
      body = {};
    }
    return await finishBindCallback(context, context.req.param("providerId"), {
      state: stringField(body, "state"),
      code: stringField(body, "code"),
      error: stringField(body, "error"),
    }, true);
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

// #349/#350/#504: the explicitly configured provider ids this deployment has,
// empty whenever it names no social credential at all.
//
// A provider Startrips accepts as a usable login is one it can complete a
// sign-in with; a provider somebody can BIND additionally needs the
// authorize/callback round trip above. #504 taught that round trip Apple's
// `form_post` return, so today the two sets agree -- but they stay two sets,
// because `availableLinkProviders` drives a generic bind button in
// `src/auth/AuthGateway.tsx`, and a provider added to sign-in before its bind
// path exists must not render a control that can only fail.
export const accountIdentityRoutes = createAccountIdentityRoutes({
  usableProviderIds: configuredSocialProviderIds(),
  linkableProviderIds: bindableSocialProviderIds(),
});
