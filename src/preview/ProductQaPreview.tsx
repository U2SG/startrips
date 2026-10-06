import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StartripsRecoverySurface } from "../brand/StartripsRecoverySurface";
import type { StartripsRecoveryKind } from "../brand/recoverySurfaces";
import { StartripsBrandLoader } from "../brand/StartripsBrandMark";
import { LivingAtlasApp } from "../journey/LivingAtlasApp";
import { JourneyComposer } from "../journey/JourneyComposer";
import { JourneyStory } from "../journey/JourneyStory";
import { JourneyBook3d } from "../journey/JourneyBook3d";
import { JourneyPlaybackOverlay } from "../journey/JourneyPlaybackOverlay";
import { resolveSuggestedRouteDecision, toJourneyRoutes } from "../journey/journeyModel";
import {
  buildPlaybackSteps,
  playbackCameraTargetKey,
  playbackMediaForPoint,
  type PlaybackCameraTarget,
  type PlaybackStep,
} from "../journey/journeyPlayback";
import { deriveJourneyStaySummaries, journeyOverviewRoutePointIds } from "../journey/journeyModel";
import type { JourneySaveResult } from "../journey/journeySaveRecovery";
import { PLAYBACK_INITIAL_TEMPO } from "../journey/useJourneyPlaybackDirector";
import type { PlaybackTempo } from "../journey/journeyPlaybackPlan";
import type { MediaReadState } from "../journey/mediaReadRefresh";
import {
  prepareQuickRecapPlayback,
  quickRecapStepDurationMs,
} from "../journey/quickRecapPlayback";
import type { Journey, RouteProvenanceTier, RouteSegmentRecord } from "../journey/types";
import { globeQaRoutes } from "./qaRoutes";
import {
  LivingAtlasGlobe,
  LivingAtlasGlobeControls,
  usePersistentEarth,
  type LivingAtlasGlobeProps,
} from "../scene/LivingAtlasGlobe";

const qaState = new URLSearchParams(window.location.search).get("qaState");

const appQaPickPoints = [
  { latitude: 37.76942, longitude: -122.48621 },
  { latitude: 34.01129, longitude: -118.49231 },
  { latitude: 47.60621, longitude: -122.33207 },
];

function LivingAtlasQaGlobe({
  onGlobePointPick,
  onJourneyRoutePointActivate,
  journeyRoutes,
  activeJourneyRouteId,
  focusPoint,
  focusRoute,
  focusRevision,
  focusColor,
}: LivingAtlasGlobeProps) {
  const [pickIndex, setPickIndex] = useState(0);
  const draftRoute = journeyRoutes.find((route) => route.id === "draft-route-preview") ?? null;
  const qaParams = new URLSearchParams(window.location.search);
  const routePointContextQa = qaParams.get("qaRoutePointContext") === "1";
  const spatialHandoffQa = qaParams.get("qaSpatialHandoff") === "1";
  return (
    <div className="living-atlas__qa-globe">
      {onGlobePointPick ? (
        <button
          type="button"
          data-qa-app-globe-point-pick
          onClick={() => {
            const point = appQaPickPoints[pickIndex % appQaPickPoints.length];
            setPickIndex((current) => current + 1);
            onGlobePointPick(point);
          }}
          style={{ position: "fixed", zIndex: 230, left: 12, bottom: 12 }}
        >QA 地球点击</button>
      ) : null}
      {routePointContextQa ? journeyRoutes.flatMap((route) => route.points.flatMap((point, index) => (
        point.id ? (
          <button
            key={`${route.id}:${point.id}`}
            type="button"
            data-qa-route-point-context-activate={point.id}
            data-qa-route-point-index={index}
            onClick={() => onJourneyRoutePointActivate?.(route.id, point.id!)}
            style={{ position: "fixed", width: 1, height: 1, overflow: "hidden", opacity: 0 }}
          >{point.label ?? point.id}</button>
        ) : []
      ))) : null}
      {spatialHandoffQa ? (
        <svg
          data-qa-spatial-route-points
          viewBox="0 0 620 360"
          aria-hidden="true"
          style={{ position: "fixed", left: 90, top: 90, width: 620, height: 360, pointerEvents: "none", zIndex: 2 }}
        >
          {journeyRoutes.flatMap((route, routeIndex) => route.points.flatMap((point, pointIndex) => {
            if (!point.id) return [];
            // Keep the deterministic spatial seam honest for ST-081: distinct
            // Route Point records at the exact same canonical coordinates share
            // one geographic marker anchor while retaining distinct record IDs.
            const firstCoordinateIndex = route.points.findIndex((candidate) => (
              candidate.lat === point.lat && candidate.lon === point.lon
            ));
            return [
              <circle
                key={`spatial:${route.id}:${point.id}`}
                className="particle-earth-route__point"
                data-journey-route={route.id}
                data-route-point-id={point.id}
                cx={150 + (firstCoordinateIndex >= 0 ? firstCoordinateIndex : pointIndex) * 115 + routeIndex * 12}
                cy={150 + routeIndex * 54}
                r={7}
              />,
            ];
          }))}
        </svg>
      ) : null}
      <output
        data-qa-app-route-preview
        data-route-points={JSON.stringify(draftRoute?.points ?? [])}
        data-focus-color={focusColor ?? ""}
        style={{ position: "fixed", width: 1, height: 1, overflow: "hidden", opacity: 0 }}
      >{draftRoute?.points.length ?? 0}</output>
      {routePointContextQa ? (
        <output
          data-qa-route-point-context-focus
          data-focus-revision={focusRevision ?? 0}
          data-focus-point={focusPoint ? `${focusPoint.lat},${focusPoint.lon}` : ""}
          data-focus-route={focusRoute?.id ?? ""}
          data-active-route={activeJourneyRouteId ?? ""}
          style={{ position: "fixed", width: 1, height: 1, overflow: "hidden", opacity: 0 }}
        />
      ) : null}
    </div>
  );
}

/**
 * #252: the Semantic Earth Dive lane needs the REAL `LivingAtlasGlobe` on the
 * real persistent particle scene, because what it grades is the zoom-driven
 * handoff between them. The other globe fixtures either stub the globe
 * (`?qaState=living-atlas`) or mount the bare scene without the Atlas section
 * that publishes `data-earth-dive` (`?qaState=journey-routes`), so this is a
 * sibling fixture rather than a change to either.
 */
