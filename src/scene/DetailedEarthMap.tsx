import { useEffect, useLayoutEffect, useRef, type MutableRefObject } from "react";
import {
  AttributionControl,
  Map as MapLibreMap,
  NavigationControl,
  type GeoJSONSource,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { JourneyRoute } from "../journey/types";
import {
  createDetailedEarthLabelExpression,
  DETAILED_EARTH_DRAG_PAN_OPTIONS,
  getDetailedEarthRouteFrame,
  getDetailedEarthFocusDuration,
  pickDetailedEarthJourneyRoutePointHit,
  getEarthDiveHandoffFrame,
  detailedEarthAnchorCorrection,
  solveDetailedEarthHandoffZoom,
  type ParticleAnchorFrame,
  DETAILED_EARTH_INITIAL_ZOOM,
  DETAILED_EARTH_MAX_PITCH,
  DETAILED_EARTH_MAX_ZOOM,
  DETAILED_EARTH_MIN_ZOOM,
  DETAILED_EARTH_PITCH_SPEED,
  type DetailedEarthJourneyOverlay,
  type DetailedEarthLanguage,
  type DetailedEarthFocusFlightProfile,
  DETAILED_EARTH_ROTATE_SPEED,
  DETAILED_EARTH_TOUCH_ZOOM_RATE,
  DETAILED_EARTH_TOUCH_ZOOM_THRESHOLD,
  getDetailedEarthStyle,
  isDetailedEarthNameLabel,
  shouldReturnToParticleEarth,
  useGlobeProjection,
} from "./detailedEarthModel";
import {
  canCommitDetailedEarthReveal,
  resolveDetailedEarthRevealCameraCommit,
  resolveDetailedEarthRevealSyncAction,
  type DetailReadiness,
  type DetailedEarthRevealCameraSnapshot,
  type DetailedEarthSurfaceGeometry,
  type EarthDiveOwner,
  type EarthDiveStage,
} from "./earthDive";
import type { SemanticZoomSnapshot } from "./semanticZoom";

// #252 section 2: the handoff has to prove "the same place did not move", so
// the map publishes the two screen-space quantities that decide it — where the
// focused anchor lands, and the local geographic scale there. Latitude is used
// for the scale on purpose: a degree of longitude shrinks with latitude, so a
// north-south probe measures the projection and not the anchor's latitude.
const LOCAL_SCALE_PROBE_DEG = 0.05;
// Route framing under a non-linear globe projection occasionally needs more
// than two synchronous corrections. This is a bounded fixed-point solve inside
// one published particle frame, not another animation loop; most point focuses
// exit after 1-2 passes, while large whole-Journey frames may use more.
const CALIBRATION_MAX_PASSES = 6;
const CALIBRATION_RETRY_PASSES = 2;
const CALIBRATION_ZOOM_EPSILON = 0.0005;
const CALIBRATION_ANCHOR_EPSILON_PX = 0.05;
const CALIBRATION_SCALE_ERROR_EPSILON = 0.0005;

const JOURNEY_OVERLAY_SOURCE_ID = "startrips-active-journey";
const JOURNEY_OVERLAY_ROUTE_LAYER_ID = "startrips-active-journey-route";
const JOURNEY_OVERLAY_POINT_LAYER_ID = "startrips-active-journey-points";
const JOURNEY_OVERLAY_LABEL_LAYER_ID = "startrips-active-journey-labels";
const JOURNEY_OVERLAY_HIT_LAYER_ID = "startrips-active-journey-hit-targets";

function installDetailedEarthJourneyOverlay(
  map: MapLibreMap,
  overlay: DetailedEarthJourneyOverlay,
) {
  const existingSource = map.getSource(JOURNEY_OVERLAY_SOURCE_ID) as GeoJSONSource | undefined;
  if (existingSource) {
    existingSource.setData(overlay.data);
  } else {
    map.addSource(JOURNEY_OVERLAY_SOURCE_ID, {
      type: "geojson",
      data: overlay.data,
    });
  }

  if (!map.getLayer(JOURNEY_OVERLAY_ROUTE_LAYER_ID)) {
    map.addLayer({
      id: JOURNEY_OVERLAY_ROUTE_LAYER_ID,
      type: "line",
      source: JOURNEY_OVERLAY_SOURCE_ID,
      filter: ["==", ["get", "featureKind"], "segment"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-width": ["interpolate", ["linear"], ["zoom"], 5.6, 1.35, 10, 2.4, 16, 4.2],
        "line-opacity": [
          "match", ["get", "attentionRole"],
          "narrative-current", 0.94,
          "selected", 0.88,
          0.72,
        ],
        "line-dasharray": [1.4, 1.2],
      },
    });
  }
  if (!map.getLayer(JOURNEY_OVERLAY_POINT_LAYER_ID)) {
    map.addLayer({
      id: JOURNEY_OVERLAY_POINT_LAYER_ID,
      type: "circle",
      source: JOURNEY_OVERLAY_SOURCE_ID,
      filter: [
        "all",
        ["==", ["get", "featureKind"], "route-point"],
        ["==", ["get", "markerVisible"], true],
      ],
      paint: {
        "circle-color": ["get", "color"],
        "circle-radius": [
          "case",
          ["==", ["get", "attentionRole"], "narrative-current"], 7,
          ["==", ["get", "attentionRole"], "selected"], 6.4,
          ["==", ["get", "semanticRole"], "stop"], 5,
          3.1,
        ],
        "circle-opacity": [
          "case",
          ["==", ["get", "semanticRole"], "passthrough"], 0.55,
          0.9,
        ],
        "circle-stroke-color": "rgba(9, 14, 18, 0.72)",
        "circle-stroke-width": [
          "case",
          ["==", ["get", "attentionRole"], "ordinary"], 1.2,
          2,
        ],
      },
    });
  }
  const styleSupportsTextLabels = Boolean(map.getStyle().glyphs);
  if (styleSupportsTextLabels && !map.getLayer(JOURNEY_OVERLAY_LABEL_LAYER_ID)) {
    map.addLayer({
      id: JOURNEY_OVERLAY_LABEL_LAYER_ID,
      type: "symbol",
      source: JOURNEY_OVERLAY_SOURCE_ID,
      minzoom: 7,
      filter: [
        "all",
        ["==", ["get", "featureKind"], "route-point"],
        ["==", ["get", "markerVisible"], true],
        ["!=", ["get", "label"], ""],
        [
          "any",
          ["==", ["get", "semanticRole"], "stop"],
          ["!=", ["get", "attentionRole"], "ordinary"],
        ],
      ],
      layout: {
        "text-field": ["get", "label"],
        "text-size": 11,
        "text-offset": [0, 1.2],
        "text-anchor": "top",
        "text-allow-overlap": false,
        "text-ignore-placement": false,
      },
      paint: {
        "text-color": "rgba(241, 247, 248, 0.92)",
        "text-halo-color": "rgba(5, 11, 14, 0.86)",
        "text-halo-width": 1.3,
      },
    });
  }
  if (!map.getLayer(JOURNEY_OVERLAY_HIT_LAYER_ID)) {
    map.addLayer({
      id: JOURNEY_OVERLAY_HIT_LAYER_ID,
      type: "circle",
      source: JOURNEY_OVERLAY_SOURCE_ID,
      filter: [
        "all",
        ["==", ["get", "featureKind"], "route-point"],
        ["==", ["get", "activatable"], true],
      ],
      paint: {
        // Visual marker size and interaction size are deliberately decoupled.
        // 22px radius gives every disclosed Route Point a 44px pointer target.
        "circle-radius": 22,
        "circle-opacity": 0,
      },
    });
  }
}

type DetailedEarthMapProps = {
  /** Which Dive stage this map is mounted under. */
  diveStage?: EarthDiveStage;
  /**
   * Who owns camera and gesture input. While the particle globe owns it this
   * map follows the handoff frame and answers no gestures, however visible it
   * already is; opacity never decides ownership.
   */
  diveOwner?: EarthDiveOwner;
  /** The zoom authority's snapshot the handoff frame is seeded from. */
  diveSnapshot?: SemanticZoomSnapshot;
  /**
   * What the particle Earth is showing at the focused place, in viewport CSS
   * pixels. This map solves its own camera to it, so the two renderers are
   * known to agree in screen space rather than assumed to.
   */
  particleFrame?: ParticleAnchorFrame | null;
  focusPoint?: { lat: number; lon: number } | null;
  focusRoute?: JourneyRoute | null;
  /** Active authorized Journey projected from the same Route consumed by Particle Earth. */
  journeyOverlay: DetailedEarthJourneyOverlay;
  focusRevision?: number;
  focusFlightProfile?: DetailedEarthFocusFlightProfile;
  language: DetailedEarthLanguage;
  onJourneyRoutePointActivate?: (journeyId: string, routePointId: string) => void;
  onGlobePointPick?: (point: { latitude: number; longitude: number }) => void;
  onOverviewRequest?: () => void;
  /** Latest detail-owned geographic observation for a renderer-to-particle handback. */
  onCameraObservation?: (point: { latitude: number; longitude: number }) => void;
  /**
   * How far this renderer has come. #252 section 3 separates renderer readiness
   * from tile settlement: `visual-ready` means the style is parsed and the
   * handoff frame can be drawn, `fully-settled` that the tiles stopped moving.
   * The Dive blends on the former, so a slow or retrying network cannot strand
   * the transition and no timer is involved in either.
   */
  onReadinessChange?: (readiness: DetailReadiness) => void;
  /** Existing screen-space calibration exposed to the Dive owner so a newly
   * published particle frame can be applied in the same event, without a
   * React-render frame of lag during continuous wheel/pinch input. */
  calibrationHandleRef?: MutableRefObject<((
    frame: ParticleAnchorFrame,
    mode?: "sync" | "retry",
  ) => void) | null>;
};

function applyMapLanguage(map: MapLibreMap, language: DetailedEarthLanguage) {
  const textField = createDetailedEarthLabelExpression(language);
  for (const layer of map.getStyle().layers ?? []) {
    if (layer.type !== "symbol") continue;
    const currentTextField = layer.layout?.["text-field"];
    if (!isDetailedEarthNameLabel(currentTextField)) continue;
    map.setLayoutProperty(layer.id, "text-field", textField);
  }
}

function applyDetailedEarthFocus(
  map: MapLibreMap,
  focusPoint: { lat: number; lon: number } | null | undefined,
  focusRoute: JourneyRoute | null | undefined,
  duration: number,
) {
  const routeFrame = getDetailedEarthRouteFrame(focusRoute?.points ?? []);
  if (routeFrame && routeFrame.pointCount > 1) {
    map.fitBounds(routeFrame.bounds, {
      padding: 56,
      maxZoom: 10,
      duration,
      essential: true,
    });
    return true;
  }
  const target = routeFrame?.center
    ?? (focusPoint ? [focusPoint.lon, focusPoint.lat] as [number, number] : null);
  if (!target) return false;
  map.flyTo({
    center: target,
    zoom: Math.max(map.getZoom(), DETAILED_EARTH_INITIAL_ZOOM),
    duration,
    essential: true,
  });
  return true;
}

export default function DetailedEarthMap({
  diveStage = "detail",
  diveOwner = "detail",
  diveSnapshot = { level: "local", zoom: Number.NaN, localProgress: 1 },
  particleFrame = null,
  focusPoint,
  focusRoute,
  journeyOverlay,
  focusRevision = 0,
  focusFlightProfile,
  language,
  onJourneyRoutePointActivate,
  onGlobePointPick,
  onOverviewRequest,
  onCameraObservation,
  onReadinessChange,
  calibrationHandleRef,
}: DetailedEarthMapProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  // One request per period of ownership: the map asks to go home once, and the
  // latch is released when ownership is no longer the map's, so a second dive
  // through the same instance can ask again.
  const overviewRequestedRef = useRef(false);
  const calibrateRef = useRef<(() => void) | null>(null);
  const revealSyncRef = useRef<((reason: "load" | "stage" | "resize-observer") => void) | null>(null);
  const languageRef = useRef(language);
  const focusPointRef = useRef(focusPoint);
  const focusRouteRef = useRef(focusRoute);
  const journeyOverlayRef = useRef(journeyOverlay);
  const syncJourneyOverlayRef = useRef<(() => void) | null>(null);
  const onJourneyRoutePointActivateRef = useRef(onJourneyRoutePointActivate);
  const onPickRef = useRef(onGlobePointPick);
  const onOverviewRequestRef = useRef(onOverviewRequest);
  const onCameraObservationRef = useRef(onCameraObservation);
  const onReadinessChangeRef = useRef(onReadinessChange);
  const diveStageRef = useRef(diveStage);
  const diveOwnerRef = useRef(diveOwner);
  const diveSnapshotRef = useRef(diveSnapshot);
  const particleFrameRef = useRef(particleFrame);
  const focusRevisionRef = useRef(focusRevision);
  const cameraIntentRevisionRef = useRef(0);
  const focusFlightActiveRef = useRef(false);
  if (focusRevisionRef.current !== focusRevision) {
    focusRevisionRef.current = focusRevision;
    cameraIntentRevisionRef.current += 1;
  }
  diveStageRef.current = diveStage;
  diveOwnerRef.current = diveOwner;
  diveSnapshotRef.current = diveSnapshot;
  particleFrameRef.current = particleFrame;
  languageRef.current = language;
  focusPointRef.current = focusPoint;
  focusRouteRef.current = focusRoute;
  journeyOverlayRef.current = journeyOverlay;
  onJourneyRoutePointActivateRef.current = onJourneyRoutePointActivate;
  onPickRef.current = onGlobePointPick;
  onOverviewRequestRef.current = onOverviewRequest;
  onCameraObservationRef.current = onCameraObservation;
  onReadinessChangeRef.current = onReadinessChange;

  const handoffFrame = (frameOverride?: ParticleAnchorFrame | null) => getEarthDiveHandoffFrame({
    stage: diveStageRef.current,
    snapshot: diveSnapshotRef.current,
    focusPoint: focusPointRef.current,
    routePoints: focusRouteRef.current?.points ?? [],
    particleFrame: frameOverride === undefined ? particleFrameRef.current : frameOverride,
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // The map is framed ONCE, from the particle focus it is taking over from.
    // The superseded path mounted at DETAILED_EARTH_INITIAL_ZOOM and then flew
    // to the same focus, and that second flight is exactly the jump #252 is
    // about.
    const mountFrame = handoffFrame();
    if (import.meta.env.DEV && typeof window !== "undefined") {
      const debugWindow = window as Window & { __detailedEarthMapConstructionCount?: number };
      debugWindow.__detailedEarthMapConstructionCount = (debugWindow.__detailedEarthMapConstructionCount ?? 0) + 1;
    }
    const map = new MapLibreMap({
      container: host,
      style: getDetailedEarthStyle(),
      center: mountFrame?.center ?? [104, 34],
      zoom: mountFrame?.zoom ?? DETAILED_EARTH_INITIAL_ZOOM,
      minZoom: DETAILED_EARTH_MIN_ZOOM,
      maxZoom: DETAILED_EARTH_MAX_ZOOM,
      maxPitch: DETAILED_EARTH_MAX_PITCH,
      pitch: 0,
      bearing: 0,
      rotateSpeed: DETAILED_EARTH_ROTATE_SPEED,
      pitchSpeed: DETAILED_EARTH_PITCH_SPEED,
      renderWorldCopies: true,
      attributionControl: false,
      cooperativeGestures: false,
      // The hidden/prewarming renderer must never ingest particle-owned input.
      // Handler state is enabled explicitly only when the Dive owner becomes
      // `detail`, eliminating the tiny mount window where wheel state could be
      // accumulated and replayed after ownership transfer.
      interactive: false,
      fadeDuration: 650,
    });
    let initialLoadSettled = false;
    let removed = false;
    let revealRevision = 0;
    let fullySettled = false;
    let lastHostGeometry: Pick<DetailedEarthSurfaceGeometry, "hostWidth" | "hostHeight"> | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let renderCount = 0;
    let idleCount = 0;
    let resizeCount = 0;
    let appliedJourneyOverlayRevision: string | null = null;
    let loadedJourneyOverlayRevision: string | null = null;
    let paintedJourneyOverlayRevision: string | null = null;
    let pendingRevealCommit: {
      revision: number;
      stage: EarthDiveStage;
      afterRenderCount: number;
      intentRevision: number;
      cameraBefore: DetailedEarthRevealCameraSnapshot;
      reason: "load" | "stage" | "resize-observer";
    } | null = null;
    mapRef.current = map;
    let debugProject: ((longitude: number, latitude: number) => { x: number; y: number }) | null = null;
    if (import.meta.env.DEV && typeof window !== "undefined") {
      const debugWindow = window as Window & {
        __detailedEarthMapProject?: (longitude: number, latitude: number) => { x: number; y: number };
      };
      debugProject = (longitude, latitude) => {
        const projected = map.project([longitude, latitude]);
        const rect = host.getBoundingClientRect();
        return { x: rect.left + projected.x, y: rect.top + projected.y };
      };
      debugWindow.__detailedEarthMapProject = debugProject;
    }
    // Register the one-shot load observation immediately after construction.
    // A tiny inline/QA style can become style-loaded before the rest of this
    // effect has finished wiring calibration/reveal callbacks. Keep the event
    // bit so the later idempotent settle function can recover that race.
    let loadEventObserved = false;
    let renderEventObserved = false;
    let settleInitialLoad: (() => void) | null = null;
    map.on("load", () => {
      loadEventObserved = true;
      settleInitialLoad?.();
    });
    // Configure gesture rates up front, but do not enable handlers while the
    // particle surface owns the Dive. Primary mouse / one-finger touch will
    // still pan and right-button / Ctrl+drag will still rotate once detail owns.
    map.touchZoomRotate.setZoomRate(DETAILED_EARTH_TOUCH_ZOOM_RATE);
    map.touchZoomRotate.setZoomThreshold(DETAILED_EARTH_TOUCH_ZOOM_THRESHOLD);
    const canvas = map.getCanvas();
    canvas.style.touchAction = "none";

    map.addControl(new NavigationControl({ showCompass: true }), "bottom-right");
    map.addControl(new AttributionControl({ compact: true }), "bottom-left");

    const publishReadiness = (readiness: DetailReadiness) => {
      host.dataset.mapReadiness = readiness;
      onReadinessChangeRef.current?.(readiness);
    };
    const syncJourneyOverlay = () => {
      if (removed || !map.isStyleLoaded()) return false;
      const overlay = journeyOverlayRef.current;
      const source = map.getSource(JOURNEY_OVERLAY_SOURCE_ID);
      if (source && appliedJourneyOverlayRevision === overlay.revision) return true;
      try {
        installDetailedEarthJourneyOverlay(map, overlay);
        appliedJourneyOverlayRevision = overlay.revision;
        // This source is a complete in-memory FeatureCollection, not a tile or
        // network-backed source. Once addSource/setData returns, the current
        // Journey revision has been accepted by MapLibre; the later render
        // below is the paint proof. Waiting for isSourceLoaded/sourcedata here
        // can deadlock a hidden prewarm surface because a synchronous GeoJSON
        // update is allowed to miss that lifecycle edge entirely.
        loadedJourneyOverlayRevision = overlay.revision;
        paintedJourneyOverlayRevision = null;
        host.dataset.journeyOverlayReady = "false";
        host.dataset.journeyOverlayRevision = overlay.revision;
        host.dataset.journeyOverlayJourneyId = overlay.journeyId ?? "";
        host.dataset.journeyOverlayPointCount = String(overlay.pointCount);
        host.dataset.journeyOverlayStopCount = String(overlay.stopCount);
        host.dataset.journeyOverlayPassthroughCount = String(overlay.passthroughCount);
        host.dataset.journeyOverlayFeatureCount = String(overlay.data.features.length);
        host.dataset.journeyOverlaySourceJourneyCount = String(new Set(
          overlay.data.features.map((feature) => feature.properties.journeyId),
        ).size);
        delete host.dataset.journeyOverlayError;
        map.triggerRepaint();
        return true;
      } catch (error) {
        appliedJourneyOverlayRevision = null;
        loadedJourneyOverlayRevision = null;
        paintedJourneyOverlayRevision = null;
        host.dataset.journeyOverlayReady = "false";
        host.dataset.journeyOverlayError = error instanceof Error ? error.message : "journey-overlay-error";
        return false;
      }
    };
    syncJourneyOverlayRef.current = syncJourneyOverlay;
    const publishCameraObservation = () => {
      if (diveOwnerRef.current !== "detail") return;
      const center = map.getCenter();
      host.dataset.mapCameraObservation = `${center.lng},${center.lat}`;
      onCameraObservationRef.current?.({
        latitude: center.lat,
        longitude: center.lng,
      });
    };
    // The renderer exists but has drawn nothing yet.
    publishReadiness("mounted");

    // #252 section 2: publish where the focused anchor lands and how large a
    // degree of latitude is there, so the handoff can be measured rather than
    // asserted. Both come from MapLibre's own projection.
    /** This renderer's own anchor and local scale, measured with `project`. */
    const measureAnchorFrame = (frameOverride?: ParticleAnchorFrame | null) => {
      const anchor = handoffFrame(frameOverride)?.center;
      if (!anchor) return null;
      const projected = map.project(anchor);
      const probe = map.project([anchor[0], anchor[1] + LOCAL_SCALE_PROBE_DEG]);
      return {
        anchor,
        projected,
        pxPerDegreeLat: Math.hypot(projected.x - probe.x, projected.y - probe.y)
          / LOCAL_SCALE_PROBE_DEG,
      };
    };

    const publishAnchorFrame = (frameOverride?: ParticleAnchorFrame | null) => {
      const measured = measureAnchorFrame(frameOverride);
      if (!measured) return;
      // Published in VIEWPORT pixels, like the particle side's: the two
      // renderers live in different boxes, so a container-relative number
      // could not be compared with the other one.
      const rect = host.getBoundingClientRect();
      host.dataset.handoffAnchorX = (rect.left + measured.projected.x).toFixed(2);
      host.dataset.handoffAnchorY = (rect.top + measured.projected.y).toFixed(2);
      host.dataset.handoffZoom = map.getZoom().toFixed(4);
      host.dataset.handoffScale = measured.pxPerDegreeLat.toFixed(3);
    };

    /**
     * Solve this map's camera to what the particle Earth is showing.
     *
     * Two questions, both answered by MapLibre's own projection and applied
     * with non-animated camera updates: what zoom reproduces the particle's
     * local scale, and which centre puts the anchor on the particle's screen
     * point. Each is a measurement followed by a correction, and the solver is
     * a fixed point once they agree, so a bounded loop converges instead of
     * hunting.
     */
    const calibrateToParticle = (
      frameOverride?: ParticleAnchorFrame | null,
      mode: "sync" | "retry" = "sync",
    ) => {
      const particle = frameOverride ?? particleFrameRef.current;
      const frame = handoffFrame(frameOverride);
      if (!particle || !frame) return;
      // A fresh particle-frame synchronization is an authorized camera intent.
      // A bounded retry is the SAME already-authorized frame: advancing the
      // revision on every Dive rAF retry would make the reveal commit stale on
      // every render and could starve a fully-settled blend forever.
      if (mode === "sync") cameraIntentRevisionRef.current += 1;
      // A NEW particle frame reseeds the geographic center. A retry of the SAME
      // stable frame must preserve the center correction already accumulated by
      // previous passes, otherwise every Dive rAF would erase its own progress.
      if (mode === "sync") map.jumpTo({ center: frame.center });
      const maxPasses = mode === "retry" ? CALIBRATION_RETRY_PASSES : CALIBRATION_MAX_PASSES;
      for (let pass = 0; pass < maxPasses; pass += 1) {
        const measured = measureAnchorFrame(frameOverride);
        if (!measured) return;
        const zoom = solveDetailedEarthHandoffZoom({
          measuredZoom: map.getZoom(),
          measuredPxPerDegreeLat: measured.pxPerDegreeLat,
          targetPxPerDegreeLat: particle.pxPerDegreeLat,
        });
        if (Math.abs(zoom - map.getZoom()) > CALIBRATION_ZOOM_EPSILON) map.jumpTo({ zoom });

        const rect = host.getBoundingClientRect();
        const target = {
          x: particle.screen.x - rect.left,
          y: particle.screen.y - rect.top,
        };
        const afterZoom = measureAnchorFrame(frameOverride);
        if (!afterZoom) return;
        const correction = detailedEarthAnchorCorrection(afterZoom.projected, target);
        if (Math.hypot(correction.x, correction.y) > CALIBRATION_ANCHOR_EPSILON_PX) {
          const centre = map.project(map.getCenter());
          map.jumpTo({
            center: map.unproject([centre.x + correction.x, centre.y + correction.y]),
          });
        }

        const settled = measureAnchorFrame(frameOverride);
        if (!settled) return;
        const anchorError = Math.hypot(
          settled.projected.x - target.x,
          settled.projected.y - target.y,
        );
        const scaleError = Math.abs(settled.pxPerDegreeLat / particle.pxPerDegreeLat - 1);
        if (
          anchorError <= CALIBRATION_ANCHOR_EPSILON_PX
          && scaleError <= CALIBRATION_SCALE_ERROR_EPSILON
        ) break;
      }
      publishAnchorFrame(frameOverride);
    };

    const publishSurfaceGeometry = (): DetailedEarthSurfaceGeometry => {
      const hostRect = host.getBoundingClientRect();
      const canvasRect = canvas.getBoundingClientRect();
      const geometry = {
        hostWidth: hostRect.width,
        hostHeight: hostRect.height,
        canvasCssWidth: canvasRect.width,
        canvasCssHeight: canvasRect.height,
        drawingBufferWidth: canvas.width,
        drawingBufferHeight: canvas.height,
        devicePixelRatio: window.devicePixelRatio || 1,
      };
      host.dataset.mapHostRect = [hostRect.left, hostRect.top, hostRect.width, hostRect.height]
        .map((value) => value.toFixed(2)).join(",");
      host.dataset.mapCanvasCss = `${canvasRect.width.toFixed(2)}x${canvasRect.height.toFixed(2)}`;
      host.dataset.mapCanvasBuffer = `${canvas.width}x${canvas.height}`;
      return geometry;
    };

    const publishPaintQuadrants = (geometry: DetailedEarthSurfaceGeometry) => {
      const points = [
        [geometry.canvasCssWidth * 0.25, geometry.canvasCssHeight * 0.25],
        [geometry.canvasCssWidth * 0.75, geometry.canvasCssHeight * 0.25],
        [geometry.canvasCssWidth * 0.25, geometry.canvasCssHeight * 0.75],
        [geometry.canvasCssWidth * 0.75, geometry.canvasCssHeight * 0.75],
      ] as const;
      try {
        // Read the framebuffer during MapLibre's own `render` event. Unlike a
        // feature query, these four samples prove that the current drawing
        // buffer actually contains visible pixels in every viewport quadrant.
        // This is diagnostic evidence only; readiness is still the renderer's
        // post-sync render revision below.
        const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
        if (!gl || geometry.canvasCssWidth <= 0 || geometry.canvasCssHeight <= 0) {
          host.dataset.mapPaintQuadrants = "unavailable";
          return;
        }
        const pixel = new Uint8Array(4);
        host.dataset.mapPaintQuadrants = points.map(([cssX, cssY]) => {
          const x = Math.max(0, Math.min(
            canvas.width - 1,
            Math.floor((cssX / geometry.canvasCssWidth) * canvas.width),
          ));
          const yFromTop = Math.max(0, Math.min(
            canvas.height - 1,
            Math.floor((cssY / geometry.canvasCssHeight) * canvas.height),
          ));
          const y = canvas.height - 1 - yFromTop;
          gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          return Array.from(pixel).join(":");
        }).join(",");
      } catch {
        host.dataset.mapPaintQuadrants = "unavailable";
      }
    };

    const cameraSnapshot = (): DetailedEarthRevealCameraSnapshot => {
      const center = map.getCenter();
      return {
        longitude: center.lng,
        latitude: center.lat,
        zoom: map.getZoom(),
        bearing: map.getBearing(),
        pitch: map.getPitch(),
      };
    };

    const cameraSignature = (camera = cameraSnapshot()) => [
      camera.longitude,
      camera.latitude,
      camera.zoom,
      camera.bearing,
      camera.pitch,
    ].map((value) => value.toFixed(6)).join(",");

    const restoreRevealCamera = (camera: DetailedEarthRevealCameraSnapshot) => {
      map.jumpTo({
        center: [camera.longitude, camera.latitude],
        zoom: camera.zoom,
        bearing: camera.bearing,
        pitch: camera.pitch,
      });
    };

    const syncRevealSurface = (reason: "load" | "stage" | "resize-observer") => {
      if (removed || !initialLoadSettled) return;
      const stage = diveStageRef.current;
      const geometry = publishSurfaceGeometry();
      const action = resolveDetailedEarthRevealSyncAction(geometry, lastHostGeometry);
      lastHostGeometry = { hostWidth: geometry.hostWidth, hostHeight: geometry.hostHeight };
      const revision = ++revealRevision;
      host.dataset.mapRevealRevision = String(revision);
      host.dataset.mapRevealReason = reason;
      host.dataset.mapRevealSync = action;
      const cameraBefore = cameraSnapshot();
      host.dataset.mapRevealCameraBefore = cameraSignature(cameraBefore);
      delete host.dataset.mapRevealStage;
      delete host.dataset.mapPostSyncRenderRevision;

      // A load/style/render bootstrap only proves resources and calibration are
      // available. The reveal gate is a LATER MapLibre render after current
      // geometry has been synchronized. Record the current render counter so a
      // listener installed from inside a `render` callback can never consume
      // that same pre-sync frame (the P1 caught on 80449f9). Newer revisions
      // simply replace this pending commit, so stale callbacks cannot publish.
      pendingRevealCommit = {
        revision,
        stage,
        afterRenderCount: renderCount,
        intentRevision: cameraIntentRevisionRef.current,
        cameraBefore,
        reason,
      };

      if (action === "resize") {
        host.dataset.mapProgrammaticResizeRevision = String(revision);
        map.resize();
      }
      // Resize normally schedules a frame, but the reveal invariant is "a
      // current post-sync render happened", not "this MapLibre version happens
      // to repaint after resize". triggerRepaint is the supported invalidation
      // for both branches and does not alter camera or input ownership.
      map.triggerRepaint();
    };
    revealSyncRef.current = syncRevealSurface;

    map.on("style.load", () => {
      if (removed) return;
      appliedJourneyOverlayRevision = null;
      loadedJourneyOverlayRevision = null;
      paintedJourneyOverlayRevision = null;
      host.dataset.journeyOverlayReady = "false";
      applyMapLanguage(map, languageRef.current);
      if (!initialLoadSettled) {
        // Do not add the Journey source before the initial style has been
        // acknowledged. Adding a source from inside the first style.load edge
        // makes MapLibre's own load/isStyleLoaded barrier include that newly
        // introduced source, which can strand the hidden prewarm surface at
        // `mounted`. Settle the already-loaded base style first; that routine
        // installs this exact Journey revision and still gates visual readiness
        // on a later source-loaded + painted render.
        settleInitialLoad?.();
        return;
      }
      const overlayReady = syncJourneyOverlay();
      if (overlayReady) syncRevealSurface("stage");
    });

    map.on("sourcedata", (event) => {
      if (
        removed
        || event.sourceId !== JOURNEY_OVERLAY_SOURCE_ID
        || event.isSourceLoaded !== true
        || appliedJourneyOverlayRevision !== journeyOverlayRef.current.revision
      ) return;
      loadedJourneyOverlayRevision = appliedJourneyOverlayRevision;
      // Source completion itself is not enough to reveal. Ask MapLibre for one
      // later render so the exact loaded revision is proven on the framebuffer.
      map.triggerRepaint();
    });

    map.on("render", () => {
      renderCount += 1;
      renderEventObserved = true;
      host.dataset.mapRenderCount = String(renderCount);
      // MapLibre can render a valid style frame before its one-shot `load`
      // event under a hidden/prewarmed surface. Use that renderer event only
      // to bootstrap initial synchronization; reveal still waits for a LATER
      // post-sync render revision.
      if (!initialLoadSettled && map.isStyleLoaded()) settleInitialLoad?.();

      const overlayRevisionAtRenderStart = appliedJourneyOverlayRevision;
      if (appliedJourneyOverlayRevision !== journeyOverlayRef.current.revision) {
        syncJourneyOverlay();
      } else {
        // GeoJSON source completion can race the sourcedata listener on fast QA
        // styles. Reconcile MapLibre's current source truth on its render event
        // instead of requiring that one event edge to have been observed. This
        // keeps the same loaded-before-painted invariant without timer/retry
        // liveness or revealing an unready Journey revision.
        if (
          loadedJourneyOverlayRevision !== journeyOverlayRef.current.revision
          && map.getSource(JOURNEY_OVERLAY_SOURCE_ID)
          && map.isSourceLoaded(JOURNEY_OVERLAY_SOURCE_ID)
        ) loadedJourneyOverlayRevision = journeyOverlayRef.current.revision;
        if (
          overlayRevisionAtRenderStart === journeyOverlayRef.current.revision
          && loadedJourneyOverlayRevision === journeyOverlayRef.current.revision
          && paintedJourneyOverlayRevision !== journeyOverlayRef.current.revision
        ) {
          paintedJourneyOverlayRevision = journeyOverlayRef.current.revision;
          host.dataset.journeyOverlayReady = "true";
          host.dataset.journeyOverlayPaintedRevision = paintedJourneyOverlayRevision;
        }
      }
      const pending = pendingRevealCommit;
      if (
        pending
        && !removed
        && paintedJourneyOverlayRevision === journeyOverlayRef.current.revision
        && pending.revision === revealRevision
        && canCommitDetailedEarthReveal(renderCount, pending.afterRenderCount)
      ) {
        const cameraAfter = cameraSnapshot();
        const cameraCommit = resolveDetailedEarthRevealCameraCommit(
          pending.intentRevision,
          cameraIntentRevisionRef.current,
          pending.cameraBefore,
          cameraAfter,
        );
        if (cameraCommit === "stale") {
          pendingRevealCommit = null;
          // A newer particle/focus camera intent won while synchronization was
          // in flight. Re-arm readiness from that newest camera rather than
          // restoring stale geography or stranding the blend.
          syncRevealSurface(pending.reason);
          return;
        }
        if (cameraCommit === "restore") {
          restoreRevealCamera(pending.cameraBefore);
          pendingRevealCommit = { ...pending, afterRenderCount: renderCount };
          map.triggerRepaint();
          return;
        }
        pendingRevealCommit = null;
        const committedGeometry = publishSurfaceGeometry();
        publishPaintQuadrants(committedGeometry);
        host.dataset.mapPostSyncRenderRevision = String(pending.revision);
        host.dataset.mapRevealStage = pending.stage;
        host.dataset.mapRevealCameraAfter = cameraSignature(cameraAfter);
        publishAnchorFrame();
        publishReadiness(fullySettled ? "fully-settled" : "visual-ready");
      }
    });
    map.on("resize", () => {
      resizeCount += 1;
      host.dataset.mapResizeCount = String(resizeCount);
    });
    map.on("idle", () => {
      idleCount += 1;
      fullySettled = true;
      host.dataset.mapIdleCount = String(idleCount);
      if (host.dataset.mapPostSyncRenderRevision === host.dataset.mapRevealRevision) {
        publishReadiness("fully-settled");
      }
    });

    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => {
        if (initialLoadSettled) syncRevealSurface("resize-observer");
      });
      resizeObserver.observe(host);
    }

    settleInitialLoad = () => {
      if (removed || initialLoadSettled) return;
      // Raster fallback remains Mercator; vector styles use the globe so a
      // polar focus is not trapped by the flat-map viewport.
      if (useGlobeProjection()) map.setProjection({ type: "globe" });
      applyMapLanguage(map, languageRef.current);
      // No second focus flight at handoff: the mount frame already IS the focus.
      initialLoadSettled = true;
      host.dataset.mapReady = "true";
      host.dataset.mapLoadCount = "1";
      host.dataset.mapLoadSource = loadEventObserved
        ? "load-event"
        : renderEventObserved
          ? "render-bootstrap"
          : "style-loaded-recovery";
      // The personal Journey is part of detail readiness, not decoration that
      // may pop in after the basemap. Install the current authorized revision
      // before calibrating and arming the post-sync reveal frame.
      syncJourneyOverlay();
      calibrateToParticle();
      syncRevealSurface("load");
    };
    // If the fast style finished before the event callback was fully wired,
    // recover from current MapLibre style truth instead of stranding prewarm.
    // This is an event-state reconciliation, not polling or a delay.
    if (loadEventObserved || map.isStyleLoaded()) settleInitialLoad();

    calibrateRef.current = () => calibrateToParticle();
    if (calibrationHandleRef) {
      calibrationHandleRef.current = (frame, mode = "sync") => calibrateToParticle(frame, mode);
    }
    map.on("move", (event) => {
      // A multi-frame flyTo/fitBounds belongs to one explicit focus intent,
      // but every animation frame is still newer than a reveal sync armed on
      // an earlier intermediate camera. Detail-owned gestures are explicit
      // camera intent too; MapLibre exposes their originating DOM event while
      // renderer-only resize/repaint drift has no originalEvent.
      if (
        focusFlightActiveRef.current
        || (diveOwnerRef.current === "detail" && Boolean(event.originalEvent))
      ) cameraIntentRevisionRef.current += 1;
      publishAnchorFrame();
      publishCameraObservation();
    });
    map.on("moveend", () => {
      // `map.resize()` can emit moveend while an explicit flyTo/fitBounds is
      // still easing. Only retire focus-flight ownership when MapLibre itself
      // says that ease has actually completed or been interrupted.
      if (!map.isMoving()) focusFlightActiveRef.current = false;
    });

    map.on("click", (event) => {
      // Resolve Route Point identity from the current authorized overlay and
      // projection first. Invisible 44px hit circles may overlap; letting
      // queryRenderedFeatures choose the first rendered feature would make
      // layer order, rather than pointer proximity, decide which Point opens.
      // The projection resolver deterministically picks the nearest disclosed
      // Point while preserving the same touch-safe radius.
      let routePointHit = pickDetailedEarthJourneyRoutePointHit(
        journeyOverlayRef.current,
        event.point,
        (coordinates) => map.project(coordinates),
      );
      // Retain the rendered-feature lookup only as a bounded fallback for a
      // future style/projection edge where MapLibre reports a hit that cannot
      // be reproduced from the current projected source coordinates.
      if (!routePointHit && map.getLayer(JOURNEY_OVERLAY_HIT_LAYER_ID)) {
        const [journeyHit] = map.queryRenderedFeatures(event.point, {
          layers: [JOURNEY_OVERLAY_HIT_LAYER_ID],
        });
        const journeyId = journeyHit?.properties?.journeyId;
        const routePointId = journeyHit?.properties?.routePointId;
        if (typeof journeyId === "string" && typeof routePointId === "string") {
          routePointHit = { journeyId, routePointId };
        }
      }
      if (routePointHit && onJourneyRoutePointActivateRef.current) {
        onJourneyRoutePointActivateRef.current(routePointHit.journeyId, routePointHit.routePointId);
        return;
      }
      if (!onPickRef.current) return;
      onPickRef.current({
        latitude: event.lngLat.lat,
        longitude: event.lngLat.lng,
      });
    });
    map.on("zoomend", () => {
      if (
        !initialLoadSettled
        || diveOwnerRef.current !== "detail"
        || overviewRequestedRef.current
        || !shouldReturnToParticleEarth(map.getZoom())
      ) return;
      overviewRequestedRef.current = true;
      onOverviewRequestRef.current?.();
    });
    map.on("error", (event) => {
      host.dataset.mapError = event.error?.message ?? "map-error";
    });

    return () => {
      removed = true;
      revealRevision += 1;
      resizeObserver?.disconnect();
      mapRef.current = null;
      calibrateRef.current = null;
      revealSyncRef.current = null;
      syncJourneyOverlayRef.current = null;
      if (calibrationHandleRef) calibrationHandleRef.current = null;
      focusFlightActiveRef.current = false;
      map.remove();
      if (import.meta.env.DEV && typeof window !== "undefined") {
        const debugWindow = window as Window & {
          __detailedEarthMapRemovalCount?: number;
          __detailedEarthMapProject?: (longitude: number, latitude: number) => { x: number; y: number };
        };
        if (debugWindow.__detailedEarthMapProject === debugProject) delete debugWindow.__detailedEarthMapProject;
        debugWindow.__detailedEarthMapRemovalCount = (debugWindow.__detailedEarthMapRemovalCount ?? 0) + 1;
      }
    };
  }, []);

  useLayoutEffect(() => {
    // The prewarmed map may have correct dimensions and still have no committed
    // frame for the now-visible surface. Synchronize on the reveal edge itself;
    // the parent keeps the blend hidden until this stage's post-sync render is
    // published through data-map-reveal-stage.
    if (diveStage === "blending") revealSyncRef.current?.("stage");
  }, [diveStage]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    applyMapLanguage(map, language);
  }, [language]);

  useEffect(() => {
    const overlayReady = syncJourneyOverlayRef.current?.() ?? false;
    if (overlayReady && diveStage !== "particle") revealSyncRef.current?.("stage");
  }, [journeyOverlay.revision]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || diveOwnerRef.current !== "detail") return;
    // During prewarm/blending the particle camera is the only authority and the
    // hidden detail map follows it exclusively through handoff calibration.
    // Once detail owns the camera, later *real* focus changes may use the map's
    // normal fly/fit choreography. The ownership commit itself is calibrated,
    // not re-focused.
    // Starting a replacement flyTo/fitBounds synchronously ends the previous
    // MapLibre flight before arming the replacement. Clear the old ownership
    // first so that previous flight's moveend cannot retire the new flight.
    focusFlightActiveRef.current = false;
    cameraIntentRevisionRef.current += 1;
    const focusFlightStarted = applyDetailedEarthFocus(
      map,
      focusPoint,
      focusRoute,
      getDetailedEarthFocusDuration(focusFlightProfile),
    );
    focusFlightActiveRef.current = focusFlightStarted;
  }, [focusFlightProfile, focusPoint, focusRevision, focusRoute]);

  // Per-frame particle following goes through `calibrationHandleRef` in the
  // same publish event. This effect is only a structural fallback for mount /
  // stage / focus changes, avoiding a duplicate solve from React prop cadence.
  useEffect(() => {
    if (diveOwner === "detail") return;
    calibrateRef.current?.();
  }, [diveOwner, diveStage, focusPoint, focusRoute]);

  // Stage and interaction owner are different state (#252 section 4): a
  // prewarmed or blending map is on the screen budget but must not take the
  // gestures the particle globe is still answering.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const owns = diveOwner === "detail";
    overviewRequestedRef.current = false;
    if (owns) {
      // The alignment gate already committed the exact imperative particle
      // frame. Do not recalibrate from React props here: that value can be one
      // render behind the frame that actually passed the gate and would move an
      // already-aligned map. Only cancel any leftover MapLibre continuation
      // before user handlers wake.
      map.stop();
      const center = map.getCenter();
      const host = hostRef.current;
      if (host) host.dataset.mapCameraObservation = `${center.lng},${center.lat}`;
      onCameraObservationRef.current?.({
        latitude: center.lat,
        longitude: center.lng,
      });
    }
    const canvas = map.getCanvas();
    if (owns) {
      // `interactive:false` is intentional during prewarm, but MapLibre also
      // makes the canvas tabindex=-1 and leaves boxZoom/touchPitch disabled.
      // Restore the complete ordinary interactive contract only after detail
      // owns input, including sequential keyboard reachability.
      canvas.tabIndex = 0;
      map.boxZoom.enable();
      map.dragPan.enable(DETAILED_EARTH_DRAG_PAN_OPTIONS);
      map.dragRotate.enable();
      map.scrollZoom.enable();
      map.touchZoomRotate.enable();
      map.touchZoomRotate.enableRotation();
      map.touchPitch.enable();
      map.keyboard.enable();
      map.doubleClickZoom.enable();
    } else {
      canvas.tabIndex = -1;
      map.boxZoom.disable();
      map.dragPan.disable();
      map.dragRotate.disable();
      map.scrollZoom.disable();
      map.touchZoomRotate.disable();
      map.touchPitch.disable();
      map.keyboard.disable();
      map.doubleClickZoom.disable();
    }
  }, [diveOwner]);

  useEffect(() => {
    const canvas = mapRef.current?.getCanvas();
    if (canvas) canvas.style.cursor = onGlobePointPick ? "crosshair" : "grab";
  }, [onGlobePointPick]);

  const ownsDetailInput = diveOwner === "detail";

  return (
    <div
      ref={hostRef}
      className="detailed-earth-map"
      data-map-provider="configurable-vector"
      data-dive-stage={diveStage}
      data-dive-owner={diveOwner}
      data-map-language={language}
      // The renderer prewarms while the particle globe still owns input. Keep
      // the required attribution visible, but remove the whole MapLibre subtree
      // from pointer/keyboard/accessibility ownership until the Dive commits.
      // This is the shared owner boundary, so ordinary blending and focus-mode
      // suspension use the same rule rather than two CSS/focus exceptions.
      inert={!ownsDetailInput || undefined}
      aria-hidden={!ownsDetailInput || undefined}
      data-point-pick={onGlobePointPick ? "true" : "false"}
      data-primary-drag="pan"
      data-alternate-drag="right-mouse-or-ctrl-rotate"
      role="application"
      aria-label="可深度缩放的真实地球地图"
    />
  );
}
