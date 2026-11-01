import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { JourneyTimeline } from "../../../src/journey/JourneyTimeline";
import { toJourneyRoutes } from "../../../src/journey/journeyModel";
import { LivingAtlasGlobe, PersistentEarthProvider, usePersistentEarth } from "../../../src/scene/LivingAtlasGlobe";
import { acceptsSnapshot, CAMERA_RESUME_MS, decodeSnapshot, renderJourneys, send, type Snapshot } from "./bridge";
import "../../../src/styles/tokens.css";
import "../../../src/styles/controls.css";
import "../../../src/styles/living-atlas.css";
import "../../../src/styles/brand-mark.css";
import "../../../src/styles/auth-gate.css";
import "../../../src/app.css";
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
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
          if (timer.current) clearTimeout(timer.current);
          setInterrupted(false); setFocusRevision((value) => value + 1);
        }
        if (!previous || previous.scopeId !== next.scopeId) send(next, "ready");
      } catch { setError(true); }
    };
    if (pendingSnapshot) deliverSnapshot(pendingSnapshot);
    return () => { deliverSnapshot = null; if (timer.current) clearTimeout(timer.current); };
  }, []);
  useEffect(() => {
    if (!snapshot?.active && timer.current) clearTimeout(timer.current);
    if (snapshot?.active) { setInterrupted(false); setFocusRevision((value) => value + 1); }
  }, [snapshot?.active]);
  const journeys = useMemo(() => snapshot ? renderJourneys(snapshot) : [], [snapshot]);
  const routes = useMemo(() => toJourneyRoutes(journeys), [journeys]);
  const selected = journeys.find((journey) => journey.id === snapshot?.selection?.journeyId);
  const point = selected?.routePoints.find((value) => value.id === snapshot?.selection?.routePointId);
  const interrupt = () => {
    setInterrupted(true);
    if (timer.current) clearTimeout(timer.current);
    if (snapshot) send(snapshot, "cameraInterrupted");
    timer.current = setTimeout(() => {
      if (current.current?.active) { setInterrupted(false); setFocusRevision((value) => value + 1); }
    }, CAMERA_RESUME_MS);
  };
  if (error) return <p role="alert">地球数据无法读取，请刷新。</p>;
  if (!snapshot) return <p role="status">正在连接图谱…</p>;
  return <main className="living-atlas native-atlas" aria-label="图谱地球">
    <div className="native-atlas__earth" aria-label="旅程地球">
      <LivingAtlasGlobe journeyRoutes={routes} activeJourneyRouteId={selected?.id}
        selectedJourneyRoutePoint={snapshot.selection ?? null}
        focusPoint={point ? { lat: point.latitude, lon: point.longitude } : null}
        focusRoute={routes.find((route) => route.id === selected?.id) ?? null}
        focusRevision={focusRevision} focusEnabled={!interrupted && snapshot.active}
        earthExperiencePolicy={snapshot.earthExperience} routeEditingEnabled={false}
        cinematicActive={!snapshot.active} mediaCoverHint={{ opaqueMediaCover: !snapshot.active, coverTransitionActive: false }}
        onManualCameraInteraction={interrupt} onFocusSettled={() => send(snapshot, "rendered", { focusRequestId: snapshot.selection?.requestId })}
        onJourneyRouteActivate={(journeyId) => send(snapshot, "select", { journeyId })}
        onJourneyRoutePointActivate={(journeyId, routePointId) => send(snapshot, "select", { journeyId, routePointId })}/>
    </div>
    <div className="native-atlas__timeline">
      <JourneyTimeline journeys={journeys} activeJourneyId={selected?.id ?? null}
        onOpenStory={(journeyId) => send(snapshot, "story", { journeyId })}/>
    </div>
    {selected && <section className="native-atlas__selection" aria-label="当前旅程">
      <strong>{selected.title}</strong>
      <div className="native-atlas__points">{selected.routePoints.map((routePoint) =>
        <button key={routePoint.id} aria-pressed={routePoint.id === point?.id}
          onClick={() => send(snapshot, "select", { journeyId: selected.id, routePointId: routePoint.id })}>
          {routePoint.label || "路线点"}
        </button>)}</div>
      <button onClick={() => send(snapshot, "story", { journeyId: selected.id, ...(point ? { routePointId: point.id } : {}) })}>打开故事</button>
    </section>}
    {!journeys.length && <p className="native-atlas__empty">图谱里还没有旅程</p>}
  </main>;
}
createRoot(document.getElementById("root")!).render(<PersistentEarthProvider><AtlasScene/></PersistentEarthProvider>);