function EarthDiveQaPreview() {
  const persistentEarth = usePersistentEarth();
  const qaParams = new URLSearchParams(window.location.search);
  const [focusRevision, setFocusRevision] = useState(0);
  const [activeRouteIndex, setActiveRouteIndex] = useState(0);
  const [activatedRoutePoint, setActivatedRoutePoint] = useState("");
  const routeCandidateQa = qaParams.get("qaRouteCandidates") === "true";
  const [routeCandidateRecords, setRouteCandidateRecords] = useState<Record<string, RouteSegmentRecord[]>>({});
  const shareScope = qaParams.get("qaScope") === "share";
  const [shareRevoked, setShareRevoked] = useState(false);
  const [earthExperiencePolicy, setEarthExperiencePolicy] = useState<"default" | "particle-only">(
    qaParams.get("qaPolicy") === "particle-only" ? "particle-only" : "default",
  );
  const [qaReduceMotion, setQaReduceMotion] = useState(qaParams.get("qaMotion") !== "animate");
  useEffect(() => {
    persistentEarth.setStage("atlas");
    return () => persistentEarth.setStage("idle");
  }, [persistentEarth]);
  // The two focus shapes the product actually hands the globe, because the Dive
  // has to hold its anchor in both: a focused Route Point publishes a focus
  // point, while a focused Journey is owned by route fitting and publishes no
  // point at all - the branch whose anchor comes from the route frame.
  // Share/guest authorization owns the route list before either renderer sees it.
  // This fixture can revoke that upstream scope while Detail remains mounted so
  // browser QA proves stale GeoJSON and hit targets are removed at the source.
  const baseRoutes = routeCandidateQa ? globeQaRoutes.slice(2, 3) : globeQaRoutes;
  const authorizedRoutes = (shareScope
    ? (shareRevoked ? [] : baseRoutes.slice(0, 1))
    : baseRoutes).map((route) => routeCandidateQa ? {
      ...route,
      routeSegments: route.points.slice(0, -1).map((point, index) => (
        routeCandidateRecords[route.id]?.find((record) => record.fromRoutePointId === point.id
          && record.toRoutePointId === route.points[index + 1]?.id) ?? null
      )),
    } : route);
  const focusRoute = authorizedRoutes[activeRouteIndex] ?? authorizedRoutes[0] ?? null;
  const routePoint = focusRoute?.points[Math.min(1, focusRoute.points.length - 1)] ?? null;
  const routeFocus = qaParams.get("qaFocus") === "route";
  const requestedLat = Number(qaParams.get("qaFocusLat") ?? Number.NaN);
  const requestedLon = Number(qaParams.get("qaFocusLon") ?? Number.NaN);
  const focusPoint = routeFocus || !routePoint
    ? null
    : {
      lat: Number.isFinite(requestedLat) ? requestedLat : routePoint.lat,
      lon: Number.isFinite(requestedLon) ? requestedLon : routePoint.lon,
    };
  return (
    <main className="living-atlas" data-qa-earth-dive-focus={routeFocus ? "route" : "route-point"}>
      <div className="living-atlas__globe">
        <LivingAtlasGlobe
          focusPoint={focusPoint}
          focusRoute={routeFocus ? focusRoute : null}
          focusRevision={focusRevision}
          journeyRoutes={authorizedRoutes}
          routeEditingEnabled={routeCandidateQa}
          onRouteSegmentSaved={routeCandidateQa ? (journeyId, segment) => {
            setRouteCandidateRecords((current) => ({
              ...current,
              [journeyId]: [
                ...(current[journeyId] ?? []).filter((record) => record.sourceKey !== segment.sourceKey),
                segment,
              ],
            }));
          } : undefined}
          activeJourneyRouteId={focusRoute?.id ?? null}
          onJourneyRouteActivate={() => undefined}
          onJourneyRoutePointActivate={(journeyId, routePointId) => {
            setActivatedRoutePoint(`${journeyId}:${routePointId}`);
          }}
          earthExperiencePolicy={earthExperiencePolicy}
          reduceMotion={qaReduceMotion}
        />
      </div>
      {routePoint && focusRoute ? (
        <output
          data-qa-earth-dive-route-point
          data-journey-id={focusRoute.id}
          data-route-point-id={routePoint.id}
          data-route-point-lat={routePoint.lat}
          data-route-point-lon={routePoint.lon}
          style={{ position: "fixed", width: 1, height: 1, overflow: "hidden", opacity: 0 }}
        >{routePoint.label}</output>
      ) : null}
      <output
        data-qa-earth-dive-activated-route-point={activatedRoutePoint}
        style={{ position: "fixed", width: 1, height: 1, overflow: "hidden", opacity: 0 }}
      >{activatedRoutePoint}</output>
      {routeCandidateQa ? <output data-qa-route-segment-decision={routeCandidateRecords[focusRoute?.id ?? ""]?.[0]?.decision ?? "absent"}
        data-qa-route-shape-count={routeCandidateRecords[focusRoute?.id ?? ""]?.[0]?.shapePoints.length ?? 0}
        style={{ position: "fixed", width: 1, height: 1, overflow: "hidden", opacity: 0 }} /> : null}
      <div style={routeCandidateQa && !shareScope
        ? { position: "absolute", zIndex: 60, top: 0, right: 0, width: 660, height: 88 }
        : { display: "contents" }}>
        {shareScope ? (
          <>
            <output
              data-qa-earth-dive-scope={shareRevoked ? "revoked" : "authorized"}
              style={{ position: "fixed", width: 1, height: 1, overflow: "hidden", opacity: 0 }}
            >{shareRevoked ? "revoked" : "authorized"}</output>
            <button
              type="button"
              data-qa-earth-dive-scope-revoke
              onClick={() => {
                setActivatedRoutePoint("");
                setShareRevoked(true);
                setFocusRevision((revision) => revision + 1);
              }}
              style={{ position: "absolute", zIndex: 60, bottom: 48, left: 14 }}
            >QA 撤销共享范围</button>
          </>
        ) : (
          <>
            <button
              type="button"
              data-qa-earth-dive-route-switch="next"
              onClick={() => { setActiveRouteIndex(1); setFocusRevision((revision) => revision + 1); }}
              style={{ position: "absolute", zIndex: 60, bottom: 48, left: 14 }}
            >QA 切换旅程</button>
            <button
              type="button"
              data-qa-earth-dive-route-switch="first"
              onClick={() => { setActiveRouteIndex(0); setFocusRevision((revision) => revision + 1); }}
              style={{ position: "absolute", zIndex: 60, bottom: 48, left: 130 }}
            >QA 返回首旅程</button>
          </>
        )}
        <button
          type="button"
          data-qa-earth-dive-refocus
          onClick={() => setFocusRevision((revision) => revision + 1)}
          style={{ position: "absolute", zIndex: 60, bottom: 14, left: 14 }}
        >QA 重新对焦</button>
        <button
          type="button"
          data-qa-earth-policy="particle-only"
          onClick={() => setEarthExperiencePolicy("particle-only")}
          style={{ position: "absolute", zIndex: 60, bottom: 14, left: 140 }}
        >QA 粒子地球</button>
        <button
          type="button"
          data-qa-earth-policy="default"
          onClick={() => setEarthExperiencePolicy("default")}
          style={{ position: "absolute", zIndex: 60, bottom: 14, left: 250 }}
        >QA 默认地球</button>
        <button
          type="button"
          data-qa-earth-motion-toggle
          onClick={() => setQaReduceMotion((current) => !current)}
          style={{ position: "absolute", zIndex: 60, bottom: 14, left: 360 }}
        >QA 动效切换</button>
        <button
          type="button"
          data-qa-earth-quality="low"
          onClick={() => persistentEarth.setStage("handoff")}
          style={{ position: "absolute", zIndex: 60, bottom: 14, left: 470 }}
        >QA 低质量</button>
        <button
          type="button"
          data-qa-earth-quality="high"
          onClick={() => persistentEarth.setStage("atlas")}
          style={{ position: "absolute", zIndex: 60, bottom: 14, left: 570 }}
        >QA 高质量</button>
      </div>
    </main>
  );
}

export function LivingAtlasGlobeChromeQa(props: LivingAtlasGlobeProps) {
  const qaParams = new URLSearchParams(window.location.search);
  const qaRoundTrip = qaParams.get("qaMode") === "globe-chrome";
  const routePointContextQa = qaParams.get("qaRoutePointContext") === "1";
  return (
    <>
      <LivingAtlasGlobe {...props} />
      {qaRoundTrip ? props.journeyRoutes.flatMap((route) => route.points.flatMap((point) => (
        point.id ? (
          <button
            key={`globe-chrome:${route.id}:${point.id}`}
            type="button"
            data-qa-globe-route-point-activate={point.id}
            data-qa-globe-route-id={route.id}
            data-qa-route-point-context-activate={routePointContextQa ? point.id : undefined}
            aria-hidden="true"
            tabIndex={-1}
            onClick={() => props.onJourneyRoutePointActivate?.(route.id, point.id!)}
            style={{ position: "fixed", width: 1, height: 1, overflow: "hidden", opacity: 0, pointerEvents: "none" }}
          >{point.label ?? point.id}</button>
        ) : []
      ))) : null}
      {routePointContextQa ? (
        <output
          data-qa-route-point-context-focus
          data-focus-revision={props.focusRevision ?? 0}
          data-focus-point={props.focusPoint ? `${props.focusPoint.lat},${props.focusPoint.lon}` : ""}
          data-focus-route={props.focusRoute?.id ?? ""}
          data-active-route={props.activeJourneyRouteId ?? ""}
          style={{ position: "fixed", width: 1, height: 1, overflow: "hidden", opacity: 0 }}
        />
      ) : null}
    </>
  );
}

function LivingAtlasQaPreview() {
  // #253: the globe-focus chrome lane needs the real `LivingAtlasGlobe`, since
  // `.living-atlas-globe__controls` and the transient gesture hint live there.
  // #291's dedicated lane adds qaRoutePointContext=1 and intentionally keeps
  // the deterministic QA globe unless a real-pointer round explicitly asks for
  // the production scene. That round must also claim the persistent Earth stage:
  // unlike AuthGateway, this QA preview renders LivingAtlasApp directly, so merely
  // swapping in the real Globe component leaves PersistentEarthProvider at idle.
  const params = new URLSearchParams(window.location.search);
  const globeChrome = params.get("qaMode") === "globe-chrome";
  const routePointContextQa = params.get("qaRoutePointContext") === "1";
  const realRoutePointScene = params.get("qaRealRoutePointScene") === "1";
  const earthExperiencePolicy = params.get("qaPolicy") === "particle-only" ? "particle-only" : "default";
  const persistentEarth = usePersistentEarth();
  useEffect(() => {
    if (!realRoutePointScene) return undefined;
    persistentEarth.setStage("atlas");
    return () => persistentEarth.setStage("idle");
  }, [persistentEarth, realRoutePointScene]);
  if (globeChrome && (!routePointContextQa || realRoutePointScene)) {
    return <LivingAtlasApp GlobeComponent={LivingAtlasGlobeChromeQa} earthExperiencePolicy={earthExperiencePolicy} />;
  }
  return <LivingAtlasApp GlobeComponent={LivingAtlasQaGlobe} earthExperiencePolicy={earthExperiencePolicy} />;
}

function LivingAtlasGlobeControlsQaPreview() {
  const [language, setLanguage] = useState<"zh" | "bilingual">("zh");
  const detailMode = new URLSearchParams(window.location.search).get("qaMode") !== "overview";
  return (
    <main className="living-atlas">
      <section
        className={`living-atlas-globe ${detailMode ? "is-detail" : "is-overview"} living-atlas-globe--controls-qa`}
        data-earth-mode={detailMode ? "detail" : "particle"}
        aria-label={detailMode ? "高精度地球地图控制 QA" : "粒子地球控制 QA"}
      >
        <LivingAtlasGlobeControls
          diveStage={detailMode ? "detail" : "particle"}
          detailLanguage={language}
          onDiveIntent={() => undefined}
          onDetailLanguageChange={setLanguage}
          onPickRequest={() => undefined}
        />
      </section>
    </main>
  );
}

