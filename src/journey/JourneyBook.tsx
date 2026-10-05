import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal, flushSync } from "react-dom";
import { PageFlip } from "page-flip";
import {
  IconArrowLeft,
  IconArrowRight,
  IconLayoutList,
  IconMusic,
  IconMusicOff,
  IconPlayerPlay,
  IconX,
} from "@tabler/icons-react";
import { STARTRIPS_V12_MARK_MARKUP, STARTRIPS_V12_MARK_VIEWBOX } from "../brand/startripsV12Mark";
import { onMotionPreferenceChange, prefersReducedMotion } from "../motion/preferences";
import {
  COVER_ROUTE_ASPECT,
  COVER_ROUTE_BAND,
  COVER_ROUTE_STROKE,
  coverDateCount,
  coverRouteGeometry,
  coverRouteSvgPath,
} from "./coverRouteGeometry";
import { useAtlasView } from "./atlasView";
import { journeySoundtrack } from "./journeyModel";
import {
  journeyBookPageRoutePointId,
  journeyBookPages,
  journeyBookStartPage,
  type JourneyBookPage,
} from "./journeyBookPages";
import {
  journeyBookBlockWidth,
  journeyBookFlipMinWidth,
  journeyBookLayout,
  journeyBookLayoutCompatible,
  type JourneyBookLayout,
  type JourneyBookOrientation,
} from "./journeyBookLayout";
import { RevealedNote } from "./RevealedNote";
import { useModalFocus } from "./useModalFocus";
import { withStillFragment, type VideoStill } from "./videoStillFrame";
import {
  isVideoAsset as isVideo,
  useReaderReads,
  useReaderSoundtrack,
  useVideoStills,
  videoPosterUrl,
  type ReaderRead as Read,
} from "./journeyReaderMedia";
import type { StoryLogicalObservation } from "./storyMediaPolicy";
import type { Journey, JourneyMediaAsset } from "./types";
import "../styles/journey-book.css";

const FLIP_MS = 760;
/** Pages ahead of and behind the current one whose media is read early. */
const READ_AHEAD = 4;
const READ_BEHIND = 2;
/** Pages further than this keep their layout but drop their pictures. */
const RENDER_WINDOW = 6;
/**
 * Page gestures. PageFlip's own touch input waits 250 ms before a finger may
 * fold the page (measured 290 ms on device) and uses that same window to tell
 * a flick, so it cannot simply be shortened. The Book reads the pointer itself
 * instead: a horizontal drag folds the page from its first movement, a quick
 * one turns it, and a vertical one stays with the browser (long notes scroll).
 */
const DRAG_SLOP_PX = 12;
const FLICK_MS = 250;
const FLICK_PX = 40;
/** The bottom band of the live video belongs to its native controls. */
const VIDEO_CONTROLS_BAND_PX = 52;

type VideoBox = { left: number; top: number; width: number; height: number };

export type JourneyBookOpenTarget = { routePointId: string | null; assetId: string | null };

function journeyRange(journey: Journey) {
  return journey.endedOn && journey.endedOn !== journey.startedOn
    ? `${journey.startedOn} — ${journey.endedOn}`
    : journey.startedOn;
}

function pageAsset(page: JourneyBookPage | undefined): JourneyMediaAsset | null {
  if (!page) return null;
  if (page.kind === "media") return page.asset;
  if (page.kind === "cover") return page.asset;
  return null;
}

function visiblePages(current: number, count: number, orientation: JourneyBookOrientation): number[] {
  if (orientation === "portrait" || current === 0 || current >= count - 1) return [current];
  return [current, current + 1];
}

function pageLabel(page: JourneyBookPage, index: number, count: number): string {
  if (page.kind === "cover") return "封面";
  if (page.kind === "end") return "封底";
  return `第 ${index} / ${count - 2} 页`;
}

function sameLayout(left: JourneyBookLayout | null, right: JourneyBookLayout | null): boolean {
  return left === right || Boolean(left && right
    && left.orientation === right.orientation
    && left.pageWidth === right.pageWidth
    && left.pageHeight === right.pageHeight);
}

