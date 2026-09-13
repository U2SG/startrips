import { describe, expect, it, vi } from "vitest";
import { cancelJourneyCardTransition, morphJourneyCard, runSharedElementMorph, runSharedElementTransition } from "./sharedElement";

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

describe("runSharedElementMorph (#18)", () => {
  it("falls back to the state update when no visible source is available", () => {
    const update = vi.fn();
    runSharedElementMorph({
      source: null,
      name: "story-media-test",
      update,
      resolveTarget: () => null,
    });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("cleans presentation-only geometry on the non-animated fallback path", () => {
    const update = vi.fn();
    const onCleanup = vi.fn();
    runSharedElementMorph({
      source: null,
      name: "place-media-test",
      update,
      resolveTarget: () => null,
      onCleanup,
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(onCleanup).toHaveBeenCalledTimes(1);
  });
});


describe("cancelJourneyCardTransition", () => {
  it("interrupts the active document-scoped Journey card transition", () => {
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    const skipTransition = vi.fn();
    const update = vi.fn();
    const finished = new Promise<void>(() => undefined);
    const ready = Promise.resolve();
    const documentStub = {
      startViewTransition: (callback: () => void) => {
        callback();
        return { ready, finished, skipTransition };
      },
    };
    const windowStub = {
      matchMedia: () => ({ matches: false }),
    };
    Object.defineProperty(globalThis, "document", { configurable: true, value: documentStub });
    Object.defineProperty(globalThis, "window", { configurable: true, value: windowStub });
    try {
      morphJourneyCard(null, true, update);
      expect(update).toHaveBeenCalledTimes(1);
      cancelJourneyCardTransition();
      expect(skipTransition).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
      Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    }
  });
});
