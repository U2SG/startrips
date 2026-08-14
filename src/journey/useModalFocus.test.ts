import { afterEach, describe, expect, it, vi } from "vitest";
import { isModalFocusCandidate } from "./useModalFocus";

function candidate({ inert = false, rendered = true } = {}) {
  return {
    closest: vi.fn(() => inert ? {} : null),
    getClientRects: vi.fn(() => ({ length: rendered ? 1 : 0 })),
  } as unknown as HTMLElement;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isModalFocusCandidate", () => {
  it("excludes controls inside an inert editor", () => {
    expect(isModalFocusCandidate(candidate({ inert: true }))).toBe(false);
  });

  it("keeps rendered, visible controls in the modal focus cycle", () => {
    vi.stubGlobal("getComputedStyle", () => ({ visibility: "visible" }));
    expect(isModalFocusCandidate(candidate())).toBe(true);
    expect(isModalFocusCandidate(candidate({ rendered: false }))).toBe(false);
  });
});
