import { cloneElement, forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactElement, type Ref, type VideoHTMLAttributes } from "react";
import { flushSync } from "react-dom";
import { MEDIA_STACK_DURATION, MEDIA_STACK_EASING, mediaStackClip, mediaStackOpacity, mediaStackPull, mediaStackRest, mediaStackReveal } from "./mediaStackMotion";
import { prefersReducedMotion } from "../motion/preferences";
import { springElementTo, springTransformVelocity, type SpringElementHandle } from "../motion/springElement";
import { MEDIA_SWIPE_DISTANCE_PX, MEDIA_SWIPE_VELOCITY_MAX_AGE_MS, isMediaSwipeIntent, nextMediaSwipeVelocity, shouldCommitMediaSwipe } from "./mediaSwipeDecision";
import { StartripsJourneyCue } from "../brand/StartripsBrandMark";
import { mediaPreviewLayer } from "./mediaPreviewLayer";
import type { JourneyMediaAsset, MediaPreviewRead } from "./types";
import "../styles/story-media-pages.css";

type Read = { status: "ready"; url: string; generation?: number; preview?: MediaPreviewRead } | { status: "loading" } | { status: "error"; message: string };
type VideoElement = ReactElement<VideoHTMLAttributes<HTMLVideoElement> & { ref?: Ref<HTMLVideoElement> }>;
type Frame = { url: string; generation?: number; state: "waiting" | "ready" | "error"; canvas?: HTMLCanvasElement; message?: string };
type VideoRenewal = {
  id: string; src: string; generation?: number; time: number; muted: boolean; volume: number; playbackRate: number;
  seekIssued: boolean; seekCompleted: boolean;
};
type RetainedVideo = Pick<VideoRenewal, "id" | "time" | "muted" | "volume" | "playbackRate"> & {
  frame: HTMLCanvasElement;
};
export type StoryMediaPagesHandle = {
  cancelGesture: () => void;
  heldVideo: () => RetainedVideo | null;
  adoptHeldVideo: (video: RetainedVideo) => boolean;
};
type MediaDrag = {
  base: HTMLDivElement;
  baseId: string;
  peek: HTMLDivElement | null;
  startX: number;
  startY: number;
  pointerId: number;
  dx: number;
  velocityX: number;
  lastX: number;
  lastTime: number;
  axis: "x" | "y" | null;
  width: number;
  originTransform: string;
  neighborId: string | null;
  tapOpensFullscreen: boolean;
  generation: number;
  scopeKey: string;
  settleTakeover: boolean;
  /** Pixels the stream travels before it locks an axis (see `videoGestureCanStart`). */
  axisLock: number;
};
/** `cancelGesture` as the stage implements it: `true` lets a landed settle commit (#530). */
export type StoryMediaGestureCancel = (commitDecided?: boolean) => void;
type Props = {
  scopeKey: string;
  media: readonly JourneyMediaAsset[];
  currentId: string | null;
  incomingId: string | null;
  pendingId: string | null;
  coverId?: string | null;
  direction?: -1 | 1;
  reads: Record<string, Read>;
  wrap: boolean;
  videoAssetId: string | null;
  video: VideoElement | null;
  active?: boolean;
  onSettled: (id: string) => void;
  onMediaError: (id: string, message: string, retainedVideoFrame?: boolean) => void;
  onPlaybackReady: (id: string | null) => void;
  onBackdropClick?: () => void;
  onImageClick?: (accessibleActivation?: boolean) => void;
  onNavigate?: (direction: -1 | 1, accessibleActivation?: boolean) => void;
  canNavigatePrevious?: boolean;
  canNavigateNext?: boolean;
  gestureEnabled: boolean;
  mobileLayout: boolean;
  fullscreen?: boolean;
  onGestureClaim: (id: string) => void;
  onGestureHoldingChange: (holding: boolean) => void;
  onGestureConsumed: (consumed: boolean) => void;
  onGestureCommit: (id: string) => void;
  onGesturePrepare: (id: string) => void;
  onGestureTapAfterSettle?: () => void;
  onGestureExitFullscreen?: () => void;
  onGestureRevealFullscreenControls?: () => void;
  /** #489: the decode tier of Story's warm window. A video here keeps a
   *  representative frame ready before it is given a physical page. */
  warmIds?: readonly string[];
};

function containsMediaPoint(element: HTMLImageElement | HTMLCanvasElement, x: number, y: number) {
  const rect = element.getBoundingClientRect();
  const width = element instanceof HTMLImageElement ? element.naturalWidth : element.width;
  const height = element instanceof HTMLImageElement ? element.naturalHeight : element.height;
  if (!width || !height || !rect.width || !rect.height) return false;
  const scale = Math.min(rect.width / width, rect.height / height);
  const left = rect.left + (rect.width - width * scale) / 2;
  const top = rect.top + (rect.height - height * scale) / 2;
  return x >= left && x <= left + width * scale && y >= top && y <= top + height * scale;
}

function videoFrame(video: HTMLVideoElement): HTMLCanvasElement | null {
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;
  const frame = document.createElement("canvas");
  const scale = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
  frame.width = Math.max(1, Math.round(video.videoWidth * scale));
  frame.height = Math.max(1, Math.round(video.videoHeight * scale));
  try {
    const context = frame.getContext("2d");
    if (!context) return null;
    context.drawImage(video, 0, 0, frame.width, frame.height);
    return frame;
  } catch { return null; }
}

/** Metadata + a still frame only. This detached element never plays. */
function prepareVideoFrame(url: string, done: (frame: HTMLCanvasElement | null) => void) {
  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  video.playsInline = true;
  let closed = false;
  let timer = 0;
  const release = () => {
    window.clearTimeout(timer);
    video.onloadeddata = null;
    video.onseeked = null;
    video.onloadedmetadata = null;
    video.onerror = null;
    video.pause();
    video.removeAttribute("src");
    video.load();
  };
  const finish = (frame: HTMLCanvasElement | null) => {
    if (closed) return;
    closed = true;
    release();
    done(frame);
  };
  const capture = () => {
    if (video.seeking) return;
    const frame = videoFrame(video);
    if (frame) finish(frame);
  };
  video.onloadeddata = capture;
  video.onseeked = capture;
  video.onloadedmetadata = () => {
    try { video.currentTime = Math.min(0.01, Number.isFinite(video.duration) ? video.duration / 2 : 0.01); }
    catch { /* loadeddata may still supply the initial frame. */ }
    capture();
  };
  video.onerror = () => finish(null);
  timer = window.setTimeout(() => finish(null), 8_000);
  video.src = url;
  return () => { if (!closed) { closed = true; release(); } };
}

function FrameCanvas({ frame, sharedId }: { frame: HTMLCanvasElement | undefined; sharedId?: string }) {
  const paint = useCallback((canvas: HTMLCanvasElement | null) => {
    if (!canvas || !frame) return;
    canvas.width = frame.width;
    canvas.height = frame.height;
    canvas.getContext("2d")?.drawImage(frame, 0, 0);
  }, [frame]);
  return <canvas ref={paint} hidden={!frame} aria-hidden="true"
    data-shared-media-id={frame ? sharedId : undefined} />;
}

