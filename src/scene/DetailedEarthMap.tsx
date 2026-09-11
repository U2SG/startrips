import { useEffect, useRef, type MutableRefObject } from "react";
import {
  AttributionControl,
  Map as MapLibreMap,
  NavigationControl,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { JourneyRoute } from "../journey/types";
import {
  createDetailedEarthLabelExpression,
  DETAILED_EARTH_DRAG_PAN_OPTIONS,
  getDetailedEarthRouteFrame,
  getDetailedEarthFocusDuration,
  getEarthDiveHandoffFrame,
  detailedEarthAnchorCorrection,
  solveDetailedEarthHandoffZoom,
  type ParticleAnchorFrame,
  DETAILED_EARTH_INITIAL_ZOOM,
  DETAILED_EARTH_MAX_PITCH,
  DETAILED_EARTH_MAX_ZOOM,
  DETAILED_EARTH_MIN_ZOOM,
  DETAILED_EARTH_PITCH_SPEED,
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
import type { DetailReadiness, EarthDiveOwner, EarthDiveStage } from "./earthDive";
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
  focusRevision?: number;
  focusFlightProfile?: DetailedEarthFocusFlightProfile;
  language: DetailedEarthLanguage;
  onGlobePointPick?: (point: { latitude: number; longitude: number }) => void;
  onOverviewRequest?: () => void;
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
    return;
  }
  const target = routeFrame?.center
    ?? (focusPoint ? [focusPoint.lon, focusPoint.lat] as [number, number] : null);
  if (!target) return;
  map.flyTo({
    center: target,
    zoom: Math.max(map.getZoom(), DETAILED_EARTH_INITIAL_ZOOM),
    duration,
    essential: true,
  });
}

export default function DetailedEarthMap({
  diveStage = "detail",
  diveOwner = "detail",
  diveSnapshot = { level: "local", zoom: Number.NaN, localProgress: 1 },
  particleFrame = null,
  focusPoint,
  focusRoute,
  focusRevision = 0,
  focusFlightProfile,
  language,
  onGlobePointPick,
  onOverviewRequest,
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
  const languageRef = useRef(language);
  const focusPointRef = useRef(focusPoint);
  const focusRouteRef = useRef(focusRoute);
  const onPickRef = useRef(onGlobePointPick);
  const onOverviewRequestRef = useRef(onOverviewRequest);
  const onReadinessChangeRef = useRef(onReadinessChange);
  const diveStageRef = useRef(diveStage);
  const diveOwnerRef = useRef(diveOwner);
  const diveSnapshotRef = useRef(diveSnapshot);
  const particleFrameRef = useRef(particleFrame);
  diveStageRef.current = diveStage;
  diveOwnerRef.current = diveOwner;
  diveSnapshotRef.current = diveSnapshot;
  particleFrameRef.current = particleFrame;
  languageRef.current = language;
  focusPointRef.current = focusPoint;
  focusRouteRef.current = focusRoute;
  onPickRef.current = onGlobePointPick;
  onOverviewRequestRef.current = onOverviewRequest;
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
    mapRef.current = map;
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

    map.on("load", () => {
      // Raster fallback remains Mercator; vector styles use the globe so a
      // polar focus is not trapped by the flat-map viewport.
      if (useGlobeProjection()) map.setProjection({ type: "globe" });
      applyMapLanguage(map, languageRef.current);
      // No second focus flight at handoff: the mount frame already IS the focus.
      initialLoadSettled = true;
      host.dataset.mapReady = "true";
      // The style is parsed and the handoff frame can be drawn. This is the
      // blend gate, and it is an event from the renderer rather than a timer.
      // Calibrate BEFORE reporting the blend gate: the surface the Dive is
      // allowed to reveal is a surface already standing where the particle
      // Earth stands.
      calibrateToParticle();
      publishReadiness("visual-ready");
      publishAnchorFrame();
      map.once("idle", () => publishReadiness("fully-settled"));
    });

    calibrateRef.current = () => calibrateToParticle();
    if (calibrationHandleRef) {
      calibrationHandleRef.current = (frame, mode = "sync") => calibrateToParticle(frame, mode);
    }
    map.on("move", () => publishAnchorFrame());

    map.on("click", (event) => {
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
      mapRef.current = null;
      calibrateRef.current = null;
      if (calibrationHandleRef) calibrationHandleRef.current = null;
      map.remove();
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    applyMapLanguage(map, language);
  }, [language]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || diveOwnerRef.current !== "detail") return;
    // During prewarm/blending the particle camera is the only authority and the
    // hidden detail map follows it exclusively through handoff calibration.
    // Once detail owns the camera, later *real* focus changes may use the map's
    // normal fly/fit choreography. The ownership commit itself is calibrated,
    // not re-focused.
    applyDetailedEarthFocus(
      map,
      focusPoint,
      focusRoute,
      getDetailedEarthFocusDuration(focusFlightProfile),
    );
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
