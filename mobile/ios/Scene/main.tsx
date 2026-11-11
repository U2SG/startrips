import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { StartripsBrandLoader } from "../../../src/brand/StartripsBrandMark";
import { toJourneyRoutes } from "../../../src/journey/journeyModel";
import { LivingAtlasGlobe, PersistentEarthProvider, usePersistentEarth } from "../../../src/scene/LivingAtlasGlobe";
import { installDetailMapOverrides, setDetailLabelPreferences } from "./detailMap";
import { acceptsSnapshot, atlasSceneFocus, decodeCommandOrDrop, decodeSnapshotOrReport, renderJourneys, send, windowReveal, type CameraInsets, type LabelPreferences, type Snapshot, type TimeWindow } from "./bridge";
import "../../../src/styles/tokens.css";
import "../../../src/styles/controls.css";
import "../../../src/styles/living-atlas.css";
import "../../../src/styles/brand-mark.css";
import "../../../src/styles/auth-gate.css";
import "../../../src/app.css";
import "./scene.css";

// The native page-world receiver exists before deferred module evaluation.
// Carry any snapshot sent by WKNavigationDelegate.didFinish into React's first effect.
const early = window.atlasNative as { pending?: string | null; commands?: string[] } | undefined;
let pendingSnapshot: string | null = early?.pending ?? null;
let deliverSnapshot: ((json: string) => void) | null = null;
// Commands sent before the module ran are replayed after the pending snapshot.
let pendingCommands: string[] = [...(early?.commands ?? [])];
let deliverCommand: ((json: string) => void) | null = null;
window.atlasNative = {
  receive(json) { pendingSnapshot = json; deliverSnapshot?.(json); },
  command(json) { if (deliverCommand) deliverCommand(json); else pendingCommands.push(json); },
};

// The detail map loads MapLibre lazily; patch the same module instance before it draws.
void import("maplibre-gl").then(({ Map }) => installDetailMapOverrides(Map.prototype as never));

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";

