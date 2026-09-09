import { describe, expect, it } from "vitest";
import { resolveGlobeRenderState } from "./globeVisibility";

const base = {
  documentVisible: true, opaqueMediaCover: false, coverTransitionActive: false,
  focusFlightActive: false, interactionActive: false, earthDiveOverlapActive: false,
};

describe("resolveGlobeRenderState", () => {
  it("suspends only a stable full cover", () => {
    expect(resolveGlobeRenderState({ ...base, opaqueMediaCover: true })).toBe("covered");
    expect(resolveGlobeRenderState({ ...base, opaqueMediaCover: true, coverTransitionActive: true })).toBe("rendering");
    expect(resolveGlobeRenderState({ ...base, opaqueMediaCover: true, focusFlightActive: true })).toBe("rendering");
    expect(resolveGlobeRenderState({ ...base, opaqueMediaCover: true, interactionActive: true })).toBe("rendering");
    expect(resolveGlobeRenderState({ ...base, opaqueMediaCover: true, earthDiveOverlapActive: true })).toBe("rendering");
  });
  it("keeps partial visibility rendering and composes hidden-tab authority first", () => {
    expect(resolveGlobeRenderState(base)).toBe("rendering");
    expect(resolveGlobeRenderState({ ...base, documentVisible: false, opaqueMediaCover: true })).toBe("hidden");
    expect(resolveGlobeRenderState({ ...base, documentVisible: false })).toBe("hidden");
  });
});
