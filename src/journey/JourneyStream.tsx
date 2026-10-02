import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type Ref, type RefObject, type WheelEvent } from "react";
import { IconArrowUp, IconChevronLeft, IconChevronRight, IconMusic, IconMusicOff, IconPlayerPlay, IconX } from "@tabler/icons-react";
import { onMotionPreferenceChange, prefersReducedMotion } from "../motion/preferences";
import { useAtlasView } from "./atlasView";
import { journeySoundtrack } from "./journeyModel";
import {
  journeyStreamEntries,
  journeyStreamLayout,
  streamAspect,
  streamOffsetFor,
  streamPictureSize,
  type JourneyStreamEntry,
  type JourneyStreamLayout,
} from "./journeyStreamModel";
import {
  isVideoAsset,
  useReaderReads,
  useReaderSoundtrack,
  useVideoStills,
  videoPosterUrl,
  type ReaderRead,
} from "./journeyReaderMedia";
import type { JourneyBookOpenTarget } from "./JourneyBook";
import { useModalFocus } from "./useModalFocus";
import { withStillFragment, type VideoStill } from "./videoStillFrame";
import type { StoryLogicalObservation } from "./storyMediaPolicy";
import type { Journey, JourneyMediaAsset } from "./types";
import "../styles/journey-stream.css";

/** px/s the stream flows on its own (Undertow's pace). */
const DRIFT_PX_S = 28;
/** Opening: the thread pours down, glides to the centre, then unfolds. */
const POUR_MS = 560;
const UNFOLD_AT_MS = 1180;
const UNFOLD_STAGGER_MS = 110;
const NOTE_AFTER_PICTURE_MS = 520;
const CLOSE_MS = 900;
/** A horizontal swipe past this distance moves to the neighbouring Journey. */
const JOURNEY_SWIPE_PX = 70;
const DRAG_SLOP_PX = 6;
/** Entries read ahead/behind the one at the centre. */
const READ_WINDOW = 4;
/**
 * Entries further than this from the centre keep their size but drop their
 * picture, so a long Journey does not keep every decoded image alive.
 */
const RENDER_WINDOW = 6;
/** Pixels of the bottom of a video that belong to its native controls. */
const VIDEO_CONTROLS_BAND_PX = 52;

type Phase = "pouring" | "centered" | "unfolded" | "closing";

function journeyRange(journey: Journey) {
  return journey.endedOn && journey.endedOn !== journey.startedOn
    ? `${journey.startedOn} — ${journey.endedOn}`
    : journey.startedOn;
}

function entryAsset(entry: JourneyStreamEntry | undefined): JourneyMediaAsset | null {
  return entry?.kind === "media" ? entry.asset : null;
}

function damp(current: number, target: number, rate: number, dt: number) {
  return target + (current - target) * Math.exp(-rate * dt);
}

/**
 * #393 trial (after Undertow): a Journey read as a flowing thread. Opens in
 * place of Story when the per-device presentation style is `stream`. The
 * thread pours from where the Journey was opened, settles in the centre and
 * unfolds into the Journey's pictures, which keep flowing down it; notes are
 * written in the margin. Only the entry at the centre may hold the live video.
 */
