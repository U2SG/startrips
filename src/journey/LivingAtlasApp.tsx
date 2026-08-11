import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconBook2,
  IconMapPin,
  IconPlus,
  IconRoute,
  IconTimeline,
  IconWorld,
  IconX,
} from "@tabler/icons-react";
import { ParticleEarthScene } from "../scene/ParticleEarthScene";
import {
  JourneyComposer,
  type GlobePointPick,
  type JourneySaveResult,
} from "./JourneyComposer";
import { JourneyStory } from "./JourneyStory";
import { JourneyTimeline } from "./JourneyTimeline";
import { listJourneys } from "./journeyApi";
import {
  mergeJourney,
  sortJourneysChronologically,
  toJourneyRoutes,
} from "./journeyModel";
import type { Journey, JourneyRoute } from "./types";

type AtlasView = "planet" | "timeline";

function preferredReducedMotion() {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function journeyFocus(journey: Journey | null) {
  if (!journey || journey.routePoints.length === 0) return null;
  const point = journey.routePoints[Math.floor((journey.routePoints.length - 1) / 2)];
  return { lat: point.latitude, lon: point.longitude };
}

export function LivingAtlasApp() {
  const [journeys, setJourneys] = useState<Journey[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const [view, setView] = useState<AtlasView>("planet");
  const [activeJourneyId, setActiveJourneyId] = useState<string | null>(null);
  const [storyJourneyId, setStoryJourneyId] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [arrivalJourneyId, setArrivalJourneyId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [globePickActive, setGlobePickActive] = useState(false);
  const [draftRoute, setDraftRoute] = useState<JourneyRoute | null>(null);
  const loadRevision = useRef(0);
  const globePickAccept = useRef<((point: GlobePointPick) => void) | null>(null);
  const reduceMotion = useMemo(preferredReducedMotion, []);

  const load = useCallback(async (quiet = false) => {
    const revision = ++loadRevision.current;
    if (!quiet) setStatus("loading");
    try {
      const loaded = sortJourneysChronologically(await listJourneys());
      if (revision !== loadRevision.current) return;
      setJourneys(loaded);
      setActiveJourneyId((current) => {
        if (current && loaded.some((journey) => journey.id === current)) return current;
        return loaded.at(-1)?.id ?? null;
      });
      setLoadError("");
      setStatus("ready");
    } catch (error) {
      if (revision !== loadRevision.current) return;
      if (quiet) {
        setNotice("旅程已保存，但最新媒体列表暂时无法刷新。稍后重新进入即可重试。");
      } else {
        setLoadError(error instanceof Error ? error.message : "无法读取旅程");
        setStatus("error");
      }
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
  const routes = useMemo(() => {
    const savedRoutes = toJourneyRoutes(journeys);
    return draftRoute ? [...savedRoutes, draftRoute] : savedRoutes;
  }, [draftRoute, journeys]);
  const focusPoint = journeyFocus(activeJourney);

  async function handleSaved(result: JourneySaveResult) {
    setJourneys((current) => mergeJourney(current, result.journey));
    setActiveJourneyId(result.journey.id);
    setArrivalJourneyId(result.journey.id);
    setDraftRoute(null);
    setNotice(result.mediaErrors.length > 0
      ? "旅程已抵达图谱；未上传成功的媒体已在创建器中列出。"
      : "旅程已抵达你的私人图谱。"
    );
    await load(true);
  }

  function selectJourney(journeyId: string) {
    setActiveJourneyId(journeyId);
    if (view === "timeline") setView("planet");
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
    <main className={`living-atlas${arrivalJourneyId ? " has-arrival" : ""}${globePickActive ? " is-globe-picking" : ""}`} data-arrival-journey={arrivalJourneyId ?? undefined}>
      <div className="living-atlas__globe" aria-hidden={view !== "planet"}>
        <ParticleEarthScene
          mode="focusPoint"
          quality="low"
          focusPoint={focusPoint}
          focusColor={activeJourney?.lightColor}
          centerFocusPoint
          journeyRoutes={routes}
          onJourneyRouteActivate={(id) => {
            if (id !== "draft-route-preview") selectJourney(id);
          }}
          onGlobePointPick={globePickActive ? completeGlobePick : undefined}
          reduceMotion={reduceMotion}
        />
      </div>

      <header className="living-atlas__header">
        <div className="living-atlas__brand"><IconWorld size={25} stroke={1.1} aria-hidden="true" /><div><p>STARTRIPS · LIVING ATLAS</p><h1>把走过的路留在地球上</h1></div></div>
        <nav aria-label="图谱视图">
          <button type="button" className={view === "planet" ? "is-active" : ""} onClick={() => setView("planet")}><IconWorld size={16} stroke={1.35} aria-hidden="true" />地球</button>
          <button type="button" className={view === "timeline" ? "is-active" : ""} onClick={() => setView("timeline")}><IconTimeline size={16} stroke={1.35} aria-hidden="true" />时间线</button>
          <button type="button" className="living-atlas__create" onClick={() => setComposerOpen(true)}><IconPlus size={17} stroke={1.4} aria-hidden="true" />记录旅程</button>
        </nav>
      </header>

      {view === "timeline" ? (
        <JourneyTimeline
          journeys={journeys}
          activeJourneyId={activeJourneyId}
          onSelect={selectJourney}
          onOpenStory={(id) => {
            setActiveJourneyId(id);
            setStoryJourneyId(id);
          }}
          onCreate={() => setComposerOpen(true)}
        />
      ) : null}

      {view === "planet" && journeys.length === 0 ? (
        <section className="living-atlas__empty">
          <p>NO JOURNEYS YET</p>
          <IconRoute size={34} stroke={1.05} aria-hidden="true" />
          <h2>你的地球还没有留下路线</h2>
          <p>一次跨城移动、一段海上航行，或只停留在一个地方，都可以成为第一段旅程。</p>
          <button type="button" onClick={() => setComposerOpen(true)}><IconPlus size={17} stroke={1.4} aria-hidden="true" />记录第一段旅程</button>
        </section>
      ) : null}

      {view === "planet" && activeJourney ? (
        <aside className={`living-atlas__active${arrivalJourneyId === activeJourney.id ? " is-arriving" : ""}`} style={{ "--journey-color": activeJourney.lightColor } as React.CSSProperties}>
          <p>{activeJourney.startedOn}{activeJourney.endedOn ? ` — ${activeJourney.endedOn}` : ""}</p>
          <IconMapPin className="living-atlas__active-marker" size={18} stroke={1.25} aria-hidden="true" />
          <h2>{activeJourney.title}</h2>
          <span>{activeJourney.routePoints.length} 个路线点 · {activeJourney.routePoints.filter((point) => point.isStop).length} 次停靠</span>
          <button type="button" onClick={() => setStoryJourneyId(activeJourney.id)}>打开故事<IconBook2 size={17} stroke={1.3} aria-hidden="true" /></button>
        </aside>
      ) : null}

      {notice ? <div className="living-atlas__notice" role="status">{notice}<button type="button" onClick={() => setNotice("")} aria-label="关闭提示"><IconX size={17} stroke={1.4} aria-hidden="true" /></button></div> : null}

      {composerOpen ? (
        <JourneyComposer
          open
          onClose={() => {
            cancelGlobePick();
            setDraftRoute(null);
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
          onClose={() => setStoryJourneyId(null)}
          onNavigate={(id) => {
            setActiveJourneyId(id);
            setStoryJourneyId(id);
          }}
        />
      ) : null}
    </main>
  );
}
