import { describe, expect, it, vi } from "vitest";
import {
  deliverEmailWithRetry,
  sendInBackground,
  type EmailSender,
} from "./email-sender";

const message = {
  to: "member@example.test",
  subject: "Verify",
  text: "token",
};

function failingSender(attempts: number, failWith = "smtp down") {
  const send = vi.fn(async () => {
    if (send.mock.calls.length <= attempts) throw new Error(failWith);
  });
  return { send, sender: { send } as EmailSender };
}

describe("deliverEmailWithRetry", () => {
  it("delivers on the first attempt without retrying", async () => {
    const { send, sender } = failingSender(0);
    await deliverEmailWithRetry(sender, message, { retries: 2, delayMs: () => 0 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure and then succeeds", async () => {
    const { send, sender } = failingSender(2);
    await deliverEmailWithRetry(sender, message, { retries: 3, delayMs: () => 0 });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("gives up after exhausting the retry budget", async () => {
    const { send, sender } = failingSender(99);
    await expect(deliverEmailWithRetry(sender, message, {
      retries: 2,
      delayMs: () => 0,
    })).rejects.toThrow("smtp down");
    expect(send).toHaveBeenCalledTimes(3);
  });
});

describe("sendInBackground", () => {
  it("logs a delivery failure without throwing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { sender } = failingSender(99);
    sendInBackground(sender, message, { retries: 1, delayMs: () => 0 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(errorSpy).toHaveBeenCalledWith(
      "Email delivery failed after retries",
      "smtp down",
    );
    errorSpy.mockRestore();
  });
});
