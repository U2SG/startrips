import { describe, expect, it, vi } from "vitest";
import {
  SHARE_TOKEN_PATTERN,
  SharedAtlasError,
  classifySharedFailure,
  createShareTokenHolder,
  createSharedAtlasClient,
  isSharedAtlasPathname,
  readShareTokenFromHash,
  sharedAtlasJourneys,
  sharedAtlasScopeIsClosed,
  sharedJourneyToJourney,
  type SharedJourney,
  type SharedJourneyView,
} from "./sharedAtlas";

const TOKEN = "a".repeat(43);
const OTHER_TOKEN = "b".repeat(43);

function sharedJourney(overrides: Partial<SharedJourney> = {}): SharedJourney {
  return {
    id: "journey-a",
    title: "海风经过深圳湾",
    startedOn: "2026-08-20",
    endedOn: null,
    note: "路线本身成为这一晚的记忆。",
    lightColor: "#77c8c2",
    lightEffect: null,
    coverMediaAssetId: null,
    revision: 3,
    previousJourneyId: null,
    nextJourneyId: null,
    routePoints: [{
      id: "point-a",
      latitude: 22.5,
      longitude: 114,
      label: "深圳湾",
      isStop: true,
      occurredAt: null,
      note: null,
    }],
    media: [{
      id: "asset-a",
      routePointId: "point-a",
      fileName: "sea.jpg",
      mimeType: "image/jpeg",
      bytes: 2048,
    }],
    ...overrides,
  };
}

