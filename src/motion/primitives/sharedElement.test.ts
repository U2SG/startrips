import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  runSharedElementMorph,
  runSharedElementTransition,
  scrollInvalidatesSharedElementMorph,
} from "./sharedElement";

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

  // #489 C/V6: the recorded reveal-then-hide-then-smaller-reopen is the window
  // between the commit that reveals the destination and the readiness that
  // lets `resolveTarget` claim it. The claim has to happen in the same
  // synchronous block as the update, before the browser can paint it, and it
  // must suppress painting without making the destination unresolvable.
  it("owns a not-yet-presentable destination from the update itself (#489)", () => {
    const primitive = readFileSync(new URL("./sharedElement.ts", import.meta.url), "utf8");
    const update = primitive.indexOf("flushSync(update);");
    const claim = primitive.indexOf("claimPendingDestination();", update);
    const observer = primitive.indexOf("new MutationObserver(advance)", update);
    expect(update).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(update);
    expect(claim).toBeLessThan(observer);
    // Opacity, not visibility: `canPresent` rejects a hidden destination, so
    // hiding it here would keep the morph from ever landing on it.
    expect(primitive).toContain('element.style.opacity = "0";');
    expect(primitive).not.toContain('element.style.visibility = "hidden";');
  });

  it("keeps the destination video hidden until the clone releases it (#489)", () => {
    const primitive = readFileSync(new URL("./sharedElement.ts", import.meta.url), "utf8");
    expect(primitive).toContain('target.style.visibility = "hidden";');
    expect(primitive).not.toContain("keepTargetInteractive");
  });

});

// #429: the compact Route Point context panel owns its own overflow, so a
// scroll inside it is routinely still queued when its entry is clicked. That
// scroll reaches the morph's capture-phase listener but cannot move either end
// of the handoff, so it must not cancel the morph and remove the published
// observation aperture.
describe("scrollInvalidatesSharedElementMorph (#429)", () => {
  const source = { id: "source" } as unknown as Node;
  const target = { id: "target" } as unknown as Node;
  const containerOf = (...held: Node[]) => ({ contains: (node: Node | null) => held.includes(node as Node) });

  it("invalidates on a document scroll", () => {
    expect(scrollInvalidatesSharedElementMorph(null, true, source, target)).toBe(true);
  });

  it("invalidates when the scrolled container holds the source", () => {
    expect(scrollInvalidatesSharedElementMorph(containerOf(source), false, source, null)).toBe(true);
  });

  it("invalidates when the scrolled container holds the resolved target", () => {
    expect(scrollInvalidatesSharedElementMorph(containerOf(target), false, source, target)).toBe(true);
  });

  it("ignores an unrelated subtree scroll", () => {
    expect(scrollInvalidatesSharedElementMorph(containerOf(), false, source, target)).toBe(false);
  });

  it("ignores a subtree that only holds a target the morph has not resolved yet", () => {
    expect(scrollInvalidatesSharedElementMorph(containerOf(target), false, source, null)).toBe(false);
  });

  it("ignores a scroll whose target is not an element", () => {
    expect(scrollInvalidatesSharedElementMorph(null, false, source, target)).toBe(false);
  });
});