function JourneyComposerQaPreview() {
  const qaMode = new URLSearchParams(window.location.search).get("qaMode");
  const journey = qaMode === "route-points"
    ? composerRoutePointsQaJourney
    : qaMode === "edit"
      ? storyQaJourney
      : undefined;
  const [open, setOpen] = useState(true);
  const [savedResult, setSavedResult] = useState<JourneySaveResult | null>(null);
  const savedProjection = useMemo(() => {
    if (!savedResult) return null;
    const savedJourney = savedResult.journey;
    const stays = deriveJourneyStaySummaries(savedJourney);
    return {
      overviewRoutePointIds: journeyOverviewRoutePointIds(savedJourney, stays),
      stays: stays.map((stay) => ({
        anchorRoutePointId: stay.anchorRoutePointId,
        routePointIds: stay.routePointIds,
        mediaAssetIds: stay.mediaAssetIds,
      })),
      playback: buildPlaybackSteps(savedJourney).flatMap<{
        kind: "stop" | "media";
        pointIndex: number;
        routePointId: string | null;
        assetId?: string | null;
        assetRoutePointId?: string | null;
      }>((step) => {
        if (step.kind === "stop") {
          return [{
            kind: step.kind,
            pointIndex: step.pointIndex,
            routePointId: savedJourney.routePoints[step.pointIndex]?.id ?? null,
          }];
        }
        if (step.kind === "media") {
          const asset = playbackMediaForPoint(savedJourney, step.pointIndex)[step.mediaIndex];
          return [{
            kind: step.kind,
            pointIndex: step.pointIndex,
            routePointId: savedJourney.routePoints[step.pointIndex]?.id ?? null,
            assetId: asset?.id ?? null,
            assetRoutePointId: asset?.routePointId ?? null,
          }];
        }
        return [];
      }),
    };
  }, [savedResult]);
  return (
    <main className="living-atlas">
      <div className="living-atlas__globe journey-story-qa__backdrop" aria-hidden="true" />
      <button type="button" data-qa-composer-reopen onClick={() => setOpen(true)}>重新打开编辑器</button>
      {savedProjection ? (
        <output
          hidden
          data-qa-composer-projection
          data-overview-route-point-ids={JSON.stringify(savedProjection.overviewRoutePointIds)}
          data-stays={JSON.stringify(savedProjection.stays)}
          data-playback={JSON.stringify(savedProjection.playback)}
        />
      ) : null}
      {open ? (
        <JourneyComposer
          open
          journey={savedResult?.journey ?? journey}
          onClose={() => setOpen(false)}
          onSaved={(result) => setSavedResult(result)}
          onGlobePickRequest={() => undefined}
        />
      ) : null}
    </main>
  );
}

const storyQaJourney: Journey = {
  id: "00000000-0000-4000-8000-000000000001",
  atlasId: "00000000-0000-4000-8000-000000000002",
  title: "穿过夜色的归途",
  startedOn: "2026-08-11",
  endedOn: null,
  note: "灯光沿着海岸慢慢退远，路途本身成为这一晚的记忆。",
  lightColor: "#77c8c2",
  revision: 1,
  createdByUserId: "00000000-0000-4000-8000-000000000003",
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
  routePoints: [{
    id: "00000000-0000-4000-8000-000000000004",
    journeyId: "00000000-0000-4000-8000-000000000001",
    sortOrder: 0,
    latitude: 1.290256,
    longitude: 103.851471,
    label: "National Gallery Singapore",
    isStop: true,
    occurredAt: null,
    createdAt: "2026-08-11T00:00:00.000Z",
  }],
  // Seeded so the deterministic QA can exercise the overview grid with
  // non-adjacent selection instead of only sequential navigation.
  media: [0, 1, 2].map((index) => ({
    id: `00000000-0000-4000-8000-00000000010${index}`,
    journeyId: "00000000-0000-4000-8000-000000000001",
    routePointId: null,
    storageDriver: "qa",
    storageKey: `qa/story-seed-${index}`,
    fileName: `seed-${index}.png`,
    mimeType: "image/png",
    bytes: 68,
    sortOrder: index,
    uploadedByUserId: "00000000-0000-4000-8000-000000000003",
    createdAt: "2026-08-11T00:00:00.000Z",
  })),
};

const storyQaDesktopChapterJourney: Journey = {
  ...storyQaJourney,
  routePoints: Array.from({ length: 20 }, (_, index) => ({
    ...storyQaJourney.routePoints[0],
    id: `00000000-0000-4000-8000-${String(index + 300).padStart(12, "0")}`,
    sortOrder: index,
    label: `途径点 ${String(index + 1).padStart(2, "0")} 海岸`,
    note: index === 16
      ? "从港湾回到山路，沿途的灯光一盏一盏亮起。这里是我最想记住的转弯。"
      : index === 3 ? "海风转凉时，我们沿着岸边慢慢走。" : null,
  })),
  media: [
    { ...storyQaJourney.media[2], sortOrder: 0, routePointId: "00000000-0000-4000-8000-000000000316" },
    { ...storyQaJourney.media[0], sortOrder: 1, routePointId: "00000000-0000-4000-8000-000000000303" },
  ],
};

const storyQaDesktopChapterNoMediaJourney: Journey = { ...storyQaDesktopChapterJourney, media: [] };

// #595: grouping changes the chapter, never who owns a note. Stop S has its own
// note and media; A (short note + media), B (note only) and C (long note, a
// photo then a video) are grouped under S; T is a Stop with media; V is an ungrouped
// note-only via (a transit beat, #514); U closes the Journey.
const GROUPED_NOTES_JOURNEY_ID = "00000000-0000-4000-8000-000000005950";
const GROUPED_NOTES_LONG_NOTE = Array.from({ length: 6 }, (_, index) => (
  `第 ${index + 1} 段：雨停以后我们沿着旧码头走到尽头，灯一盏一盏亮起来，风里有海盐和桂花的味道，谁都没有说话。`
)).join("\n");
const storyQaGroupedNotesJourney: Journey = {
  ...storyQaJourney,
  id: GROUPED_NOTES_JOURNEY_ID,
  title: "QA · GROUPED NOTES",
  note: "",
  coverMediaAssetId: null,
  routePoints: [
    { id: "nb-point-s", label: "STOP S 港湾", isStop: true, note: "停靠点 S 自己的感想：先在港湾坐了一会儿。" },
    { id: "nb-point-a", label: "A 石阶", isStop: false, stayAnchorRoutePointId: "nb-point-s", note: "A 的感想：石阶上的青苔。" },
    { id: "nb-point-b", label: "B 茶摊", isStop: false, stayAnchorRoutePointId: "nb-point-s", note: "B 只留下了一句话：茶摊老板记得我们。" },
    { id: "nb-point-c", label: "C 灯塔", isStop: false, stayAnchorRoutePointId: "nb-point-s", note: GROUPED_NOTES_LONG_NOTE },
    { id: "nb-point-t", label: "STOP T 山路", isStop: true, note: null },
    { id: "nb-point-v", label: "V 隧道口", isStop: false, note: "路过 V 时想到的：隧道里很凉。" },
    { id: "nb-point-u", label: "STOP U 终点", isStop: true, note: null },
  ].map((point, index) => ({
    stayAnchorRoutePointId: null,
    ...point,
    journeyId: GROUPED_NOTES_JOURNEY_ID,
    sortOrder: index,
    latitude: 22.28 + index * 0.012,
    longitude: 114.15 + index * 0.014,
    occurredAt: null,
    createdAt: "2026-10-04T00:00:00.000Z",
  })),
  media: [
    { id: "nb-media-s1", routePointId: "nb-point-s", mimeType: "image/jpeg" },
    { id: "nb-media-a1", routePointId: "nb-point-a", mimeType: "image/jpeg" },
    { id: "nb-media-c1", routePointId: "nb-point-c", mimeType: "image/jpeg" },
    { id: "nb-media-c2", routePointId: "nb-point-c", mimeType: "video/webm" },
    { id: "nb-media-t1", routePointId: "nb-point-t", mimeType: "image/jpeg" },
    { id: "nb-media-u1", routePointId: "nb-point-u", mimeType: "image/jpeg" },
  ].map((asset, index) => ({
    ...asset,
    journeyId: GROUPED_NOTES_JOURNEY_ID,
    storageDriver: "qa",
    storageKey: `qa/${asset.id}`,
    fileName: `${asset.id}.${asset.mimeType === "video/webm" ? "webm" : "jpg"}`,
    bytes: 68,
    sortOrder: index,
    uploadedByUserId: storyQaJourney.createdByUserId,
    createdAt: "2026-10-04T00:00:00.000Z",
  })),
};

