import { creativeCoverRecipeForGeneration } from "../reveal/creativeCoverRecipes";
import { getJourney, getPrivateMediaRead, JourneyApiError, readCoverRevealDisplay } from "./journeyApi";
import { journeyCover, journeySoundtrack } from "./journeyModel";
import { buildKeepsakeRenderManifest, type KeepsakeAspect, type KeepsakeDurationPreset } from "./journeyKeepsake";
import { buildKeepsakePrivateRenderPlan, type AuthorizedKeepsakeJourneyContext } from "./keepsakePrivateRender";
import { buildMemoryFilm, type MemoryFilmCoverPin, type PreparedMemoryFilm } from "./keepsakeMemoryFilm";
import { planCoverRevealOpening, type CoverRevealDisplayPayload } from "./coverRevealOpening";
import type { Journey, JourneyMediaAsset } from "./types";
import { createJourneyFilmWatchdog } from "./journeyFilmWatchdog";
import { estimateJourneyFilmOutputBytes } from "./journeyFilmBudget";

export const FILM_MAX_BYTES = 256 * 1024 * 1024;
export const FILM_MAX_ASSET_BYTES = 128 * 1024 * 1024;
export type JourneyFilmProgress = { phase: "preparing" | "rendering" | "finalizing" | "validating"; completed: number; total: number };
export type JourneyFilmPlanSummary = { durationMs: number; estimatedOutputBytes: number; soundtrackIncluded: boolean };
export type JourneyFilmExportOptions = {
  presetSeconds: KeepsakeDurationPreset;
  aspect: KeepsakeAspect;
  includeRoutePointNotes: boolean;
  includeCover: boolean;
  /** Include the Journey's existing owner-uploaded soundtrack unless explicitly disabled. */
  includeSoundtrack?: boolean;
  reducedMotion: boolean;
  signal: AbortSignal;
  onProgress: (progress: JourneyFilmProgress) => void;
  onPlan?: (plan: JourneyFilmPlanSummary) => void;
};
export type JourneyFilmArtifact = {
  blob: Blob;
  filename: string;
  durationMs: number;
  soundtrackIncluded?: boolean;
  storageMode?: "disk" | "memory";
  dispose?: () => Promise<void>;
  retainForDownload?: () => Promise<void>;
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
  readSoundtrack: (() => Promise<Blob>) | null;
  signal: AbortSignal;
  onFrame: (completed: number) => void;
  onFinalize?: () => void;
  onWrite?: (writtenBytes: number) => void;
};
export type JourneyFilmEncoded = { blob: Blob; storageMode: "disk" | "memory"; dispose: () => Promise<void>; retainForDownload?: () => Promise<void> };
export type JourneyFilmEncoder = (input: JourneyFilmEncoderInput) => Promise<Blob | JourneyFilmEncoded>;
class JourneyFilmCleanupError extends Error {
  constructor(readonly originalError: unknown) { super("journey_film_cleanup_failed", { cause: originalError }); }
}

/** Compare all rendered facts, including edits that do not bump Journey.revision. */
export function journeyFilmIdentity(journey: Journey): string {
  return JSON.stringify([
    journey.id, journey.atlasId, journey.revision, journey.title, journey.startedOn, journey.endedOn,
    journey.coverMediaAssetId ?? null,
    journey.routePoints.map((p) => [p.id, p.latitude, p.longitude, p.label, p.note ?? null, p.isStop, p.sortOrder, p.regionContext ?? null, p.stayAnchorRoutePointId ?? null]),
    journey.routeSegments ?? [],
    journey.media.map((a) => [a.id, a.journeyId, a.routePointId, a.mimeType, a.bytes, a.sortOrder, a.contentHash ?? null, a.contentHashVerified === true]),
  ]);
}

