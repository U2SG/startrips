import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { motionTokens } from "../motion/tokens";
import { StartripsWordmarkSignatureButton } from "./StartripsSignatureMoment";
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
    expect(markup.startsWith("<button")).toBe(true);
    expect(markup).toContain('type="button"');
    expect(markup).toContain('aria-label="播放 Startrips 动画"');
    expect(markup).toContain('data-brand-state="travel"');
    expect(markup).toContain("/brand/startrips-v12-wordmark.svg");
    expect(markup).not.toContain("startrips-signature-motion");
  });
});
