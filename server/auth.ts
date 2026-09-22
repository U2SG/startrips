import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { eq } from "drizzle-orm";
import { organization } from "better-auth/plugins";
import { recordProviderSignInOwnership } from "./account-identities/account-identity-repository";
import {
  configuredSocialProviderIds,
  googleSignInOptions,
  takeVerifiedProviderIdentity,
} from "./account-identities/social-providers";
import { serverConfig } from "./config";
import { db } from "./db/client";
import * as authSchema from "./db/auth-schema";
import {
  createEmailSender,
  sendInBackground,
} from "./email/email-sender";

const emailSender = createEmailSender(serverConfig);

// #349: present only when this deployment names both halves of a Google OAuth
// client. An incomplete configuration never reaches here -- `config.ts`
// refuses it at startup -- and an absent one omits the provider entirely
// rather than mounting a mock, so the sign-in entry simply does not exist.
const googleOptions = googleSignInOptions(serverConfig);
const SOCIAL_PROVIDER_IDS = configuredSocialProviderIds(serverConfig);

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

/**
 * Carry the identity this callback verified into Startrips' own ownership row.
 *
 * The account row is re-read by id rather than taken from the hook argument:
 * `create.after` and `update.after` are handed whatever the adapter returned
 * for that write, and this path must not depend on which columns that happens
 * to include. A failure here must not fail the sign-in -- a missing or stale
 * ownership row makes the method read as unusable, which is the fail-closed
 * direction.
 */
async function syncProviderSignInOwnership(accountRecordId: string) {
  try {
    const [record] = await db
      .select({
        id: authSchema.account.id,
        userId: authSchema.account.userId,
        providerId: authSchema.account.providerId,
        accountId: authSchema.account.accountId,
      })
      .from(authSchema.account)
      .where(eq(authSchema.account.id, accountRecordId))
      .limit(1);
    if (!record || !SOCIAL_PROVIDER_IDS.has(record.providerId)) return;
    const identity = takeVerifiedProviderIdentity(record.providerId, record.accountId);
    if (!identity) return;
    await recordProviderSignInOwnership({
      userId: record.userId,
      accountRecordId: record.id,
      identity,
    });
  } catch (error) {
    console.error("account_identity_ownership_record_failed", {
      accountRecordId,
      message: error instanceof Error ? error.message : "unknown",
    });
  }
}

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
  socialProviders: googleOptions ? { google: googleOptions } : {},
  databaseHooks: {
    account: {
      // #349: a native provider sign-up creates the Better Auth account row
      // without Startrips' ownership row, which every ST-067 usability and
      // last-usable-login decision reads. `create` covers the first callback;
      // `update` covers every later one, because Better Auth refreshes the
      // stored tokens of an existing linked account on each social sign-in and
      // never creates that account again. Without the second entry a first
      // callback that carried an unverified email would pin the method as
      // permanently unusable.
      create: { after: (account) => syncProviderSignInOwnership(account.id) },
      update: { after: (account) => syncProviderSignInOwnership(account.id) },
    },
  },
  disabledPaths: [...STARTRIPS_DISABLED_IDENTITY_PATHS],
  rateLimit: {
    enabled: true,
    storage: "database",
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 60, max: 10 },
      // #349: one authorization redirect per person per few seconds is
      // already generous; the callback itself is bounded by the single-use
      // state Better Auth issues here.
      "/sign-in/social": { window: 60, max: 10 },
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
