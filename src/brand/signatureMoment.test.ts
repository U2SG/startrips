import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { motionTokens } from "../motion/tokens";
import { loadStartripsGoatShow, StartripsSignatureMoment, StartripsWordmarkSignatureButton } from "./StartripsSignatureMoment";
import { SIGNATURE_MOMENT_FADE_MS, signatureMomentReducer, type SignatureMomentEvent, type SignatureMomentPhase } from "./signatureMoment";

const run = (events: SignatureMomentEvent[], from: SignatureMomentPhase = "idle") =>
  events.reduce(signatureMomentReducer, from);

describe("Startrips signature moment", () => {
  it("plays once, then fades back to rest when the clip ends or is skipped", () => {
    expect(run([{ type: "play", reducedMotion: false }])).toBe("playing");
    expect(run([{ type: "play", reducedMotion: false }, { type: "end" }])).toBe("leaving");
    expect(run([{ type: "play", reducedMotion: false }, { type: "end" }, { type: "faded" }])).toBe("idle");
  });

  it("does not play under reduced motion", () => {
    expect(run([{ type: "play", reducedMotion: true }])).toBe("idle");
  });

  it("ignores a replay while playing or fading, so the skipping click does not restart it", () => {
    expect(run([{ type: "play", reducedMotion: false }, { type: "play", reducedMotion: false }])).toBe("playing");
    expect(run([{ type: "play", reducedMotion: false }, { type: "end" }, { type: "play", reducedMotion: false }])).toBe("leaving");
  });

  it("releases gracefully when the product it accompanies is ready, tolerating repeats", () => {
    expect(run([{ type: "play", reducedMotion: false }, { type: "release" }, { type: "release" }, { type: "end" }])).toBe("leaving");
    expect(run([{ type: "release" }])).toBe("idle");
    expect(run([{ type: "faded" }])).toBe("idle");
  });

  it("fades for one Tier 1 beat", () => {
    expect(SIGNATURE_MOMENT_FADE_MS).toBe(motionTokens.tiers.ui);
  });

  it("renders the wordmark as a labelled button with no clip mounted at rest", () => {
    const markup = renderToStaticMarkup(createElement(StartripsWordmarkSignatureButton, { size: 34, state: "travel" }));
    // React 19 server rendering may hoist an image preload <link> ahead of the
    // tree, so assert on the button element itself rather than the first tag.
    const button = markup.match(/<button[^>]*>/)?.[0] ?? "";
    expect(button).toContain('type="button"');
    expect(button).toContain('class="startrips-signature-trigger"');
    expect(button).toContain('aria-label="播放 Startrips 动画"');
    expect(markup).toContain('data-brand-state="travel"');
    expect(markup).toContain("/brand/startrips-v12-wordmark.svg");
    expect(markup).not.toContain("startrips-signature-motion");
    expect(markup).not.toContain("startrips-goat-show");
  });

  it("plays the goat show over the wordmark's baseline and scale, drawing above it", async () => {
    // The show is a deferred module; the wordmark button fetches it before playing.
    await loadStartripsGoatShow();
    const markup = renderToStaticMarkup(createElement(StartripsSignatureMoment, {
      phase: "playing", size: 34, show: "goat", onEnd: () => undefined,
    }));
    expect(markup).toContain('class="startrips-signature-moment is-playing');
    expect(markup).toContain('class="startrips-goat-show"');
    expect(markup).toContain('viewBox="-20 -300 820 360"');
    // Stage offset from the wordmark box: -20 and -175 of 176 units per size.
    const style = markup.match(/class="startrips-goat-show"[^>]*style="([^"]*)"/)?.[1] ?? "";
    expect(style).toContain(`left:${(-20 * 34) / 176}px`);
    expect(style).toContain(`top:${(-175 * 34) / 176}px`);
    expect(style).toContain(`width:${(820 * 34) / 176}px`);
    expect(style).toContain(`height:${(360 * 34) / 176}px`);
    // Colour comes from currentColor, like the wordmark; no unstyled class is left.
    expect(markup).not.toContain("goat-fill");
    expect(markup).not.toContain("startrips-signature-motion");
  });

  it("keeps the `full` clip for the other signature moments", () => {
    const markup = renderToStaticMarkup(createElement(StartripsSignatureMoment, {
      phase: "playing", size: 52, onEnd: () => undefined,
    }));
    expect(markup).toContain('data-signature-clip="full"');
    expect(markup).not.toContain("startrips-goat-show");
  });
});
