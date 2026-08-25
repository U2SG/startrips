import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconArrowRight,
  IconMapPin,
  IconPhoto,
  IconPlayerPlay,
  IconPlus,
  IconRoute,
  IconTimeline,
  IconWorld,
  IconX,
} from "@tabler/icons-react";
import { useAtlasCapabilities } from "../auth/AuthGateway";
import { CountUp } from "../motion/primitives/CountUp";
import { useMagnet } from "../motion/primitives/Magnet";
import { ScrambledText } from "../motion/primitives/ScrambledText";
import { ShinyText } from "../motion/primitives/ShinyText";
import { morphJourneyCard, runSharedElementTransition } from "../motion/primitives/sharedElement";
import { LivingAtlasGlobe } from "../scene/LivingAtlasGlobe";
import {
  JourneyComposer,
  type GlobePointPick,
  type JourneySaveResult,
} from "./JourneyComposer";
import { JourneyPlaybackOverlay } from "./JourneyPlaybackOverlay";
import { JourneyStory } from "./JourneyStory";
import {
  cachedSoundtrackRead,
  prefetchSoundtrackRead,
} from "./soundtrackReadCache";
import { JourneyTimeline } from "./JourneyTimeline";
import { GlobeTimeScrubber } from "./GlobeTimeScrubber";
import { useGlobeTimeCursor } from "./useGlobeTimeCursor";
import {
  deleteJourney,
  getPrivateMediaRead,
  listJourneys,
  restoreJourney,
} from "./journeyApi";
import {
  journeyCover,
  journeySoundtrack,
  journeyVisualMedia,
  mergeJourney,
  sortJourneysChronologically,
  toJourneyRoutes,
} from "./journeyModel";
import { getLightEffectGradient } from "./lightEffects";
import type { Journey, JourneyRoute } from "./types";

type AtlasView = "planet" | "timeline";

// #8: the root class/data contract for globe focus mode, kept pure so the
// layout toggle is unit-testable without mounting the full app.
export function globeFocusState(focused: boolean) {
  return {
    className: focused ? " is-globe-focus" : "",
    dataAttribute: focused ? "on" : "off",
  };
}

export function playbackEntryNeedsPreparation(
  journey: Journey | null,
  cachedRead: { url: string } | null,
) {
  return Boolean(journey && journeySoundtrack(journey) && !cachedRead);
}

