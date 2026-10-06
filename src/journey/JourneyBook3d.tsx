import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import * as THREE from "three";
import {
  IconArrowLeft,
  IconArrowRight,
  IconLayoutList,
  IconMusic,
  IconMusicOff,
  IconX,
} from "@tabler/icons-react";
import { onMotionPreferenceChange, prefersReducedMotion } from "../motion/preferences";
import { useAtlasView } from "./atlasView";
import { journeySoundtrack } from "./journeyModel";
import {
  journeyBookPageRoutePointId,
  journeyBookPages,
  journeyBookStartPage,
  type JourneyBookPage,
} from "./journeyBookPages";
import { BOOK_PAGE_RATIO, journeyBookLayout, type JourneyBookOrientation } from "./journeyBookLayout";
import {
  dragFraction,
  dragTurnDirection,
  edgePreviewDirection,
  faceSide,
  facesAtSpread,
  focusX,
  shouldCompleteDrag,
  spreadOfFace,
  stepFace,
} from "./journeyBook3dModel";
import { coverRouteGeometry, coverRouteSvgPath } from "./coverRouteGeometry";
import { PLATE, coverMarkReady, loadCoverMark, noteCharacterCount, paintCoverMaterial, paintFace, type PageSource } from "./journeyBook3dPainter";
import { loadPictureChain } from "./journeyBook3dPictures";
import { JourneyBook3dScene } from "./journeyBook3dScene";
import {
  isVideoAsset,
  useReaderReads,
  useReaderSoundtrack,
  useVideoStills,
  type ReaderRead,
} from "./journeyReaderMedia";
import type { JourneyBookOpenTarget } from "./JourneyBook";
import { writeMediaPresentationStyle } from "./mediaPresentation";
import { useModalFocus } from "./useModalFocus";
import { withStillFragment } from "./videoStillFrame";
import type { StoryLogicalObservation } from "./storyMediaPolicy";
import type { Journey, JourneyMediaAsset } from "./types";
import "../styles/journey-book.css";
import "../styles/journey-book-3d.css";

const STAGE_BACKGROUND = "#020706";
/** Texture height of one page face; the width follows the page ratio. */
const FACE_TEXTURE_HEIGHT = 1280;
/** Spreads either side of the current one whose faces hold textures. */
const PAINT_SPREADS = 1;
/** Spreads either side whose pictures are fetched and decoded ahead. */
const LOAD_SPREADS = 2;
/** Longest edge a decoded picture is kept at; the page texture needs no more. */
const PICTURE_MAX_EDGE = 1400;
const REVEAL_MS_PER_CHARACTER = 34;
const REVEAL_SPAN_MAX_MS = 1600;
/** Repaint rate while a note arrives; each repaint re-uploads the page texture. */
const REPAINT_INTERVAL_MS = 80;
const DRAG_SLOP_PX = 6;
const SWIPE_PX = 36;
const EDGE_ZONE_PX = 28;
/** The bottom of the live video belongs to its native controls. */
const VIDEO_CONTROLS_BAND_PX = 52;

let fineHoverQuery: MediaQueryList | null = null;
/** Whether the primary pointer can hover precisely (a desktop mouse or trackpad). */
function canHoverFinely(): boolean {
  if (typeof window.matchMedia !== "function") return false;
  fineHoverQuery ??= window.matchMedia("(hover: hover) and (pointer: fine)");
  return fineHoverQuery.matches;
}

type FaceSurface = {
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  signature: string;
  /** The front cover's material map (height, roughness, metalness); other faces have none. */
  material?: { canvas: HTMLCanvasElement; texture: THREE.CanvasTexture };
};

/** A face-sized canvas texture, mipmapped like every page so it stays sharp when minified. */
function faceTexture(scene: JourneyBook3dScene): { canvas: HTMLCanvasElement; texture: THREE.CanvasTexture } {
  const canvas = document.createElement("canvas");
  const height = Math.min(FACE_TEXTURE_HEIGHT, scene.maxTextureSize);
  canvas.height = height;
  canvas.width = Math.round(height * BOOK_PAGE_RATIO);
  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = Math.min(4, scene.maxAnisotropy);
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  return { canvas, texture };
}

function disposeSurface(surface: FaceSurface) {
  surface.texture.dispose();
  surface.material?.texture.dispose();
}
type Gesture = {
  pointerId: number;
  x: number;
  y: number;
  time: number;
  face: number;
  spread: number;
  mode: "pending" | "turn" | "pan" | "none";
  direction: -1 | 1;
  startFraction: number;
  fraction: number;
  onVideo: boolean;
};

function journeyRange(journey: Journey) {
  return journey.endedOn && journey.endedOn !== journey.startedOn
    ? `${journey.startedOn} — ${journey.endedOn}`
    : journey.startedOn;
}