/** Three fixed pages and one persistent, gesture-authorized video transport. */
export const StoryMediaPages = forwardRef<StoryMediaPagesHandle, Props>(function StoryMediaPages({ active = true, ...props }, stageRef) {
  const latest = useRef({ ...props, active });
  latest.current = { ...props, active };
  const root = useRef<HTMLDivElement>(null);
  const hitSurface = useRef<HTMLDivElement>(null);
  const pageNodes = useRef<Array<HTMLDivElement | null>>([null, null, null]);
  const imageNodes = useRef<Array<HTMLImageElement | null>>([null, null, null]);
  const slotIds = useRef<Array<string | null>>([null, null, null]);
  // The last presentable incoming page, painted in front of `current` while
  // its handoff runs. A newer request that is not presentable yet must not
  // take that page's slot or send the stack back to `current`.
  const frontIncoming = useRef<{ id: string; currentId: string | null } | null>(null);
  const clipOwners = useRef<Array<string | null>>([null, null, null]);
  const interrupted = useRef(false);
  const drag = useRef<MediaDrag | null>(null);
  const settle = useRef<{ cancel: (commitDecided?: boolean) => void; finishForTakeover: () => void } | null>(null);
  const suppressCancelledPointerClick = useRef(false);
  const dragSprings = useRef<SpringElementHandle[]>([]);
  const gestureGeneration = useRef(0);
  const handoffGeneration = useRef(0);
  const gestureScope = useRef(props.scopeKey);
  const gestureCurrentId = useRef(props.currentId);
  const [gesturePhase, setGesturePhase] = useState<"dragging" | "settling" | null>(null);
  const [gestureFrontId, setGestureFrontId] = useState<string | null>(null);
  const [layoutRevision, updateLayoutRevision] = useState(0);
  const frames = useRef(new Map<string, Frame>());
  const pendingFrames = useRef(new Map<string, () => void>());
  const decodedImages = useRef(new Map<string, string>());
  const [revision, updateRevision] = useState(0);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [recoveryRevision, requestRecovery] = useState(0);
  const [failedLiveSource, setFailedLiveSource] = useState<string | null>(null);
  const liveVideo = useRef<HTMLVideoElement | null>(null);
  const videoShell = useRef<HTMLDivElement>(null);
  const retainedVideo = useRef<VideoElement | null>(props.video);
  if (props.video) retainedVideo.current = props.video;
  const parentVideoRef = useRef<Ref<HTMLVideoElement> | undefined>(props.video?.props.ref);
  if (props.video) parentVideoRef.current = props.video.props.ref;
  const providedSource = props.video?.props.src;
  const videoRead = props.videoAssetId ? props.reads[props.videoAssetId] : undefined;
  const providedGeneration = videoRead?.status === "ready" ? videoRead.generation : undefined;
  // Delay a src change for one layout phase so the old video can be painted
  // into its own page before the same transport starts loading the new source.
  const [binding, setBinding] = useState({ id: props.videoAssetId, src: providedSource, generation: providedGeneration });
  const bindingRef = useRef(binding);
  bindingRef.current = binding;
  const renewal = useRef<VideoRenewal | null>(null);
  const requestedSeek = useRef<{ id: string; src: string; generation?: number; time: number } | null>(null);
  const [liveReady, setLiveReady] = useState<string | null>(null);
  const bindVideo = useCallback((element: HTMLVideoElement | null) => {
    liveVideo.current = element;
    const ref = parentVideoRef.current;
    if (typeof ref === "function") ref(element);
    else if (ref) ref.current = element;
  }, []);

  const index = props.media.findIndex((asset) => asset.id === props.currentId);
  const at = (offset: number) => {
    if (index < 0 || props.media.length < 2) return null;
    const raw = index + offset;
    const next = props.wrap ? (raw + props.media.length) % props.media.length : raw;
    return props.media[next]?.id ?? null;
  };
  const previousId = at(-1);
  const nextId = at(1);
  const direction = props.direction ?? (props.incomingId === previousId ? -1
    : props.incomingId === nextId ? 1
      : props.media.findIndex((asset) => asset.id === props.incomingId) < index ? -1 : 1);
  const held = frontIncoming.current;
  const requestedId = props.incomingId ?? props.pendingId;
  const heldFrontId = held && requestedId && held.id !== requestedId
    && held.currentId === props.currentId && props.media.some((asset) => asset.id === held.id) ? held.id : null;
  const neighbors = props.incomingId
    ? [props.currentId, props.incomingId, heldFrontId ?? (direction > 0 ? previousId : nextId)]
    : heldFrontId ? [props.currentId, props.pendingId, heldFrontId]
    : [props.currentId, previousId ?? at(2), nextId];
  const desired = [...new Set(neighbors
    .filter((id): id is string => id !== null))].slice(0, 3);
  const assigned = slotIds.current.map((id) => id && desired.includes(id) ? id : null);
  for (const id of desired) {
    if (!assigned.includes(id)) assigned[assigned.indexOf(null)] = id;
  }
  slotIds.current = assigned;
  const offsets = assigned.map((id) => id === null ? 3 : id === props.currentId ? 0
    : id === props.incomingId ? direction : id === previousId ? -1 : 1);
  const depths = assigned.map((id) => id === props.currentId ? 0 : id === nextId ? 1 : 2);
  const slotSignature = assigned.join("|");
  const readSignature = assigned.map((id) => {
    const read = id ? props.reads[id] : undefined;
    return `${id}:${read?.status}:${read?.status === "ready" ? `${read.url}:${read.generation ?? ""}` : ""}`;
  }).join("|");
  const warmFrameIds = (props.warmIds ?? []).filter((id) => !assigned.includes(id));
  const warmSignature = warmFrameIds.map((id) => {
    const read = props.reads[id];
    return `${id}:${read?.status}:${read?.status === "ready" ? `${read.url}:${read.generation ?? ""}` : ""}`;
  }).join("|");
  // What each physical <img> last finished painting. A reassigned slot keeps
  // drawing its previous asset until the new source decodes, so a page whose
  // image still shows another asset is hidden rather than exposing that old
  // neighbour under the new identity (#489 section 5).
  const paintedImages = useRef<Array<string | null>>([null, null, null]);

  const rememberLiveFrame = useCallback(() => {
    const source = bindingRef.current;
    const frame = liveVideo.current ? videoFrame(liveVideo.current) : null;
    if (source.id && source.src && frame) {
      pendingFrames.current.get(source.id)?.();
      pendingFrames.current.delete(source.id);
      frames.current.set(source.id, { url: source.src, generation: source.generation, state: "ready", canvas: frame });
      updateRevision((value) => value + 1);
    }
  }, []);

  useLayoutEffect(() => {
    if (!props.video) { renewal.current = null; return; }
    // A failed renewed source leaves the old frame and seek target available
    // behind Story's retry action. The next signed read can use both again.
    if (!providedSource && renewal.current?.id === props.currentId
      && props.videoAssetId === props.currentId) return;
    if (binding.id === props.videoAssetId && binding.src === providedSource
      && binding.generation === providedGeneration) return;
    const video = liveVideo.current;
    const sameUrlGeneration = binding.id === props.videoAssetId
      && binding.src === providedSource && binding.generation !== providedGeneration;
    const samePresentedVideo = active && binding.id === props.videoAssetId
      && binding.id === props.currentId && binding.src && providedSource;
    if (samePresentedVideo && video) {
      // Keep the paused picture in the page while the one live transport loads
      // its renewed capability. A second renewal inherits the original seek.
      if (!renewal.current || renewal.current.id !== binding.id) {
        rememberLiveFrame();
        renewal.current = {
          id: binding.id!, src: providedSource!, generation: providedGeneration, time: video.currentTime,
          muted: video.muted, volume: video.volume, playbackRate: video.playbackRate,
          seekIssued: false, seekCompleted: false,
        };
      } else renewal.current = { ...renewal.current, src: providedSource!, generation: providedGeneration,
        seekIssued: false, seekCompleted: false };
    } else {
      renewal.current = null;
      rememberLiveFrame();
    }
    video?.pause();
    setLiveReady(null);
    setFailedLiveSource(null);
    setBinding({ id: props.videoAssetId, src: providedSource, generation: providedGeneration });
    // React does not reload an unchanged src. A successful new signed read
    // must issue fresh bytes even if its URL compares equal to the old one.
    if (sameUrlGeneration && providedSource) video?.load();
  }, [active, props.currentId, props.videoAssetId, providedSource, providedGeneration,
    binding.id, binding.src, binding.generation, Boolean(props.video), rememberLiveFrame]);

  useEffect(() => {
    const slotted = new Set(assigned.filter((id): id is string => Boolean(id)));
    // Representative frames cover the pages and the warm decode tier; decoded
    // <img> marks belong to a physical page and leave with it.
    const wanted = new Set([...slotted, ...warmFrameIds]);
    for (const [id, cancel] of pendingFrames.current) {
      if (!wanted.has(id)) { cancel(); pendingFrames.current.delete(id); }
    }
    for (const id of frames.current.keys()) if (!wanted.has(id)) frames.current.delete(id);
    for (const id of decodedImages.current.keys()) if (!slotted.has(id)) decodedImages.current.delete(id);
    for (const id of wanted) {
      const asset = latest.current.media.find((item) => item.id === id);
      const read = latest.current.reads[id];
      const existing = frames.current.get(id);
      if (!asset?.mimeType.startsWith("video/")) continue;
      if (read?.status !== "ready") {
        pendingFrames.current.get(id)?.();
        pendingFrames.current.delete(id);
        if (!(renewal.current?.id === id && existing?.canvas)) frames.current.delete(id);
        continue;
      }
      if (existing?.url === read.url && existing.generation === read.generation) continue;
      pendingFrames.current.get(id)?.();
      // A URL is a capability, not a new asset. Preserve the last decoded
      // picture until the renewed transport has sought back to that picture.
      frames.current.set(id, { url: read.url, generation: read.generation, state: "waiting", canvas: existing?.canvas });
      if (renewal.current?.id === id && renewal.current.src === read.url
        && renewal.current.generation === read.generation) continue;
      const cancel = prepareVideoFrame(read.url, (canvas) => {
        pendingFrames.current.delete(id);
        if (frames.current.get(id)?.url !== read.url
          || frames.current.get(id)?.generation !== read.generation) return;
        if (frames.current.get(id)?.state === "ready") return;
        frames.current.set(id, canvas ? { url: read.url, generation: read.generation, state: "ready", canvas }
          : { url: read.url, generation: read.generation, state: "error", message: "视频首帧暂时无法载入，请重试。" });
        updateRevision((value) => value + 1);
      });
      pendingFrames.current.set(id, cancel);
    }
  }, [slotSignature, readSignature, warmSignature]);

  const liveKey = `${binding.id}:${binding.src}:${binding.generation ?? ""}`;
  const liveSourceMatches = (element: HTMLVideoElement) => Boolean(binding.id && binding.src
    && element.currentSrc === new URL(binding.src, document.baseURI).href);
  const liveMatches = (element: HTMLVideoElement) => !element.error && liveSourceMatches(element)
    && element.readyState >= 2 && element.videoWidth > 0 && !element.seeking;
  const recordLiveReady = (event?: { type: string }) => {
    if (!liveVideo.current || liveVideo.current.error || !liveSourceMatches(liveVideo.current)) return;
    const pending = renewal.current;
    if (pending && pending.id === binding.id && pending.src === binding.src
      && pending.generation === binding.generation) {
      const video = liveVideo.current;
      video.muted = pending.muted;
      video.volume = pending.volume;
      video.playbackRate = pending.playbackRate;
      if (video.readyState < HTMLMediaElement.HAVE_METADATA) return;
      const time = Number.isFinite(video.duration) ? Math.min(pending.time, video.duration) : pending.time;
      const seekWasIssued = pending.seekIssued;
      if (!pending.seekIssued && Math.abs(video.currentTime - time) > 0.08) {
        try { video.currentTime = time; pending.seekIssued = true; } catch { return; }
      }
      if (event?.type === "seeked" && seekWasIssued) pending.seekCompleted = true;
      if (!liveMatches(video) || (pending.seekIssued && !pending.seekCompleted)
        || Math.abs(video.currentTime - time) > 0.12) return;
      renewal.current = null;
      video.pause();
    } else if (!liveMatches(liveVideo.current)) return;
    rememberLiveFrame();
    setLiveReady(liveKey);
  };
  const recordLiveError = () => {
    const video = liveVideo.current;
    const source = bindingRef.current;
    // An expired URL can fail on the next uncached native seek before the
    // expiry sweep runs. Keep the last decoded picture and the requested seek
    // time so Retry can renew the read instead of replacing the stage with a
    // blank unavailable-media panel.
    if (active && video && source.id && source.id === props.currentId && source.src
      && frames.current.get(source.id)?.canvas && !renewal.current) {
      const seek = requestedSeek.current;
      renewal.current = {
        id: source.id, src: source.src, generation: source.generation,
        time: seek?.id === source.id && seek.src === source.src
          && seek.generation === source.generation ? seek.time : video.currentTime,
        muted: video.muted, volume: video.volume, playbackRate: video.playbackRate,
        seekIssued: false, seekCompleted: false,
      };
    }
    setLiveReady(null);
    setFailedLiveSource(liveKey);
  };
  useLayoutEffect(() => {
    // Close can hand a retained fullscreen frame to the inactive inline stage
    // after its new source has already decoded. In that case no fresh browser
    // event is guaranteed; prepare the inherited seek when it becomes active.
    if (active && renewal.current?.id === props.currentId) recordLiveReady();
  }, [active, props.currentId, binding.id, binding.src, binding.generation, revision]);
  const reportImageError = (image: HTMLImageElement, id: string, url: string) => {
    const read = latest.current.reads[id];
    if (!image.isConnected || image.parentElement?.dataset.mediaPageId !== id
      || image.getAttribute("src") !== url || read?.status !== "ready" || read.url !== url) return;
    if (latest.current.active && (id === latest.current.currentId || id === latest.current.incomingId)) {
      latest.current.onMediaError(id, "图片暂时无法载入，请重试。");
    }
  };

  useEffect(() => {
    if (!active || !binding.src || liveReady === liveKey || failedLiveSource === liveKey
      || (binding.id !== props.currentId && binding.id !== props.incomingId)) return;
    const timer = window.setTimeout(() => {
      if (liveVideo.current && liveMatches(liveVideo.current)) { recordLiveReady(); return; }
      setFailedLiveSource(liveKey);
    }, 8_000);
    return () => window.clearTimeout(timer);
  }, [active, binding.id, binding.src, liveKey, liveReady, failedLiveSource, props.currentId, props.incomingId]);

  const ready = (id: string | null) => {
    if (!id) return false;
    const read = props.reads[id];
    if (read?.status !== "ready") return false;
    const asset = props.media.find((item) => item.id === id);
    if (asset?.mimeType.startsWith("video/")) {
      if (renewal.current?.id === id && renewal.current.src === read.url
        && renewal.current.generation === read.generation) return false;
      const frame = frames.current.get(id);
      return (frame?.url === read.url && frame.generation === read.generation && frame.state === "ready")
        || (binding.id === id && binding.generation === read.generation && liveReady === liveKey);
    }
    return decodedImages.current.get(id) === read.url;
  };
  const targetReady = ready(props.incomingId);
  // The pending read can clear incomingId before its replacement is decoded.
  // Keep the last painted incoming page while that newer request is pending.
  const holdingFront = Boolean(heldFrontId && !targetReady);
  const presentedId = holdingFront ? heldFrontId : props.currentId;
  const presentedAsset = props.media.find((asset) => asset.id === presentedId);
  const presentedVideo = presentedAsset?.mimeType.startsWith("video/");
  const presentedIdRef = useRef(presentedId);
  presentedIdRef.current = presentedId;
  const wasActive = useRef(active);
  const claimingPresentedBase = useRef<string | null>(null);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    let size = `${element.clientWidth}:${element.clientHeight}`;
    const observer = new ResizeObserver(() => {
      const next = `${element.clientWidth}:${element.clientHeight}`;
      if (next !== size) {
        size = next;
        // A held pointer and its spring were measured against the old stage.
        // Invalidate that generation before either can commit after rotation.
        if (drag.current || settle.current) {
          // Releasing capture does not prevent the browser from synthesizing a
          // click at the release target. That click cannot navigate the photo.
          suppressCancelledPointerClick.current = true;
          cancelGesture(true);
        }
        updateLayoutRevision((value) => value + 1);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const front = pageNodes.current[assigned.indexOf(props.currentId)];
    pageNodes.current.forEach((node, slot) => {
      if (!node) return;
      // Retained pages keep their painted aperture when their semantic role
      // changes. Only a recycled owner or an idle layout needs initialization.
      if (clipOwners.current[slot] !== assigned[slot]
        || (!props.incomingId && !holdingFront && !movingId && !interrupted.current && gesturePhase === null)) {
        const [y, x] = mediaStackClip(node, front);
        node.style.clipPath = `inset(${y}% ${x}%)`;
      }
      clipOwners.current[slot] = assigned[slot];
    });
    // #489 B root cause: the aperture is written imperatively by this effect
    // and by the handoff springs, so the stack returning to rest is the moment
    // the aperture has to be reclaimed. `incomingId` and `movingId` decide that
    // rest condition above but were missing here, so an abandoned handoff --
    // the flushSync that clears `incomingId` in updateMediaDrag, then the grab
    // that cancels the springs mid-flight -- left the presented page wearing
    // the aperture computed for a target that never arrived, and the rear pages
    // wearing none. Nothing recomputed it until the next navigation happened to
    // move one of the old dependencies, which is why the recorded exposure
    // appears mid-handoff and clears itself one navigation later.
  }, [slotSignature, props.currentId, props.incomingId, holdingFront, movingId, revision, liveReady, layoutRevision, gesturePhase]);
  useLayoutEffect(() => {
    const activated = active && !wasActive.current;
    wasActive.current = active;
    if (!activated || !holdingFront) return;
    // The inactive stage retained B's identity but never ran A -> B's spring.
    // Give B the front pose before the fullscreen clone releases its paint.
    const node = pageNodes.current[assigned.indexOf(heldFrontId)];
    if (!node) return;
    node.style.transform = mediaStackRest(0);
    node.style.opacity = String(mediaStackOpacity(0));
    node.style.clipPath = "inset(0% 0%)";
  }, [active, holdingFront, heldFrontId, slotSignature]);
  useLayoutEffect(() => {
    if (props.incomingId && targetReady) frontIncoming.current = { id: props.incomingId, currentId: props.currentId };
    else if ((!props.incomingId && !props.pendingId) || frontIncoming.current?.currentId !== props.currentId) frontIncoming.current = null;
  }, [props.incomingId, props.pendingId, props.currentId, targetReady]);
  const currentReady = ready(props.currentId);
  // #489 C/V8: a presentable target is painted in front of the page it
  // replaces, so it is already the media the viewer last saw. Shared-element
  // identity has to follow that painted foreground; publishing it from the
  // settled index instead made a close during a handoff hand the previous
  // photograph to the return morph while the new one was on screen.
  const foregroundId = props.incomingId && targetReady ? props.incomingId
    : holdingFront ? heldFrontId : props.currentId;
  useLayoutEffect(() => {
    if (!active) return;
    // Physical slots outlive their media. Carry keyboard focus with the
    // presented image before its old slot becomes an inaccessible neighbor.
    const focused = document.activeElement;
    if (focused === root.current || imageNodes.current.some((image) => image === focused)) {
      const image = imageNodes.current[assigned.indexOf(presentedId)];
      (image && !image.hidden ? image : root.current)?.focus({ preventScroll: true });
    }
  }, [active, presentedId]);
  const currentVideo = props.media.find((asset) => asset.id === props.currentId)?.mimeType.startsWith("video/");
  const playbackReady = currentReady && !props.incomingId && !movingId
    && (!currentVideo || (binding.id === props.currentId && liveReady === liveKey));
  useLayoutEffect(() => {
    props.onPlaybackReady(playbackReady ? props.currentId : null);
  }, [playbackReady, props.currentId, props.onPlaybackReady]);
  const motionHandles = useRef<SpringElementHandle[]>([]);
  const reportKey = useRef("");
  useEffect(() => {
    if (!active) return;
    const id = props.incomingId ?? props.currentId;
    if (!id) return;
    const read = props.reads[id];
    const liveFailed = binding.id === id && failedLiveSource === liveKey;
    // A passive metadata preview may fail on a browser that can play the
    // live source. Only the actual transport can declare that source failed.
    const message = liveFailed ? "视频暂时无法播放，请重试。" : null;
    const key = `${id}:${read?.status}:${read?.status === "ready" ? read.generation ?? "" : ""}:${message}`;
    if (read?.status === "ready" && message && reportKey.current !== key) {
      reportKey.current = key;
      props.onMediaError(id, message, Boolean(renewal.current?.id === id && frames.current.get(id)?.canvas));
    }
    if (!message) reportKey.current = "";
  }, [active, revision, readSignature, failedLiveSource, liveKey, props.currentId, props.incomingId]);

  useLayoutEffect(() => {
    const id = props.incomingId;
    const generation = ++handoffGeneration.current;
    let cancelled = false;
    let completed = false;
    const recovering = !id || !targetReady;
    if (!active || (recovering && !interrupted.current && !holdingFront)) { setMovingId(null); return; }
    if (holdingFront) {
      // Freeze the interrupted handoff where it is painted: B keeps the front
      // and its pose, and the next run springs from it once C is presentable.
      setMovingId(id ?? heldFrontId);
      return () => { interrupted.current = true; };
    }
    const finish = () => {
      if (cancelled || generation !== handoffGeneration.current || !latest.current.active
        || latest.current.incomingId !== id || latest.current.currentId !== props.currentId) return;
      completed = true;
      interrupted.current = false;
      setMovingId(null);
      if (id && targetReady) latest.current.onSettled(id);
    };
    if (prefersReducedMotion()) { finish(); return; }
    rememberLiveFrame();
    liveVideo.current?.pause();
    // Recovery owns presentation too: never reveal the stationary video over
    // a still-moving retained frame. The live transport returns at rest.
    setMovingId(id ?? props.currentId);
    const animations = pageNodes.current.flatMap((node, slot) => {
      const assetId = assigned[slot];
      if (!node || !assetId) return [];
      const isCurrent = assetId === props.currentId;
      const isTarget = assetId === id;
      const depth = recovering ? depths[slot]
        : isTarget ? 0 : isCurrent ? (direction > 0 ? 2 : 1) : depths[slot];
      // #489 B: paint order is published by the render below and nowhere else.
      // Writing it here too made the DOM diverge from the order React believes
      // it rendered, and React skips the corrective write whenever its own
      // value is unchanged -- so a handoff that ended without changing the
      // presented identity left the stack painted in the abandoned order.
      const front = pageNodes.current[assigned.indexOf(recovering ? props.currentId : id)];
      return [springElementTo(node, { transform: mediaStackRest(depth), opacity: mediaStackOpacity(depth),
        clipInset: mediaStackClip(node, front) },
        { owner: assetId })];
    });
    motionHandles.current = animations;
    interrupted.current = false;
    void Promise.all(animations.map((animation) => animation.finished)).then(finish, () => undefined);
    return () => {
      cancelled = true;
      for (const animation of animations) animation.cancel();
      // cancel freezes both position and velocity. The next spring consumes
      // that state, including another reversal during recovery.
      interrupted.current = !completed;
    };
  }, [active, props.currentId, props.incomingId, targetReady, holdingFront, direction, rememberLiveFrame, recoveryRevision, layoutRevision]);

  function grabPages(neighborId: string | null) {
    ++handoffGeneration.current;
    for (const handle of motionHandles.current) handle.cancel();
    // The pointer owns the current page and the neighbor it reveals. Every
    // other retained page returns to rest under this same stage owner.
    motionHandles.current = pageNodes.current.flatMap((node) => {
      const id = node?.dataset.mediaPageId;
      if (!node || !id || id === latest.current.currentId || id === neighborId) return [];
      const depth = Number(node.style.getPropertyValue("--stack-depth")) || 1;
      const spring = springElementTo(node, {
        transform: mediaStackRest(depth), opacity: mediaStackOpacity(depth),
      }, { owner: id });
      void spring.finished.catch(() => undefined);
      return [spring];
    });
    interrupted.current = false;
    setMovingId(null);
  }

  function recoverPages() {
    interrupted.current = true;
    requestRecovery((value) => value + 1);
  }

  function gestureIsCurrent(value: MediaDrag) {
    return value.generation === gestureGeneration.current
      && latest.current.active && latest.current.scopeKey === value.scopeKey
      && (latest.current.currentId === value.baseId || presentedIdRef.current === value.baseId)
      && value.base.isConnected && value.base.dataset.mediaPageId === value.baseId;
  }

  function releaseCapture(value: MediaDrag) {
    const element = root.current;
    try {
      if (element?.hasPointerCapture(value.pointerId)) element.releasePointerCapture(value.pointerId);
    } catch { /* A browser cancellation may already have released it. */ }
  }

  function clearDragPresentation(value: MediaDrag) {
    const element = root.current;
    const ownedPageMotion = value.axis === "x" || value.settleTakeover;
    element?.style.removeProperty("--story-drag-x");
    element?.style.removeProperty("--story-live-transform");
    element?.style.removeProperty("--story-live-opacity");
    element?.style.removeProperty("--story-live-z");
    element?.classList.remove("is-drag-settling");
    const shell = videoShell.current;
    if (shell && ownedPageMotion) { shell.style.transform = ""; shell.style.opacity = ""; shell.style.clipPath = ""; }
    releaseCapture(value);
    if (ownedPageMotion) {
      for (const node of [value.base, value.peek]) {
        if (!node) continue;
        node.style.transform = "";
        node.style.opacity = "";
        node.style.clipPath = "";
        node.style.transition = "";
      }
    }
    setGesturePhase(null);
    setGestureFrontId(null);
    latest.current.onGestureHoldingChange(false);
    // A cancelled gesture has no later animation event to restore apertures.
    // Reclaim the rest layout now, including after a pointercancel or Back.
    if (ownedPageMotion && !latest.current.incomingId) {
      const front = pageNodes.current.find((node) => node?.dataset.mediaPageId === latest.current.currentId) ?? null;
      pageNodes.current.forEach((node, slot) => {
        if (!node) return;
        const [y, x] = mediaStackClip(node, front);
        node.style.clipPath = `inset(${y}% ${x}%)`;
        clipOwners.current[slot] = node.dataset.mediaPageId ?? null;
      });
    }
  }

  // #530: `commitDecided` is for an interruption from outside the gesture
  // (resize, blur, fullscreen, editing). A settle whose release already landed
  // on a presentable target commits before it is finished; a spring-back, a
  // held drag, and every lifecycle caller (unmount, scope or identity change)
  // stay cleanup-only. The settle is resolved before the generation moves so
  // its commit is still judged against the gesture that decided it.
  function cancelGesture(commitDecided = false) {
    const pending = settle.current;
    settle.current = null;
    pending?.cancel(commitDecided);
    ++gestureGeneration.current;
    const held = drag.current;
    drag.current = null;
    if (held) clearDragPresentation(held);
    for (const spring of dragSprings.current) spring.cancel();
    dragSprings.current = [];
  }

  useImperativeHandle(stageRef, () => ({
    cancelGesture,
    heldVideo: () => {
      const held = renewal.current;
      const frame = held ? frames.current.get(held.id)?.canvas : null;
      return active && held?.id === props.currentId && frame
        ? { id: held.id, time: held.time, muted: held.muted, volume: held.volume,
          playbackRate: held.playbackRate, frame } : null;
    },
    adoptHeldVideo: (held) => {
      const read = latest.current.reads[held.id];
      if (latest.current.currentId !== held.id || read?.status !== "ready") return false;
      pendingFrames.current.get(held.id)?.();
      pendingFrames.current.delete(held.id);
      liveVideo.current?.pause();
      frames.current.set(held.id, { url: read.url, generation: read.generation,
        state: "waiting", canvas: held.frame });
      renewal.current = { id: held.id, src: read.url, generation: read.generation,
        time: held.time, muted: held.muted, volume: held.volume,
        playbackRate: held.playbackRate, seekIssued: false, seekCompleted: false };
      setLiveReady(null);
      setFailedLiveSource(null);
      updateRevision((value) => value + 1);
      return true;
    },
  }));

  function mediaGestureCanStart(target: EventTarget | null) {
    if (!(target instanceof Element)) return false;
    return !target.closest("button, input, select, textarea, [role='button']:not(img)");
  }

  // A swipe may start on the presented video's picture, so a video page can be
  // browsed and a phone can swipe down out of fullscreen from it. A pointer is
  // never taken by position alone: nothing is claimed until the stream locks an
  // axis, a click never navigates (#489 A2), and the native control band --
  // timeline, play, volume, overflow -- keeps every stream that starts in it.
  // Chromium's control boxes live in a closed user-agent shadow tree, so the
  // band is the one `--story-video-control-band` token the fullscreen nav
  // also clears (tokens.css). Without a readable token the whole video stays
  // with its transport rather than guessing.
  function videoGestureCanStart(event: ReactPointerEvent<HTMLDivElement>) {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest(".story-media-pages__video")) return true;
    if (!(target instanceof HTMLVideoElement)) return false;
    if (!target.controls) return true;
    const band = Number.parseFloat(getComputedStyle(target).getPropertyValue("--story-video-control-band"));
    return Number.isFinite(band) && event.clientY < target.getBoundingClientRect().bottom - band;
  }

  function neighborFor(dx: number, baseId: string) {
    if (dx === 0) return null;
    const { media, wrap } = latest.current;
    const index = media.findIndex((item) => item.id === baseId);
    if (index < 0 || media.length < 2) return null;
    const next = index + (dx < 0 ? 1 : -1);
    const target = wrap ? (next + media.length) % media.length : next;
    return media[target] ?? null;
  }

  function peekFor(id: string | null) {
    if (!id) return null;
    return pageNodes.current.find((node) => node?.dataset.mediaPageId === id
      && node.dataset.mediaPageReady === "true") ?? null;
  }

  function applyDrag(value: MediaDrag) {
    const distance = value.peek ? value.dx : value.dx * 0.3;
    const transform = `${mediaStackPull(distance, value.width)} ${value.originTransform === "none" ? "" : value.originTransform}`;
    value.base.style.transform = transform;
    root.current?.style.setProperty("--story-drag-x", `${distance}px`);
    root.current?.style.setProperty("--story-live-transform", transform);
    if (value.peek) {
      const depth = Number(value.peek.style.getPropertyValue("--stack-depth")) || 1;
      value.peek.style.transform = mediaStackReveal(depth, Math.abs(distance) / value.width);
    }
  }

  function beginGesture(event: ReactPointerEvent<HTMLDivElement>) {
    latest.current.onGestureConsumed(false);
    if (!event.isPrimary || !latest.current.active || !latest.current.gestureEnabled
      || latest.current.media.length < 2 || !mediaGestureCanStart(event.target)
      || !videoGestureCanStart(event)) return;
    const prior = settle.current;
    if (prior) prior.finishForTakeover();
    const base = pageNodes.current.find((node) => node?.dataset.mediaPresented === "true");
    const baseId = base?.dataset.mediaPageId;
    if (!base || !baseId) return;
    const originTransform = getComputedStyle(base).transform;
    root.current?.style.setProperty("--story-live-transform", originTransform);
    root.current?.style.setProperty("--story-live-opacity", getComputedStyle(base).opacity);
    const value: MediaDrag = {
      base, baseId, peek: null, startX: event.clientX, startY: event.clientY,
      pointerId: event.pointerId, dx: 0, velocityX: 0, lastX: event.clientX,
      lastTime: event.timeStamp, axis: null, width: base.clientWidth,
      originTransform, neighborId: null,
      tapOpensFullscreen: latest.current.mobileLayout && !latest.current.fullscreen
        && event.target instanceof HTMLImageElement,
      generation: ++gestureGeneration.current, scopeKey: latest.current.scopeKey,
      settleTakeover: Boolean(prior),
      // On a video picture a small wobble belongs to the transport: its taps,
      // pointerup and control reveal stay native. Only travel that is already
      // a swipe by distance lets the stage claim the stream.
      axisLock: event.target instanceof HTMLVideoElement ? MEDIA_SWIPE_DISTANCE_PX : 8,
    };
    drag.current = value;
    if (prior) setGesturePhase("dragging");
    latest.current.onGestureHoldingChange(true);
  }

  function updateGesture(event: ReactPointerEvent<HTMLDivElement>) {
    const value = drag.current;
    if (!event.isPrimary || !value || value.pointerId !== event.pointerId || !gestureIsCurrent(value)) return;
    if (value.axis === null) {
      const dx = event.clientX - value.startX;
      const dy = event.clientY - value.startY;
      if (Math.abs(dx) < value.axisLock && Math.abs(dy) < value.axisLock) return;
      if (Math.abs(dx) <= Math.abs(dy) * 1.15) { value.axis = "y"; return; }
      value.axis = "x";
      // The gesture owns this pointer from here through release, including a
      // compatibility click synthesized after capture is lost on resize.
      suppressCancelledPointerClick.current = true;
      for (const spring of dragSprings.current) spring.cancel();
      dragSprings.current = [];
      if (value.baseId !== latest.current.currentId) claimingPresentedBase.current = value.baseId;
      flushSync(() => latest.current.onGestureClaim(value.baseId));
      if (!gestureIsCurrent(value)) return;
      value.originTransform = getComputedStyle(value.base).transform;
      root.current?.style.setProperty("--story-live-transform", value.originTransform);
      root.current?.style.setProperty("--story-live-opacity", getComputedStyle(value.base).opacity);
      grabPages(neighborFor(dx, value.baseId)?.id ?? null);
      setGesturePhase("dragging");
      try { event.currentTarget.setPointerCapture(value.pointerId); }
      catch { /* A cancelled pointer can no longer be captured. */ }
    }
    if (value.axis !== "x") return;
    value.dx = event.clientX - value.startX;
    const elapsed = event.timeStamp - value.lastTime;
    if (elapsed > 0) {
      value.velocityX = nextMediaSwipeVelocity(value.velocityX, event.clientX - value.lastX, elapsed);
      value.lastX = event.clientX;
      value.lastTime = event.timeStamp;
    }
    const neighbor = neighborFor(value.dx, value.baseId);
    const peek = peekFor(neighbor?.id ?? null);
    if (value.neighborId !== (neighbor?.id ?? null) || value.peek !== peek) {
      value.neighborId = neighbor?.id ?? null;
      value.peek = peek;
      setGestureFrontId(peek?.dataset.mediaPageId ?? null);
      grabPages(value.neighborId);
    }
    applyDrag(value);
  }

  function settleGesture(commit: boolean, releaseVelocityX = 0, tapAfterSettle = false) {
    const value = drag.current;
    drag.current = null;
    if (!value) return;
    releaseCapture(value);
    if (value.axis !== "x" || !gestureIsCurrent(value)) {
      if (value.settleTakeover) recoverPages();
      clearDragPresentation(value);
      return;
    }
    const targetId = commit ? value.neighborId : null;
    const targetRead = targetId ? latest.current.reads[targetId] : null;
    const readyToLand = Boolean(targetId && value.peek && targetRead?.status === "ready"
      && value.peek.dataset.mediaPageId === targetId
      && value.peek.dataset.mediaPageReady === "true");
    if (targetId && !readyToLand) latest.current.onGesturePrepare(targetId);
    let allowTapAfterSettle = tapAfterSettle;
    const complete = () => {
      if (!gestureIsCurrent(value)) { clearDragPresentation(value); return; }
      const targetStillReady = readyToLand && targetId && value.peek?.isConnected
        && value.peek.dataset.mediaPageId === targetId
        && value.peek.dataset.mediaPageReady === "true"
        && latest.current.media.some((asset) => asset.id === targetId)
        && latest.current.reads[targetId]?.status === "ready";
      if (targetId && targetStillReady) flushSync(() => latest.current.onGestureCommit(targetId));
      clearDragPresentation(value);
      // The stage is the only owner of this spring's completion. A later
      // pointer, scope change or surface exit invalidates this exact gesture.
      if (allowTapAfterSettle && gestureIsCurrent(value)) latest.current.onGestureTapAfterSettle?.();
    };
    if (prefersReducedMotion()) { complete(); return; }
    setGesturePhase("settling");
    setGestureFrontId(readyToLand ? targetId : value.peek?.dataset.mediaPageId ?? null);
    const rearDepth = readyToLand ? (value.dx < 0 ? 2 : 1) : 0;
    const targetTransform = mediaStackRest(rearDepth);
    const sampleSeconds = 1 / 120;
    const sample = (distance: number) => new DOMMatrixReadOnly(mediaStackPull(
      value.peek ? distance : distance * 0.3, value.width,
    )).multiply(new DOMMatrixReadOnly(value.originTransform === "none" ? undefined : value.originTransform)).toFloat64Array();
    const transformVelocity = springTransformVelocity(sample(value.dx),
      sample(value.dx + releaseVelocityX * 1000 * sampleSeconds), sampleSeconds);
    if (readyToLand) root.current?.style.setProperty("--story-live-z", "2");
    const front = readyToLand ? value.peek : value.base;
    const springs = [springElementTo(value.base, {
      transform: targetTransform, opacity: mediaStackOpacity(rearDepth),
      clipInset: mediaStackClip(value.base, front),
    }, { owner: value.baseId, transformVelocity })];
    const shell = videoShell.current;
    if (shell?.dataset.videoVisible === "true") springs.push(springElementTo(shell, {
      transform: targetTransform, opacity: mediaStackOpacity(rearDepth),
      clipInset: mediaStackClip(value.base, front),
    }, { owner: value.baseId, transformVelocity }));
    if (value.peek) {
      const depth = Number(value.peek.style.getPropertyValue("--stack-depth")) || 1;
      springs.push(springElementTo(value.peek, {
        transform: mediaStackRest(readyToLand ? 0 : depth),
        opacity: readyToLand ? 1 : mediaStackOpacity(depth),
        clipInset: mediaStackClip(value.peek, front),
      }, { owner: value.peek.dataset.mediaPageId }));
    }
    for (const page of pageNodes.current) {
      if (!page?.dataset.mediaPageId || page === value.base || page === value.peek) continue;
      springs.push(springElementTo(page, {
        transform: getComputedStyle(page).transform,
        clipInset: mediaStackClip(page, front),
      }, { owner: page.dataset.mediaPageId }));
    }
    dragSprings.current = springs;
    let pending = true;
    const finish = () => {
      if (!pending) return;
      pending = false;
      settle.current = null;
      dragSprings.current = [];
      complete();
    };
    const finishForTakeover = () => {
      if (!pending) return;
      allowTapAfterSettle = false;
      // A new pointer claims the painted pixels. Commit the identity first,
      // then restore the measured pose on still-owned physical slots.
      const painted = pageNodes.current.flatMap((node) => node?.dataset.mediaPageId
        ? [{ node, id: node.dataset.mediaPageId, transform: getComputedStyle(node).transform,
          opacity: getComputedStyle(node).opacity, clipPath: getComputedStyle(node).clipPath }] : []);
      for (const spring of springs) spring.cancel();
      finish();
      for (const { node, id, transform, opacity, clipPath } of painted) {
        if (node.dataset.mediaPageId !== id) continue;
        node.style.transform = transform;
        node.style.opacity = opacity;
        node.style.clipPath = clipPath;
      }
    };
    settle.current = {
      cancel: (commitDecided = false) => {
        if (!pending) return;
        if (commitDecided && readyToLand) {
          // #530: the release already chose this target. Commit it exactly as
          // a takeover would, then let the stage spring the committed stack
          // from its painted pose to rest; no later pointer will own it.
          finishForTakeover();
          recoverPages();
          return;
        }
        pending = false;
        settle.current = null;
        for (const spring of springs) spring.cancel();
        dragSprings.current = [];
        clearDragPresentation(value);
      },
      finishForTakeover,
    };
    void Promise.all(springs.map((spring) => spring.finished)).then(finish, () => undefined);
  }

  function finishPointer(event: ReactPointerEvent<HTMLDivElement>) {
    if (!event.isPrimary) return;
    const value = drag.current;
    if (!value) { if (props.fullscreen) props.onGestureRevealFullscreenControls?.(); return; }
    if (value.pointerId !== event.pointerId) return;
    const dx = event.clientX - value.startX;
    const dy = event.clientY - value.startY;
    value.dx = dx;
    const velocity = event.timeStamp - value.lastTime <= MEDIA_SWIPE_VELOCITY_MAX_AGE_MS ? value.velocityX : 0;
    const swipe = value.axis === "x" && isMediaSwipeIntent(dx, velocity);
    const commit = value.axis === "x" && shouldCommitMediaSwipe(dx, velocity, Boolean(value.neighborId));
    const tapAfterSettle = value.axis === "x" && !swipe && value.tapOpensFullscreen;
    if (swipe || tapAfterSettle || (!props.mobileLayout && value.axis !== null)) {
      latest.current.onGestureConsumed(true);
    }
    settleGesture(commit, velocity, tapAfterSettle);
    if (props.fullscreen && props.mobileLayout && value.axis !== "x"
      && dy >= 72 && Math.abs(dy) > Math.abs(dx) * 1.15) {
      latest.current.onGestureExitFullscreen?.();
    } else if (props.fullscreen && value.axis === null) {
      latest.current.onGestureRevealFullscreenControls?.();
    }
  }

  useLayoutEffect(() => {
    if (gestureScope.current !== props.scopeKey || !active) cancelGesture();
    gestureScope.current = props.scopeKey;
  }, [active, props.scopeKey]);
  useLayoutEffect(() => {
    if (gestureCurrentId.current !== props.currentId && (drag.current || settle.current)) {
      // Claiming an already painted B makes it the semantic owner inside the
      // same pointer stream. Other identity changes still cancel that stream.
      if (claimingPresentedBase.current === props.currentId && drag.current?.baseId === props.currentId) {
        claimingPresentedBase.current = null;
      } else cancelGesture();
    }
    gestureCurrentId.current = props.currentId;
  }, [props.currentId]);
  useLayoutEffect(() => () => {
    cancelGesture();
    for (const handle of motionHandles.current) handle.cancel();
  }, []);

  useLayoutEffect(() => {
    if (!active) liveVideo.current?.pause();
  }, [active]);
  useLayoutEffect(() => () => {
    for (const cancel of pendingFrames.current.values()) cancel();
    pendingFrames.current.clear();
    liveVideo.current?.pause();
    latest.current.onPlaybackReady(null);
  }, []);

  const videoOffset = binding.id === props.currentId ? 0 : binding.id === props.incomingId ? direction : 2;
  const videoVisible = active && !movingId && props.videoAssetId === binding.id
    && liveReady === liveKey && failedLiveSource !== liveKey
    && binding.id === props.currentId;
  const heldRenewalFrame = renewal.current?.id === props.currentId
    && Boolean(frames.current.get(props.currentId ?? "")?.canvas);
  const videoSource = retainedVideo.current;
  const canNavigate = Boolean(props.onNavigate && (props.canNavigatePrevious || props.canNavigateNext));
  const navigationDirection = (element: HTMLElement, x: number): -1 | 1 => {
    const rect = element.getBoundingClientRect();
    return x < rect.left + rect.width / 2 ? -1 : 1;
  };
  const step = (direction: -1 | 1 | null, accessibleActivation = false) => {
    if (holdingFront && presentedId) flushSync(() => latest.current.onGestureClaim(presentedId));
    const current = latest.current;
    const resolvedDirection = direction ?? (current.canNavigateNext ? 1 : -1);
    if (resolvedDirection < 0 ? current.canNavigatePrevious : current.canNavigateNext) {
      current.onNavigate?.(resolvedDirection, accessibleActivation);
    }
  };
  // #489 A2: only a photograph resolves a click into navigation. The presented
  // video's own surface belongs to its transport, so this never binds to it and
  // no longer has to guess where a native control strip begins.
  const handlePictureClick = (event: MouseEvent<HTMLImageElement>) => {
    if (!active) return;
    const media = event.currentTarget;
    if (event.detail !== 0 && !containsMediaPoint(media, event.clientX, event.clientY)) return;
    event.stopPropagation();
    if (props.onNavigate) {
      event.preventDefault();
      step(event.detail === 0 ? null : navigationDirection(media, event.clientX), event.detail === 0);
    } else {
      props.onImageClick?.(event.detail === 0);
    }
  };
  const handleBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!active || !props.onBackdropClick || event.defaultPrevented) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target === event.currentTarget || target.classList.contains("story-media-pages__page")) {
      props.onBackdropClick();
      return;
    }
    if (!(target instanceof HTMLImageElement || target instanceof HTMLCanvasElement || target instanceof HTMLVideoElement)) return;
    // #489 A2: the presented transport owns its whole element, letterbox
    // included. Closing Story from there would race the browser's own
    // click-to-play, so the video surface never resolves into a backdrop.
    if (target instanceof HTMLVideoElement) return;
    if (!containsMediaPoint(target, event.clientX, event.clientY)) props.onBackdropClick();
  };
  const stablePictureContains = (x: number, y: number) => {
    const surface = hitSurface.current;
    if (!surface) return false;
    const rect = surface.getBoundingClientRect();
    // Only a photograph owns this surface now, so its aperture comes from the
    // presented image itself rather than from a retained video frame.
    const asset = props.media.find((item) => item.id === presentedId);
    const image = imageNodes.current[assigned.indexOf(presentedId)];
    const width = asset?.displayWidth || image?.naturalWidth || 0;
    const height = asset?.displayHeight || image?.naturalHeight || 0;
    if (!width || !height) return false;
    const scale = Math.min(rect.width / width, rect.height / height);
    return Math.abs(x - (rect.left + rect.width / 2)) <= width * scale / 2
      && Math.abs(y - (rect.top + rect.height / 2)) <= height * scale / 2;
  };
  useLayoutEffect(() => {
    if (!active || presentedVideo || props.incomingId) delete root.current?.dataset.clickDirection;
  }, [active, presentedVideo, props.incomingId]);
  // A video page has no focusable picture slot; the stage carries navigation.
  const videoStageNavigation = Boolean(presentedVideo && canNavigate);
  return <div ref={root} className="story-media-pages" data-story-media-pages
    tabIndex={videoStageNavigation ? 0 : -1}
    role={videoStageNavigation ? "group" : undefined}
    aria-label={videoStageNavigation ? `${presentedAsset?.fileName ?? "视频"}。左右方向键切换媒体` : undefined}
    aria-keyshortcuts={videoStageNavigation ? "ArrowLeft ArrowRight" : undefined}
    onPointerDownCapture={(event) => {
      if (event.isPrimary) suppressCancelledPointerClick.current = false;
    }}
    onPointerDown={beginGesture}
    onPointerUp={finishPointer}
    onPointerCancel={(event) => {
      if (drag.current?.pointerId !== event.pointerId) return;
      suppressCancelledPointerClick.current = true;
      settleGesture(false);
    }}
    onLostPointerCapture={(event) => {
      if (event.target !== event.currentTarget || drag.current?.pointerId !== event.pointerId) return;
      suppressCancelledPointerClick.current = true;
      settleGesture(false);
    }}
    onDragStart={(event) => event.preventDefault()}
    onKeyDown={(event) => {
      // A video has no focusable picture slot. Keep arrow navigation on the
      // stable stage without taking keys away from its native controls.
      if (event.target !== event.currentTarget || !active || !props.onNavigate) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      step(event.key === "ArrowLeft" ? -1 : 1, true);
    }}
    style={{ "--media-settle-duration": `${MEDIA_STACK_DURATION}ms`, "--media-settle-easing": MEDIA_STACK_EASING } as CSSProperties}
    onClickCapture={(event) => {
      if (!suppressCancelledPointerClick.current || event.detail === 0) return;
      suppressCancelledPointerClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    }}
    onClick={handleBackdropClick}
    onPointerMove={(event) => {
      updateGesture(event);
      if (presentedVideo || props.incomingId || !props.onNavigate) {
        delete event.currentTarget.dataset.clickDirection;
        return;
      }
      if (!hitSurface.current || !stablePictureContains(event.clientX, event.clientY)) {
        delete event.currentTarget.dataset.clickDirection;
        return;
      }
      const direction = navigationDirection(hitSurface.current, event.clientX);
      event.currentTarget.dataset.clickDirection = direction < 0 && props.canNavigatePrevious ? "previous"
        : direction > 0 && props.canNavigateNext ? "next" : "";
    }}
    onPointerLeave={(event) => { delete event.currentTarget.dataset.clickDirection; }}
    data-click-navigation={props.onNavigate ? "true" : undefined}
    data-current-media-kind={presentedId ? (presentedVideo ? "video" : "image") : undefined}
    data-media-presentation={gesturePhase ?? (movingId ? "moving" : props.incomingId ? "waiting" : "settled")}>
    {assigned.map((id, slot) => {
      const asset = props.media.find((item) => item.id === id);
      const read = id ? props.reads[id] : undefined;
      const isVideo = asset?.mimeType.startsWith("video/");
      const current = id !== null && id === props.currentId;
      const presented = id !== null && id === presentedId;
      const url = read?.status === "ready" ? read.url : undefined;
      const pageReady = ready(id);
      const layer = id && read?.status === "ready" ? mediaPreviewLayer({
        assetId: id,
        readAssetId: id,
        read,
        originalReady: pageReady,
      }) : null;
      return <div key={slot} ref={(element) => { pageNodes.current[slot] = element; }}
        className="story-media-pages__page"
        data-media-page={current ? "current" : offsets[slot] < 0 ? "previous" : "next"}
        data-media-page-id={id ?? undefined} data-media-page-ready={pageReady ? "true" : "false"}
        data-media-layer={layer?.kind}
        data-media-preview-asset={layer?.kind === "preview" ? layer.assetId : undefined}
        data-media-preview-width={layer?.kind === "preview" ? layer.frame?.width : undefined}
        data-media-preview-height={layer?.kind === "preview" ? layer.frame?.height : undefined}
        data-media-incoming={id !== null && id === props.incomingId ? "true" : undefined}
        data-media-presented={presented ? "true" : undefined}
        aria-hidden={!presented} style={{
          "--page-offset": offsets[slot], "--stack-depth": depths[slot],
          // A physical slot changes owners without remounting. Commit its
          // painted order with that identity, including synchronous reduced-
          // motion handoffs, so a former top page cannot intercept the next tap.
          // One render writer also accounts for the page held in front during
          // a gesture before the semantic selection is committed.
          zIndex: gestureFrontId && id === gestureFrontId ? 5
            : gestureFrontId && current ? 2
              : current ? (props.incomingId && (targetReady || holdingFront) ? 2 : 5)
                : id !== null && id === props.incomingId && targetReady ? 4
                  : holdingFront && id === heldFrontId ? 4 : 3 - depths[slot],
          transform: mediaStackRest(depths[slot]),
          opacity: mediaStackOpacity(depths[slot]),
          // Same-asset layer authority keeps the preview under this physical
          // page until its own original is decoded/presentable.
          backgroundImage: layer?.kind === "preview"
            ? `url(${JSON.stringify(layer.url)})` : undefined,
          backgroundSize: "contain", backgroundPosition: "center", backgroundRepeat: "no-repeat",
          pointerEvents: presented ? "auto" : "none",
        } as CSSProperties}>
        <img ref={(element) => { imageNodes.current[slot] = element; }}
          src={!isVideo ? url : undefined}
          hidden={isVideo || !url || (!pageReady && paintedImages.current[slot] !== id)}
          alt={presented ? asset?.fileName ?? "" : ""}
          draggable={false} decoding="async"
          role={presented && (canNavigate || props.onImageClick) ? "button" : undefined}
          tabIndex={presented && pageReady && (canNavigate || props.onImageClick) ? 0 : -1}
          aria-label={presented && canNavigate
            ? `${asset?.fileName ?? "照片"}。左侧上一张，右侧下一张，方向键切换`
            : presented && props.onImageClick ? `沉浸查看：${asset?.fileName ?? "照片"}` : undefined}
          aria-keyshortcuts={presented && canNavigate ? "ArrowLeft ArrowRight" : undefined}
          data-shared-media-id={id !== null && id === foregroundId && !isVideo && pageReady ? id : undefined}
          data-shared-journey-cover={id !== null && id === foregroundId && !isVideo && pageReady && id === props.coverId ? "true" : undefined}
          onLoad={(event) => {
            const image = event.currentTarget;
            if (!id || !url) return;
            const mark = () => {
              if (!image.isConnected || image.getAttribute("src") !== url || !image.naturalWidth) return;
              decodedImages.current.set(id, url);
              paintedImages.current[slot] = id;
              updateRevision((value) => value + 1);
            };
            if (typeof image.decode === "function") void image.decode().then(mark, () => reportImageError(image, id, url));
            else mark();
          }}
          onError={(event) => {
            if (id && url) reportImageError(event.currentTarget, id, url);
          }}
          onClick={presented && (props.onNavigate || props.onImageClick) ? handlePictureClick : undefined}
          onKeyDown={presented && (props.onNavigate || props.onImageClick) ? (event) => {
            if (props.onNavigate && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
              event.preventDefault();
              event.stopPropagation();
              step(event.key === "ArrowLeft" ? -1 : 1, true);
              return;
            }
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            if (props.onNavigate) step(null, true);
            else props.onImageClick?.(true);
          } : undefined} />
        <FrameCanvas frame={isVideo && id ? frames.current.get(id)?.canvas : undefined}
          sharedId={isVideo && id !== null && id === foregroundId && pageReady
            && (!videoVisible || id !== props.currentId) ? id : undefined} />
      </div>;
    })}
    {/* #489 A1: a photograph's stationary click surface must never cover the
        presented video. A clipped strip still left the transport's own picture
        behind a navigation layer, so the video keeps its whole surface and
        navigates by the separate buttons or the arrow keys the stage advertises. */}
    {props.onNavigate && active && ready(presentedId) && !presentedVideo ? <div ref={hitSurface}
      className="story-media-pages__hit-surface" data-story-hit-surface aria-hidden="true"
      draggable={false}
      onClick={(event) => {
        event.stopPropagation();
        if (!stablePictureContains(event.clientX, event.clientY)) { props.onBackdropClick?.(); return; }
        const image = imageNodes.current[assigned.indexOf(presentedId)];
        (image && !image.hidden ? image : root.current)?.focus({ preventScroll: true });
        step(navigationDirection(event.currentTarget, event.clientX));
      }} /> : null}
    <div ref={videoShell} className="story-media-pages__video" data-video-visible={videoVisible ? "true" : "false"}
      style={{ "--page-offset": videoOffset } as CSSProperties}>
      {videoSource ? cloneElement(videoSource, {
        key: "story-persistent-video", ref: bindVideo, src: binding.src,
        preload: active && (binding.id === props.currentId || binding.id === props.incomingId) ? "auto" : "metadata",
        hidden: !videoVisible, "aria-hidden": !videoVisible,
        controls: videoVisible && binding.id === props.currentId,
        // #489 A2: the presented transport owns its own clicks. Play/pause,
        // scrub and the native controls stay reachable; navigation never
        // intercepts them.
        onClick: videoSource.props.onClick,
        // Only the presented video is a shared-element target. Priming and
        // adjacent preparation never masquerade as a viewed media asset.
        ...{
          "data-shared-media-id": videoVisible && binding.id === props.currentId ? binding.id : undefined,
          "data-shared-journey-cover": videoVisible && binding.id === props.currentId && binding.id === props.coverId ? "true" : undefined,
          "data-story-read-generation": videoVisible ? binding.generation : undefined,
        },
        onLoadedMetadata: recordLiveReady, onLoadedData: recordLiveReady,
        onCanPlay: recordLiveReady,
        onPause: rememberLiveFrame,
        onSeeking: () => {
          const video = liveVideo.current;
          if (!video || !active || !binding.id || binding.id !== props.currentId || !binding.src || renewal.current) return;
          requestedSeek.current = { id: binding.id, src: binding.src,
            generation: binding.generation, time: video.currentTime };
        },
        onSeeked: (event) => {
          if (!event.currentTarget.error && event.currentTarget.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            requestedSeek.current = null;
          }
          recordLiveReady(event);
        },
        onError: recordLiveError,
      }) : null}
    </div>
    {!currentReady && !heldRenewalFrame && !props.incomingId && props.currentId
      && props.reads[props.currentId]?.status === "ready" ? (
      <div className="starlight-media-state is-waiting" role="status">
        <StartripsJourneyCue state="waiting" size={48} />
        <div className="starlight-media-state__copy"><strong>正在准备画面…</strong></div>
      </div>
    ) : null}
    {/* A first-frame canvas makes a video page presentable, not playable. Until
        its one transport is live the page keeps that retained picture, and this
        quiet notice -- never a cover over it -- says why it has no controls. */}
    {active && currentVideo && currentReady && !heldRenewalFrame && !props.incomingId
      && !movingId && gesturePhase === null && props.videoAssetId === props.currentId
      && !(binding.id === props.currentId && liveReady === liveKey)
      && failedLiveSource !== liveKey ? (
      <div className="starlight-media-state is-over-media story-media-pages__transport-state"
        role="status" data-story-transport-pending={props.currentId ?? undefined}>
        <div className="starlight-media-state__copy"><strong>正在准备画面…</strong></div>
      </div>
    ) : null}
  </div>;
});