const composerRoutePointsQaJourney: Journey = {
  ...storyQaJourney,
  title: "Composer Route Point QA",
  routePoints: Array.from({ length: 12 }, (_, index) => ({
    ...storyQaJourney.routePoints[0],
    id: `00000000-0000-4000-8000-${String(index + 20).padStart(12, "0")}`,
    sortOrder: index,
    latitude: index === 1 || index === 6 ? 22.543096 : 21.9 + index * 0.07,
    longitude: index === 1 || index === 6 ? 114.057865 : 113.8 + index * 0.08,
    label: index === 0 || index === 11
      ? "Shared label"
      : index === 1 || index === 6
        ? "Las Vegas"
        : index === 2
          ? "Record 03"
          : `Record ${String(index + 1).padStart(2, "0")}`,
    isStop: index % 3 === 0,
    note: index === 1
      ? "Record 02 local search note."
      : index === 6
        ? "Record 07 local search note."
        : index === 2
          ? "Record 03 keeps its note while moving."
          : null,
  })),
  media: storyQaJourney.media.map((media, index) => ({
    ...media,
    routePointId: index === 0
      ? "00000000-0000-4000-8000-000000000022"
      : index === 1
        ? "00000000-0000-4000-8000-000000000021"
        : index === 2
          ? "00000000-0000-4000-8000-000000000026"
          : null,
  })),
};

const storyQaRouteBoundaryJourney: Journey = {
  ...storyQaJourney,
  routePoints: [
    storyQaJourney.routePoints[0],
    {
      ...storyQaJourney.routePoints[0],
      id: "00000000-0000-4000-8000-000000000005",
      sortOrder: 1,
      latitude: 1.3008,
      longitude: 103.8394,
      label: "Fort Canning Park",
    },
  ],
  media: [
    { ...storyQaJourney.media[0], routePointId: storyQaJourney.routePoints[0].id },
    { ...storyQaJourney.media[1], routePointId: storyQaJourney.routePoints[0].id },
    {
      ...storyQaJourney.media[2],
      routePointId: "00000000-0000-4000-8000-000000000005",
    },
    {
      ...storyQaJourney.media[2],
      id: "00000000-0000-4000-8000-000000000103",
      storageKey: "qa/story-seed-3",
      fileName: "seed-3.png",
      sortOrder: 3,
      routePointId: "00000000-0000-4000-8000-000000000005",
    },
  ],
};

// #555: the Journey cover opening. The explicit cover is the LAST media of
// the second Route Point, so the opening, canonical entry 0 and the cover's own
// canonical entry are three different positions with three different contexts:
// entries are [cover(103) opening, 100, 101, 102, 103].
const storyQaCoverOpeningJourney: Journey = {
  ...storyQaRouteBoundaryJourney,
  coverMediaAssetId: "00000000-0000-4000-8000-000000000103",
  routePoints: storyQaRouteBoundaryJourney.routePoints.map((point, index) => ({
    ...point,
    note: index === 0 ? "美术馆台阶上的第一站。" : "福康宁山的树影里，我们停了很久。",
  })),
};

// #555: the same Journey with its cover as canonical entry 0 (the first media
// of the first Route Point), which is also what `journeyCover` falls back to
// without an explicit cover. Entries are [100 opening, 100, 101, 102, 103]: the
// step off the opening is a page change between two pages of one asset.
const storyQaCoverOpeningLeadingJourney: Journey = {
  ...storyQaCoverOpeningJourney,
  coverMediaAssetId: "00000000-0000-4000-8000-000000000100",
};

// #555: a cover sourced from Journey-level media (routePointId null). It sorts
// into the intro, so it is also canonical entry 0, in its Journey role rather
// than any Route Point's: entries are [104 opening, 104, 100, 101, 102, 103].
const storyQaCoverOpeningIntroJourney: Journey = {
  ...storyQaCoverOpeningJourney,
  coverMediaAssetId: "00000000-0000-4000-8000-000000000104",
  media: [
    ...storyQaCoverOpeningJourney.media,
    {
      ...storyQaCoverOpeningJourney.media[0],
      id: "00000000-0000-4000-8000-000000000104",
      storageKey: "qa/story-seed-4",
      fileName: "seed-4.png",
      sortOrder: 4,
      routePointId: null,
    },
  ],
};

const STORY_QA_MIXED_VIDEO_ASSET_ID = "00000000-0000-4000-8000-000000000152";
const storyQaMixedJourney: Journey = {
  ...storyQaJourney,
  media: storyQaJourney.media.map((asset, index) => index === 1 ? {
    ...asset,
    id: STORY_QA_MIXED_VIDEO_ASSET_ID,
    storageKey: "qa/story-mixed-video",
    fileName: "mixed-video.mp4",
    mimeType: "video/mp4",
  } : asset),
};

// #489 (ST-134). The handoff contract names image<->image, image<->video,
// video<->video and mixed aspect ratio as four separate classes, so the lane
// that proves them needs a sequence carrying two differently shaped transports
// and two adjacent photographs. `mixed-media` keeps its three-asset shape
// because the existing media-controls lane navigates it by position.
const STORY_QA_MIXED_VERTICAL_VIDEO_ASSET_ID = "00000000-0000-4000-8000-000000000153";
const STORY_QA_MIXED_SECOND_PHOTO_ASSET_ID = "00000000-0000-4000-8000-000000000103";
const storyQaMixedPairJourney: Journey = {
  ...storyQaJourney,
  media: [
    { ...storyQaJourney.media[0], sortOrder: 0 },
    {
      ...storyQaJourney.media[1],
      id: STORY_QA_MIXED_VIDEO_ASSET_ID,
      storageKey: "qa/story-mixed-video",
      fileName: "mixed-video.mp4",
      mimeType: "video/mp4",
      sortOrder: 1,
    },
    {
      ...storyQaJourney.media[1],
      id: STORY_QA_MIXED_VERTICAL_VIDEO_ASSET_ID,
      storageKey: "qa/story-mixed-video-vertical",
      fileName: "mixed-video-vertical.webm",
      mimeType: "video/webm",
      sortOrder: 2,
    },
    { ...storyQaJourney.media[2], sortOrder: 3 },
    {
      ...storyQaJourney.media[2],
      id: STORY_QA_MIXED_SECOND_PHOTO_ASSET_ID,
      storageKey: "qa/story-seed-3",
      fileName: "seed-3.png",
      sortOrder: 4,
    },
  ],
};

const QA_SOUNDTRACK_ASSET_ID = "00000000-0000-4000-8000-000000000900";
// #596: a second soundtrack identity, so the ducking lane can force a real
// re-key and remount rather than swapping the node behind React's back.
const QA_SOUNDTRACK_ALTERNATE_ID = "00000000-0000-4000-8000-000000000901";

// #595: a Journey with no visual media at all. Q (grouped under Stop P), Stop R
// and the ungrouped via W only have notes; P and X have neither.
const NOTES_ONLY_JOURNEY_ID = "00000000-0000-4000-8000-000000005951";
const storyQaNotesOnlyJourney: Journey = {
  ...storyQaJourney,
  id: NOTES_ONLY_JOURNEY_ID,
  title: "QA · NOTES ONLY",
  note: "",
  coverMediaAssetId: null,
  routePoints: [
    { id: "no-point-p", label: "STOP P 渡口", isStop: true, note: null },
    { id: "no-point-q", label: "Q 码头", isStop: false, stayAnchorRoutePointId: "no-point-p", note: "Q 的感想：船晚了半小时。" },
    { id: "no-point-r", label: "STOP R 山顶", isStop: true, note: "R 的感想：风很大，什么也没拍。" },
    { id: "no-point-w", label: "W 隧道口", isStop: false, note: "W 的感想：隧道里很凉。" },
    { id: "no-point-x", label: "STOP X 终点", isStop: true, note: null },
  ].map((point, index) => ({
    stayAnchorRoutePointId: null,
    ...point,
    journeyId: NOTES_ONLY_JOURNEY_ID,
    sortOrder: index,
    latitude: 22.3 + index * 0.012,
    longitude: 114.2 + index * 0.014,
    occurredAt: null,
    createdAt: "2026-10-04T00:00:00.000Z",
  })),
  media: [],
};

