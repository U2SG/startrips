import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ArchiveShell } from "./components/ArchiveShell";
import { ArtworkBrowser, getArchiveNeighbor } from "./components/ArtworkBrowser";
import { ArtworkDetail } from "./components/ArtworkDetail";
import { GenerationProgress } from "./components/GenerationProgress";
import { PersonalArtifactFlow } from "./components/PersonalArtifactFlow";
import { PersonalGalleryRoute } from "./components/PersonalGalleryRoute";
import { PersonalMomentDetail } from "./components/PersonalMomentDetail";
import { PointPlacedConfirmation } from "./components/PointPlacedConfirmation";
import { SignalLog } from "./components/SignalLog";
import { archiveBrowserRecords } from "./data/archiveRecords";
import { EMPTY_UPLOAD_DRAFT, experienceReducer } from "./experience/reducer";
import { hydrateQaState } from "./experience/qaState";
import type { PersonalMoment } from "./experience/types";
import { ParticleEarthScene } from "./scene/ParticleEarthScene";
import { formatLatitude, formatLongitude } from "./scene/geo";
import {
  coordinatesForPlace,
  loadPersonalMoments,
  normalizeUploadDraft,
  savePersonalMoments,
} from "./storage/personalMoments";

function readInitialQaState() {
  return new URLSearchParams(window.location.search).get("qaState");
}

function createAppInitialState() {
  const state = hydrateQaState(readInitialQaState());
  return state.qaState
    ? state
    : { ...state, personalMoments: loadPersonalMoments() };
}

function getSignalCopy(phase: string, qaState: string | null, globeMode: string) {
  if (qaState === "brand-transition") {
    return { label: "ENTER", message: "从现实地球，进入一张活着的艺术地图。" };
  }
  if (phase === "artworkDetail") {
    return { label: "ARCHIVE", message: "浏览作品，时间、地点与档案彼此连接。" };
  }
  if (phase === "artworkBrowser" || phase === "archive") {
    return { label: "ENTER", message: "从现实地球，进入一张活着的艺术地图。" };
  }
  if (phase === "upload") {
    if (qaState === "upload-ready") {
      return { label: "LOCATE", message: "选择时间、地点与情绪，生成个人坐标。" };
    }
    if (qaState === "upload-filled") {
      return { label: "DESCRIBE", message: "上传图像，写下它的名字与个人记忆。" };
    }
    return { label: "UPLOAD", message: "现在，放入一件属于自己的艺术。" };
  }
  if (phase === "generating" || phase === "pointPlaced") {
    return { label: "GENERATE", message: "AI 把这段记忆变成艺术星球上的新光点。" };
  }
  if (phase === "earthReturn") {
    return { label: "YOUR ORBIT", message: "你的作品进入一张共同的艺术关系图。" };
  }
  if (globeMode === "focusPoint") {
    return { label: "POINT PLACED", message: "一个属于你的观看坐标已经被点亮。" };
  }
  return { label: "SIGNAL", message: "拖动视线，进入一颗由艺术坐标组成的地球。" };
}

