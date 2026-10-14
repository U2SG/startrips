import type {
  AuthorizedKeepsakeJourneyContext,
  AuthorizedKeepsakeRoutePointContext,
  KeepsakePrivateRenderPlan,
} from "./keepsakePrivateRender";

export interface MemoryFilmOptions {
  fps?: 24 | 30;
  includeRoutePointNotes?: boolean;
  reducedMotion?: boolean;
}
export interface MemoryFilmCoverPin {
  derivativeId: string;
  sourceMediaAssetId: string;
  recipeId: "ink-wash-memory" | "poetic-line-memory" | "paper-collage-memory";
  recipeVersion: 1;
}
export interface MemoryFilmShot {
  sourceSceneIndex: number;
  startFrame: number;
  endFrame: number;
  openingDerivativeId: string | null;
  captionCues: Array<{ id: string; startFrame: number; endFrame: number }>;
}
/** IDs and timing only. Private bytes, notes, coordinates and URLs stay outside this manifest. */
export interface MemoryFilmManifest {
  version: 2;
  exportKind: "journey_memory_film";
  journeyId: string;
  journeyRevision: number;
  narrativeSnapshot: KeepsakePrivateRenderPlan["narrativeSnapshot"];
  privacy: { artifactVisibility: "private"; mediaResolution: "authorized-server-fetch" | "authorized-owner-fetch" };
  fps: 24 | 30;
  output: { width: number; height: number };
  reducedMotion: boolean;
  totalFrames: number;
  actualDurationMs: number;
  sourceDurationMs: number;
  cover: MemoryFilmCoverPin | null;
  shots: MemoryFilmShot[];
}
export interface PreparedMemoryFilm {
  manifest: MemoryFilmManifest;
  /** Ephemeral render memory. Do not serialize this map as a manifest or a log. */
  captions: ReadonlyMap<string, string>;
}

function snapshotKey(value: KeepsakePrivateRenderPlan["narrativeSnapshot"]): string {
  return JSON.stringify([value.routePointIds, value.visualMedia.map((item) => [item.mediaAssetId, item.routePointId])]);
}

function notePages(text: string): string[] {
  const normalized = text.trim();
  if (!normalized) return [];
  // Refuse excess input, never silently truncate someone's writing.
  if (normalized.length > 8000) throw new Error("memory_film_note_too_long");
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const chars = [...segmenter.segment(normalized)].map((item) => item.segment);
  const pages: string[] = [];
  let page: string[] = [], breaks = 0;
  for (const char of chars) {
    page.push(char);
    if (char.includes("\n")) breaks++;
    if (page.length >= 64 || breaks >= 3) { pages.push(page.join("")); page = []; breaks = 0; }
  }
  if (page.length) pages.push(page.join(""));
  return pages;
}

/** Assign every authorized Route Point note without creating a Stop or changing v1 scenes. */
function captionPagesByScene(
  plan: KeepsakePrivateRenderPlan,
  points: ReadonlyMap<string, AuthorizedKeepsakeRoutePointContext>,
): Map<number, string[]> {
  const ids = plan.narrativeSnapshot.routePointIds;
  const rank = new Map(ids.map((id, index) => [id, index]));
  if (rank.size !== ids.length) throw new Error("memory_film_duplicate_point");
  const target = new Map<string, number>();
  let intro: number | undefined, outro: number | undefined;
  // Keep existing Stop captions at arrival. A transit point's own media is
  // next best; its owner ID is preserved even when media is chapter-grouped.
  plan.scenes.forEach(({ scene }, index) => {
    if (scene.kind !== "map") return;
    if (scene.role === "intro") intro ??= index;
    if (scene.role === "outro") outro = index;
    if (scene.role === "arrival" && !target.has(scene.routePointId)) target.set(scene.routePointId, index);
  });
  plan.scenes.forEach(({ scene }, index) => {
    if (scene.kind === "media" && scene.routePointId !== null && !target.has(scene.routePointId)) {
      target.set(scene.routePointId, index);
    }
  });
  // Shape-only vias can lie INSIDE a travel span, not merely at an endpoint.
  // Use canonical Route Point order rather than guessing from coordinates.
  plan.scenes.forEach(({ scene }, index) => {
    if (scene.kind !== "map" || scene.role !== "travel") return;
    const from = rank.get(scene.fromRoutePointId), to = rank.get(scene.toRoutePointId);
    if (from === undefined || to === undefined) throw new Error("memory_film_point_missing");
    for (let at = Math.min(from, to); at <= Math.max(from, to); at++) {
      if (!target.has(ids[at])) target.set(ids[at], index);
    }
  });
  // A trailing via may have neither media nor a travel scene; an all-via,
  // text-only Journey has only overview scenes. Keep these notes on the
  // overview, never on another point's photo or a fabricated arrival.
  const overview = target.size === 0 ? intro ?? outro : outro ?? intro;
  const result = new Map<number, string[]>();
  for (const id of ids) {
    const point = points.get(id);
    if (!point) throw new Error("memory_film_point_missing");
    const pages = notePages(point.note ?? "");
    if (!pages.length) continue;
    const index = target.get(id) ?? overview;
    if (index === undefined) throw new Error("memory_film_note_scene_missing");
    const existing = result.get(index) ?? [];
    existing.push(...pages); // canonical order for notes sharing one travel/overview shot
    result.set(index, existing);
  }
  return result;
}

