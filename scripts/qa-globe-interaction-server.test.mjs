import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  allocateLoopbackPort,
  hasChildExited,
  normalizeQaBaseUrl,
  waitForChildExitOrTimeout,
} from "./qa-globe-interaction-server.mjs";

describe("qa globe interaction server ownership (#109)", () => {
  it("normalizes an explicit external QA URL without changing its host or port", () => {
    expect(normalizeQaBaseUrl("http://127.0.0.1:43123/")).toBe("http://127.0.0.1:43123");
    expect(normalizeQaBaseUrl("https://example.test/qa/")).toBe("https://example.test/qa");
    expect(normalizeQaBaseUrl(undefined)).toBeNull();
  });

  it("rejects non-HTTP QA URLs", () => {
    expect(() => normalizeQaBaseUrl("file:///tmp/startrips")).toThrow(/http or https/);
  });

  it("allocates a valid ephemeral loopback port instead of assuming 4173", async () => {
    const port = await allocateLoopbackPort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65_535);
  });

  it("clears the fallback timer when the child exits promptly", async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter();
      child.exitCode = null;
      const waiting = waitForChildExitOrTimeout(child, 5_000);
      expect(vi.getTimerCount()).toBe(1);
      child.exitCode = 0;
      child.emit("exit", 0, null);
      await expect(waiting).resolves.toBe("exit");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes the exit listener when the shutdown timeout wins", async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter();
      child.exitCode = null;
      const waiting = waitForChildExitOrTimeout(child, 5_000);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(waiting).resolves.toBe("timeout");
      expect(child.listenerCount("exit")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("treats signal-terminated children as exited", async () => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = "SIGKILL";
    expect(hasChildExited(child)).toBe(true);
    await expect(waitForChildExitOrTimeout(child, 5_000)).resolves.toBe("exit");
  });

});
