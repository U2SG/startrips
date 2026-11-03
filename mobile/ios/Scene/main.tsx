import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { GlobeTimeScrubber } from "../../../src/journey/GlobeTimeScrubber";
import { useGlobeTimeCursor } from "../../../src/journey/useGlobeTimeCursor";
import { JourneyTimeline } from "../../../src/journey/JourneyTimeline";
import { toJourneyRoutes } from "../../../src/journey/journeyModel";
import { LivingAtlasGlobe, PersistentEarthProvider, usePersistentEarth } from "../../../src/scene/LivingAtlasGlobe";
import { acceptsSnapshot, atlasSceneFocus, decodeSnapshot, renderJourneys, send, type Snapshot } from "./bridge";
import "../../../src/styles/tokens.css";
import "../../../src/styles/controls.css";
import "../../../src/styles/living-atlas.css";
import "../../../src/styles/brand-mark.css";
import "../../../src/styles/auth-gate.css";
import "../../../src/app.css";
import "../../../src/styles/globe-time-scrubber.css";
import "./scene.css";

let pendingSnapshot: string | null = null;
let deliverSnapshot: ((json: string) => void) | null = null;
// Installed during module execution, before WKNavigationDelegate.didFinish.
window.atlasNative = { receive(json) { pendingSnapshot = json; deliverSnapshot?.(json); } };

