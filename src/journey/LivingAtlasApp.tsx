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
import { useAtlasCapabilities } from "../auth/AuthGateway";
import { LivingAtlasGlobe } from "../scene/LivingAtlasGlobe";
import {
  JourneyComposer,
  type GlobePointPick,
  type JourneySaveResult,
} from "./JourneyComposer";
import { JourneyStory } from "./JourneyStory";
import { JourneyTimeline } from "./JourneyTimeline";
import { deleteJourney, listJourneys, restoreJourney } from "./journeyApi";
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
  const { canDeleteJourney } = useAtlasCapabilities();
  const [journeys, setJourneys] = useState<Journey[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const [view, setView] = useState<AtlasView>("planet");
  const [activeJourneyId, setActiveJourneyId] = useState<string | null>(null);
  const [storyJourneyId, setStoryJourneyId] = useState<string | null>(null);
  const [storyRoutePointId, setStoryRoutePointId] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [editingJourneyId, setEditingJourneyId] = useState<string | null>(null);
  const [arrivalJourneyId, setArrivalJourneyId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [undoJourney, setUndoJourney] = useState<Journey | null>(null);
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
        return null;
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
    <main
      className={`living-atlas${arrivalJourneyId ? " has-arrival" : ""}${globePickActive ? " is-globe-picking" : ""}`}
      data-arrival-journey={arrivalJourneyId ?? undefined}
      data-journey-count={journeys.length}
    >
      <div className="living-atlas__globe" aria-hidden={view !== "planet"}>
        <LivingAtlasGlobe
          focusPoint={focusPoint}
          focusColor={activeJourney?.lightColor}
          journeyRoutes={routes}
          activeJourneyRouteId={draftRoute?.id ?? activeJourneyId}
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
          reduceMotion={reduceMotion}
        />
      </div>

      <header className="living-atlas__header">
        <div className="living-atlas__brand"><IconWorld size={25} stroke={1.1} aria-hidden="true" /><div><p>STARTRIPS · LIVING ATLAS</p><h1>把走过的路留在地球上</h1></div></div>
        <nav aria-label="图谱视图">
          <button type="button" className={view === "planet" ? "is-active" : ""} onClick={() => setView("planet")}><IconWorld size={16} stroke={1.35} aria-hidden="true" />地球</button>
          <button type="button" className={view === "timeline" ? "is-active" : ""} onClick={() => setView("timeline")}><IconTimeline size={16} stroke={1.35} aria-hidden="true" />时间线</button>
          <button type="button" className="living-atlas__create" onClick={openCreateComposer}><IconPlus size={17} stroke={1.4} aria-hidden="true" />记录旅程</button>
        </nav>
      </header>

      {view === "planet" && journeys.length > 0 ? (
        <nav className="living-atlas__journey-rail" aria-label={`全部旅程，共 ${journeys.length} 段`}>
          <p>{String(journeys.length).padStart(2, "0")} JOURNEYS</p>
          <ol>
            {journeys.map((journey) => (
              <li key={journey.id}>
                <button
                  type="button"
                  className={journey.id === activeJourneyId ? "is-active" : ""}
                  aria-current={journey.id === activeJourneyId ? "true" : undefined}
                  style={{ "--journey-color": journey.lightColor } as React.CSSProperties}
                  onClick={() => selectJourney(journey.id)}
                >
                  <span aria-hidden="true" />
                  <strong>{journey.title}</strong>
                  <small>{journey.startedOn}</small>
                </button>
              </li>
            ))}
          </ol>
        </nav>
      ) : null}

      {view === "timeline" ? (
        <JourneyTimeline
          journeys={journeys}
          activeJourneyId={activeJourneyId}
          onSelect={selectJourney}
          onOpenStory={(id) => {
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
        <aside className={`living-atlas__active${arrivalJourneyId === activeJourney.id ? " is-arriving" : ""}`} style={{ "--journey-color": activeJourney.lightColor } as React.CSSProperties}>
          <p>{activeJourney.startedOn}{activeJourney.endedOn ? ` — ${activeJourney.endedOn}` : ""}</p>
          <IconMapPin className="living-atlas__active-marker" size={18} stroke={1.25} aria-hidden="true" />
          <h2>{activeJourney.title}</h2>
          <span>{activeJourney.routePoints.length} 个路线点 · {activeJourney.routePoints.filter((point) => point.isStop).length} 次停靠</span>
          <button type="button" onClick={() => { setStoryRoutePointId(null); setStoryJourneyId(activeJourney.id); }}>打开故事<IconBook2 size={17} stroke={1.3} aria-hidden="true" /></button>
        </aside>
      ) : null}

      {notice ? (
        <div className="living-atlas__notice" role="status">
          <span>{notice}</span>
          {undoJourney ? <button className="living-atlas__notice-undo" type="button" onClick={() => void undoRemovedJourney()}>撤销删除</button> : null}
          <button type="button" onClick={() => { setNotice(""); setUndoJourney(null); }} aria-label="关闭提示"><IconX size={17} stroke={1.4} aria-hidden="true" /></button>
        </div>
      ) : null}

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
    </main>
  );
}