function JourneyStoryQaPreview() {
  const qaMode = new URLSearchParams(window.location.search).get("qaMode");
  const mixedMediaMode = qaMode === "mixed-media";
  const mixedMediaPairMode = qaMode === "mixed-media-pair";
  const manyMediaMode = qaMode === "many-media";
  const desktopChapterMode = qaMode === "desktop-chapter-rail";
  const desktopChapterNoMediaMode = qaMode === "desktop-chapter-rail-no-media";
  const routeBoundaryMode = qaMode === "route-boundary";
  const groupedNotesMode = qaMode === "grouped-notes";
  const notesOnlyMode = qaMode === "notes-only";
  // #555: the only preview mode that opens as a genuine whole-Journey entry.
  // Every other mode keeps its current starting state (no opening).
  const coverOpeningLeadingMode = qaMode === "journey-cover-opening-leading";
  const coverOpeningIntroMode = qaMode === "journey-cover-opening-intro";
  const coverOpeningMode = qaMode === "journey-cover-opening" || coverOpeningLeadingMode || coverOpeningIntroMode;
  const initialJourney = notesOnlyMode
    ? storyQaNotesOnlyJourney
    : groupedNotesMode
    ? storyQaGroupedNotesJourney
    : coverOpeningIntroMode
    ? storyQaCoverOpeningIntroJourney
    : coverOpeningLeadingMode
    ? storyQaCoverOpeningLeadingJourney
    : coverOpeningMode
    ? storyQaCoverOpeningJourney
    : desktopChapterNoMediaMode
    ? storyQaDesktopChapterNoMediaJourney
    : desktopChapterMode
    ? storyQaDesktopChapterJourney
    : mixedMediaPairMode
    ? storyQaMixedPairJourney
    : mixedMediaMode
    ? storyQaMixedJourney
    : routeBoundaryMode
      ? storyQaRouteBoundaryJourney
      : manyMediaMode ? {
    ...storyQaJourney,
    media: Array.from({ length: 8 }, (_, index) => ({
      ...storyQaJourney.media[0],
      id: `00000000-0000-4000-8000-${String(100 + index).padStart(12, "0")}`,
      storageKey: `qa/story-seed-${index}`, fileName: `seed-${index}.jpg`, sortOrder: index,
    })),
  } : storyQaJourney;
  const [open, setOpen] = useState(true);
  const [journeys, setJourneys] = useState<Journey[]>([initialJourney]);
  const [observation, setObservation] = useState<{ assetId: string | null; routePointId: string | null } | null>(null);
  // The preview synthesizes the asset a real API would return, so it needs to
  // be told which kind the next completed upload represents.
  const [nextMediaIsSoundtrack, setNextMediaIsSoundtrack] = useState(false);

  return (
    <main className="living-atlas" data-qa-story-observation-asset={observation?.assetId ?? undefined}
      data-qa-story-observation-route-point={observation?.routePointId ?? undefined}>
      <div className="living-atlas__globe journey-story-qa__backdrop" aria-hidden="true" />
      <button type="button" data-qa-story-reopen onClick={() => setOpen(true)}>重新打开旅程</button>
      <button type="button" data-qa-story-next-audio onClick={() => setNextMediaIsSoundtrack(true)}>下一个上传是配乐</button>
      {/* #596 QA: attach a soundtrack directly, so the ducking lane can reach a
          real `<audio>` without driving the whole upload pipeline to create one.
          Clicking again swaps the soundtrack's identity, which is what makes a
          Journey re-key and genuinely remount the element - the same path a
          member takes when they replace their soundtrack. The upload path above
          stays the honest route to one; this is a fixture affordance, the same
          kind as the button beside it. */}
      <button
        type="button"
        data-qa-story-attach-soundtrack
        onClick={() => {
          setJourneys((current) => {
            const journey = current[0];
            if (!journey) return current;
            const hasPrimary = journey.media.some((asset) => asset.id === QA_SOUNDTRACK_ASSET_ID);
            const hasAlternate = journey.media.some((asset) => asset.id === QA_SOUNDTRACK_ALTERNATE_ID);
            const nextId = hasPrimary && !hasAlternate
              ? QA_SOUNDTRACK_ALTERNATE_ID
              : QA_SOUNDTRACK_ASSET_ID;
            const kept = journey.media.filter((asset) => (
              asset.id !== QA_SOUNDTRACK_ASSET_ID && asset.id !== QA_SOUNDTRACK_ALTERNATE_ID
            ));
            return [{
              ...journey,
              media: [...kept, {
                id: nextId,
                journeyId: journey.id,
                routePointId: null,
                storageDriver: "qa",
                storageKey: "qa/story-soundtrack",
                fileName: "night-theme.mp3",
                mimeType: "audio/mpeg",
                bytes: 68,
                sortOrder: kept.length,
                uploadedByUserId: journey.createdByUserId,
                createdAt: "2026-08-11T00:00:00.000Z",
              }],
            }];
          });
        }}
      >附加配乐</button>
      {open ? (
        <JourneyStory
          journeys={journeys}
          journeyId={initialJourney.id}
          // #595: a Playback return or a deep link names a Route Point.
          routePointId={new URLSearchParams(window.location.search).get("qaRoutePoint")}
          presentJourneyCoverOpening={coverOpeningMode}
          onObservationChange={(next) => setObservation((current) => {
            if (current?.assetId === next?.assetId && current?.routePointId === next?.routePointId) return current;
            return next ? { assetId: next.assetId, routePointId: next.routePointId } : null;
          })}
          onClose={() => setOpen(false)}
          onNavigate={() => undefined}
          onEdit={() => undefined}
          onDelete={() => {
            setJourneys([]);
            setOpen(false);
          }}
          onMediaAdded={() => {
            const currentJourney = journeys[0];
            const index = currentJourney.media.length;
            // The API deduplicates identical content inside a journey and
            // answers with the asset that already exists, so re-uploading the
            // same soundtrack must not add a second row here either.
            if (
              nextMediaIsSoundtrack
              && currentJourney.media.some((asset) => asset.id === QA_SOUNDTRACK_ASSET_ID)
            ) {
              setNextMediaIsSoundtrack(false);
              return currentJourney;
            }
            const nextJourney: Journey = {
              ...currentJourney,
              media: [...currentJourney.media, {
                id: nextMediaIsSoundtrack
                  ? QA_SOUNDTRACK_ASSET_ID
                  : `00000000-0000-4000-8000-00000000020${index}`,
                journeyId: storyQaJourney.id,
                routePointId: null,
                storageDriver: "qa",
                storageKey: `qa/story-media-${index}`,
                fileName: nextMediaIsSoundtrack ? "night-theme.mp3" : "night-route.png",
                mimeType: nextMediaIsSoundtrack ? "audio/mpeg" : "image/png",
                bytes: 68,
                sortOrder: index,
                uploadedByUserId: storyQaJourney.createdByUserId,
                createdAt: "2026-08-11T00:00:00.000Z",
              }],
            };
            setJourneys([nextJourney]);
            setNextMediaIsSoundtrack(false);
            return nextJourney;
          }}
          onMediaDelete={(assetId) => {
            const currentJourney = journeys[0];
            const nextJourney: Journey = {
              ...currentJourney,
              media: currentJourney.media.filter((asset) => asset.id !== assetId),
            };
            setJourneys([nextJourney]);
          }}
          onMediaReorder={(_journeyId, assetIds) => {
            const currentJourney = journeys[0];
            const media = assetIds
              .map((id, index) => {
                const asset = currentJourney.media.find((candidate) => candidate.id === id);
                return asset ? { ...asset, sortOrder: index } : null;
              })
              .filter((asset): asset is NonNullable<typeof asset> => asset !== null);
            const nextJourney: Journey = { ...currentJourney, media };
            setJourneys([nextJourney]);
            return nextJourney;
          }}
        />
      ) : null}
    </main>
  );
}

const playbackQaJourneyId = "00000000-0000-4000-8000-000000000011";
const playbackQaJourney: Journey = {
  ...storyQaJourney,
  id: playbackQaJourneyId,
  title: "QA · MEDIA PLAYBACK",
  routePoints: storyQaJourney.routePoints.map((point) => ({
    ...point,
    journeyId: playbackQaJourneyId,
  })),
  media: [{
    ...storyQaJourney.media[0],
    id: "00000000-0000-4000-8000-000000000111",
    journeyId: playbackQaJourneyId,
    routePointId: storyQaJourney.routePoints[0].id,
    storageKey: "qa/playback-video",
    fileName: "playback-video.mp4",
    mimeType: "video/mp4",
    sortOrder: 0,
  }],
};

// #195 Phase 2: the trimmed variant. A second asset follows the video on the
// same route point, because "the segment ended the beat" is only distinguishable
// from "playback ended" if there is a next beat to advance into.
const PLAYBACK_QA_TRIM_VIDEO_ASSET_ID = "00000000-0000-4000-8000-000000000111";
const playbackQaTrimJourney: Journey = {
  ...playbackQaJourney,
  media: [
    playbackQaJourney.media[0],
    {
      ...playbackQaJourney.media[0],
      id: "00000000-0000-4000-8000-000000000112",
      storageKey: "qa/playback-after-trim",
      fileName: "playback-after-trim.png",
      mimeType: "image/png",
      sortOrder: 1,
    },
  ],
};