function AtlasScene() {
  const earth = usePersistentEarth();
  useEffect(() => { earth.setStage("atlas"); return () => earth.setStage("idle"); }, [earth]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [interrupted, setInterrupted] = useState(false);
  const [focusRevision, setFocusRevision] = useState(0);
  const [cursorScope, setCursorScope] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const lastCursorCommit = useRef<string | null>(null);
  const current = useRef<Snapshot | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    deliverSnapshot = (json) => {
      try {
        const next = decodeSnapshot(JSON.parse(json));
        if (!acceptsSnapshot(current.current, next)) return;
        const previous = current.current;
        const newFocus = previous?.scopeId !== next.scopeId || previous?.selection?.requestId !== next.selection?.requestId;
        current.current = next; setSnapshot(next); setError(false);
        if (newFocus) {
          setInterrupted(false); setFocusRevision((value) => value + 1);
        }
        if (!previous || previous.scopeId !== next.scopeId) send(next, "ready");
      } catch { setError(true); }
    };
    if (pendingSnapshot) deliverSnapshot(pendingSnapshot);
    return () => { deliverSnapshot = null; };
  }, []);
  useEffect(() => {
    if (snapshot?.active) { setInterrupted(false); setFocusRevision((value) => value + 1); }
  }, [snapshot?.active]);
  const journeys = useMemo(() => snapshot ? renderJourneys(snapshot) : [], [snapshot]);
  const routes = useMemo(() => toJourneyRoutes(journeys), [journeys]);
  const time = useGlobeTimeCursor(journeys);
  const cursorActive = !!snapshot?.active && cursorScope === snapshot.scopeId;
  const selected = journeys.find((journey) => journey.id === (cursorActive ? time.selection?.journeyId : snapshot?.selection?.journeyId));
  const point = cursorActive
    ? selected?.routePoints[time.selection?.pointIndex ?? -1]
    : selected?.routePoints.find((value) => value.id === snapshot?.selection?.routePointId);

  useEffect(() => {
    if (!snapshot?.active || cursorScope !== snapshot.scopeId) {
      time.pause();
      setCursorScope(null);
      lastCursorCommit.current = null;
    }
  }, [snapshot?.active, snapshot?.scopeId, cursorScope, time.pause]);

  // Scrub previews render locally. Only a completed seek or a playback stop crosses the bridge.
  useEffect(() => {
    if (!cursorActive || !snapshot || time.scrub !== null || !selected) return;
    const key = JSON.stringify([snapshot.scopeId, selected.id, point?.id]);
    if (lastCursorCommit.current === key) return;
    lastCursorCommit.current = key;
    send(snapshot, "select", { journeyId: selected.id, routePointId: point?.id });
  }, [cursorActive, snapshot, time.scrub, selected, point]);

  useEffect(() => {
    const element = panel.current;
    if (!element) return;
    const update = () => document.documentElement.style.setProperty("--native-atlas-bottom", `${element.getBoundingClientRect().height}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => { observer.disconnect(); document.documentElement.style.removeProperty("--native-atlas-bottom"); };
  }, [!!snapshot, error]);

  const beginCursor = () => {
    if (!snapshot) return;
    setInterrupted(false); setCursorScope(snapshot.scopeId);
  };
  const select = (journeyId: string, routePointId?: string) => {
    if (!snapshot) return;
    time.pause(); setCursorScope(null); lastCursorCommit.current = null;
    send(snapshot, "select", { journeyId, routePointId });
  };
  const interrupt = () => {
    time.pause();
    setInterrupted(true);
    if (snapshot) send(snapshot, "cameraInterrupted");
    // ParticleEarthScene owns the idle clock. Keep commanded focus released
    // until the user selects a point or explicitly drives the time cursor.
  };
  if (error) return <p role="alert">地球数据无法读取，请刷新。</p>;
  if (!snapshot) return <p role="status">正在连接图谱…</p>;
  return <main className="living-atlas native-atlas" aria-label="图谱地球">
    <div className="native-atlas__earth" aria-label="旅程地球">
      <LivingAtlasGlobe journeyRoutes={routes} activeJourneyRouteId={selected?.id}
        selectedJourneyRoutePoint={selected ? { journeyId: selected.id, routePointId: point?.id } : null}
        temporalReveal={cursorActive ? { journeys: time.reveal.journeyProgress, points: time.reveal.pointProgress,
          timestamp: time.timeDomain ? time.timeDomain.minTime + time.cursor * (time.timeDomain.maxTime - time.timeDomain.minTime) : undefined } : undefined}
        {...atlasSceneFocus(point, routes.find((route) => route.id === selected?.id))}
        focusRevision={focusRevision} focusEnabled={!interrupted && snapshot.active}
        earthExperiencePolicy={snapshot.earthExperience} routeEditingEnabled={false}
        cinematicActive={!snapshot.active} mediaCoverHint={{ opaqueMediaCover: !snapshot.active, coverTransitionActive: false }}
        onManualCameraInteraction={interrupt} onFocusSettled={() => {
          if (!cursorActive || (time.scrub === null && selected?.id === snapshot.selection?.journeyId
            && (point?.id ?? null) === (snapshot.selection?.routePointId ?? null))) {
            send(snapshot, "rendered", { focusRequestId: snapshot.selection?.requestId });
          }
        }}
        onJourneyRouteActivate={(journeyId) => select(journeyId)}
        onJourneyRoutePointActivate={select}/>
    </div>
    <div className="native-atlas__panel" ref={panel}>
    {time.timeDomain && <GlobeTimeScrubber {...time} play={() => { beginCursor(); time.play(); }}
      seek={(value) => { beginCursor(); time.seek(value); }}
      setScrub={(value) => { beginCursor(); time.setScrub(value); }}/>}
    <div className="native-atlas__timeline">
      <JourneyTimeline journeys={journeys} activeJourneyId={selected?.id ?? null}
        onOpenStory={(journeyId) => send(snapshot, "story", { journeyId })}/>
    </div>
    {selected && <section className="native-atlas__selection" aria-label="当前旅程">
      <strong>{selected.title}</strong>
      <div className="native-atlas__points">{selected.routePoints.map((routePoint) =>
        <button key={routePoint.id} aria-pressed={routePoint.id === point?.id}
          onClick={() => select(selected.id, routePoint.id)}>
          {routePoint.label || "路线点"}
        </button>)}</div>
      <button aria-label={point ? `打开故事：${point.label}` : "打开故事"} onClick={() => send(snapshot, "story", { journeyId: selected.id, ...(point ? { routePointId: point.id } : {}) })}>打开故事</button>
    </section>}
    {!journeys.length && <p className="native-atlas__empty">图谱里还没有旅程</p>}
    </div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<PersistentEarthProvider><AtlasScene/></PersistentEarthProvider>);
