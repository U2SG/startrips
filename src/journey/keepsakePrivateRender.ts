import {
  keepsakeNarrativeSnapshotsEqual,
  type KeepsakeNarrativeSnapshot,
  type KeepsakeRenderManifest,
  type KeepsakeScene,
} from "./journeyKeepsake";

export interface AuthorizedKeepsakeMedia {
  mediaAssetId: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface AuthorizedKeepsakeMediaRequest {
  journeyId: string;
  journeyRevision: number;
  narrativeSnapshot: KeepsakeNarrativeSnapshot;
  mediaAssetId: string;
}

export interface AuthorizedKeepsakeMediaResolver {
  /**
   * Privileged consistency boundary. Implementations must verify that current
   * canonical Journey narrative state still matches the supplied pin and
   * authorize/materialize the requested private asset in the same consistency
   * boundary. If the canonical narrative changed, reject before reading bytes.
   */
  resolveAuthorizedMedia(request: AuthorizedKeepsakeMediaRequest): Promise<AuthorizedKeepsakeMedia>;
}

export interface AuthorizedKeepsakeRoutePointContext {
  routePointId: string;
  latitude: number;
  longitude: number;
  label: string | null;
  note: string | null;
}

export interface AuthorizedKeepsakeJourneyContext {
  journeyId: string;
  journeyRevision: number;
  narrativeSnapshot: KeepsakeNarrativeSnapshot;
  routePoints: AuthorizedKeepsakeRoutePointContext[];
}

export interface AuthorizedKeepsakeJourneyContextResolver {
  resolveAuthorizedJourneyContext(
    journeyId: string,
    journeyRevision: number,
  ): Promise<AuthorizedKeepsakeJourneyContext>;
}

export interface KeepsakePrivateRenderScene {
  index: number;
  startMs: number;
  endMs: number;
  scene: KeepsakeScene;
}

export interface KeepsakePrivateRenderPlan {
  version: 1;
  journeyId: string;
  journeyRevision: number;
  narrativeSnapshot: KeepsakeNarrativeSnapshot;
  output: { width: number; height: number };
  targetDurationMs: number;
  actualDurationMs: number;
  scenes: KeepsakePrivateRenderScene[];
  mediaAssetIds: string[];
}

/**
 * Turns the already-validated semantic Keepsake manifest into the narrow input
 * accepted by a trusted private renderer. The plan intentionally carries asset
 * identities rather than storage coordinates or share URLs. Private bytes are
 * resolved by AuthorizedKeepsakeMediaResolver; revision-pinned coordinates and
 * place presentation data are resolved separately by
 * AuthorizedKeepsakeJourneyContextResolver.
 */
export function buildKeepsakePrivateRenderPlan(
  manifest: KeepsakeRenderManifest,
): KeepsakePrivateRenderPlan {
  if (manifest.privacy.artifactVisibility !== "private") {
    throw new Error("keepsake_render_artifact_not_private");
  }
  if (manifest.privacy.mediaResolution !== "authorized-server-fetch") {
    throw new Error("keepsake_render_media_resolution_not_authorized");
  }

  let cursorMs = 0;
  const mediaAssetIds: string[] = [];
  const seenMedia = new Set<string>();
  const scenes = manifest.scenes.map((scene, index): KeepsakePrivateRenderScene => {
    if (!Number.isInteger(scene.durationMs) || scene.durationMs <= 0) {
      throw new Error("keepsake_render_scene_duration_invalid");
    }
    const startMs = cursorMs;
    cursorMs += scene.durationMs;
    if (scene.kind === "media" && !seenMedia.has(scene.mediaAssetId)) {
      seenMedia.add(scene.mediaAssetId);
      mediaAssetIds.push(scene.mediaAssetId);
    }
    return {
      index,
      startMs,
      endMs: cursorMs,
      scene: structuredClone(scene),
    };
  });

  if (cursorMs !== manifest.actualDurationMs) {
    throw new Error("keepsake_render_duration_mismatch");
  }

  return {
    version: 1,
    journeyId: manifest.journeyId,
    journeyRevision: manifest.journeyRevision,
    narrativeSnapshot: structuredClone(manifest.narrativeSnapshot),
    output: { ...manifest.output },
    targetDurationMs: manifest.targetDurationMs,
    actualDurationMs: manifest.actualDurationMs,
    scenes,
    mediaAssetIds,
  };
}

function referencedRoutePointIds(plan: KeepsakePrivateRenderPlan): Set<string> {
  const ids = new Set<string>();
  for (const { scene } of plan.scenes) {
    if (scene.kind === "media") {
      if (scene.routePointId !== null) ids.add(scene.routePointId);
      continue;
    }
    if (scene.role === "arrival") {
      ids.add(scene.routePointId);
      continue;
    }
    if (scene.role === "travel") {
      ids.add(scene.fromRoutePointId);
      ids.add(scene.toRoutePointId);
    }
  }
  return ids;
}

/**
 * Resolve revision-pinned spatial/presentation truth separately from the
 * serializable render plan. Production renderers must not infer labels or
 * coordinates from Route Point IDs or read mutable Journey state implicitly.
 */
function assertKeepsakePrivateJourneyContext(
  plan: KeepsakePrivateRenderPlan,
  context: AuthorizedKeepsakeJourneyContext,
): void {
  if (context.journeyId !== plan.journeyId) {
    throw new Error("keepsake_render_journey_identity_mismatch");
  }
  if (context.journeyRevision !== plan.journeyRevision) {
    throw new Error("keepsake_render_journey_revision_mismatch");
  }
  if (!keepsakeNarrativeSnapshotsEqual(plan.narrativeSnapshot, context.narrativeSnapshot)) {
    throw new Error("keepsake_render_journey_narrative_mismatch");
  }
  const availableRoutePointIds = new Set(context.routePoints.map((point) => point.routePointId));
  for (const routePointId of referencedRoutePointIds(plan)) {
    if (!availableRoutePointIds.has(routePointId)) {
      throw new Error("keepsake_render_route_point_context_missing");
    }
  }
}

export async function resolveKeepsakePrivateJourneyContext(
  plan: KeepsakePrivateRenderPlan,
  resolver: AuthorizedKeepsakeJourneyContextResolver,
): Promise<AuthorizedKeepsakeJourneyContext> {
  const context = await resolver.resolveAuthorizedJourneyContext(plan.journeyId, plan.journeyRevision);
  assertKeepsakePrivateJourneyContext(plan, context);
  return context;
}

/**
 * Resolve each private media asset exactly once through the privileged
 * renderer boundary. Every read carries the immutable Journey narrative pin so
 * the privileged resolver can atomically re-check canonical state before bytes
 * are materialized. A resolver may map an authorized ID to S3, local job
 * scratch storage, or another trusted source, but that coordinate never enters
 * the serializable render plan.
 */
export async function resolveKeepsakePrivateMedia(
  plan: KeepsakePrivateRenderPlan,
  resolver: AuthorizedKeepsakeMediaResolver,
): Promise<Map<string, AuthorizedKeepsakeMedia>> {
  const expectedMediaKindById = new Map<string, "image" | "video">();
  for (const { scene } of plan.scenes) {
    if (scene.kind !== "media") continue;
    const previousKind = expectedMediaKindById.get(scene.mediaAssetId);
    if (previousKind && previousKind !== scene.mediaType) {
      throw new Error("keepsake_render_media_kind_conflict");
    }
    expectedMediaKindById.set(scene.mediaAssetId, scene.mediaType);
  }

  const resolved = new Map<string, AuthorizedKeepsakeMedia>();
  for (const mediaAssetId of plan.mediaAssetIds) {
    const media = await resolver.resolveAuthorizedMedia({
      journeyId: plan.journeyId,
      journeyRevision: plan.journeyRevision,
      narrativeSnapshot: structuredClone(plan.narrativeSnapshot),
      mediaAssetId,
    });
    if (media.mediaAssetId !== mediaAssetId) {
      throw new Error("keepsake_render_media_identity_mismatch");
    }
    if (!(media.bytes instanceof Uint8Array) || media.bytes.byteLength === 0) {
      throw new Error("keepsake_render_media_empty");
    }
    const mimeType = media.mimeType.trim().toLowerCase();
    if (!mimeType) {
      throw new Error("keepsake_render_media_mime_missing");
    }
    const resolvedMediaKind = mimeType.startsWith("image/")
      ? "image"
      : mimeType.startsWith("video/")
        ? "video"
        : null;
    if (resolvedMediaKind !== expectedMediaKindById.get(mediaAssetId)) {
      throw new Error("keepsake_render_media_kind_mismatch");
    }
    resolved.set(mediaAssetId, media);
  }
  return resolved;
}