function JourneyPlaybackQaPreview() {
  // A trim is declared by the Edit Plan, so the preview supplies it the way
  // Quick Recap does: the resolver answers the window, and the beat's booked
  // length is the same `outMs - inMs` the plan would have booked. Without the
  // trim mode this stays the untrimmed preview the other lanes already drive.
  const qaParams = new URLSearchParams(window.location.search);
  const trimMode = qaParams.get("qaMode") === "trim";
  const trimInMs = Number(qaParams.get("qaTrimIn") ?? 1_200);
  const trimOutMs = Number(qaParams.get("qaTrimOut") ?? 4_700);
  const trim = Number.isFinite(trimInMs) && Number.isFinite(trimOutMs)
    ? { inMs: trimInMs, outMs: trimOutMs }
    : { inMs: 1_200, outMs: 4_700 };
  const journey = trimMode ? playbackQaTrimJourney : playbackQaJourney;
  const trimmedAsset = (targetJourney: Journey, step: PlaybackStep) => (
    step.kind === "media"
    && playbackMediaForPoint(targetJourney, step.pointIndex)[step.mediaIndex]?.id
      === PLAYBACK_QA_TRIM_VIDEO_ASSET_ID
  );
  return (
    <main className="living-atlas">
      <div className="living-atlas__globe journey-story-qa__backdrop" aria-hidden="true" />
      <JourneyPlaybackOverlay
        journey={journey}
        onClose={() => undefined}
        onCameraTargetChange={() => undefined}
        mediaTrimResolver={trimMode
          ? (targetJourney, step) => trimmedAsset(targetJourney, step) ? trim : null
          : undefined}
        stepDurationResolver={trimMode
          ? (targetJourney, step) => (
            trimmedAsset(targetJourney, step) ? trim.outMs - trim.inMs : undefined
          )
          : undefined}
        playbackMode={trimMode ? "quick-recap" : "full"}
        reduceMotion
      />
    </main>
  );
}

// #197: the image-heavy Playback fixtures the prefetch capture needs. A
// time-budget lookahead only differs from the old fixed `current + next` when
// there are many assets to prepare, and the tempo difference only shows on
// image beats. These live in this dev-only preview alone: `LivingAtlasApp`
// builds its journeys from the API, and the default `?qaState=journey-playback`
// preview above is untouched because `qa:media-controls` and
// `qa:final-acceptance` still grade it.
const PREFETCH_QA_SINGLE_POINT_IMAGES = 20;
const PREFETCH_QA_MULTI_POINTS = 5;
const PREFETCH_QA_MULTI_POINT_IMAGES = 12;

function prefetchQaJourney(pointCount: number, imagesPerPoint: number): Journey {
  const journeyId = "00000000-0000-4000-8000-000000000012";
  const routePoints = Array.from({ length: pointCount }, (_unused, pointIndex) => ({
    id: `00000000-0000-4000-8000-2${`${pointIndex}`.padStart(2, "0")}000000000`,
    journeyId,
    sortOrder: pointIndex,
    latitude: 1.290256 + pointIndex * 1.4,
    longitude: 103.851471 + pointIndex * 1.9,
    label: `QA POINT ${pointIndex}`,
    isStop: true,
    occurredAt: null,
    createdAt: "2026-08-11T00:00:00.000Z",
  }));
  const media = routePoints.flatMap((point, pointIndex) => (
    Array.from({ length: imagesPerPoint }, (_unused, mediaIndex) => ({
      // The id carries its own route point and media index, so the QA script
      // can map a signed read back to the beat that displays it without any
      // extra DOM contract.
      id: `00000000-0000-4000-8000-1${`${pointIndex}`.padStart(2, "0")}${`${mediaIndex}`.padStart(3, "0")}000000`,
      journeyId,
      routePointId: point.id,
      storageDriver: "qa",
      storageKey: `qa/prefetch-${pointIndex}-${mediaIndex}`,
      fileName: `prefetch-${pointIndex}-${mediaIndex}.png`,
      mimeType: "image/png",
      bytes: 68,
      sortOrder: pointIndex * 1_000 + mediaIndex,
      uploadedByUserId: storyQaJourney.createdByUserId,
      createdAt: "2026-08-11T00:00:00.000Z",
    }))
  ));
  return {
    ...storyQaJourney,
    id: journeyId,
    title: "QA · PLAYBACK PREFETCH",
    routePoints,
    media,
  };
}

const prefetchQaSingleJourney = prefetchQaJourney(1, PREFETCH_QA_SINGLE_POINT_IMAGES);
const prefetchQaMultiJourney = prefetchQaJourney(
  PREFETCH_QA_MULTI_POINTS,
  PREFETCH_QA_MULTI_POINT_IMAGES,
);

function JourneyPlaybackPrefetchQaPreview() {
  const params = new URLSearchParams(window.location.search);
  const journey = params.get("qaFixture") === "multi"
    ? prefetchQaMultiJourney
    : prefetchQaSingleJourney;
  // Quick Recap is wired the way `LivingAtlasApp` wires it, not approximated:
  // the recap owns an Edit Plan, the plan is rebuilt at the live tempo
  // (decision D1), and the same resolver answers each beat's length — which is
  // what makes the prefetch window walk the beats the recap actually plays.
  const recap = params.get("qaRecap") === "1";
  const [tempo, setTempo] = useState<PlaybackTempo>(PLAYBACK_INITIAL_TEMPO);
  const quickRecap = useMemo(
    () => (recap
      ? prepareQuickRecapPlayback(journey, {
        generatedAt: "2026-09-05T00:00:00.000Z",
        tempo,
      })
      : null),
    [journey, recap, tempo],
  );
  const stepDurationResolver = useCallback((
    targetJourney: Journey,
    step: PlaybackStep,
    activeTempo: PlaybackTempo,
  ) => (
    quickRecap
      ? quickRecapStepDurationMs(targetJourney, step, quickRecap.plan, activeTempo)
      : undefined
  ), [quickRecap]);
  return (
    <main className="living-atlas">
      <div className="living-atlas__globe journey-story-qa__backdrop" aria-hidden="true" />
      <JourneyPlaybackOverlay
        journey={quickRecap?.journey ?? journey}
        onClose={() => undefined}
        onCameraTargetChange={() => undefined}
        stepDurationResolver={recap ? stepDurationResolver : undefined}
        onTempoChange={setTempo}
        playbackMode={quickRecap ? "quick-recap" : "full"}
        reduceMotion
      />
    </main>
  );
}

// #456's original 0/1/3 fixture is also consumed by the #465 map-bridge
// lane. Keep that contract stable; #492 opts into the richer 4/6/9 fixture
// explicitly so one QA slice cannot silently renumber another slice's beats.
// #498 gets a separate 10/30/60 fixture so its large chapter does not make the
// earlier continuity walk pay an unbounded navigation cost.
const CONTINUITY_QA_MEDIA_COUNTS = [0, 1, 3];
const SEQUENCE_CONTINUITY_QA_MEDIA_COUNTS = [0, 1, 3, 4, 6, 9];
const DENSE_CONTINUITY_QA_MEDIA_COUNTS = [10, 30, 60];

const continuityQaJourneyId = "00000000-0000-4000-8000-000000000456";
function buildContinuityQaJourney(mediaCounts: readonly number[]): Journey {
  const routePoints = mediaCounts.map((_unused, pointIndex) => ({
    id: `st109-point-${pointIndex}`,
    journeyId: continuityQaJourneyId,
    sortOrder: pointIndex,
    latitude: 1.290256 + pointIndex * 2.2,
    longitude: 103.851471 + pointIndex * 2.6,
    label: `QA CHAPTER ${pointIndex}`,
    isStop: true,
    occurredAt: null,
    note: pointIndex === 0
      ? "没有照片的一站，地点本身就是完整章节。"
      : pointIndex === 1
        // #595: real notes are capped at 500 characters (journeyModel); eleven
        // lines is 472, still far longer than the caption band.
        ? Array.from({ length: 11 }, () => "这是一段用于验证窄屏长笔记仍为媒体保留稳定画面空间的 Route Point 记录。").join("\n")
        : null,
    createdAt: "2026-09-20T00:00:00.000Z",
  }));
  const media = routePoints.flatMap((point, pointIndex) => (
    Array.from({ length: mediaCounts[pointIndex] }, (_unused, mediaIndex) => ({
      id: `st109-p${pointIndex}-m${mediaIndex}`,
      journeyId: continuityQaJourneyId,
      routePointId: point.id,
      storageDriver: "qa",
      storageKey: `qa/continuity-${pointIndex}-${mediaIndex}`,
      fileName: (pointIndex === 4 && mediaIndex === 2)
        || (mediaCounts[pointIndex] >= 30 && mediaIndex === 2)
        ? `continuity-${pointIndex}-${mediaIndex}.webm`
        : `continuity-${pointIndex}-${mediaIndex}.png`,
      mimeType: (pointIndex === 4 && mediaIndex === 2)
        || (mediaCounts[pointIndex] >= 30 && mediaIndex === 2)
        ? "video/webm"
        : "image/png",
      bytes: 68,
      sortOrder: pointIndex * 10 + mediaIndex,
      uploadedByUserId: storyQaJourney.createdByUserId,
      createdAt: "2026-09-20T00:00:00.000Z",
    }))
  ));
  return {
    ...storyQaJourney,
    id: continuityQaJourneyId,
    title: "QA · PLAYBACK CONTINUITY",
    note: "",
    routePoints,
    media,
  };
}
const continuityQaJourney = buildContinuityQaJourney(CONTINUITY_QA_MEDIA_COUNTS);
const sequenceContinuityQaJourney = buildContinuityQaJourney(SEQUENCE_CONTINUITY_QA_MEDIA_COUNTS);
const denseContinuityQaJourney = buildContinuityQaJourney(DENSE_CONTINUITY_QA_MEDIA_COUNTS);

