import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMPACT_MOBILE_LAYOUT_ATTRIBUTE,
  COMPACT_MOBILE_MEDIA_QUERY,
  compactMobileLayoutMarker,
} from "./mobileLayout";

/**
 * #194: one product-level definition of compact/mobile interaction mode, and
 * the literal is never duplicated across TS and CSS. `mobileLayout.ts` owns the
 * query; every product surface publishes `data-mobile-v2` from the resolved
 * boolean and its stylesheet keys off that attribute, so no stylesheet states a
 * breakpoint that could drift.
 *
 * The allowlist is exactly the product surfaces #194 names, plus the two
 * stylesheets migrated as same-class siblings. Nothing outside it is asserted
 * on, so the legacy `?qaState=` art-archive experience (`src/App.tsx`,
 * `src/styles/personal-gallery.css`) keeps its own breakpoints.
 */
const GLOBE_SCENE_SOURCES = [
  "src/scene/ParticleEarthScene.tsx",
  "src/scene/LivingAtlasGlobe.tsx",
] as const;

/** Stylesheet -> the component that publishes the attribute it keys off. */
const ATTRIBUTE_DRIVEN_STYLESHEETS = {
  "src/styles/journey-playback.css": {
    publisher: "src/journey/JourneyPlaybackOverlay.tsx",
    scope: '.journey-playback[data-mobile-v2="on"]',
    surface: ".journey-playback",
  },
  "src/styles/globe-time-scrubber.css": {
    publisher: "src/journey/GlobeTimeScrubber.tsx",
    scope: '.globe-time-scrubber[data-mobile-v2="on"]',
    surface: ".globe-time-scrubber",
  },
  // `src/app.css` also holds the legacy `?qaState=` experience, which keeps its
  // own 720px block; only the globe overlay selectors are constrained here.
  "src/app.css": {
    publisher: "src/scene/ParticleEarthScene.tsx",
    scope: '.particle-earth-scene[data-mobile-v2="on"]',
    surface: ".particle-earth",
  },
} as const;

const JUSTIFIED_WIDTH_ONLY_STYLESHEET = "src/styles/auth-gate.css";

const read = (path: string) => readFileSync(path, "utf8");
const normalize = (query: string) => query.replace(/\s+/g, " ").trim();

/** Prelude text of every `@media` rule, without matching braces (blocks nest). */
function mediaPreludes(css: string) {
  return Array.from(css.matchAll(/@media([^{]*)\{/g), (match) => normalize(match[1]));
}

/** `@media` blocks whose prelude names any dimension of 960px or less. */
function phoneSizedMediaBlocks(css: string) {
  const blocks: Array<{ prelude: string; body: string }> = [];
  for (const match of css.matchAll(/@media([^{]*)\{/g)) {
    const prelude = normalize(match[1]);
    const widths = Array.from(
      prelude.matchAll(/(?:max|min)-(?:width|height):\s*(\d+)px/g),
      (width) => Number(width[1]),
    );
    if (!widths.some((width) => width <= 960)) continue;
    let depth = 0;
    let index = match.index + match[0].length - 1;
    const start = index;
    for (; index < css.length; index += 1) {
      if (css[index] === "{") depth += 1;
      else if (css[index] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    blocks.push({ prelude, body: css.slice(start + 1, index) });
  }
  return blocks;
}

describe("#194 compact-mobile contract", () => {
  it("marks the compact mode exactly when the resolved layout is compact", () => {
    expect(compactMobileLayoutMarker(true)).toBe("on");
    expect(compactMobileLayoutMarker(false)).toBe("off");
    expect(COMPACT_MOBILE_LAYOUT_ATTRIBUTE).toBe("data-mobile-v2");
  });

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

  it("states the shared query in exactly one place", () => {
    // The stylesheets #194 names must not carry a copy of the literal, and the
    // owning module must carry it once. `src/styles/living-atlas.css` is the
    // pre-existing #58 shell implementation and is deliberately out of scope.
    const owner = read("src/journey/mobileLayout.ts");
    expect(owner.split(COMPACT_MOBILE_MEDIA_QUERY)).toHaveLength(2);
    for (const path of Object.keys(ATTRIBUTE_DRIVEN_STYLESHEETS)) {
      const css = read(path);
      expect(css, `${path} states a breakpoint of its own`).not.toContain("760");
      expect(normalize(css)).not.toContain(normalize(COMPACT_MOBILE_MEDIA_QUERY));
    }
  });

  it("keys every migrated stylesheet off the published attribute", () => {
    for (const [path, { publisher, scope, surface }] of Object.entries(ATTRIBUTE_DRIVEN_STYLESHEETS)) {
      const css = read(path);
      expect(css, `${path} does not use ${scope}`).toContain(scope);
      // A phone-sized media block that styles this surface would be a second
      // breakpoint even without the 760 literal.
      const offenders = phoneSizedMediaBlocks(css)
        .filter((block) => block.body.includes(surface))
        .map((block) => block.prelude);
      expect(offenders, `${path} styles ${surface} behind a phone breakpoint`).toEqual([]);

      const source = read(publisher);
      expect(source, `${publisher} does not publish the compact marker`)
        .toContain("compactMobileLayoutMarker(");
      expect(source).toContain(`${COMPACT_MOBILE_LAYOUT_ATTRIBUTE}={compactMobileLayoutMarker(`);
    }
  });

  it("derives every publisher's marker from the shared hook or an injected flag", () => {
    // Playback and the scrubber own their answer; the scene is handed one by
    // its React owner, which is what acceptance 1 requires.
    for (const path of [
      "src/journey/JourneyPlaybackOverlay.tsx",
      "src/journey/GlobeTimeScrubber.tsx",
      "src/journey/LivingAtlasApp.tsx",
    ]) {
      expect(read(path), `${path} does not read the shared hook`)
        .toContain("useCompactMobileLayout()");
    }
    expect(read("src/scene/ParticleEarthScene.tsx"))
      .toContain("compactMobileLayoutMarker(compactMobileLayout)");
  });

  it("requires the auth width-only block to carry its justification", () => {
    const css = read(JUSTIFIED_WIDTH_ONLY_STYLESHEET);
    const widthOnly = mediaPreludes(css).filter(
      (prelude) => prelude.includes("760px")
        && prelude !== normalize(COMPACT_MOBILE_MEDIA_QUERY),
    );
    if (widthOnly.length === 0) return;
    // Audited under #194 and deliberately left width-only, so the reasoning has
    // to stay in the file: a later edit that drops it fails here.
    expect(css).toContain("#194 audit: width-only here is deliberate");
  });
});
