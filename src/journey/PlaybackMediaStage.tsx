import {
  cloneElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type Ref,
  type SyntheticEvent,
  type VideoHTMLAttributes,
} from "react";
import { StartripsJourneyCue } from "../brand/StartripsBrandMark";
import { mediaStackOpacity, mediaStackRest } from "./mediaStackMotion";
import { springElementTo } from "../motion/springElement";
import type { JourneyMediaAsset } from "./types";
import "../styles/playback-media-presentation.css";

type SlotIndex = 0 | 1;
type Slot = { asset: JourneyMediaAsset; url: string; frame: HTMLCanvasElement | null; video: VideoElement | null };
type Stage = {
  slots: [Slot | null, Slot | null];
  shown: SlotIndex | null;
  requested: SlotIndex | null;
  intent: string;
};
type VideoElement = ReactElement<VideoHTMLAttributes<HTMLVideoElement> & { ref?: Ref<HTMLVideoElement> }>;
type Props = {
  asset: JourneyMediaAsset;
  url: string | null;
  intent: string;
  stepIndex: number;
  imageReady: boolean;
  videoPositionReady: boolean;
  failed: boolean;
  buffering: boolean;
  paused: boolean;
  reduceMotion: boolean;
  video: VideoElement | null;
  videoWaitTimeoutMs: number;
  onVideoElement: (element: HTMLVideoElement | null) => void;
  onPendingChange: (pending: boolean) => void;
  onPresented: (assetId: string) => void;
  onUnavailable: () => void;
};

// Keep the departing video frame in its physical slot without keeping a second
// transport alive. Painting a canvas does not read/export private media pixels.
function retainVideoFrame(video: HTMLVideoElement): HTMLCanvasElement | null {
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;
  const frame = document.createElement("canvas");
  const bounds = video.getBoundingClientRect();
  const scale = Math.min(1, Math.max(bounds.width, bounds.height) * window.devicePixelRatio
    / Math.max(video.videoWidth, video.videoHeight));
  frame.width = Math.max(1, Math.round(video.videoWidth * scale));
  frame.height = Math.max(1, Math.round(video.videoHeight * scale));
  try {
    const context = frame.getContext("2d");
    if (!context) return null;
    context.drawImage(video, 0, 0, frame.width, frame.height);
    return frame;
  } catch {
    return null;
  }
}

function RetainedVideoFrame({ frame }: { frame: HTMLCanvasElement }) {
  const draw = useCallback((canvas: HTMLCanvasElement | null) => {
    if (!canvas) return;
    canvas.width = frame.width;
    canvas.height = frame.height;
    canvas.getContext("2d")?.drawImage(frame, 0, 0);
  }, [frame]);
  return <canvas ref={draw} aria-hidden="true" />;
}

