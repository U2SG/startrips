import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AuthGateway } from "./auth/AuthGateway";
import { LivingAtlasApp } from "./journey/LivingAtlasApp";
import { JourneyComposer } from "./journey/JourneyComposer";
import { JourneyStory } from "./journey/JourneyStory";
import { JourneyPlaybackOverlay } from "./journey/JourneyPlaybackOverlay";
import type { Journey, JourneyRoute } from "./journey/types";
import { ParticleEarthScene } from "./scene/ParticleEarthScene";
import {
  LivingAtlasGlobe,
  LivingAtlasGlobeControls,
  PersistentEarthProvider,
  type LivingAtlasGlobeProps,
} from "./scene/LivingAtlasGlobe";
import "./styles/tokens.css";
import "./app.css";
import "./styles/archive-shell.css";
import "./styles/artwork-browser.css";
import "./styles/personal-artifact.css";
import "./styles/personal-gallery.css";
import "./styles/auth-gate.css";
import "./styles/living-atlas.css";
import "./styles/journey-playback.css";
import "./styles/globe-time-scrubber.css";

const qaState = new URLSearchParams(window.location.search).get("qaState");

const globeQaRoutes: JourneyRoute[] = [
  {
    id: "qa-route-night-train",
    color: "#77c8c2",
    lightEffect: "aurora",
    points: [
      { id: "qa-p-1", lat: 31.2304, lon: 121.4737, isStop: true, label: "Shanghai" },
      { id: "qa-p-2", lat: 34.7466, lon: 113.6254, isStop: true, label: "Zhengzhou" },
      { id: "qa-p-3", lat: 39.9042, lon: 116.4074, isStop: true, label: "Beijing" },
      { id: "qa-p-4", lat: 43.8256, lon: 87.6168, isStop: false, label: "Ürümqi" },
    ],
  },
  {
    id: "qa-route-sea-breeze",
    color: "#e8a87c",
    lightEffect: "rainbow",
    points: [
      { id: "qa-p-5", lat: 35.6762, lon: 139.6503, isStop: true, label: "Tokyo" },
      { id: "qa-p-6", lat: 34.6937, lon: 135.5023, isStop: true, label: "Osaka" },
      { id: "qa-p-7", lat: 33.5904, lon: 130.4017, isStop: true, label: "Fukuoka" },
    ],
  },
  {
    id: "qa-route-rhine",
    color: "#9fd356",
    lightEffect: "sunset",
    points: [
      { id: "qa-p-8", lat: 52.3676, lon: 4.9041, isStop: true, label: "Amsterdam" },
      { id: "qa-p-9", lat: 50.9375, lon: 6.9603, isStop: true, label: "Cologne" },
      { id: "qa-p-10", lat: 50.1109, lon: 8.6821, isStop: false, label: "Frankfurt" },
    ],
  },
  {
    id: "qa-route-southern-summer",
    color: "#b39ddb",
    lightEffect: "nebula",
    points: [
      { id: "qa-p-11", lat: -36.8509, lon: 174.7645, isStop: true, label: "Auckland" },
      { id: "qa-p-12", lat: -37.8136, lon: 144.9631, isStop: true, label: "Melbourne" },
      { id: "qa-p-13", lat: -33.8688, lon: 151.2093, isStop: false, label: "Sydney" },
    ],
  },
  {
    id: "qa-route-alone-at-sea",
    color: "#ffd166",
    points: [
      { id: "qa-p-14", lat: 1.290256, lon: 103.851471, isStop: true, label: "Singapore" },
    ],
  },
];

function JourneyRoutesQaPreview() {
  const [activeRouteId, setActiveRouteId] = useState<string | null>(null);
  const activeRoute = globeQaRoutes.find((route) => route.id === activeRouteId) ?? null;
  return (
    <main className="living-atlas">
      <div className="living-atlas__globe">
        <ParticleEarthScene
          mode="focusPoint"
          quality="low"
          journeyRoutes={globeQaRoutes}
          activeJourneyRouteId={activeRouteId}
          focusRoute={activeRoute}
          onJourneyRouteActivate={setActiveRouteId}
          onJourneyRoutePointActivate={() => undefined}
          focusPoint={{ lat: 30, lon: 110 }}
          focusColor="#77c8c2"
          centerFocusPoint
          dragToRotate
          wheelToZoom
          reduceMotion
        />
      </div>
      <div
        style={{
          position: "absolute",
          zIndex: 60,
          bottom: 14,
          left: 14,
          display: "flex",
          gap: 6,
        }}
      >
        {globeQaRoutes.map((route) => (
          <button
            key={route.id}
            type="button"
            data-qa-route={route.id}
            style={{
              padding: "6px 10px",
              border: activeRouteId === route.id
                ? "1px solid rgba(200,255,61,0.55)"
                : "1px solid rgba(118,198,188,0.28)",
              background: activeRouteId === route.id
                ? "rgba(200,255,61,0.1)"
                : "rgba(2,11,12,0.82)",
              color: route.color,
              cursor: "pointer",
              font: "500 9px/1 ui-monospace, monospace",
            }}
            onClick={() => setActiveRouteId(route.id)}
          >
            {route.id.replace("qa-route-", "")}
          </button>
        ))}
      </div>
    </main>
  );
}

