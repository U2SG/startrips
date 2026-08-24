import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LivingAtlasGlobe } from "./LivingAtlasGlobe";

function markup(storedAmbience: string | null) {
  // A stored preference must not be able to remove the ambience layer, so the
  // globe is rendered with the old "off" value still present in storage.
  const previous = (globalThis as { localStorage?: unknown }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => storedAmbience,
    setItem: () => undefined,
  };
  try {
    return renderToStaticMarkup(createElement(LivingAtlasGlobe, {
      journeyRoutes: [],
      onJourneyRouteActivate: () => undefined,
      onJourneyRoutePointActivate: () => undefined,
    }));
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
