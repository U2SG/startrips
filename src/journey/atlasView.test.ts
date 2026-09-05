import { describe, expect, it, vi } from "vitest";
import {
  ATLAS_MUTATION_CAPABILITIES,
  GUEST_ATLAS_VIEW_CAPABILITIES,
  OWNER_ATLAS_VIEW_CAPABILITIES,
  createOwnerAtlasMutations,
  createOwnerAtlasView,
  isReadOnlyAtlasView,
  resolveAtlasView,
  type AtlasView,
} from "./atlasView";

const GUEST_VIEW: AtlasView = {
  capabilities: GUEST_ATLAS_VIEW_CAPABILITIES,
  listJourneys: async () => [],
  readMedia: async () => ({ url: "signed", expiresAt: "2026-09-05T00:00:00.000Z" }),
  mutations: null,
};

describe("AtlasViewCapabilities (#200 phase D)", () => {
  it("lists every mutation capability, so a new one cannot default to allowed", () => {
    // If a capability is added to the type without being classified here, the
    // union below stops covering the owner set and this fails.
    const classified = new Set<string>([
      ...ATLAS_MUTATION_CAPABILITIES,
      "canViewPlayback",
    ]);
    expect(Object.keys(OWNER_ATLAS_VIEW_CAPABILITIES).sort())
      .toEqual([...classified].sort());
  });

  it("grants the owner every capability", () => {
    expect(Object.values(OWNER_ATLAS_VIEW_CAPABILITIES).every(Boolean)).toBe(true);
    expect(isReadOnlyAtlasView(OWNER_ATLAS_VIEW_CAPABILITIES)).toBe(false);
  });

  it("grants a guest viewing only", () => {
    for (const capability of ATLAS_MUTATION_CAPABILITIES) {
      expect(GUEST_ATLAS_VIEW_CAPABILITIES[capability]).toBe(false);
    }
    // Read-only does not mean static: #200 keeps playback for a guest.
    expect(GUEST_ATLAS_VIEW_CAPABILITIES.canViewPlayback).toBe(true);
    expect(isReadOnlyAtlasView(GUEST_ATLAS_VIEW_CAPABILITIES)).toBe(true);
  });

  it("treats one true mutation capability as not read-only", () => {
    expect(isReadOnlyAtlasView({
      ...GUEST_ATLAS_VIEW_CAPABILITIES,
      canManageMedia: true,
    })).toBe(false);
  });
});

describe("owner and guest atlas views", () => {
  it("builds an owner view with a complete mutation client", () => {
    const view = createOwnerAtlasView();
    expect(view.capabilities).toEqual(OWNER_ATLAS_VIEW_CAPABILITIES);
    expect(view.mutations).not.toBeNull();
    expect(Object.keys(view.mutations ?? {}).sort()).toEqual([
      // #200 phase E: creating, listing and revoking a share are owner calls,
      // so they belong to the same client every other owner write goes through.
      "createShare",
      "deleteJourney",
      "deleteMedia",
      "listShares",
      "moveJourneyMedia",
      "reorderJourneyMedia",
      "restoreJourney",
      "revokeShare",
      "setJourneyCover",
      "undoJourneyMediaMove",
      "uploadJourneyMedia",
    ]);
    expect(Object.values(createOwnerAtlasMutations())
      .every((entry) => typeof entry === "function")).toBe(true);
  });

  it("narrows one owner capability without dropping the mutation client", () => {
    // A member who may create but not delete is still an owner-mode view: the
    // capability is what disappears, not the client the rest of the app uses.
    const view = createOwnerAtlasView({ canDeleteJourney: false });
    expect(view.capabilities.canDeleteJourney).toBe(false);
    expect(view.capabilities.canCreateJourney).toBe(true);
    expect(view.mutations).not.toBeNull();
  });

  it("gives a guest view no mutation client at all", () => {
    // Not "the buttons are hidden" — there is no object here with a write on
    // it, so nothing under this view can construct one.
    expect(GUEST_VIEW.mutations).toBeNull();
  });
});

describe("resolveAtlasView", () => {
  it("never constructs the owner fallback when a view was provided", () => {
    // This is the whole guarantee behind "in guest mode no mutation-capable
    // API client is constructed at all": the shared route always provides its
    // own value, so the owner factory is never reached.
    const ownerFallback = vi.fn(() => createOwnerAtlasView());
    expect(resolveAtlasView(GUEST_VIEW, ownerFallback)).toBe(GUEST_VIEW);
    expect(ownerFallback).not.toHaveBeenCalled();
  });

  it("falls back to the full owner set when no view was provided", () => {
    // #200 acceptance: the contract defaults to the owner set, so a surface
    // that predates it keeps behaving exactly as before.
    const fallback = createOwnerAtlasView();
    const ownerFallback = vi.fn(() => fallback);
    expect(resolveAtlasView(null, ownerFallback)).toBe(fallback);
    expect(ownerFallback).toHaveBeenCalledTimes(1);
  });
});
