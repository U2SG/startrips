import { Hono } from "hono";
import {
  AccountEmailChangeError,
  cancelAccountEmailChange,
  confirmAccountEmailChangeOldAddress,
  getAccountEmailChangeStatus,
  startAccountEmailChange,
  verifyAccountEmailChangeNewAddress,
} from "../account-identities/email-change-repository";
import { auth } from "../auth";
import { serverConfig } from "../config";
import {
  createEmailSender,
  deliverEmailWithRetry,
  sendInBackground,
  type EmailSender,
} from "../email/email-sender";
import { readJsonObject } from "./json-body";

export type AccountEmailChangeRouteOptions = {
  emailSender?: EmailSender;
};

function sameOrigin(request: Request): boolean {
  return request.headers.get("origin") === serverConfig.appOrigin;
}

async function requireSession(request: Request) {
  return await auth.api.getSession({ headers: request.headers });
}

function stringField(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function refusalStatus(error: AccountEmailChangeError): 400 | 403 | 404 | 409 {
  switch (error.code) {
    case "EMAIL_CHANGE_INVALID":
    case "EMAIL_CHANGE_PROOF_INVALID":
      return 400;
    case "EMAIL_CHANGE_ACCOUNT_NOT_FOUND":
      return 404;
    case "EMAIL_CHANGE_SESSION_CHANGED":
    case "EMAIL_CHANGE_REVERIFY_INVALID":
    case "EMAIL_CHANGE_CURRENT_EMAIL_UNVERIFIED":
      return 403;
    default:
      return 409;
  }
}

function proofLink(stage: "old" | "new", token: string): string {
  const url = new URL("/account/email-change", serverConfig.appOrigin);
  // Keep the bearer capability out of HTTP request targets/access logs. #347
  // reads the fragment client-side and submits the token in a POST body.
  url.hash = new URLSearchParams({ stage, token }).toString();
  return url.toString();
}

async function sendProofMessages(
  sender: EmailSender,
  values: {
    currentEmail: string;
    proposedEmail: string;
    oldProofToken: string;
    newProofToken: string;
  },
) {
  await Promise.all([
    deliverEmailWithRetry(sender, {
      to: values.currentEmail,
      subject: "确认 Startrips 邮箱换绑",
      text: `请打开以下链接确认你仍控制当前邮箱：${proofLink("old", values.oldProofToken)}`,
      sensitive: true,
    }),
    deliverEmailWithRetry(sender, {
      to: values.proposedEmail,
      subject: "验证新的 Startrips 邮箱",
      text: `请打开以下链接验证新的邮箱地址：${proofLink("new", values.newProofToken)}`,
      sensitive: true,
    }),
  ]);
}

function notifyCompletion(
  sender: EmailSender,
  oldEmail: string,
  newEmail: string,
) {
  const message = {
    subject: "Startrips 邮箱已完成换绑",
    text: "你的 Startrips Account 主邮箱已经完成换绑。若这不是你的操作，请立即通过既有账户恢复流程处理。",
  };
  sendInBackground(sender, { to: oldEmail, ...message });
  if (newEmail !== oldEmail) {
    sendInBackground(sender, { to: newEmail, ...message });
  }
}

export function createAccountEmailChangeRoutes(
  options: AccountEmailChangeRouteOptions = {},
) {
  const routes = new Hono();
  const emailSender = options.emailSender ?? createEmailSender(serverConfig);

  routes.get("/", async (context) => {
    const session = await requireSession(context.req.raw);
    if (!session) return context.json({ error: "UNAUTHORIZED" }, 401);
    const change = await getAccountEmailChangeStatus(session.user.id);
    return context.json({ change });
  });

  routes.post("/", async (context) => {
    if (!sameOrigin(context.req.raw)) {
      return context.json({ error: "EMAIL_CHANGE_ORIGIN_REQUIRED" }, 403);
    }
    const session = await requireSession(context.req.raw);
    if (!session) return context.json({ error: "UNAUTHORIZED" }, 401);
    const body = await readJsonObject(() => context.req.json());
    const proposedEmail = body && stringField(body, "newEmail");
    const reverificationToken = body && stringField(body, "reverificationToken");
    if (!body || !proposedEmail || !reverificationToken) {
      return context.json({ error: "EMAIL_CHANGE_INVALID" }, 400);
    }
    if (body.oldAddressAvailable === false) {
      return context.json({ error: "EMAIL_CHANGE_RECOVERY_REQUIRED" }, 409);
    }

    try {
      const result = await startAccountEmailChange({
        userId: session.user.id,
        sessionId: session.session.id,
        proposedEmail,
        reverificationToken,
      });
      try {
        await sendProofMessages(emailSender, {
          currentEmail: result.change.currentEmail,
          proposedEmail: result.change.proposedEmail,
          oldProofToken: result.oldProofToken,
          newProofToken: result.newProofToken,
        });
      } catch {
        // If only one delivery made it out before the other exhausted retries,
        // invalidate both capabilities before reporting failure. A retry must
        // obtain a fresh ST-067 grant and creates a fresh transaction.
        await cancelAccountEmailChange({
          userId: session.user.id,
          sessionId: session.session.id,
          changeId: result.change.id,
        });
        return context.json({ error: "EMAIL_CHANGE_DELIVERY_FAILED" }, 503);
      }
      return context.json({ change: result.change }, 201);
    } catch (error) {
      if (!(error instanceof AccountEmailChangeError)) throw error;
      return context.json({ error: error.code }, refusalStatus(error));
    }
  });

  routes.post("/confirm-old", async (context) => {
    if (!sameOrigin(context.req.raw)) {
      return context.json({ error: "EMAIL_CHANGE_ORIGIN_REQUIRED" }, 403);
    }
    const session = await requireSession(context.req.raw);
    if (!session) return context.json({ error: "UNAUTHORIZED" }, 401);
    const body = await readJsonObject(() => context.req.json());
    const token = body && stringField(body, "token");
    if (!token) return context.json({ error: "EMAIL_CHANGE_PROOF_INVALID" }, 400);
    try {
      const result = await confirmAccountEmailChangeOldAddress({
        userId: session.user.id,
        sessionId: session.session.id,
        token,
      });
      if (result.notification) {
        notifyCompletion(
          emailSender,
          result.notification.oldEmail,
          result.notification.newEmail,
        );
      }
      return context.json({ change: result.change, completed: result.completed });
    } catch (error) {
      if (!(error instanceof AccountEmailChangeError)) throw error;
      return context.json({ error: error.code }, refusalStatus(error));
    }
  });

  routes.post("/verify-new", async (context) => {
    if (!sameOrigin(context.req.raw)) {
      return context.json({ error: "EMAIL_CHANGE_ORIGIN_REQUIRED" }, 403);
    }
    const session = await requireSession(context.req.raw);
    if (!session) return context.json({ error: "UNAUTHORIZED" }, 401);
    const body = await readJsonObject(() => context.req.json());
    const token = body && stringField(body, "token");
    if (!token) return context.json({ error: "EMAIL_CHANGE_PROOF_INVALID" }, 400);
    try {
      const result = await verifyAccountEmailChangeNewAddress({
        userId: session.user.id,
        sessionId: session.session.id,
        token,
      });
      if (result.notification) {
        notifyCompletion(
          emailSender,
          result.notification.oldEmail,
          result.notification.newEmail,
        );
      }
      return context.json({ change: result.change, completed: result.completed });
    } catch (error) {
      if (!(error instanceof AccountEmailChangeError)) throw error;
      return context.json({ error: error.code }, refusalStatus(error));
    }
  });

  routes.post("/cancel", async (context) => {
    if (!sameOrigin(context.req.raw)) {
      return context.json({ error: "EMAIL_CHANGE_ORIGIN_REQUIRED" }, 403);
    }
    const session = await requireSession(context.req.raw);
    if (!session) return context.json({ error: "UNAUTHORIZED" }, 401);
    try {
      const change = await cancelAccountEmailChange({
        userId: session.user.id,
        sessionId: session.session.id,
      });
      return context.json({ change });
    } catch (error) {
      if (!(error instanceof AccountEmailChangeError)) throw error;
      return context.json({ error: error.code }, refusalStatus(error));
    }
  });

  return routes;
}

export const accountEmailChangeRoutes = createAccountEmailChangeRoutes();
