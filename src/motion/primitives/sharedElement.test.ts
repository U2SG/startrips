import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { storyFullscreenTargetIsCurrent } from "../../journey/JourneyStory";
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

  it("keeps Story mobile/video fullscreen on the guarded shared-element path (#459)", () => {
    const source = readFileSync(new URL("../../journey/JourneyStory.tsx", import.meta.url), "utf8");
    const start = source.indexOf("function presentFullscreen(nextFullscreen: boolean)");
    const end = source.indexOf("\n  function ", start + 1);
    const presentFullscreen = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(presentFullscreen).toContain("runSharedElementMorph({");
    expect(presentFullscreen).toContain("isTargetCurrent: () =>");
    expect(presentFullscreen).toContain("storyFullscreenTargetIsCurrent({");
    expect(presentFullscreen).toContain('keepTargetInteractive: source?.tagName === "VIDEO"');
    expect(presentFullscreen).not.toMatch(/if \(mobileLayout\)[\s\S]{0,160}setFullscreen/);
    expect(presentFullscreen).not.toContain("source instanceof HTMLVideoElement");
  });

  it("keeps an opted-in live destination interactive under the visual clone (#459)", () => {
    const primitive = readFileSync(new URL("./sharedElement.ts", import.meta.url), "utf8");
    expect(primitive).toContain("keepTargetInteractive = false");
    expect(primitive).toContain('if (!keepTargetInteractive) target.style.visibility = "hidden";');
  });

  it("cancels the Story fullscreen morph when newer media or overlay intent wins (#459)", () => {
    const current = {
      mediaId: "asset-a",
      nextFullscreen: true,
      overlayHidden: false,
      stagePresent: true,
      currentPageId: "asset-a",
      stageInterrupted: false,
    };
    expect(storyFullscreenTargetIsCurrent(current)).toBe(true);
    expect(storyFullscreenTargetIsCurrent({ ...current, currentPageId: "asset-b" })).toBe(false);
    expect(storyFullscreenTargetIsCurrent({ ...current, overlayHidden: true })).toBe(false);
    expect(storyFullscreenTargetIsCurrent({ ...current, stageInterrupted: true })).toBe(false);
    expect(storyFullscreenTargetIsCurrent({ ...current, stagePresent: false })).toBe(false);
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
