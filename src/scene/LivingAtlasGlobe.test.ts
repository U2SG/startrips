import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LivingAtlasGlobe, PersistentEarthProvider, resolveLivingAtlasHomeBaseLayer } from "./LivingAtlasGlobe";
import { getRouteFocusPhase } from "./ParticleEarthScene";
import type { HomeBasePeriod } from "../journey/homeBase";
import { resolveHomeBasePresence } from "../journey/homeBasePresence";
import { readFileSync } from "node:fs";

function markup(storedAmbience: string | null) {
  // A stored preference must not be able to remove the ambience layer, so the
  // globe is rendered with the old "off" value still present in storage.
  const previous = (globalThis as { localStorage?: unknown }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => storedAmbience,
    setItem: () => undefined,
  };
  try {
    return renderToStaticMarkup(createElement(
      PersistentEarthProvider,
      null,
      createElement(LivingAtlasGlobe, {
        journeyRoutes: [],
        onJourneyRouteActivate: () => undefined,
        onJourneyRoutePointActivate: () => undefined,
      }),
    ));
  } finally {
    (globalThis as { localStorage?: unknown }).localStorage = previous;
  }
}

describe("LivingAtlasGlobe ambience", () => {
  it("renders the ambience field on first paint with no toggle", () => {
    const rendered = markup(null);
    expect(rendered).toContain("living-atlas-ambience");
    expect(rendered).toContain("living-atlas-ambience__blob-a");
    expect(rendered).toContain('data-ambience="on"');
    expect(rendered).not.toContain("data-ambience-toggle");
    expect(rendered).not.toContain("开启氛围效果");
    expect(rendered).not.toContain("关闭氛围效果");
  });

  it("ignores a stored preference that used to disable the ambience", () => {
    expect(markup("off")).toContain("living-atlas-ambience__blob-c");
    expect(markup("off")).toContain('data-ambience="on"');
  });
});

describe("route focus choreography phase", () => {
  it("derives flying and settled from route ownership", () => {
    expect(getRouteFocusPhase(true, true, false)).toBe("flying");
    expect(getRouteFocusPhase(true, false, false)).toBe("settled");
  });

  it("keeps zoom release distinct from the idle state", () => {
    expect(getRouteFocusPhase(false, false, true)).toBe("releasing");
    expect(getRouteFocusPhase(false, false, false)).toBe("idle");
  });
});


describe("Home Base presence projection (ST-056)", () => {
  const period: HomeBasePeriod = {
    id: "home-shenzhen", label: "Shenzhen", latitude: 22.5431, longitude: 114.0579,
    startedOn: "2026-01-01", endedOn: null, source: "manual",
  };

  it("turns the typed Home prop into one drawable and leaves an absent prop empty", () => {
    const resolved = resolveHomeBasePresence({
      periods: [period], semanticZoom: "regional", timeline: { kind: "ordinary", date: "2026-09-10" },
    });
    const layer = resolveLivingAtlasHomeBaseLayer({ resolved, periods: [period], effectiveDate: "2026-09-10" });
    expect(layer).toHaveLength(1);
    expect(layer[0].anchor).toBe(resolved[0].anchor);
    expect(resolveLivingAtlasHomeBaseLayer(undefined)).toEqual([]);
  });

  it("keeps projection and manual ownership inside the existing particle scene authority", () => {
    const source = readFileSync(new URL("./ParticleEarthScene.tsx", import.meta.url), "utf8");
    expect(source).toContain("projectLocalPoint(");
    expect(source).toContain("descriptor.anchor.x");
    expect(source).toContain("latestOnManualCameraInteraction.current?.()");
    expect(source).toContain("claimManualInteraction(false)");
  });
  it("keeps initial Home camera seeding separate from semantic focus ownership", () => {
    const globeSource = readFileSync(new URL("./LivingAtlasGlobe.tsx", import.meta.url), "utf8");
    const particleSource = readFileSync(new URL("./ParticleEarthScene.tsx", import.meta.url), "utf8");
    expect(globeSource).toContain("focusPoint={atlas?.focusPoint}");
    expect(globeSource).toContain("initialCameraAnchor={atlas?.initialCameraAnchor}");
    expect(globeSource).not.toContain("focusPoint={atlas?.focusPoint ?? atlas?.initialCameraAnchor}");
    expect(particleSource).toContain("initialCameraAnchorNow");
    expect(particleSource).toContain("rotationXForLatitude(initialCameraAnchorNow.lat)");
    expect(particleSource).toContain("rotationYForLongitude(initialCameraAnchorNow.lon)");
    expect(particleSource).toContain("if (initialCameraAnchorNow && activePointers.size === 0)");
    expect(particleSource).toContain("interactiveRotationX = interpolate(interactiveRotationX, targetRotationX)");
    expect(particleSource).toMatch(/resolveParticleDiveAnchor\(\s*routeFocusFrame,\s*latestFocusPoint\.current,\s*initialCameraAnchorNow,/);
  });
  it("keeps Home presence on the particle owner through prewarm/blend and off the detail owner", () => {
    const source = readFileSync(new URL("./LivingAtlasGlobe.tsx", import.meta.url), "utf8");
    expect(source).toContain('dive.owner !== "detail" && !cinematicActive');
  });
  it("keeps the Home accessibility target transparent to pointer camera gestures", () => {
    const css = readFileSync(new URL("../styles/living-atlas.css", import.meta.url), "utf8");
    const start = css.indexOf(".living-atlas-globe__home-base {");
    const rule = css.slice(start, css.indexOf("}", start));
    expect(start).toBeGreaterThanOrEqual(0);
    expect(rule).toContain("pointer-events: none;");
  });
});
