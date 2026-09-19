import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { serverConfig } from "./config";
import { db } from "./db/client";
import * as authSchema from "./db/auth-schema";
import {
  createEmailSender,
  sendInBackground,
} from "./email/email-sender";

const emailSender = createEmailSender(serverConfig);

export const STARTRIPS_ACCOUNT_LINKING_POLICY = {
  enabled: false,
  disableImplicitLinking: true,
  allowDifferentEmails: false,
  allowUnlinkingAll: false,
  updateUserInfoOnLink: false,
} as const;

export const STARTRIPS_DISABLED_IDENTITY_PATHS = [
  "/link-social",
  "/unlink-account",
  "/list-accounts",
  // #389 owns primary-email replacement. Better Auth's native endpoint does
  // not consume the ST-067 dedicated recent-proof grant or our two-stage
  // old/new address transaction, so it must not be an alternate write path.
  "/change-email",
  // #410 owns password replacement for the same reason: the native endpoint
  // accepts any authoritative session and therefore bypasses the ST-067
  // recent-proof grant, its single-use replay receipt and the deterministic
  // session rule. `disabledPaths` filters the HTTP router only, so
  // `/api/account-identities/password` still drives the pinned Better Auth
  // 1.6.23 change-password path through `auth.api.changePassword()`.
  "/change-password",
] as const;

export const auth = betterAuth({
  appName: "Startrips",
  baseURL: serverConfig.appOrigin,
  secret: serverConfig.authSecret,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: authSchema,
  }),
  trustedOrigins: [serverConfig.appOrigin],
  advanced: {
    cookiePrefix: "startrips",
    useSecureCookies: serverConfig.production,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },
  // #345: account rows are login identities of one stable Startrips user.
  // Better Auth 1.6.23 can otherwise expose implicit email-based linking and
  // native unlink/list endpoints that know nothing about Startrips' stronger
  // re-verification and last-actually-usable-method contract. Keep those native
  // management paths fail-closed; provider integrations use the bounded
  // `/api/account-identities` service instead. Existing linked-provider sign-in
  // remains a normal sign-in path because it does not create a new link.
  account: {
    accountLinking: STARTRIPS_ACCOUNT_LINKING_POLICY,
  },
  disabledPaths: [...STARTRIPS_DISABLED_IDENTITY_PATHS],
  rateLimit: {
    enabled: true,
    storage: "database",
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 60, max: 10 },
      "/sign-up/email": { window: 60 * 10, max: 5 },
      "/request-password-reset": { window: 60 * 10, max: 3 },
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: true,
    expiresIn: 60 * 60,
    async sendVerificationEmail({ user, url }) {
      sendInBackground(emailSender, {
        to: user.email,
        subject: "验证你的 Startrips 邮箱",
        text: `请打开以下链接完成邮箱验证：${url}`,
      });
    },
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    minPasswordLength: 10,
    maxPasswordLength: 128,
    revokeSessionsOnPasswordReset: true,
    // #425: the reset URL carries the live single-use reset token, so the body
    // is a bearer capability exactly like the email-change links in
    // `routes/account-email-change.ts`. Without this flag the development mail
    // sink prints `text` to the application log, which writes a usable token to
    // disk — the same class `request-log.ts` removes from request paths.
    async sendResetPassword({ user, url }) {
      sendInBackground(emailSender, {
        to: user.email,
        subject: "重置你的 Startrips 密码",
        text: `请打开以下链接重置密码：${url}`,
        sensitive: true,
      });
    },
  },
  plugins: [
    organization({
      organizationLimit: 1,
      membershipLimit: 2,
      invitationLimit: 1,
      requireEmailVerificationOnInvitation: true,
      async sendInvitationEmail(data) {
        const inviteUrl = new URL("/accept-invitation", serverConfig.appOrigin);
        inviteUrl.searchParams.set("id", data.id);
        sendInBackground(emailSender, {
          to: data.email,
          subject: `${data.inviter.user.name} 邀请你加入 Startrips`,
          text: `请打开以下链接加入「${data.organization.name}」：${inviteUrl}`,
        });
      },
    }),
  ],
});
