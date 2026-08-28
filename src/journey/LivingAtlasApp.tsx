import { Suspense, lazy, type ComponentType, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useAtlasCapabilities, useAtlasCinematicIsolation } from "../auth/AuthGateway";
import { CountUp } from "../motion/primitives/CountUp";
import { useMagnet } from "../motion/primitives/Magnet";
import { ScrambledText } from "../motion/primitives/ScrambledText";
import { ShinyText } from "../motion/primitives/ShinyText";
import { morphJourneyCard, runSharedElementMorph } from "../motion/primitives/sharedElement";
import { LivingAtlasGlobe, type LivingAtlasGlobeProps } from "../scene/LivingAtlasGlobe";
import {
  JourneyComposer,
  type GlobePointPick,
  type JourneySaveResult,
} from "./JourneyComposer";
import { JourneyPlaybackOverlay } from "./JourneyPlaybackOverlay";
import type { PlaybackCameraTarget } from "./journeyPlayback";
import { JourneyStory } from "./JourneyStory";
import {
  cachedSoundtrackRead,
  prefetchSoundtrackRead,
} from "./soundtrackReadCache";
import { JourneyTimeline } from "./JourneyTimeline";
import { GlobeTimeScrubber, formatCursorDate } from "./GlobeTimeScrubber";
import { useGlobeTimeCursor } from "./useGlobeTimeCursor";
import { useModalFocus } from "./useModalFocus";
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

const MobileDetailedEarthMap = lazy(() => import("../scene/DetailedEarthMap"));
const MOBILE_ATLAS_QUERY = "(max-width: 760px)";