function preferredReducedMotion() {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function journeyFocus(journey: Journey | null) {
  if (!journey || journey.routePoints.length === 0) return null;
  const point = journey.routePoints[Math.floor((journey.routePoints.length - 1) / 2)];
  return { lat: point.latitude, lon: point.longitude };
}

type JourneyCardMediaRead =
  | { status: "idle" | "loading" | "error" }
  | { status: "ready"; url: string };

function JourneyCardMedia({
  journey,
  reduceMotion,
}: {
  journey: Journey;
  reduceMotion: boolean;
}) {
  // #14: the card cover is the explicit coverMediaAssetId when set, else the
  // first visual media by sortOrder, else nothing. The soundtrack never
  // becomes a cover.
  const asset = journeyCover(journey);
  const [read, setRead] = useState<JourneyCardMediaRead>({ status: "idle" });

  useEffect(() => {
    let cancelled = false;
    let refreshTimer = 0;
    if (!asset) {
      setRead({ status: "idle" });
      return () => {
        cancelled = true;
      };
    }

    const load = async () => {
      setRead({ status: "loading" });
      try {
        const next = await getPrivateMediaRead(asset.id);
        if (cancelled) return;
        setRead({ status: "ready", url: next.url });
        const expiresAt = Date.parse(next.expiresAt);
        const refreshIn = Number.isFinite(expiresAt)
          ? Math.max(30_000, expiresAt - Date.now() - 30_000)
          : 5 * 60_000;
        refreshTimer = window.setTimeout(
          () => void load(),
          refreshIn,
        );
      } catch {
        if (!cancelled) setRead({ status: "error" });
      }
    };

    void load();
    return () => {
      cancelled = true;
      window.clearTimeout(refreshTimer);
    };
  }, [asset?.id]);

  if (!asset) return null;
  return (
    <figure className={`living-atlas__active-media is-${read.status}`}>
      {read.status === "ready" && asset.mimeType.startsWith("video/") ? (
        <video
          src={read.url}
          aria-label={asset.fileName}
          autoPlay={!reduceMotion}
          loop={!reduceMotion}
          muted
          playsInline
          preload={reduceMotion ? "metadata" : "auto"}
          onError={() => setRead({ status: "error" })}
        />
      ) : null}
      {read.status === "ready" && !asset.mimeType.startsWith("video/") ? (
        <img
          src={read.url}
          alt={asset.fileName}
          loading="eager"
          onError={() => setRead({ status: "error" })}
        />
      ) : null}
      {read.status !== "ready" ? (
        <span className="living-atlas__active-media-state">
          <IconPhoto size={18} stroke={1.2} aria-hidden="true" />
          {read.status === "error" ? "媒体暂不可用" : "正在载入媒体"}
        </span>
      ) : null}
      <figcaption>{String(journeyVisualMedia(journey).length).padStart(2, "0")} MEDIA</figcaption>
    </figure>
  );
}

export function LivingAtlasApp() {
  const { canDeleteJourney } = useAtlasCapabilities();
  const [journeys, setJourneys] = useState<Journey[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const [view, setView] = useState<AtlasView>("planet");
  const [activeJourneyId, setActiveJourneyId] = useState<string | null>(null);
  const [storyJourneyId, setStoryJourneyId] = useState<string | null>(null);
  const [storyRoutePointId, setStoryRoutePointId] = useState<string | null>(null);
  // #19: cinematic journey playback. The globe stays mounted underneath; the
  // director drives phases and the overlay translates them into focus calls.
  const [playbackJourneyId, setPlaybackJourneyId] = useState<string | null>(null);
  // Review P1: when the soundtrack read is not cached yet, the first click
  // only starts the prefetch and the button shows 正在准备配乐…; the user
  // clicks again (now with a cached URL) to actually start, keeping play()
  // inside a real user gesture.
  const [playbackPreparingId, setPlaybackPreparingId] = useState<string | null>(null);
  const [playbackFocusPoint, setPlaybackFocusPoint] = useState<{
    lat: number;
    lon: number;
  } | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [editingJourneyId, setEditingJourneyId] = useState<string | null>(null);
  const [arrivalJourneyId, setArrivalJourneyId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [undoJourney, setUndoJourney] = useState<Journey | null>(null);
  const [globePickActive, setGlobePickActive] = useState(false);
  const [draftRoute, setDraftRoute] = useState<JourneyRoute | null>(null);
  // #8: globe-only focus mode hides every sidebar/card and lets the globe take
  // the full viewport. It is a temporary viewing mode: refresh restores the
  // normal layout, and the Three scene is never remounted (camera/rotation/
  // focus survive through the class switch).
  const [globeFocusMode, setGlobeFocusMode] = useState(false);
  const globeFocusExitRef = useRef<HTMLButtonElement | null>(null);
  const globeFocusTriggerRef = useRef<HTMLButtonElement | null>(null);
  // Review P2: remember the focused element inside focus mode so Esc/exit can
  // restore focus to the trigger on the way out.
  const globeFocusActiveRef = useRef(false);
  globeFocusActiveRef.current = globeFocusMode;
  const loadRevision = useRef(0);
  const globePickAccept = useRef<((point: GlobePointPick) => void) | null>(null);
  const reduceMotion = useMemo(preferredReducedMotion, []);
  const createMagnet = useMagnet<HTMLButtonElement>(14);
  const storyMagnet = useMagnet<HTMLButtonElement>(14);

  // #21: the rewind cursor over the whole journey timeline. Only active while
  // the user is in globe focus mode; entering playback pauses rewind.
  const timeCursor = useGlobeTimeCursor(journeys);

  // #8 + review P2: entering focus mode moves keyboard focus to the restore
  // control so the invisible trigger never keeps it; exiting restores focus
  // to the trigger. Hidden regions become `inert`, so tab order skips them.
  useEffect(() => {
    if (globeFocusMode) {
      globeFocusExitRef.current?.focus();
    }
  }, [globeFocusMode]);

  const exitGlobeFocus = useCallback(() => {
    setGlobeFocusMode(false);
    globeFocusTriggerRef.current?.focus();
  }, []);

  // Esc exits focus mode. The exit control is only visible inside focus mode,
  // so exiting returns focus to the trigger button in the header.
  useEffect(() => {
    if (!globeFocusMode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        exitGlobeFocus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [globeFocusMode, exitGlobeFocus]);

  const load = useCallback(async (quiet = false) => {
    const revision = ++loadRevision.current;
    if (!quiet) setStatus("loading");
    try {
      const loaded = sortJourneysChronologically(await listJourneys());
      if (revision !== loadRevision.current) return;
      setJourneys(loaded);
      // Default to the most recent journey so routes and flow are visible
      // immediately instead of only after the first selection.
      setActiveJourneyId((current) => {
        if (current && loaded.some((journey) => journey.id === current)) return current;
        return loaded.at(-1)?.id ?? null;
      });
      setLoadError("");
      setStatus("ready");
      return loaded;
    } catch (error) {
      if (revision !== loadRevision.current) return;
      if (quiet) {
        setNotice("旅程已保存，但最新媒体列表暂时无法刷新。稍后重新进入即可重试。");
      } else {
        setLoadError(error instanceof Error ? error.message : "无法读取旅程");
        setStatus("error");
      }
      return null;
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      loadRevision.current += 1;
    };
  }, [load]);

  useEffect(() => {
    if (!arrivalJourneyId) return;
    const timeout = globalThis.setTimeout(
      () => setArrivalJourneyId(null),
      reduceMotion ? 500 : 2600,
    );
    return () => globalThis.clearTimeout(timeout);
  }, [arrivalJourneyId, reduceMotion]);

  const activeJourney = journeys.find((journey) => journey.id === activeJourneyId) ?? null;
  const editingJourney = journeys.find((journey) => journey.id === editingJourneyId) ?? null;
  // Review P1: prefetch the soundtrack read while the active card is visible
  // so 播放旅程 can start audio synchronously inside the click gesture.
  useEffect(() => {
    if (!activeJourney) return;
    void prefetchSoundtrackRead(activeJourney).catch(() => undefined);
  }, [activeJourney?.id]);
  const journeyRail = useMemo(() => [...journeys].reverse(), [journeys]);
  const routes = useMemo(() => {
    const savedRoutes = toJourneyRoutes(journeys);
    if (!draftRoute) return savedRoutes;
    return savedRoutes.some((route) => route.id === draftRoute.id)
      ? savedRoutes.map((route) => route.id === draftRoute.id ? draftRoute : route)
      : [...savedRoutes, draftRoute];
  }, [draftRoute, journeys]);
  const focusPoint = journeyFocus(activeJourney);

  async function handleSaved(result: JourneySaveResult) {
    const edited = editingJourneyId === result.journey.id;
    setJourneys((current) => mergeJourney(current, result.journey));
    setActiveJourneyId(result.journey.id);
    if (!edited) setArrivalJourneyId(result.journey.id);
    setDraftRoute(null);
    setUndoJourney(null);
    setNotice(edited
      ? result.mediaErrors.length > 0
        ? "旅程修改已保存；未上传成功的媒体仍可重试。"
        : "旅程修改已保存。"
      : result.mediaErrors.length > 0
      ? "旅程已抵达图谱；未上传成功的媒体已在创建器中列出。"
      : "旅程已抵达你的私人图谱。"
    );
    await load(true);
  }

  function openCreateComposer() {
    setEditingJourneyId(null);
    setComposerOpen(true);
  }

  function editJourney(journeyId: string) {
    setActiveJourneyId(journeyId);
    setStoryJourneyId(null);
    setStoryRoutePointId(null);
    setEditingJourneyId(journeyId);
    setView("planet");
    setComposerOpen(true);
  }

  async function removeJourney(journeyId: string) {
    const removed = journeys.find((journey) => journey.id === journeyId) ?? null;
    await deleteJourney(journeyId);
    const remaining = journeys.filter((journey) => journey.id !== journeyId);
    setJourneys(remaining);
    setStoryJourneyId(null);
    setStoryRoutePointId(null);
    setActiveJourneyId((current) => current === journeyId
      ? null
      : current);
    setUndoJourney(removed);
    setNotice("旅程已从图谱移除；7 天内可以撤销，媒体尚未清理。");
  }

  async function undoRemovedJourney() {
    if (!undoJourney) return;
    try {
      const restored = await restoreJourney(undoJourney.id);
      setJourneys((current) => mergeJourney(current, restored));
      setActiveJourneyId(restored.id);
      setUndoJourney(null);
      setNotice("旅程已恢复到图谱。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法恢复这段旅程");
    }
  }

  function selectJourney(journeyId: string, source?: HTMLElement | null) {
    morphJourneyCard(source ?? null, activeJourneyId !== null, () => {
      setActiveJourneyId(journeyId);
      setArrivalJourneyId(journeyId);
      if (view === "timeline") setView("planet");
    });
  }

  // #18: opening the story from a card morphs the card cover into the story
  // hero. The cover <img> claims a stable view-transition-name before the
  // state switch; JourneyStory's hero claims the same name in the new
  // snapshot, so the browser interpolates geometry instead of a hard modal
  // cut. Falls back to a plain state update (short CSS crossfade).
  function openJourneyStory(journeyId: string, routePointId: string | null) {
    const sourceElement = document.querySelector<HTMLImageElement>(
      ".living-atlas__active-media img",
    );
    if (sourceElement && typeof document.startViewTransition === "function") {
      sourceElement.style.viewTransitionName = "journey-cover";
      runSharedElementTransition(() => {
        setActiveJourneyId(journeyId);
        setStoryRoutePointId(routePointId);
        setStoryJourneyId(journeyId);
      });
      window.setTimeout(() => {
        sourceElement.style.viewTransitionName = "";
      }, 700);
    } else {
      setActiveJourneyId(journeyId);
      setStoryRoutePointId(routePointId);
      setStoryJourneyId(journeyId);
    }
  }

  // Review P1: a network await does NOT preserve the click's transient user
  // activation. So: if the soundtrack read is already cached, start playback
  // synchronously (the overlay's first play() stays inside the gesture);
  // otherwise the first click only prefetches and the button switches to
  // 正在准备配乐… — the user clicks again once it is ready, and THAT click
  // starts playback with a cached URL. No silent first soundtrack.
  function startPlayback(journeyId: string) {
    const journey = journeys.find((candidate) => candidate.id === journeyId) ?? null;
    setStoryJourneyId(null);
    setStoryRoutePointId(null);
    const cachedRead = journey ? cachedSoundtrackRead(journey) : null;
    if (playbackEntryNeedsPreparation(journey, cachedRead)) {
      setPlaybackPreparingId(journeyId);
      void prefetchSoundtrackRead(journey!)
        .catch(() => null)
        .finally(() => setPlaybackPreparingId((current) => (
          current === journeyId ? null : current
        )));
      return;
    }
    setPlaybackJourneyId(journeyId);
    setPlaybackFocusPoint(journey?.routePoints[0]
      ? { lat: journey.routePoints[0].latitude, lon: journey.routePoints[0].longitude }
      : null);
  }

  function startGlobePick(accept: (point: GlobePointPick) => void) {
    globePickAccept.current = accept;
    setGlobePickActive(true);
    setView("planet");
  }

  function cancelGlobePick() {
    globePickAccept.current = null;
    setGlobePickActive(false);
  }

  function completeGlobePick(point: GlobePointPick) {
    const accept = globePickAccept.current;
    cancelGlobePick();
    accept?.(point);
  }

  if (status === "loading") {
    return <main className="living-atlas is-loading"><p>正在读取你的私人星轨…</p></main>;
  }

  if (status === "error") {
    return (
      <main className="living-atlas is-error">
        <section><p>PRIVATE ATLAS</p><h1>暂时无法读取旅程</h1><p role="alert">{loadError}</p><button type="button" onClick={() => void load()}>重试</button></section>
      </main>
    );
  }

  return (
    <main
      className={`living-atlas${arrivalJourneyId ? " has-arrival" : ""}${globePickActive ? " is-globe-picking" : ""}${globeFocusState(globeFocusMode).className}`}
      data-globe-focus={globeFocusState(globeFocusMode).dataAttribute}
      data-arrival-journey={arrivalJourneyId ?? undefined}
      data-journey-count={journeys.length}
    >
      <div className="living-atlas__globe" aria-hidden={view !== "planet"}>
        <LivingAtlasGlobe
          focusPoint={playbackFocusPoint ?? focusPoint}
          focusColor={activeJourney?.lightColor}
          journeyRoutes={routes}
          activeJourneyRouteId={draftRoute?.id ?? activeJourneyId}
          temporalReveal={globeFocusMode
            ? {
              journeys: timeCursor.reveal.journeyProgress,
              points: timeCursor.reveal.pointProgress,
            }
            : undefined}
          onJourneyRouteActivate={(id) => {
            if (id !== "draft-route-preview") selectJourney(id);
          }}
          onJourneyRoutePointActivate={(journeyId, routePointId) => {
            if (journeyId === "draft-route-preview") return;
            setActiveJourneyId(journeyId);
            setStoryRoutePointId(routePointId);
            setStoryJourneyId(journeyId);
          }}
          onGlobePointPick={globePickActive ? completeGlobePick : undefined}
          onPickRequest={() => {
            setEditingJourneyId(null);
            setComposerOpen(true);
          }}
          reduceMotion={reduceMotion}
        />
      </div>

      <header className="living-atlas__header" inert={globeFocusMode || undefined}>
        <div className="living-atlas__brand"><IconWorld size={25} stroke={1.1} aria-hidden="true" /><div><p>STARTRIPS · LIVING ATLAS</p><h1><ShinyText>把走过的路留在地球上</ShinyText></h1></div></div>
        <nav aria-label="图谱视图">
          <button type="button" className={view === "planet" ? "is-active" : ""} onClick={() => setView("planet")}><IconWorld size={16} stroke={1.35} aria-hidden="true" />地球</button>
          <button type="button" className={view === "timeline" ? "is-active" : ""} onClick={() => setView("timeline")}><IconTimeline size={16} stroke={1.35} aria-hidden="true" />时间线</button>
          <button ref={createMagnet.ref} onMouseMove={createMagnet.onMouseMove} onMouseLeave={createMagnet.onMouseLeave} type="button" className="living-atlas__create" onClick={openCreateComposer}><IconPlus size={17} stroke={1.4} aria-hidden="true" />记录旅程</button>
          <button
            ref={globeFocusTriggerRef}
            type="button"
            className="living-atlas__globe-focus"
            aria-pressed={globeFocusMode}
            onClick={() => {
              setView("planet");
              setGlobeFocusMode(true);
            }}
          >
            <IconWorld size={16} stroke={1.35} aria-hidden="true" />
            只看地球
          </button>
        </nav>
      </header>

      {view === "planet" && journeys.length > 0 ? (
        <nav className="living-atlas__journey-rail motion-staged" aria-label={`全部旅程，共 ${journeys.length} 段`} inert={globeFocusMode || undefined}>
          <div className="living-atlas__journey-rail-heading">
            <span>旅程</span>
            <small><CountUp value={journeys.length} initialValue={journeys.length} format={(value) => String(value).padStart(2, "0")} /> JOURNEYS</small>
          </div>
          <ol>
            {journeyRail.map((journey) => (
              <li key={journey.id}>
                <button
                  type="button"
                  className={journey.id === activeJourneyId ? "is-active" : ""}
                  aria-current={journey.id === activeJourneyId ? "true" : undefined}
                  style={{
                    "--journey-color": journey.lightColor,
                    "--journey-gradient": getLightEffectGradient(journey.lightEffect, journey.lightColor),
                  } as React.CSSProperties}
                  onClick={(event) => selectJourney(journey.id, event.currentTarget)}
                >
                  <span aria-hidden="true" />
                  <strong>{journey.title}</strong>
                  <small>{journey.startedOn}</small>
                  <IconArrowRight className="living-atlas__journey-arrow" size={16} stroke={1.35} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ol>
          <p className="living-atlas__journey-scroll-hint">滚动查看更多旅程</p>
        </nav>
      ) : null}

      {view === "timeline" ? (
        <JourneyTimeline
          journeys={journeys}
          activeJourneyId={activeJourneyId}
          onOpenStory={(id: string) => {
            setActiveJourneyId(id);
            setStoryRoutePointId(null);
            setStoryJourneyId(id);
          }}
          onCreate={openCreateComposer}
        />
      ) : null}

      {view === "planet" && journeys.length === 0 ? (
        <section className="living-atlas__empty">
          <p>NO JOURNEYS YET</p>
          <IconRoute size={34} stroke={1.05} aria-hidden="true" />
          <h2>你的地球还没有留下路线</h2>
          <p>一次跨城移动、一段海上航行，或只停留在一个地方，都可以成为第一段旅程。</p>
          <button type="button" onClick={openCreateComposer}><IconPlus size={17} stroke={1.4} aria-hidden="true" />记录第一段旅程</button>
        </section>
      ) : null}

      {view === "planet" && activeJourney ? (
        <aside
          className={`living-atlas__active${journeyVisualMedia(activeJourney).length > 0 ? " has-media" : ""}${arrivalJourneyId === activeJourney.id ? " is-arriving" : ""}`}
          inert={globeFocusMode || undefined}
          style={{
            "--journey-color": activeJourney.lightColor,
            "--journey-gradient": getLightEffectGradient(activeJourney.lightEffect, activeJourney.lightColor),
          } as React.CSSProperties}
          aria-live="polite"
        >
          {/* #13 + review P2: the whole active card is one interaction surface —
              clicking cover/title/note/blank opens the story; explicit actions
              sit above the transparent hit area. */}
          <button
            type="button"
            className="living-atlas__active-hit-area"
            aria-label={`打开旅程：${activeJourney.title}`}
            onClick={() => openJourneyStory(activeJourney.id, null)}
          />
          <div className="living-atlas__active-content" aria-hidden="true">
            <p>{activeJourney.startedOn}{activeJourney.endedOn ? ` — ${activeJourney.endedOn}` : ""}</p>
            <IconMapPin className="living-atlas__active-marker" size={18} stroke={1.25} aria-hidden="true" />
            <h2><ScrambledText text={activeJourney.title} /></h2>
            <span>{activeJourney.routePoints.length} 个路线点 · {activeJourney.routePoints.filter((point) => point.isStop).length} 次停靠</span>
            <JourneyCardMedia journey={activeJourney} reduceMotion={reduceMotion} />
            <p className={`living-atlas__active-note${activeJourney.note ? "" : " is-empty"}`}>
              {activeJourney.note || "路线已经留在地球上，故事等待被打开。"}
            </p>
          </div>
          <div className="living-atlas__active-actions">
            <button ref={storyMagnet.ref} onMouseMove={storyMagnet.onMouseMove} onMouseLeave={storyMagnet.onMouseLeave} type="button" onClick={() => openJourneyStory(activeJourney.id, null)}>
              <span>打开故事</span>
              <span className="living-atlas__active-action-icon" aria-hidden="true"><IconArrowRight size={17} stroke={1.35} /></span>
            </button>
            <button
              type="button"
              className="living-atlas__active-play"
              disabled={playbackPreparingId === activeJourney.id}
              onClick={() => {
                startPlayback(activeJourney.id);
              }}
            >
              <IconPlayerPlay size={15} stroke={1.35} aria-hidden="true" />
              <span>{playbackPreparingId === activeJourney.id ? "正在准备配乐…" : "播放旅程"}</span>
            </button>
          </div>
        </aside>
      ) : null}

      {notice ? (
        <div className="living-atlas__notice" role="status" inert={globeFocusMode || undefined}>
          <span>{notice}</span>
          {undoJourney ? <button className="living-atlas__notice-undo" type="button" onClick={() => void undoRemovedJourney()}>撤销删除</button> : null}
          <button type="button" onClick={() => { setNotice(""); setUndoJourney(null); }} aria-label="关闭提示"><IconX size={17} stroke={1.4} aria-hidden="true" /></button>
        </div>
      ) : null}

      {/* #8: the only control left visible in globe focus mode; always in the
          DOM so keyboard focus can return to it on exit. */}
      <button
        ref={globeFocusExitRef}
        type="button"
        className="living-atlas__globe-focus-exit"
        aria-label="退出专注地球"
        aria-hidden={!globeFocusMode}
        tabIndex={globeFocusMode ? 0 : -1}
        onClick={exitGlobeFocus}
      >
        <IconX size={16} stroke={1.4} aria-hidden="true" />
        恢复界面
      </button>

      {/* #21: the rewind time axis, only in globe focus mode. */}
      {globeFocusMode ? <GlobeTimeScrubber {...timeCursor} /> : null}

      {composerOpen ? (
        <JourneyComposer
          key={editingJourney?.id ?? "new-journey"}
          open
          journey={editingJourney}
          onClose={() => {
            cancelGlobePick();
            setDraftRoute(null);
            setEditingJourneyId(null);
            setComposerOpen(false);
          }}
          onSaved={handleSaved}
          onGlobePickRequest={startGlobePick}
          onGlobePickCancel={cancelGlobePick}
          onRoutePreviewChange={setDraftRoute}
        />
      ) : null}

      {storyJourneyId ? (
        <JourneyStory
          journeys={journeys}
          journeyId={storyJourneyId}
          routePointId={storyRoutePointId}
          onClose={() => { setStoryJourneyId(null); setStoryRoutePointId(null); }}
          onNavigate={(id) => {
            setActiveJourneyId(id);
            setStoryRoutePointId(null);
            setStoryJourneyId(id);
          }}
          onEdit={editJourney}
          onDelete={canDeleteJourney ? removeJourney : undefined}
          onMediaAdded={async (id) => {
            const loaded = await load(true);
            return loaded?.find((journey) => journey.id === id) ?? null;
          }}
        />
      ) : null}

      {playbackJourneyId ? (
        <JourneyPlaybackOverlay
          journey={journeys.find((journey) => journey.id === playbackJourneyId) ?? null}
          onClose={() => {
            setPlaybackJourneyId(null);
            setPlaybackFocusPoint(null);
          }}
          onFocusRoutePoint={(pointIndex) => {
            const journey = journeys.find((candidate) => candidate.id === playbackJourneyId);
            const point = journey?.routePoints[pointIndex];
            if (point) {
              setPlaybackFocusPoint({ lat: point.latitude, lon: point.longitude });
            }
          }}
          initialSoundtrackRead={(() => {
            const target = journeys.find((journey) => journey.id === playbackJourneyId);
            return target ? cachedSoundtrackRead(target) : null;
          })()}
          reduceMotion={reduceMotion}
        />
      ) : null}
    </main>
  );
}
