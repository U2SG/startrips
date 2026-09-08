import { cloneElement, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactElement, type Ref, type VideoHTMLAttributes } from "react";
import { MEDIA_STACK_DURATION, MEDIA_STACK_EASING, mediaStackDeparture, mediaStackOpacity, mediaStackRest } from "./mediaStackMotion";
import { prefersReducedMotion } from "../motion/preferences";
import { StartripsJourneyCue } from "../brand/StartripsBrandMark";
import type { JourneyMediaAsset, MediaPreviewRead } from "./types";
import "../styles/story-media-pages.css";

type Read = { status: "ready"; url: string; preview?: MediaPreviewRead } | { status: "loading" } | { status: "error"; message: string };
type VideoElement = ReactElement<VideoHTMLAttributes<HTMLVideoElement> & { ref?: Ref<HTMLVideoElement> }>;
type Frame = { url: string; state: "waiting" | "ready" | "error"; canvas?: HTMLCanvasElement; message?: string };
type Props = {
  media: readonly JourneyMediaAsset[];
  currentId: string | null;
  incomingId: string | null;
  coverId?: string | null;
  direction?: -1 | 1;
  reads: Record<string, Read>;
  wrap: boolean;
  videoAssetId: string | null;
  video: VideoElement | null;
  active?: boolean;
  onSettled: (id: string) => void;
  onMediaError: (id: string, message: string) => void;
  onPlaybackReady: (id: string | null) => void;
  onBackdropClick?: () => void;
  onImageClick?: (accessibleActivation?: boolean) => void;
  onNavigate?: (direction: -1 | 1, accessibleActivation?: boolean) => void;
  canNavigatePrevious?: boolean;
  canNavigateNext?: boolean;
};

