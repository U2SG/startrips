import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  StartripsBrandMark,
  StartripsLoadingPoints,
  StartripsWordmark,
} from "./StartripsBrandMark";

describe("Startrips v12 brand identity", () => {
  it("uses the approved v12 compact goat-and-star mark", () => {
    const markup = renderToStaticMarkup(createElement(StartripsBrandMark, {
      size: 48,
      state: "waiting",
      title: "Startrips",
    }));

    expect(markup).toContain('data-brand-version="12"');
    expect(markup).toContain('data-brand-state="waiting"');
    expect(markup).toContain('viewBox="610 -132 170 150"');
    expect(markup).toContain('data-brand-part="goat"');
    expect(markup).toContain('data-brand-part="star"');
    expect(markup).not.toContain('tabler');
  });

  it("keeps the authored wordmark and i-dot star when the goat companion is omitted", () => {
    const withCompanion = renderToStaticMarkup(createElement(StartripsWordmark, { size: 34 }));
    const wordmarkOnly = renderToStaticMarkup(createElement(StartripsWordmark, {
      size: 34,
      companion: false,
    }));

    expect(withCompanion).toContain('/brand/startrips-v12-wordmark.svg');
    expect(wordmarkOnly).toContain('/brand/startrips-v12-wordmark-only.svg');
    expect(withCompanion).toContain('aria-label="Startrips"');
    expect(wordmarkOnly).toContain('data-brand-version="12"');
  });


  it("keeps one authored i-dot star in the full and wordmark-only SVG assets", () => {
    for (const asset of [
      "public/brand/startrips-v12-wordmark.svg",
      "public/brand/startrips-v12-wordmark-only.svg",
    ]) {
      const svg = readFileSync(asset, "utf8");
      expect(svg.match(/id="star"/g)).toHaveLength(1);
      expect(svg).toContain('fill="currentColor"');
      expect(svg).not.toContain("IconSparkle");
    }
    expect(readFileSync("public/brand/startrips-v12-wordmark.svg", "utf8")).toContain('id="goat"');
    expect(readFileSync("public/brand/startrips-v12-wordmark-only.svg", "utf8")).not.toContain('id="goat"');
  });

  it("retires the legacy loading-particle signal so v12 keeps one four-point star", () => {
    expect(renderToStaticMarkup(createElement(StartripsLoadingPoints))).toBe("");
  });
});