export function App() {
  const [state, dispatch] = useReducer(
    experienceReducer,
    undefined,
    createAppInitialState,
  );
  const [galleryFocusPending, setGalleryFocusPending] = useState(false);
  const previousMomentsRef = useRef(state.personalMoments);
  const reduceMotion = useMemo(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );
  const isBrandTransition = state.qaState === "brand-transition";
  const isSurface = state.qaState === "earth-surface";
  const isArchiveIndex =
    state.phase === "archive" &&
    !isBrandTransition &&
    !isSurface &&
    state.qaState !== "archive-burst";
  const showEarthScene = ["earthIntro", "archive", "generating", "earthReturn"].includes(state.phase);
  const selectedArtwork =
    archiveBrowserRecords.find((record) => record.id === state.selectedArtworkId) ??
    archiveBrowserRecords[0];
  const previousArtwork = getArchiveNeighbor(archiveBrowserRecords, selectedArtwork.id, -1);
  const nextArtwork = getArchiveNeighbor(archiveBrowserRecords, selectedArtwork.id, 1);
  const selectedMoment =
    state.personalMoments.find((moment) => moment.id === state.selectedMomentId) ??
    state.personalMoments[0] ??
    null;
  const signalCopy = getSignalCopy(state.phase, state.qaState, state.globeMode);
  const telemetryPoint = state.focusedPoint ?? { lat: 34.0522, lon: -118.2437 };

  useEffect(() => {
    if (!galleryFocusPending) return;
    const timeout = window.setTimeout(() => {
      dispatch({ type: "OPEN_PERSONAL_GALLERY" });
      setGalleryFocusPending(false);
    }, reduceMotion ? 0 : 420);
    return () => window.clearTimeout(timeout);
  }, [galleryFocusPending, reduceMotion]);

  useEffect(() => {
    if (state.phase !== "generating" || state.qaState) return;
    const delay = reduceMotion ? 900 : 2600;
    const timeout = window.setTimeout(() => {
      const draft = normalizeUploadDraft(state.uploadDraft);
      if (!draft.imageUrl || !draft.title) return;
      const point = draft.point ?? coordinatesForPlace(draft.place);
      const moment: PersonalMoment = {
        id: `personal-${Date.now()}`,
        title: draft.title,
        note: draft.note || undefined,
        year: draft.year,
        place: draft.place,
        imageUrl: draft.imageUrl,
        previewUrl: draft.previewUrl,
        lightColor: draft.lightColor,
        point,
      };
      dispatch({ type: "POINT_PLACED", moment });
    }, delay);
    return () => window.clearTimeout(timeout);
  }, [reduceMotion, state.phase, state.qaState, state.uploadDraft]);

  useEffect(() => {
    if (!state.qaState && state.personalMoments.length > 0) {
      savePersonalMoments(state.personalMoments);
    }
  }, [state.personalMoments, state.qaState]);

  useEffect(() => {
    const retainedUrls = new Set(
      state.personalMoments.flatMap((moment) => [moment.imageUrl, moment.previewUrl]),
    );
    for (const moment of previousMomentsRef.current) {
      const removedUrls = new Set([moment.imageUrl, moment.previewUrl]);
      for (const removedUrl of removedUrls) {
        if (removedUrl?.startsWith("blob:") && !retainedUrls.has(removedUrl)) {
          URL.revokeObjectURL(removedUrl);
        }
      }
    }
    previousMomentsRef.current = state.personalMoments;
  }, [state.personalMoments]);

  function submitUpload() {
    const normalized = normalizeUploadDraft(state.uploadDraft);
    dispatch({
      type: "UPDATE_UPLOAD_DRAFT",
      patch: {
        ...normalized,
        point: normalized.point ?? coordinatesForPlace(normalized.place),
      },
    });
    dispatch({ type: "SUBMIT_UPLOAD" });
  }

  function addAnotherMoment() {
    dispatch({
      type: "UPDATE_UPLOAD_DRAFT",
      patch: {
        ...EMPTY_UPLOAD_DRAFT,
        imageUrl: undefined,
        previewUrl: undefined,
        lightColor: undefined,
        point: undefined,
      },
    });
    dispatch({ type: "START_UPLOAD" });
  }

  function focusPersonalPoint() {
    if (!galleryFocusPending) setGalleryFocusPending(true);
  }

  return (
    <main className={`experience phase-${state.phase} state-${state.qaState ?? "live"}`}>
      {showEarthScene ? (
        <>
          <ParticleEarthScene
            mode={state.globeMode}
            quality="high"
            focusPoint={state.focusedPoint}
            focusColor={selectedMoment?.lightColor}
            centerFocusPoint={!state.qaState && state.phase === "earthReturn"}
            onFocusPointActivate={
              state.phase === "earthReturn" ? focusPersonalPoint : undefined
            }
            reduceMotion={reduceMotion}
          />
          <div className="scene-vignette" aria-hidden="true" />
        </>
      ) : null}

      {state.phase !== "upload" && state.phase !== "personalGallery" && state.phase !== "momentDetail" ? (
        <header className="global-header">
          <div className="archive-name">ART MOMENT · WORLD ARCHIVE · 001</div>
          <div className="profile-name">Joey ZONE</div>
        </header>
      ) : null}

      {(state.phase === "earthIntro" || state.phase === "archive" || state.phase === "earthReturn") ? (
        <nav className="world-nav" aria-label="世界档案导航">
          <button type="button" onClick={() => dispatch({ type: "BACK_TO_EARTH" })}>OCEAN</button>
          <button type="button" onClick={() => dispatch({ type: "ENTER_ARCHIVE" })}>SIGNAL</button>
          <span>YOU</span>
        </nav>
      ) : null}

      {state.phase === "earthIntro" && state.qaState !== "earth-intro" ? (
        <section className="intro-copy">
          <p className="eyebrow">A LIVING ARCHIVE OF HUMAN LOOKING</p>
          <h1>每一件艺术，<br />都在地球上留下光。</h1>
          <p className="lede">从一颗粒子地球出发，看见作品、地点与观看者如何彼此连接。</p>
          <button className="primary-cta" type="button" onClick={() => dispatch({ type: "ENTER_ARCHIVE" })}>
            进入世界艺术档案
          </button>
        </section>
      ) : null}

      {isBrandTransition ? (
        <section className="brand-transition" aria-label="ART LOOKS BACK">
          <span>ART</span>
          <span>LOOKS</span>
          <span>BACK</span>
        </section>
      ) : null}

      {isSurface ? (
        <section className="surface-index">
          <div className="surface-index-number">04</div>
          <p>WORLD ARCHIVE</p>
          <h1>{selectedArtwork.title}</h1>
          <dl>
            <div><dt>ARTIST</dt><dd>{selectedArtwork.artist}</dd></div>
            <div><dt>YEAR</dt><dd>{selectedArtwork.year}</dd></div>
            <div><dt>REGION</dt><dd>{selectedArtwork.region}</dd></div>
          </dl>
        </section>
      ) : null}

      {isArchiveIndex ? (
        <ArchiveShell
          records={archiveBrowserRecords}
          selectedId={selectedArtwork.id}
          onSelect={(artworkId) => dispatch({ type: "SELECT_ARTWORK", artworkId })}
          onOpen={(artworkId) => dispatch({ type: "OPEN_ARTWORK_BROWSER", artworkId })}
        />
      ) : null}

      {state.phase === "artworkBrowser" ? (
        <ArtworkBrowser
          records={archiveBrowserRecords}
          selectedId={selectedArtwork.id}
          onSelect={(artworkId) => dispatch({ type: "SELECT_ARTWORK", artworkId })}
          onOpen={(artworkId) => dispatch({ type: "OPEN_ARTWORK", artworkId })}
          onBack={() => dispatch({ type: "CLOSE_ARTWORK_BROWSER" })}
        />
      ) : null}

      {state.phase === "artworkDetail" ? (
        <ArtworkDetail
          artwork={selectedArtwork}
          onBack={() => dispatch({ type: "CLOSE_ARTWORK" })}
          onPrevious={() => dispatch({ type: "SELECT_ARTWORK", artworkId: previousArtwork.id })}
          onNext={() => dispatch({ type: "SELECT_ARTWORK", artworkId: nextArtwork.id })}
          onUseAsContext={() => dispatch({ type: "START_UPLOAD" })}
        />
      ) : null}

      {state.phase === "upload" ? (
        <PersonalArtifactFlow
          draft={state.uploadDraft}
          onDraftChange={(patch) => dispatch({ type: "UPDATE_UPLOAD_DRAFT", patch })}
          onSubmit={submitUpload}
          onCancel={() => dispatch({ type: "BACK_TO_EARTH" })}
        />
      ) : null}

      {state.phase === "generating" ? (
        <GenerationProgress
          draft={state.uploadDraft}
          deterministic={state.qaState === "generation-progress"}
          reduceMotion={reduceMotion}
        />
      ) : null}

      {state.phase === "pointPlaced" && selectedMoment ? (
        <PointPlacedConfirmation
          moment={selectedMoment}
          onReturn={() => dispatch({ type: "RETURN_TO_EARTH" })}
          onAddAnother={addAnotherMoment}
        />
      ) : null}

      {state.phase === "earthReturn" && selectedMoment ? (
        <button
          className={`personal-point-entry ${galleryFocusPending ? "is-focusing" : ""}`}
          type="button"
          disabled={galleryFocusPending}
          onClick={focusPersonalPoint}
        >
          <span>{galleryFocusPending ? "YOUR ORBIT · FOCUSING" : "YOUR ORBIT · OPEN"}</span>
          <strong>{selectedMoment.title}</strong>
          <small>{selectedMoment.place} · {selectedMoment.year}</small>
        </button>
      ) : null}

      {state.phase === "personalGallery" ? (
        <PersonalGalleryRoute
          moments={state.personalMoments}
          selectedMomentId={state.selectedMomentId}
          reduceMotion={reduceMotion}
          onOpen={(momentId) => dispatch({ type: "OPEN_MOMENT", momentId })}
          onBackToEarth={() => dispatch({ type: "BACK_TO_EARTH" })}
          onAddMoment={addAnotherMoment}
        />
      ) : null}

      {state.phase === "momentDetail" && selectedMoment ? (
        <PersonalMomentDetail
          moment={selectedMoment}
          onBack={() => dispatch({ type: "CLOSE_MOMENT" })}
          onBackToEarth={() => dispatch({ type: "BACK_TO_EARTH" })}
        />
      ) : null}

      {showEarthScene ? (
        <aside className="scene-telemetry" aria-label="场景状态">
          <span>LAT {formatLatitude(telemetryPoint.lat)}</span>
          <span>LON {formatLongitude(telemetryPoint.lon)}</span>
          <span>ALT 0001.39</span>
        </aside>
      ) : null}

      {state.phase !== "personalGallery" && state.phase !== "momentDetail" ? (
        <SignalLog label={signalCopy.label} message={signalCopy.message} />
      ) : null}
    </main>
  );
}