export function journeyFilmFilename(title: string): string {
  // Keep the control-code bound separate from punctuation: ordinary letters,
  // hyphens, @ and ^ must never become part of a character-class range.
  const forbidden = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*']);
  const sanitized = Array.from(title.normalize("NFC"), (character) => {
    const code = character.charCodeAt(0);
    const loneSurrogate = character.length === 1 && code >= 0xd800 && code <= 0xdfff;
    return code < 32 || loneSurrogate || forbidden.has(character) ? "_" : character;
  }).join("");
  // NFC can expand even an originally valid 80-unit title. Keep the same
  // UTF-16 budget, but never split an emoji, combining sequence or ZWJ family.
  let safe = "";
  const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const { segment } of graphemes.segment(sanitized)) {
    if (safe.length + segment.length > 80) break;
    safe += segment;
  }
  safe = safe.replace(/[. ]+$/g, "");
  return `Startrips-${safe || "Journey"}.mp4`;
}

export function journeyFilmErrorMessage(error: unknown): string {
  if (error instanceof JourneyFilmCleanupError) return `${journeyFilmErrorMessage(error.originalError)} 临时文件清理未完成，请稍后重试清理。`;
  if (error instanceof DOMException && error.name === "AbortError") return "已取消导出。";
  if (error instanceof DOMException && error.name === "TimeoutError") return "导出长时间没有进展，已停止。请检查网络或设备状态后重试。";
  if (error instanceof DOMException && error.name === "QuotaExceededError") return "设备可用存储空间不足，请释放空间后重试。未生成不完整的视频。";
  if (error instanceof JourneyApiError && (error.status === 401 || error.status === 403)) return "登录或访问权限已变化，请重新登录后再导出。";
  const code = error instanceof Error ? error.message : "";
  const limits = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const bytes = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const capacity = bytes(limits.requiredBytes) && bytes(limits.availableBytes)
    ? `所需约 ${Math.ceil(limits.requiredBytes / 1024 / 1024)} MiB，当前可用导出预算 ${Math.floor(limits.availableBytes / 1024 / 1024)} MiB。` : "";
  if (code === "journey_film_busy") return "上一段短片仍在生成或清理，请稍后重试。";
  if (code === "journey_film_changed") return "旅程内容已变化，请关闭此窗口后重新导出。";
  if (code === "journey_film_codec_unavailable") return "此浏览器无法编码 MP4，请使用支持 H.264 视频编码的浏览器。";
  if (code === "journey_film_source_limit") return "素材超过本地导出上限：单个 128 MB、合计 256 MB。请减少素材后重试。";
  if (code === "journey_film_output_limit") return `预计成片或实际文件超过本地导出空间预算（最多 512 MiB）。${capacity}请释放空间或选择内容较少的旅程；不会自动删减或拆分。`;
  if (code === "journey_film_storage_unavailable") return `此浏览器无法为完整视频准备临时存储，内存导出最多 96 MiB。${capacity}请使用较新的浏览器并检查设备空间；不会自动删减或拆分。`;
  if (code === "journey_film_downloads_pending") {
    const count = bytes(limits.exportCount) && bytes(limits.exportLimit) && limits.exportCount >= limits.exportLimit
      ? `临时文件已达 ${limits.exportLimit} 份上限。` : "";
    return `导出临时存储已满。${count}${capacity}请确认之前的下载全部完成后清理临时文件，或等待其他导出结束再重试。`;
  }
  if (code === "journey_film_reveal_unavailable") return "此浏览器无法渲染艺术开场，请关闭艺术封面选项后重试。";
  if (code === "memory_film_note_too_long") return "单条感想超过字幕长度上限，请缩短感想或关闭感想字幕后重试。";
  if (code === "journey_film_text_layout_limit") return "文字过长，无法在画面内完整呈现，请缩短标题或关闭感想字幕后重试。";
  if (code === "journey_film_video_unsupported") return "有视频无法在此浏览器中解码，未生成不完整的短片。";
  if (code === "journey_film_soundtrack_unsupported") return "旅程配乐无法解码，未生成静音替代片。请更换配乐后重试，或明确关闭配乐选项。";
  if (code === "journey_film_audio_codec_unavailable") return "此浏览器无法编码配乐，未生成静音替代片。请换用支持音频编码的浏览器。";
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
  const watchdog = createJourneyFilmWatchdog(options.signal);
  try { return await renderAuthorizedJourneyFilm(journeyId, { ...options, signal: watchdog.signal,
    onProgress: (next) => { watchdog.progress(next.phase, next.completed); options.onProgress(next); },
  }, dependencies, watchdog.progress); }
  finally { watchdog.dispose(); if (activeJourneyFilmRun === owner) activeJourneyFilmRun = null; }
}

