import { creativeCoverRecipeForGeneration } from "../reveal/creativeCoverRecipes";
import { getJourney, getPrivateMediaRead, JourneyApiError, readCoverRevealDisplay } from "./journeyApi";
import { journeyCover } from "./journeyModel";
import { buildKeepsakeRenderManifest, type KeepsakeAspect, type KeepsakeDurationPreset } from "./journeyKeepsake";
import { buildKeepsakePrivateRenderPlan, type AuthorizedKeepsakeJourneyContext } from "./keepsakePrivateRender";
import { buildMemoryFilm, type MemoryFilmCoverPin, type PreparedMemoryFilm } from "./keepsakeMemoryFilm";
import { planCoverRevealOpening, type CoverRevealDisplayPayload } from "./coverRevealOpening";
import type { Journey, JourneyMediaAsset } from "./types";

export const FILM_MAX_BYTES = 256 * 1024 * 1024;
export const FILM_MAX_ASSET_BYTES = 128 * 1024 * 1024;
export const FILM_MAX_DURATION_MS = 120_000;
export type JourneyFilmProgress = { phase: "preparing" | "rendering" | "validating"; completed: number; total: number };
export type JourneyFilmExportOptions = {
  presetSeconds: KeepsakeDurationPreset;
  aspect: KeepsakeAspect;
  includeRoutePointNotes: boolean;
  includeCover: boolean;
  reducedMotion: boolean;
  signal: AbortSignal;
  onProgress: (progress: JourneyFilmProgress) => void;
};
export type JourneyFilmArtifact = {
  blob: Blob;
  filename: string;
  durationMs: number;
  /** Re-authorize immediately before a later explicit download, not just on render completion. */
  verify: (signal: AbortSignal) => Promise<void>;
};
export type JourneyFilmExporter = (journeyId: string, options: JourneyFilmExportOptions) => Promise<JourneyFilmArtifact>;
export type JourneyFilmEncoderInput = {
  journey: Journey;
  film: PreparedMemoryFilm;
  sourcePlan: ReturnType<typeof buildKeepsakePrivateRenderPlan>;
  readMedia: (asset: JourneyMediaAsset) => Promise<Blob>;
  readOpening: (() => Promise<Blob>) | null;
  signal: AbortSignal;
  onFrame: (completed: number) => void;
};
export type JourneyFilmEncoder = (input: JourneyFilmEncoderInput) => Promise<Blob>;

/** Compare all rendered facts, including edits that do not bump Journey.revision. */
export function journeyFilmIdentity(journey: Journey): string {
  return JSON.stringify([
    journey.id, journey.atlasId, journey.revision, journey.title, journey.startedOn, journey.endedOn,
    journey.coverMediaAssetId ?? null,
    journey.routePoints.map((p) => [p.id, p.latitude, p.longitude, p.label, p.note ?? null, p.isStop, p.sortOrder, p.regionContext ?? null, p.stayAnchorRoutePointId ?? null]),
    journey.routeSegments ?? [],
    journey.media.map((a) => [a.id, a.routePointId, a.mimeType, a.bytes, a.sortOrder, a.contentHash ?? null, a.contentHashVerified === true]),
  ]);
}

export function journeyFilmFilename(title: string): string {
  const safe = title.normalize("NFC").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").slice(0, 80);
  return `Startrips-${safe || "Journey"}.mp4`;
}

export function journeyFilmErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "已取消导出。";
  if (error instanceof DOMException && error.name === "TimeoutError") return "导出超时，请缩短旅程后重试。";
  if (error instanceof JourneyApiError && (error.status === 401 || error.status === 403)) return "登录或访问权限已变化，请重新登录后再导出。";
  const code = error instanceof Error ? error.message : "";
  if (code === "journey_film_busy") return "上一段短片仍在生成或清理，请稍后重试。";
  if (code === "journey_film_changed") return "旅程内容已变化，请关闭此窗口后重新导出。";
  if (code === "journey_film_codec_unavailable") return "此浏览器无法编码 MP4，请使用支持 H.264 视频编码的浏览器。";
  if (code === "journey_film_source_limit") return "素材超过本地导出上限：单个 128 MB、合计 256 MB。请减少素材后重试。";
  if (code === "journey_film_duration_limit") return "内容或字幕需要超过两分钟，请减少素材或关闭字幕后重试。";
  if (code === "journey_film_reveal_unavailable") return "此浏览器无法渲染艺术开场，请关闭艺术封面选项后重试。";
  if (code === "journey_film_text_layout_limit") return "文字过长，无法在画面内完整呈现，请缩短标题或关闭感想字幕后重试。";
  if (code === "journey_film_video_unsupported") return "有视频无法在此浏览器中解码，未生成不完整的短片。";
  if (code === "journey_film_source_changed") return "原片校验失败，未生成短片。请刷新旅程后重试。";
  return "未能完成导出。请检查网络和素材是否可读取，然后重试。";
}

