import { describe, expect, it, vi } from "vitest";
import { buildKeepsakeRenderManifest } from "./journeyKeepsake";
import {
  buildKeepsakePrivateRenderPlan,
  resolveKeepsakePrivateJourneyContext,
  resolveKeepsakePrivateMedia,
  type AuthorizedKeepsakeMediaResolver,
} from "./keepsakePrivateRender";
import type { Journey, JourneyMediaAsset, RoutePoint } from "./types";

function point(id: string, sortOrder: number, longitude: number): RoutePoint {
  return {
    id,
    journeyId: "journey-private-render",
    sortOrder,
    latitude: 22 + sortOrder * 2,
    longitude,
    label: ["Hong Kong", "Taipei", "Tokyo"][sortOrder] ?? `Stop ${sortOrder + 1}`,
    isStop: true,
    occurredAt: `2026-08-${String(10 + sortOrder).padStart(2, "0")}T08:00:00.000Z`,
    note: null,
    createdAt: "2026-08-10T00:00:00.000Z",
  };
}

function media(id: string, routePointId: string | null, sortOrder: number): JourneyMediaAsset {
  return {
    id,
    journeyId: "journey-private-render",
    routePointId,
    storageDriver: "s3",
    storageKey: `private/${id}`,
    fileName: `${id}.jpg`,
    mimeType: "image/jpeg",
    bytes: 1024,
    sortOrder,
    uploadedByUserId: "user-1",
    createdAt: "2026-08-10T00:00:00.000Z",
  };
}

const journey: Journey = {
  id: "journey-private-render",
  atlasId: "atlas-1",
  title: "Three quiet stops",
  startedOn: "2026-08-10",
  endedOn: "2026-08-12",
  note: "",
  lightColor: "#f4ce73",
  revision: 2,
  createdByUserId: "user-1",
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
  routePoints: [point("p0", 0, 114), point("p1", 1, 121), point("p2", 2, 139)],
  media: [
    media("opening", null, 0),
    media("p0-photo", "p0", 0),
    media("p1-photo", "p1", 0),
    media("p2-photo", "p2", 0),
  ],
};

describe("private Keepsake render boundary (#87)", () => {
  it("preserves semantic scene order and exact manifest timing without storage coordinates", () => {
    const manifest = buildKeepsakeRenderManifest(journey, 15);
    const plan = buildKeepsakePrivateRenderPlan(manifest);

    expect(plan.scenes[0]?.startMs).toBe(0);
    expect(plan.scenes.at(-1)?.endMs).toBe(manifest.actualDurationMs);
    expect(plan.scenes.every((entry, index) => (
      index === 0 || entry.startMs === plan.scenes[index - 1]?.endMs
    ))).toBe(true);
    expect(plan.scenes.map((entry) => entry.scene)).toEqual(manifest.scenes);
    expect(plan.mediaAssetIds).toEqual(["opening", "p0-photo", "p1-photo", "p2-photo"]);

    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain("storageKey");
    expect(serialized).not.toContain("private/opening");
    expect(serialized).not.toContain("http://");
    expect(serialized).not.toContain("https://");
  });

  it("requires revision-pinned authorized spatial context for every referenced Route Point", async () => {
    const plan = buildKeepsakePrivateRenderPlan(buildKeepsakeRenderManifest(journey, 15));
    const resolveAuthorizedJourneyContext = vi.fn(async (journeyId: string, journeyRevision: number) => ({
      journeyId,
      journeyRevision,
      routePoints: journey.routePoints.map((routePoint) => ({
        routePointId: routePoint.id,
        latitude: routePoint.latitude,
        longitude: routePoint.longitude,
        label: routePoint.label ?? null,
        note: routePoint.note ?? null,
      })),
    }));

    const context = await resolveKeepsakePrivateJourneyContext(plan, { resolveAuthorizedJourneyContext });

    expect(resolveAuthorizedJourneyContext).toHaveBeenCalledWith(plan.journeyId, plan.journeyRevision);
    expect(context.routePoints.map((routePoint) => routePoint.routePointId)).toEqual(["p0", "p1", "p2"]);

    await expect(resolveKeepsakePrivateJourneyContext(plan, {
      resolveAuthorizedJourneyContext: async () => ({
        ...context,
        journeyId: "wrong-journey",
      }),
    })).rejects.toThrow("keepsake_render_journey_identity_mismatch");
    await expect(resolveKeepsakePrivateJourneyContext(plan, {
      resolveAuthorizedJourneyContext: async () => ({
        ...context,
        journeyRevision: plan.journeyRevision + 1,
      }),
    })).rejects.toThrow("keepsake_render_journey_revision_mismatch");

    await expect(resolveKeepsakePrivateJourneyContext(plan, {
      resolveAuthorizedJourneyContext: async () => ({
        ...context,
        routePoints: context.routePoints.filter((routePoint) => routePoint.routePointId !== "p1"),
      }),
    })).rejects.toThrow("keepsake_render_route_point_context_missing");
  });
  it("lets only the authorized resolver materialize private bytes, once per asset", async () => {
    const plan = buildKeepsakePrivateRenderPlan(buildKeepsakeRenderManifest(journey, 15));
    const resolveAuthorizedMedia = vi.fn(async (mediaAssetId: string) => ({
      mediaAssetId,
      mimeType: "image/x-portable-pixmap",
      bytes: new Uint8Array([mediaAssetId.length, 7, 19]),
    }));
    const resolver: AuthorizedKeepsakeMediaResolver = { resolveAuthorizedMedia };

    const resolved = await resolveKeepsakePrivateMedia(plan, resolver);

    expect(resolveAuthorizedMedia.mock.calls.map(([id]) => id)).toEqual(plan.mediaAssetIds);
    expect(resolved.size).toBe(plan.mediaAssetIds.length);
    expect([...resolved.keys()]).toEqual(plan.mediaAssetIds);
  });

  it("fails closed when the privileged resolver returns the wrong identity or empty bytes", async () => {
    const plan = buildKeepsakePrivateRenderPlan(buildKeepsakeRenderManifest(journey, 15));
    await expect(resolveKeepsakePrivateMedia(plan, {
      resolveAuthorizedMedia: async () => ({
        mediaAssetId: "wrong-id",
        mimeType: "image/jpeg",
        bytes: new Uint8Array([1]),
      }),
    })).rejects.toThrow("keepsake_render_media_identity_mismatch");

    await expect(resolveKeepsakePrivateMedia(plan, {
      resolveAuthorizedMedia: async (mediaAssetId) => ({
        mediaAssetId,
        mimeType: "image/jpeg",
        bytes: new Uint8Array(),
      }),
    })).rejects.toThrow("keepsake_render_media_empty");
    await expect(resolveKeepsakePrivateMedia(plan, {
      resolveAuthorizedMedia: async (mediaAssetId) => ({
        mediaAssetId,
        mimeType: "video/mp4",
        bytes: new Uint8Array([1]),
      }),
    })).rejects.toThrow("keepsake_render_media_kind_mismatch");
  });
});
