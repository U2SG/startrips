import type { KeepsakeRenderManifest } from "./journeyKeepsake";
import {
  buildKeepsakePrivateRenderPlan,
  resolveKeepsakePrivateJourneyContext,
  resolveKeepsakePrivateMedia,
  type AuthorizedKeepsakeJourneyContextResolver,
  type AuthorizedKeepsakeMediaResolver,
  type KeepsakePrivateRenderPlan,
} from "./keepsakePrivateRender";
import { buildMemoryFilm, type MemoryFilmCoverPin, type MemoryFilmOptions } from "./keepsakeMemoryFilm";

export interface AuthorizedMemoryFilmCover extends MemoryFilmCoverPin {
  journeyId: string;
  journeyRevision: number;
  sourceSha256: string;
  mimeType: "image/jpeg";
  bytes: Uint8Array;
}
export interface MemoryFilmPreparationDependencies {
  media: AuthorizedKeepsakeMediaResolver;
  context: AuthorizedKeepsakeJourneyContextResolver;
  /** Must authorize the CURRENT canonical cover and ready derivative in one consistency boundary. */
  resolveCover?: (pin: KeepsakePrivateRenderPlan) => Promise<AuthorizedMemoryFilmCover | null>;
}

async function digest(bytes: Uint8Array): Promise<string> {
  const result = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Reuses the existing privileged resolvers. This is not an unauthenticated export API. */
export async function preparePrivateMemoryFilm(
  manifest: KeepsakeRenderManifest,
  dependencies: MemoryFilmPreparationDependencies,
  options: MemoryFilmOptions = {},
) {
  const plan = buildKeepsakePrivateRenderPlan(manifest);
  const context = await resolveKeepsakePrivateJourneyContext(plan, dependencies.context);
  const media = await resolveKeepsakePrivateMedia(plan, dependencies.media);
  const cover = options.reducedMotion === true ? null : await dependencies.resolveCover?.(structuredClone(plan)) ?? null;
  if (cover) {
    const source = media.get(cover.sourceMediaAssetId);
    if (!source || cover.journeyId !== plan.journeyId || cover.journeyRevision !== plan.journeyRevision
      || cover.mimeType !== "image/jpeg" || !(cover.bytes instanceof Uint8Array) || cover.bytes.byteLength === 0
      || cover.sourceSha256 !== await digest(source.bytes)) {
      throw new Error("memory_film_cover_identity_mismatch");
    }
  }
  // The existing snapshot excludes text. Compare freshly authorized presentation context
  // too, so a note/label/coordinate edit during media preparation cannot mix revisions.
  const current = await resolveKeepsakePrivateJourneyContext(plan, dependencies.context);
  const presentation = (value: typeof context) => JSON.stringify(value.routePoints.map((point) => [
    point.routePointId, point.latitude, point.longitude, point.label, point.note,
  ]));
  if (presentation(context) !== presentation(current)) throw new Error("memory_film_presentation_changed");
  const coverPin: MemoryFilmCoverPin | null = cover ? {
    derivativeId: cover.derivativeId, sourceMediaAssetId: cover.sourceMediaAssetId,
    recipeId: cover.recipeId, recipeVersion: cover.recipeVersion,
  } : null;
  return {
    ...buildMemoryFilm(plan, current, options, coverPin),
    sourcePlan: plan,
    context: structuredClone(current),
    media,
    opening: cover ? { derivativeId: cover.derivativeId, mimeType: cover.mimeType, bytes: new Uint8Array(cover.bytes) } : null,
  };
}
