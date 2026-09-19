import { Hono } from "hono";
import {
  AccountPasswordChangeError,
  changeAccountPassword,
  type AccountPasswordChangeErrorCode,
} from "../account-identities/password-change";
import { auth } from "../auth";
import { serverConfig } from "../config";
import { readJsonObject } from "./json-body";

function sameOrigin(request: Request): boolean {
  return request.headers.get("origin") === serverConfig.appOrigin;
}

function stringField(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function refusalStatus(
  code: AccountPasswordChangeErrorCode,
): 400 | 403 | 404 | 409 {
  switch (code) {
    case "PASSWORD_CHANGE_INVALID":
    case "PASSWORD_CHANGE_PASSWORD_TOO_SHORT":
    case "PASSWORD_CHANGE_PASSWORD_TOO_LONG":
    case "PASSWORD_CHANGE_REVERIFY_INVALID":
      return 400;
    case "PASSWORD_CHANGE_ACCOUNT_NOT_FOUND":
    case "PASSWORD_CHANGE_CREDENTIAL_NOT_FOUND":
      return 404;
    case "PASSWORD_CHANGE_CURRENT_PASSWORD_INVALID":
    case "PASSWORD_CHANGE_REVERIFY_EXPIRED":
    case "PASSWORD_CHANGE_SESSION_CHANGED":
    case "PASSWORD_CHANGE_SESSION_EXPIRED":
      return 403;
    default:
      return 409;
  }
}

export function createAccountPasswordRoutes() {
  const routes = new Hono();

  // #410: the only password-replacement write path. Better Auth's native
  // `/api/auth/change-password` is disabled in `server/auth.ts`, so a direct or
  // native client cannot reach the credential without a fresh ST-067 grant.
  routes.post("/", async (context) => {
    if (!sameOrigin(context.req.raw)) {
      return context.json({ error: "PASSWORD_CHANGE_ORIGIN_REQUIRED" }, 403);
    }
    const session = await auth.api.getSession({
      headers: context.req.raw.headers,
    });
    if (!session) return context.json({ error: "UNAUTHORIZED" }, 401);
    const body = await readJsonObject(() => context.req.json());
    const currentPassword = body && stringField(body, "currentPassword");
    const newPassword = body && stringField(body, "newPassword");
    const reverificationToken = body && stringField(body, "reverificationToken");
    if (!currentPassword || !newPassword || !reverificationToken) {
      return context.json({ error: "PASSWORD_CHANGE_INVALID" }, 400);
    }

    try {
      const result = await changeAccountPassword({
        userId: session.user.id,
        sessionId: session.session.id,
        currentPassword,
        newPassword,
        reverificationToken,
        headers: context.req.raw.headers,
      });
      return context.json({ status: true, ...result });
    } catch (error) {
      if (!(error instanceof AccountPasswordChangeError)) throw error;
      return context.json({ error: error.code }, refusalStatus(error.code));
    }
  });

  return routes;
}

export const accountPasswordRoutes = createAccountPasswordRoutes();
