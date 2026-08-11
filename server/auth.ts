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
    async sendResetPassword({ user, url }) {
      sendInBackground(emailSender, {
        to: user.email,
        subject: "重置你的 Startrips 密码",
        text: `请打开以下链接重置密码：${url}`,
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
