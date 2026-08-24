import { describe, expect, it, vi } from "vitest";
import { runSharedElementTransition } from "./sharedElement";

// `runSharedElementTransition` falls back to a plain update when the View
// Transitions API is unavailable (or reduced motion is on). These tests pin
// that fallback contract (#18). The reduced-motion path is covered by the
// browser QA script; in the node test environment there is no `document`.
describe("runSharedElementTransition (#18)", () => {
  it("runs the update directly when the View Transitions API is unavailable", () => {
    const update = vi.fn();
    runSharedElementTransition(update);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("is safe when document does not exist (SSR/node)", () => {
    const update = vi.fn();
    expect(() => runSharedElementTransition(update)).not.toThrow();
    expect(update).toHaveBeenCalledTimes(1);
  });
});
