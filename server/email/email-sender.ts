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

export type EmailDeliveryOptions = {
  retries?: number;
  delayMs?: (attempt: number) => number;
};

const DEFAULT_RETRIES = 2;
const DEFAULT_DELAY_MS = (attempt: number) => 1_000 * 3 ** attempt;

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

export async function deliverEmailWithRetry(
  sender: EmailSender,
  message: EmailMessage,
  options: EmailDeliveryOptions = {},
): Promise<void> {
  const retries = options.retries ?? DEFAULT_RETRIES;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await sender.send(message);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await new Promise((resolve) => {
          globalThis.setTimeout(resolve, delayMs(attempt));
        });
      }
    }
  }
  throw lastError;
}

export function sendInBackground(
  sender: EmailSender,
  message: EmailMessage,
  options: EmailDeliveryOptions = {},
): void {
  void deliverEmailWithRetry(sender, message, options).catch((error: unknown) => {
    console.error(
      "Email delivery failed after retries",
      error instanceof Error ? error.message : "unknown error",
    );
  });
}
