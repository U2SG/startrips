import type { Journey } from "../../../src/journey/types";
import { isLightEffectId } from "../../../src/journey/lightEffects";

export type Selection = { journeyId: string; routePointId?: string | null; assetId?: string | null; revision: number; requestId: string };
export type SceneJourney = Pick<Journey, "id" | "title" | "startedOn" | "endedOn" | "note" | "lightColor" | "revision" | "lightEffect" | "routeSegments"> & {
  routePoints: Pick<Journey["routePoints"][number], "id" | "latitude" | "longitude" | "label" | "isStop" | "occurredAt">[];
  media: Pick<Journey["media"][number], "id" | "routePointId" | "fileName" | "mimeType" | "bytes">[];
};
export type Snapshot = { version: 1; scopeId: string; revision: number; access: "owner" | "guest";
  earthExperience: "default" | "particle-only"; journeys: SceneJourney[]; selection?: Selection | null; active: boolean };
export type SceneEvent = { version: 1; kind: "ready" | "select" | "story" | "invalidate" | "cameraInterrupted" | "rendered";
  scopeId: string; revision: number; requestId: string; journeyId?: string; routePointId?: string; assetId?: string; focusRequestId?: string };

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const text = (value: unknown): value is string => typeof value === "string";
const optionalId = (value: unknown) => value == null || id(value);
const uuid = (value: unknown) => typeof value === "string" && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);

export function decodeSnapshot(value: unknown): Snapshot {
  if (!object(value) || value.version !== 1 || !id(value.scopeId) || !integer(value.revision)
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

export function acceptsSnapshot(current: Snapshot | null, next: Snapshot) {
  return !current || current.scopeId !== next.scopeId || next.revision >= current.revision;
}

declare global {
  interface Window {
    atlasNative: { receive: (json: string) => void };
    webkit?: { messageHandlers?: { atlas?: { postMessage: (body: string) => void } } };
  }
}

export function send(snapshot: Snapshot, kind: SceneEvent["kind"], target: Partial<Pick<SceneEvent, "journeyId" | "routePointId" | "assetId" | "focusRequestId">> = {}) {
  const message: SceneEvent = { version: 1, kind, scopeId: snapshot.scopeId, revision: snapshot.revision,
    requestId: crypto.randomUUID(), ...target };
  window.webkit?.messageHandlers?.atlas?.postMessage(JSON.stringify(message));
}
