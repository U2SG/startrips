import { describe, expect, it } from "vitest";
import {
  canUseStartripsRecoveryBack,
  getStartripsRecoveryDescriptor,
  getStartripsRecoveryCopy,
} from "./recoverySurfaces";

describe("Startrips recovery surface descriptors", () => {
  it("keeps empty truthful by omitting retry action and retry copy", () => {
    const empty = getStartripsRecoveryDescriptor("empty");
    expect(empty.primaryActionKind).toBe("create");
    expect(empty.secondaryActionKind).toBeUndefined();
    expect(empty.copyKeys.primaryAction).toBe("recovery.empty.primary");
    expect(Object.values(empty.copyKeys).some((key) => String(key).includes("retry"))).toBe(false);
  });

  it("keeps generic recoverable errors explicitly retryable", () => {
    const error = getStartripsRecoveryDescriptor("error");
    expect(error.primaryActionKind).toBe("retry");
    expect(getStartripsRecoveryCopy(error.copyKeys.primaryAction)).toBe("重试");
  });

  it("offers 404 back only when history is plausibly in-app", () => {
    expect(canUseStartripsRecoveryBack({
      historyLength: 2,
      referrer: "https://startrips.test/journeys/1",
      origin: "https://startrips.test",
    })).toBe(true);
    expect(canUseStartripsRecoveryBack({
      historyLength: 1,
      referrer: "https://startrips.test/journeys/1",
      origin: "https://startrips.test",
    })).toBe(false);
    expect(canUseStartripsRecoveryBack({
      historyLength: 3,
      referrer: "https://example.com/elsewhere",
      origin: "https://startrips.test",
    })).toBe(false);
    expect(canUseStartripsRecoveryBack({ historyLength: 3, referrer: "not a url", origin: "https://startrips.test" })).toBe(false);
  });
});
