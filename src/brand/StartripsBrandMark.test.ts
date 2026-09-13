import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  StartripsBrandLoader,
  StartripsBrandMark,
  StartripsLoadingPoints,
  StartripsWordmark,
} from "./StartripsBrandMark";
import { STARTRIPS_V12_MARK_MARKUP } from "./startripsV12Mark";

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

  it("uses the semantic loading clip on the existing product loader", () => {
    const markup = renderToStaticMarkup(createElement(StartripsBrandLoader, { message: "Loading" }));
    expect(markup).toContain('data-signature-clip="loading"');
    expect(markup).toContain('/brand/startrips-v12-wordmark.svg#letters');
    expect(markup).toContain('/brand/startrips-v12-wordmark.svg#leg-fn');
    expect(markup).not.toContain('startrips-v12-wordmark__art');
  });

  it("keeps the inline compact geometry in lockstep with the committed v12 mark asset", () => {
    const asset = readFileSync("public/brand/startrips-v12-mark.svg", "utf8");
    const pathData = (source: string) => [...source.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((match) => match[1]);
    expect(pathData(STARTRIPS_V12_MARK_MARKUP)).toEqual(pathData(asset));
  });

  it("keeps the animated wordmark goat geometry identical to the compact v12 mark geometry", () => {
    const markAsset = readFileSync("public/brand/startrips-v12-mark.svg", "utf8");
    const wordmarkAsset = readFileSync("public/brand/startrips-v12-wordmark.svg", "utf8");
    const goatSlice = wordmarkAsset.slice(wordmarkAsset.indexOf('<g id="goat">'));
    const pathData = (source: string) => [...source.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((match) => match[1]);
    expect(pathData(goatSlice)).toEqual(pathData(markAsset));
  });



});