/** Two fixed presentation slots; the director remains the only time owner. */
export function PlaybackMediaStage(props: Props) {
  const latest = useRef(props);
  latest.current = props;
  const [stage, setStage] = useState<Stage>({ slots: [null, null], shown: null, requested: null, intent: "" });
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const slots = useRef<Array<HTMLDivElement | null>>([null, null]);
  const videos = useRef<Array<HTMLVideoElement | null>>([null, null]);
  const images = useRef<Array<HTMLImageElement | null>>([null, null]);
  const videoRefs = useMemo(() => ([0, 1] as const).map((index) => (element: HTMLVideoElement | null) => {
    if (!element) videos.current[index]?.pause();
    videos.current[index] = element;
  }), []);
  const boundVideo = useRef<HTMLVideoElement | null>(null);
  const [nativeRevision, setNativeRevision] = useState(0);
  const [readyKey, setReadyKey] = useState("");
  const [presentedKey, setPresentedKey] = useState("");
  const [movingKey, setMovingKey] = useState("");
  const [failedKey, setFailedKey] = useState("");
  const requestInput = `${props.intent}:${props.url ?? ""}`;
  const requestRevision = useRef({ input: requestInput, revision: 0 });
  if (requestRevision.current.input !== requestInput) {
    requestRevision.current = { input: requestInput, revision: requestRevision.current.revision + 1 };
  }
  // A -> B -> A is a new request even if A never stopped being the retained
  // picture. In particular, restoring A's live video from its canvas must pass
  // first-frame readiness again rather than reuse A's old completion token.
  const requestKey = `${requestInput}:${requestRevision.current.revision}`;
  const requestKeyRef = useRef(requestKey);
  requestKeyRef.current = requestKey;

  useLayoutEffect(() => {
    const previous = stageRef.current;
    const nextSlots: Stage["slots"] = [null, null];
    if (previous.shown !== null) {
      let previousSlot = previous.slots[previous.shown];
      const previousVideo = videos.current[previous.shown];
      const keepsSource = previousSlot?.asset.id === props.asset.id && previousSlot.url === props.url;
      if (previousVideo && !keepsSource) {
        previousVideo.pause();
        const frame = retainVideoFrame(previousVideo);
        // Only a genuinely drawn frame is retained; never manufacture a black
        // placeholder or leave an off-screen video running as a backup owner.
        previousSlot = frame && previousSlot ? { ...previousSlot, frame } : null;
      }
      nextSlots[previous.shown] = previousSlot;
    }
    const shown = previous.shown !== null && nextSlots[previous.shown] ? previous.shown : null;
    const kept = shown === null ? null : nextSlots[shown];
    // A retained canvas is not a reusable live video. Restore the video in
    // the free slot and keep that canvas visible until the new node can draw.
    const sameSource = kept?.asset.id === props.asset.id && kept.url === props.url && !kept.frame;
    const requested: SlotIndex | null = props.url
      ? sameSource && shown !== null ? shown : shown === 0 ? 1 : 0
      : null;
    if (requested !== null && props.url) {
      nextSlots[requested] = { asset: props.asset, url: props.url, frame: null, video: props.video };
    }
    setStage({ slots: nextSlots, shown, requested, intent: props.intent });
  }, [props.asset.id, props.intent, props.url]);

  const target = stage.requested === null ? null : stage.slots[stage.requested];
  const matches = stage.intent === props.intent && target?.asset.id === props.asset.id && target.url === props.url;
  const failed = props.failed || failedKey === requestKey;
  const presented = matches && presentedKey === requestKey;
  const isVideo = props.asset.mimeType.startsWith("video/");
  const ready = matches && readyKey === requestKey && (isVideo ? props.videoPositionReady : props.imageReady);
  const pending = !failed && !presented;
  const moving = movingKey === requestKey;

  // Bind the one live video to the existing trim/transport owner. A slot role
  // changes independently of its DOM identity, so a ref callback alone cannot
  // announce every ownership change.
  useLayoutEffect(() => {
    const element = matches && stage.requested !== null && isVideo
      ? videos.current[stage.requested] : null;
    for (const video of videos.current) {
      if (video && (video !== element || pending || failed || props.paused)) video.pause();
    }
    if (boundVideo.current !== element) {
      boundVideo.current = element;
      props.onVideoElement(element);
    }
  });

  useLayoutEffect(() => {
    if (!matches || stage.requested === null) return;
    const video = videos.current[stage.requested];
    const image = images.current[stage.requested];
    const canDraw = isVideo
      ? props.videoPositionReady && video && !video.seeking && video.readyState >= 2 && video.videoWidth > 0
      : props.imageReady && image?.complete && image.naturalWidth > 0;
    if (canDraw) setReadyKey(requestKey);
  }, [isVideo, matches, nativeRevision, props.imageReady, props.videoPositionReady, requestKey, stage.requested]);

  useLayoutEffect(() => {
    props.onPendingChange(pending);
  }, [pending, props.onPendingChange]);

  // Presentation commit is distinct from pending=false: failures also stop
  // pending, but only a request that owns the visible slot may advance the
  // narrative return commit log.
  useLayoutEffect(() => {
    if (!presented) return;
    props.onPresented(props.asset.id);
  }, [presented, props.asset.id, props.onPresented]);

  useLayoutEffect(() => {
    if (!ready || failed || presented || stage.requested === null) return;
    const requested = stage.requested;
    const stillCurrent = () => requestKeyRef.current === requestKey;
    const commit = () => {
      if (!stillCurrent()) return;
      setStage((current) => {
        if (current.intent !== props.intent || current.requested !== requested) return current;
        const nextSlots: Stage["slots"] = [null, null];
        nextSlots[requested] = current.slots[requested];
        return { ...current, shown: requested, slots: nextSlots };
      });
      setPresentedKey(requestKey);
      setMovingKey("");
    };
    const shown = stage.shown;
    const from = shown === null ? null : slots.current[shown];
    const to = slots.current[requested];
    if (shown === null || props.reduceMotion || !from || !to) {
      if (to) {
        to.style.transform = mediaStackRest(0);
        to.style.opacity = "1";
        to.style.zIndex = "4";
      }
      commit();
      return;
    }
    setMovingKey(requestKey);
    if (shown === requested || stage.slots[shown]?.asset.id === props.asset.id) {
      to.style.zIndex = "4";
      const recovery = springElementTo(to, { transform: mediaStackRest(0), opacity: 1 }, { owner: props.asset.id });
      void recovery.finished.then(commit, () => undefined);
      return () => recovery.cancel();
    }
    from.style.zIndex = "2";
    to.style.zIndex = "4";
    const outgoing = springElementTo(from, { transform: mediaStackRest(1), opacity: mediaStackOpacity(1) },
      { owner: stage.slots[shown]?.asset.id });
    const incoming = springElementTo(to, { transform: mediaStackRest(0), opacity: 1 },
      { owner: props.asset.id });
    void Promise.all([outgoing.finished, incoming.finished]).then(commit, () => undefined);
    return () => { outgoing.cancel(); incoming.cancel(); };
  }, [failed, presented, props.asset.id, props.intent, props.reduceMotion, ready, requestKey, stage.requested, stage.shown]);

  const unavailable = () => {
    setFailedKey(requestKey);
    latest.current.onUnavailable();
  };
  useEffect(() => {
    // Trim positioning has its own bounded degradation in the overlay. Only
    // start the first-frame deadline after that owner has released the source.
    if (!isVideo || !props.url || !props.videoPositionReady || !pending || ready || failed || props.paused) return;
    const timer = window.setTimeout(() => {
      if (requestKeyRef.current !== requestKey) return;
      setFailedKey(requestKey);
      latest.current.onUnavailable();
    }, props.videoWaitTimeoutMs);
    return () => window.clearTimeout(timer);
  }, [failed, isVideo, pending, props.paused, props.url, props.videoPositionReady, props.videoWaitTimeoutMs, ready, requestKey]);

  useLayoutEffect(() => () => {
    for (const video of videos.current) video?.pause();
    boundVideo.current = null;
    latest.current.onVideoElement(null);
    latest.current.onPendingChange(false);
  }, []);

  const hasFrame = stage.shown !== null;
  const waiting = !failed && ((pending && !moving) || props.buffering);
  return (
    <div className="journey-playback__media playback-media-presentation"
      data-media-presentation={failed ? "error" : moving ? "moving" : pending ? "waiting" : "settled"}
      data-presented-asset={hasFrame ? stage.slots[stage.shown!]?.asset.id : undefined}
      data-requested-asset={props.asset.id}>
      {([0, 1] as const).map((index) => {
        const slot = stage.slots[index];
        const ownsTarget = matches && stage.requested === index;
        const ownsEvents = (event: SyntheticEvent<HTMLVideoElement>) => ownsTarget && !failed
          && requestKeyRef.current === requestKey && videos.current[index] === event.currentTarget;
        const videoElement = ownsTarget ? props.video : slot?.video;
        const handlers: Record<string, unknown> = {};
        if (videoElement) {
          for (const [name, handler] of Object.entries(videoElement.props)) {
            if (!/^on[A-Z]/.test(name) || typeof handler !== "function") continue;
            if (!ownsTarget) { handlers[name] = undefined; continue; }
            handlers[name] = (event: SyntheticEvent<HTMLVideoElement>) => {
              if (!ownsEvents(event)) return;
              if ((name === "onEnded" || name === "onPlaying" || name === "onTimeUpdate") && (!presented || latest.current.paused)) return;
              handler(event);
              if (name === "onError") unavailable();
              else if (name === "onSeeked" || name === "onLoadedMetadata") setNativeRevision((value) => value + 1);
            };
          }
        }
        return (
          <div key={index} ref={(element) => { slots.current[index] = element; }}
            className="playback-media-presentation__slot"
            data-media-slot={index} data-media-asset={slot?.asset.id}
            aria-hidden={stage.shown !== index}
            style={{ transform: mediaStackRest(stage.shown === index ? 0 : 1), zIndex: stage.shown === index ? 2 : 1 }}>
            {slot?.frame ? <RetainedVideoFrame frame={slot.frame} /> : slot?.asset.mimeType.startsWith("image/") ? (
              <img key={slot.asset.id} ref={(element) => { images.current[index] = element; }}
                src={slot.url} alt={slot.asset.fileName}
                onLoad={() => { if (ownsTarget) setNativeRevision((value) => value + 1); }}
                onError={() => { if (ownsTarget && requestKeyRef.current === requestKey) unavailable(); }} />
            ) : slot && videoElement ? cloneElement(videoElement, {
              ...handlers,
              key: slot.asset.id,
              ref: videoRefs[index],
              autoPlay: false,
              preload: "auto",
              onLoadedData: (event: SyntheticEvent<HTMLVideoElement>) => {
                if (ownsEvents(event)) setNativeRevision((value) => value + 1);
              },
              onCanPlay: (event: SyntheticEvent<HTMLVideoElement>) => {
                if (ownsEvents(event)) setNativeRevision((value) => value + 1);
              },
            }) : null}
          </div>
        );
      })}
      {failed ? (
        <div className="journey-playback__media-state starlight-media-state is-error" role="alert">
          <StartripsJourneyCue state="rest" size={60} className="starlight-media-state__cue" />
          <div className="starlight-media-state__copy"><strong>媒体暂时无法打开</strong><span>将继续播放下一段。</span></div>
        </div>
      ) : waiting ? (
        <div className={`journey-playback__media-state starlight-media-state is-waiting${hasFrame ? " is-over-media" : ""}`} role="status" aria-live="polite">
          {!hasFrame ? <StartripsJourneyCue state="waiting" size={60} className="starlight-media-state__cue" /> : null}
          <div className="starlight-media-state__copy"><strong>{props.buffering ? "正在缓冲视频…" : "正在打开媒体…"}</strong>{!hasFrame ? <span>准备好后继续播放。</span> : null}</div>
        </div>
      ) : null}
    </div>
  );
}
