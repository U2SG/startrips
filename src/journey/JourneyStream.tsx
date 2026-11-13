import type { DailyJournal } from "./dailyJournal";
import { DailyJournalPanel } from "./DailyJournalPanel";
import { StoryPresentationPicker } from "./StoryPresentationPicker";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref, type RefObject, type WheelEvent } from "react";
import { IconArrowBarToUp, IconArrowUp, IconChevronLeft, IconChevronRight, IconMusic, IconMusicOff, IconNotebook, IconPlayerPause, IconPlayerPlay, IconX } from "@tabler/icons-react";
import { onMotionPreferenceChange, prefersReducedMotion } from "../motion/preferences";
import { useAtlasView } from "./atlasView";
import { journeySoundtrack } from "./journeyModel";
import {
  journeyStreamEntries,
  journeyStreamJournalDays,
  journeyStreamJournalPlacement,
  journeyStreamLayout,
  streamAspect,
  streamOffsetFor,
  streamPictureSize,
  type JourneyStreamEntry,
  type JourneyStreamJournalDay,
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
import { useModalFocus, useNestedModalFocus } from "./useModalFocus";
import { canStartStreamPointer, streamPointerHasLostCapture, streamSwipeDirection, STREAM_NATIVE_INPUT } from "./journeyStreamInput";
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
const DRAG_SLOP_PX = 6;
/** Entries read ahead/behind the one at the centre. */
const READ_WINDOW = 4;
/**
 * Entries further than this from the centre keep their size but drop their
 * picture, so a long Journey does not keep every decoded image alive.
 */
const RENDER_WINDOW = 6;

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

function journalAutoplayEnd(flow: HTMLElement, journal: HTMLElement) {
  // The journal appendix starts below the last view of the media.
  return Math.max(0, journal.offsetTop - flow.clientHeight);
}

/**
 * #393 trial (after Undertow): a Journey read as a flowing thread. Opens in
 * place of Story when the per-device presentation style is `stream`. The
 * thread pours from where the Journey was opened, settles in the centre and
 * unfolds into the Journey's pictures, which keep flowing down it; notes are
 * written in the margin. Only the entry at the centre may hold the live video.
 */
function JourneyStreamContent({
  journeys,
  journeyId,
  routePointId = null,
  initialAssetId = null,
  origin = null,
  onClose,
  onOpenClassic,
  onNavigate,
  onObservationChange,
  onOpenJournal,
  onCloseAtPoint,
  journal,
}: {
  journal?: DailyJournal;
  onCloseAtPoint?: (id: string) => void;
  onOpenJournal?: () => void;
  onJourneyUpdated?: (journey: Journey) => void;
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
  const { capabilities, readMedia } = useAtlasView();
  const journeyIndex = journeys.findIndex((candidate) => candidate.id === journeyId);
  const journey = journeyIndex >= 0 ? journeys[journeyIndex] : null;
  const previousJourney = journeyIndex > 0 ? journeys[journeyIndex - 1] : null;
  const nextJourney = journeyIndex >= 0 && journeyIndex < journeys.length - 1 ? journeys[journeyIndex + 1] : null;
  const journalDays = useMemo(() => journal ? journeyStreamJournalDays(
    journal.chapters, new Map(journey?.routePoints.map(point => [point.id, point])),
  ) : [], [journey, journal]);
  const entries = useMemo(() => {
    if (!journey) return [];
    const journalPoints = new Set(journalDays.flatMap(day => day.chapters.flatMap(
      chapter => chapter.events.flatMap(event => event.point ? [event.point.id] : []),
    )));
    return journeyStreamEntries(journey, routePointId, journalPoints);
  }, [journey, routePointId, journalDays]);
  const journalPlacement = useMemo(() => journeyStreamJournalPlacement(entries, journalDays), [entries, journalDays]);
  const readingJournal = journalDays.length > 0;
  const soundtrack = journey ? journeySoundtrack(journey) : null;

  const [reduced, setReduced] = useState(prefersReducedMotion);
  const [streamPhase, setPhase] = useState<Phase>(() => (prefersReducedMotion() ? "unfolded" : "pouring"));
  const phase = readingJournal && streamPhase !== "closing" ? "unfolded" : streamPhase;
  const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null);
  const [activeKey, setActiveKey] = useState(() => {
    const byAsset = initialAssetId ? entries.find((entry) => entryAsset(entry)?.id === initialAssetId) : undefined;
    const byPoint = routePointId
      ? entries.find((entry) => entry.kind !== "intro" && entry.routePoint?.id === routePointId)
      : undefined;
    return (byAsset ?? byPoint)?.key ?? "intro";
  });
  const active = Math.max(0, entries.findIndex(entry => entry.key === activeKey));
  const [naturalSizes, setNaturalSizes] = useState<Record<string, { width: number; height: number }>>({});
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [journalDate, setJournalDate] = useState<string | null>(null);
  const openDay = journalDays.find(day => day.date === journalDate);
  const openDayEntry = openDay ? journalPlacement.byDate.get(openDay.date) : undefined;
  const openDayChoices = openDayEntry ? journalPlacement.byEntry.get(openDayEntry) : undefined;
  const [hovering, setHovering] = useState(false);
  const [paused, setPaused] = useState(false);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const flowRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const journalRef = useRef<HTMLElement>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);
  const itemBoundsRef = useRef(new Map<string, { top: number; center: number }>());
  const centersRef = useRef<number[]>([]);
  const readingModeRef = useRef(readingJournal);
  const motionRef = useRef({ offset: 0, target: 0, velocity: 0, drift: 0, placed: false });
  // Restarts the flow loop after it has settled; anything that moves the
  // motion state from outside the loop calls it.
  const wakeRef = useRef<() => void>(() => {});
  const dragRef = useRef<{ x: number; y: number; lastY: number; lastTime: number; pointerId: number; moved: boolean } | null>(null);
  const draggedRef = useRef(false);
  const lightboxOpenerRef = useRef<HTMLElement | null>(null);
  const journalOpenerRef = useRef<HTMLElement | null>(null);
  const lightboxRef = useNestedModalFocus<HTMLDivElement>(Boolean(lightbox), lightbox);
  const journalPanelRef = useNestedModalFocus<HTMLElement>(Boolean(openDay));
  const videoRef = useRef<HTMLVideoElement>(null);
  const timersRef = useRef<number[]>([]);
  const closingRef = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;

  const requestClose = useCallback((pointId?: string) => {
    if (closingRef.current) return;
    closingRef.current = true;
    stopStreamMotion();
    const close = pointId && onCloseAtPoint ? () => onCloseAtPoint(pointId) : onClose;
    if (reduced || readingJournal) {
      close();
      return;
    }
    setPhase("closing");
    timersRef.current.push(window.setTimeout(close, CLOSE_MS));
  }, [onClose, onCloseAtPoint, readingJournal, reduced]);
  const rootRef = useModalFocus<HTMLDivElement>(() => {
    if (lightbox) setLightbox(null);
    else if (openDay) setJournalDate(null);
    else requestClose();
  });

  useLayoutEffect(() => {
    stopStreamMotion();
  }, [lightbox, journeyId, viewport?.width, viewport?.height]);
  useEffect(() => {
    if (lightbox) return;
    const opener = lightboxOpenerRef.current;
    lightboxOpenerRef.current = null;
    if (opener?.isConnected && !closingRef.current && !opener.closest("[inert]")) opener.focus({ preventScroll: true });
  }, [lightbox]);
  useEffect(() => {
    if (openDay) return;
    const opener = journalOpenerRef.current;
    journalOpenerRef.current = null;
    if (opener?.isConnected && !closingRef.current) opener.focus({ preventScroll: true });
  }, [openDay]);
  useEffect(() => {
    const interrupt = () => stopStreamMotion();
    const hidden = () => { if (document.hidden) interrupt(); };
    window.addEventListener("blur", interrupt);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("blur", interrupt);
      document.removeEventListener("visibilitychange", hidden);
      interrupt();
    };
  }, []);
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
      const key = entries[anchor]?.key;
      const previous = key === undefined ? undefined : itemBoundsRef.current.get(key);
      const modeChanged = readingModeRef.current !== readingJournal;
      readingModeRef.current = readingJournal;
      const items = entries.map((_, index) => itemRefs.current[index]);
      const bounds = new Map<string, { top: number; center: number }>();
      centersRef.current = items.map((item, index) => {
        if (!item) return Number.NaN;
        const top = item.offsetTop;
        const center = top + item.offsetHeight / 2;
        bounds.set(entries[index].key, { top, center });
        return center;
      });
      itemBoundsRef.current = bounds;
      const motion = motionRef.current;
      const after = centersRef.current[anchor];
      const flow = flowRef.current;
      if (readingJournal) {
        const item = itemRefs.current[anchor];
        if (modeChanged) {
          stopStreamMotion();
          strip.style.removeProperty("transform");
          itemRefs.current.forEach(entry => entry?.style.removeProperty("opacity"));
        }
        if ((!motion.placed || modeChanged) && item && flow) {
          // Keep the top of the media anchored as its route note moves below it.
          const scrollTop = motion.placed && previous
            ? item.offsetTop - (previous.top + motion.offset - flow.scrollTop)
            : after - flow.clientHeight / 2;
          flow.scrollTop = anchor === 0 ? 0 : scrollTop;
          motion.placed = true;
        }
        return;
      }
      if (modeChanged) {
        if (flow) flow.scrollTop = 0;
        motion.placed = false;
      }
      // A picture that loads late changes the heights above the reader; keep
      // the entry being read where it is.
      if (motion.placed && !dragRef.current?.moved && previous && Number.isFinite(after) && previous.center !== after) {
        motion.offset -= after - previous.center;
        motion.target -= after - previous.center;
      }
      if (!motion.placed && viewport && centersRef.current.length) {
        motion.offset = motion.target = streamOffsetFor(after ?? 0, viewport.height);
        motion.placed = true;
      }
      wakeRef.current();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    return () => observer.disconnect();
    // Placement uses the opening entry once; later layouts only re-measure.
  }, [layout?.beside, layout?.pictureWidth, entries, viewport, readingJournal]);

  const flowing = !readingJournal && phase === "unfolded" && !reduced && !paused && !lightbox && !hovering && !videoPlaying;
  const flowingRef = useRef(flowing);
  flowingRef.current = flowing;
  useEffect(() => {
    if (flowing) wakeRef.current();
  }, [flowing]);

  // Keep native scrolling for the journal so touch, selection and expanded
  // days continue to work. Advance that same scroll position during autoplay.
  const canAutoplayJournal = readingJournal && !reduced && entries.length > 1;
  const journalAutoplay = canAutoplayJournal && streamPhase === "unfolded" && !paused && !lightbox && !videoPlaying;
  useEffect(() => {
    const flow = flowRef.current;
    const journal = journalRef.current;
    if (!journalAutoplay || !flow || !journal) return;
    let frame = 0;
    let last = performance.now();
    let carry = 0;
    const advance = (now: number) => {
      if (closingRef.current) return;
      const end = journalAutoplayEnd(flow, journal);
      if (flow.scrollTop >= end - 1) {
        setPaused(true);
        return;
      }
      carry += Math.min(0.05, (now - last) / 1000) * DRIFT_PX_S;
      last = now;
      const pixels = Math.floor(carry);
      if (pixels) {
        flow.scrollTop = Math.min(end, flow.scrollTop + pixels);
        carry -= pixels;
      }
      frame = requestAnimationFrame(advance);
    };
    frame = requestAnimationFrame(advance);
    return () => cancelAnimationFrame(frame);
  }, [journalAutoplay]);

  // The flow: offset follows its target; the target drifts downward until
  // the newest entry reaches the centre, and never past either end. The loop
  // stops once everything has settled and is woken by any outside change.
  useEffect(() => {
    if (!viewport || readingJournal) return;
    let frame = 0;
    let last = performance.now();
    let running = false;
    const tick = (now: number) => {
      if (readingModeRef.current) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const pointer = dragRef.current;
      if (pointer && streamPointerHasLostCapture(pointer.moved, flowRef.current?.hasPointerCapture(pointer.pointerId) ?? false)) {
        // Native release can precede its lostpointercapture notification.
        // A queued frame must not integrate an ownerless drag or its velocity.
        stopStreamMotion();
      }
      const motion = motionRef.current;
      const centers = centersRef.current;
      const known = centers.filter(Number.isFinite);
      if (!known.length) {
        running = false;
        return;
      }
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
      if (nearest !== activeRef.current && entries[nearest]) setActiveKey(entries[nearest].key);
      const settled = !dragging
        && Math.abs(motion.velocity) < 0.5
        && Math.abs(motion.offset - motion.target) < 0.05
        && Math.abs(motion.drift) < 0.05
        && (!flowingRef.current || motion.target >= high);
      if (settled) running = false;
      else frame = requestAnimationFrame(tick);
    };
    const start = () => {
      if (running) return;
      running = true;
      last = performance.now();
      frame = requestAnimationFrame(tick);
    };
    wakeRef.current = start;
    start();
    return () => {
      cancelAnimationFrame(frame);
      running = false;
      wakeRef.current = () => {};
    };
  }, [viewport, readingJournal, entries]);

  // Unfolding: pictures open from the top of the screen down, each note a
  // beat after its picture.
  useLayoutEffect(() => {
    if (readingJournal || phase !== "unfolded" || reduced || !viewport) return;
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

  function updateReadingPosition() {
    const flow = flowRef.current;
    if (!flow || !motionRef.current.placed) return;
    const readingLine = flow.scrollTop + flow.clientHeight / 2;
    if (journalRef.current && readingLine >= journalRef.current.offsetTop) return;
    let nearest = activeRef.current;
    let distance = Infinity;
    itemRefs.current.forEach((item, index) => {
      if (!item) return;
      const gap = Math.max(item.offsetTop - readingLine, readingLine - item.offsetTop - item.offsetHeight, 0);
      if (gap < distance) { nearest = index; distance = gap; }
    });
    if (nearest !== activeRef.current && entries[nearest]) setActiveKey(entries[nearest].key);
  }

  function jumpToDay(date: string) {
    const flow = flowRef.current;
    const entryKey = journalPlacement.byDate.get(date);
    const entryIndex = entries.findIndex(entry => entry.key === entryKey);
    const item = itemRefs.current[entryIndex];
    if (!flow || !date) return;
    if (item) flow.scrollTop += item.getBoundingClientRect().top - flow.getBoundingClientRect().top;
    openJournalDay(date);
  }

  function openJournalDay(date: string) {
    journalOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPaused(true);
    setJournalDate(date);
  }

  function jumpToStart() {
    setPaused(true);
    if (flowRef.current) flowRef.current.scrollTop = 0;
    itemRefs.current[0]?.querySelector("h2")?.focus({ preventScroll: true });
  }

  function toggleJournalAutoplay() {
    const flow = flowRef.current;
    const journal = journalRef.current;
    if (paused && flow && journal && flow.scrollTop >= journalAutoplayEnd(flow, journal) - 1) {
      flow.scrollTop = 0;
    }
    setPaused(!paused);
  }

  function centreOn(index: number) {
    if (readingJournal) {
      const item = itemRefs.current[index];
      const flow = flowRef.current;
      const target = item?.querySelector(".journey-stream__frame") ?? item;
      if (target && flow && entries[index]) {
        const bounds = target.getBoundingClientRect();
        flow.scrollTop += bounds.top - flow.getBoundingClientRect().top + (bounds.height - flow.clientHeight) / 2;
        setActiveKey(entries[index].key);
      }
      return;
    }
    const viewportHeight = viewport?.height ?? 0;
    const center = centersRef.current[index];
    if (center === undefined || !Number.isFinite(center)) return;
    motionRef.current.target = streamOffsetFor(center, viewportHeight);
    motionRef.current.velocity = 0;
    wakeRef.current();
  }

  function releaseStreamPointer(pointerId: number) {
    const flow = flowRef.current;
    try { if (flow?.hasPointerCapture(pointerId)) flow.releasePointerCapture(pointerId); }
    catch { /* Browser cancellation may have released capture already. */ }
  }

  function stopStreamMotion() {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag) {
      draggedRef.current = true;
      releaseStreamPointer(drag.pointerId);
    }
    const motion = motionRef.current;
    motion.velocity = 0;
    motion.drift = 0;
    motion.target = motion.offset;
  }

  function onWheel(event: WheelEvent<HTMLDivElement>) {
    if (lightbox || closingRef.current || event.ctrlKey || event.metaKey
      || (event.target instanceof Element && event.target.closest(STREAM_NATIVE_INPUT))) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? (viewport?.height ?? 800) : 1;
    motionRef.current.target -= event.deltaY * unit;
    wakeRef.current();
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const blocked = Boolean(lightbox || closingRef.current || !(event.target instanceof Element)
      || event.target.closest(STREAM_NATIVE_INPUT));
    if (!canStartStreamPointer({ isPrimary: event.isPrimary, button: event.button, blocked,
      activePointerId: dragRef.current?.pointerId ?? null })) return;
    dragRef.current = { x: event.clientX, y: event.clientY, lastY: event.clientY, lastTime: performance.now(), pointerId: event.pointerId, moved: false };
    draggedRef.current = false;
    motionRef.current.velocity = 0;
    wakeRef.current();
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse") setHovering(Boolean((event.target as HTMLElement).closest(".journey-stream__item")));
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || lightbox || closingRef.current) return;
    if (streamPointerHasLostCapture(drag.moved, event.currentTarget.hasPointerCapture(event.pointerId))) {
      stopStreamMotion();
      return;
    }
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > DRAG_SLOP_PX) {
      drag.moved = true;
      draggedRef.current = true;
      try { event.currentTarget.setPointerCapture(event.pointerId); }
      catch { stopStreamMotion(); return; }
    }
    if (!drag.moved) return;
    const now = performance.now();
    const dy = event.clientY - drag.lastY;
    const dt = Math.max((now - drag.lastTime) / 1000, 1e-3);
    motionRef.current.target += dy;
    motionRef.current.velocity = damp(motionRef.current.velocity, dy / dt, 20, dt);
    drag.lastY = event.clientY;
    drag.lastTime = now;
    wakeRef.current();
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>, cancelled = false) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    releaseStreamPointer(drag.pointerId);
    const direction = streamSwipeDirection(dx, dy, drag.moved, cancelled || Boolean(lightbox) || closingRef.current);
    if (cancelled || direction !== null) stopStreamMotion();
    if (cancelled || drag.moved) draggedRef.current = true;
    if (direction !== null) {
      const neighbour = direction > 0 ? nextJourney : previousJourney;
      if (neighbour && onNavigate) onNavigate(neighbour.id);
    }
    // A compatibility click remains suppressed until the next valid pointer
    // starts. Keyboard activation (detail=0) is never suppressed by a drag.
    wakeRef.current();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (lightbox || openDay || closingRef.current || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement;
    if (target.closest("video, input, textarea, select, .journey-stream__journal, .journey-stream__journal-day")) return;
    if (readingJournal && ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
      setPaused(true);
      return;
    }
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
  const backgroundInert = Boolean(lightbox || openDay) || phase === "closing";
  return (
    <div
      ref={rootRef}
      className="journey-stream"
      role="dialog"
      aria-modal="true"
      aria-label={`${journey.title} · 旅程之流`}
      tabIndex={-1}
      data-phase={phase}
      data-journal={readingJournal || undefined}
      data-layout={!readingJournal && layout?.beside ? "beside" : "stacked"}
      style={{
        "--accent": journey.lightColor,
        "--pour-x": pourX === null ? "50%" : `${Math.round(pourX)}px`,
        "--gap": `${layout?.gap ?? 60}px`,
        "--note-width": `${layout?.noteWidth ?? 260}px`,
        "--gutter": `${layout?.gutter ?? 40}px`,
        "--reader-half-height": `${(viewport?.height ?? 0) / 2}px`,
      } as CSSProperties}
      onKeyDown={onKeyDown}
    >
      <div className="journey-stream__backdrop" aria-hidden="true" />
      <div className="journey-stream__thread" aria-hidden="true" />
      <div
        ref={flowRef}
        className="journey-stream__flow"
        inert={backgroundInert}
        onClickCapture={(event) => {
          if (!draggedRef.current || event.detail === 0) return;
          event.preventDefault();
          event.stopPropagation();
        }}
        tabIndex={readingJournal ? 0 : undefined}
        onFocusCapture={readingJournal ? () => setPaused(true) : undefined}
        onScroll={readingJournal ? updateReadingPosition : undefined}
        onWheel={readingJournal ? () => setPaused(true) : onWheel}
        onPointerDownCapture={(event) => {
          // A fresh native-control press also ends the previous drag's click
          // suppression; only its late compatibility click must be blocked.
          if (event.isPrimary && event.button === 0 && !dragRef.current) draggedRef.current = false;
        }}
        onPointerDown={readingJournal ? () => setPaused(true) : onPointerDown}
        onPointerMove={readingJournal ? undefined : onPointerMove}
        onPointerUp={(event) => onPointerUp(event)}
        onPointerCancel={(event) => onPointerUp(event, true)}
        onLostPointerCapture={(event) => {
          if (event.target === event.currentTarget && dragRef.current?.pointerId === event.pointerId) onPointerUp(event, true);
        }}
        onPointerLeave={(event) => {
          setHovering(false);
          if (dragRef.current?.pointerId === event.pointerId && !event.currentTarget.hasPointerCapture(event.pointerId)) stopStreamMotion();
        }}
      >
        <div ref={stripRef} className="journey-stream__strip">
          {layout ? entries.map((entry, index) => (
            <StreamItem
              key={entry.key}
              ref={(element) => { itemRefs.current[index] = element; }}
              journey={journey}
              entry={entry}
              journalDate={journalPlacement.visitByEntry.get(entry.key)}
              journalDays={journalPlacement.byEntry.get(entry.key)}
              side={(readingJournal ? index : entries.length - 1 - index) % 2 === 0 ? "left" : "right"}
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
                if (closingRef.current || lightbox) return;
                if (index !== active && (!readingJournal || (entry.kind === "media" && isVideoAsset(entry.asset)))) centreOn(index);
                else {
                  stopStreamMotion();
                  const opener = itemRefs.current[index]?.querySelector<HTMLElement>("[data-stream-shot]") ?? null;
                  lightboxOpenerRef.current = opener;
                  opener?.focus({ preventScroll: true });
                  setLightbox(assetId);
                }
              }}
              onPlay={() => { if (!readingJournal) centreOn(index); }}
              onOpenJournalDay={openJournalDay}
              journalIndex={entry.kind === "intro" && readingJournal ? (
                <select className="journey-stream__journal-index" aria-label="按日期查看手记"
                  value="" onChange={event => jumpToDay(event.currentTarget.value)}>
                  <option value="">按日期查看手记</option>
                  {journalDays.map(day => (
                    <option key={day.date} value={day.date}>{day.date}</option>
                  ))}
                </select>
              ) : undefined}
              onExpired={expireRead}
              onLoaded={clearRetry}
            />
          )) : null}
          {readingJournal ? (
            <section ref={journalRef} className="journey-stream__journal" aria-label="全部手记">
              <div className="journey-stream__journal-heading">
                <h2>全部手记</h2>
                <button type="button" className="journey-stream__journal-jump" onClick={jumpToStart}>
                  回到开头
                </button>
              </div>
              {journalDays.map(day => (
                <JournalDay key={day.date} day={day} onMapPoint={onCloseAtPoint ? requestClose : undefined} />
              ))}
            </section>
          ) : null}
        </div>
      </div>
      <header className="journey-stream__header" inert={backgroundInert}>
        <button type="button" className="journey-stream__icon" aria-label="回到地球" onClick={() => requestClose()}>
          <IconArrowUp size={20} stroke={1.35} aria-hidden="true" />
        </button>
        <p className="journey-stream__title">{journey.title}</p>
        <div className="journey-stream__actions">
          {canAutoplayJournal ? (
            <button type="button" className="journey-stream__icon"
              aria-label={paused ? "自动播放旅程" : "暂停自动播放"} onClick={toggleJournalAutoplay}>
              {paused ? <IconPlayerPlay size={18} stroke={1.35} aria-hidden="true" />
                : <IconPlayerPause size={18} stroke={1.35} aria-hidden="true" />}
            </button>
          ) : null}
          {readingJournal ? (
            <button type="button" className="journey-stream__icon" aria-label="回到旅程开头" title="回到旅程开头"
              onClick={jumpToStart}>
              <IconArrowBarToUp size={18} stroke={1.35} aria-hidden="true" />
            </button>
          ) : null}
          {onOpenJournal ? <button type="button" className="journey-stream__text-action" onClick={onOpenJournal}>导入手记</button> : null}
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
          <StoryPresentationPicker canEdit={capabilities.canEditJourney} onOpenClassic={() => onOpenClassic(classicTarget)} />
        </div>
      </header>
      {previousJourney && onNavigate ? (
        <button
          type="button"
          className="journey-stream__side is-previous"
          inert={backgroundInert}
          style={{ "--side-accent": previousJourney.lightColor } as CSSProperties}
          aria-label={`上一段旅程：${previousJourney.title}`}
          onClick={() => onNavigate(previousJourney.id)}
        ><IconChevronLeft size={20} stroke={1.35} aria-hidden="true" /></button>
      ) : null}
      {nextJourney && onNavigate ? (
        <button
          type="button"
          className="journey-stream__side is-next"
          inert={backgroundInert}
          style={{ "--side-accent": nextJourney.lightColor } as CSSProperties}
          aria-label={`下一段旅程：${nextJourney.title}`}
          onClick={() => onNavigate(nextJourney.id)}
        ><IconChevronRight size={20} stroke={1.35} aria-hidden="true" /></button>
      ) : null}
      {paused && !readingJournal ? <p className="journey-stream__paused" role="status">已暂停流动 · 空格继续</p> : null}
      {openDay ? (
        <>
          <div className="journey-stream__journal-scrim" aria-hidden="true" onClick={() => setJournalDate(null)} />
          <aside className="journey-stream__journal-panel" ref={journalPanelRef} role="dialog" aria-modal="true"
            aria-label={`${openDay.date} 手记`} data-focus-trap-exempt tabIndex={-1}>
            <header className="journey-stream__journal-heading">
              <h2><time dateTime={openDay.date}>{openDay.date}</time> 手记</h2>
              <button type="button" className="journey-stream__icon" aria-label="关闭手记" onClick={() => setJournalDate(null)}>
                <IconX size={18} stroke={1.35} aria-hidden="true" />
              </button>
            </header>
            {openDayChoices && openDayChoices.length > 1 ? (
              <select className="journey-stream__journal-index" aria-label="本站手记日期"
                value={openDay.date} onChange={event => setJournalDate(event.currentTarget.value)}>
                {openDayChoices.map(day => <option key={day.date} value={day.date}>{day.date}</option>)}
              </select>
            ) : null}
            <div className="journey-stream__journal-panel-scroll" key={openDay.date}>
              <JournalDayBody day={openDay} onMapPoint={onCloseAtPoint ? pointId => {
                setJournalDate(null);
                requestClose(pointId);
              } : undefined} />
            </div>
          </aside>
        </>
      ) : null}
      {lightbox && lightboxEntry?.kind === "media" ? (
        <div ref={lightboxRef} className="journey-stream__lightbox" role="dialog" aria-modal="true"
          data-focus-trap-exempt tabIndex={-1} aria-label="大图" onClick={() => setLightbox(null)}>
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

function JournalDay({ day, onMapPoint }: {
  day: JourneyStreamJournalDay;
  onMapPoint?: (id: string) => void;
}) {
  return <details className="journey-stream__journal-day" data-journal-date={day.date}>
    <summary tabIndex={0}><time dateTime={day.date}>{day.date}</time></summary>
    <JournalDayBody day={day} onMapPoint={onMapPoint} />
  </details>;
}

function JournalDayBody({ day, onMapPoint }: { day: JourneyStreamJournalDay; onMapPoint?: (id: string) => void }) {
  return <div className="journey-stream__journal-body">
      {day.chapters.map(chapter => <div key={chapter.id}>
        {chapter.title ? <h3>{chapter.title}</h3> : null}
        {chapter.source ? <p>{chapter.source}</p> : null}
        {chapter.events.length ? <ol>
          {chapter.events.map(({ id, localDate, localTime, point, text }) => <li key={id}>
            <div className="journey-stream__journal-meta">
              {localDate && localDate !== day.date ? <time dateTime={localDate}>{localDate}</time> : null}
              {localTime ? <time dateTime={localTime}>{localTime}</time> : null}
            </div>
            {text ? <p>{text}</p> : null}
            {point && onMapPoint ? <button type="button" className="journey-stream__journal-place"
              aria-label={`在地图上查看：${point.label || "地图地点"}`} onClick={() => onMapPoint(point.id)}>
              {point.label || "地图地点"}
            </button> : point && !text ? <p>{point.label || "地图地点"}</p> : null}
          </li>)}
        </ol> : null}
      </div>)}
    </div>;
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
  journalIndex?: ReactNode;
  journalDate?: string;
  journalDays?: readonly JourneyStreamJournalDay[];
  onOpenJournalDay: (date: string) => void;
  onExpired: (assetId: string) => void;
  onLoaded: (assetId: string) => void;
  ref?: Ref<HTMLElement>;
};

function StreamNote({ place, date, note, side, journalEntry }: {
  place: string | null; date: string | null; note: string | null; side: "left" | "right"; journalEntry?: ReactNode;
}) {
  if (!place && !date && !note && !journalEntry) return null;
  const meta = place || date ? <span className="journey-stream__note-meta">{[place, date].filter(Boolean).join(" · ")}</span> : null;
  return (
    <aside className={`journey-stream__note is-${side}`}>
      {journalEntry ? <div className="journey-stream__note-heading">{meta}{journalEntry}</div> : meta}
      {note ? <p>{note}</p> : null}
    </aside>
  );
}

function StreamItem({
  journey, entry, side, layout, read, still, natural, live, near, videoRef,
  onVideoChange, onNatural, onOpen, onPlay, journalIndex, journalDate, journalDays, onOpenJournalDay, onExpired, onLoaded, ref,
}: StreamItemProps) {
  if (entry.kind === "intro") {
    return (
      <section ref={ref} className="journey-stream__item journey-stream__intro">
        <span className="journey-stream__bead" aria-hidden="true" />
        <h2 tabIndex={journalIndex ? -1 : undefined}>{journey.title}</h2>
        <span className="journey-stream__note-meta">{journeyRange(journey)}</span>
        {entry.note ? <p>{entry.note}</p> : null}
        {journalIndex}
      </section>
    );
  }
  const firstDay = journalDays?.[0];
  const journalEntry = firstDay ? (
    <button type="button" className="journey-stream__journal-entry" aria-label={`查看 ${firstDay.date} 手记`} title="查看手记"
      aria-haspopup="dialog" data-journal-date={firstDay.date} onClick={() => onOpenJournalDay(firstDay.date)}>
      <IconNotebook size={16} stroke={1.35} aria-hidden="true" />
    </button>
  ) : undefined;
  const annotation = <StreamNote place={entry.place} date={entry.date ?? journalDate ?? null}
    note={entry.note} side={side} journalEntry={journalEntry} />;
  if (entry.kind === "note") {
    return (
      <section ref={ref} className="journey-stream__item journey-stream__bead-item">
        <span className="journey-stream__bead" aria-hidden="true" />
        {annotation}
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
        {annotation}
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
      {annotation}
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

export function JourneyStream(props: Omit<Parameters<typeof JourneyStreamContent>[0], "journal" | "onOpenJournal">) {
  const { dailyJournal } = useAtlasView();
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [updated, setUpdated] = useState<Journey | null>(null);
  const [read, setRead] = useState<{ scope: string; client: NonNullable<typeof dailyJournal>; journal: DailyJournal } | null>(null);
  const journeys = props.journeys.map(j => updated && j.id === updated.id && j.atlasId === updated.atlasId && j.revision < updated.revision ? updated : j);
  const journey = journeys.find(j => j.id === props.journeyId);
  const scope = journey ? `${journey.atlasId}:${journey.id}` : null;
  const journeyId = journey?.id;
  const importing = Boolean(dailyJournal && scope && openFor === scope);
  useEffect(() => {
    if (!dailyJournal || !scope || !journeyId || importing) return;
    const request = new AbortController();
    void dailyJournal.read(journeyId, request.signal).then(journal => {
      if (!request.signal.aborted) setRead({ scope, client: dailyJournal, journal });
    }).catch(() => { /* Media remain readable; the import panel reports journal errors. */ });
    return () => request.abort();
  }, [dailyJournal, scope, journeyId, importing]);
  if (dailyJournal && journey && scope && importing) return <DailyJournalPanel
    key={scope} journey={journey} client={dailyJournal}
    onJourneyChanged={next => { setUpdated(next); props.onJourneyUpdated?.(next); }}
    onJournalChanged={journal => setRead({ scope, client: dailyJournal, journal })}
    onClose={() => setOpenFor(null)} />;
  const journal = read && read.scope === scope && read.client === dailyJournal ? read.journal : undefined;
  return <JourneyStreamContent {...props} key={scope} journeys={journeys} journal={journal}
    onOpenJournal={dailyJournal && scope ? () => setOpenFor(scope) : undefined} />;
}

export default JourneyStream;
