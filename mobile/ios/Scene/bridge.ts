import type { Journey, JourneyRoute } from "../../../src/journey/types";
import { isLightEffectId } from "../../../src/journey/lightEffects";
import { resolveRoutePointTimes } from "../../../src/journey/globeTimeline";

/** One version for snapshots, scene events and native commands (Swift `SceneContract.version`). */
export const CONTRACT_VERSION = 2;

export type Selection = { journeyId: string; routePointId?: string | null; assetId?: string | null; revision: number; requestId: string };
export type SceneJourney = Pick<Journey, "id" | "title" | "startedOn" | "endedOn" | "note" | "lightColor" | "revision" | "lightEffect" | "routeSegments"> & {
  routePoints: Pick<Journey["routePoints"][number], "id" | "latitude" | "longitude" | "label" | "isStop" | "occurredAt">[];
  media: Pick<Journey["media"][number], "id" | "routePointId" | "fileName" | "mimeType" | "bytes">[];
};
export type Snapshot = { version: typeof CONTRACT_VERSION; scopeId: string; revision: number; access: "owner" | "guest";
  earthExperience: "default" | "particle-only"; journeys: SceneJourney[]; selection?: Selection | null; active: boolean };
export type SceneEvent = { version: typeof CONTRACT_VERSION; kind: "ready" | "select" | "story" | "invalidate" | "cameraInterrupted" | "rendered" | "switchAccess";
  scopeId: string; revision: number; requestId: string; journeyId?: string; routePointId?: string; assetId?: string; focusRequestId?: string };

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const text = (value: unknown): value is string => typeof value === "string";
const optionalId = (value: unknown) => value == null || id(value);
const uuid = (value: unknown) => typeof value === "string" && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);

export function decodeSnapshot(value: unknown): Snapshot {
  if (!object(value) || value.version !== CONTRACT_VERSION || !id(value.scopeId) || !integer(value.revision)
    || !["owner", "guest"].includes(String(value.access)) || !["default", "particle-only"].includes(String(value.earthExperience))
    || typeof value.active !== "boolean" || !Array.isArray(value.journeys)) throw Error("invalid-snapshot");
  const journeyIds = new Set<string>();
  for (const journey of value.journeys) {
    if (!object(journey) || !id(journey.id) || journeyIds.has(journey.id) || !integer(journey.revision)
      || !text(journey.title) || !text(journey.startedOn) || !text(journey.note) || !text(journey.lightColor)
      || !(journey.endedOn == null || text(journey.endedOn)) || !Array.isArray(journey.routePoints) || !Array.isArray(journey.media)) throw Error("invalid-journey");
    if ((journey.lightEffect != null && !isLightEffectId(journey.lightEffect))
      || (journey.routeSegments != null && !Array.isArray(journey.routeSegments))) throw Error("invalid-journey-presentation");
    journeyIds.add(journey.id);
    const points = new Set<string>();
    for (const point of journey.routePoints) {
      if (!object(point) || !id(point.id) || points.has(point.id) || !text(point.label) || typeof point.isStop !== "boolean"
        || !Number.isFinite(point.latitude) || Math.abs(Number(point.latitude)) > 90
        || !Number.isFinite(point.longitude) || Math.abs(Number(point.longitude)) > 180) throw Error("invalid-point");
      points.add(point.id);
    }
    const assets = new Set<string>();
    for (const asset of journey.media) {
      if (!object(asset) || !id(asset.id) || assets.has(asset.id) || !optionalId(asset.routePointId)
        || (asset.routePointId != null && !points.has(String(asset.routePointId)))
        || !text(asset.fileName) || !text(asset.mimeType) || !integer(asset.bytes)) throw Error("invalid-asset");
      assets.add(asset.id);
    }
  }
  if (value.selection != null) {
    const selection = value.selection;
    if (!object(selection) || !id(selection.journeyId) || !optionalId(selection.routePointId)
      || !optionalId(selection.assetId) || !integer(selection.revision) || !uuid(selection.requestId)) throw Error("invalid-selection");
    const journey = (value.journeys as SceneJourney[]).find((j) => j.id === selection.journeyId);
    if (!journey || journey.revision !== selection.revision
      || (selection.routePointId != null && !journey.routePoints.some((p) => p.id === selection.routePointId))
      || (selection.assetId != null && !journey.media.some((m) => m.id === selection.assetId && (selection.routePointId == null || m.routePointId === selection.routePointId)))) throw Error("stale-selection");
  }
  return value as Snapshot;
}