export function JourneyStream({
  journeys,
  journeyId,
  routePointId = null,
  initialAssetId = null,
  origin = null,
  onClose,
  onOpenClassic,
  onNavigate,
  onObservationChange,
}: {
  journeys: readonly Journey[];
  journeyId: string;
  routePointId?: string | null;
  initialAssetId?: string | null;
  /** Where on screen the Journey was opened from; the thread pours from there. */
  origin?: { x: number; y: number } | null;
  onClose: () => void;
  onOpenClassic: (target: JourneyBookOpenTarget) => void;
  onNavigate?: (journeyId: string) => void;
  onObservationChange?: (observation: StoryLogicalObservation | null) => void;
}) {
  const { readMedia } = useAtlasView();
  const journeyIndex = journeys.findIndex((candidate) => candidate.id === journeyId);
  const journey = journeyIndex >= 0 ? journeys[journeyIndex] : null;
  const previousJourney = journeyIndex > 0 ? journeys[journeyIndex - 1] : null;
  const nextJourney = journeyIndex >= 0 && journeyIndex < journeys.length - 1 ? journeys[journeyIndex + 1] : null;
  // Oldest first; drawn newest at the top so the downward flow plays forward.
  const entries = useMemo(() => (journey ? journeyStreamEntries(journey) : []), [journey]);
  const soundtrack = journey ? journeySoundtrack(journey) : null;

  const [reduced, setReduced] = useState(prefersReducedMotion);
  const [phase, setPhase] = useState<Phase>(() => (prefersReducedMotion() ? "unfolded" : "pouring"));
  const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null);
  const [active, setActive] = useState(() => {
    const byAsset = initialAssetId ? entries.findIndex((entry) => entryAsset(entry)?.id === initialAssetId) : -1;
    if (byAsset >= 0) return byAsset;
    const byPoint = routePointId
      ? entries.findIndex((entry) => entry.kind !== "intro" && entry.routePoint?.id === routePointId)
      : -1;
    return Math.max(0, byPoint);
  });
  const [naturalSizes, setNaturalSizes] = useState<Record<string, { width: number; height: number }>>({});
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [hovering, setHovering] = useState(false);
  const [paused, setPaused] = useState(false);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const flowRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);
  const centersRef = useRef<number[]>([]);
  const motionRef = useRef({ offset: 0, target: 0, velocity: 0, drift: 0, placed: false });
  const dragRef = useRef<{ x: number; y: number; lastY: number; lastTime: number; pointerId: number; moved: boolean } | null>(null);
  const draggedRef = useRef(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const timersRef = useRef<number[]>([]);
  const closingRef = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    if (reduced) {
      onClose();
      return;
    }
    setPhase("closing");
    timersRef.current.push(window.setTimeout(onClose, CLOSE_MS));
  }, [onClose, reduced]);
  const rootRef = useModalFocus<HTMLDivElement>(() => {
    if (lightbox) setLightbox(null);
    else requestClose();
  });

  useEffect(() => onMotionPreferenceChange(setReduced), []);
  useEffect(() => () => timersRef.current.forEach((timer) => window.clearTimeout(timer)), []);

  // Opening sequence.
  useEffect(() => {
    if (prefersReducedMotion()) return;
    timersRef.current.push(window.setTimeout(() => setPhase("centered"), POUR_MS));
    timersRef.current.push(window.setTimeout(() => setPhase("unfolded"), UNFOLD_AT_MS));
  }, []);

  useLayoutEffect(() => {
    const flow = flowRef.current;
    if (!flow) return;
    const measure = () => setViewport((previous) => (
      previous && previous.width === flow.clientWidth && previous.height === flow.clientHeight
        ? previous
        : { width: flow.clientWidth, height: flow.clientHeight }
    ));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(flow);
    return () => observer.disconnect();
  }, []);

  const layout: JourneyStreamLayout | null = viewport ? journeyStreamLayout(viewport.width, viewport.height) : null;

  const wantedAssets = useMemo(() => {
    const assets: JourneyMediaAsset[] = soundtrack ? [soundtrack] : [];
    for (let index = Math.max(0, active - READ_WINDOW); index <= Math.min(entries.length - 1, active + READ_WINDOW); index += 1) {
      const asset = entryAsset(entries[index]);
      if (asset) assets.push(asset);
    }
    return assets;
  }, [active, entries, soundtrack]);
  const { reads, expireRead, clearRetry } = useReaderReads(readMedia, wantedAssets);
  const stillCandidates = useMemo(() => {
    const assets: JourneyMediaAsset[] = [];
    for (let index = Math.max(0, active - 2); index <= Math.min(entries.length - 1, active + 2); index += 1) {
      const asset = entryAsset(entries[index]);
      if (asset) assets.push(asset);
    }
    return assets;
  }, [active, entries]);
  const stills = useVideoStills(reads, stillCandidates);
  const soundtrackRead = soundtrack ? reads[soundtrack.id] : undefined;
  const soundtrackUrl = soundtrackRead?.status === "ready" ? soundtrackRead.read.url : null;
  const { audioRef, musicOn, toggleMusic, reportVideo } = useReaderSoundtrack(soundtrackUrl, reduced);
  const updateVideo = useCallback(() => {
    const video = videoRef.current;
    reportVideo(video);
    setVideoPlaying(Boolean(video && !video.paused && !video.ended));
  }, [reportVideo]);

  const activeEntry = entries[active];
  const liveVideoId = activeEntry?.kind === "media" && isVideoAsset(activeEntry.asset) ? activeEntry.asset.id : null;
  // Each entry mounts its own video; one that unmounts while playing never
  // reports a pause, so every change of the live entry starts from silence.
  useEffect(() => {
    reportVideo(null);
    setVideoPlaying(false);
  }, [liveVideoId, reportVideo]);

  useEffect(() => {
    if (!journey || !activeEntry) return;
    onObservationChange?.({
      journeyId: journey.id,
      routePointId: activeEntry.kind === "intro" ? null : activeEntry.routePoint?.id ?? null,
      assetId: entryAsset(activeEntry)?.id ?? null,
      storySnapState: "in-context",
    });
  }, [activeEntry, journey, onObservationChange]);

  // Entry centres, measured in the strip, after every layout change.
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const measure = () => {
      const anchor = activeRef.current;
      const before = centersRef.current[anchor];
      centersRef.current = entries.map((_, index) => {
        const item = itemRefs.current[index];
        return item ? item.offsetTop + item.offsetHeight / 2 : Number.NaN;
      });
      const motion = motionRef.current;
      // A picture that loads late changes the heights above the reader; keep
      // the entry being read where it is.
      const after = centersRef.current[anchor];
      if (motion.placed && !dragRef.current?.moved && Number.isFinite(before) && Number.isFinite(after) && before !== after) {
        motion.offset -= after - before;
        motion.target -= after - before;
      }
      if (!motion.placed && viewport && centersRef.current.length) {
        motion.offset = motion.target = streamOffsetFor(centersRef.current[active] ?? 0, viewport.height);
        motion.placed = true;
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    return () => observer.disconnect();
    // Placement uses the opening entry once; later layouts only re-measure.
  }, [layout?.beside, layout?.pictureWidth, entries, viewport]);

  const flowing = phase === "unfolded" && !reduced && !paused && !lightbox && !hovering && !videoPlaying;
  const flowingRef = useRef(flowing);
  flowingRef.current = flowing;

  // The flow: offset follows its target; the target drifts downward until
  // the newest entry reaches the centre, and never past either end.
  useEffect(() => {
    if (!viewport) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const motion = motionRef.current;
      const centers = centersRef.current;
      const known = centers.filter(Number.isFinite);
      if (!known.length) return;
      // Newest is at the top (smallest centre) — the largest offset.
      const high = streamOffsetFor(Math.min(...known), viewport.height);
      const low = streamOffsetFor(Math.max(...known), viewport.height);
      const dragging = dragRef.current?.moved ?? false;
      motion.drift = damp(motion.drift, flowingRef.current && motion.target < high ? DRIFT_PX_S : 0, 1.6, dt);
      if (!dragging) {
        motion.target += (motion.drift + motion.velocity) * dt;
        motion.velocity *= Math.exp(-dt * 3);
      }
      motion.target = Math.min(high, Math.max(low, motion.target));
      motion.offset = damp(motion.offset, motion.target, dragging ? 30 : 9, dt);
      const strip = stripRef.current;
      if (strip) strip.style.transform = `translate3d(0, ${motion.offset.toFixed(2)}px, 0)`;
      // Entries dim into the dark near the edges; the nearest one is active.
      let nearest = activeRef.current;
      let nearestDistance = Infinity;
      itemRefs.current.forEach((item, index) => {
        if (!item || !Number.isFinite(centers[index])) return;
        const y = centers[index] + motion.offset - viewport.height / 2;
        const distance = Math.abs(y) / (viewport.height / 2);
        item.style.opacity = (1 - Math.min(1, Math.max(0, (distance - 0.78) / 0.4))).toFixed(3);
        if (Math.abs(y) < nearestDistance) {
          nearestDistance = Math.abs(y);
          nearest = index;
        }
      });
      if (nearest !== activeRef.current) setActive(nearest);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [viewport]);

  // Unfolding: pictures open from the top of the screen down, each note a
  // beat after its picture.
  useLayoutEffect(() => {
    if (phase !== "unfolded" || reduced || !viewport) return;
    const visible = itemRefs.current
      .map((item, index) => ({ item, y: (centersRef.current[index] ?? 0) + motionRef.current.offset }))
      .filter((entry): entry is { item: HTMLElement; y: number } => Boolean(entry.item) && entry.y > -200 && entry.y < viewport.height + 200)
      .sort((left, right) => left.y - right.y);
    visible.forEach(({ item }, rank) => {
      item.style.setProperty("--unfold-delay", `${rank * UNFOLD_STAGGER_MS}ms`);
      item.style.setProperty("--note-delay", `${rank * UNFOLD_STAGGER_MS + NOTE_AFTER_PICTURE_MS}ms`);
    });
    const clear = window.setTimeout(() => {
      for (const item of itemRefs.current) {
        item?.style.removeProperty("--unfold-delay");
        item?.style.removeProperty("--note-delay");
      }
    }, visible.length * UNFOLD_STAGGER_MS + 1800);
    return () => window.clearTimeout(clear);
  }, [phase === "unfolded"]);

  function centreOn(index: number) {
    const viewportHeight = viewport?.height ?? 0;
    const center = centersRef.current[index];
    if (center === undefined || !Number.isFinite(center)) return;
    motionRef.current.target = streamOffsetFor(center, viewportHeight);
    motionRef.current.velocity = 0;
  }

  function onWheel(event: WheelEvent<HTMLDivElement>) {
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? (viewport?.height ?? 800) : 1;
    motionRef.current.target -= event.deltaY * unit;
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button:not([data-stream-shot])")) return;
    const video = target.closest("video");
    if (video && video.getBoundingClientRect().bottom - event.clientY < VIDEO_CONTROLS_BAND_PX) return;
    dragRef.current = { x: event.clientX, y: event.clientY, lastY: event.clientY, lastTime: performance.now(), pointerId: event.pointerId, moved: false };
    draggedRef.current = false;
    motionRef.current.velocity = 0;
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse") setHovering(Boolean((event.target as HTMLElement).closest(".journey-stream__item")));
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > DRAG_SLOP_PX) {
      drag.moved = true;
      draggedRef.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    if (!drag.moved) return;
    const now = performance.now();
    const dy = event.clientY - drag.lastY;
    const dt = Math.max((now - drag.lastTime) / 1000, 1e-3);
    motionRef.current.target += dy;
    motionRef.current.velocity = damp(motionRef.current.velocity, dy / dt, 20, dt);
    drag.lastY = event.clientY;
    drag.lastTime = now;
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>, cancelled = false) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!cancelled && drag.moved && Math.abs(dx) > JOURNEY_SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
      motionRef.current.velocity = 0;
      const neighbour = dx < 0 ? nextJourney : previousJourney;
      if (neighbour && onNavigate) onNavigate(neighbour.id);
    }
    window.setTimeout(() => { draggedRef.current = false; }, 0);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target.closest("video, input, textarea, select")) return;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      centreOn(Math.min(entries.length - 1, Math.max(0, active + (event.key === "ArrowUp" ? 1 : -1))));
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (lightbox) return;
      const neighbour = event.key === "ArrowRight" ? nextJourney : previousJourney;
      if (neighbour && onNavigate) {
        event.preventDefault();
        onNavigate(neighbour.id);
      }
    } else if (event.key === " " && !target.closest("button")) {
      event.preventDefault();
      setPaused((value) => !value);
    }
  }

  if (!journey) return null;
  const pourX = origin?.x ?? null;
  const lightboxEntry = lightbox ? entries.find((entry) => entryAsset(entry)?.id === lightbox) : undefined;
  const lightboxRead = lightbox ? reads[lightbox] : undefined;
  const classicTarget: JourneyBookOpenTarget = {
    routePointId: activeEntry && activeEntry.kind !== "intro" ? activeEntry.routePoint?.id ?? null : null,
    assetId: entryAsset(activeEntry)?.id ?? null,
  };
  // Newest at the top.
  const drawn = entries.map((entry, index) => ({ entry, index })).reverse();

  return (
    <div
      ref={rootRef}
      className="journey-stream"
      role="dialog"
      aria-modal="true"
      aria-label={`${journey.title} · 旅程之流`}
      tabIndex={-1}
      data-phase={phase}
      data-layout={layout?.beside ? "beside" : "stacked"}
      style={{
        "--accent": journey.lightColor,
        "--pour-x": pourX === null ? "50%" : `${Math.round(pourX)}px`,
        "--gap": `${layout?.gap ?? 60}px`,
        "--note-width": `${layout?.noteWidth ?? 260}px`,
        "--gutter": `${layout?.gutter ?? 40}px`,
      } as CSSProperties}
      onKeyDown={onKeyDown}
    >
      <div className="journey-stream__backdrop" aria-hidden="true" />
      <div className="journey-stream__thread" aria-hidden="true" />
      <div
        ref={flowRef}
        className="journey-stream__flow"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => onPointerUp(event)}
        onPointerCancel={(event) => onPointerUp(event, true)}
        onPointerLeave={() => setHovering(false)}
      >
        <div ref={stripRef} className="journey-stream__strip">
          {layout ? drawn.map(({ entry, index }, position) => (
            <StreamItem
              key={entry.key}
              ref={(element) => { itemRefs.current[index] = element; }}
              journey={journey}
              entry={entry}
              side={position % 2 === 0 ? "left" : "right"}
              layout={layout}
              read={entryAsset(entry) ? reads[entryAsset(entry)!.id] : undefined}
              still={entryAsset(entry) ? stills[entryAsset(entry)!.id] ?? null : null}
              natural={entryAsset(entry) ? naturalSizes[entryAsset(entry)!.id] ?? null : null}
              live={index === active && liveVideoId !== null}
              near={Math.abs(index - active) <= RENDER_WINDOW}
              videoRef={videoRef}
              onVideoChange={updateVideo}
              onNatural={(assetId, size) => setNaturalSizes((previous) => (
                previous[assetId] ? previous : { ...previous, [assetId]: size }
              ))}
              onOpen={(assetId) => {
                if (draggedRef.current) return;
                if (index !== active) centreOn(index);
                else setLightbox(assetId);
              }}
              onPlay={() => centreOn(index)}
              onExpired={expireRead}
              onLoaded={clearRetry}
            />
          )) : null}
        </div>
      </div>
      <header className="journey-stream__header">
        <button type="button" className="journey-stream__icon" aria-label="回到地球" onClick={requestClose}>
          <IconArrowUp size={20} stroke={1.35} aria-hidden="true" />
        </button>
        <p className="journey-stream__title">{journey.title}</p>
        <div className="journey-stream__actions">
          {soundtrack ? (
            <button
              type="button"
              className="journey-stream__icon"
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
          <button type="button" className="journey-stream__text-action" onClick={() => onOpenClassic(classicTarget)}>经典视图</button>
        </div>
      </header>
      {previousJourney && onNavigate ? (
        <button
          type="button"
          className="journey-stream__side is-previous"
          style={{ "--side-accent": previousJourney.lightColor } as CSSProperties}
          aria-label={`上一段旅程：${previousJourney.title}`}
          onClick={() => onNavigate(previousJourney.id)}
        ><IconChevronLeft size={20} stroke={1.35} aria-hidden="true" /></button>
      ) : null}
      {nextJourney && onNavigate ? (
        <button
          type="button"
          className="journey-stream__side is-next"
          style={{ "--side-accent": nextJourney.lightColor } as CSSProperties}
          aria-label={`下一段旅程：${nextJourney.title}`}
          onClick={() => onNavigate(nextJourney.id)}
        ><IconChevronRight size={20} stroke={1.35} aria-hidden="true" /></button>
      ) : null}
      {paused ? <p className="journey-stream__paused" role="status">已暂停流动 · 空格继续</p> : null}
      {lightbox && lightboxEntry?.kind === "media" ? (
        <div className="journey-stream__lightbox" role="dialog" aria-label="大图" onClick={() => setLightbox(null)}>
          {lightboxRead?.status === "ready" ? (
            <img
              src={lightboxRead.read.url}
              alt={lightboxEntry.asset.fileName}
              onLoad={() => clearRetry(lightboxEntry.asset.id)}
              // An expired signed URL is read once more; the view stays open.
              onError={() => expireRead(lightboxEntry.asset.id)}
            />
          ) : (
            <p role="status">{lightboxRead?.status === "error" ? "这张照片暂时无法读取" : "正在读取原图…"}</p>
          )}
          {lightboxEntry.place || lightboxEntry.date ? (
            <p>{[lightboxEntry.place, lightboxEntry.date].filter(Boolean).join(" · ")}</p>
          ) : null}
          <button type="button" className="journey-stream__icon" aria-label="关闭大图" onClick={() => setLightbox(null)}>
            <IconX size={20} stroke={1.35} aria-hidden="true" />
          </button>
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

type StreamItemProps = {
  journey: Journey;
  entry: JourneyStreamEntry;
  side: "left" | "right";
  layout: JourneyStreamLayout;
  read: ReaderRead | undefined;
  still: VideoStill | null;
  natural: { width: number; height: number } | null;
  live: boolean;
  near: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  onVideoChange: () => void;
  onNatural: (assetId: string, size: { width: number; height: number }) => void;
  onOpen: (assetId: string) => void;
  onPlay: () => void;
  onExpired: (assetId: string) => void;
  onLoaded: (assetId: string) => void;
  ref?: Ref<HTMLElement>;
};

function StreamNote({ place, date, note, side }: { place: string | null; date: string | null; note: string | null; side: "left" | "right" }) {
  if (!place && !date && !note) return null;
  return (
    <aside className={`journey-stream__note is-${side}`}>
      {place || date ? <span className="journey-stream__note-meta">{[place, date].filter(Boolean).join(" · ")}</span> : null}
      {note ? <p>{note}</p> : null}
    </aside>
  );
}

function StreamItem({
  journey, entry, side, layout, read, still, natural, live, near, videoRef,
  onVideoChange, onNatural, onOpen, onPlay, onExpired, onLoaded, ref,
}: StreamItemProps) {
  if (entry.kind === "intro") {
    return (
      <section ref={ref} className="journey-stream__item journey-stream__intro">
        <span className="journey-stream__bead" aria-hidden="true" />
        <h2>{journey.title}</h2>
        <span className="journey-stream__note-meta">{journeyRange(journey)}</span>
        {entry.note ? <p>{entry.note}</p> : null}
      </section>
    );
  }
  if (entry.kind === "note") {
    return (
      <section ref={ref} className="journey-stream__item journey-stream__bead-item">
        <span className="journey-stream__bead" aria-hidden="true" />
        <StreamNote place={entry.place} date={entry.date} note={entry.note} side={side} />
      </section>
    );
  }
  const asset = entry.asset;
  const size = streamPictureSize(streamAspect(asset, read?.status === "ready" ? read.read.preview : null, natural), layout);
  const video = isVideoAsset(asset);
  const poster = video ? videoPosterUrl(read, still) : undefined;
  // The column shows the preview; the original is for the large view only.
  const picture = read?.status === "ready" ? read.read.preview?.url ?? read.read.url : undefined;
  if (!near) {
    return (
      <section ref={ref} className="journey-stream__item" style={{ width: size.width }}>
        <div className="journey-stream__frame" style={{ height: size.height }} />
        <StreamNote place={entry.place} date={entry.date} note={entry.note} side={side} />
      </section>
    );
  }
  return (
    <section ref={ref} className="journey-stream__item" style={{ width: size.width }}>
      <div className="journey-stream__frame" style={{ height: size.height }}>
        {read?.status === "error" ? <span className="journey-stream__state">暂时无法读取</span> : null}
        {!read || read.status === "loading" ? <span className="journey-stream__state" aria-hidden="true" /> : null}
        {read?.status === "ready" && !video ? (
          <button type="button" className="journey-stream__shot" data-stream-shot="" aria-label={`查看 ${asset.fileName}`} onClick={() => onOpen(asset.id)}>
            <img
              src={picture}
              alt=""
              decoding="async"
              draggable={false}
              onLoad={(event) => {
                onLoaded(asset.id);
                const image = event.currentTarget;
                if (image.naturalWidth && image.naturalHeight) onNatural(asset.id, { width: image.naturalWidth, height: image.naturalHeight });
              }}
              onError={() => onExpired(asset.id)}
            />
          </button>
        ) : null}
        {read?.status === "ready" && video && live ? (
          <video
            ref={videoRef}
            src={withStillFragment(read.read.url)}
            poster={poster}
            controls
            playsInline
            preload="metadata"
            onPlay={() => { onVideoChange(); onPlay(); }}
            onPause={onVideoChange}
            onEnded={onVideoChange}
            onEmptied={onVideoChange}
            onVolumeChange={onVideoChange}
            onCanPlay={() => onLoaded(asset.id)}
            onError={() => onExpired(asset.id)}
            onLoadedMetadata={(event) => {
              const element = event.currentTarget;
              if (element.videoWidth && element.videoHeight) onNatural(asset.id, { width: element.videoWidth, height: element.videoHeight });
            }}
          />
        ) : null}
        {read?.status === "ready" && video && !live ? (
          <button type="button" className="journey-stream__shot" data-stream-shot="" aria-label={`播放 ${asset.fileName}`} onClick={() => onOpen(asset.id)}>
            {poster ? <img src={poster} alt="" draggable={false} /> : null}
            {!poster && still?.kind === "canvas" ? <StillCanvas canvas={still.canvas} /> : null}
            <span className="journey-stream__play" aria-hidden="true"><IconPlayerPlay size={22} stroke={1.35} /></span>
          </button>
        ) : null}
      </div>
      <StreamNote place={entry.place} date={entry.date} note={entry.note} side={side} />
    </section>
  );
}

function StillCanvas({ canvas }: { canvas: HTMLCanvasElement }) {
  const hostRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.replaceChildren(canvas);
    return () => host.replaceChildren();
  }, [canvas]);
  return <span ref={hostRef} className="journey-stream__still" />;
}

export default JourneyStream;