type ContinuityQaTrace = { cameraTargets: { key: string; at: number; step: number | null; phase: string | null }[] };

// #342: Stop A -> shaping P1 -> A's media via P2 -> independent media via P3
// -> empty Stop B -> shaping P4. All six retain their canonical identities.
const chapterMembershipQaJourney: Journey = {
  ...storyQaJourney,
  id: "00000000-0000-4000-8000-000000003421",
  title: "QA STOP AND VIA CHAPTERS",
  note: "",
  coverMediaAssetId: null,
  routePoints: [
    { label: "STOP A", isStop: true, latitude: 0, longitude: 0, regionContext: "A" },
    { label: "P1 SHAPING", isStop: false, latitude: 2, longitude: 2 },
    { label: "P2 STAY MEDIA", isStop: false, latitude: 0.1, longitude: 0.1, regionContext: "A" },
    { label: "P3 INDEPENDENT MEDIA", isStop: false, latitude: 1, longitude: 1 },
    { label: "STOP B", isStop: true, latitude: 2, longitude: 3, regionContext: "B" },
    { label: "P4 SHAPING", isStop: false, latitude: 3, longitude: 4 },
  ].map((point, index) => ({
    ...point, id: `st121-chapter-point-${index}`, journeyId: "00000000-0000-4000-8000-000000003421",
    stayAnchorRoutePointId: index === 2 ? "st121-chapter-point-0" : null,
    sortOrder: index, occurredAt: null, createdAt: "2026-09-28T00:00:00.000Z",
  })),
  media: [2, 3].map((pointIndex, index) => ({
    id: `st121-chapter-photo-${pointIndex}`, journeyId: "00000000-0000-4000-8000-000000003421",
    routePointId: `st121-chapter-point-${pointIndex}`, storageDriver: "qa", storageKey: `qa/chapter-${pointIndex}`,
    fileName: `chapter-${pointIndex}.png`, mimeType: "image/png", bytes: 68, sortOrder: index,
    uploadedByUserId: storyQaJourney.createdByUserId, createdAt: "2026-09-28T00:00:00.000Z",
  })),
};

function JourneyPlaybackChapterMembershipQaPreview() {
  const params = new URLSearchParams(window.location.search);
  const recap = params.get("qaRecap") === "1";
  const ownedCover = params.get("qaOwnedCover") === "1";
  const sourceJourney = useMemo(() => ownedCover ? {
    ...chapterMembershipQaJourney,
    coverMediaAssetId: "st121-chapter-photo-2",
    routePoints: chapterMembershipQaJourney.routePoints.map((point, index) => index === 2
      ? { ...point, stayAnchorRoutePointId: "st121-chapter-point-4" } : point),
    media: [...chapterMembershipQaJourney.media, {
      ...chapterMembershipQaJourney.media[0], id: "st121-chapter-sibling-2", sortOrder: 99,
    }],
  } : chapterMembershipQaJourney, [ownedCover]);
  const [tempo, setTempo] = useState<PlaybackTempo>(PLAYBACK_INITIAL_TEMPO);
  const prepared = useMemo(() => recap ? prepareQuickRecapPlayback(sourceJourney, {
    generatedAt: "2026-09-28T00:00:00.000Z", tempo,
  }) : null, [recap, tempo, sourceJourney]);
  const journey = prepared?.journey ?? sourceJourney;
  const [handoff, setHandoff] = useState<{ routePointId: string | null; assetId: string | null; reason: string } | null>(null);
  const resolveDuration = useCallback((targetJourney: Journey, step: PlaybackStep, activeTempo: PlaybackTempo) => (
    prepared ? quickRecapStepDurationMs(targetJourney, step, prepared.plan, activeTempo) : undefined
  ), [prepared]);
  const recordCameraTarget = useCallback((target: PlaybackCameraTarget) => {
    const store = window as unknown as { __qaPlaybackContinuity?: ContinuityQaTrace };
    const trace = store.__qaPlaybackContinuity ?? { cameraTargets: [] };
    store.__qaPlaybackContinuity = trace;
    const overlay = document.querySelector<HTMLElement>(".journey-playback");
    trace.cameraTargets.push({ key: playbackCameraTargetKey(target), at: Date.now(),
      step: overlay ? Number(overlay.dataset.playbackStep) : null,
      phase: overlay?.dataset.playbackPhase ?? null,
    });
  }, []);
  return (
    <main className="living-atlas" data-qa-chapter-membership
      data-qa-canonical-route={JSON.stringify(journey.routePoints.map((point) => point.id))}
      data-qa-canonical-media={JSON.stringify(journey.media.map((asset) => [asset.id, asset.routePointId, asset.sortOrder]))}
      data-qa-return-route-point={handoff?.routePointId ?? undefined}
      data-qa-return-asset={handoff?.assetId ?? undefined}
      data-qa-return-reason={handoff?.reason ?? undefined}
    >
      <div className="living-atlas__globe journey-story-qa__backdrop" aria-hidden="true" />
      {handoff ? null : <JourneyPlaybackOverlay
        journey={journey}
        onClose={({ position, reason }) => setHandoff({ routePointId: position?.routePointId ?? null, assetId: position?.assetId ?? null, reason })}
        onCameraTargetChange={recordCameraTarget}
        onTempoChange={setTempo}
        stepDurationResolver={prepared ? resolveDuration : undefined}
        playbackMode={prepared ? "quick-recap" : "full"}
        reduceMotion
      />}
    </main>
  );
}

// #595: Journey Playback over the grouped-notes Journey. Close records the
// committed return position, so the lane can reopen Story on it.
function JourneyPlaybackGroupedNotesQaPreview() {
  const notesOnly = new URLSearchParams(window.location.search).get("qaNotesOnly") === "1";
  const [handoff, setHandoff] = useState<{ routePointId: string | null; assetId: string | null; reason: string } | null>(null);
  return (
    <main className="living-atlas" data-qa-grouped-notes
      data-qa-return-route-point={handoff?.routePointId ?? undefined}
      data-qa-return-asset={handoff?.assetId ?? undefined}
      data-qa-return-reason={handoff?.reason ?? undefined}
    >
      <div className="living-atlas__globe journey-story-qa__backdrop" aria-hidden="true" />
      {handoff ? null : <JourneyPlaybackOverlay
        journey={notesOnly ? storyQaNotesOnlyJourney : storyQaGroupedNotesJourney}
        onClose={({ position, reason }) => setHandoff({
          routePointId: position?.routePointId ?? null, assetId: position?.assetId ?? null, reason,
        })}
        onCameraTargetChange={() => undefined}
        playbackMode="full"
        reduceMotion
      />}
    </main>
  );
}

function JourneyPlaybackContinuityQaPreview() {
  const params = new URLSearchParams(window.location.search);
  const bridgeVideo = params.get("qaMapBridgeVideo") === "1";
  const nearbyBridge = params.get("qaMapBridgeNearby") === "1";
  const sequenceDensityQa = params.get("qaSequenceDensity") === "1";
  const denseDensityQa = params.get("qaDenseDensity") === "1";
  const baseJourney = denseDensityQa
    ? denseContinuityQaJourney
    : sequenceDensityQa
      ? sequenceContinuityQaJourney
      : continuityQaJourney;
  const journey = useMemo(() => ({
    ...baseJourney,
    routePoints: nearbyBridge ? baseJourney.routePoints.map((point, index) => ({
      ...point, latitude: 1.290256 + index * 0.01, longitude: 103.851471 + index * 0.01,
    })) : baseJourney.routePoints,
    media: bridgeVideo ? baseJourney.media.map((asset) => asset.id === "st109-p1-m0"
      ? { ...asset, mimeType: "video/webm", fileName: "bridge.webm" } : asset) : baseJourney.media,
  }), [baseJourney, bridgeVideo, nearbyBridge]);
  const [closed, setClosed] = useState(false);
  const playbackMediaReadCacheRef = useRef<Record<string, MediaReadState>>({});
  const expireCachedReadOnClose = params.get("qaExpireCachedReadOnClose");
  const cachePlaybackMediaRead = useCallback((
    _journeyId: string,
    assetId: string,
    read: MediaReadState | null,
  ) => {
    if (read?.status === "ready") {
      playbackMediaReadCacheRef.current = { ...playbackMediaReadCacheRef.current, [assetId]: read };
      return;
    }
    const next = { ...playbackMediaReadCacheRef.current };
    delete next[assetId];
    playbackMediaReadCacheRef.current = next;
  }, []);
  const closePlayback = useCallback(() => {
    if (expireCachedReadOnClose) {
      const cached = playbackMediaReadCacheRef.current[expireCachedReadOnClose];
      if (cached?.status === "ready") {
        playbackMediaReadCacheRef.current = {
          ...playbackMediaReadCacheRef.current,
          [expireCachedReadOnClose]: { ...cached, expiresAt: 0 },
        };
      }
    }
    setClosed(true);
  }, [expireCachedReadOnClose]);
  // Reduced Motion is a run parameter here, not a constant: acceptance 6 is
  // only observable if the SAME fixture can be played both ways.
  const reduceMotion = params.get("qaReduceMotion") !== "0";
  const recordCameraTarget = useCallback((target: PlaybackCameraTarget) => {
    const store = window as unknown as { __qaPlaybackContinuity?: ContinuityQaTrace };
    const trace = store.__qaPlaybackContinuity ?? { cameraTargets: [] };
    store.__qaPlaybackContinuity = trace;
    const overlay = document.querySelector<HTMLElement>(".journey-playback");
    trace.cameraTargets.push({ key: playbackCameraTargetKey(target), at: Date.now(),
      step: overlay ? Number(overlay.dataset.playbackStep) : null,
      phase: overlay?.dataset.playbackPhase ?? null,
    });
  }, []);
  return (
    <main className="living-atlas">
      <div className="living-atlas__globe journey-story-qa__backdrop" aria-hidden="true" />
      {closed ? (
        <button type="button" data-qa-playback-reopen onClick={() => setClosed(false)}>Reopen Playback</button>
      ) : <JourneyPlaybackOverlay
        journey={journey}
        initialMediaReads={playbackMediaReadCacheRef.current}
        onMediaReadCacheChange={cachePlaybackMediaRead}
        onClose={closePlayback}
        onCameraTargetChange={recordCameraTarget}
        playbackMode="full"
        reduceMotion={reduceMotion}
      />}
    </main>
  );
}