function pageAsset(page: JourneyBookPage | undefined): JourneyMediaAsset | null {
  if (page?.kind === "media" || page?.kind === "cover") return page.asset;
  return null;
}

function pageNote(page: JourneyBookPage | undefined): string | null {
  if (page?.kind === "media" || page?.kind === "note") return page.note;
  return null;
}

function pageLabel(page: JourneyBookPage, face: number, count: number): string {
  if (page.kind === "cover") return "封面";
  if (page.kind === "end") return "封底";
  return `第 ${face} / ${count - 2} 页`;
}

/**
 * What a face paints, best last: for a photo its preview (small, fast) then
 * the original; for a video its poster or a browser-decoded still.
 */
function pictureUrls(asset: JourneyMediaAsset, read: ReaderRead | undefined, still: string | undefined): string[] {
  if (read?.status !== "ready") return [];
  if (isVideoAsset(asset)) {
    const poster = read.read.preview?.url ?? still;
    return poster ? [poster] : [];
  }
  return read.read.preview ? [read.read.preview.url, read.read.url] : [read.read.url];
}

/**
 * Decode a picture in CORS mode (a WebGL texture needs a clean image) and
 * keep it only as a canvas no larger than the page needs, so a long Journey
 * of camera originals does not hold full-size bitmaps.
 */
function loadPicture(url: string): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => {
      const scale = Math.min(1, PICTURE_MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error("no 2d context"));
        return;
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas);
    };
    image.onerror = () => reject(new Error("load failed"));
    image.src = url;
  });
}

/**
 * After a CORS-mode load failed: does the same URL load as a plain image?
 * Then the URL is fine and the storage only refuses cross-origin reads,
 * which no re-read can fix.
 */
function loadsWithoutCors(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
    image.src = url;
  });
}

/**
 * #393 trial: a Journey read as a book with real paper — pages bend, catch
 * light and cast shadows (Quick FlipBook on Three.js). Opens in place of Story
 * when the per-device presentation style is `book-3d`. Every face is painted
 * as one picture, so photos and notes bend with the page; a settled video page
 * is overlaid with the one live `<video>`. Portrait reads a page at a time and
 * pans across an open spread, turning paper only between sheets.
 */
