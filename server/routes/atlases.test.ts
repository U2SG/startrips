import { describe, expect, it } from "vitest";
import { parseAtlasDetails } from "./atlases";

describe("parseAtlasDetails", () => {
  it("accepts a trimmed title and dedication", () => {
    expect(parseAtlasDetails({
      title: "  Our Shared Atlas  ",
      dedication: "  for the road ahead  ",
    })).toEqual({
      title: "Our Shared Atlas",
      dedication: "for the road ahead",
    });
  });

  it("rejects missing titles and oversized values", () => {
    expect(parseAtlasDetails({ title: "", dedication: "" })).toBeNull();
    expect(parseAtlasDetails({ title: "   ", dedication: "" })).toBeNull();
    expect(parseAtlasDetails({ title: "x".repeat(81), dedication: "" }))
      .toBeNull();
    expect(parseAtlasDetails({ title: "Atlas", dedication: "y".repeat(241) }))
      .toBeNull();
  });

  it("rejects non-string titles and treats non-string dedication as empty", () => {
    expect(parseAtlasDetails({ title: 42, dedication: "" })).toBeNull();
    expect(parseAtlasDetails({ title: "Atlas", dedication: ["x"] })).toEqual({
      title: "Atlas",
      dedication: "",
    });
  });
});
