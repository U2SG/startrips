import type { KeepsakeRenderManifest, KeepsakeScene } from "./journeyKeepsake";

export interface AuthorizedKeepsakeMedia {
  mediaAssetId: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface AuthorizedKeepsakeMediaResolver {
  resolveAuthorizedMedia(mediaAssetId: string): Promise<AuthorizedKeepsakeMedia>;
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
  output: { width: number; height: number };
  targetDurationMs: number;
  actualDurationMs: number;
  scenes: KeepsakePrivateRenderScene[];
  mediaAssetIds: string[];
}

/**
 * Turns the already-validated semantic Keepsake manifest into the narrow input
 * accepted by a trusted private renderer. The plan intentionally carries asset
 * identities rather than storage coordinates or share URLs; resolving private
 * bytes is a separate privileged step owned by AuthorizedKeepsakeMediaResolver.
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
    output: { ...manifest.output },
    targetDurationMs: manifest.targetDurationMs,
    actualDurationMs: manifest.actualDurationMs,
    scenes,
    mediaAssetIds,
  };
}

/**
 * Resolve each private media asset exactly once through the privileged
 * renderer boundary. A resolver may map an authorized ID to S3, local job
 * scratch storage, or another trusted source, but that coordinate never enters
 * the serializable render plan.
 */
export async function resolveKeepsakePrivateMedia(
  plan: KeepsakePrivateRenderPlan,
  resolver: AuthorizedKeepsakeMediaResolver,
): Promise<Map<string, AuthorizedKeepsakeMedia>> {
  const resolved = new Map<string, AuthorizedKeepsakeMedia>();
  for (const mediaAssetId of plan.mediaAssetIds) {
    const media = await resolver.resolveAuthorizedMedia(mediaAssetId);
    if (media.mediaAssetId !== mediaAssetId) {
      throw new Error("keepsake_render_media_identity_mismatch");
    }
    if (!(media.bytes instanceof Uint8Array) || media.bytes.byteLength === 0) {
      throw new Error("keepsake_render_media_empty");
    }
    if (!media.mimeType.trim()) {
      throw new Error("keepsake_render_media_mime_missing");
    }
    resolved.set(mediaAssetId, media);
  }
  return resolved;
}
