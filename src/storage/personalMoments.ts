import type {
  GeoPoint,
  PersonalMoment,
  UploadDraft,
} from "../experience/types";
import { MAX_PERSONAL_MOMENTS } from "../experience/types";

export const PERSONAL_MOMENTS_STORAGE_KEY =
  "art-history-twin:personal-moments";

const KNOWN_PLACES: Record<string, GeoPoint> = {
  "los angeles": { lat: 34.0522, lon: -118.2437 },
  "洛杉矶": { lat: 34.0522, lon: -118.2437 },
  paris: { lat: 48.8566, lon: 2.3522 },
  beijing: { lat: 39.9042, lon: 116.4074 },
  "北京": { lat: 39.9042, lon: 116.4074 },
  florence: { lat: 43.7696, lon: 11.2558 },
  firenze: { lat: 43.7696, lon: 11.2558 },
  "佛罗伦萨": { lat: 43.7696, lon: 11.2558 },
};

function normalizeText(value: string, maxLength: number): string {
  return value.trim().replace(/\s+/g, " ").slice(0, maxLength);
}

export function normalizeUploadDraft(draft: UploadDraft): UploadDraft {
  return {
    title: normalizeText(draft.title, 48),
    note: normalizeText(draft.note, 160),
    year: normalizeText(draft.year, 12),
    place: normalizeText(draft.place, 64),
    ...(draft.imageUrl ? { imageUrl: draft.imageUrl } : {}),
    ...(draft.previewUrl ? { previewUrl: draft.previewUrl } : {}),
    ...(draft.lightColor ? { lightColor: draft.lightColor } : {}),
    ...(draft.point ? { point: { ...draft.point } } : {}),
  };
}

function hashText(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function coordinatesForPlace(place: string): GeoPoint {
  const normalizedPlace = normalizeText(place, 64).toLocaleLowerCase();
  const knownPoint = KNOWN_PLACES[normalizedPlace];
  if (knownPoint) {
    return { ...knownPoint };
  }
  if (!normalizedPlace) {
    return { lat: 0, lon: -135 };
  }

  const firstHash = hashText(normalizedPlace);
  const secondHash = hashText(`${normalizedPlace}:longitude`);
  return {
    lat: Number((-70 + (firstHash / 0xffffffff) * 140).toFixed(4)),
    lon: Number((-180 + (secondHash / 0xffffffff) * 360).toFixed(4)),
  };
}

function isPoint(value: unknown): value is GeoPoint {
  if (!value || typeof value !== "object") return false;
  const point = value as Partial<GeoPoint>;
  return Boolean(
    Number.isFinite(point.lat)
      && Number.isFinite(point.lon)
      && (point.lat as number) >= -90
      && (point.lat as number) <= 90
      && (point.lon as number) >= -180
      && (point.lon as number) <= 180,
  );
}

function isPersonalMoment(value: unknown): value is PersonalMoment {
  if (!value || typeof value !== "object") return false;
  const moment = value as Partial<PersonalMoment>;
  return Boolean(
    typeof moment.id === "string"
      && typeof moment.title === "string"
      && typeof moment.year === "string"
      && typeof moment.place === "string"
      && typeof moment.imageUrl === "string"
      && (moment.previewUrl === undefined || typeof moment.previewUrl === "string")
      && (moment.lightColor === undefined || typeof moment.lightColor === "string")
      && (moment.note === undefined || typeof moment.note === "string")
      && isPoint(moment.point),
  );
}

function resolveStorage(storage: Storage | null | undefined): Storage | null {
  if (storage !== undefined) return storage;
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function loadPersonalMoments(
  storage?: Storage | null,
): PersonalMoment[] {
  const resolvedStorage = resolveStorage(storage);
  if (!resolvedStorage) return [];
  try {
    const serialized = resolvedStorage.getItem(PERSONAL_MOMENTS_STORAGE_KEY);
    if (!serialized) return [];
    const value: unknown = JSON.parse(serialized);
    if (!Array.isArray(value)) return [];
    return value
      .filter(isPersonalMoment)
      .filter((moment) => !moment.imageUrl.startsWith("blob:"))
      .slice(0, MAX_PERSONAL_MOMENTS)
      .map((moment) => ({ ...moment, point: { ...moment.point } }));
  } catch {
    return [];
  }
}

export function savePersonalMoments(
  moments: PersonalMoment[],
  storage?: Storage | null,
): boolean {
  const resolvedStorage = resolveStorage(storage);
  if (!resolvedStorage) return false;
  try {
    const validMoments = moments
      .filter(isPersonalMoment)
      .slice(0, MAX_PERSONAL_MOMENTS);
    resolvedStorage.setItem(
      PERSONAL_MOMENTS_STORAGE_KEY,
      JSON.stringify(validMoments),
    );
    return true;
  } catch {
    return false;
  }
}
