import { MAX_PERSONAL_MOMENTS, type ExperienceAction, type ExperienceState } from "./types";

export const EMPTY_UPLOAD_DRAFT = {
  title: "",
  note: "",
  year: "",
  place: "",
} as const;

export function createInitialExperienceState(): ExperienceState {
  return {
    phase: "earthIntro",
    globeMode: "particleSphere",
    selectedArtworkId: null,
    selectedMomentId: null,
    focusedPoint: null,
    uploadDraft: { ...EMPTY_UPLOAD_DRAFT },
    personalMoments: [],
    transitionDirection: "still",
    qaState: null,
  };
}

export function experienceReducer(
  state: ExperienceState,
  action: ExperienceAction,
): ExperienceState {
  switch (action.type) {
    case "ENTER_ARCHIVE":
      return {
        ...state,
        phase: "archive",
        globeMode: "archiveBurst",
        transitionDirection: "forward",
      };
    case "OPEN_ARTWORK_BROWSER":
      return {
        ...state,
        phase: "artworkBrowser",
        globeMode: "archiveBurst",
        selectedArtworkId:
          action.artworkId ?? state.selectedArtworkId ?? "china-han-dancer",
        transitionDirection: "forward",
      };
    case "SELECT_ARTWORK":
      return {
        ...state,
        selectedArtworkId: action.artworkId,
        transitionDirection: "still",
      };
    case "CLOSE_ARTWORK_BROWSER":
      return {
        ...state,
        phase: "archive",
        globeMode: "archiveBurst",
        transitionDirection: "back",
      };
    case "OPEN_ARTWORK":
      return {
        ...state,
        phase: "artworkDetail",
        selectedArtworkId: action.artworkId,
        transitionDirection: "forward",
      };
    case "CLOSE_ARTWORK":
      return {
        ...state,
        phase: "artworkBrowser",
        transitionDirection: "back",
      };
    case "START_UPLOAD":
      return {
        ...state,
        phase: "upload",
        transitionDirection: "forward",
      };
    case "UPDATE_UPLOAD_DRAFT":
      return {
        ...state,
        uploadDraft: { ...state.uploadDraft, ...action.patch },
      };
    case "SUBMIT_UPLOAD":
      return {
        ...state,
        phase: "generating",
        transitionDirection: "forward",
      };
    case "POINT_PLACED":
      return {
        ...state,
        phase: "pointPlaced",
        globeMode: "focusPoint",
        focusedPoint: action.moment.point,
        selectedMomentId: action.moment.id,
        personalMoments: [
          action.moment,
          ...state.personalMoments.filter((moment) => moment.id !== action.moment.id),
        ].slice(0, MAX_PERSONAL_MOMENTS),
        transitionDirection: "forward",
      };
    case "RETURN_TO_EARTH":
      return {
        ...state,
        phase: "earthReturn",
        globeMode: "focusPoint",
        transitionDirection: "back",
      };
    case "OPEN_PERSONAL_GALLERY":
      return {
        ...state,
        phase: "personalGallery",
        transitionDirection: "forward",
      };
    case "OPEN_MOMENT":
      return {
        ...state,
        phase: "momentDetail",
        selectedMomentId: action.momentId,
        transitionDirection: "forward",
      };
    case "CLOSE_MOMENT":
      return {
        ...state,
        phase: "personalGallery",
        transitionDirection: "back",
      };
    case "BACK_TO_EARTH":
      return {
        ...state,
        phase: state.focusedPoint ? "earthReturn" : "earthIntro",
        globeMode: state.focusedPoint ? "focusPoint" : "particleSphere",
        transitionDirection: "back",
      };
  }
}
