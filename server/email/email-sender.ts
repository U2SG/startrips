import nodemailer from "nodemailer";
import type { ServerConfig } from "../config";

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
};

export type EmailSender = {
  send(message: EmailMessage): Promise<void>;
};

export function createEmailSender(config: ServerConfig): EmailSender {
  if (!config.smtpUrl || !config.mailFrom) {
    return {
      async send(message) {
        if (config.production) {
          throw new Error("SMTP is unavailable");
        }
        console.info(`[development email] ${message.to}: ${message.subject}`);
        console.info(message.text);
      },
    };
  }

  const transport = nodemailer.createTransport(config.smtpUrl);
  return {
    async send(message) {
      await transport.sendMail({
        from: config.mailFrom ?? undefined,
        ...message,
      });
    },
  };
}

export function sendInBackground(
  sender: EmailSender,
  message: EmailMessage,
): void {
  void sender.send(message).catch((error: unknown) => {
    console.error(
      "Email delivery failed",
      error instanceof Error ? error.message : "unknown error",
    );
  });
}
