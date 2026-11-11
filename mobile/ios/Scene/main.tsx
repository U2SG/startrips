import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createRoot } from "react-dom/client";
import { IconArrowRight, IconRoute, IconTimeline, IconUserCircle, IconX } from "@tabler/icons-react";
import { StartripsBrandLoader, StartripsJourneyCue } from "../../../src/brand/StartripsBrandMark";
import { StartripsWordmarkSignatureButton } from "../../../src/brand/StartripsSignatureMoment";
import { GlobeTimeScrubber } from "../../../src/journey/GlobeTimeScrubber";
import { useGlobeTimeCursor } from "../../../src/journey/useGlobeTimeCursor";
import { MobileSheetGrabber, useMobileSheetDetents } from "../../../src/journey/mobileSheetDetents";
import { toJourneyRoutes } from "../../../src/journey/journeyModel";
import { LivingAtlasGlobe, PersistentEarthProvider, usePersistentEarth } from "../../../src/scene/LivingAtlasGlobe";
import { acceptsSnapshot, atlasSceneFocus, decodeCommandOrDrop, decodeSnapshotOrReport, journeySwipeDirection, nextJourneyIndex, renderJourneys, send, windowReveal, type CameraInsets, type JourneySwipePoint, type Snapshot, type TimeWindow } from "./bridge";
import "../../../src/styles/tokens.css";
import "../../../src/styles/controls.css";
import "../../../src/styles/living-atlas.css";
import "../../../src/styles/brand-mark.css";
import "../../../src/styles/auth-gate.css";
import "../../../src/app.css";
import "../../../src/styles/globe-time-scrubber.css";
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
  const [cursorScope, setCursorScope] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  const pickerTrigger = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLElement>(null);
  const picker = useRef<HTMLElement>(null);
  const swipeStart = useRef<JourneySwipePoint | null>(null);
  const didSwipe = useRef(false);
  const lastCursorCommit = useRef<string | null>(null);
  const current = useRef<Snapshot | null>(null);
  const [error, setError] = useState(false);
  // Native presentation state (contract v2 commands).
  const [globeOnly, setGlobeOnly] = useState(false);
  const [insets, setInsets] = useState<CameraInsets | null>(null);
  const [timeWindow, setTimeWindow] = useState<TimeWindow | null>(null);
  const [preview, setPreview] = useState<{ journeyId: string; routePointId: string | null } | null>(null);
  useEffect(() => {
    deliverSnapshot = (json) => {
      // An unreadable snapshot is reported to native, which owns the reload control.
      const next = decodeSnapshotOrReport(json);
      if (!next) { setError(true); return; }
      if (!acceptsSnapshot(current.current, next)) return;
      const previous = current.current;
      const newFocus = previous?.scopeId !== next.scopeId || previous?.selection?.requestId !== next.selection?.requestId;
      current.current = next; setSnapshot(next); setError(false);
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
      else {
        setPreview({ journeyId: command.journeyId, routePointId: command.routePointId });
        setInterrupted(false); setFocusRevision((value) => value + 1);
      }
    };
    const queued = pendingCommands; pendingCommands = [];
    queued.forEach((json) => deliverCommand?.(json));
    return () => { deliverSnapshot = null; deliverCommand = null; };
  }, []);
  // In globe-only mode native chrome reports what it covers; the camera viewport
  // (the persistent Earth host) shrinks so the globe is never under the card.
  useEffect(() => {
    const root = document.documentElement.style;
    if (!globeOnly || !insets) { root.removeProperty("--native-atlas-top-inset"); return; }
    root.setProperty("--native-atlas-top-inset", `${insets.top}px`);
    root.setProperty("--native-atlas-bottom", `${insets.bottom}px`);
    return () => { root.removeProperty("--native-atlas-top-inset"); };
  }, [globeOnly, insets]);
  useEffect(() => {
    if (snapshot?.active) { setInterrupted(false); setFocusRevision((value) => value + 1); }
  }, [snapshot?.active]);
  const journeys = useMemo(() => snapshot ? renderJourneys(snapshot) : [], [snapshot]);
  const routes = useMemo(() => toJourneyRoutes(journeys), [journeys]);
  const time = useGlobeTimeCursor(journeys);
  const cursorActive = !!snapshot?.active && cursorScope === snapshot.scopeId;
  const previewing = !cursorActive && preview !== null;
  const selected = journeys.find((journey) => journey.id === (cursorActive ? time.selection?.journeyId
    : previewing ? preview.journeyId : snapshot?.selection?.journeyId))
    ?? journeys[0];
  const point = cursorActive
    ? selected?.routePoints[time.selection?.pointIndex ?? -1]
    : selected?.routePoints.find((value) => value.id === (previewing ? preview.routePointId : snapshot?.selection?.routePointId));
  const nativeReveal = useMemo(() => timeWindow ? windowReveal(journeys, timeWindow) : null, [journeys, timeWindow]);

  useEffect(() => {
    if (!snapshot?.active || cursorScope !== snapshot.scopeId) {
      time.pause();
      setCursorScope(null);
      lastCursorCommit.current = null;
    }
  }, [snapshot?.active, snapshot?.scopeId, cursorScope, time.pause]);

  // The native router owns identity and navigation. Never carry a previous
  // owner/guest overlay into another scope or above a real Story destination.
  useEffect(() => {
    setSheetOpen(false);
    setPickerOpen(false);
  }, [snapshot?.scopeId, snapshot?.active]);

  useEffect(() => {
    if (sheetOpen) sheet.current?.focus({ preventScroll: true });
    else if (pickerOpen) picker.current?.focus({ preventScroll: true });
  }, [sheetOpen, pickerOpen]);

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
    if (globeOnly) return;
    if (!element) {
      document.documentElement.style.setProperty("--native-atlas-bottom", "0px");
      return () => document.documentElement.style.removeProperty("--native-atlas-bottom");
    }
    const update = () => {
      const bottom = document.documentElement.clientHeight - element.getBoundingClientRect().top;
      document.documentElement.style.setProperty("--native-atlas-bottom", `${Math.max(0, bottom)}px`);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => { observer.disconnect(); document.documentElement.style.removeProperty("--native-atlas-bottom"); };
  }, [!!snapshot, error, selected?.id, globeOnly]);

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
  const closeSheet = () => {
    setSheetOpen(false);
    requestAnimationFrame(() => chip.current?.focus({ preventScroll: true }));
  };
  const sheetDetents = useMobileSheetDetents(sheet, closeSheet, sheetOpen && !scrollableDetails ? selected?.id ?? null : null);
  useLayoutEffect(() => {
    // The same sheet can switch from scrolling to the compact detent while open.
    if (!scrollableDetails && sheet.current) sheet.current.scrollTop = 0;
  }, [scrollableDetails]);
  const closePicker = () => {
    setPickerOpen(false);
    requestAnimationFrame(() => pickerTrigger.current?.focus({ preventScroll: true }));
  };
  const stepJourney = (step: -1 | 1) => {
    if (!selected || !snapshot || journeys.length < 2) return;
    const index = journeys.findIndex((journey) => journey.id === selected.id);
    const next = journeys[nextJourneyIndex(index, journeys.length, step)];
    if (next && next.id !== selected.id) select(next.id);
  };
  const finishJourneySwipe = (end: JourneySwipePoint) => {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (!start) return;
    const direction = journeySwipeDirection(start, end);
    if (direction) {
      didSwipe.current = true;
      stepJourney(direction);
    } else if (Math.hypot(end.x - start.x, end.y - start.y) > 16) {
      // A drag must never accidentally open the details sheet as a click.
      didSwipe.current = true;
    }
  };
  const onDialogKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (pickerOpen) closePicker();
      else closeSheet();
    }
    if (event.key !== "Tab") return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not([disabled])")];
    if (!controls.length) return;
    if (event.shiftKey && document.activeElement === controls[0]) {
      event.preventDefault(); controls.at(-1)?.focus();
    } else if (!event.shiftKey && document.activeElement === controls.at(-1)) {
      event.preventDefault(); controls[0]?.focus();
    }
  };
  const dateRange = selected ? [selected.startedOn, selected.endedOn].filter(Boolean).join(" — ") : "";
  const stops = selected?.routePoints.filter((p) => p.isStop) ?? [];
  const routeSummary = !selected ? "" : stops.length > 1
    ? stops[0].label + " → " + stops[stops.length - 1].label
    : stops.length === 1 ? stops[0].label : selected.routePoints.length + " 个途经点";
  if (error) return <main className="native-atlas__status" aria-hidden="true" />;
  if (!snapshot) return <main className="native-atlas__status" aria-busy="true">
    <StartripsBrandLoader message="正在打开图谱…" />
  </main>;
  return <main className="living-atlas is-mobile-v2 native-atlas" data-mobile-v2="on"
    data-native-mobile-v2="on" data-globe-only={globeOnly ? "on" : undefined} aria-label="图谱地球">
    <div className="native-atlas__earth" aria-label="旅程地球">
      <LivingAtlasGlobe journeyRoutes={routes} activeJourneyRouteId={selected?.id}
        selectedJourneyRoutePoint={selected ? { journeyId: selected.id, routePointId: point?.id } : null}
        temporalReveal={cursorActive ? { journeys: time.reveal.journeyProgress, points: time.reveal.pointProgress,
          timestamp: time.timeDomain ? time.timeDomain.minTime + time.cursor * (time.timeDomain.maxTime - time.timeDomain.minTime) : undefined }
          : nativeReveal ? { journeys: nativeReveal.journeyProgress, points: nativeReveal.pointProgress } : undefined}
        {...atlasSceneFocus(point, routes.find((route) => route.id === selected?.id))}
        focusRevision={focusRevision} focusEnabled={!interrupted && snapshot.active}
        earthExperiencePolicy={snapshot.earthExperience} routeEditingEnabled={false}
        labelLegibility={labelLegibility}
        reduceMotion={reduceMotion}
        cinematicActive={!snapshot.active} mediaCoverHint={{ opaqueMediaCover: !snapshot.active, coverTransitionActive: false }}
        onManualCameraInteraction={interrupt} onFocusSettled={() => {
          // A ribbon preview is camera-only: it is never acknowledged as the selection.
          if (previewing) return;
          if (!cursorActive || (time.scrub === null && selected?.id === snapshot.selection?.journeyId
            && (point?.id ?? null) === (snapshot.selection?.routePointId ?? null))) {
            send(snapshot, "rendered", { focusRequestId: snapshot.selection?.requestId });
          }
        }}
        onJourneyRouteActivate={(journeyId) => select(journeyId)}
        onJourneyRoutePointActivate={select}/>
    </div>
    {!globeOnly && <>
    <header className="mobile-v2__header native-atlas__header"
      inert={sheetOpen || pickerOpen || undefined}>
      <div className="mobile-v2__brand"><StartripsWordmarkSignatureButton size={27} state="rest" /></div>
      <nav aria-label="移动端旅程操作">
        <button type="button" aria-label="切换账户或分享"
          onClick={() => send(snapshot, "switchAccess")}>
          <IconUserCircle size={19} stroke={1.4} aria-hidden="true" />
        </button>
        {journeys.length > 0 && <button type="button" ref={pickerTrigger}
          aria-label="打开全部旅程" aria-expanded={pickerOpen}
          onClick={() => { setSheetOpen(false); setPickerOpen(true); }}>
          <IconTimeline size={19} stroke={1.4} aria-hidden="true" />
        </button>}
      </nav>
    </header>
    {selected && <section ref={panel} className="mobile-v2__chrome native-atlas__chrome"
      inert={sheetOpen || pickerOpen || undefined}
      aria-label="当前旅程与时间轴"
      style={{ "--journey-color": selected.lightColor } as CSSProperties}>
      <button ref={chip} type="button" className="mobile-v2__journey-chip"
        aria-label={"查看当前旅程详情：" + selected.title + "。左右滑动切换旅程"}
        aria-expanded={sheetOpen}
        onTouchStart={(event) => {
          if (event.touches.length !== 1) { swipeStart.current = null; return; }
          const touch = event.touches[0];
          swipeStart.current = { x: touch.clientX, y: touch.clientY };
          didSwipe.current = false;
        }}
        onTouchEnd={(event) => {
          if (event.touches.length !== 0 || event.changedTouches.length !== 1) {
            swipeStart.current = null; return;
          }
          const touch = event.changedTouches[0];
          finishJourneySwipe({ x: touch.clientX, y: touch.clientY });
        }}
        onTouchCancel={() => { swipeStart.current = null; }}
        onPointerDown={(event) => {
          // iOS touch events are tracked separately; pointer capture keeps
          // mouse/pen swipes alive when the pointer exits the 56px chip.
          if (event.pointerType === "touch" || !event.isPrimary) return;
          swipeStart.current = { x: event.clientX, y: event.clientY };
          didSwipe.current = false;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerUp={(event) => {
          if (event.pointerType === "touch") return;
          finishJourneySwipe({ x: event.clientX, y: event.clientY });
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onPointerCancel={(event) => {
          if (event.pointerType !== "touch") swipeStart.current = null;
        }}
        onClick={() => {
          if (didSwipe.current) { didSwipe.current = false; return; }
          setSheetOpen(true);
        }}>
        <span className="mobile-v2__journey-light" aria-hidden="true" />
        <span className="mobile-v2__journey-copy">
          <small>{dateRange}</small>
          <strong>{selected.title}</strong>
          <span>{point?.label || (selected.routePoints.length + " 个路线点")}</span>
        </span>
        <IconArrowRight size={17} stroke={1.35} aria-hidden="true" />
      </button>
      <div className="mobile-v2__timeline">
        {time.timeDomain && <GlobeTimeScrubber {...time}
          play={() => { beginCursor(); time.play(); }}
          seek={(value) => { beginCursor(); time.seek(value); }}
          setScrub={(value) => { beginCursor(); time.setScrub(value); }}/>}
      </div>
    </section>}
    {!journeys.length && <section className="native-atlas__empty" aria-label="空图谱">
      <StartripsJourneyCue size={54}/>
      <p>图谱里还没有旅程</p>
    </section>}
    {sheetOpen && selected && <div className="mobile-v2__sheet-layer native-atlas__sheet-layer">
      <button className="mobile-v2__sheet-backdrop" type="button" tabIndex={-1}
        aria-label="关闭旅程详情" onClick={closeSheet}/>
      <section ref={sheet} className="mobile-v2__sheet native-atlas__sheet" role="dialog"
        aria-modal="true" aria-labelledby="native-atlas-sheet-title"
        tabIndex={-1} onKeyDown={onDialogKeyDown}
        {...(scrollableDetails ? { "data-scrollable": true } : sheetDetents.sheetProps)}
        style={{ "--journey-color": selected.lightColor } as CSSProperties}>
        {scrollableDetails
          ? <button className="native-atlas__sheet-close" type="button" aria-label="返回地球" onClick={closeSheet}>
              <IconX size={19} stroke={1.4} aria-hidden="true" />
            </button>
          : <MobileSheetGrabber detent={sheetDetents.detent}
              onHandleClick={sheetDetents.onHandleClick} toggle={sheetDetents.toggle}/>}
        <div className="mobile-v2__sheet-heading">
          <p>{dateRange}</p>
          <h2 id="native-atlas-sheet-title">{selected.title}</h2>
          <span>{routeSummary}</span>
        </div>
        <div className="native-atlas__sheet-cover" aria-hidden="true">
          <StartripsJourneyCue size={62}/>
        </div>
        <dl className="mobile-v2__stats">
          <div><dt>路线点</dt><dd>{selected.routePoints.length}</dd></div>
          <div><dt>媒体</dt><dd>{selected.media.length}</dd></div>
          <div><dt>停靠</dt><dd>{stops.length}</dd></div>
        </dl>
        <p className={"mobile-v2__sheet-note" + (selected.note ? "" : " is-empty")}>
          {selected.note || "路线已经留在地球上，故事等待被打开。"}
        </p>
        <div className="native-atlas__route-points" role="group" aria-label="旅程地点">
          {selected.routePoints.map((routePoint) => <button
            key={routePoint.id} type="button" role="switch"
            aria-checked={routePoint.id === point?.id}
            onClick={() => { select(selected.id, routePoint.id); closeSheet(); }}>
            <IconRoute size={14} stroke={1.4} aria-hidden="true" />
            {routePoint.label || "路线点"}
          </button>)}
        </div>
        <div className="mobile-v2__sheet-actions">
          <button className="is-primary" type="button"
            aria-label={point ? "打开故事：" + point.label : "打开故事"}
            onClick={() => {
              setSheetOpen(false);
              send(snapshot, "story", { journeyId: selected.id,
                ...(point ? { routePointId: point.id } : {}) });
            }}>打开故事 <IconArrowRight size={17} stroke={1.35} aria-hidden="true" /></button>
          {!scrollableDetails && <button type="button" onClick={closeSheet}>返回地球</button>}
        </div>
      </section>
    </div>}
    {pickerOpen && <section ref={picker} className="mobile-v2__picker native-atlas__picker"
      role="dialog" aria-modal="true" tabIndex={-1}
      aria-labelledby="native-atlas-picker-title" onKeyDown={onDialogKeyDown}>
      <header>
        <h2 id="native-atlas-picker-title">全部旅程</h2>
        <button type="button" aria-label="关闭全部旅程" onClick={closePicker}>
          <IconX size={19} stroke={1.4} aria-hidden="true" />
        </button>
      </header>
      <ol>{journeys.map((journey) => <li key={journey.id}>
        <button type="button" className={journey.id === selected?.id ? "is-active" : ""}
          aria-current={journey.id === selected?.id ? "true" : undefined}
          aria-label={"切换到旅程：" + journey.title}
          style={{ "--journey-color": journey.lightColor } as CSSProperties}
          onClick={() => { select(journey.id); closePicker(); }}>
          <span className="mobile-v2__picker-thumb" aria-hidden="true"><IconRoute size={22} stroke={1.05}/></span>
          <span className="mobile-v2__picker-copy">
            <small>{[journey.startedOn, journey.endedOn].filter(Boolean).join(" — ")}</small>
            <strong>{journey.title}</strong>
            <span>{journey.routePoints.length + " 个路线点"}</span>
          </span>
          <IconArrowRight size={17} stroke={1.35} aria-hidden="true" />
        </button>
      </li>)}</ol>
    </section>}
    </>}
  </main>;
}
createRoot(document.getElementById("root")!).render(<PersistentEarthProvider><AtlasScene/></PersistentEarthProvider>);