const routeProvenanceQaJourneyId = "00000000-0000-4000-8000-000000000342";
const routeProvenanceQaJourney: Journey = {
  ...storyQaRouteBoundaryJourney,
  id: routeProvenanceQaJourneyId,
  title: "QA ROUTE PROVENANCE",
  routePoints: storyQaRouteBoundaryJourney.routePoints.map((point, index) => ({
    ...point,
    id: `st121-route-point-${index}`,
    journeyId: routeProvenanceQaJourneyId,
    sortOrder: index,
    label: index === 0 ? "QA ROUTE A" : "QA ROUTE B",
  })),
  media: [],
};

function JourneyPlaybackRouteProvenanceQaPreview() {
  const [provenance, setProvenance] = useState<RouteProvenanceTier>("sparse-relation");
  const [fallback, setFallback] = useState<"user-shaped-route" | "sparse-relation">("sparse-relation");
  const playbackRoute = useMemo(() => ({
    points: toJourneyRoutes([routeProvenanceQaJourney])[0].points,
    segmentProvenance: [provenance],
  }), [provenance]);
  const suggest = (nextFallback: "user-shaped-route" | "sparse-relation") => {
    setFallback(nextFallback);
    setProvenance("suggested-route");
  };
  const decide = (decision: "confirm" | "none-of-these") => {
    setProvenance(resolveSuggestedRouteDecision(decision, fallback));
  };
  return (
    <main className="living-atlas" data-qa-route-provenance={provenance}>
      <div className="living-atlas__globe journey-story-qa__backdrop" aria-hidden="true" />
      <JourneyPlaybackOverlay
        journey={routeProvenanceQaJourney}
        playbackRoute={playbackRoute}
        onClose={() => undefined}
        onCameraTargetChange={() => undefined}
        stepDurationResolver={(_journey, step) => step.kind === "travel" ? 60_000 : 50}
        playbackMode="full"
        reduceMotion
      />
      <div
        data-qa-route-provenance-controls
        style={{ position: "fixed", inset: "8px auto auto 8px", zIndex: 10000, display: "flex", gap: 4 }}
      >
        <button type="button" data-qa-action="suggest-sparse" onClick={() => suggest("sparse-relation")}>suggest sparse</button>
        <button type="button" data-qa-action="suggest-shaped" onClick={() => suggest("user-shaped-route")}>suggest shaped</button>
        <button type="button" data-qa-action="confirm" onClick={() => decide("confirm")}>confirm</button>
        <button type="button" data-qa-action="reject" onClick={() => decide("none-of-these")}>reject</button>
      </div>
    </main>
  );
}

function BrandSignatureMotionQaPreview() {
  return (
    <main className="auth-gate auth-gate--brand-loading" data-qa-brand-signature-motion="true">
      <StartripsBrandLoader message="Loading your private atlas…" />
    </main>
  );
}

function RecoverySurfaceQaPreview() {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("qaMode");
  const kind: StartripsRecoveryKind = requested === "not-found" || requested === "error" ? requested : "empty";
  const [intent, setIntent] = useState("idle");
  const markIntent = (name: string) => setIntent(name);
  const rootClassName = kind === "not-found"
    ? "startrips-not-found"
    : `living-atlas${kind === "error" ? " is-error" : " is-mobile-v2"}`;
  return (
    <main
      className={`${rootClassName} recovery-surface-qa recovery-surface-qa--${kind}`}
      data-qa-recovery-surface={kind}
      data-qa-recovery-intent={intent}
    >
      <StartripsRecoverySurface
        kind={kind}
        className={kind === "empty" ? "living-atlas__empty" : undefined}
        headingLevel={kind === "empty" ? 2 : 1}
        detail={kind === "error" ? "QA recoverable service error" : undefined}
        onPrimaryAction={() => markIntent(kind === "error" ? "retry" : kind === "empty" ? "create" : "home")}
        onSecondaryAction={kind === "not-found" ? () => markIntent("back") : undefined}
      />
    </main>
  );
}

/**
 * 3D Journey Book QA: a deep book, so the stacks either side of the spine are
 * thick enough to expose the table and tilt regressions. Cover + 78 pictures +
 * back cover = 80 faces, 40 sheets; the Route Points have no note and no media,
 * so they add no page, and give the cover a real Route to deboss. The QA lane
 * serves the checked-in artworks for these assets.
 */
const BOOK_3D_QA_PICTURES = 78;
const BOOK_3D_QA_ROUTE: [number, number][] = [
  [1.290256, 103.851471],
  [1.2816, 103.8636],
  [1.3008, 103.9122],
  [1.3236, 103.9568],
  [1.3644, 103.9915],
];
const book3dQaJourney: Journey = {
  ...storyQaJourney,
  // The lane's sheet count is fixed (40 sheets, 80 faces); a Journey note
  // would add its own first page.
  note: "",
  routePoints: BOOK_3D_QA_ROUTE.map(([latitude, longitude], index) => ({
    ...storyQaJourney.routePoints[0],
    id: `00000000-0000-4000-8000-${String(4900 + index).padStart(12, "0")}`,
    sortOrder: index,
    latitude,
    longitude,
    label: index === 0 ? storyQaJourney.routePoints[0].label : "",
    isStop: index === 0,
    note: null,
  })),
  media: Array.from({ length: BOOK_3D_QA_PICTURES }, (_, index) => ({
    ...storyQaJourney.media[0],
    id: `00000000-0000-4000-8000-${String(5000 + index).padStart(12, "0")}`,
    storageKey: `qa/book-3d-${index}`,
    fileName: `book-3d-${index}.jpg`,
    mimeType: "image/jpeg",
    sortOrder: index,
  })),
};

function JourneyBook3dQaPreview() {
  return (
    <main className="living-atlas">
      <JourneyBook3d
        journeys={[book3dQaJourney]}
        journeyId={book3dQaJourney.id}
        onClose={() => {}}
        onOpenClassic={() => {}}
      />
    </main>
  );
}

const Experience = qaState === "journey-composer"
  ? JourneyComposerQaPreview
  : qaState === "journey-story"
    ? JourneyStoryQaPreview
  : qaState === "journey-book-3d"
    ? JourneyBook3dQaPreview
  : qaState === "journey-playback"
    // #197: the prefetch capture needs its own image-heavy fixture, so it is a
    // sibling mode of the playback preview rather than a change to it.
    ? (new URLSearchParams(window.location.search).get("qaMode") === "prefetch"
      ? JourneyPlaybackPrefetchQaPreview
      // #456: the sparse 0/1/3-media continuity fixture is a sibling mode too,
      // so the lanes already grading the default preview keep their fixture.
      : new URLSearchParams(window.location.search).get("qaMode") === "route-provenance"
        ? JourneyPlaybackRouteProvenanceQaPreview
        : new URLSearchParams(window.location.search).get("qaMode") === "chapter-membership"
          ? JourneyPlaybackChapterMembershipQaPreview
          : new URLSearchParams(window.location.search).get("qaMode") === "continuity"
            ? JourneyPlaybackContinuityQaPreview
            : new URLSearchParams(window.location.search).get("qaMode") === "grouped-notes"
              ? JourneyPlaybackGroupedNotesQaPreview
              : JourneyPlaybackQaPreview)
  : (qaState === "globe-controls" || qaState === "globe-controls-gateway")
    ? LivingAtlasGlobeControlsQaPreview
  : qaState === "earth-dive"
    ? EarthDiveQaPreview
  : (qaState === "living-atlas" || qaState === "atlas-gateway")
    ? LivingAtlasQaPreview
  : qaState === "brand-signature-motion"
    ? BrandSignatureMotionQaPreview
  : qaState === "recovery-surfaces"
    ? RecoverySurfaceQaPreview
    : LivingAtlasApp;

export function QaExperience() {
  return <Experience />;
}