/**
 * #393 trial: a Journey read as a book. Opens in place of Story when the
 * per-device presentation style is `book`; Story remains one tap away for
 * editing. Pages hold pictures and still frames only; the Book owns exactly
 * one `<video>`, laid over the page it belongs to once a turn has settled, so
 * PageFlip's portrait page copy can never become a second live transport.
 */
export function JourneyBook({
  journeys,
  journeyId,
  routePointId = null,
  initialAssetId = null,
  onClose,
  onOpenClassic,
  onNavigate,
  onObservationChange,
}: {
  journeys: readonly Journey[];
  journeyId: string;
  routePointId?: string | null;
  initialAssetId?: string | null;
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
  const pages = useMemo(() => (journey ? journeyBookPages(journey) : []), [journey]);
  const pageSignature = pages.map((page) => page.key).join("|");
  // PageFlip moves its page nodes around and copies them, so the Book gives it
  // plain elements it owns and renders each page's content into them through a
  // portal; React never reconciles a node PageFlip has moved.
  const pageElements = useMemo(() => pages.map((page) => {
    const element = document.createElement("article");
    element.className = `journey-book__page journey-book__page--${page.kind}`;
    if (page.kind === "cover" || page.kind === "end") element.dataset.density = "hard";
    return element;
  }), [pageSignature]);
  const soundtrack = journey ? journeySoundtrack(journey) : null;

  // The Book is keyed by Journey, so the opening target is read once.
  const [startPage] = useState(() => journeyBookStartPage(pages, { routePointId, assetId: initialAssetId }));
  const [current, setCurrent] = useState(startPage);
  const currentRef = useRef(startPage);
  const [layout, setLayout] = useState<JourneyBookLayout | null>(null);
  // The layout PageFlip was created for. It changes only when PageFlip would
  // decide differently (see `journeyBookLayoutCompatible`); every other
  // resize keeps the open book and only resizes it.
  const [builtLayout, setBuiltLayout] = useState<JourneyBookLayout | null>(null);
  if (layout && (!builtLayout || !journeyBookLayoutCompatible(builtLayout, layout))) setBuiltLayout(layout);
  const orientation = layout?.orientation ?? "landscape";
  const [turning, setTurning] = useState(false);
  // Set before a programmatic turn: PageFlip copies the turning page before
  // it reports the turn, so notes must already be plain text by then.
  const [notesSettled, setNotesSettled] = useState(false);
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(() => new Set());
  const [reduced, setReduced] = useState(prefersReducedMotion);
  const [chosenVideoId, setChosenVideoId] = useState<string | null>(null);
  const [videoBox, setVideoBox] = useState<VideoBox | null>(null);
  const [tocOpen, setTocOpen] = useState(false);
  const flipRef = useRef<PageFlip | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const rootRef = useModalFocus<HTMLDivElement>(onClose);

  useEffect(() => onMotionPreferenceChange(setReduced), []);

  // The stage decides portrait or spread and the page size, from both of its
  // dimensions, so the whole book always fits (#393 short landscape).
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => {
      // The content box: short landscape pads the stage for the turn buttons.
      const style = getComputedStyle(stage);
      const next = journeyBookLayout(
        stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
      );
      setLayout((previous) => (sameLayout(previous, next) ? previous : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || !builtLayout || pageElements.length === 0) return;
    const block = document.createElement("div");
    block.className = "journey-book__block";
    host.appendChild(block);
    const flip = new PageFlip(block, {
      // Only the ratio matters in stretch mode; the block's width sets the size.
      width: builtLayout.pageWidth,
      height: builtLayout.pageHeight,
      size: "stretch",
      minWidth: journeyBookFlipMinWidth(builtLayout),
      maxWidth: 10_000,
      minHeight: 1,
      maxHeight: 10_000,
      startPage: Math.min(currentRef.current, pageElements.length - 1),
      drawShadow: true,
      // Reduced Motion turns the page at once; a CSS rule alone cannot reach
      // PageFlip's JavaScript animation.
      flippingTime: reduced ? 1 : FLIP_MS,
      usePortrait: true,
      startZIndex: 10,
      autoSize: true,
      maxShadowOpacity: 0.42,
      showCover: true,
      mobileScrollSupport: true,
      clickEventForward: true,
      // The Book forwards pointer input itself (onStagePointerDown).
      useMouseEvents: false,
      swipeDistance: 24,
      showPageCorners: !reduced,
      // A tap on a picture or video frame is not a page turn.
      disableFlipByClick: true,
    });
    flip.loadFromHTML(pageElements);
    // A rebuild in the middle of a turn never reports its end.
    setTurning(false);
    setNotesSettled(false);
    flip.on("flip", (event) => {
      // `update()` on a resize re-announces the same page; only a real page
      // change gives the live video back to the first video on the spread.
      if (event.data !== currentRef.current) setChosenVideoId(null);
      currentRef.current = event.data;
      setCurrent(event.data);
      setNotesSettled(false);
    });
    // Synchronous, so a note still entering is settled into plain text
    // before PageFlip copies the turning page.
    flip.on("changeState", (event) => flushSync(() => setTurning(event.data !== "read")));
    flipRef.current = flip;
    return () => {
      flipRef.current = null;
      // With useMouseEvents off, destroy() leaves its window resize listener.
      (flip as unknown as { ui?: { removeHandlers?: () => void } }).ui?.removeHandlers?.();
      flip.destroy();
    };
  }, [pageElements, reduced, builtLayout]);

  // A resize that keeps PageFlip's decision only resizes the open book.
  useLayoutEffect(() => {
    flipRef.current?.update();
  }, [layout]);

  const visible = useMemo(
    () => visiblePages(current, pages.length, orientation),
    [current, orientation, pages.length],
  );

  useEffect(() => {
    if (turning) return;
    setRevealed((previous) => {
      if (visible.every((index) => previous.has(index))) return previous;
      const next = new Set(previous);
      for (const index of visible) next.add(index);
      return next;
    });
  }, [turning, visible]);

  // Media for the pages around the reader, and the soundtrack.
  const wantedAssets = useMemo(() => {
    const assets: JourneyMediaAsset[] = soundtrack ? [soundtrack] : [];
    for (let index = Math.max(0, current - READ_BEHIND); index <= Math.min(pages.length - 1, current + READ_AHEAD); index += 1) {
      const asset = pageAsset(pages[index]);
      if (asset) assets.push(asset);
    }
    return assets;
  }, [current, pages, soundtrack]);
  const { reads, expireRead, clearRetry } = useReaderReads(readMedia, wantedAssets);
  const stillCandidates = useMemo(() => {
    const assets: JourneyMediaAsset[] = [];
    for (let index = Math.max(0, current - 1); index <= Math.min(pages.length - 1, current + 2); index += 1) {
      const asset = pageAsset(pages[index]);
      if (asset) assets.push(asset);
    }
    return assets;
  }, [current, pages]);
  const stills = useVideoStills(reads, stillCandidates);

  // The one live video: on the chosen visible video page, else the first.
  const visibleVideos = visible
    .map((index) => ({ index, asset: pageAsset(pages[index]) }))
    .filter((entry): entry is { index: number; asset: JourneyMediaAsset } => (
      pages[entry.index]?.kind === "media" && isVideo(entry.asset)
    ));
  const liveVideo = visibleVideos.find((entry) => entry.asset.id === chosenVideoId) ?? visibleVideos[0] ?? null;
  const liveVideoRead = liveVideo ? reads[liveVideo.asset.id] : undefined;
  const liveVideoUrl = liveVideoRead?.status === "ready" ? withStillFragment(liveVideoRead.read.url) : null;
  const liveVideoStill = liveVideo ? stills[liveVideo.asset.id] : null;
  const liveVideoPoster = videoPosterUrl(liveVideoRead, liveVideoStill);
  const liveVideoIndex = liveVideo?.index ?? null;
  const liveVideoId = liveVideo?.asset.id ?? null;

  const measureVideo = useCallback(() => {
    const stage = stageRef.current;
    const frame = liveVideoIndex !== null
      ? pageElements[liveVideoIndex]?.querySelector<HTMLElement>("[data-book-video-frame]")
      : null;
    if (!stage || !frame) {
      setVideoBox(null);
      return;
    }
    const stageRect = stage.getBoundingClientRect();
    const rect = frame.getBoundingClientRect();
    const next = {
      left: Math.round(rect.left - stageRect.left),
      top: Math.round(rect.top - stageRect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
    setVideoBox((previous) => previous
      && previous.left === next.left && previous.top === next.top
      && previous.width === next.width && previous.height === next.height ? previous : next);
  }, [liveVideoIndex, pageElements]);

  // A turn pauses the live video; the page underneath keeps its still frame.
  useEffect(() => {
    if (turning) videoRef.current?.pause();
  }, [turning]);

  useLayoutEffect(() => {
    if (turning || liveVideoIndex === null) {
      setVideoBox(null);
      return;
    }
    // PageFlip settles its transforms in the next frame.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(measureVideo);
    });
    return () => cancelAnimationFrame(frame);
  }, [turning, liveVideoId, liveVideoIndex, layout, measureVideo]);

  useEffect(() => {
    const stage = stageRef.current;
    const rig = hostRef.current;
    if (!stage || !rig) return;
    const remeasure = () => {
      if (flipRef.current?.getState() === "read") measureVideo();
    };
    const observer = new ResizeObserver(remeasure);
    observer.observe(stage);
    // Leaving the cover slides the open book sideways; a translate is not a
    // resize, so the live video follows the page once the slide ends.
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target === rig) remeasure();
    };
    rig.addEventListener("transitionend", onTransitionEnd);
    return () => {
      observer.disconnect();
      rig.removeEventListener("transitionend", onTransitionEnd);
    };
  }, [measureVideo]);

  const soundtrackRead = soundtrack ? reads[soundtrack.id] : undefined;
  const soundtrackUrl = soundtrackRead?.status === "ready" ? soundtrackRead.read.url : null;
  const { audioRef, musicOn, toggleMusic, reportVideo } = useReaderSoundtrack(soundtrackUrl, reduced);
  const updateVideoAudible = useCallback(() => reportVideo(videoRef.current), [reportVideo]);
  useEffect(() => {
    if (liveVideoId === null) reportVideo(null);
  }, [liveVideoId, reportVideo]);

  const currentPage = pages[current];
  useEffect(() => {
    if (!journey) return;
    const routePoint = journeyBookPageRoutePointId(currentPage);
    const asset = currentPage?.kind === "media" ? currentPage.asset : null;
    onObservationChange?.({
      journeyId: journey.id,
      routePointId: routePoint,
      assetId: asset?.id ?? null,
      storySnapState: "in-context",
    });
  }, [currentPage, journey, onObservationChange]);

  const chapters = useMemo(() => {
    const seen = new Set<string>();
    const entries: { index: number; label: string }[] = [{ index: 0, label: "封面" }];
    pages.forEach((page, index) => {
      if (page.kind !== "media" && page.kind !== "note") return;
      const key = page.routePoint?.id ?? "journey";
      if (seen.has(key)) return;
      seen.add(key);
      entries.push({ index, label: page.routePoint?.label || "整段旅程" });
    });
    return entries;
  }, [pages]);

  function turn(direction: -1 | 1) {
    const flip = flipRef.current;
    if (!flip || flip.getState() !== "read") return;
    flushSync(() => setNotesSettled(true));
    if (direction < 0) flip.flipPrev();
    else flip.flipNext();
  }

  function jumpTo(index: number) {
    setTocOpen(false);
    flushSync(() => setNotesSettled(true));
    flipRef.current?.turnToPage(index);
    currentRef.current = index;
    setCurrent(index);
  }

  function blockPoint(x: number, y: number) {
    const block = hostRef.current?.querySelector(".stf__block")?.getBoundingClientRect();
    return block ? { x: x - block.left, y: y - block.top } : { x, y };
  }

  /**
   * Every page gesture, including one that starts on the live video (which
   * sits above the page, out of PageFlip's reach). Buttons, links and the
   * native video controls band keep their own input.
   */
  function onStagePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const flip = flipRef.current;
    // A corner lifted by hover is where a desktop drag usually starts.
    if (!flip || (flip.getState() !== "read" && flip.getState() !== "fold_corner")) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, a, input, select, textarea")) return;
    const video = target.closest("video");
    if (!video && !target.closest(".stf__block")) return;
    if (video && video.getBoundingClientRect().bottom - event.clientY < VIDEO_CONTROLS_BAND_PX) return;
    const start = { x: event.clientX, y: event.clientY, time: performance.now(), pointerId: event.pointerId };
    let engaged = false;
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== start.pointerId) return;
      const dx = moveEvent.clientX - start.x;
      const dy = moveEvent.clientY - start.y;
      if (!engaged) {
        if (Math.abs(dx) < DRAG_SLOP_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return;
        engaged = true;
        videoRef.current?.pause();
        flushSync(() => setNotesSettled(true));
        flip.startUserTouch(blockPoint(start.x, start.y));
      }
      moveEvent.preventDefault();
      flip.userMove(blockPoint(moveEvent.clientX, moveEvent.clientY), true);
    };
    const end = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== start.pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      const point = blockPoint(endEvent.clientX, endEvent.clientY);
      if (!engaged) {
        // A tap: PageFlip turns only when it lands on a page corner
        // (disableFlipByClick), as its own input would.
        if (endEvent.type === "pointerup" && !video) {
          flip.startUserTouch(point);
          flip.userStop(point);
        }
        return;
      }
      const dx = endEvent.clientX - start.x;
      if (endEvent.type === "pointerup" && performance.now() - start.time < FLICK_MS && Math.abs(dx) > FLICK_PX) {
        if (dx < 0) flip.flipNext();
        else flip.flipPrev();
        flip.userStop(point, true);
      } else {
        flip.userStop(point);
      }
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  /** Desktop hover lifts the page corner, as PageFlip's own mouse input did. */
  function onStagePointerHover(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType !== "mouse" || event.buttons !== 0 || reduced) return;
    const flip = flipRef.current;
    if (!flip || flip.getState() === "flipping" || flip.getState() === "user_fold") return;
    flip.userMove(blockPoint(event.clientX, event.clientY), false);
  }

  /** Leaving the book lays a lifted corner back down. */
  function onStagePointerLeave(event: ReactPointerEvent<HTMLDivElement>) {
    const flip = flipRef.current;
    const block = hostRef.current?.querySelector(".stf__block")?.getBoundingClientRect();
    if (event.pointerType !== "mouse" || !flip || !block || flip.getState() !== "fold_corner") return;
    flip.userMove({ x: block.width / 2, y: block.height / 2 }, false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target.closest("video, input, textarea, select")) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      turn(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      turn(1);
    }
  }

  if (!journey) return null;
  const edge = current === 0 ? "front" : current >= pages.length - 1 ? "back" : "inside";
  const classicTarget: JourneyBookOpenTarget = {
    routePointId: journeyBookPageRoutePointId(currentPage),
    assetId: currentPage?.kind === "media" ? currentPage.asset.id : null,
  };
  const journeyLinks = onNavigate ? { previous: previousJourney, next: nextJourney, onNavigate } : null;

  return (
    <div
      ref={rootRef}
      className="journey-book"
      role="dialog"
      aria-modal="true"
      aria-label={`${journey.title} · 旅程之书`}
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
              <li key={chapter.index}>
                <button
                  type="button"
                  aria-current={chapter.index <= current && current < (chapters[position + 1]?.index ?? Infinity) ? "true" : undefined}
                  onClick={() => jumpTo(chapter.index)}
                >{chapter.label}</button>
              </li>
            ))}
          </ol>
          {journeyLinks && (journeyLinks.previous || journeyLinks.next) ? (
            <div className="journey-book__toc-journeys">
              {journeyLinks.previous ? (
                <button type="button" onClick={() => journeyLinks.onNavigate(journeyLinks.previous!.id)}>
                  <small>上一段旅程</small>{journeyLinks.previous.title}
                </button>
              ) : null}
              {journeyLinks.next ? (
                <button type="button" onClick={() => journeyLinks.onNavigate(journeyLinks.next!.id)}>
                  <small>下一段旅程</small>{journeyLinks.next.title}
                </button>
              ) : null}
            </div>
          ) : null}
        </nav>
      ) : null}
      <div
        ref={stageRef}
        className="journey-book__stage"
        onPointerDown={onStagePointerDown}
        onPointerMove={onStagePointerHover}
        onPointerLeave={onStagePointerLeave}
      >
        <div
          ref={hostRef}
          className="journey-book__rig"
          data-edge={edge}
          data-orientation={orientation}
          style={layout ? { width: journeyBookBlockWidth(layout), height: layout.pageHeight } as CSSProperties : undefined}
        />
        {liveVideo ? (
          <video
            ref={videoRef}
            className="journey-book__video"
            src={liveVideoUrl ?? undefined}
            poster={liveVideoPoster}
            controls
            playsInline
            preload="metadata"
            hidden={!videoBox || !liveVideoUrl}
            style={videoBox ?? undefined}
            onPlay={updateVideoAudible}
            onPause={updateVideoAudible}
            onEnded={updateVideoAudible}
            onEmptied={updateVideoAudible}
            onVolumeChange={updateVideoAudible}
            onCanPlay={() => liveVideoId && clearRetry(liveVideoId)}
            onError={() => liveVideoId && expireRead(liveVideoId)}
          />
        ) : null}
      </div>
      <footer className="journey-book__controls">
        <button
          type="button"
          className="journey-book__icon journey-book__turn"
          aria-label="上一页"
          disabled={current === 0}
          onClick={() => turn(-1)}
        ><IconArrowLeft size={18} stroke={1.35} aria-hidden="true" /></button>
        <span className="journey-book__status" aria-live="polite">
          {currentPage ? pageLabel(currentPage, current, pages.length) : ""}
        </span>
        <button
          type="button"
          className="journey-book__icon journey-book__turn"
          aria-label="下一页"
          disabled={current >= pages.length - 1}
          onClick={() => turn(1)}
        ><IconArrowRight size={18} stroke={1.35} aria-hidden="true" /></button>
      </footer>
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
      {pages.map((page, index) => createPortal(
        <JourneyBookPageContent
          journey={journey}
          page={page}
          index={index}
          count={pages.length}
          read={(() => {
            const asset = pageAsset(page);
            return asset ? reads[asset.id] : undefined;
          })()}
          still={(() => {
            const asset = pageAsset(page);
            const still = asset ? stills[asset.id] ?? null : null;
            // A canvas is one element and can sit on one page only; the cover
            // shares its asset with that asset's own page (#555).
            return page.kind === "cover" && still?.kind === "canvas" ? null : still;
          })()}
          noteState={revealed.has(index) ? (turning || notesSettled ? "settled" : "live") : "hidden"}
          near={Math.abs(index - current) <= RENDER_WINDOW}
          videoIsLive={liveVideo?.index === index && Boolean(videoBox)}
          onChooseVideo={(assetId) => setChosenVideoId(assetId)}
          onExpired={expireRead}
          onLoaded={clearRetry}
          journeyLinks={page.kind === "end" ? journeyLinks : null}
        />,
        pageElements[index],
        page.key,
      ))}
    </div>
  );
}

