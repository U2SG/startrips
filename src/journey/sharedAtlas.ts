import type { Journey, JourneyMediaAsset, PrivateMediaRead, RoutePoint } from "./types";
import type { LightEffectId } from "./lightEffects";

/** The one path that renders a shared Atlas. */
export const SHARE_VIEW_PATHNAME = "/share";

/**
 * Whether this document is the shared viewer.
 *
 * Normalized rather than compared exactly, because the static handler serves
 * the same `index.html` for `/share` and `/share/` (Caddy `try_files`, and the
 * Vite dev server's SPA fallback). An exact match would let `/share/` fall
 * through to the owner app: a signed-in owner would silently open their own
 * Atlas at a URL carrying somebody else's share token in the fragment, and
 * everybody else would meet a login gate in front of an already-authorized
 * link.
 */
export function isSharedAtlasPathname(pathname: string): boolean {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return normalized === SHARE_VIEW_PATHNAME;
}

/**
 * base64url of the 32 random bytes `server/authorization/share-access.ts`
 * generates: 43 characters, no padding. Anything else is not a token this
 * deployment ever issued, so it is refused before a request is made.
 */
export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * The guest read model, mirroring `server/repositories/shared-journey-repository.ts`.
 * Written out rather than derived so a field only reaches the browser because
 * somebody typed it here.
 */
export type SharedRoutePoint = {
  id: string;
  latitude: number;
  longitude: number;
  label: string;
  isStop: boolean;
  occurredAt: string | null;
  note: string | null;
};

export type SharedJourneyMedia = {
  id: string;
  routePointId: string | null;
  fileName: string;
  mimeType: string;
  bytes: number;
};

export type SharedJourney = {
  id: string;
  title: string;
  startedOn: string;
  endedOn: string | null;
  note: string;
  lightColor: string;
  lightEffect: string | null;
  coverMediaAssetId: string | null;
  revision: number;
  previousJourneyId: string | null;
  nextJourneyId: string | null;
  routePoints: SharedRoutePoint[];
  media: SharedJourneyMedia[];
};

export type SharedJourneyView = {
  share: { expiresAt: string; journeyCount: number };
  journeys: SharedJourney[];
};

/**
 * Read the share token from the URL fragment.
 *
 * The fragment is the point of the design amendment on #200: it is never
 * transmitted to any server, so it cannot appear in an access log, in a
 * `Referer` header, or in a link-preview bot's fetch. Anything that is not
 * exactly one opaque token is treated as no token at all, so a hand-edited
 * fragment produces the unavailable state rather than a request.
 */
export function readShareTokenFromHash(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  return SHARE_TOKEN_PATTERN.test(raw) ? raw : null;
}

/**
 * The token is read from `location.hash` exactly once per document and then
 * lives only in this closure. It is never written to the path, to a query
 * string, to `localStorage` or to `sessionStorage`, and the only place it goes
 * is the `Authorization` header of a guest request - the one header Caddy
 * already redacts.
 *
 * The fragment is deliberately left in the address bar: it is what makes a
 * reload work, and #200 accepts that a bearer link appears in browser history
 * by design. Reading it once means a later `history.pushState` - the mobile
 * surface history does one per opened sheet - can never smuggle it anywhere,
 * and a re-read can never observe a fragment some other code has changed.
 */
export function createShareTokenHolder(readHash: () => string) {
  let read = false;
  let token: string | null = null;
  return () => {
    if (!read) {
      read = true;
      token = readShareTokenFromHash(readHash());
    }
    return token;
  };
}

export const shareToken = createShareTokenHolder(
  () => globalThis.location?.hash ?? "",
);

/**
 * Why a guest request failed, in the only three shapes a viewer needs.
 *
 * The server draws this distinction deliberately and the client must not
 * collapse it: `SHARE_UNAVAILABLE` means the link itself is dead - revoked,
 * expired, or an Atlas that started deleting - and the session is over.
 * `MEDIA_UNAVAILABLE` means one asset is gone while the link still works,
 * which is what happens whenever the owner moves a photo out of a shared
 * journey, and must never tear down a live viewer. Everything else is a
 * transport problem and is retryable.
 */
export type SharedAtlasFailure = "link-unavailable" | "media-unavailable" | "network";

export class SharedAtlasError extends Error {
  readonly failure: SharedAtlasFailure;

  constructor(failure: SharedAtlasFailure, message: string) {
    super(message);
    this.name = "SharedAtlasError";
    this.failure = failure;
  }
}

export function classifySharedFailure(
  status: number,
  code: string | null,
): SharedAtlasFailure {
  if (status === 404 && code === "MEDIA_UNAVAILABLE") return "media-unavailable";
  if (status === 404) return "link-unavailable";
  return "network";
}

/**
 * How one guest request failure changes the viewer session.
 *
 * `media-unavailable` maps to `null`: the owner moved one photo out of a
 * shared journey, the link still works, and tearing down a whole session over
 * it would be the bug. Only a dead link ends the session, and a transport
 * failure stays a retry rather than being dressed up as an expiry the
 * recipient can do nothing about.
 */
export function sharedAtlasStatusForFailure(
  failure: SharedAtlasFailure,
): "unavailable" | "error" | null {
  if (failure === "link-unavailable") return "unavailable";
  if (failure === "network") return "error";
  return null;
}

export type SharedAtlasClient = {
  getJourneys: () => Promise<SharedJourneyView>;
  getMediaRead: (assetId: string) => Promise<PrivateMediaRead>;
};