/**
 * Enrich the existing canonical Keepsake plan; never re-sort stops or invent a route.
 * Call only after the existing private context/media resolvers have authorized the pin.
 */
export function buildMemoryFilm(
  plan: KeepsakePrivateRenderPlan,
  context: AuthorizedKeepsakeJourneyContext,
  options: MemoryFilmOptions = {},
  cover: MemoryFilmCoverPin | null = null,
): PreparedMemoryFilm {
  const fps = options.fps ?? 30;
  if (fps !== 24 && fps !== 30) throw new Error("memory_film_fps_invalid");
  if (plan.version !== 1 || plan.scenes.length === 0 || !Number.isSafeInteger(plan.journeyRevision)
    || plan.journeyRevision < 0 || plan.journeyId !== context.journeyId
    || plan.journeyRevision !== context.journeyRevision
    || snapshotKey(plan.narrativeSnapshot) !== snapshotKey(context.narrativeSnapshot)) {
    throw new Error("memory_film_context_mismatch");
  }
  for (const value of [plan.output.width, plan.output.height]) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 4096) throw new Error("memory_film_output_invalid");
  }
  const points = new Map(context.routePoints.map((point) => [point.routePointId, point]));
  if (points.size !== context.routePoints.length) throw new Error("memory_film_duplicate_point");
  const reducedMotion = options.reducedMotion === true;
  const captions = new Map<string, string>();
  const notePagesForScene = options.includeRoutePointNotes === true ? captionPagesByScene(plan, points) : new Map<number, string[]>();
  let elapsedMs = 0;
  let expectedSourceStart = 0;
  let nextFrame = 0;
  let coverUsed = false;
  if (cover && (!cover.derivativeId.trim() || cover.recipeVersion !== 1
    || !["ink-wash-memory", "poetic-line-memory", "paper-collage-memory"].includes(cover.recipeId)
    || !plan.scenes.some(({ scene }) => scene.kind === "media"
      && scene.mediaType === "image" && scene.mediaAssetId === cover.sourceMediaAssetId))) {
    throw new Error("memory_film_cover_pin_invalid");
  }
  const shots = plan.scenes.map((entry, index): MemoryFilmShot => {
    const scene = entry.scene;
    if (entry.index !== index || entry.startMs !== expectedSourceStart
      || !Number.isSafeInteger(scene.durationMs) || scene.durationMs <= 0
      || entry.endMs !== entry.startMs + scene.durationMs) {
      throw new Error("memory_film_source_timeline_invalid");
    }
    expectedSourceStart = entry.endMs;
    const pointIds = scene.kind === "media" ? (scene.routePointId ? [scene.routePointId] : [])
      : scene.role === "arrival" ? [scene.routePointId]
        : scene.role === "travel" ? [scene.fromRoutePointId, scene.toRoutePointId] : [];
    if (pointIds.some((id) => !points.has(id))) throw new Error("memory_film_point_missing");
    const pages = notePagesForScene.get(index) ?? [];
    const pageDurations = pages.map((page) => Math.max(3000, [...page].length * 180));
    const durationMs = Math.max(scene.durationMs, pageDurations.reduce((sum, value) => sum + value, 0));
    const startFrame = nextFrame;
    elapsedMs += durationMs;
    nextFrame = Math.round(elapsedMs * fps / 1000);
    if (nextFrame <= startFrame) throw new Error("memory_film_scene_below_one_frame");
    let cueCursor = startFrame;
    let cueElapsedMs = elapsedMs - durationMs;
    const captionCues = pages.map((page, pageIndex) => {
      const id = `caption:${index}:${pageIndex}`;
      captions.set(id, page);
      cueElapsedMs += pageDurations[pageIndex];
      const endFrame = pageIndex === pages.length - 1 ? nextFrame
        : Math.round(cueElapsedMs * fps / 1000);
      const cue = { id, startFrame: cueCursor, endFrame };
      cueCursor = endFrame;
      return cue;
    });
    const isCover = !reducedMotion && !coverUsed && cover && scene.kind === "media"
      && scene.mediaType === "image" && scene.mediaAssetId === cover.sourceMediaAssetId;
    if (isCover) coverUsed = true;
    return { sourceSceneIndex: index, startFrame, endFrame: nextFrame,
      openingDerivativeId: isCover ? cover.derivativeId : null, captionCues };
  });
  if (expectedSourceStart !== plan.actualDurationMs) throw new Error("memory_film_duration_mismatch");
  return {
    manifest: {
      version: 2, exportKind: "journey_memory_film", journeyId: plan.journeyId,
      journeyRevision: plan.journeyRevision, narrativeSnapshot: {
        routePointIds: [...plan.narrativeSnapshot.routePointIds],
        visualMedia: plan.narrativeSnapshot.visualMedia.map((item) => ({
          mediaAssetId: item.mediaAssetId, routePointId: item.routePointId,
        })),
      },
      privacy: { artifactVisibility: "private", mediaResolution: "authorized-server-fetch" },
      fps, output: { ...plan.output }, reducedMotion, totalFrames: nextFrame,
      actualDurationMs: nextFrame * 1000 / fps, sourceDurationMs: plan.actualDurationMs,
      cover: coverUsed && cover ? {
        derivativeId: cover.derivativeId, sourceMediaAssetId: cover.sourceMediaAssetId,
        recipeId: cover.recipeId, recipeVersion: cover.recipeVersion,
      } : null, shots,
    },
    captions,
  };
}

