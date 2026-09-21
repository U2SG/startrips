import { Hono } from "hono";
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
import { validProviderId } from "../account-identities/identity-policy";
import { verifyProviderIdentityProof } from "../account-identities/provider-proof";
import { consumePasswordReverificationBudget } from "../account-identities/reverification-rate-limit";
import { clientAddress } from "../share-rate-limit";
import { readJsonObject } from "./json-body";

export type AccountIdentityRouteOptions = {
  usableProviderIds?: ReadonlySet<string>;
  linkableProviderIds?: ReadonlySet<string>;
  proofSecret?: string;
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

  routes.get("/", async (context) => {
    const session = await requireSession(context.req.raw);
    if (!session) return context.json({ error: "UNAUTHORIZED" }, 401);
    const methods = await listAccountIdentityMethods(session.user.id, usableProviderIds);
    // Read live rather than snapshotting at construction: `link-intents` and
    // `link/complete` gate on `linkableProviderIds.has(...)` at request time, so
    // an advertised provider is exactly a provider those writes accept.
    const availableLinkProviders = [...linkableProviderIds].sort();
    return context.json({ methods, availableLinkProviders });
  });

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

// No social provider is configured on current main. #349/#350 can construct
// the same router with their explicitly configured provider ids; until then the
// production surface fails closed on link attempts while list/reverify/unlink
// remain usable for the credential account and future verified identities.
export const accountIdentityRoutes = createAccountIdentityRoutes();
