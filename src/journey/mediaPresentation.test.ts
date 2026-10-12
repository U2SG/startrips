import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("shared presentation ignores recipient preferences", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it.each(["/share", "/share/"])("uses the link in %s without changing the browser preference", async (pathname) => {
    const storage = { getItem: vi.fn(() => "stream"), setItem: vi.fn() };
    vi.stubGlobal("window", { location: { pathname, search: "?mediaPresentation=book-3d" }, localStorage: storage });
    vi.resetModules();
    const presentation = await import("./mediaPresentation");
    expect(presentation.readMediaPresentationStyle()).toBe("book-3d");
    storage.getItem.mockReturnValue("note-overlay");
    expect(presentation.readMediaPresentationStyle()).toBe("book-3d");
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();

    // An explicit reader recovery still works, just for this visit.
    presentation.writeMediaPresentationStyle("book");
    expect(presentation.readMediaPresentationStyle()).toBe("book");
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it.each(["", "?mediaPresentation=unknown"])("uses classic for legacy or invalid links: %s", async (search) => {
    vi.stubGlobal("window", {
      location: { pathname: "/share", search },
      localStorage: { getItem: vi.fn(() => "book-3d"), setItem: vi.fn() },
    });
    vi.resetModules();
    const { readMediaPresentationStyle } = await import("./mediaPresentation");
    expect(readMediaPresentationStyle()).toBe("classic");
  });
});