// Rendering adapter only: synthetic bookkeeping never goes to an owner API.
export function renderJourneys(snapshot: Snapshot): Journey[] {
  return snapshot.journeys.map((journey) => ({ ...journey, atlasId: "", createdByUserId: "", createdAt: "", updatedAt: "",
    routePoints: journey.routePoints.map((point, index) => ({ ...point, journeyId: journey.id, sortOrder: index, createdAt: "" })),
    media: journey.media.map((asset, index) => ({ ...asset, journeyId: journey.id, sortOrder: index, createdAt: "" })),
  }));
}

// ParticleEarthScene gives a non-empty route precedence over a point.
// An explicit or scrubbed Route Point must suppress that route-fit command.
export function atlasSceneFocus(point: { latitude: number; longitude: number } | undefined, route: JourneyRoute | undefined) {
  return point
    ? { focusPoint: { lat: point.latitude, lon: point.longitude }, focusRoute: null }
    : { focusPoint: null, focusRoute: route ?? null };
}

export function acceptsSnapshot(current: Snapshot | null, next: Snapshot) {
  return !current || current.scopeId !== next.scopeId || next.revision >= current.revision;
}

/// System low-vision settings; they shape globe labels only, never the snapshot or its revision.
export type SceneAccessibility = {
  textScale: number;
  accessibilitySize: boolean;
  boldText: boolean;
  increasedContrast: boolean;
};

declare global {
  interface Window {
    atlasNative: {
      receive: (json: string) => void;
      command: (json: string) => void;
      setAccessibility: (settings: SceneAccessibility) => void;
    };
    webkit?: { messageHandlers?: { atlas?: { postMessage: (body: string) => void } } };
  }
}

// The snapshot could not be decoded, so there is no trusted scope or revision to echo.
export function sendSceneFailure() {
  const message = { version: CONTRACT_VERSION, kind: "sceneFailed", requestId: crypto.randomUUID() };
  window.webkit?.messageHandlers?.atlas?.postMessage(JSON.stringify(message));
}

// Decode a native snapshot; on failure, tell native so its reload control appears.
export function decodeSnapshotOrReport(json: string): Snapshot | null {
  try { return decodeSnapshot(JSON.parse(json)); }
  catch { sendSceneFailure(); return null; }
}

export function send(snapshot: Snapshot, kind: SceneEvent["kind"], target: Partial<Pick<SceneEvent, "journeyId" | "routePointId" | "assetId" | "focusRequestId">> = {}) {
  const message: SceneEvent = { version: CONTRACT_VERSION, kind, scopeId: snapshot.scopeId, revision: snapshot.revision,
    requestId: crypto.randomUUID(), ...target };
  window.webkit?.messageHandlers?.atlas?.postMessage(JSON.stringify(message));
}

// Native -> scene presentation commands. They carry the live scope/revision but
// never bump it, so a layout change cannot stale-reject in-flight scene events.
export type TimeWindow = { start: string; end: string };
export type CameraInsets = { top: number; bottom: number };
export type LabelPreferences = { language: "zh" | "bilingual"; showPlaceNames: boolean };
export type SceneCommand =
  | { kind: "focus"; requestId: string; journeyId: string; routePointId: string | null }
  | { kind: "timeWindow"; requestId: string; window: TimeWindow | null }
  | { kind: "chrome"; requestId: string; globeOnly: boolean }
  | { kind: "insets"; requestId: string; insets: CameraInsets }
  | { kind: "labels"; requestId: string; labels: LabelPreferences };

const day = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
const inset = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 4096;
const absent = (command: Record<string, unknown>, ...keys: string[]) => keys.every((key) => command[key] == null);

