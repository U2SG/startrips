import { describe, expect, it } from "vitest";
import { revealDelayMs } from "./RevealedNote";

describe("revealDelayMs", () => {
  it("staggers a short note evenly", () => {
    expect(revealDelayMs(0, 5)).toBe(0);
    expect(revealDelayMs(1, 5)).toBe(34);
    expect(revealDelayMs(4, 5)).toBe(136);
  });

  it("caps a long note so the last character arrives within the reveal span", () => {
    expect(revealDelayMs(199, 200)).toBe(1600);
    expect(revealDelayMs(100, 200)).toBeLessThanOrEqual(1600);
  });

  it("does not delay a single character", () => {
    expect(revealDelayMs(0, 1)).toBe(0);
  });
});
