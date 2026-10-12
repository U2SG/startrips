import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { requestMediaPresentationPreference, MEDIA_PRESENTATION_PREFERENCE_PATH } from "./mediaPresentationPreference";
import { SharedMediaPresentationProvider } from "./MediaPresentationProvider";
import { useMediaPresentationStyle } from "./mediaPresentation";
import { MEDIA_PRESENTATION_STYLES } from "./mediaPresentationStyle";

describe("durable media presentation", () => {
  it("reads the signed-in account and sends only the selected style on save", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ style: "stream" })));
    expect(await requestMediaPresentationPreference(undefined, undefined, request)).toBe("stream");
    expect(request).toHaveBeenLastCalledWith(MEDIA_PRESENTATION_PREFERENCE_PATH, expect.objectContaining({ method: "GET", credentials: "include" }));
    expect(await requestMediaPresentationPreference("stream", undefined, request)).toBe("stream");
    expect(request).toHaveBeenLastCalledWith(MEDIA_PRESENTATION_PREFERENCE_PATH, expect.objectContaining({ method: "PUT", body: JSON.stringify({ style: "stream" }) }));
  });

  it.each([401, 400, 500])("does not report a rejected %s save as a chosen style", async (status) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status }));
    await expect(requestMediaPresentationPreference("book", undefined, request)).rejects.toThrow("无法确认");
  });

  it("does not apply an unknown response or a failed connection", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ style: "cube" })))
      .mockRejectedValueOnce(new Error("connection lost"));
    await expect(requestMediaPresentationPreference("book", undefined, request)).rejects.toThrow("无法确认");
    await expect(requestMediaPresentationPreference("book", undefined, request)).rejects.toThrow("connection lost");
  });

  it.each(MEDIA_PRESENTATION_STYLES)("renders the share response's %s policy", (style) => {
    function Reader() { return createElement("span", null, useMediaPresentationStyle()); }
    const html = renderToStaticMarkup(createElement(SharedMediaPresentationProvider, { style, children: createElement(Reader) }));
    expect(html).toBe(`<span>${style}</span>`);
  });
});
