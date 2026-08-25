import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  IconArrowLeft,
  IconArrowRight,
  IconChevronLeft,
  IconChevronRight,
  IconPlayerPause,
  IconPlayerPlay,
  IconX,
} from "@tabler/icons-react";
import { getPrivateMediaRead } from "./journeyApi";
import {
  createDecodeRegistry,
  decodeImageUrl,
} from "./mediaPrefetch";
import { useJourneyPlaybackDirector } from "./useJourneyPlaybackDirector";
import { playbackMediaForPoint, type PlaybackStep } from "./journeyPlayback";
import { journeySoundtrack, stripMediaExtension } from "./journeyModel";
import { createSoundtrackSampler } from "../motion/audioSampler";
import { prefersReducedMotion } from "../motion/preferences";
import type { Journey, JourneyMediaAsset } from "./types";

type MediaRead =
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "error"; message: string };

/**
 * #19 Journey Playback overlay.
 *
 * A cinematic chapter player: intro -> travel (globe fly-to) -> stop (place +
 * note) -> memories (media slideshow) -> outro. The soundtrack plays for the
 * whole run, never resetting between chapters. The overlay translates each
 * phase into visible content; camera control is delegated to the parent via
 * onFocusRoutePoint so the globe is never remounted.
 */
export function JourneyPlaybackOverlay({
  journey,
  onClose,
  onFocusRoutePoint,
  reduceMotion,
}: {
  journey: Journey | null;
  onClose: () => void;
  onFocusRoutePoint: (pointIndex: number) => void;
  reduceMotion?: boolean;
}) {
  const director = useJourneyPlaybackDirector(journey);
  const { phase, paused, pause, resume, next, back, exit } = director;
  // Review P2: `exit()` only resets the local director; the overlay must also
  // tell the parent to drop playbackJourneyId, or playback can never close.
  const requestClose = useCallback(() => {
    exit();
    onClose();
  }, [exit, onClose]);
  const [mediaReads, setMediaReads] = useState<Record<string, MediaRead>>({});
  const decodeRegistryRef = useRef(createDecodeRegistry(decodeImageUrl));
  // Review P2: decode settles without React state; this revision bumps on
  // every settle so the media gate re-renders once the image is decoded.
  const [decodeSettleRevision, setDecodeSettleRevision] = useState(0);
  useEffect(() => decodeRegistryRef.current.onSettle(
    () => setDecodeSettleRevision((current) => current + 1),
  ), []);
  const audioRef = useRef<HTMLAudioElement>(null);
  // #20: one sampler per soundtrack element; analyser built on first play.
  const samplerRef = useRef(createSoundtrackSampler());
  const lightStripRef = useRef<HTMLDivElement>(null);
  const [controlsHidden, setControlsHidden] = useState(false);
  const pendingReads = useRef(new Set<string>());
  // Review P2: the playback overlay is its own focus trap (rendered outside
  // any dialog that would otherwise manage Tab focus).
  const overlayRef = useRef<HTMLDivElement>(null);

  const soundtrack = useMemo(
    () => journey ? journeySoundtrack(journey) : null,
    [journey],
  );
  const soundtrackRead = soundtrack ? mediaReads[soundtrack.id] : null;

  const loadMediaRead = useCallback((assetId: string) => {
    if (pendingReads.current.has(assetId)) return;
    pendingReads.current.add(assetId);
    setMediaReads((current) => current[assetId]?.status === "ready"
      ? current
      : { ...current, [assetId]: { status: "loading" } });
    void getPrivateMediaRead(assetId).then(
      (read) => setMediaReads((current) => ({
        ...current,
        [assetId]: { status: "ready", url: read.url },
      })),
      (error) => setMediaReads((current) => ({
        ...current,
        [assetId]: {
          status: "error",
          message: error instanceof Error ? error.message : "媒体读取失败",
        },
      })),
    ).finally(() => pendingReads.current.delete(assetId));
  }, []);

  // Load the soundtrack and any media the current step needs.
  useEffect(() => {
    if (soundtrack) loadMediaRead(soundtrack.id);
    if (!journey) return;
    const step = director.step;
    if (step?.kind === "media") {
      const asset = playbackMediaForPoint(journey, step.pointIndex)[step.mediaIndex];
      if (asset) loadMediaRead(asset.id);
    } else if (step?.kind === "stop") {
      for (const asset of playbackMediaForPoint(journey, step.pointIndex)) {
        loadMediaRead(asset.id);
      }
    }
  }, [journey, director.step, loadMediaRead, soundtrack]);

  // Decode the active media image ahead of display.
  useEffect(() => {
    if (!journey) return;
    const step = director.step;
    if (step?.kind !== "media") return;
    const asset = playbackMediaForPoint(journey, step.pointIndex)[step.mediaIndex];
    if (!asset || !asset.mimeType.startsWith("image/")) return;
    const read = mediaReads[asset.id];
    if (read?.status === "ready") {
      decodeRegistryRef.current.ensure(asset.id, read.url);
    }
  }, [decodeSettleRevision, director.step, journey, mediaReads]);

  // The soundtrack follows playback: play on any non-paused phase after the
  // user started playback; pause when paused; never reset between chapters.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !soundtrackRead || soundtrackRead.status !== "ready") return;
    if (paused || !director.isPlaying) {
      audio.pause();
      return;
    }
    void audio.play().catch(() => undefined);
  }, [paused, director.isPlaying, soundtrackRead?.status === "ready"]);

  // #20: on first real play, build the analyser and drive the light strip /
  // atmosphere from smoothed low/mid energy. Under reduced motion the strip
  // stays static. If the analyser cannot be built (CORS etc.), playback
  // continues and the CSS-only playing animation remains.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !soundtrackRead || soundtrackRead.status !== "ready") return;
    if (!director.isPlaying || paused) return;
    const reduced = prefersReducedMotion();
    if (reduced) return;
    const sampler = samplerRef.current;
    sampler.start(audio);
    const strip = lightStripRef.current;
    if (!sampler.isActive()) return;
    let frame = 0;
    const drive = () => {
      const energy = sampler.getEnergy();
      if (strip) {
        // Clamp to a small visual range: glow width 0.4..1, brightness 0.4..1.
        strip.style.setProperty("--audio-width", String(0.4 + energy.mid * 0.6));
        strip.style.setProperty("--audio-brightness", String(0.4 + energy.overall * 0.6));
      }
      frame = window.requestAnimationFrame(drive);
    };
    frame = window.requestAnimationFrame(drive);
    return () => window.cancelAnimationFrame(frame);
  }, [director.isPlaying, paused, soundtrackRead?.status === "ready"]);

  // Release the analyser and AudioContext when playback closes.
  useEffect(() => {
    return () => samplerRef.current.stop();
  }, []);

  useEffect(() => () => audioRef.current?.pause(), []);

  // Controls fade out after idle; any pointer/key/touch activity shows them
  // AND restarts the 2.5s timer (review P2: previously activity only revealed
  // controls and the timer never re-armed after the first hide).
  useEffect(() => {
    if (!director.isPlaying) return;
    let timer = 0;
    const restartIdle = () => {
      setControlsHidden(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setControlsHidden(true), 2500);
    };
    const onActivity = () => restartIdle();
    window.addEventListener("pointermove", onActivity);
    window.addEventListener("pointerdown", onActivity);
    window.addEventListener("touchstart", onActivity, { passive: true });
    window.addEventListener("keydown", onActivity);
    restartIdle();
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointermove", onActivity);
      window.removeEventListener("pointerdown", onActivity);
      window.removeEventListener("touchstart", onActivity);
      window.removeEventListener("keydown", onActivity);
    };
  }, [director.isPlaying, director.stepIndex]);

  // Review P2: toggle playback from the user gesture so audio.play() runs
  // inside user activation; the soundtrack effect below stays as the
  // synchronization/fallback path.
  const togglePlayback = useCallback(() => {
    if (paused) {
      const audio = audioRef.current;
      if (audio && soundtrackRead?.status === "ready") {
        void audio.play().catch(() => undefined);
      }
      resume();
    } else {
      pause();
    }
  }, [paused, pause, resume, soundtrackRead?.status === "ready"]);

  // Camera: travel and stop phases focus the relevant route point.
  useEffect(() => {
    const step = director.step;
    if (step?.kind === "travel") {
      onFocusRoutePoint(step.to);
    } else if (step?.kind === "stop") {
      onFocusRoutePoint(step.pointIndex);
    }
  }, [director.step, onFocusRoutePoint]);

  // Keyboard: arrows step, space pauses, Esc exits.
  useEffect(() => {
    if (!director.isPlaying && !paused) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
      else if (event.key === "ArrowRight") next();
      else if (event.key === "ArrowLeft") back();
      else if (event.key === " ") {
        event.preventDefault();
        if (paused) resume(); else pause();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [director.isPlaying, paused, pause, resume, next, back, requestClose]);

  // Review P2: keep Tab focus inside the playback overlay.
  useEffect(() => {
    const root = overlayRef.current;
    if (!root) return;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusable = () => [...root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((element) => (
      element.getClientRects().length > 0
      && getComputedStyle(element).visibility !== "hidden"
    ));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const candidates = focusable();
      if (candidates.length === 0) return;
      const first = candidates[0];
      const last = candidates[candidates.length - 1];
      const current = document.activeElement;
      if (event.shiftKey && (current === first || !root.contains(current))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || !root.contains(current))) {
        event.preventDefault();
        first.focus();
      }
    };
    const firstButton = focusable()[0];
    firstButton?.focus();
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  if (!journey) return null;

  const step: PlaybackStep | undefined = director.step;
  const activeMedia = step?.kind === "media"
    ? playbackMediaForPoint(journey, step.pointIndex)[step.mediaIndex]
    : null;
  const activeRead = activeMedia ? mediaReads[activeMedia.id] : null;
  const activePoint = step?.kind === "stop" || step?.kind === "media"
    ? journey.routePoints[step.pointIndex]
    : step?.kind === "travel"
      ? journey.routePoints[step.to]
      : null;
  const progress = stepsProgress(director.stepIndex, director.steps.length);

  return (
    <div
      ref={overlayRef}
      className={`journey-playback${paused ? " is-paused" : ""}${controlsHidden ? " is-controls-hidden" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="播放旅程"
      data-playback-phase={step?.kind ?? "idle"}
      data-playback-step={director.stepIndex}
      data-playback-steps={director.steps.length}
    >
      <audio
        ref={audioRef}
        src={soundtrackRead?.status === "ready" ? soundtrackRead.url : undefined}
        loop
        preload="metadata"
        tabIndex={-1}
        aria-hidden="true"
      />

      {/* ── Chapter content ─────────────────────────────────────────────── */}
      <div className="journey-playback__stage">
        {step?.kind === "intro" ? (
          <div className="journey-playback__intro">
            <p>JOURNEY PLAYBACK</p>
            <h2>{journey.title}</h2>
            <span>{journey.startedOn}{journey.endedOn ? ` — ${journey.endedOn}` : ""}</span>
          </div>
        ) : null}

        {step?.kind === "travel" && activePoint ? (
          <div className="journey-playback__travel">
            <p>正在前往</p>
            <h3>{activePoint.label || `途径点 ${step.to + 1}`}</h3>
            <div className="journey-playback__route-hint" aria-hidden="true">
              <span />
            </div>
          </div>
        ) : null}

        {step?.kind === "stop" && activePoint ? (
          <div className="journey-playback__stop">
            <p>STOP {step.pointIndex + 1}</p>
            <h3>{activePoint.label || `途径点 ${step.pointIndex + 1}`}</h3>
            {activePoint.note ? (
              <blockquote>{activePoint.note}</blockquote>
            ) : null}
          </div>
        ) : null}

        {step?.kind === "media" && activeMedia ? (
          <div className="journey-playback__media">
            {activeMedia.mimeType.startsWith("video/")
              ? activeRead?.status === "ready"
                ? <video key={activeMedia.id} src={activeRead.url} controls autoPlay playsInline />
                : <div className="journey-playback__media-state">正在打开媒体…</div>
              // Review P2: images must wait for the decode gate too — showing
              // the <img> as soon as the signed URL is ready can still flash
              // a blank frame while the browser decodes (#11 requirement).
              : activeRead?.status === "ready"
                && decodeRegistryRef.current.isDecoded(activeMedia.id)
                ? <img key={activeMedia.id} src={activeRead.url} alt={activeMedia.fileName} />
                : <div className="journey-playback__media-state">正在打开媒体…</div>}
          </div>
        ) : null}

        {step?.kind === "outro" ? (
          <div className="journey-playback__outro">
            <h2>{journey.title}</h2>
            <p>{journey.routePoints.length} 个地点 · 这段路已经走完</p>
          </div>
        ) : null}
      </div>

      {/* ── Controls ────────────────────────────────────────────────────── */}
      <button className="journey-playback__close" type="button" onClick={requestClose} aria-label="退出播放">
        <IconX size={22} stroke={1.35} aria-hidden="true" />
      </button>
      <nav className="journey-playback__controls" aria-label="播放控制">
        <button type="button" onClick={back} aria-label="上一个章节"><IconChevronLeft size={20} stroke={1.35} aria-hidden="true" /></button>
        <button
          type="button"
          className={paused ? "is-active" : ""}
          onClick={togglePlayback}
          aria-label={paused ? "继续播放" : "暂停播放"}
          aria-pressed={paused}
        >
          {paused
            ? <IconPlayerPlay size={20} stroke={1.35} aria-hidden="true" />
            : <IconPlayerPause size={20} stroke={1.35} aria-hidden="true" />}
        </button>
        <button type="button" onClick={next} aria-label="下一个章节"><IconChevronRight size={20} stroke={1.35} aria-hidden="true" /></button>
        <div className="journey-playback__progress" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="播放进度">
          <span style={{ width: `${progress * 100}%` }} />
        </div>
      </nav>

      {/* ── Soundtrack light strip (hidden engine; follows playing) ─────── */}
      {soundtrack && soundtrackRead?.status === "ready" ? (
        <div className={`journey-playback__soundtrack${director.isPlaying ? " is-playing" : ""}`} aria-hidden="true">
          <div ref={lightStripRef} className="journey-playback__soundtrack-light"><span /><span /><span /></div>
          <small>{stripMediaExtension(soundtrack.fileName)}</small>
        </div>
      ) : null}
    </div>
  );
}

function stepsProgress(stepIndex: number, total: number) {
  if (total <= 1) return 1;
  return Math.min(1, Math.max(0, stepIndex / (total - 1)));
}

export function playbackMediaForStep(
  journey: Journey,
  step: PlaybackStep | undefined,
): JourneyMediaAsset | null {
  if (step?.kind !== "media") return null;
  return playbackMediaForPoint(journey, step.pointIndex)[step.mediaIndex] ?? null;
}
