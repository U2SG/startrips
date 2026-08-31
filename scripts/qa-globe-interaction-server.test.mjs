import { describe, expect, it } from "vitest";
import { allocateLoopbackPort, normalizeQaBaseUrl } from "./qa-globe-interaction-server.mjs";

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
});
