import { describe, expect, it } from "vitest";
import {
  isAllowedOpenFreemapPath,
  rewriteOpenFreemapUrls,
} from "./mapstyle";

describe("mapstyle proxy validation", () => {
  it("allows only known OpenFreeMap resource prefixes", () => {
    expect(isAllowedOpenFreemapPath("styles/fiord")).toBe(true);
    expect(isAllowedOpenFreemapPath("planet")).toBe(true);
    expect(isAllowedOpenFreemapPath("planet/2/0/1.pbf")).toBe(true);
    expect(isAllowedOpenFreemapPath("fonts/Noto%20Sans%20Regular/0-255.pbf"))
      .toBe(true);
    expect(isAllowedOpenFreemapPath("sprites/ofm_f384/ofm.json")).toBe(true);
    expect(isAllowedOpenFreemapPath("natural_earth/ne2sr/2/0/1.png"))
      .toBe(true);
  });

  it("rejects traversal, foreign, and oversized paths", () => {
    expect(isAllowedOpenFreemapPath("")).toBe(false);
    expect(isAllowedOpenFreemapPath("planet/../secrets")).toBe(false);
    expect(isAllowedOpenFreemapPath("//planet/2/0/1.pbf")).toBe(false);
    expect(isAllowedOpenFreemapPath("https://evil.example/x")).toBe(false);
    expect(isAllowedOpenFreemapPath("planet/" + "a".repeat(300))).toBe(false);
    expect(isAllowedOpenFreemapPath("styles/../planet/2/0/1.pbf")).toBe(false);
  });
});

describe("rewriteOpenFreemapUrls", () => {
  it("rewrites provider URLs to the same-origin proxy as absolute URLs", () => {
    const style = JSON.stringify({
      glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
      sprite: "https://tiles.openfreemap.org/sprites/ofm_f384/ofm",
      sources: {
        openmaptiles: { url: "https://tiles.openfreemap.org/planet" },
      },
    });
    const rewritten = rewriteOpenFreemapUrls(style, "https://startrips.example");
    expect(rewritten).toContain(
      "https://startrips.example/api/mapstyle?path=fonts%2F{fontstack}%2F{range}.pbf",
    );
    expect(rewritten).toContain(
      "https://startrips.example/api/mapstyle?path=planet",
    );
    expect(rewritten).toContain(
      "https://startrips.example/api/mapstyle/sprite/sprites/ofm_f384/ofm",
    );
    expect(rewritten).not.toContain("startrips.example/api/mapstyle?path=sprites");
  });

  it("leaves unrelated JSON untouched", () => {
    const body = JSON.stringify({ hello: "world" });
    expect(rewriteOpenFreemapUrls(body, "https://startrips.example")).toBe(body);
  });
});