function useMobileAtlasLayout() {
  const [mobile, setMobile] = useState(() => (
    globalThis.matchMedia?.(MOBILE_ATLAS_QUERY).matches ?? false
  ));
  useEffect(() => {
    const media = globalThis.matchMedia?.(MOBILE_ATLAS_QUERY);
    if (!media) return;
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return mobile;
}

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

export function resolveMobilePlaybackPresentation(
  journeys: readonly Journey[],
  selection: { journeyId: string; pointIndex: number | null } | null,
) {
  const journey = journeys.find((candidate) => candidate.id === selection?.journeyId)
    ?? journeys.at(-1)
    ?? null;
  const point = selection?.pointIndex === null || selection?.pointIndex === undefined
    ? null
    : journey?.routePoints[selection.pointIndex] ?? null;
  const focusPoint = point
    ? { lat: point.latitude, lon: point.longitude }
    : journeyFocus(journey);
  const journeyIndex = journey
    ? Math.max(0, journeys.findIndex((candidate) => candidate.id === journey.id))
    : -1;
  return {
    journey,
    point,
    focusPoint,
    activeRouteId: journey?.id ?? null,
    focusRevision: journeyIndex >= 0
      ? (journeyIndex + 1) * 1000 + (selection?.pointIndex ?? 0)
      : 0,
  };
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

export function playbackFocusPointForCameraTarget(
  journey: Journey | null,
  target: PlaybackCameraTarget,
): { lat: number; lon: number } | null {
  if (target.kind === "route") return null;
  const point = journey?.routePoints[target.pointIndex];
  return point ? { lat: point.latitude, lon: point.longitude } : null;
}

export type PlaybackCameraCommand = {
  target: PlaybackCameraTarget;
  revision: number;
};

export function nextPlaybackCameraCommand(
  current: PlaybackCameraCommand | null,
  target: PlaybackCameraTarget,
): PlaybackCameraCommand {
  return { target, revision: (current?.revision ?? 0) + 1 };
}

export function playbackFocusRouteForCameraTarget(
  route: JourneyRoute | null,
  target: PlaybackCameraTarget,
): JourneyRoute | null {
  return target.kind === "route" ? route : null;
}

export function LivingAtlasApp({
  lightweightGlobe = false,
  GlobeComponent = LivingAtlasGlobe,
}: {
  lightweightGlobe?: boolean;
  GlobeComponent?: ComponentType<LivingAtlasGlobeProps>;
} = {}) {
  const { canDeleteJourney } = useAtlasCapabilities();
  const setCinematicIsolation = useAtlasCinematicIsolation();
  const [journeys, setJourneys] = useState<Journey[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const [view, setView] = useState<AtlasView>("planet");
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
  const [playbackCameraCommand, setPlaybackCameraCommand] = useState<PlaybackCameraCommand | null>(null);
  const playbackActive = playbackJourneyId !== null;
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
  const isMobileV2 = useMobileAtlasLayout();
  const [mobileSheetJourneyId, setMobileSheetJourneyId] = useState<string | null>(null);
  const [mobilePickerOpen, setMobilePickerOpen] = useState(false);
  const [mobileMapJourneyId, setMobileMapJourneyId] = useState<string | null>(null);
  const mobileJourneyChipRef = useRef<HTMLButtonElement>(null);
  const closeMobileMap = useCallback(() => {
    setMobileMapJourneyId(null);
    if (typeof requestAnimationFrame !== "function") return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const chip = mobileJourneyChipRef.current;
        if (chip?.isConnected && !chip.closest("[inert]")) {
          chip.focus({ preventScroll: true });
        }
      });
    });
  }, []);
  const mobileChipStartX = useRef<number | null>(null);
  const mobileChipSwiped = useRef(false);
  const mobileSheetStartY = useRef<number | null>(null);
  const mobileSheetDialogRef = useModalFocus<HTMLElement>(
    () => setMobileSheetJourneyId(null),
    isMobileV2 && mobileSheetJourneyId !== null,
  );
  const mobilePickerDialogRef = useModalFocus<HTMLElement>(
    () => setMobilePickerOpen(false),
    isMobileV2 && mobilePickerOpen,
  );
  const mobileMapDialogRef = useModalFocus<HTMLElement>(
    closeMobileMap,
    isMobileV2 && mobileMapJourneyId !== null,
  );
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
  const activeJourneyId = timeCursor.selection?.journeyId ?? journeys.at(-1)?.id ?? null;

  useEffect(() => {
    setCinematicIsolation(playbackActive);
    return () => setCinematicIsolation(false);
  }, [playbackActive, setCinematicIsolation]);

  // Mobile V2 is immersive by default: desktop focus-mode and timeline views
  // are never part of the mobile state machine.
  useEffect(() => {
    if (!isMobileV2) return;
    setView("planet");
    setGlobeFocusMode(false);
  }, [isMobileV2]);

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

  useEffect(() => {
    if (!arrivalJourneyId) return;
    if (!journeys.some((journey) => journey.id === arrivalJourneyId)) return;
    timeCursor.selectJourney(arrivalJourneyId);
  }, [arrivalJourneyId, journeys, timeCursor.selectJourney]);

  const activeJourney = journeys.find((journey) => journey.id === activeJourneyId) ?? null;
  const playbackJourney = journeys.find((journey) => journey.id === playbackJourneyId) ?? null;
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
  const focusPresentation = resolveMobilePlaybackPresentation(journeys, timeCursor.selection);
  const mobileJourney = focusPresentation.journey;
  const mobilePoint = focusPresentation.point;
  const focusPoint = focusPresentation.focusPoint;
  const focusRoute = focusPresentation.point
    ? null
    : routes.find((route) => route.id === focusPresentation.activeRouteId) ?? null;
  const focusRevision = focusPresentation.focusRevision + timeCursor.selectionRevision * 100_000;
  const mobileSheetJourney = journeys.find((journey) => journey.id === mobileSheetJourneyId) ?? null;
  const mobileMapJourney = journeys.find((journey) => journey.id === mobileMapJourneyId) ?? null;
  const mobileMapRoute = routes.find((route) => route.id === mobileMapJourneyId) ?? null;
  const mobileMapFocusRevision = mobileMapJourney
    ? (Math.max(0, journeys.findIndex((journey) => journey.id === mobileMapJourney.id)) + 1) * 1000
    : 0;
  const playbackCameraTarget = playbackCameraCommand?.target ?? null;
  const playbackJourneyRoute = routes.find((route) => route.id === playbackJourneyId) ?? null;
  const playbackFocusPoint = playbackCameraTarget
    ? playbackFocusPointForCameraTarget(playbackJourney, playbackCameraTarget)
    : null;
  const playbackFocusRoute = playbackCameraTarget
    ? playbackFocusRouteForCameraTarget(playbackJourneyRoute, playbackCameraTarget)
    : null;

  function selectMobileJourney(journeyId: string) {
    timeCursor.selectJourney(journeyId);
    setView("planet");
    setMobilePickerOpen(false);
  }

  function stepMobileJourney(direction: -1 | 1) {
    if (!mobileJourney || journeys.length < 2) return;
    const currentIndex = journeys.findIndex((journey) => journey.id === mobileJourney.id);
    if (currentIndex < 0) return;
    const nextIndex = Math.min(journeys.length - 1, Math.max(0, currentIndex + direction));
    if (nextIndex === currentIndex) return;
    selectMobileJourney(journeys[nextIndex].id);
  }

  async function handleSaved(result: JourneySaveResult) {
    const edited = editingJourneyId === result.journey.id;
    setJourneys((current) => mergeJourney(current, result.journey));
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
    timeCursor.selectJourney(journeyId);
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
    setUndoJourney(removed);
    setNotice("旅程已从图谱移除；7 天内可以撤销，媒体尚未清理。");
  }

  async function undoRemovedJourney() {
    if (!undoJourney) return;
    try {
      const restored = await restoreJourney(undoJourney.id);
      setJourneys((current) => mergeJourney(current, restored));
      setArrivalJourneyId(restored.id);
      setUndoJourney(null);
      setNotice("旅程已恢复到图谱。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法恢复这段旅程");
    }
  }

  function selectJourney(journeyId: string, source?: HTMLElement | null) {
    morphJourneyCard(source ?? null, activeJourneyId !== null, () => {
      timeCursor.selectJourney(journeyId);
      setArrivalJourneyId(journeyId);
      if (view === "timeline") setView("planet");
    });
  }

  // #18: opening the story from the active card uses a true shared-element
  // morph. View Transitions handles supported browsers; the primitive falls
  // back to a fixed-clone WAAPI morph without remounting the globe.
  function openJourneyStory(journeyId: string, routePointId: string | null) {
    const targetJourney = journeys.find((candidate) => candidate.id === journeyId) ?? null;
    const sharedCoverId = routePointId === null && targetJourney
      ? journeyCover(targetJourney)?.id ?? null
      : null;
    const sourceElement = routePointId === null
      ? document.querySelector<HTMLElement>(
        ".living-atlas__active-media img, .living-atlas__active-media video",
      )
      : null;
    runSharedElementMorph({
      source: sourceElement,
      name: `journey-cover-${journeyId}`,
      update: () => {
        timeCursor.selectJourney(journeyId);
        setStoryRoutePointId(routePointId);
        setStoryJourneyId(journeyId);
      },
      // #18 follow-up: never morph the card cover into whichever Story asset
      // happens to render first. The Story initializes to journeyCover(), and
      // this lookup additionally requires the exact same asset id.
      resolveTarget: () => sharedCoverId
        ? [...document.querySelectorAll<HTMLElement>("[data-shared-media-id]")]
          .find((element) => element.dataset.sharedMediaId === sharedCoverId) ?? null
        : null,
    });
  }

  function closeJourneyStory(source: HTMLElement | null) {
    const journeyId = storyJourneyId;
    runSharedElementMorph({
      source,
      name: `journey-cover-${journeyId ?? "story"}`,
      update: () => {
        setStoryJourneyId(null);
        setStoryRoutePointId(null);
      },
      resolveTarget: () => document.querySelector<HTMLElement>(
        ".living-atlas__active-media img, .living-atlas__active-media video",
      ),
    });
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
    // The overlay issues the intro route command after mount. Clearing any
    // previous command keeps camera ownership explicit across playback runs.
    setPlaybackCameraCommand(null);
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
      className={`living-atlas${isMobileV2 ? " is-mobile-v2" : ""}${arrivalJourneyId ? " has-arrival" : ""}${globePickActive ? " is-globe-picking" : ""}${playbackActive ? " is-playback" : ""}${globeFocusState(globeFocusMode).className}`}
      data-mobile-v2={isMobileV2 ? "on" : "off"}
      data-globe-focus={globeFocusState(globeFocusMode).dataAttribute}
      data-arrival-journey={arrivalJourneyId ?? undefined}
      data-journey-count={journeys.length}
    >
      <div className="living-atlas__globe" aria-hidden={view !== "planet"}>
        {lightweightGlobe ? (
          <div className="living-atlas__qa-globe" aria-hidden="true" />
        ) : (
          <GlobeComponent
            focusPoint={playbackCameraTarget?.kind === "point"
              ? playbackFocusPoint
              : focusPoint}
            focusRoute={playbackCameraTarget
              ? playbackFocusRoute
              : focusRoute}
            focusRevision={playbackCameraCommand?.revision ?? focusRevision}
            focusColor={focusPresentation.journey?.lightColor}
            journeyRoutes={routes}
            activeJourneyRouteId={draftRoute?.id ?? activeJourneyId}
            temporalReveal={isMobileV2 || globeFocusMode
              ? {
                journeys: timeCursor.reveal.journeyProgress,
                points: timeCursor.reveal.pointProgress,
              }
              : undefined}
            showControls={!isMobileV2}
            onJourneyRouteActivate={(id) => {
              if (id === "draft-route-preview") return;
              if (isMobileV2) selectMobileJourney(id);
              else selectJourney(id);
            }}
            onJourneyRoutePointActivate={(journeyId, routePointId) => {
              if (journeyId === "draft-route-preview") return;
              const journey = journeys.find((candidate) => candidate.id === journeyId);
              const pointIndex = journey?.routePoints.findIndex((point) => point.id === routePointId) ?? -1;
              if (pointIndex >= 0) timeCursor.selectPoint(journeyId, pointIndex);
              setStoryRoutePointId(routePointId);
              setStoryJourneyId(journeyId);
            }}
            onGlobePointPick={globePickActive ? completeGlobePick : undefined}
            onPickRequest={() => {
              setEditingJourneyId(null);
              setComposerOpen(true);
            }}
            reduceMotion={reduceMotion}
            cinematicActive={playbackActive}
          />
        )}
      </div>

      {isMobileV2 ? (
        <header className="mobile-v2__header">
          <div className="mobile-v2__brand"><IconWorld size={18} stroke={1.2} aria-hidden="true" /><strong>Startrips</strong></div>
          <nav aria-label="移动端旅程操作">
            <button type="button" onClick={openCreateComposer} aria-label="记录新旅程"><IconPlus size={18} stroke={1.4} aria-hidden="true" /></button>
            {journeys.length > 0 ? (
              <button type="button" onClick={() => setMobilePickerOpen(true)} aria-label="打开全部旅程"><IconTimeline size={18} stroke={1.4} aria-hidden="true" /></button>
            ) : null}
          </nav>
        </header>
      ) : (
        <header className="living-atlas__header" inert={globeFocusMode || globePickActive || playbackActive || undefined}>
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
      )}

      {!isMobileV2 && view === "planet" && journeys.length > 0 ? (
        <nav className="living-atlas__journey-rail motion-staged" aria-label={`全部旅程，共 ${journeys.length} 段`} inert={globeFocusMode || globePickActive || playbackActive || undefined}>
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

      {!isMobileV2 && view === "timeline" ? (
        <JourneyTimeline
          journeys={journeys}
          activeJourneyId={activeJourneyId}
          onOpenStory={(id: string) => {
            timeCursor.selectJourney(id);
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

      {!isMobileV2 && view === "planet" && activeJourney ? (
        <aside
          className={`living-atlas__active${journeyVisualMedia(activeJourney).length > 0 ? " has-media" : ""}${arrivalJourneyId === activeJourney.id ? " is-arriving" : ""}`}
          inert={globeFocusMode || globePickActive || playbackActive || undefined}
          style={{
            "--journey-color": activeJourney.lightColor,
            "--journey-gradient": getLightEffectGradient(activeJourney.lightEffect, activeJourney.lightColor),
          } as React.CSSProperties}
          aria-live="polite"
        >
          {/* The narrative/media region is one story-opening surface, while
              the explicit Story / Playback actions own a separate hit zone. */}
          <div className="living-atlas__active-main">
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

      {isMobileV2 && view === "planet" && mobileJourney && !mobileMapJourney ? (
        <section
          className="mobile-v2__chrome"
          aria-label="当前旅程与时间轴"
          style={{
            "--journey-color": mobileJourney.lightColor,
            "--journey-gradient": getLightEffectGradient(mobileJourney.lightEffect, mobileJourney.lightColor),
          } as React.CSSProperties}
        >
          {timeCursor.scrub !== null ? (
            <div className="mobile-v2__scrub-bubble" aria-live="polite">
              <strong>{formatCursorDate(timeCursor.cursor, timeCursor.timeDomain)}</strong>
              <span>{mobilePoint?.label || mobileJourney.title}</span>
            </div>
          ) : null}
          <button
            ref={mobileJourneyChipRef}
            type="button"
            className="mobile-v2__journey-chip"
            aria-label={`查看当前旅程详情：${mobileJourney.title}。左右滑动切换旅程`}
            data-playback-journey={mobileJourney.id}
            onPointerDown={(event) => {
              mobileChipStartX.current = event.clientX;
              mobileChipSwiped.current = false;
            }}
            onPointerUp={(event) => {
              const start = mobileChipStartX.current;
              mobileChipStartX.current = null;
              if (start === null) return;
              const delta = event.clientX - start;
              if (Math.abs(delta) < 34) return;
              mobileChipSwiped.current = true;
              stepMobileJourney(delta < 0 ? 1 : -1);
            }}
            onPointerCancel={() => {
              mobileChipStartX.current = null;
              mobileChipSwiped.current = false;
            }}
            onClick={() => {
              if (mobileChipSwiped.current) {
                mobileChipSwiped.current = false;
                return;
              }
              setMobileSheetJourneyId(mobileJourney.id);
            }}
          >
            <span className="mobile-v2__journey-light" aria-hidden="true" />
            <span className="mobile-v2__journey-copy">
              <small>{mobileJourney.startedOn}{mobileJourney.endedOn ? ` — ${mobileJourney.endedOn}` : ""}</small>
              <strong>{mobileJourney.title}</strong>
              <span>{mobilePoint?.label || `${mobileJourney.routePoints.length} 个路线点`}</span>
            </span>
            <IconArrowRight size={17} stroke={1.35} aria-hidden="true" />
          </button>
          <div className="mobile-v2__timeline" data-scrubbing={timeCursor.scrub !== null ? "true" : "false"}>
            <GlobeTimeScrubber {...timeCursor} />
          </div>
        </section>
      ) : null}

      {isMobileV2 && mobileSheetJourney ? (
        <div className="mobile-v2__sheet-layer">
          <button className="mobile-v2__sheet-backdrop" type="button" tabIndex={-1} aria-label="关闭旅程详情" onClick={() => setMobileSheetJourneyId(null)} />
          <section
            ref={mobileSheetDialogRef}
            tabIndex={-1}
            className="mobile-v2__sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-v2-sheet-title"
            style={{
              "--journey-color": mobileSheetJourney.lightColor,
              "--journey-gradient": getLightEffectGradient(mobileSheetJourney.lightEffect, mobileSheetJourney.lightColor),
            } as React.CSSProperties}
          >
            <button
              className="mobile-v2__sheet-handle"
              type="button"
              aria-label="向下滑动或点击关闭旅程详情"
              onClick={() => setMobileSheetJourneyId(null)}
              onPointerDown={(event) => {
                mobileSheetStartY.current = event.clientY;
              }}
              onPointerUp={(event) => {
                const start = mobileSheetStartY.current;
                mobileSheetStartY.current = null;
                if (start !== null && event.clientY - start > 64) setMobileSheetJourneyId(null);
              }}
              onPointerCancel={() => {
                mobileSheetStartY.current = null;
              }}
            ><span aria-hidden="true" /></button>
            <div className="mobile-v2__sheet-heading">
              <p>{mobileSheetJourney.startedOn}{mobileSheetJourney.endedOn ? ` — ${mobileSheetJourney.endedOn}` : ""}</p>
              <h2 id="mobile-v2-sheet-title">{mobileSheetJourney.title}</h2>
              <span>{mobileSheetJourney.routePoints[0]?.label ?? "未命名起点"}{mobileSheetJourney.routePoints.length > 1 ? ` → ${mobileSheetJourney.routePoints.at(-1)?.label ?? "未命名终点"}` : ""}</span>
            </div>
            <JourneyCardMedia journey={mobileSheetJourney} reduceMotion={reduceMotion} />
            <dl className="mobile-v2__stats">
              <div><dt>路线点</dt><dd>{mobileSheetJourney.routePoints.length}</dd></div>
              <div><dt>媒体</dt><dd>{journeyVisualMedia(mobileSheetJourney).length}</dd></div>
              <div><dt>停靠</dt><dd>{mobileSheetJourney.routePoints.filter((point) => point.isStop).length}</dd></div>
            </dl>
            <p className={`mobile-v2__sheet-note${mobileSheetJourney.note ? "" : " is-empty"}`}>
              {mobileSheetJourney.note || "路线已经留在地球上，故事等待被打开。"}
            </p>
            <div className="mobile-v2__sheet-actions">
              <button
                type="button"
                className="is-primary"
                onClick={() => {
                  setMobileSheetJourneyId(null);
                  openJourneyStory(mobileSheetJourney.id, null);
                }}
              >打开故事 <IconArrowRight size={17} stroke={1.35} aria-hidden="true" /></button>
              <button
                type="button"
                onClick={() => {
                  setMobileSheetJourneyId(null);
                  setMobileMapJourneyId(mobileSheetJourney.id);
                }}
              ><IconWorld size={16} stroke={1.35} aria-hidden="true" />真实地图</button>
              <button
                type="button"
                onClick={() => {
                  setMobileSheetJourneyId(null);
                  editJourney(mobileSheetJourney.id);
                }}
              ><IconRoute size={16} stroke={1.35} aria-hidden="true" />编辑旅程</button>
            </div>
          </section>
        </div>
      ) : null}

      {isMobileV2 && mobilePickerOpen ? (
        <section ref={mobilePickerDialogRef} tabIndex={-1} className="mobile-v2__picker" role="dialog" aria-modal="true" aria-labelledby="mobile-v2-picker-title">
          <header>
            <div><p>YOUR JOURNEYS</p><h2 id="mobile-v2-picker-title">全部旅程</h2></div>
            <button type="button" onClick={() => setMobilePickerOpen(false)} aria-label="关闭全部旅程"><IconX size={19} stroke={1.4} aria-hidden="true" /></button>
          </header>
          <ol>
            {journeyRail.map((journey) => (
              <li key={journey.id}>
                <button
                  type="button"
                  className={journey.id === mobileJourney?.id ? "is-active" : ""}
                  aria-current={journey.id === mobileJourney?.id ? "true" : undefined}
                  style={{
                    "--journey-color": journey.lightColor,
                    "--journey-gradient": getLightEffectGradient(journey.lightEffect, journey.lightColor),
                  } as React.CSSProperties}
                  onClick={() => selectMobileJourney(journey.id)}
                >
                  <span className="mobile-v2__picker-thumb" aria-hidden="true"><IconRoute size={22} stroke={1.05} /></span>
                  <span className="mobile-v2__picker-copy">
                    <small>{journey.startedOn}{journey.endedOn ? ` — ${journey.endedOn}` : ""}</small>
                    <strong>{journey.title}</strong>
                    <span>{journey.routePoints[0]?.label ?? "未命名地点"}{journey.routePoints.length > 1 ? ` → ${journey.routePoints.at(-1)?.label ?? "终点"}` : ""}</span>
                  </span>
                  <IconArrowRight size={17} stroke={1.25} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ol>
          <button className="mobile-v2__picker-create" type="button" onClick={() => {
            setMobilePickerOpen(false);
            openCreateComposer();
          }}><IconPlus size={17} stroke={1.4} aria-hidden="true" />记录新旅程</button>
        </section>
      ) : null}

      {isMobileV2 && mobileMapJourney ? (
        <section ref={mobileMapDialogRef} tabIndex={-1} className="mobile-v2__real-map" role="dialog" aria-modal="true" aria-labelledby="mobile-v2-real-map-title">
          <Suspense fallback={<div className="mobile-v2__map-loading">正在打开真实地图…</div>}>
            <MobileDetailedEarthMap
              focusPoint={journeyFocus(mobileMapJourney)}
              focusRoute={mobileMapRoute}
              focusRevision={mobileMapFocusRevision}
              language="zh"
            />
          </Suspense>
          <header>
            <button type="button" onClick={closeMobileMap} aria-label="返回地球"><IconX size={19} stroke={1.4} aria-hidden="true" /></button>
            <div><p>REAL MAP</p><strong id="mobile-v2-real-map-title">{mobileMapJourney.title}</strong></div>
          </header>
          <div className="mobile-v2__map-card">
            <span className="mobile-v2__journey-light" aria-hidden="true" />
            <div><small>{mobileMapJourney.startedOn}</small><strong>{mobileMapJourney.routePoints[0]?.label ?? mobileMapJourney.title}</strong><span>{mobileMapJourney.routePoints.length} 个路线点</span></div>
            <button type="button" onClick={closeMobileMap}>返回地球</button>
          </div>
        </section>
      ) : null}

      {notice ? (
        <div className="living-atlas__notice" role="status" inert={globeFocusMode || globePickActive || playbackActive || undefined}>
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
          onClose={(source) => closeJourneyStory(source ?? null)}
          onNavigate={(id) => {
            timeCursor.selectJourney(id);
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
          journey={playbackJourney}
          onClose={() => {
            setPlaybackJourneyId(null);
            setPlaybackCameraCommand(null);
          }}
          onCameraTargetChange={(target) => {
            setPlaybackCameraCommand((current) => nextPlaybackCameraCommand(current, target));
          }}
          initialSoundtrackRead={(() => {
            return playbackJourney ? cachedSoundtrackRead(playbackJourney) : null;
          })()}
          reduceMotion={reduceMotion}
        />
      ) : null}
    </main>
  );
}