async function renderAuthorizedJourneyFilm(
  journeyId: string,
  options: JourneyFilmExportOptions,
  dependencies: { fetcher?: typeof fetch; encode?: JourneyFilmEncoder },
  activity: (phase: string, completed: number) => void,
): Promise<JourneyFilmArtifact> {
  const signal = options.signal;
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
  const soundtrack = options.includeSoundtrack !== false ? journeySoundtrack(journey) : null;
  if (soundtrack && (soundtrack.journeyId !== journey.id || soundtrack.routePointId !== null)) throw new Error("journey_film_source_changed");
  const sourceIds = new Set(sourcePlan.mediaAssetIds);
  if (soundtrack) sourceIds.add(soundtrack.id);
  let total = 0;
  for (const id of sourceIds) {
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
  options.onPlan?.({ durationMs: film.manifest.actualDurationMs,
    estimatedOutputBytes: estimateJourneyFilmOutputBytes(film.manifest.actualDurationMs, soundtrack !== null),
    soundtrackIncluded: soundtrack !== null });
  let transferred = 0;
  const readUrl = async (url: string, maxBytes: number) => {
    signal.throwIfAborted();
    const parsed = new URL(url, globalThis.location?.origin ?? "http://localhost");
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("journey_film_source_unreadable");
    const readSignal = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
    const response = await fetcher(parsed.href, { signal: readSignal, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
    const blob = await readBoundedFilmBlob(response, Math.min(maxBytes, FILM_MAX_BYTES - transferred), readSignal);
    transferred += blob.size;
    activity("source-read", transferred);
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
  let encoded: Blob | JourneyFilmEncoded;
  try {
    encoded = await encode({
    journey, sourcePlan, film, signal, readMedia,
    readSoundtrack: soundtrack ? () => readMedia(soundtrack) : null,
    readOpening: coverPin && openingPayload?.display ? async () => {
      // Re-sign immediately before decoding. Slow preparation must not reuse an expired URL.
      const current = await readCoverRevealDisplay(journeyId, scopedFetch);
      if (openingIdentity(current) !== pinnedOpening) throw new Error("journey_film_changed");
      if (!current.display || !(Date.parse(current.display.expiresAt) > Date.now())) throw new Error("journey_film_source_unreadable");
      return readUrl(current.display.url, 16 * 1024 * 1024);
    } : null,
    onFrame: (completed) => options.onProgress({ phase: "rendering", completed, total: film.manifest.totalFrames }),
    onFinalize: () => options.onProgress({ phase: "finalizing", completed: 0, total: 1 }),
    onWrite: (writtenBytes) => activity("output-write", writtenBytes),
  });
  } finally { mediaCache.clear(); }
  const result = encoded instanceof Blob ? { blob: encoded } : encoded;
  const { blob } = result;
  try {
  signal.throwIfAborted();
  if (journeyFilmIdentity(journey) !== identity) throw new Error("journey_film_changed");
  if (blob.type !== "video/mp4" || blob.size === 0) throw new Error("journey_film_output_invalid");
  options.onProgress({ phase: "validating", completed: 0, total: 1 });
  await verify(signal);
  return { ...result, filename: journeyFilmFilename(journey.title), durationMs: film.manifest.actualDurationMs, soundtrackIncluded: soundtrack !== null, verify };
  } catch (error) {
    try { if ("dispose" in result) await result.dispose(); }
    catch { throw new JourneyFilmCleanupError(error); }
    throw error;
  }
}