export async function readBoundedFilmBlob(response: Response, maxBytes: number, signal: AbortSignal): Promise<Blob> {
  if (!response.ok || !response.body) throw new Error("journey_film_source_unreadable");
  const declared = Number(response.headers.get("content-length"));
  if (declared > maxBytes) { await response.body.cancel(); throw new Error("journey_film_source_limit"); }
  const reader = response.body.getReader();
  const parts: ArrayBuffer[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("journey_film_source_limit");
      parts.push(new Uint8Array(value).buffer);
    }
    signal.throwIfAborted();
    if (!size) throw new Error("journey_film_source_unreadable");
    return new Blob(parts, { type: response.headers.get("content-type") ?? "application/octet-stream" });
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function blobHash(blob: Blob): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

// One memory-intensive encoder per page, owned outside any dialog mount.
// Unmount aborts a run, but only its fully settled exporter releases this slot.
let activeJourneyFilmRun: symbol | null = null;

/** Owner browser export. Server-authorized signed reads, no guest fallback and no upload/queue. */
export async function exportPrivateJourneyFilm(
  journeyId: string,
  options: JourneyFilmExportOptions,
  dependencies: { fetcher?: typeof fetch; encode?: JourneyFilmEncoder } = {},
): Promise<JourneyFilmArtifact> {
  options.signal.throwIfAborted();
  if (activeJourneyFilmRun !== null) throw new Error("journey_film_busy");
  const owner = Symbol("journey-film-run");
  activeJourneyFilmRun = owner;
  try { return await renderAuthorizedJourneyFilm(journeyId, options, dependencies); }
  finally { if (activeJourneyFilmRun === owner) activeJourneyFilmRun = null; }
}

async function renderAuthorizedJourneyFilm(
  journeyId: string,
  options: JourneyFilmExportOptions,
  dependencies: { fetcher?: typeof fetch; encode?: JourneyFilmEncoder },
): Promise<JourneyFilmArtifact> {
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(300_000)]);
  signal.throwIfAborted();
  if (![15, 30, 60].includes(options.presetSeconds) || !["portrait", "landscape"].includes(options.aspect)) throw new Error("journey_film_options_invalid");
  const fetcher = dependencies.fetcher ?? fetch;
  const scopedFetch: typeof fetch = (input, init) => fetcher(input, { ...init, signal });
  options.onProgress({ phase: "preparing", completed: 0, total: 1 });
  const journey = await getJourney(journeyId, signal, scopedFetch);
  if (journey.id !== journeyId) throw new Error("journey_film_changed");
  const identity = journeyFilmIdentity(journey);
  const sourcePlan = buildKeepsakePrivateRenderPlan(buildKeepsakeRenderManifest(journey, options.presetSeconds, options.aspect));
  const assets = new Map(journey.media.map((asset) => [asset.id, asset]));
  let total = 0;
  for (const id of sourcePlan.mediaAssetIds) {
    const asset = assets.get(id);
    if (!asset || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || asset.bytes > FILM_MAX_ASSET_BYTES) throw new Error("journey_film_source_limit");
    total += asset.bytes;
  }
  if (total > FILM_MAX_BYTES) throw new Error("journey_film_source_limit");
  const context: AuthorizedKeepsakeJourneyContext = {
    journeyId: journey.id, journeyRevision: journey.revision, narrativeSnapshot: sourcePlan.narrativeSnapshot,
    routePoints: journey.routePoints.map((p) => ({ routePointId: p.id, latitude: p.latitude, longitude: p.longitude, label: p.label, note: p.note ?? null })),
  };
  const cover = journeyCover(journey);
  let openingPayload: CoverRevealDisplayPayload | null = null;
  let coverPin: MemoryFilmCoverPin | null = null;
  if (options.includeCover && !options.reducedMotion && cover && sourcePlan.mediaAssetIds.includes(cover.id)) {
    openingPayload = await readCoverRevealDisplay(journey.id, scopedFetch);
    const decision = planCoverRevealOpening({ journeyId, cover, payload: openingPayload, played: new Set(), reducedMotion: false, supersededByIntent: false });
    const metadata = openingPayload.derivative;
    const recipe = creativeCoverRecipeForGeneration(metadata?.generationKind, metadata?.generationVersion);
    if (decision.kind === "open" && metadata && recipe) {
      coverPin = { derivativeId: metadata.id, sourceMediaAssetId: cover.id, recipeId: recipe.id, recipeVersion: 1 };
    }
  }
  const film = buildMemoryFilm(sourcePlan, context, {
    includeRoutePointNotes: options.includeRoutePointNotes, reducedMotion: options.reducedMotion,
  }, coverPin);
  // This client is not the privileged server resolver. Keep the actual read boundary truthful.
  film.manifest.privacy.mediaResolution = "authorized-owner-fetch";
  if (film.manifest.actualDurationMs > FILM_MAX_DURATION_MS) throw new Error("journey_film_duration_limit");
  let transferred = 0;
  const readUrl = async (url: string, maxBytes: number) => {
    signal.throwIfAborted();
    const parsed = new URL(url, globalThis.location?.origin ?? "http://localhost");
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("journey_film_source_unreadable");
    const readSignal = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
    const response = await fetcher(parsed.href, { signal: readSignal, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
    const blob = await readBoundedFilmBlob(response, Math.min(maxBytes, FILM_MAX_BYTES - transferred), readSignal);
    transferred += blob.size;
    return blob;
  };
  const mediaCache = new Map<string, Promise<Blob>>();
  const readMediaBytes = async (asset: JourneyMediaAsset): Promise<Blob> => {
    if (assets.get(asset.id) !== asset) throw new Error("journey_film_source_changed");
    const read = await getPrivateMediaRead(asset.id, scopedFetch);
    if (!(Date.parse(read.expiresAt) > Date.now())) throw new Error("journey_film_source_unreadable");
    const bytes = await readUrl(read.url, FILM_MAX_ASSET_BYTES);
    if (bytes.size !== asset.bytes || (asset.contentHashVerified === true && asset.contentHash !== await blobHash(bytes))) throw new Error("journey_film_source_changed");
    return new Blob([bytes], { type: asset.mimeType });
  };
  const readMedia = (asset: JourneyMediaAsset): Promise<Blob> => {
    if (assets.get(asset.id) !== asset) return Promise.reject(new Error("journey_film_source_changed"));
    let pending = mediaCache.get(asset.id);
    if (!pending) { pending = readMediaBytes(asset); mediaCache.set(asset.id, pending); }
    return pending;
  };
  const openingIdentity = (payload: CoverRevealDisplayPayload | null) => {
    const d = payload?.derivative;
    return d ? JSON.stringify([d.id, d.journeyId, d.sourceMediaAssetId, d.sourceContentHash, d.generationKind, d.generationVersion, d.presetId, d.mimeType, d.width, d.height]) : null;
  };
  const pinnedOpening = openingIdentity(openingPayload);
  const verify = async (downloadSignal: AbortSignal) => {
    downloadSignal.throwIfAborted();
    const checkFetch: typeof fetch = (input, init) => fetcher(input, { ...init, signal: downloadSignal, cache: "no-store" });
    const current = await getJourney(journeyId, downloadSignal, checkFetch);
    if (journeyFilmIdentity(current) !== identity) throw new Error("journey_film_changed");
    if (coverPin) {
      const currentCover = await readCoverRevealDisplay(journeyId, checkFetch);
      if (openingIdentity(currentCover) !== pinnedOpening) throw new Error("journey_film_changed");
    }
    downloadSignal.throwIfAborted();
  };
  const encode = dependencies.encode ?? (await import("./journeyFilmCanvas")).encodeJourneyFilm;
  let blob: Blob;
  try {
    blob = await encode({
    journey, sourcePlan, film, signal, readMedia,
    readOpening: coverPin && openingPayload?.display ? async () => {
      // Re-sign immediately before decoding. Slow preparation must not reuse an expired URL.
      const current = await readCoverRevealDisplay(journeyId, scopedFetch);
      if (openingIdentity(current) !== pinnedOpening) throw new Error("journey_film_changed");
      if (!current.display || !(Date.parse(current.display.expiresAt) > Date.now())) throw new Error("journey_film_source_unreadable");
      return readUrl(current.display.url, 16 * 1024 * 1024);
    } : null,
    onFrame: (completed) => options.onProgress({ phase: "rendering", completed, total: film.manifest.totalFrames }),
  });
  } finally { mediaCache.clear(); }
  signal.throwIfAborted();
  if (journeyFilmIdentity(journey) !== identity) throw new Error("journey_film_changed");
  if (blob.type !== "video/mp4" || blob.size === 0) throw new Error("journey_film_output_invalid");
  options.onProgress({ phase: "validating", completed: 0, total: 1 });
  await verify(signal);
  return { blob, filename: journeyFilmFilename(journey.title), durationMs: film.manifest.actualDurationMs, verify };
}
