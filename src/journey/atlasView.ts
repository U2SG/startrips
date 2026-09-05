import { createContext, useContext } from "react";
import {
  createShare,
  deleteJourney,
  deleteMedia,
  getPrivateMediaRead,
  listJourneys,
  listShares,
  moveJourneyMedia,
  reorderJourneyMedia,
  restoreJourney,
  revokeShare,
  setJourneyCover,
  undoJourneyMediaMove,
  type JourneyMediaMoveUndo,
} from "./journeyApi";
import { uploadJourneyMedia } from "./JourneyComposer";
import type {
  CreatedShareGrant,
  Journey,
  PrivateMediaRead,
  ShareGrantSummary,
} from "./types";

/**
 * #200 phase D: what an Atlas view is allowed to do.
 *
 * One object decides whether a mutation affordance EXISTS. Components read it
 * instead of asking "am I a guest?" at every call site, because a scattered
 * `if (isGuest) hide this button` is exactly what the issue forbids: it leaves
 * the handler and its API client alive underneath the hidden control.
 *
 * The booleans are affordance decisions, not security. Enforcement lives on
 * the server: a share token resolves through `requireActiveShareGrant()` and
 * there is no mutating route it can reach. This contract exists so the browser
 * never builds a control, a handler or an API client that would need that
 * enforcement to say no.
 */
export type AtlasViewCapabilities = {
  canCreateJourney: boolean;
  canEditJourney: boolean;
  canDeleteJourney: boolean;
  canManageMedia: boolean;
  canManageAtlas: boolean;
  canShareAtlas: boolean;
  canViewPlayback: boolean;
};

/**
 * Every capability that authorizes a write, listed explicitly so a new one
 * cannot be added without deciding what a guest gets. `isReadOnlyAtlasView`
 * and the contract test both iterate this list rather than naming fields, so
 * a future capability that is left out of `GUEST_ATLAS_VIEW_CAPABILITIES`
 * fails the test instead of silently defaulting to allowed.
 */
export const ATLAS_MUTATION_CAPABILITIES = [
  "canCreateJourney",
  "canEditJourney",
  "canDeleteJourney",
  "canManageMedia",
  "canManageAtlas",
  "canShareAtlas",
] as const satisfies ReadonlyArray<keyof AtlasViewCapabilities>;

export type AtlasMutationCapability = (typeof ATLAS_MUTATION_CAPABILITIES)[number];

export const OWNER_ATLAS_VIEW_CAPABILITIES: AtlasViewCapabilities = {
  canCreateJourney: true,
  canEditJourney: true,
  canDeleteJourney: true,
  canManageMedia: true,
  canManageAtlas: true,
  canShareAtlas: true,
  canViewPlayback: true,
};

/**
 * The read-only capability set of #200: `VIEW_SELECTED_JOURNEYS` and
 * `VIEW_SELECTED_JOURNEY_MEDIA`, nothing else. Playback stays on — read-only
 * does not mean static, and a guest is meant to experience the journeys.
 */
export const GUEST_ATLAS_VIEW_CAPABILITIES: AtlasViewCapabilities = {
  canCreateJourney: false,
  canEditJourney: false,
  canDeleteJourney: false,
  canManageMedia: false,
  canManageAtlas: false,
  canShareAtlas: false,
  canViewPlayback: true,
};

export function isReadOnlyAtlasView(
  capabilities: AtlasViewCapabilities,
): boolean {
  return ATLAS_MUTATION_CAPABILITIES.every(
    (capability) => capabilities[capability] === false,
  );
}

/** Reading one private asset's short-lived signed URL. Never a mutation. */
export type AtlasMediaRead = (assetId: string) => Promise<PrivateMediaRead>;

/**
 * `uploadJourneyMedia` is typed through the module rather than imported as a
 * value here so this alias stays usable from a module that must not pull the
 * composer in at runtime.
 */
export type UploadJourneyMedia = typeof import("./JourneyComposer")["uploadJourneyMedia"];