export function JourneyBook3d({
  journeys,
  journeyId,
  routePointId = null,
  initialAssetId = null,
  onClose,
  onOpenClassic,
  onNavigate,
  onObservationChange,
  onGlobeCoverChange,
}: {
  journeys: readonly Journey[];
  journeyId: string;
  routePointId?: string | null;
  initialAssetId?: string | null;
  onClose: () => void;
  onOpenClassic: (target: JourneyBookOpenTarget) => void;
  onNavigate?: (journeyId: string) => void;
  onObservationChange?: (observation: StoryLogicalObservation | null) => void;
  /** The book covers the globe completely, so the globe can stop rendering. */
  onGlobeCoverChange?: (state: { opaqueMediaCover: boolean; coverTransitionActive: boolean }) => void;
}) {
  const { readMedia } = useAtlasView();
  const journeyIndex = journeys.findIndex((candidate) => candidate.id === journeyId);
  const journey = journeyIndex >= 0 ? journeys[journeyIndex] : null;
  const previousJourney = journeyIndex > 0 ? journeys[journeyIndex - 1] : null;
  const nextJourney = journeyIndex >= 0 && journeyIndex < journeys.length - 1 ? journeys[journeyIndex + 1] : null;
  const pages = useMemo(() => (journey ? journeyBookPages(journey) : []), [journey]);
  const coverRoute = useMemo(() => coverRouteGeometry(journey?.routePoints ?? []), [journey?.routePoints]);
  // Fingerprint of what the cover draws from the Route, for its repaint signature.
  const coverRouteKey = `${journey?.routePoints.length ?? 0}:${coverRoute.kind === "point" ? "point" : coverRouteSvgPath(coverRoute, 1000, 1000)}`;
  const faceCount = pages.length;
  const soundtrack = journey ? journeySoundtrack(journey) : null;

  const [face, setFace] = useState(() => journeyBookStartPage(pages, { routePointId, assetId: initialAssetId }));
  const faceRef = useRef(face);
  faceRef.current = face;
  const [orientation, setOrientation] = useState<JourneyBookOrientation>("landscape");
  const orientationRef = useRef(orientation);
  orientationRef.current = orientation;
  const [settled, setSettled] = useState(true);
  const [reduced, setReduced] = useState(prefersReducedMotion);
  const [failure, setFailure] = useState<string | null>(null);
  const [corsRefused, setCorsRefused] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [fullNote, setFullNote] = useState<string | null>(null);
  const [overflowFaces, setOverflowFaces] = useState<ReadonlySet<number>>(() => new Set());
  const [pictures, setPictures] = useState<Record<string, PageSource>>({});
  const [chosenVideoId, setChosenVideoId] = useState<string | null>(null);
  const [videoRect, setVideoRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [repaintTick, setRepaintTick] = useState(0);

  // The cover's embossed mark is rasterised once; the cover repaints when it is ready.
  useEffect(() => {
    let live = true;
    void loadCoverMark().then(() => {
      if (live) setRepaintTick((tick) => tick + 1);
    });
    return () => {
      live = false;
    };
  }, []);
  const [stageSize, setStageSize] = useState("");
  const lastSettledRef = useRef(true);
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const sceneRef = useRef<JourneyBook3dScene | null>(null);
  const surfacesRef = useRef(new Map<number, FaceSurface>());
  const revealRef = useRef(new Map<number, { start: number; length: number } | "done">());
  const gestureRef = useRef<Gesture | null>(null);
  const pictureUrlsRef = useRef(new Map<string, string>());
  const placedRef = useRef(false);
  const rootRef = useModalFocus<HTMLDivElement>(() => {
    if (fullNote !== null) setFullNote(null);
    else if (tocOpen) setTocOpen(false);
    else onClose();
  });

  useEffect(() => onMotionPreferenceChange(setReduced), []);

  useEffect(() => {
    onGlobeCoverChange?.({ opaqueMediaCover: true, coverTransitionActive: false });
    return () => onGlobeCoverChange?.({ opaqueMediaCover: false, coverTransitionActive: false });
  }, [onGlobeCoverChange]);

  // ── the scene ─────────────────────────────────────────────────────────
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || faceCount === 0) return;
    // Every scene gets a fresh canvas: dispose() forces the old context lost,
    // and a canvas keeps returning its lost context, so it cannot be reused.
    const canvas = document.createElement("canvas");
    canvas.className = "journey-book-3d__canvas";
    canvas.setAttribute("aria-hidden", "true");
    stage.prepend(canvas);
    let scene: JourneyBook3dScene;
    try {
      scene = new JourneyBook3dScene(canvas, BOOK_PAGE_RATIO, reduced, STAGE_BACKGROUND);
    } catch {
      canvas.remove();
      setFailure("这台设备暂时无法显示立体之书。");
      return;
    }
    sceneRef.current = scene;
    scene.setFaceCount(faceCount);
    scene.jumpTo(spreadOfFace(faceRef.current));
    placedRef.current = false;
    lastSettledRef.current = true;
    scene.onFrame((_, isSettled) => {
      // QA: where the sheet in flight reaches against the stage, every
      // rendered frame. DEV only; a production build writes nothing.
      if (import.meta.env.DEV) stage.dataset.qaBookFlight = JSON.stringify(scene.qaFlight);
      if (isSettled !== lastSettledRef.current) {
        lastSettledRef.current = isSettled;
        setSettled(isSettled);
      }
    });
    const surfaces = surfacesRef.current;
    return () => {
      for (const surface of surfaces.values()) disposeSurface(surface);
      surfaces.clear();
      sceneRef.current = null;
      scene.dispose();
      canvas.remove();
    };
  }, [faceCount, reduced]);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => {
      const width = stage.clientWidth;
      const height = stage.clientHeight;
      const layout = journeyBookLayout(width, height);
      if (!layout) return;
      setOrientation(layout.orientation);
      setStageSize(`${width}x${height}`);
      sceneRef.current?.resize(width, height, layout.orientation);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [faceCount, reduced]);

  // The camera frames the page being read (portrait) or the spread.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.setFocus(focusX(face, faceCount, BOOK_PAGE_RATIO, orientation), !placedRef.current || reduced);
    placedRef.current = true;
  }, [face, faceCount, orientation, reduced]);

  // ── media ─────────────────────────────────────────────────────────────
  const spread = spreadOfFace(face);
  const loadFaces = useMemo(() => {
    const faces: number[] = [];
    for (let candidate = 0; candidate < faceCount; candidate += 1) {
      if (Math.abs(spreadOfFace(candidate) - spread) <= LOAD_SPREADS) faces.push(candidate);
    }
    return faces;
  }, [faceCount, spread]);
  const wantedAssets = useMemo(() => {
    const assets: JourneyMediaAsset[] = soundtrack ? [soundtrack] : [];
    for (const candidate of loadFaces) {
      const asset = pageAsset(pages[candidate]);
      if (asset) assets.push(asset);
    }
    return assets;
  }, [loadFaces, pages, soundtrack]);
  const { reads, expireRead, clearRetry } = useReaderReads(readMedia, wantedAssets);
  const stills = useVideoStills(reads, wantedAssets);
  const soundtrackRead = soundtrack ? reads[soundtrack.id] : undefined;
  const soundtrackUrl = soundtrackRead?.status === "ready" ? soundtrackRead.read.url : null;
  const { audioRef, musicOn, toggleMusic, reportVideo } = useReaderSoundtrack(soundtrackUrl, reduced);

  // Pictures are decoded in CORS mode so they can become page textures, the
  // preview first and the original after it. A failed load is read once more
  // (an expired signed URL), then reported on the page.
  useEffect(() => {
    const live = new Set<string>();
    for (const asset of wantedAssets) {
      if (asset === soundtrack) continue;
      live.add(asset.id);
      const read = reads[asset.id];
      if (read?.status === "error") {
        if (pictures[asset.id]?.status !== "error") {
          setPictures((previous) => ({ ...previous, [asset.id]: { status: "error", message: "暂时无法读取" } }));
        }
        continue;
      }
      const still = stills[asset.id];
      const urls = pictureUrls(asset, read, still?.kind === "image" ? still.url : undefined);
      const key = urls.join("|");
      if (!urls.length || pictureUrlsRef.current.get(asset.id) === key) continue;
      pictureUrlsRef.current.set(asset.id, key);
      void loadPictureChain(urls, {
        load: loadPicture,
        loadsWithoutCors,
        isLive: () => pictureUrlsRef.current.get(asset.id) === key,
        present: (canvas) => setPictures((previous) => ({
          ...previous,
          [asset.id]: { status: "ready", image: canvas, width: canvas.width, height: canvas.height },
        })),
        onComplete: () => clearRetry(asset.id),
        onCorsRefused: () => setCorsRefused(true),
        onExpire: () => {
          pictureUrlsRef.current.delete(asset.id);
          expireRead(asset.id);
        },
      });
    }
    // Pictures far from the reader are released.
    for (const assetId of pictureUrlsRef.current.keys()) {
      if (!live.has(assetId)) pictureUrlsRef.current.delete(assetId);
    }
    setPictures((previous) => {
      const kept = Object.keys(previous).filter((assetId) => live.has(assetId));
      return kept.length === Object.keys(previous).length
        ? previous
        : Object.fromEntries(kept.map((assetId) => [assetId, previous[assetId]]));
    });
  }, [wantedAssets, reads, stills, soundtrack, expireRead, clearRetry, pictures]);

  // Loads still in flight when the book closes report nothing.
  useEffect(() => {
    const pictureUrls = pictureUrlsRef.current;
    return () => pictureUrls.clear();
  }, []);

  // ── painting ──────────────────────────────────────────────────────────
  const visibleFaces = useMemo(() => {
    const atSpread = facesAtSpread(spread, faceCount);
    return orientation === "portrait" && atSpread.length > 1 ? [face] : atSpread;
  }, [face, faceCount, orientation, spread]);

  const revealedCount = useCallback((target: number): number => {
    const state = revealRef.current.get(target);
    if (state === "done" || reduced) return Infinity;
    if (!state) return 0;
    return (performance.now() - state.start) / Math.min(REVEAL_MS_PER_CHARACTER, REVEAL_SPAN_MAX_MS / Math.max(1, state.length));
  }, [reduced]);

  const paint = useCallback((target: number) => {
    const scene = sceneRef.current;
    const page = pages[target];
    if (!scene || !page || !journey) return;
    const asset = pageAsset(page);
    const source: PageSource | null = asset ? pictures[asset.id] ?? { status: "loading" } : null;
    const revealed = revealedCount(target);
    const signature = `${page.key}|${asset ? `${source?.status}:${pictureUrlsRef.current.get(asset.id) ?? ""}` : ""}|${source?.status === "ready" ? `${source.width}x${source.height}` : ""}|${Number.isFinite(revealed) ? Math.floor(revealed * 4) : "all"}|${journey.title}${page.kind === "cover" ? `|${coverRouteKey}|${coverMarkReady()}|${journeyRange(journey)}` : ""}`;
    let surface = surfacesRef.current.get(target);
    if (surface?.signature === signature) return;
    if (!surface) {
      const { canvas, texture } = faceTexture(scene);
      texture.colorSpace = THREE.SRGBColorSpace;
      surface = { canvas, texture, signature: "" };
      // Only the front cover gets the material map; its data stays linear.
      if (target === 0 && page.kind === "cover") surface.material = faceTexture(scene);
      surfacesRef.current.set(target, surface);
    }
    const result = paintFace(surface.canvas, {
      page,
      face: target,
      faceCount,
      title: journey.title,
      dates: journeyRange(journey),
      routePointCount: journey.routePoints.length,
      route: coverRoute,
      source,
      revealed,
    });
    surface.signature = signature;
    surface.texture.needsUpdate = true;
    scene.setFaceTexture(target, surface.texture);
    if (surface.material) {
      paintCoverMaterial(surface.material.canvas, { page, route: coverRoute });
      surface.material.texture.needsUpdate = true;
      scene.setCoverMaps(surface.material.texture);
    }
    scene.textureUpdated();
    setOverflowFaces((previous) => {
      if (previous.has(target) === result.noteOverflow) return previous;
      const next = new Set(previous);
      if (result.noteOverflow) next.add(target);
      else next.delete(target);
      return next;
    });
  }, [coverRoute, coverRouteKey, faceCount, journey, pages, pictures, repaintTick, revealedCount]);

  // Faces near the reader hold painted textures; the rest are released.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    for (let target = 0; target < faceCount; target += 1) {
      if (Math.abs(spreadOfFace(target) - spread) <= PAINT_SPREADS) {
        paint(target);
        continue;
      }
      const surface = surfacesRef.current.get(target);
      if (!surface) continue;
      scene.setFaceTexture(target, null);
      if (surface.material) scene.setCoverMaps(null);
      disposeSurface(surface);
      surfacesRef.current.delete(target);
    }
  }, [faceCount, paint, spread]);

  // Notes arrive a character at a time once their page has settled in view;
  // a turn settles any note still arriving.
  useEffect(() => {
    if (!settled) {
      // Repaint only when a note actually settled: `paint` changes with the
      // tick, so an unconditional bump would re-run this effect for ever.
      let changed = false;
      for (const [target, state] of revealRef.current) {
        if (state === "done") continue;
        revealRef.current.set(target, "done");
        changed = true;
      }
      if (changed) setRepaintTick((tick) => tick + 1);
      return;
    }
    const arriving: number[] = [];
    for (const target of visibleFaces) {
      const state = revealRef.current.get(target);
      if (state === "done") continue;
      // Still arriving when this effect re-ran (a picture landed): resume it.
      if (state) {
        arriving.push(target);
        continue;
      }
      const length = noteCharacterCount(pageNote(pages[target]));
      if (!length || reduced) {
        revealRef.current.set(target, "done");
        continue;
      }
      revealRef.current.set(target, { start: performance.now(), length });
      arriving.push(target);
    }
    if (!arriving.length) return;
    let timer = 0;
    const tick = () => {
      let pending = false;
      for (const target of arriving) {
        const state = revealRef.current.get(target);
        if (!state || state === "done") continue;
        if (revealedCount(target) >= state.length + 1) revealRef.current.set(target, "done");
        else pending = true;
        const surface = surfacesRef.current.get(target);
        if (surface) surface.signature = "";
        paint(target);
      }
      if (pending) timer = window.setTimeout(tick, REPAINT_INTERVAL_MS);
    };
    tick();
    return () => window.clearTimeout(timer);
  }, [paint, pages, reduced, revealedCount, settled, visibleFaces]);

  // ── the live video ────────────────────────────────────────────────────
  const visibleVideos = visibleFaces.filter((target) => {
    const page = pages[target];
    return page?.kind === "media" && isVideoAsset(page.asset);
  });
  const liveFace = visibleVideos.find((target) => pageAsset(pages[target])?.id === chosenVideoId) ?? visibleVideos[0] ?? null;
  const liveAsset = liveFace !== null ? pageAsset(pages[liveFace]) : null;
  const liveRead = liveAsset ? reads[liveAsset.id] : undefined;

  useLayoutEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !settled || liveFace === null) {
      setVideoRect(null);
      return;
    }
    const rect = scene.faceRect(faceSide(liveFace, faceCount));
    setVideoRect({
      left: Math.round(rect.left + rect.width * PLATE.left),
      top: Math.round(rect.top + rect.height * PLATE.top),
      width: Math.round(rect.width * PLATE.width),
      height: Math.round(rect.height * PLATE.height),
    });
  }, [faceCount, liveFace, orientation, settled, stageSize]);

  // QA: publish where the settled faces lie, so browser QA can sample the
  // rendered paper against them. DEV only; a production build writes nothing.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const stage = stageRef.current;
    const scene = sceneRef.current;
    if (!stage) return;
    if (!scene || !settled) {
      delete stage.dataset.qaBook;
      return;
    }
    const at = Math.round(scene.progress);
    const sides = at <= 0 ? ["closed-front"] as const : at >= scene.sheets ? ["closed-back"] as const : ["left", "right"] as const;
    stage.dataset.qaBook = JSON.stringify({
      spread: at,
      face,
      sheets: scene.sheets,
      orientation,
      pixelsPerUnit: scene.pixelsPerUnit,
      spineX: scene.spineX,
      rects: Object.fromEntries(sides.map((side) => [side, scene.faceRect(side)])),
    });
  }, [face, faceCount, orientation, settled, stageSize]);

  // A turn pauses the live video; the turning page shows its poster or still.
  // The player is not in CORS mode (deploy/README.md), so its frame cannot be
  // copied onto the page.
  useEffect(() => {
    if (!settled) videoRef.current?.pause();
  }, [settled]);

  const updateVideo = useCallback(() => reportVideo(videoRef.current), [reportVideo]);
  useEffect(() => {
    reportVideo(null);
  }, [liveAsset?.id, reportVideo]);

  // ── reading position ──────────────────────────────────────────────────
  const settleNotes = useCallback(() => {
    for (const target of visibleFaces) revealRef.current.set(target, "done");
    setRepaintTick((tick) => tick + 1);
  }, [visibleFaces]);

  /** The book is about to move: hide the live video before the first frame. */
  const markMoving = useCallback(() => {
    lastSettledRef.current = false;
    setSettled(false);
  }, []);

  const goToFace = useCallback((target: number, turns: boolean) => {
    const scene = sceneRef.current;
    if (!scene) return;
    settleNotes();
    setChosenVideoId(null);
    markMoving();
    if (turns) scene.turnTo(spreadOfFace(target));
    else scene.requestRender();
    setFace(target);
  }, [markMoving, settleNotes]);

  const step = useCallback((direction: -1 | 1) => {
    const scene = sceneRef.current;
    if (!scene || !scene.isSettled()) return;
    const next = stepFace(faceRef.current, direction, faceCount, orientationRef.current);
    if (next) goToFace(next.face, next.turns);
  }, [faceCount, goToFace]);

  const currentPage = pages[face];
  useEffect(() => {
    if (!journey) return;
    onObservationChange?.({
      journeyId: journey.id,
      routePointId: journeyBookPageRoutePointId(currentPage),
      assetId: currentPage?.kind === "media" ? currentPage.asset.id : null,
      storySnapState: "in-context",
    });
  }, [currentPage, journey, onObservationChange]);

  // ── gestures ──────────────────────────────────────────────────────────
  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const scene = sceneRef.current;
    if (!scene || (event.pointerType === "mouse" && event.button !== 0)) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, a, input, select, textarea")) return;
    const video = target.closest("video");
    if (video && video.getBoundingClientRect().bottom - event.clientY < VIDEO_CONTROLS_BAND_PX) return;
    const lifted = scene.takeEdge();
    if (!lifted && !scene.isSettled()) return;
    gestureRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      time: performance.now(),
      face: faceRef.current,
      spread: lifted?.base ?? Math.round(scene.progress),
      mode: lifted ? "turn" : "pending",
      direction: lifted?.direction ?? 1,
      startFraction: lifted?.fraction ?? 0,
      fraction: lifted?.fraction ?? 0,
      onVideo: Boolean(video),
    };
    if (lifted) {
      markMoving();
      scene.beginDrag();
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const scene = sceneRef.current;
    if (!scene) return;
    const gesture = gestureRef.current;
    const stage = stageRef.current!.getBoundingClientRect();
    if (!gesture) {
      // The edge lift is a hover affordance: only for a fine pointer that can
      // hover, so a tap (or a touch-emulated mouse event) never leaves it up.
      if (event.pointerType !== "mouse" || !canHoverFinely() || reduced || orientationRef.current !== "landscape") return;
      // Lifting an edge unsettles the book, which would pause a playing video.
      if (videoRef.current && !videoRef.current.paused) return;
      if (!scene.isSettled() && !scene.hasEdge) return;
      const spreadNow = Math.round(scene.progress);
      const pointerX = event.clientX - stage.left;
      // Under the tilt each side rests at its own height on screen.
      const page = scene.faceRect(spreadNow <= 0 ? "closed-front"
        : spreadNow >= scene.sheets ? "closed-back"
          : pointerX < scene.spineX ? "left" : "right");
      scene.hoverEdge(edgePreviewDirection({
        spread: spreadNow,
        sheets: scene.sheets,
        pointerX,
        pointerY: event.clientY - stage.top,
        spineX: scene.spineX,
        centerY: page.top + page.height / 2,
        pageWidth: scene.pageWidthPx,
        pageHeight: page.height,
        edgeZone: EDGE_ZONE_PX,
      }));
      return;
    }
    if (gesture.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - gesture.x;
    const deltaY = event.clientY - gesture.y;
    if (gesture.mode === "pending") {
      if (Math.abs(deltaX) < DRAG_SLOP_PX) return;
      if (Math.abs(deltaY) > Math.abs(deltaX) * 1.15) {
        gesture.mode = "none";
        return;
      }
      event.currentTarget.setPointerCapture(event.pointerId);
      const direction = dragTurnDirection(gesture.face, faceCount, orientationRef.current, deltaX);
      if (direction === 0) {
        gesture.mode = "pan";
        return;
      }
      gesture.mode = "turn";
      gesture.direction = direction;
      videoRef.current?.pause();
      settleNotes();
      markMoving();
      scene.beginDrag();
    }
    if (gesture.mode !== "turn") return;
    event.preventDefault();
    gesture.fraction = dragFraction(deltaX, gesture.direction, scene.pageWidthPx, gesture.startFraction);
    scene.dragTo(gesture.spread + gesture.direction * gesture.fraction);
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>, cancelled = false) {
    const scene = sceneRef.current;
    const gesture = gestureRef.current;
    if (!scene || !gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    const deltaX = event.clientX - gesture.x;
    const deltaY = event.clientY - gesture.y;
    const elapsed = performance.now() - gesture.time;
    if (gesture.mode === "turn") {
      // A click on a lifted page edge (no drag) turns that page, as a tap does.
      const clicked = Math.abs(deltaX) < DRAG_SLOP_PX && elapsed < 500;
      const complete = !cancelled && (clicked || shouldCompleteDrag(gesture.fraction, elapsed));
      const targetSpread = gesture.spread + (complete ? gesture.direction : 0);
      scene.endDrag(targetSpread);
      if (complete) {
        const next = stepFace(gesture.face, gesture.direction, faceCount, orientationRef.current);
        if (next) {
          setChosenVideoId(null);
          setFace(next.face);
        }
      }
      return;
    }
    if (cancelled) return;
    if (gesture.mode === "pan" || (gesture.mode === "none" && Math.abs(deltaX) > SWIPE_PX)) {
      if (Math.abs(deltaX) > SWIPE_PX && Math.abs(deltaX) > Math.abs(deltaY)) step(deltaX < 0 ? 1 : -1);
      return;
    }
    if (gesture.mode !== "pending" || gesture.onVideo || elapsed > 500 || Math.abs(deltaY) > 20) return;
    // A tap: on a still video frame it starts that video; elsewhere the edge
    // of the book it lands nearer turns toward it.
    const stage = stageRef.current!.getBoundingClientRect();
    const x = event.clientX - stage.left;
    for (const target of visibleVideos) {
      const rect = scene.faceRect(faceSide(target, faceCount));
      if (x >= rect.left && x <= rect.left + rect.width && event.clientY - stage.top >= rect.top && event.clientY - stage.top <= rect.top + rect.height) {
        setChosenVideoId(pageAsset(pages[target])?.id ?? null);
        return;
      }
    }
    if (x < stage.width / 3) step(-1);
    else if (x > (stage.width * 2) / 3) step(1);
  }

  function onPointerLeave(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse" && !gestureRef.current) sceneRef.current?.hoverEdge(0);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target.closest("video, input, textarea, select")) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      step(event.key === "ArrowRight" ? 1 : -1);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      goToFace(event.key === "Home" ? 0 : faceCount - 1, true);
    }
  }

  const chapters = useMemo(() => {
    const seen = new Set<string>();
    const entries: { face: number; label: string }[] = [{ face: 0, label: "封面" }];
    pages.forEach((page, index) => {
      if (page.kind !== "media" && page.kind !== "note") return;
      const key = page.routePoint?.id ?? "journey";
      if (seen.has(key)) return;
      seen.add(key);
      entries.push({ face: index, label: page.routePoint?.label || "整段旅程" });
    });
    return entries;
  }, [pages]);

  if (!journey) return null;
  const classicTarget: JourneyBookOpenTarget = {
    routePointId: journeyBookPageRoutePointId(currentPage),
    assetId: currentPage?.kind === "media" ? currentPage.asset.id : null,
  };
  const overflowNote = visibleFaces.map((target) => (overflowFaces.has(target) ? pageNote(pages[target]) : null)).find(Boolean) ?? null;
  const atBackCover = face >= faceCount - 1;
  const readable = visibleFaces.map((target) => {
    const page = pages[target];
    if (!page) return "";
    if (page.kind === "cover") return [journey.title, journeyRange(journey)].filter(Boolean).join("。");
    if (page.kind === "media" || page.kind === "note") return [page.routePoint?.label, page.note].filter(Boolean).join("。");
    return "";
  }).filter(Boolean).join(" ");

  return (
    <div
      ref={rootRef}
      className="journey-book journey-book-3d"
      role="dialog"
      aria-modal="true"
      aria-label={`${journey.title} · 立体之书`}
      data-orientation={orientation}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <header className="journey-book__header">
        <button type="button" className="journey-book__icon" aria-label="合上书" onClick={onClose}>
          <IconX size={20} stroke={1.35} aria-hidden="true" />
        </button>
        <div className="journey-book__title">
          <h2>{journey.title}</h2>
          <span>{journeyRange(journey)}</span>
        </div>
        <div className="journey-book__header-actions">
          {soundtrack ? (
            <button
              type="button"
              className="journey-book__icon"
              aria-label={musicOn ? "关闭配乐" : "播放配乐"}
              aria-pressed={musicOn}
              disabled={!soundtrackUrl}
              onClick={toggleMusic}
            >
              {musicOn
                ? <IconMusic size={19} stroke={1.35} aria-hidden="true" />
                : <IconMusicOff size={19} stroke={1.35} aria-hidden="true" />}
            </button>
          ) : null}
          <button
            type="button"
            className="journey-book__icon"
            aria-label="目录"
            aria-expanded={tocOpen}
            onClick={() => setTocOpen((value) => !value)}
          ><IconLayoutList size={19} stroke={1.35} aria-hidden="true" /></button>
          <button type="button" className="journey-book__text-action" onClick={() => onOpenClassic(classicTarget)}>
            经典视图
          </button>
        </div>
      </header>
      {tocOpen ? (
        <nav className="journey-book__toc" aria-label="目录">
          <ol>
            {chapters.map((chapter, position) => (
              <li key={chapter.face}>
                <button
                  type="button"
                  aria-current={chapter.face <= face && face < (chapters[position + 1]?.face ?? Infinity) ? "true" : undefined}
                  onClick={() => {
                    setTocOpen(false);
                    goToFace(chapter.face, spreadOfFace(chapter.face) !== spread);
                  }}
                >{chapter.label}</button>
              </li>
            ))}
          </ol>
        </nav>
      ) : null}
      <div
        ref={stageRef}
        className="journey-book__stage journey-book-3d__stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => onPointerUp(event)}
        onPointerCancel={(event) => onPointerUp(event, true)}
        onPointerLeave={onPointerLeave}
      >
        {failure || corsRefused ? (
          <div className="journey-book-3d__failure" role="status">
            <p>{failure ?? "媒体存储不允许跨域读取，立体之书无法显示照片。"}</p>
            <div className="journey-book-3d__failure-actions">
              <button type="button" className="journey-book__text-action" onClick={() => onOpenClassic(classicTarget)}>打开经典视图</button>
              <button type="button" className="journey-book__text-action" onClick={() => writeMediaPresentationStyle("book")}>改用旅程之书</button>
            </div>
          </div>
        ) : null}
        {liveAsset && liveRead?.status === "ready" && videoRect ? (
          <video
            ref={videoRef}
            key={liveAsset.id}
            className="journey-book-3d__video"
            src={withStillFragment(liveRead.read.url)}
            poster={liveRead.read.preview?.url}
            controls
            playsInline
            preload="metadata"
            style={videoRect as CSSProperties}
            onPlay={updateVideo}
            onPause={updateVideo}
            onEnded={updateVideo}
            onEmptied={updateVideo}
            onVolumeChange={updateVideo}
            onCanPlay={() => clearRetry(liveAsset.id)}
            onError={() => expireRead(liveAsset.id)}
          />
        ) : null}
        {settled && overflowNote ? (
          <button type="button" className="journey-book-3d__full-note" onClick={() => setFullNote(overflowNote)}>阅读全文</button>
        ) : null}
        {settled && atBackCover && onNavigate && (previousJourney || nextJourney) ? (
          <div className="journey-book-3d__journeys">
            {previousJourney ? (
              <button type="button" onClick={() => onNavigate(previousJourney.id)}><small>上一段旅程</small>{previousJourney.title}</button>
            ) : null}
            {nextJourney ? (
              <button type="button" onClick={() => onNavigate(nextJourney.id)}><small>下一段旅程</small>{nextJourney.title}</button>
            ) : null}
          </div>
        ) : null}
      </div>
      <footer className="journey-book__controls">
        <button
          type="button"
          className="journey-book__icon journey-book__turn"
          aria-label="上一页"
          disabled={face === 0}
          onClick={() => step(-1)}
        ><IconArrowLeft size={18} stroke={1.35} aria-hidden="true" /></button>
        <span className="journey-book__status" aria-live="polite">
          {currentPage ? pageLabel(currentPage, face, faceCount) : ""}
        </span>
        <button
          type="button"
          className="journey-book__icon journey-book__turn"
          aria-label="下一页"
          disabled={face >= faceCount - 1}
          onClick={() => step(1)}
        ><IconArrowRight size={18} stroke={1.35} aria-hidden="true" /></button>
      </footer>
      <p className="journey-book-3d__readable" aria-live="polite">{settled ? readable : ""}</p>
      {fullNote !== null ? (
        <div className="journey-book-3d__note-sheet" role="dialog" aria-label="感想全文" onClick={() => setFullNote(null)}>
          <div onClick={(event) => event.stopPropagation()}>
            <p>{fullNote}</p>
            <button type="button" className="journey-book__text-action" onClick={() => setFullNote(null)}>收起</button>
          </div>
        </div>
      ) : null}
      {soundtrack && soundtrackUrl ? (
        <audio
          ref={audioRef}
          key={soundtrack.id}
          src={soundtrackUrl}
          loop
          preload="metadata"
          tabIndex={-1}
          aria-hidden="true"
          onError={() => expireRead(soundtrack.id)}
          onCanPlay={() => clearRetry(soundtrack.id)}
        />
      ) : null}
    </div>
  );
}

export default JourneyBook3d;
