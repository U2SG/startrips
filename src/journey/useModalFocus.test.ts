import { afterEach, describe, expect, it, vi } from "vitest";
import { claimInertOwnership, isModalFocusCandidate, modalSurfaceFor } from "./useModalFocus";

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

// #250: an element-like stub is enough here, and deliberate — the project runs
// every test in the default node environment, and the ownership rule is a
// property of the claim/release pair, not of a real layout.
function background(inert = false) {
  return { inert } as unknown as HTMLElement;
}

function inertMutationHarness() {
  let callback: MutationCallback | null = null;
  let pending: MutationRecord[] = [];

  class TestMutationObserver {
    constructor(next: MutationCallback) {
      callback = next;
    }

    observe() {}

    disconnect() {}

    takeRecords() {
      const records = pending;
      pending = [];
      return records;
    }
  }

  vi.stubGlobal("MutationObserver", TestMutationObserver);
  const record = () => ({ attributeName: "inert" }) as MutationRecord;

  return {
    queueExternalWrite() {
      pending.push(record());
    },
    flushExternalWrite() {
      callback?.([record()], {} as MutationObserver);
    },
  };
}

describe("claimInertOwnership", () => {
  it("leaves an externally owned inert flag untouched through claim and release", () => {
    // The mobile Journey sheet layer while React holds inert={storyJourneyId !== null}.
    const sheetLayer = background(true);
    const release = claimInertOwnership([sheetLayer]);
    expect(sheetLayer.inert).toBe(true);

    // React drops its own flag when the Story closes, in the commit that tears
    // the expanded Story's trap down. The trap must not write the stale value back.
    sheetLayer.inert = false;
    release();
    expect(sheetLayer.inert).toBe(false);
  });

  it("releases only what it claimed when an owner is still holding a sibling", () => {
    const claimable = background(false);
    const externallyOwned = background(true);
    const release = claimInertOwnership([claimable, externallyOwned]);
    expect([claimable.inert, externallyOwned.inert]).toEqual([true, true]);

    release();
    // The claimed Atlas child is handed back; the still-owned one keeps its flag.
    expect(claimable.inert).toBe(false);
    expect(externallyOwned.inert).toBe(true);
  });

  it("applies the same rule to the account dock as to the atlas children", () => {
    // The dock branch and the children loop share one claim path, so an
    // already-inert dock (playback cinematic) survives a modal round trip.
    const atlasChild = background(false);
    const accountDock = background(true);
    claimInertOwnership([atlasChild, accountDock])();
    expect(atlasChild.inert).toBe(false);
    expect(accountDock.inert).toBe(true);
  });

  it("ends cleanup with inert === false for every element it did claim", () => {
    const children = [background(false), background(false), background(false)];
    const release = claimInertOwnership(children);
    expect(children.every((child) => child.inert)).toBe(true);
    release();
    expect(children.map((child) => child.inert)).toEqual([false, false, false]);
  });

  it("is idempotent across nested traps sharing one background", () => {
    // Outer sheet trap claims, inner Story trap finds it already inert and
    // declines; the inner release must not free the outer trap's claim.
    const child = background(false);
    const releaseOuter = claimInertOwnership([child]);
    const releaseInner = claimInertOwnership([child]);
    releaseInner();
    expect(child.inert).toBe(true);
    releaseOuter();
    expect(child.inert).toBe(false);
  });

  it("does not clear an external inert owner acquired just before trap suspension cleanup", () => {
    const mutations = inertMutationHarness();
    const atlasChrome = background(false);
    const release = claimInertOwnership([atlasChrome]);
    expect(atlasChrome.inert).toBe(true);

    // React writes inert=true in the host mutation phase. The observer callback
    // may still be pending when the passive trap cleanup begins, so release must
    // consult takeRecords() as well as already-delivered records.
    atlasChrome.inert = true;
    mutations.queueExternalWrite();
    release();
    expect(atlasChrome.inert).toBe(true);
  });

  it("does not clear an external inert owner already observed before modal teardown cleanup", () => {
    const mutations = inertMutationHarness();
    const atlasChrome = background(false);
    const release = claimInertOwnership([atlasChrome]);

    atlasChrome.inert = true;
    mutations.flushExternalWrite();
    release();
    expect(atlasChrome.inert).toBe(true);
  });
});