function containsMediaPoint(element: HTMLImageElement | HTMLCanvasElement | HTMLVideoElement, x: number, y: number) {
  const rect = element.getBoundingClientRect();
  const width = element instanceof HTMLImageElement ? element.naturalWidth
    : element instanceof HTMLVideoElement ? element.videoWidth : element.width;
  const height = element instanceof HTMLImageElement ? element.naturalHeight
    : element instanceof HTMLVideoElement ? element.videoHeight : element.height;
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

function FrameCanvas({ frame }: { frame: HTMLCanvasElement | undefined }) {
  const paint = useCallback((canvas: HTMLCanvasElement | null) => {
    if (!canvas || !frame) return;
    canvas.width = frame.width;
    canvas.height = frame.height;
    canvas.getContext("2d")?.drawImage(frame, 0, 0);
  }, [frame]);
  return <canvas ref={paint} hidden={!frame} aria-hidden="true" />;
}

/** Three fixed pages and one persistent, gesture-authorized video transport. */
export function StoryMediaPages({ active = true, ...props }: Props) {
  const latest = useRef({ ...props, active });
  latest.current = { ...props, active };
  const root = useRef<HTMLDivElement>(null);
  const pageNodes = useRef<Array<HTMLDivElement | null>>([null, null, null]);
  const imageNodes = useRef<Array<HTMLImageElement | null>>([null, null, null]);
  const slotIds = useRef<Array<string | null>>([null, null, null]);
  const frames = useRef(new Map<string, Frame>());
  const pendingFrames = useRef(new Map<string, () => void>());
  const decodedImages = useRef(new Map<string, string>());
  const [revision, updateRevision] = useState(0);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [failedLiveSource, setFailedLiveSource] = useState<string | null>(null);
  const liveVideo = useRef<HTMLVideoElement | null>(null);
  const videoShell = useRef<HTMLDivElement>(null);
  const retainedVideo = useRef<VideoElement | null>(props.video);
  if (props.video) retainedVideo.current = props.video;
  const parentVideoRef = useRef<Ref<HTMLVideoElement> | undefined>(props.video?.props.ref);
  if (props.video) parentVideoRef.current = props.video.props.ref;
  const providedSource = props.video?.props.src;
  // Delay a src change for one layout phase so the old video can be painted
  // into its own page before the same transport starts loading the new source.
  const [binding, setBinding] = useState({ id: props.videoAssetId, src: providedSource });
  const bindingRef = useRef(binding);
  bindingRef.current = binding;
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
  const neighbors = props.incomingId
    ? [props.currentId, props.incomingId, direction > 0 ? previousId : nextId]
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
    return `${id}:${read?.status}:${read?.status === "ready" ? read.url : ""}`;
  }).join("|");

  const rememberLiveFrame = useCallback(() => {
    const source = bindingRef.current;
    const frame = liveVideo.current ? videoFrame(liveVideo.current) : null;
    if (source.id && source.src && frame) {
      pendingFrames.current.get(source.id)?.();
      pendingFrames.current.delete(source.id);
      frames.current.set(source.id, { url: source.src, state: "ready", canvas: frame });
      updateRevision((value) => value + 1);
    }
  }, []);

  useLayoutEffect(() => {
    if (!props.video || (binding.id === props.videoAssetId && binding.src === providedSource)) return;
    rememberLiveFrame();
    liveVideo.current?.pause();
    setLiveReady(null);
    setFailedLiveSource(null);
    setBinding({ id: props.videoAssetId, src: providedSource });
  }, [props.videoAssetId, providedSource, binding.id, binding.src, Boolean(props.video), rememberLiveFrame]);

  useEffect(() => {
    const wanted = new Set(assigned.filter((id): id is string => Boolean(id)));
    for (const [id, cancel] of pendingFrames.current) {
      if (!wanted.has(id)) { cancel(); pendingFrames.current.delete(id); }
    }
    for (const id of frames.current.keys()) if (!wanted.has(id)) frames.current.delete(id);
    for (const id of decodedImages.current.keys()) if (!wanted.has(id)) decodedImages.current.delete(id);
    for (const id of wanted) {
      const asset = latest.current.media.find((item) => item.id === id);
      const read = latest.current.reads[id];
      const existing = frames.current.get(id);
      if (!asset?.mimeType.startsWith("video/")) continue;
      if (read?.status !== "ready") {
        pendingFrames.current.get(id)?.();
        pendingFrames.current.delete(id);
        frames.current.delete(id);
        continue;
      }
      if (existing?.url === read.url) continue;
      pendingFrames.current.get(id)?.();
      frames.current.set(id, { url: read.url, state: "waiting" });
      const cancel = prepareVideoFrame(read.url, (canvas) => {
        pendingFrames.current.delete(id);
        if (frames.current.get(id)?.url !== read.url) return;
        if (!canvas && frames.current.get(id)?.state === "ready") return;
        frames.current.set(id, canvas ? { url: read.url, state: "ready", canvas }
          : { url: read.url, state: "error", message: "视频首帧暂时无法载入，请重试。" });
        updateRevision((value) => value + 1);
      });
      pendingFrames.current.set(id, cancel);
    }
  }, [slotSignature, readSignature]);

  const liveKey = `${binding.id}:${binding.src}`;
  const liveMatches = (element: HTMLVideoElement) => Boolean(binding.id && binding.src
    && element.readyState >= 2 && element.videoWidth > 0 && !element.seeking
    && element.currentSrc === new URL(binding.src, document.baseURI).href);
  const recordLiveReady = () => {
    if (!liveVideo.current || !liveMatches(liveVideo.current)) return;
    rememberLiveFrame();
    setLiveReady(liveKey);
  };
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
      const frame = frames.current.get(id);
      return (frame?.url === read.url && frame.state === "ready") || (binding.id === id && liveReady === liveKey);
    }
    return decodedImages.current.get(id) === read.url;
  };
  const targetReady = ready(props.incomingId);
  const currentReady = ready(props.currentId);
  const currentVideo = props.media.find((asset) => asset.id === props.currentId)?.mimeType.startsWith("video/");
  const playbackReady = currentReady && !props.incomingId && !movingId
    && (!currentVideo || (binding.id === props.currentId && liveReady === liveKey));
  useLayoutEffect(() => {
    props.onPlaybackReady(playbackReady ? props.currentId : null);
  }, [playbackReady, props.currentId, props.onPlaybackReady]);
  const interrupted = useRef(new Map<string, { transform: string; opacity: string }>());
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
    const key = `${id}:${read?.status}:${message}`;
    if (read?.status === "ready" && message && reportKey.current !== key) {
      reportKey.current = key;
      props.onMediaError(id, message);
    }
    if (!message) reportKey.current = "";
  }, [active, revision, readSignature, failedLiveSource, liveKey, props.currentId, props.incomingId]);

  useLayoutEffect(() => {
    const id = props.incomingId;
    if (!active || !id || !targetReady) {
      setMovingId(null);
      // Reverse/cancel keeps the pixels at their current position and settles
      // back into the same pile, without snapping to the authored rest frame.
      const recovery = active && !prefersReducedMotion() ? pageNodes.current.flatMap((node, slot) => {
        const assetId = assigned[slot];
        const from = assetId ? interrupted.current.get(assetId) : null;
        if (!node?.animate || !from) return [];
        return [node.animate([from, { transform: mediaStackRest(depths[slot]), opacity: mediaStackOpacity(depths[slot]) }],
          { duration: MEDIA_STACK_DURATION, easing: MEDIA_STACK_EASING })];
      }) : [];
      interrupted.current.clear();
      return () => { for (const animation of recovery) animation.cancel(); };
    }
    let cancelled = false;
    const finish = () => {
      if (cancelled || !latest.current.active || latest.current.incomingId !== id) return;
      latest.current.onSettled(id);
    };
    if (prefersReducedMotion() || !root.current?.animate) { finish(); return; }
    // Pages carry the handoff, including the last drawn frame of a departing
    // video. The one live transport reappears only on its settled own page.
    rememberLiveFrame();
    liveVideo.current?.pause();
    setMovingId(id);
    const animations = pageNodes.current.flatMap((node, slot) => {
      if (!node || !assigned[slot]) return [];
      const isCurrent = assigned[slot] === props.currentId;
      const isTarget = assigned[slot] === id;
      if (!isCurrent && !isTarget) return [];
      const assetId = assigned[slot]!;
      const from = interrupted.current.get(assetId) ?? {
        transform: getComputedStyle(node).transform,
        opacity: getComputedStyle(node).opacity,
      };
      const keyframes = isCurrent
        ? mediaStackDeparture(direction, node.clientWidth, direction > 0 ? 2 : 1)
        : [from, { transform: mediaStackRest(0), opacity: 1 }];
      keyframes[0] = { ...keyframes[0], ...from };
      return [node.animate(keyframes,
        { duration: MEDIA_STACK_DURATION, easing: MEDIA_STACK_EASING, fill: "forwards" })];
    });
    void Promise.all(animations.map((animation) => animation.finished)).then(finish, () => undefined);
    interrupted.current.clear();
    return () => {
      cancelled = true;
      if (latest.current.currentId === props.currentId) {
        for (const [slot, node] of pageNodes.current.entries()) {
          const assetId = assigned[slot];
          if (node && assetId) {
            const style = getComputedStyle(node);
            interrupted.current.set(assetId, { transform: style.transform, opacity: style.opacity });
          }
        }
      }
      for (const animation of animations) animation.cancel();
    };
  }, [active, props.currentId, props.incomingId, targetReady, direction, rememberLiveFrame]);

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
  const videoVisible = active && !movingId && props.videoAssetId === binding.id && liveReady === liveKey
    && binding.id === props.currentId;
  const videoSource = retainedVideo.current;
  const canNavigate = Boolean(props.onNavigate && (props.canNavigatePrevious || props.canNavigateNext));
  const navigationDirection = (element: HTMLElement, x: number): -1 | 1 => {
    const rect = element.getBoundingClientRect();
    return x < rect.left + rect.width / 2 ? -1 : 1;
  };
  const step = (direction: -1 | 1, accessibleActivation = false) => {
    if (direction < 0 ? props.canNavigatePrevious : props.canNavigateNext) {
      props.onNavigate?.(direction, accessibleActivation);
    }
  };
  const handlePictureClick = (event: MouseEvent<HTMLImageElement | HTMLVideoElement>) => {
    if (!active) return;
    const media = event.currentTarget;
    const rect = media.getBoundingClientRect();
    if (media instanceof HTMLVideoElement && media.controls
      && event.clientY >= rect.bottom - Math.min(72, rect.height * .25)) return;
    if (event.detail !== 0 && !containsMediaPoint(media, event.clientX, event.clientY)) return;
    event.stopPropagation();
    if (props.onNavigate) {
      event.preventDefault();
      step(event.detail === 0 ? (props.canNavigateNext ? 1 : -1) : navigationDirection(media, event.clientX), event.detail === 0);
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
    const rect = target.getBoundingClientRect();
    // Match Story's native control strip guard. A scrubber or playback control
    // remains interactive even when the contained picture has space below it.
    if (target instanceof HTMLVideoElement && target.controls
      && event.clientY >= rect.bottom - Math.min(72, rect.height * 0.25)) return;
    if (!containsMediaPoint(target, event.clientX, event.clientY)) props.onBackdropClick();
  };
  return <div ref={root} className="story-media-pages" data-story-media-pages
    style={{ "--media-settle-duration": `${MEDIA_STACK_DURATION}ms`, "--media-settle-easing": MEDIA_STACK_EASING } as CSSProperties}
    onClick={handleBackdropClick}
    onPointerMove={props.onNavigate ? (event) => {
      const target = event.target;
      if (!(target instanceof HTMLImageElement || target instanceof HTMLVideoElement)
        || !containsMediaPoint(target, event.clientX, event.clientY)) {
        delete event.currentTarget.dataset.clickDirection;
        return;
      }
      const bounds = target.getBoundingClientRect();
      const direction = navigationDirection(target, event.clientX);
      const nativeControls = target instanceof HTMLVideoElement && target.controls
        && event.clientY >= bounds.bottom - Math.min(72, bounds.height * .25);
      event.currentTarget.dataset.clickDirection = nativeControls ? ""
        : direction < 0 && props.canNavigatePrevious ? "previous"
          : direction > 0 && props.canNavigateNext ? "next" : "";
    } : undefined}
    onPointerLeave={(event) => { delete event.currentTarget.dataset.clickDirection; }}
    data-click-navigation={props.onNavigate ? "true" : undefined}
    data-media-presentation={movingId ? "moving" : props.incomingId ? "waiting" : "settled"}>
    {assigned.map((id, slot) => {
      const asset = props.media.find((item) => item.id === id);
      const read = id ? props.reads[id] : undefined;
      const isVideo = asset?.mimeType.startsWith("video/");
      const current = id !== null && id === props.currentId;
      const url = read?.status === "ready" ? read.url : undefined;
      const pageReady = ready(id);
      return <div key={slot} ref={(element) => { pageNodes.current[slot] = element; }}
        className="story-media-pages__page"
        data-media-page={current ? "current" : offsets[slot] < 0 ? "previous" : "next"}
        data-media-page-id={id ?? undefined} data-media-page-ready={pageReady ? "true" : "false"}
        data-media-incoming={id !== null && id === props.incomingId ? "true" : undefined}
        aria-hidden={!current} style={{
          "--page-offset": offsets[slot], "--stack-depth": depths[slot],
          // A physical slot changes owners without remounting. Commit its
          // painted order with that identity, including synchronous reduced-
          // motion handoffs, so a former top page cannot intercept the next tap.
          zIndex: current ? 5 : id !== null && id === props.incomingId ? 4 : 3 - depths[slot],
          transform: mediaStackRest(depths[slot]),
          opacity: mediaStackOpacity(depths[slot]),
          // A signed preview belongs to this exact asset. It holds the same
          // contained frame until the original image/video is actually ready.
          backgroundImage: !pageReady && read?.status === "ready" && read.preview
            ? `url(${JSON.stringify(read.preview.url)})` : undefined,
          backgroundSize: "contain", backgroundPosition: "center", backgroundRepeat: "no-repeat",
          pointerEvents: current ? "auto" : "none",
        } as CSSProperties}>
        <img ref={(element) => { imageNodes.current[slot] = element; }}
          src={!isVideo ? url : undefined} hidden={isVideo || !url} alt={current ? asset?.fileName ?? "" : ""}
          draggable={false} decoding="async"
          role={current && (canNavigate || props.onImageClick) ? "button" : undefined}
          tabIndex={current && pageReady && (canNavigate || props.onImageClick) ? 0 : -1}
          aria-label={current && canNavigate
            ? `${asset?.fileName ?? "照片"}。左侧上一张，右侧下一张，方向键切换`
            : current && props.onImageClick ? `沉浸查看：${asset?.fileName ?? "照片"}` : undefined}
          aria-keyshortcuts={current && canNavigate ? "ArrowLeft ArrowRight" : undefined}
          data-shared-media-id={current && !isVideo && pageReady ? id : undefined}
          data-shared-journey-cover={current && !isVideo && pageReady && id === props.coverId ? "true" : undefined}
          onLoad={(event) => {
            const image = event.currentTarget;
            if (!id || !url) return;
            const mark = () => {
              if (!image.isConnected || image.getAttribute("src") !== url || !image.naturalWidth) return;
              decodedImages.current.set(id, url);
              updateRevision((value) => value + 1);
            };
            if (typeof image.decode === "function") void image.decode().then(mark, () => reportImageError(image, id, url));
            else mark();
          }}
          onError={(event) => {
            if (id && url) reportImageError(event.currentTarget, id, url);
          }}
          onClick={current && (props.onNavigate || props.onImageClick) ? handlePictureClick : undefined}
          onKeyDown={current && (props.onNavigate || props.onImageClick) ? (event) => {
            if (props.onNavigate && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
              event.preventDefault();
              event.stopPropagation();
              step(event.key === "ArrowLeft" ? -1 : 1, true);
              return;
            }
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            if (props.onNavigate) step(props.canNavigateNext ? 1 : -1, true);
            else props.onImageClick?.(true);
          } : undefined} />
        <FrameCanvas frame={isVideo && id ? frames.current.get(id)?.canvas : undefined} />
      </div>;
    })}
    <div ref={videoShell} className="story-media-pages__video" data-video-visible={videoVisible ? "true" : "false"}
      style={{ "--page-offset": videoOffset } as CSSProperties}>
      {videoSource ? cloneElement(videoSource, {
        key: "story-persistent-video", ref: bindVideo, src: binding.src,
        preload: active && (binding.id === props.currentId || binding.id === props.incomingId) ? "auto" : "metadata",
        hidden: !videoVisible, "aria-hidden": !videoVisible,
        controls: videoVisible && binding.id === props.currentId,
        onClick: videoVisible && props.onNavigate ? handlePictureClick : videoSource.props.onClick,
        // Only the presented video is a shared-element target. Priming and
        // adjacent preparation never masquerade as a viewed media asset.
        ...{
          "data-shared-media-id": videoVisible && binding.id === props.currentId ? binding.id : undefined,
          "data-shared-journey-cover": videoVisible && binding.id === props.currentId && binding.id === props.coverId ? "true" : undefined,
        },
        onLoadedData: recordLiveReady, onCanPlay: recordLiveReady, onSeeked: recordLiveReady,
        onError: () => setFailedLiveSource(liveKey),
      }) : null}
    </div>
    {!currentReady && !props.incomingId && props.currentId && props.reads[props.currentId]?.status === "ready" ? (
      <div className="starlight-media-state is-waiting" role="status">
        <StartripsJourneyCue state="waiting" size={48} />
        <div className="starlight-media-state__copy"><strong>正在准备画面…</strong></div>
      </div>
    ) : null}
  </div>;
}