const appQaPickPoints = [
  { latitude: 37.76942, longitude: -122.48621 },
  { latitude: 34.01129, longitude: -118.49231 },
  { latitude: 47.60621, longitude: -122.33207 },
];

function LivingAtlasQaGlobe({ onGlobePointPick, journeyRoutes }: LivingAtlasGlobeProps) {
  const [pickIndex, setPickIndex] = useState(0);
  const draftRoute = journeyRoutes.find((route) => route.id === "draft-route-preview") ?? null;
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
      <output
        data-qa-app-route-preview
        data-route-points={JSON.stringify(draftRoute?.points ?? [])}
        style={{ position: "fixed", width: 1, height: 1, overflow: "hidden", opacity: 0 }}
      >{draftRoute?.points.length ?? 0}</output>
    </div>
  );
}

function LivingAtlasQaPreview() {
  return <LivingAtlasApp GlobeComponent={LivingAtlasQaGlobe} />;
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
          detailMode={detailMode}
          transitionTarget={null}
          detailLanguage={language}
          transitionLabel=""
          onModeToggle={() => undefined}
          onDetailLanguageChange={setLanguage}
          onPickRequest={() => undefined}
        />
      </section>
    </main>
  );
}

function JourneyComposerQaPreview() {
  const editMode = new URLSearchParams(window.location.search).get("qaMode") === "edit";
  const [open, setOpen] = useState(true);
  return (
    <main className="living-atlas">
      <div className="living-atlas__globe journey-story-qa__backdrop" aria-hidden="true" />
      <button type="button" data-qa-composer-reopen onClick={() => setOpen(true)}>重新打开编辑器</button>
      {open ? (
        <JourneyComposer
          open
          journey={editMode ? storyQaJourney : undefined}
          onClose={() => setOpen(false)}
          onSaved={() => undefined}
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

const QA_SOUNDTRACK_ASSET_ID = "00000000-0000-4000-8000-000000000900";

function JourneyStoryQaPreview() {
  const [open, setOpen] = useState(true);
  const [journeys, setJourneys] = useState<Journey[]>([storyQaJourney]);
  // The preview synthesizes the asset a real API would return, so it needs to
  // be told which kind the next completed upload represents.
  const [nextMediaIsSoundtrack, setNextMediaIsSoundtrack] = useState(false);

  return (
    <main className="living-atlas">
      <div className="living-atlas__globe journey-story-qa__backdrop" aria-hidden="true" />
      <button type="button" data-qa-story-reopen onClick={() => setOpen(true)}>重新打开旅程</button>
      <button type="button" data-qa-story-next-audio onClick={() => setNextMediaIsSoundtrack(true)}>下一个上传是配乐</button>
      {open ? (
        <JourneyStory
          journeys={journeys}
          journeyId={storyQaJourney.id}
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

function JourneyPlaybackQaPreview() {
  return (
    <main className="living-atlas">
      <div className="living-atlas__globe journey-story-qa__backdrop" aria-hidden="true" />
      <JourneyPlaybackOverlay
        journey={playbackQaJourney}
        onClose={() => undefined}
        onCameraTargetChange={() => undefined}
        reduceMotion
      />
    </main>
  );
}

const Experience = import.meta.env.DEV && qaState === "journey-composer"
  ? JourneyComposerQaPreview
  : import.meta.env.DEV && qaState === "journey-story"
    ? JourneyStoryQaPreview
  : import.meta.env.DEV && qaState === "journey-playback"
    ? JourneyPlaybackQaPreview
  : import.meta.env.DEV && qaState === "journey-routes"
    ? JourneyRoutesQaPreview
  : import.meta.env.DEV && (qaState === "globe-controls" || qaState === "globe-controls-gateway")
    ? LivingAtlasGlobeControlsQaPreview
  : import.meta.env.DEV && (qaState === "living-atlas" || qaState === "atlas-gateway")
    ? LivingAtlasQaPreview
  : import.meta.env.DEV && qaState === "final-acceptance"
    ? LivingAtlasApp
  : import.meta.env.DEV && qaState
    ? App
    : LivingAtlasApp;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PersistentEarthProvider>
      <AuthGateway>
        <Experience />
      </AuthGateway>
    </PersistentEarthProvider>
  </StrictMode>,
);
