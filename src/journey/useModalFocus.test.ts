import { afterEach, describe, expect, it, vi } from "vitest";
import { isModalFocusCandidate, modalSurfaceFor } from "./useModalFocus";

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

describe("modalSurfaceFor", () => {
  it("keeps overlay wrappers as the modal surface for existing web dialogs", () => {
    const atlas = {} as HTMLElement;
    const overlay = { parentElement: atlas } as unknown as HTMLElement;
    const root = { parentElement: overlay } as unknown as HTMLElement;
    expect(modalSurfaceFor(root, atlas)).toBe(overlay);
  });

  it("keeps a direct atlas-child dialog reachable instead of inerting itself", () => {
    const atlas = {} as HTMLElement;
    const root = { parentElement: atlas } as unknown as HTMLElement;
    expect(modalSurfaceFor(root, atlas)).toBe(root);
  });
});
