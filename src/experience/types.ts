export type ExperiencePhase =
  | "earthIntro"
  | "archive"
  | "artworkBrowser"
  | "artworkDetail"
  | "upload"
  | "generating"
  | "pointPlaced"
  | "earthReturn"
  | "personalGallery"
  | "momentDetail";

export type GlobeMode =
  | "particleSphere"
  | "archiveBurst"
  | "surfaceEarth"
  | "focusPoint";

export type TransitionDirection = "forward" | "back" | "still";

export const MAX_PERSONAL_MOMENTS = 12;

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface ArchiveRecord {
  id: string;
  title: string;
  artist: string;
  year: string;
  region: string;
  imageUrl: string;
  point: GeoPoint;
  provenance: string;
  culture?: string;
  medium?: string;
  description?: string;
  collectionUrl?: string;
  accessionNumber?: string;
}

export interface PersonalMoment {
  id: string;
  title: string;
  year: string;
  place: string;
  note?: string;
  imageUrl: string;
  previewUrl?: string;
  lightColor?: string;
  point: GeoPoint;
}

export interface UploadDraft {
  title: string;
  note: string;
  year: string;
  place: string;
  imageUrl?: string;
  previewUrl?: string;
  lightColor?: string;
  point?: GeoPoint;
}

export interface ExperienceState {
  phase: ExperiencePhase;
  globeMode: GlobeMode;
  selectedArtworkId: string | null;
  selectedMomentId: string | null;
  focusedPoint: GeoPoint | null;
  uploadDraft: UploadDraft;
  personalMoments: PersonalMoment[];
  transitionDirection: TransitionDirection;
  qaState: string | null;
}

export type ExperienceAction =
  | { type: "ENTER_ARCHIVE" }
  | { type: "OPEN_ARTWORK_BROWSER"; artworkId?: string }
  | { type: "SELECT_ARTWORK"; artworkId: string }
  | { type: "CLOSE_ARTWORK_BROWSER" }
  | { type: "OPEN_ARTWORK"; artworkId: string }
  | { type: "CLOSE_ARTWORK" }
  | { type: "START_UPLOAD" }
  | { type: "UPDATE_UPLOAD_DRAFT"; patch: Partial<UploadDraft> }
  | { type: "SUBMIT_UPLOAD" }
  | { type: "POINT_PLACED"; moment: PersonalMoment }
  | { type: "RETURN_TO_EARTH" }
  | { type: "OPEN_PERSONAL_GALLERY" }
  | { type: "OPEN_MOMENT"; momentId: string }
  | { type: "CLOSE_MOMENT" }
  | { type: "BACK_TO_EARTH" };
