import { createInitialExperienceState } from "./reducer";
import type { ExperienceState, PersonalMoment, UploadDraft } from "./types";

export const QA_STATE_IDS = [
  "earth-intro",
  "archive-burst",
  "brand-transition",
  "earth-surface",
  "archive-index",
  "artwork-browser",
  "artwork-detail",
  "upload-empty",
  "upload-filled",
  "upload-ready",
  "generation-progress",
  "point-generated",
  "earth-return",
  "personal-gallery",
  "moment-detail",
] as const;

export type QaStateId = (typeof QA_STATE_IDS)[number];

const qaPartialDraft: UploadDraft = {
  title: "kobe with",
  note: "",
  year: "",
  place: "",
  imageUrl: "/qa/upload-filled-artwork.jpg",
  previewUrl: "/qa/upload-filled-artwork.jpg",
  lightColor: "#f4ce73",
};

const qaReadyDraft: UploadDraft = {
  title: "kobe with gianna.",
  note: "我记忆深刻的瞬间",
  year: "2020",
  place: "洛杉矶",
  imageUrl: "/qa/upload-filled-artwork.jpg",
  point: { lat: 34.0522, lon: -118.2437 },
};

const qaMoment: PersonalMoment = {
  id: "qa-personal-001",
  title: qaReadyDraft.title,
  note: qaReadyDraft.note,
  year: qaReadyDraft.year,
  place: qaReadyDraft.place,
  imageUrl: qaReadyDraft.imageUrl ?? "",
  previewUrl: qaReadyDraft.previewUrl,
  lightColor: qaReadyDraft.lightColor,
  point: { lat: 0, lon: -135 },
};

export function isQaStateId(value: string | null): value is QaStateId {
  return value !== null && QA_STATE_IDS.includes(value as QaStateId);
}

export function hydrateQaState(id: QaStateId | string | null): ExperienceState {
  const state = createInitialExperienceState();
  if (!isQaStateId(id)) return state;

  const base = { ...state, qaState: id, transitionDirection: "still" as const };

  switch (id) {
    case "earth-intro":
      return base;
    case "archive-burst":
      return { ...base, phase: "archive", globeMode: "archiveBurst" };
    case "brand-transition":
      return { ...base, phase: "archive", globeMode: "surfaceEarth" };
    case "earth-surface":
      return { ...base, phase: "archive", globeMode: "surfaceEarth" };
    case "archive-index":
      return {
        ...base,
        phase: "archive",
        globeMode: "archiveBurst",
        selectedArtworkId: "china-han-dancer",
      };
    case "artwork-browser":
      return {
        ...base,
        phase: "artworkBrowser",
        globeMode: "archiveBurst",
        selectedArtworkId: "china-han-dancer",
      };
    case "artwork-detail":
      return {
        ...base,
        phase: "artworkDetail",
        globeMode: "archiveBurst",
        selectedArtworkId: "china-han-dancer",
      };
    case "upload-empty":
      return { ...base, phase: "upload", globeMode: "surfaceEarth" };
    case "upload-filled":
      return {
        ...base,
        phase: "upload",
        globeMode: "surfaceEarth",
        uploadDraft: { ...qaPartialDraft },
      };
    case "upload-ready":
      return {
        ...base,
        phase: "upload",
        globeMode: "surfaceEarth",
        uploadDraft: {
          ...qaReadyDraft,
          point: qaReadyDraft.point && { ...qaReadyDraft.point },
        },
      };
    case "generation-progress":
      return {
        ...base,
        phase: "generating",
        globeMode: "focusPoint",
        focusedPoint: { ...qaMoment.point },
        uploadDraft: {
          ...qaReadyDraft,
          point: qaReadyDraft.point && { ...qaReadyDraft.point },
        },
      };
    case "point-generated":
      return {
        ...base,
        phase: "pointPlaced",
        globeMode: "focusPoint",
        focusedPoint: { ...qaMoment.point },
        uploadDraft: {
          ...qaReadyDraft,
          point: qaReadyDraft.point && { ...qaReadyDraft.point },
        },
        selectedMomentId: qaMoment.id,
        personalMoments: [{ ...qaMoment, point: { ...qaMoment.point } }],
      };
    case "earth-return":
      return {
        ...base,
        phase: "earthReturn",
        globeMode: "focusPoint",
        focusedPoint: { ...qaMoment.point },
        selectedMomentId: qaMoment.id,
        personalMoments: [{ ...qaMoment, point: { ...qaMoment.point } }],
      };
    case "personal-gallery":
      return {
        ...base,
        phase: "personalGallery",
        globeMode: "focusPoint",
        focusedPoint: { ...qaMoment.point },
        selectedMomentId: qaMoment.id,
        personalMoments: [{ ...qaMoment, point: { ...qaMoment.point } }],
      };
    case "moment-detail":
      return {
        ...base,
        phase: "momentDetail",
        globeMode: "focusPoint",
        focusedPoint: { ...qaMoment.point },
        selectedMomentId: qaMoment.id,
        personalMoments: [{ ...qaMoment, point: { ...qaMoment.point } }],
      };
  }
}
