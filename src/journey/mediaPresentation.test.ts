import { describe, expect, it } from "vitest";
import { mediaPresentationFromSearch, mediaPresentationLabel, nextMediaPresentationStyle, parseMediaPresentationStyle } from "./mediaPresentation";

describe("media presentation style", () => {
  it("falls back to classic for anything it does not know", () => {
    expect(parseMediaPresentationStyle(null)).toBe("classic");
    expect(parseMediaPresentationStyle("flip")).toBe("classic");
    expect(parseMediaPresentationStyle("book")).toBe("book");
  });

  it("cycles through every style and back", () => {
    expect(nextMediaPresentationStyle("classic")).toBe("note-overlay");
    expect(nextMediaPresentationStyle("note-overlay")).toBe("book");
    expect(nextMediaPresentationStyle("book")).toBe("book-3d");
    expect(nextMediaPresentationStyle("book-3d")).toBe("stream");
    expect(nextMediaPresentationStyle("stream")).toBe("classic");
  });

  it("names each style for the account menu", () => {
    expect(mediaPresentationLabel("classic")).toBe("默认");
    expect(mediaPresentationLabel("note-overlay")).toBe("图上感想");
    expect(mediaPresentationLabel("book")).toBe("旅程之书");
    expect(mediaPresentationLabel("book-3d")).toBe("立体之书");
    expect(mediaPresentationLabel("stream")).toBe("旅程之流");
  });

  it("reads a style from a link and ignores anything else", () => {
    expect(mediaPresentationFromSearch("?mediaPresentation=book")).toBe("book");
    expect(mediaPresentationFromSearch("?share=abc&mediaPresentation=note-overlay")).toBe("note-overlay");
    expect(mediaPresentationFromSearch("?mediaPresentation=cube")).toBeNull();
    expect(mediaPresentationFromSearch("")).toBeNull();
  });
});