function sharedView(journeys: SharedJourney[]): SharedJourneyView {
  return {
    share: { expiresAt: "2026-10-10T10:30:00.000Z", journeyCount: journeys.length },
    journeys,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("readShareTokenFromHash", () => {
  it("accepts one opaque token, with or without the leading hash", () => {
    expect(readShareTokenFromHash(`#${TOKEN}`)).toBe(TOKEN);
    expect(readShareTokenFromHash(TOKEN)).toBe(TOKEN);
    expect(SHARE_TOKEN_PATTERN.test(TOKEN)).toBe(true);
  });

  it("refuses anything this deployment never issued", () => {
    expect(readShareTokenFromHash("")).toBeNull();
    expect(readShareTokenFromHash("#")).toBeNull();
    expect(readShareTokenFromHash("#short")).toBeNull();
    expect(readShareTokenFromHash(`#${"a".repeat(44)}`)).toBeNull();
    // A base64url token has no padding and no slashes, so a fragment that
    // looks like a route is not a token.
    expect(readShareTokenFromHash(`#/share/${TOKEN}`)).toBeNull();
    expect(readShareTokenFromHash(`#${"a".repeat(42)}=`)).toBeNull();
  });
});

describe("isSharedAtlasPathname", () => {
  it("accepts the shared route with or without a trailing slash", () => {
    // The static handler serves one document for both, so an exact-match
    // comparison would let `/share/` fall through to the owner app.
    expect(isSharedAtlasPathname("/share")).toBe(true);
    expect(isSharedAtlasPathname("/share/")).toBe(true);
    expect(isSharedAtlasPathname("/share//")).toBe(true);
  });

  it("refuses every other path", () => {
    expect(isSharedAtlasPathname("/")).toBe(false);
    expect(isSharedAtlasPathname("/shared")).toBe(false);
    expect(isSharedAtlasPathname("/share/extra")).toBe(false);
    expect(isSharedAtlasPathname("/reset-password")).toBe(false);
  });
});

describe("createShareTokenHolder", () => {
  it("reads the fragment exactly once per document", () => {
    let hash = `#${TOKEN}`;
    const readHash = vi.fn(() => hash);
    const holder = createShareTokenHolder(readHash);

    expect(holder()).toBe(TOKEN);
    // Something else rewrote the fragment; the captured capability does not
    // follow it, and no second read of `location.hash` happens.
    hash = `#${OTHER_TOKEN}`;
    expect(holder()).toBe(TOKEN);
    expect(holder()).toBe(TOKEN);
    expect(readHash).toHaveBeenCalledTimes(1);
  });

  it("caches the absence of a token too", () => {
    let hash = "#not-a-token";
    const readHash = vi.fn(() => hash);
    const holder = createShareTokenHolder(readHash);
    expect(holder()).toBeNull();
    hash = `#${TOKEN}`;
    expect(holder()).toBeNull();
    expect(readHash).toHaveBeenCalledTimes(1);
  });
});

describe("classifySharedFailure", () => {
  it("keeps one dead asset apart from a dead link", () => {
    expect(classifySharedFailure(404, "MEDIA_UNAVAILABLE")).toBe("media-unavailable");
    expect(classifySharedFailure(404, "SHARE_UNAVAILABLE")).toBe("link-unavailable");
    // The server answers an unknown token with the same generic 404, so an
    // unrecognised code on a 404 is the link being gone.
    expect(classifySharedFailure(404, null)).toBe("link-unavailable");
  });

  it("treats everything else as retryable transport", () => {
    expect(classifySharedFailure(500, null)).toBe("network");
    expect(classifySharedFailure(429, null)).toBe("network");
    expect(classifySharedFailure(502, "MEDIA_UNAVAILABLE")).toBe("network");
  });
});

describe("createSharedAtlasClient", () => {
  it("sends the capability as a bearer header and never in a URL", async () => {
    const fetcher = vi.fn(async () => jsonResponse(sharedView([sharedJourney()])));
    const client = createSharedAtlasClient(TOKEN, fetcher as unknown as typeof fetch);
    await client.getJourneys();

    const [path, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/shared/journeys");
    expect(path).not.toContain(TOKEN);
    expect((init.headers as Record<string, string>).authorization)
      .toBe(`Bearer ${TOKEN}`);
    expect(init.credentials).toBe("omit");
    expect(init.cache).toBe("no-store");
  });

  it("asks for one asset by id, with the token still only in the header", async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      url: "https://storage.example/signed",
      expiresAt: "2026-09-05T00:01:30.000Z",
    }));
    const client = createSharedAtlasClient(TOKEN, fetcher as unknown as typeof fetch);
    const read = await client.getMediaRead("asset a/1");

    const [path, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/shared/assets/asset%20a%2F1/read-url");
    expect(path).not.toContain(TOKEN);
    expect((init.headers as Record<string, string>).authorization)
      .toBe(`Bearer ${TOKEN}`);
    expect(read.url).toBe("https://storage.example/signed");
  });

  it("reports a withdrawn asset without ending the session", async () => {
    const fetcher = vi.fn(async () => jsonResponse(
      { error: "MEDIA_UNAVAILABLE", message: "Media unavailable" },
      404,
    ));
    const client = createSharedAtlasClient(TOKEN, fetcher as unknown as typeof fetch);
    await expect(client.getMediaRead("asset-a")).rejects.toMatchObject({
      failure: "media-unavailable",
    });
  });

  it("reports a revoked or expired grant as a dead link", async () => {
    const fetcher = vi.fn(async () => jsonResponse(
      { error: "SHARE_UNAVAILABLE", message: "Share link unavailable" },
      404,
    ));
    const client = createSharedAtlasClient(TOKEN, fetcher as unknown as typeof fetch);
    await expect(client.getJourneys()).rejects.toMatchObject({
      failure: "link-unavailable",
    });
  });

  it("reports a transport failure as retryable", async () => {
    const fetcher = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    const client = createSharedAtlasClient(TOKEN, fetcher as unknown as typeof fetch);
    const error = await client.getJourneys().catch((thrown) => thrown);
    expect(error).toBeInstanceOf(SharedAtlasError);
    expect(error.failure).toBe("network");
  });
});