function BookPicture({ asset, read, onExpired, onLoaded }: {
  asset: JourneyMediaAsset;
  read: Read | undefined;
  onExpired: (assetId: string) => void;
  onLoaded: (assetId: string) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  if (!read || read.status === "loading") return <span className="journey-book__plate-state">正在翻到这一页…</span>;
  if (read.status === "error") return <span className="journey-book__plate-state">这张照片暂时无法读取</span>;
  const preview = read.read.preview;
  return (
    <>
      {preview && !loaded ? <img className="journey-book__picture" src={preview.url} alt="" draggable={false} /> : null}
      <img
        className={`journey-book__picture${loaded ? " is-loaded" : ""}`}
        src={read.read.url}
        alt={asset.fileName}
        draggable={false}
        decoding="async"
        onLoad={() => {
          setLoaded(true);
          onLoaded(asset.id);
        }}
        onError={() => onExpired(asset.id)}
      />
    </>
  );
}

function JourneyBookPageContent({
  journey,
  page,
  index,
  count,
  read: pageRead,
  still,
  noteState,
  near,
  videoIsLive,
  onChooseVideo,
  onExpired,
  onLoaded,
  journeyLinks,
}: {
  journey: Journey;
  page: JourneyBookPage;
  index: number;
  count: number;
  read: Read | undefined;
  still: VideoStill | null;
  noteState: "hidden" | "live" | "settled";
  near: boolean;
  videoIsLive: boolean;
  onChooseVideo: (assetId: string) => void;
  onExpired: (assetId: string) => void;
  onLoaded: (assetId: string) => void;
  journeyLinks: { previous: Journey | null; next: Journey | null; onNavigate: (journeyId: string) => void } | null;
}) {
  const side = index % 2 === 1 ? "verso" : "recto";
  // Far pages keep their layout and notes but release their pictures.
  const read = near ? pageRead : undefined;
  if (page.kind === "cover") {
    return (
      <div className={`journey-book__sheet journey-book__sheet--cloth journey-book__sheet--cover${page.asset ? " has-plate" : ""}`}>
        <header className="journey-book__cover-head">
          <h1 className="journey-book__cover-title">{journey.title}</h1>
          <p className="journey-book__cover-dates"><span>{journeyRange(journey)}</span>{coverDateCount(journey.routePoints.length) ? <span>{coverDateCount(journey.routePoints.length)}</span> : null}</p>
        </header>
        <CoverRoute routePoints={journey.routePoints} />
        <svg
          className="journey-book__cover-mark"
          viewBox={STARTRIPS_V12_MARK_VIEWBOX}
          aria-hidden="true"
          focusable="false"
          dangerouslySetInnerHTML={{ __html: STARTRIPS_V12_MARK_MARKUP }}
        />
        {page.asset ? (
          <figure className="journey-book__cover-plate">
            {isVideo(page.asset)
              ? <VideoFrame asset={page.asset} read={read} still={still} live={false} onChoose={null} />
              : <BookPicture asset={page.asset} read={read} onExpired={onExpired} onLoaded={onLoaded} />}
          </figure>
        ) : null}
      </div>
    );
  }
  if (page.kind === "end") {
    return (
      <div className="journey-book__sheet journey-book__sheet--cloth">
        {journeyLinks && (journeyLinks.previous || journeyLinks.next) ? (
          <div className="journey-book__journey-links">
            {journeyLinks.next ? (
              <button type="button" onClick={() => journeyLinks.onNavigate(journeyLinks.next!.id)}>
                <small>下一段旅程</small>{journeyLinks.next.title}
              </button>
            ) : null}
            {journeyLinks.previous ? (
              <button type="button" onClick={() => journeyLinks.onNavigate(journeyLinks.previous!.id)}>
                <small>上一段旅程</small>{journeyLinks.previous.title}
              </button>
            ) : null}
          </div>
        ) : null}
        <span className="journey-book__back-mark">{journey.title}</span>
      </div>
    );
  }
  if (page.kind === "blank") return <div className={`journey-book__sheet journey-book__sheet--endpaper is-${side}`} />;
  if (page.kind === "note") {
    return (
      <div className={`journey-book__sheet is-${side}`}>
        <div className="journey-book__text-block">
          {page.routePoint?.label ? <h3>{page.routePoint.label}</h3> : null}
          {noteState !== "hidden"
            ? <RevealedNote text={page.note} settled={noteState === "settled"} collapsible={false} className="is-inline journey-book__page-note" />
            : <p className="journey-book__note-placeholder" aria-hidden="true">{page.note}</p>}
        </div>
        <span className="journey-book__folio">{index}</span>
      </div>
    );
  }
  const plate = isVideo(page.asset) ? "is-video" : "is-picture";
  return (
    <div className={`journey-book__sheet is-${side}`}>
      <figure className={`journey-book__plate ${plate}`}>
        {isVideo(page.asset)
          ? <VideoFrame asset={page.asset} read={read} still={still} live={videoIsLive} onChoose={onChooseVideo} />
          : <BookPicture asset={page.asset} read={read} onExpired={onExpired} onLoaded={onLoaded} />}
        {page.note && noteState !== "hidden" ? (
          <RevealedNote text={page.note} settled={noteState === "settled"} />
        ) : null}
      </figure>
      {page.routePoint?.label ? <span className="journey-book__caption">{page.routePoint.label}</span> : null}
      <span className="journey-book__folio" aria-label={pageLabel(page, index, count)}>{index}</span>
    </div>
  );
}

/** Band units: the SVG is drawn in a 100-unit-high box of the band's aspect. */
const COVER_BAND_HEIGHT = 100;
const COVER_BAND_WIDTH = COVER_ROUTE_ASPECT * COVER_BAND_HEIGHT;
/** Band units per cover width, for the stroke sizes given as fractions of it. */
const COVER_UNITS = COVER_BAND_WIDTH / COVER_ROUTE_BAND.width;

/** The Journey's Route, blind-debossed into the cover cloth (start dark, end foil). */
function CoverRoute({ routePoints }: { routePoints: Journey["routePoints"] }) {
  const geometry = useMemo(() => coverRouteGeometry(routePoints), [routePoints]);
  if (geometry.kind === "none") return null;
  const d = coverRouteSvgPath(geometry, COVER_BAND_WIDTH, COVER_BAND_HEIGHT);
  const offset = -COVER_ROUTE_STROKE.highlightOffset * COVER_UNITS;
  const square = (vec: { x: number; y: number }, size: number) => ({
    x: vec.x * COVER_BAND_WIDTH - (size * COVER_UNITS) / 2,
    y: vec.y * COVER_BAND_HEIGHT - (size * COVER_UNITS) / 2,
    width: size * COVER_UNITS,
    height: size * COVER_UNITS,
  });
  return (
    <svg className="journey-book__cover-route" viewBox={`0 0 ${COVER_BAND_WIDTH} ${COVER_BAND_HEIGHT}`} aria-hidden="true" focusable="false">
      {geometry.kind === "path" ? (
        <>
          <path className="journey-book__cover-route-deboss" d={d} strokeWidth={COVER_ROUTE_STROKE.deboss * COVER_UNITS} />
          <path
            className="journey-book__cover-route-highlight"
            d={d}
            strokeWidth={COVER_ROUTE_STROKE.highlight * COVER_UNITS}
            transform={`translate(${offset} ${offset})`}
          />
          <rect className="journey-book__cover-route-start" {...square(geometry.start, COVER_ROUTE_STROKE.start)} />
        </>
      ) : null}
      <rect className="journey-book__cover-route-end" {...square(geometry.end, COVER_ROUTE_STROKE.end)} />
    </svg>
  );
}

/**
 * A video page shows its poster — the server's, or a still decoded in the
 * browser — and never a `<video>`. The Book lays its single live transport
 * over this frame after a turn.
 */
function VideoFrame({ asset, read, still, live, onChoose }: {
  asset: JourneyMediaAsset;
  read: Read | undefined;
  still: VideoStill | null;
  live: boolean;
  onChoose: ((assetId: string) => void) | null;
}) {
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const poster = videoPosterUrl(read, still);
  const canvas = !poster && still?.kind === "canvas" ? still.canvas : null;
  useLayoutEffect(() => {
    const host = canvasHostRef.current;
    if (!host || !canvas) return;
    canvas.classList.add("journey-book__picture", "is-loaded");
    host.replaceChildren(canvas);
    return () => host.replaceChildren();
  }, [canvas]);
  return (
    <div className={`journey-book__video-frame${live ? " is-live" : ""}`} data-book-video-frame="">
      {poster ? <img className="journey-book__picture is-loaded" src={poster} alt="" draggable={false} /> : null}
      {canvas ? <div ref={canvasHostRef} className="journey-book__still-host" aria-hidden="true" /> : null}
      {!live && onChoose ? (
        <button type="button" className="journey-book__video-choose" aria-label={`播放 ${asset.fileName}`} onClick={() => onChoose(asset.id)}>
          <IconPlayerPlay size={22} stroke={1.35} aria-hidden="true" />
        </button>
      ) : null}
      {read?.status === "error" ? <span className="journey-book__plate-state">这段视频暂时无法读取</span> : null}
    </div>
  );
}

export default JourneyBook;
