import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMPACT_MOBILE_MEDIA_QUERY } from "./mobileLayout";

/**
 * #194: one product-level definition of compact/mobile interaction mode.
 *
 * The allowlist is exactly the product surfaces #194 names. Nothing outside it
 * is asserted on, so the legacy `?qaState=` art-archive experience
 * (`src/App.tsx`, `src/styles/personal-gallery.css`) keeps its own breakpoints.
 */
const GLOBE_SCENE_SOURCES = [
  "src/scene/ParticleEarthScene.tsx",
  "src/scene/LivingAtlasGlobe.tsx",
] as const;
const SHARED_CONTRACT_STYLESHEET = "src/styles/journey-playback.css";
const JUSTIFIED_WIDTH_ONLY_STYLESHEET = "src/styles/auth-gate.css";

const read = (path: string) => readFileSync(path, "utf8");
const normalize = (query: string) => query.replace(/\s+/g, " ").trim();

/** Prelude text of every `@media` rule, without matching braces (blocks nest). */
function mediaPreludes(css: string) {
  return Array.from(css.matchAll(/@media([^{]*)\{/g), (match) => normalize(match[1]));
}

describe("#194 compact-mobile contract", () => {
  it("keeps the globe scene from inferring the product mode from a viewport width", () => {
    for (const path of GLOBE_SCENE_SOURCES) {
      const source = read(path);
      // Any comparison of a raw viewport dimension against a pixel literal is a
      // second, independent breakpoint - the failure class #58 removed.
      const inferred = source.match(
        /window\.(innerWidth|innerHeight)\s*[<>]=?\s*\d/g,
      );
      expect(inferred, `${path} re-derives compact mobile mode`).toBeNull();
    }
  });

  it("hands the globe scene one compact flag from its React owner", () => {
    const scene = read("src/scene/ParticleEarthScene.tsx");
    const owner = read("src/scene/LivingAtlasGlobe.tsx");
    expect(scene).toContain("compactMobileLayout?: boolean;");
    expect(scene).toContain("resolveRouteLabelSafeArea");
    expect(scene).toContain("resolveRouteLabelLimit(currentCompactMobileLayout)");
    expect(owner).toContain('useCompactMobileLayout } from "../journey/mobileLayout"');
    expect(owner).toContain("compactMobileLayout={compactMobileLayout}");
  });

  it("states the Journey Playback compact block as the shared query", () => {
    const preludes = mediaPreludes(read(SHARED_CONTRACT_STYLESHEET));
    const canonical = normalize(COMPACT_MOBILE_MEDIA_QUERY);
    expect(preludes).toContain(canonical);
    // Other breakpoints in this file (a 1024px tablet block) stay legitimate;
    // only a query that touches the 760px product boundary is constrained.
    const drifted = preludes.filter(
      (prelude) => prelude.includes("760px") && prelude !== canonical,
    );
    expect(drifted, `${SHARED_CONTRACT_STYLESHEET} reintroduced a width-only mobile breakpoint`)
      .toEqual([]);
  });

  it("requires the auth width-only block to carry its justification", () => {
    const css = read(JUSTIFIED_WIDTH_ONLY_STYLESHEET);
    const preludes = mediaPreludes(css);
    const canonical = normalize(COMPACT_MOBILE_MEDIA_QUERY);
    const widthOnly = preludes.filter(
      (prelude) => prelude.includes("760px") && prelude !== canonical,
    );
    if (widthOnly.length === 0) return;
    // Audited under #194 and deliberately left width-only, so the reasoning has
    // to stay in the file: a later edit that drops it fails here.
    expect(css).toContain("#194 audit: width-only here is deliberate");
  });
});