// WebKit mirrors the iOS Reduce Motion setting; follow live changes like the Web Atlas.
function usePrefersReducedMotion() {
  const [reduce, setReduce] = useState(() => window.matchMedia(reducedMotionQuery).matches);
  useEffect(() => {
    const media = window.matchMedia(reducedMotionQuery);
    const update = () => setReduce(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduce;
}

// The iPhone scene renders only the production globe. Native SwiftUI owns every
// control (wordmark, account, time ribbon, Journey card and Story entry) and
// drives the camera through snapshot selection and contract v2 commands.
function AtlasScene() {
  const reduceMotion = usePrefersReducedMotion();
  const earth = usePersistentEarth();
  useEffect(() => { earth.setStage("atlas"); return () => earth.setStage("idle"); }, [earth]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [accessibility, setAccessibility] = useState(sceneAccessibility);
  const { textScale, accessibilitySize, boldText, increasedContrast } = accessibility;
  const scrollableDetails = accessibilitySize || textScale > 1 || boldText;
  const labelLegibility = useMemo(() => ({
    // Keep space around the anchor on a phone even at the largest text size.
    fontSize: Math.min(26, 15 * textScale),
    boldText,
    increasedContrast,
  }), [textScale, boldText, increasedContrast]);
  useEffect(() => {
    deliverAccessibility = setAccessibility;
    setAccessibility(sceneAccessibility);
    return () => { deliverAccessibility = null; };
  }, []);
  const [interrupted, setInterrupted] = useState(false);
  const [focusRevision, setFocusRevision] = useState(0);
  const current = useRef<Snapshot | null>(null);
  const [error, setError] = useState(false);
  // Native presentation state (contract v2 commands).
  const [globeOnly, setGlobeOnly] = useState(false);
  const [insets, setInsets] = useState<CameraInsets | null>(null);
  const [timeWindow, setTimeWindow] = useState<TimeWindow | null>(null);
  const [preview, setPreview] = useState<{ journeyId: string; routePointId: string | null } | null>(null);
  const [labels, setLabels] = useState<LabelPreferences>({ language: "zh", showPlaceNames: false });
  useEffect(() => {
    deliverSnapshot = (json) => {
      // An unreadable snapshot is reported to native, which owns the reload control.
      const next = decodeSnapshotOrReport(json);
      if (!next) { setError(true); return; }
      if (!acceptsSnapshot(current.current, next)) return;
      const previous = current.current;
      const newFocus = previous?.scopeId !== next.scopeId || previous?.selection?.requestId !== next.selection?.requestId;
      current.current = next; setSnapshot(next); setError(false);
      if (previous?.scopeId !== next.scopeId) setTimeWindow(null);
      if (newFocus) {
        setPreview(null); setInterrupted(false); setFocusRevision((value) => value + 1);
      }
      if (!previous || previous.scopeId !== next.scopeId) send(next, "ready");
    };
    if (pendingSnapshot) deliverSnapshot(pendingSnapshot);
    deliverCommand = (json) => {
      const command = decodeCommandOrDrop(json, current.current);
      if (!command) return;
      if (command.kind === "chrome") setGlobeOnly(command.globeOnly);
      else if (command.kind === "insets") setInsets(command.insets);
      else if (command.kind === "timeWindow") setTimeWindow(command.window);
      else if (command.kind === "labels") setLabels(command.labels);
      else {
        setPreview({ journeyId: command.journeyId, routePointId: command.routePointId });
        setInterrupted(false); setFocusRevision((value) => value + 1);
      }
    };
    const queued = pendingCommands; pendingCommands = [];
    queued.forEach((json) => deliverCommand?.(json));
    return () => { deliverSnapshot = null; deliverCommand = null; };
  }, []);
  // Native chrome reports what it covers; the camera viewport (the persistent
  // Earth host) shrinks so the globe is never hidden under the Journey card.
  useEffect(() => {
    const root = document.documentElement.style;
    if (!insets) return;
    root.setProperty("--native-atlas-top-inset", `${insets.top}px`);
    root.setProperty("--native-atlas-bottom", `${insets.bottom}px`);
    return () => { root.removeProperty("--native-atlas-top-inset"); root.removeProperty("--native-atlas-bottom"); };
  }, [insets]);
  // Native Settings own map labels: the detail map follows the language and
  // the globe's city names are drawn only when place names are switched on.
  useEffect(() => {
    setDetailLabelPreferences(labels);
    document.documentElement.dataset.placeNames = labels.showPlaceNames ? "on" : "off";
  }, [labels]);
  useEffect(() => {
    if (snapshot?.active) { setInterrupted(false); setFocusRevision((value) => value + 1); }
  }, [snapshot?.active]);
  const journeys = useMemo(() => snapshot ? renderJourneys(snapshot) : [], [snapshot]);
  const routes = useMemo(() => toJourneyRoutes(journeys), [journeys]);
  const previewing = preview !== null;
  const selected = journeys.find((journey) => journey.id === (preview ? preview.journeyId : snapshot?.selection?.journeyId))
    ?? journeys[0];
  const point = selected?.routePoints.find((value) => value.id === (preview ? preview.routePointId : snapshot?.selection?.routePointId));
  const reveal = useMemo(() => timeWindow ? windowReveal(journeys, timeWindow) : null, [journeys, timeWindow]);

  const select = (journeyId: string, routePointId?: string) => {
    if (snapshot) send(snapshot, "select", { journeyId, routePointId });
  };
  const interrupt = () => {
    setInterrupted(true);
    if (snapshot) send(snapshot, "cameraInterrupted");
    // ParticleEarthScene owns the idle clock. Keep commanded focus released
    // until the next native selection or ribbon preview.
  };
  if (error) return <main className="native-atlas__status" aria-hidden="true" />;
  if (!snapshot) return <main className="native-atlas__status" aria-busy="true">
    {!globeOnly && <StartripsBrandLoader message="正在打开图谱…" />}
  </main>;
  return <main className="living-atlas is-mobile-v2 native-atlas" data-mobile-v2="on"
    data-native-mobile-v2="on" data-globe-only={globeOnly ? "on" : undefined} aria-label="图谱地球">
    <style>{selected ? `html .particle-earth-route__label:not([data-journey-route="${CSS.escape(selected.id)}"]) { display: none !important; }` : ""}</style>
    <div className="native-atlas__earth" aria-label="旅程地球">
      <LivingAtlasGlobe journeyRoutes={routes} activeJourneyRouteId={selected?.id}
        selectedJourneyRoutePoint={selected ? { journeyId: selected.id, routePointId: point?.id } : null}
        temporalReveal={reveal ? { journeys: reveal.journeyProgress, points: reveal.pointProgress } : undefined}
        {...atlasSceneFocus(point, routes.find((route) => route.id === selected?.id))}
        focusRevision={focusRevision} focusEnabled={!interrupted && snapshot.active}
        earthExperiencePolicy={snapshot.earthExperience} routeEditingEnabled={false}
        reduceMotion={reduceMotion}
        cinematicActive={!snapshot.active} mediaCoverHint={{ opaqueMediaCover: !snapshot.active, coverTransitionActive: false }}
        onManualCameraInteraction={interrupt} onFocusSettled={() => {
          // A ribbon preview is camera-only: it is never acknowledged as the selection.
          if (!previewing) send(snapshot, "rendered", { focusRequestId: snapshot.selection?.requestId });
        }}
        onJourneyRouteActivate={(journeyId) => select(journeyId)}
        onJourneyRoutePointActivate={select}/>
    </div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<PersistentEarthProvider><AtlasScene/></PersistentEarthProvider>);