type Fetcher = typeof fetch;

async function readGuestJson<T>(
  token: string,
  path: string,
  fetcher: Fetcher,
): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(path, {
      cache: "no-store",
      // No cookies: a guest is not a session, and sending an owner's cookie to
      // a guest route would make the owner's own share link resolve through a
      // different identity than every other recipient's.
      credentials: "omit",
      headers: { authorization: `Bearer ${token}` },
    });
  } catch (error) {
    throw new SharedAtlasError(
      "network",
      error instanceof Error ? error.message : "网络连接失败",
    );
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as
      | { error?: string; message?: string }
      | null;
    throw new SharedAtlasError(
      classifySharedFailure(response.status, payload?.error ?? null),
      payload?.message ?? `请求失败 (${response.status})`,
    );
  }
  return response.json() as Promise<T>;
}

/**
 * The guest data client. There is no method here that writes, and no path
 * carries the token or a journey id: the capability is the bearer header and
 * the scope is whatever grant it resolves to, so a guest has nothing to
 * enumerate.
 */
export function createSharedAtlasClient(
  token: string,
  fetcher: Fetcher = fetch,
): SharedAtlasClient {
  return {
    getJourneys: () => readGuestJson<SharedJourneyView>(
      token,
      "/api/shared/journeys",
      fetcher,
    ),
    getMediaRead: (assetId) => readGuestJson<PrivateMediaRead>(
      token,
      `/api/shared/assets/${encodeURIComponent(assetId)}/read-url`,
      fetcher,
    ),
  };
}

/**
 * Owner-only journey fields the guest payload deliberately omits. They exist
 * in the shape the presentation components already consume; filling them with
 * an empty string keeps that reuse without inventing a plausible-looking value
 * for something the guest was never told. Nothing in the viewing path reads
 * them: `atlasId`, `createdByUserId`, `storageDriver`, `storageKey` and
 * `uploadedByUserId` have no reader anywhere in `src/`, and `createdAt` is
 * read only as a tiebreak in `sortJourneysChronologically`, where every guest
 * journey ties and the payload's own grant order therefore survives the sort.
 */
const GUEST_WITHHELD = "";

/**
 * Map one shared journey into the shape the globe, timeline, story and
 * playback already render.
 *
 * `sortOrder` is assigned from array position because the guest payload has
 * none: the repository returns route points and media already ordered, and
 * browser payload order defining Route Point order is that repository's own
 * invariant.
 */
export function sharedJourneyToJourney(shared: SharedJourney): Journey {
  const routePoints: RoutePoint[] = shared.routePoints.map((point, index) => ({
    id: point.id,
    journeyId: shared.id,
    sortOrder: index,
    latitude: point.latitude,
    longitude: point.longitude,
    label: point.label,
    isStop: point.isStop,
    occurredAt: point.occurredAt,
    note: point.note,
    createdAt: GUEST_WITHHELD,
  }));
  const media: JourneyMediaAsset[] = shared.media.map((asset, index) => ({
    id: asset.id,
    journeyId: shared.id,
    routePointId: asset.routePointId,
    storageDriver: GUEST_WITHHELD,
    storageKey: GUEST_WITHHELD,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    bytes: asset.bytes,
    sortOrder: index,
    uploadedByUserId: GUEST_WITHHELD,
    createdAt: GUEST_WITHHELD,
  }));
  return {
    id: shared.id,
    atlasId: GUEST_WITHHELD,
    title: shared.title,
    startedOn: shared.startedOn,
    endedOn: shared.endedOn,
    note: shared.note,
    lightColor: shared.lightColor,
    lightEffect: (shared.lightEffect ?? null) as LightEffectId | null,
    coverMediaAssetId: shared.coverMediaAssetId,
    revision: shared.revision,
    createdByUserId: GUEST_WITHHELD,
    createdAt: GUEST_WITHHELD,
    updatedAt: GUEST_WITHHELD,
    routePoints,
    media,
  };
}

export function sharedAtlasJourneys(view: SharedJourneyView): Journey[] {
  return view.journeys.map(sharedJourneyToJourney);
}

/**
 * The scope-closure invariant, checked against the payload the browser
 * actually received rather than assumed from the server that sent it.
 *
 * `previousJourneyId` / `nextJourneyId` arrive already resolved inside the
 * granted set, with `null` at both ends, so guest navigation cannot name an
 * outside journey. This re-derives that from the array: if a neighbour
 * reference, a cover asset or a media placement pointed outside the set, the
 * viewer shows the unavailable state instead of rendering a payload whose
 * scope it cannot account for.
 */
export function sharedAtlasScopeIsClosed(view: SharedJourneyView): boolean {
  const ids = new Set(view.journeys.map((journey) => journey.id));
  if (ids.size !== view.journeys.length) return false;
  return view.journeys.every((journey, index) => {
    const previous = index > 0 ? view.journeys[index - 1].id : null;
    const next = index < view.journeys.length - 1
      ? view.journeys[index + 1].id
      : null;
    const assetIds = new Set(journey.media.map((asset) => asset.id));
    const routePointIds = new Set(journey.routePoints.map((point) => point.id));
    return journey.previousJourneyId === previous
      && journey.nextJourneyId === next
      && (journey.coverMediaAssetId === null
        || assetIds.has(journey.coverMediaAssetId))
      && journey.media.every((asset) => asset.routePointId === null
        || routePointIds.has(asset.routePointId));
  });
}