/** Mirrors Swift `validateSceneCommand`; both run `Fixtures/bridge.json`. */
export function decodeCommand(value: unknown, snapshot: Snapshot | null): SceneCommand {
  if (!object(value) || value.version !== CONTRACT_VERSION || !uuid(value.requestId)) throw Error("invalid-command");
  if (!snapshot || value.scopeId !== snapshot.scopeId || value.revision !== snapshot.revision) throw Error("stale-command");
  const requestId = value.requestId as string;
  if (value.kind !== "labels" && value.labels != null) throw Error("invalid-command");
  switch (value.kind) {
    case "labels": {
      const labels = value.labels;
      if (!absent(value, "journeyId", "routePointId", "window", "globeOnly", "insets") || !object(labels)
        || (labels.language !== "zh" && labels.language !== "bilingual") || typeof labels.showPlaceNames !== "boolean") throw Error("invalid-command");
      return { kind: "labels", requestId, labels: { language: labels.language, showPlaceNames: labels.showPlaceNames } };
    }
    case "focus": {
      if (!absent(value, "window", "globeOnly", "insets")) throw Error("invalid-command");
      const journey = snapshot.journeys.find((candidate) => candidate.id === value.journeyId);
      if (!journey) throw Error("unknown-target");
      if (value.routePointId != null && !journey.routePoints.some((point) => point.id === value.routePointId)) throw Error("unknown-target");
      return { kind: "focus", requestId, journeyId: journey.id, routePointId: (value.routePointId as string | undefined) ?? null };
    }
    case "timeWindow": {
      if (!absent(value, "journeyId", "routePointId", "globeOnly", "insets")) throw Error("invalid-command");
      const window = value.window;
      if (window == null) return { kind: "timeWindow", requestId, window: null };
      if (!object(window) || !day(window.start) || !day(window.end) || window.start > window.end) throw Error("invalid-command");
      return { kind: "timeWindow", requestId, window: { start: window.start, end: window.end } };
    }
    case "chrome":
      if (!absent(value, "journeyId", "routePointId", "window", "insets") || typeof value.globeOnly !== "boolean") throw Error("invalid-command");
      return { kind: "chrome", requestId, globeOnly: value.globeOnly };
    case "insets": {
      const insets = value.insets;
      if (!absent(value, "journeyId", "routePointId", "window", "globeOnly") || !object(insets)
        || !inset(insets.top) || !inset(insets.bottom)) throw Error("invalid-command");
      return { kind: "insets", requestId, insets: { top: Number(insets.top), bottom: Number(insets.bottom) } };
    }
    default: throw Error("invalid-command");
  }
}

/** Decode a command or drop it: a stale or malformed command never changes the scene. */
export function decodeCommandOrDrop(json: string, snapshot: Snapshot | null): SceneCommand | null {
  try { return decodeCommand(JSON.parse(json), snapshot); } catch { return null; }
}

const dayEnd = (value: string) => Date.parse(value + "T23:59:59.999Z");
const dayStart = (value: string) => Date.parse(value + "T00:00:00.000Z");

/**
 * Reveal for a native time window: Journeys and Route Points dated inside
 * [start, end] are drawn; anything later stays hidden, as on the web scrubber.
 * Undated Journeys stay visible. Keys match `useGlobeTimeCursor`.
 */
export function windowReveal(journeys: readonly Journey[], window: TimeWindow) {
  const start = dayStart(window.start);
  const end = dayEnd(window.end);
  const journeyProgress = new Map<string, number>();
  const pointProgress = new Map<string, number>();
  for (const journey of journeys) {
    const began = Date.parse(journey.startedOn);
    if (!Number.isFinite(began)) {
      journeyProgress.set(journey.id, 1);
      journey.routePoints.forEach((_, index) => pointProgress.set(`${journey.id}:${index}`, 1));
      continue;
    }
    const ended = journey.endedOn ? dayEnd(journey.endedOn) : dayEnd(journey.startedOn);
    const visible = began <= end && ended >= start;
    const span = Math.max(1, ended - began);
    journeyProgress.set(journey.id, !visible ? 0 : Math.min(1, Math.max(0, (end - began) / span)));
    for (const point of resolveRoutePointTimes(journey)) {
      pointProgress.set(`${journey.id}:${point.index}`, visible && Number.isFinite(point.timeMs) && point.timeMs <= end ? 1 : 0);
    }
  }
  return { journeyProgress, pointProgress };
}