describe("sharedJourneyToJourney", () => {
  it("orders route points and media by payload position", () => {
    const journey = sharedJourneyToJourney(sharedJourney({
      routePoints: [
        { id: "p1", latitude: 1, longitude: 2, label: "一", isStop: true, occurredAt: null, note: null },
        { id: "p2", latitude: 3, longitude: 4, label: "二", isStop: false, occurredAt: null, note: "note" },
      ],
      media: [
        { id: "m1", routePointId: null, fileName: "a.jpg", mimeType: "image/jpeg", bytes: 1 },
        { id: "m2", routePointId: "p2", fileName: "b.mp4", mimeType: "video/mp4", bytes: 2 },
      ],
    }));

    expect(journey.routePoints.map((point) => [point.id, point.sortOrder]))
      .toEqual([["p1", 0], ["p2", 1]]);
    expect(journey.media.map((asset) => [asset.id, asset.sortOrder]))
      .toEqual([["m1", 0], ["m2", 1]]);
    expect(journey.routePoints[1].note).toBe("note");
    expect(journey.media[1].routePointId).toBe("p2");
  });

  it("withholds every owner-only field instead of inventing one", () => {
    const journey = sharedJourneyToJourney(sharedJourney());
    expect(journey.atlasId).toBe("");
    expect(journey.createdByUserId).toBe("");
    expect(journey.createdAt).toBe("");
    expect(journey.updatedAt).toBe("");
    // A private storage key must never reach the browser (#200).
    expect(journey.media[0].storageKey).toBe("");
    expect(journey.media[0].storageDriver).toBe("");
    expect(journey.media[0].uploadedByUserId).toBe("");
    // Content the recipient is looking at does come through.
    expect(journey.title).toBe("海风经过深圳湾");
    expect(journey.revision).toBe(3);
  });

  it("maps a whole view in the payload's own order", () => {
    const journeys = sharedAtlasJourneys(sharedView([
      sharedJourney({ id: "a", nextJourneyId: "b" }),
      sharedJourney({ id: "b", previousJourneyId: "a" }),
    ]));
    expect(journeys.map((journey) => journey.id)).toEqual(["a", "b"]);
  });
});

describe("sharedAtlasScopeIsClosed", () => {
  it("accepts a payload whose neighbours all resolve inside the set", () => {
    expect(sharedAtlasScopeIsClosed(sharedView([
      sharedJourney({ id: "a", nextJourneyId: "b" }),
      sharedJourney({ id: "b", previousJourneyId: "a", nextJourneyId: "c" }),
      sharedJourney({ id: "c", previousJourneyId: "b" }),
    ]))).toBe(true);
  });

  it("accepts a single shared journey with no neighbour at all", () => {
    expect(sharedAtlasScopeIsClosed(sharedView([sharedJourney()]))).toBe(true);
  });

  it("rejects a neighbour reference that names a journey outside the set", () => {
    expect(sharedAtlasScopeIsClosed(sharedView([
      sharedJourney({ id: "a", nextJourneyId: "unshared" }),
    ]))).toBe(false);
    expect(sharedAtlasScopeIsClosed(sharedView([
      sharedJourney({ id: "a", previousJourneyId: "unshared" }),
    ]))).toBe(false);
  });

  it("rejects a cover asset or media placement outside the journey", () => {
    expect(sharedAtlasScopeIsClosed(sharedView([
      sharedJourney({ coverMediaAssetId: "asset-from-another-journey" }),
    ]))).toBe(false);
    expect(sharedAtlasScopeIsClosed(sharedView([
      sharedJourney({
        media: [{
          id: "asset-a",
          routePointId: "point-outside",
          fileName: "sea.jpg",
          mimeType: "image/jpeg",
          bytes: 1,
        }],
      }),
    ]))).toBe(false);
  });

  it("rejects a duplicated journey id", () => {
    expect(sharedAtlasScopeIsClosed(sharedView([
      sharedJourney({ id: "a", nextJourneyId: "a" }),
      sharedJourney({ id: "a", previousJourneyId: "a" }),
    ]))).toBe(false);
  });

  it("accepts an emptied grant, which is a product state and not a scope break", () => {
    expect(sharedAtlasScopeIsClosed(sharedView([]))).toBe(true);
  });
});