/**
 * Every write the Atlas surfaces can perform, in one object.
 *
 * A component holds `AtlasMutations | null`. `null` is the whole point: it is
 * not "the buttons are hidden", it is "there is no client here that can
 * write". Before this contract the story dialog fell back to the owner API
 * whenever its optional `onMediaDelete` prop was absent, so omitting the prop
 * hid the control and left deletion reachable. Absence must mean absence.
 */
export type AtlasMutations = {
  deleteJourney: (journeyId: string) => Promise<void>;
  restoreJourney: (journeyId: string) => Promise<Journey>;
  deleteMedia: (assetId: string) => Promise<void>;
  reorderJourneyMedia: (
    journeyId: string,
    assetIds: readonly string[],
  ) => Promise<Journey>;
  moveJourneyMedia: (
    journeyId: string,
    assetIds: readonly string[],
    routePointId: string | null,
  ) => Promise<Journey>;
  undoJourneyMediaMove: (undo: JourneyMediaMoveUndo) => Promise<Journey>;
  setJourneyCover: (
    journeyId: string,
    coverMediaAssetId: string | null,
  ) => Promise<Journey>;
  uploadJourneyMedia: UploadJourneyMedia;
  /**
   * #200 phase E. Creating and revoking a share are owner writes, and the
   * owner's list of its own links is owner-private, so all three live here
   * rather than being imported by the surface that renders them. `canShareAtlas`
   * decides whether the affordance exists; this object decides whether a client
   * capable of the call exists at all, and in shared mode it is `null`.
   */
  createShare: (
    journeyIds: readonly string[],
    expiresAt: Date,
  ) => Promise<CreatedShareGrant>;
  listShares: () => Promise<ShareGrantSummary[]>;
  revokeShare: (shareId: string) => Promise<void>;
};

/**
 * The whole product mode: what may be done, and how the journeys and their
 * media are read. Owner mode and shared-link mode differ only in this value,
 * so the presentation components below it are the same code.
 */
export type AtlasView = {
  capabilities: AtlasViewCapabilities;
  listJourneys: () => Promise<Journey[]>;
  readMedia: AtlasMediaRead;
  mutations: AtlasMutations | null;
};

export function createOwnerAtlasMutations(): AtlasMutations {
  return {
    deleteJourney,
    restoreJourney,
    deleteMedia,
    reorderJourneyMedia,
    moveJourneyMedia,
    undoJourneyMediaMove,
    setJourneyCover,
    uploadJourneyMedia,
    createShare,
    listShares,
    revokeShare,
  };
}

export function createOwnerAtlasView(
  overrides: Partial<AtlasViewCapabilities> = {},
): AtlasView {
  return {
    capabilities: { ...OWNER_ATLAS_VIEW_CAPABILITIES, ...overrides },
    listJourneys: () => listJourneys(),
    readMedia: (assetId) => getPrivateMediaRead(assetId),
    mutations: createOwnerAtlasMutations(),
  };
}

const AtlasViewContext = createContext<AtlasView | null>(null);

export const AtlasViewProvider = AtlasViewContext.Provider;

let ownerAtlasViewFallback: AtlasView | null = null;

/**
 * The owner view for a tree that never provided one. Built on first use and
 * then reused, so entering shared mode — which always provides its own value —
 * never constructs an owner mutation client at all. That laziness is the
 * difference between "the guest cannot reach the writes" and "the writes were
 * never created", and it is what `resolveAtlasView` is tested for.
 */
export function defaultOwnerAtlasView(): AtlasView {
  ownerAtlasViewFallback ??= createOwnerAtlasView();
  return ownerAtlasViewFallback;
}

/**
 * #200 acceptance: the capability contract defaults to the full owner set, so
 * a surface that predates it — the `?qaState=` previews mount the story and
 * playback overlays directly — keeps behaving exactly as it did. Shared mode
 * is entered only by an explicit provider at the `/share` entry point.
 */
export function resolveAtlasView(
  provided: AtlasView | null,
  ownerFallback: () => AtlasView,
): AtlasView {
  return provided ?? ownerFallback();
}

export function useAtlasView(): AtlasView {
  return resolveAtlasView(useContext(AtlasViewContext), defaultOwnerAtlasView);
}

export function useAtlasCapabilities(): AtlasViewCapabilities {
  return useAtlasView().capabilities;
}
