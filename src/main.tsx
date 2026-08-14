import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AuthGateway } from "./auth/AuthGateway";
import { LivingAtlasApp } from "./journey/LivingAtlasApp";
import { JourneyComposer } from "./journey/JourneyComposer";
import { JourneyStory } from "./journey/JourneyStory";
import type { Journey } from "./journey/types";
import { ParticleEarthScene } from "./scene/ParticleEarthScene";
import "./styles/tokens.css";
import "./app.css";
import "./styles/archive-shell.css";
import "./styles/artwork-browser.css";
import "./styles/personal-artifact.css";
import "./styles/personal-gallery.css";
import "./styles/auth-gate.css";
import "./styles/living-atlas.css";

const qaState = new URLSearchParams(window.location.search).get("qaState");

function JourneyComposerQaPreview() {
  return (
    <main className="living-atlas">
      <div className="living-atlas__globe" aria-hidden="true">
        <ParticleEarthScene mode="focusPoint" quality="high" reduceMotion />
      </div>
      <JourneyComposer
        open
        onClose={() => undefined}
        onSaved={() => undefined}
        onGlobePickRequest={() => undefined}
      />
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
  media: [],
};

function JourneyStoryQaPreview() {
  const [open, setOpen] = useState(true);
  const [journeys, setJourneys] = useState<Journey[]>([storyQaJourney]);

  return (
    <main className="living-atlas">
      <div className="living-atlas__globe" aria-hidden="true">
        <ParticleEarthScene mode="focusPoint" quality="high" reduceMotion />
      </div>
      <button type="button" data-qa-story-reopen onClick={() => setOpen(true)}>重新打开旅程</button>
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
            const nextJourney: Journey = {
              ...currentJourney,
              media: [...currentJourney.media, {
                id: "00000000-0000-4000-8000-000000000005",
                journeyId: storyQaJourney.id,
                routePointId: null,
                storageDriver: "qa",
                storageKey: "qa/story-media",
                fileName: "night-route.png",
                mimeType: "image/png",
                bytes: 68,
                sortOrder: currentJourney.media.length,
                uploadedByUserId: storyQaJourney.createdByUserId,
                createdAt: "2026-08-11T00:00:00.000Z",
              }],
            };
            setJourneys([nextJourney]);
            return nextJourney;
          }}
        />
      ) : null}
    </main>
  );
}

const Experience = import.meta.env.DEV && qaState === "journey-composer"
  ? JourneyComposerQaPreview
  : import.meta.env.DEV && qaState === "journey-story"
    ? JourneyStoryQaPreview
  : import.meta.env.DEV && qaState
    ? App
    : LivingAtlasApp;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthGateway>
      <Experience />
    </AuthGateway>
  </StrictMode>,
);