export interface MemoryFilmFrame {
  frame: number;
  sourceSceneIndex: number;
  sourceProgress: number;
  openingDerivativeId: string | null;
  openingOpacity: number;
  captionId: string | null;
  reducedMotion: boolean;
}

/** Random-access deterministic sampling; no timers, accumulated deltas or whole-photo warping. */
export function sampleMemoryFilmFrame(manifest: MemoryFilmManifest, frame: number): MemoryFilmFrame {
  if (!Number.isSafeInteger(frame) || frame < 0 || frame >= manifest.totalFrames) throw new Error("memory_film_frame_out_of_range");
  let low = 0;
  let high = manifest.shots.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (frame < manifest.shots[middle].endFrame) high = middle;
    else low = middle + 1;
  }
  const shot = manifest.shots[low];
  if (!shot || frame < shot.startFrame || frame >= shot.endFrame) throw new Error("memory_film_frame_gap");
  const local = frame - shot.startFrame;
  const span = shot.endFrame - shot.startFrame;
  const progress = span === 1 ? 1 : local / (span - 1);
  // At least the final half of a cover shot is the unchanged original.
  const revealFrames = Math.max(1, Math.min(Math.round(1.2 * manifest.fps), Math.floor((span - 1) / 2)));
  const revealProgress = Math.min(1, local / revealFrames);
  const opacity = shot.openingDerivativeId && !manifest.reducedMotion && span > 1
    ? (1 + Math.cos(Math.PI * revealProgress)) / 2 : 0;
  return {
    frame, sourceSceneIndex: shot.sourceSceneIndex, sourceProgress: progress,
    openingDerivativeId: shot.openingDerivativeId,
    openingOpacity: opacity,
    captionId: shot.captionCues.find((cue) => frame >= cue.startFrame && frame < cue.endFrame)?.id ?? null,
    reducedMotion: manifest.reducedMotion,
  };
}

export interface MemoryFilmFrameRenderer {
  /** Existing private map/media renderer; this layer neither invents coordinates nor fetches URLs. */
  renderOriginalScene(sourceSceneIndex: number, progress: number, reducedMotion: boolean): void | Promise<void>;
  compositeOpening(derivativeId: string, opacity: number): void | Promise<void>;
  drawCaption(text: string): void | Promise<void>;
}

export async function renderMemoryFilmFrame(
  film: PreparedMemoryFilm, frame: number, renderer: MemoryFilmFrameRenderer,
): Promise<void> {
  const state = sampleMemoryFilmFrame(film.manifest, frame);
  await renderer.renderOriginalScene(state.sourceSceneIndex, state.sourceProgress, state.reducedMotion);
  if (state.openingDerivativeId && state.openingOpacity > 0) {
    await renderer.compositeOpening(state.openingDerivativeId, state.openingOpacity);
  }
  if (state.captionId) {
    const text = film.captions.get(state.captionId);
    if (text === undefined) throw new Error("memory_film_caption_missing");
    await renderer.drawCaption(text);
  }
}
