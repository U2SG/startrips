import type { Journey, JourneyMediaAsset, RoutePoint } from "./types";

export type MediaSpatialSource = "exif" | "container-metadata" | "imported" | "unknown";
export type MediaSpatialGranularity = "coordinate" | "city" | "unknown";
export type MediaCaptureTimeSource = "exif-original" | "exif-digitized" | "gps" | "container-metadata" | "imported" | "unknown";
export type MediaTimezoneState = "offset-known" | "local-only" | "unknown";

export type MediaPlacementSignal = {
  latitude?: number;
  longitude?: number;
  /** ISO timestamp when metadata supplies an explicit offset or UTC instant. */
  capturedAt?: string;
  /** Wall-clock timestamp when the source omits timezone information. */
  capturedLocal?: string;
  spatialSource?: MediaSpatialSource;
  spatialGranularity?: MediaSpatialGranularity;
  accuracyMeters?: number | null;
  captureTimeSource?: MediaCaptureTimeSource;
  timezoneState?: MediaTimezoneState;
  offsetMinutes?: number | null;
};

export type MediaPlacementReadResult =
  | { status: "signal"; signal: MediaPlacementSignal }
  | { status: "no-evidence" }
  | { status: "unsupported-format" };

export type MediaPlacementSuggestion = {
  journeyId: string;
  routePointId: string | null;
  score: number;
  confidence: "high";
  evidence: readonly ("gps" | "time" | "journey-date" | "current-context")[];
  distanceKm?: number;
  timeDeltaHours?: number;
};

export type MediaPlacementSuggestionGroup = {
  journeyId: string;
  routePointId: string | null;
  fileIndexes: number[];
  suggestion: MediaPlacementSuggestion;
};

export type MediaPlacementBatchResult = {
  groups: MediaPlacementSuggestionGroup[];
  unsuggestedFileIndexes: number[];
};

export type MediaPlacementUploadGroup = {
  journeyId: string;
  routePointId: string | null;
  fileIndexes: number[];
};

/**
 * Returns an upload-safe grouped plan only when every selected file has exactly
 * one confident destination. The plan preserves original selection order within
 * each destination and orders groups by their first selected file.
 */
export function completeMediaPlacementUploadPlan(
  batch: MediaPlacementBatchResult,
  fileCount: number,
): MediaPlacementUploadGroup[] | null {
  if (fileCount <= 0 || batch.unsuggestedFileIndexes.length > 0 || batch.groups.length === 0) {
    return null;
  }
  const seen = new Set<number>();
  const groups: MediaPlacementUploadGroup[] = [];
  for (const group of batch.groups) {
    const indexes = [...group.fileIndexes].sort((left, right) => left - right);
    if (indexes.length === 0) return null;
    for (const index of indexes) {
      if (!Number.isInteger(index) || index < 0 || index >= fileCount || seen.has(index)) return null;
      seen.add(index);
    }
    groups.push({
      journeyId: group.journeyId,
      routePointId: group.routePointId,
      fileIndexes: indexes,
    });
  }
  if (seen.size !== fileCount) return null;
  return groups.sort((left, right) => left.fileIndexes[0] - right.fileIndexes[0]);
}

const GPS_STRONG_DISTANCE_KM = 25;
const TIME_STRONG_DELTA_HOURS = 24;
const MIN_ROUTE_SCORE = 0.58;
const MIN_JOURNEY_SCORE = 0.5;
const MIN_SCORE_MARGIN = 0.09;

function safeDateMs(value: string | null | undefined) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isValidCalendarDate(year: number, month: number, day: number) {
  if (year <= 0 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const normalized = new Date(0);
  normalized.setUTCFullYear(year, month - 1, day);
  normalized.setUTCHours(0, 0, 0, 0);
  return normalized.getUTCFullYear() === year
    && normalized.getUTCMonth() === month - 1
    && normalized.getUTCDate() === day;
}

function dateKey(value: string | undefined) {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})(?=$|T)/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return isValidCalendarDate(year, month, day)
    ? `${match[1]}-${match[2]}-${match[3]}`
    : null;
}

function signalDateKey(signal: MediaPlacementSignal) {
  return dateKey(signal.capturedLocal) ?? dateKey(signal.capturedAt);
}

function signalHasCoordinateEvidence(signal: MediaPlacementSignal) {
  if (!Number.isFinite(signal.latitude) || !Number.isFinite(signal.longitude)) return false;
  const hasExplicitSpatialSemantics = signal.spatialSource !== undefined
    || signal.spatialGranularity !== undefined;
  if (!hasExplicitSpatialSemantics) return true;
  return signal.spatialGranularity === "coordinate"
    && signal.spatialSource !== undefined
    && signal.spatialSource !== "unknown";
}

function dateOrdinal(value: string) {
  const key = dateKey(value);
  if (!key || key !== value) return null;
  const [year, month, day] = key.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function journeyContainsDate(journey: Journey, captureDate: string | null) {
  if (!captureDate) return false;
  const capture = dateOrdinal(captureDate);
  const start = dateOrdinal(journey.startedOn);
  const end = dateOrdinal(journey.endedOn ?? journey.startedOn);
  return capture !== null && start !== null && end !== null && capture >= start && capture <= end;
}

export function haversineDistanceKm(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
) {
  const radians = Math.PI / 180;
  const latA = latitudeA * radians;
  const latB = latitudeB * radians;
  const deltaLat = (latitudeB - latitudeA) * radians;
  const deltaLon = (longitudeB - longitudeA) * radians;
  const sinLat = Math.sin(deltaLat / 2);
  const sinLon = Math.sin(deltaLon / 2);
  const a = sinLat * sinLat + Math.cos(latA) * Math.cos(latB) * sinLon * sinLon;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

function spatialScore(distanceKm: number) {
  if (distanceKm <= 1) return 0.68;
  if (distanceKm <= 5) return 0.62;
  if (distanceKm <= 20) return 0.5;
  if (distanceKm <= 75) return 0.32;
  if (distanceKm <= 150) return 0.18;
  return 0;
}

function absoluteTimeEvidence(signal: MediaPlacementSignal, point: RoutePoint) {
  if (!signal.capturedAt || !point.occurredAt) return null;
  const capture = safeDateMs(signal.capturedAt);
  const occurred = safeDateMs(point.occurredAt);
  if (capture === null || occurred === null) return null;
  const hours = Math.abs(capture - occurred) / 3_600_000;
  let score = 0;
  if (hours <= 2) score = 0.48;
  else if (hours <= 8) score = 0.42;
  else if (hours <= 24) score = 0.34;
  else if (hours <= 72) score = 0.2;
  else if (hours <= 168) score = 0.1;
  return { score, hours };
}

function localDateTimeScore(signal: MediaPlacementSignal, point: RoutePoint) {
  if (signal.capturedAt || !signal.capturedLocal || !point.occurredAt) return 0;
  const captureDate = dateKey(signal.capturedLocal);
  const pointDate = dateKey(point.occurredAt);
  if (!captureDate || !pointDate) return 0;
  const captureOrdinal = dateOrdinal(captureDate);
  const pointOrdinal = dateOrdinal(pointDate);
  if (captureOrdinal === null || pointOrdinal === null) return 0;
  const days = Math.abs(captureOrdinal - pointOrdinal);
  if (days === 0) return 0.28;
  if (days === 1) return 0.1;
  return 0;
}

type Candidate = MediaPlacementSuggestion & {
  strongGps: boolean;
  strongTime: boolean;
};

function routeCandidate(
  signal: MediaPlacementSignal,
  journey: Journey,
  point: RoutePoint,
  currentJourneyId: string | null | undefined,
): Candidate | null {
  const hasGps = signalHasCoordinateEvidence(signal);
  const distanceKm = hasGps
    ? haversineDistanceKm(
      signal.latitude!,
      signal.longitude!,
      point.latitude,
      point.longitude,
    )
    : undefined;
  const gpsScore = distanceKm === undefined ? 0 : spatialScore(distanceKm);
  const absoluteTime = absoluteTimeEvidence(signal, point);
  const localTimeScore = localDateTimeScore(signal, point);
  const timeScore = absoluteTime?.score ?? localTimeScore;
  const containsDate = journeyContainsDate(journey, signalDateKey(signal));
  const contextBonus = journey.id === currentJourneyId ? 0.04 : 0;
  const score = gpsScore + timeScore + (containsDate ? 0.12 : 0) + contextBonus;
  if (gpsScore === 0 && timeScore === 0) return null;
  const evidence: Array<"gps" | "time" | "journey-date" | "current-context"> = [];
  if (gpsScore > 0) evidence.push("gps");
  if (timeScore > 0) evidence.push("time");
  if (containsDate) evidence.push("journey-date");
  if (contextBonus > 0) evidence.push("current-context");
  return {
    journeyId: journey.id,
    routePointId: point.id,
    score,
    confidence: "high",
    evidence,
    ...(distanceKm === undefined ? {} : { distanceKm }),
    ...(absoluteTime ? { timeDeltaHours: absoluteTime.hours } : {}),
    strongGps: distanceKm !== undefined && distanceKm <= GPS_STRONG_DISTANCE_KM,
    strongTime: Boolean(absoluteTime && absoluteTime.hours <= TIME_STRONG_DELTA_HOURS),
  };
}

function journeyCandidate(
  signal: MediaPlacementSignal,
  journey: Journey,
  currentJourneyId: string | null | undefined,
): Candidate | null {
  if (!journeyContainsDate(journey, signalDateKey(signal))) return null;
  const contextBonus = journey.id === currentJourneyId ? 0.04 : 0;
  return {
    journeyId: journey.id,
    routePointId: null,
    score: 0.52 + contextBonus,
    confidence: "high",
    evidence: contextBonus > 0
      ? ["journey-date", "current-context"]
      : ["journey-date"],
    strongGps: false,
    strongTime: false,
  };
}

function bestStrongGpsTarget(candidates: readonly Candidate[]) {
  return candidates
    .filter((candidate) => candidate.routePointId && candidate.strongGps)
    .sort((left, right) => (
      (left.distanceKm ?? Number.POSITIVE_INFINITY) - (right.distanceKm ?? Number.POSITIVE_INFINITY)
      || left.journeyId.localeCompare(right.journeyId)
      || (left.routePointId ?? "").localeCompare(right.routePointId ?? "")
    ))[0] ?? null;
}

function bestStrongTimeTarget(candidates: readonly Candidate[]) {
  return candidates
    .filter((candidate) => candidate.routePointId && candidate.strongTime)
    .sort((left, right) => (
      (left.timeDeltaHours ?? Number.POSITIVE_INFINITY) - (right.timeDeltaHours ?? Number.POSITIVE_INFINITY)
      || left.journeyId.localeCompare(right.journeyId)
      || (left.routePointId ?? "").localeCompare(right.routePointId ?? "")
    ))[0] ?? null;
}

/**
 * Deterministic, privacy-preserving placement scorer. It consumes only normalized
 * coordinates/timestamps; raw EXIF never leaves the browser parser.
 */
export function suggestMediaPlacement(
  signal: MediaPlacementSignal | null | undefined,
  journeys: readonly Journey[],
  currentJourneyId?: string | null,
): MediaPlacementSuggestion | null {
  if (!signal) return null;
  const hasGps = signalHasCoordinateEvidence(signal);
  const hasTime = Boolean(signal.capturedAt || signal.capturedLocal);
  if (!hasGps && !hasTime) return null;

  const routeCandidates = journeys.flatMap((journey) => journey.routePoints
    .map((point) => routeCandidate(signal, journey, point, currentJourneyId))
    .filter((candidate): candidate is Candidate => Boolean(candidate)));

  // Strong GPS and strong absolute-time evidence that point at different places
  // is a conflict, not permission to average two contradictory facts.
  const spatialTarget = bestStrongGpsTarget(routeCandidates);
  const temporalTarget = bestStrongTimeTarget(routeCandidates);
  if (
    spatialTarget
    && temporalTarget
    && (
      spatialTarget.journeyId !== temporalTarget.journeyId
      || spatialTarget.routePointId !== temporalTarget.routePointId
    )
  ) {
    return null;
  }

  const candidates = [
    ...routeCandidates,
    ...journeys
      .map((journey) => journeyCandidate(signal, journey, currentJourneyId))
      .filter((candidate): candidate is Candidate => Boolean(candidate)),
  ].sort((left, right) => (
    right.score - left.score
    || Number(right.routePointId !== null) - Number(left.routePointId !== null)
    || left.journeyId.localeCompare(right.journeyId)
    || (left.routePointId ?? "").localeCompare(right.routePointId ?? "")
  ));

  const best = candidates[0];
  if (!best) return null;
  const minimum = best.routePointId ? MIN_ROUTE_SCORE : MIN_JOURNEY_SCORE;
  if (best.score < minimum) return null;
  const second = candidates.find((candidate) => {
    if (candidate.journeyId === best.journeyId && candidate.routePointId === best.routePointId) {
      return false;
    }
    // A route point and its parent Journey are not competing destinations: the
    // point is simply the more specific form of the same ownership suggestion.
    if (best.routePointId && candidate.journeyId === best.journeyId && candidate.routePointId === null) {
      return false;
    }
    return true;
  });
  if (second && best.score - second.score < MIN_SCORE_MARGIN) return null;

  const { strongGps: _strongGps, strongTime: _strongTime, ...suggestion } = best;
  return suggestion;
}

export function groupMediaPlacementSuggestions(
  signals: readonly (MediaPlacementSignal | null | undefined)[],
  journeys: readonly Journey[],
  currentJourneyId?: string | null,
): MediaPlacementBatchResult {
  const groupsByDestination = new Map<string, MediaPlacementSuggestionGroup>();
  const unsuggestedFileIndexes: number[] = [];
  signals.forEach((signal, fileIndex) => {
    const suggestion = suggestMediaPlacement(signal, journeys, currentJourneyId);
    if (!suggestion) {
      unsuggestedFileIndexes.push(fileIndex);
      return;
    }
    const key = `${suggestion.journeyId}:${suggestion.routePointId ?? "journey"}`;
    const existing = groupsByDestination.get(key);
    if (existing) {
      existing.fileIndexes.push(fileIndex);
      // Keep the weakest score as the group confidence floor.
      if (suggestion.score < existing.suggestion.score) existing.suggestion = suggestion;
      return;
    }
    groupsByDestination.set(key, {
      journeyId: suggestion.journeyId,
      routePointId: suggestion.routePointId,
      fileIndexes: [fileIndex],
      suggestion,
    });
  });
  return {
    groups: [...groupsByDestination.values()].sort(
      (left, right) => left.fileIndexes[0] - right.fileIndexes[0],
    ),
    unsuggestedFileIndexes,
  };
}

/**
 * #335 / ST-114. These are planner bounds, not claims about a named place.
 * Keeping them exported makes the product contract and its fixtures inspectable.
 */
export const MEDIA_PLACEMENT_PROPOSAL_LIMITS = {
  neighborDistanceKm: 2,
  timeWindowHours: 12,
  maxClusterDiameterKm: 5,
  maxAutomaticAccuracyMeters: 500,
  maxPlausibleSpeedKmh: 1_200,
  maxInputs: 1_000,
} as const;

export const MEDIA_PLACEMENT_PROPOSAL_ALGORITHM_VERSION = "route-point-proposal-v1";

export type MediaPlacementProposalInput = Pick<
  JourneyMediaAsset,
  "contentHash" | "contentHashVerified"
> & {
  fileIndex: number;
  signal: MediaPlacementSignal | null | undefined;
};

export type MediaPlacementProposalBasis = {
  reason: string;
  evidence: readonly string[];
  uncertainty: readonly string[];
};

export type ExistingRoutePointProposal = {
  kind: "match-existing";
  journeyId: string;
  routePointId: string;
  fileIndexes: number[];
  basis: MediaPlacementProposalBasis;
};

export type NewRoutePointProposal = {
  kind: "suggest-new";
  candidateId: string;
  fileIndexes: number[];
  representative: {
    fileIndex: number;
    latitude: number;
    longitude: number;
  };
  basis: MediaPlacementProposalBasis;
};

export type PendingRoutePointProposal = {
  kind: "pending-confirmation";
  fileIndexes: number[];
  basis: MediaPlacementProposalBasis;
};

export type MediaPlacementProposalPlan = {
  algorithmVersion: typeof MEDIA_PLACEMENT_PROPOSAL_ALGORITHM_VERSION;
  scope: {
    batchId: string;
    journeyId: string;
    routeRevision: number;
  };
  matchExisting: ExistingRoutePointProposal[];
  suggestNew: NewRoutePointProposal[];
  pendingConfirmation: PendingRoutePointProposal[];
};

type ProposalTime = {
  kind: "absolute" | "local" | "unknown";
  value: number | null;
};

type ProposalIdentity = {
  key: string;
  fileIndexes: number[];
  representative: MediaPlacementProposalInput;
};

function safeAbsoluteProposalTime(signal: MediaPlacementSignal) {
  if (
    signal.timezoneState === "local-only"
    || signal.timezoneState === "unknown"
    || !signal.capturedAt
    || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(signal.capturedAt)
  ) return null;
  return safeDateMs(signal.capturedAt);
}

function safeLocalProposalTime(signal: MediaPlacementSignal) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/
    .exec(signal.capturedLocal ?? "");
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (!isValidCalendarDate(year, month, day) || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const milliseconds = Number((match[7] ?? "").padEnd(3, "0").slice(0, 3) || "0");
  return Date.UTC(year, month - 1, day, hour, minute, second, milliseconds);
}

function proposalTime(signal: MediaPlacementSignal | null | undefined): ProposalTime {
  if (!signal) return { kind: "unknown", value: null };
  const absolute = safeAbsoluteProposalTime(signal);
  if (absolute !== null) return { kind: "absolute", value: absolute };
  const local = safeLocalProposalTime(signal);
  if (local !== null) return { kind: "local", value: local };
  return { kind: "unknown", value: null };
}

function proposalTimeCompare(
  left: MediaPlacementProposalInput,
  right: MediaPlacementProposalInput,
) {
  const leftTime = proposalTime(left.signal);
  const rightTime = proposalTime(right.signal);
  const rank = (time: ProposalTime) => time.kind === "absolute" ? 0 : time.kind === "local" ? 1 : 2;
  return rank(leftTime) - rank(rightTime)
    || (leftTime.value ?? Number.POSITIVE_INFINITY) - (rightTime.value ?? Number.POSITIVE_INFINITY)
    || left.fileIndex - right.fileIndex;
}

function proposalInputIdentity(input: MediaPlacementProposalInput) {
  const hash = input.contentHash?.trim();
  return input.contentHashVerified === true && hash
    ? `hash:${hash}`
    : `file:${String(input.fileIndex).padStart(12, "0")}`;
}

function proposalInputQuality(input: MediaPlacementProposalInput) {
  const signal = input.signal;
  if (!signal) return 0;
  const coordinate = signalHasCoordinateEvidence(signal) ? 4 : 0;
  const accuracy = Number.isFinite(signal.accuracyMeters) ? 2 : 0;
  const time = proposalTime(signal);
  return coordinate + accuracy + (time.kind === "absolute" ? 2 : time.kind === "local" ? 1 : 0);
}

function buildProposalIdentities(inputs: readonly MediaPlacementProposalInput[]) {
  const groups = new Map<string, ProposalIdentity>();
  const seenFileIndexes = new Set<number>();
  for (const input of inputs) {
    if (!Number.isInteger(input.fileIndex) || input.fileIndex < 0 || seenFileIndexes.has(input.fileIndex)) {
      throw new RangeError("Media placement proposal fileIndex must be a unique non-negative integer");
    }
    seenFileIndexes.add(input.fileIndex);
    const key = proposalInputIdentity(input);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { key, fileIndexes: [input.fileIndex], representative: input });
      continue;
    }
    existing.fileIndexes.push(input.fileIndex);
    const qualityDelta = proposalInputQuality(input) - proposalInputQuality(existing.representative);
    if (qualityDelta > 0 || (qualityDelta === 0 && proposalTimeCompare(input, existing.representative) < 0)) {
      existing.representative = input;
    }
  }
  return [...groups.values()].map((identity) => ({
    ...identity,
    fileIndexes: identity.fileIndexes.sort((left, right) => left - right),
  }));
}

function proposalEvidence(identity: ProposalIdentity) {
  const signal = identity.representative.signal;
  const evidence: string[] = [];
  if (signal && signalHasCoordinateEvidence(signal)) {
    evidence.push(`coordinate:${signal.spatialSource ?? "normalized"}`);
  }
  const time = proposalTime(signal);
  if (time.kind === "absolute") evidence.push("time:absolute");
  if (time.kind === "local") evidence.push("time:local-only");
  if (identity.key.startsWith("hash:")) evidence.push("verified-content-hash");
  return evidence;
}

function proposalUncertainty(identity: ProposalIdentity) {
  const signal = identity.representative.signal;
  const uncertainty: string[] = [];
  const time = proposalTime(signal);
  if (time.kind === "local") uncertainty.push("local-time-no-offset");
  if (time.kind === "unknown") uncertainty.push("capture-time-unknown");
  if (!signal || !Number.isFinite(signal.accuracyMeters)) uncertainty.push("accuracy-unknown");
  else if ((signal.accuracyMeters ?? 0) > MEDIA_PLACEMENT_PROPOSAL_LIMITS.maxAutomaticAccuracyMeters) {
    uncertainty.push("accuracy-too-coarse");
  }
  return uncertainty;
}

function proposalIdentityCompare(left: ProposalIdentity, right: ProposalIdentity) {
  return proposalTimeCompare(left.representative, right.representative)
    || left.fileIndexes[0] - right.fileIndexes[0]
    || left.key.localeCompare(right.key);
}

function routeEvidenceForProposal(signal: MediaPlacementSignal, journey: Journey) {
  return journey.routePoints
    .map((point) => routeCandidate(signal, journey, point, journey.id))
    .filter((candidate): candidate is Candidate => Boolean(candidate));
}

function hasStrongRouteEvidenceConflict(signal: MediaPlacementSignal, journey: Journey) {
  const candidates = routeEvidenceForProposal(signal, journey);
  const spatialTarget = bestStrongGpsTarget(candidates);
  const temporalTarget = bestStrongTimeTarget(candidates);
  return Boolean(
    spatialTarget
    && temporalTarget
    && (
      spatialTarget.journeyId !== temporalTarget.journeyId
      || spatialTarget.routePointId !== temporalTarget.routePointId
    )
  );
}

function hasStrongExistingSpatialTarget(signal: MediaPlacementSignal, journey: Journey) {
  return routeEvidenceForProposal(signal, journey)
    .some((candidate) => candidate.routePointId !== null && candidate.strongGps);
}

function coordinateDistance(left: ProposalIdentity, right: ProposalIdentity) {
  const leftSignal = left.representative.signal!;
  const rightSignal = right.representative.signal!;
  return haversineDistanceKm(
    leftSignal.latitude!,
    leftSignal.longitude!,
    rightSignal.latitude!,
    rightSignal.longitude!,
  );
}

function implausibleSpeedIdentityKeys(identities: readonly ProposalIdentity[]) {
  const timed = identities
    .filter((identity) => {
      const signal = identity.representative.signal;
      return Boolean(
        signal
        && signalHasCoordinateEvidence(signal)
        && Number.isFinite(signal.accuracyMeters)
        && (signal.accuracyMeters ?? -1) >= 0
        && proposalTime(signal).kind === "absolute"
      );
    })
    .sort(proposalIdentityCompare);
  const invalid = new Set<string>();
  for (let index = 1; index < timed.length; index += 1) {
    const previous = timed[index - 1];
    const current = timed[index];
    const previousSignal = previous.representative.signal!;
    const currentSignal = current.representative.signal!;
    const previousTime = proposalTime(previousSignal).value!;
    const currentTime = proposalTime(currentSignal).value!;
    const deltaHours = (currentTime - previousTime) / 3_600_000;
    const adjustedDistanceKm = Math.max(
      0,
      coordinateDistance(previous, current)
      - ((previousSignal.accuracyMeters ?? 0) + (currentSignal.accuracyMeters ?? 0)) / 1_000,
    );
    const implausible = deltaHours <= 0
      ? adjustedDistanceKm > MEDIA_PLACEMENT_PROPOSAL_LIMITS.maxClusterDiameterKm
      : adjustedDistanceKm / deltaHours > MEDIA_PLACEMENT_PROPOSAL_LIMITS.maxPlausibleSpeedKmh;
    if (implausible) {
      invalid.add(previous.key);
      invalid.add(current.key);
    }
  }
  return invalid;
}

function pendingProposal(
  identity: ProposalIdentity,
  reason: string,
  extraUncertainty: readonly string[] = [],
): PendingRoutePointProposal {
  return {
    kind: "pending-confirmation",
    fileIndexes: [...identity.fileIndexes],
    basis: {
      reason,
      evidence: proposalEvidence(identity),
      uncertainty: [...new Set([...proposalUncertainty(identity), ...extraUncertainty])],
    },
  };
}

function compatibleProposalTimes(left: ProposalIdentity, right: ProposalIdentity) {
  const leftTime = proposalTime(left.representative.signal);
  const rightTime = proposalTime(right.representative.signal);
  if (
    leftTime.kind === "unknown"
    || rightTime.kind === "unknown"
    || leftTime.kind !== rightTime.kind
    || leftTime.value === null
    || rightTime.value === null
  ) return false;
  return Math.abs(leftTime.value - rightTime.value) / 3_600_000
    <= MEDIA_PLACEMENT_PROPOSAL_LIMITS.timeWindowHours;
}

function canJoinProposalCluster(
  cluster: readonly ProposalIdentity[],
  candidate: ProposalIdentity,
) {
  if (cluster.length === 0) return true;
  const withinNeighbor = cluster.some((member) => (
    coordinateDistance(member, candidate) <= MEDIA_PLACEMENT_PROPOSAL_LIMITS.neighborDistanceKm
    && compatibleProposalTimes(member, candidate)
  ));
  if (!withinNeighbor) return false;
  const expanded = [...cluster, candidate];
  for (let left = 0; left < expanded.length; left += 1) {
    for (let right = left + 1; right < expanded.length; right += 1) {
      if (
        coordinateDistance(expanded[left], expanded[right])
          > MEDIA_PLACEMENT_PROPOSAL_LIMITS.maxClusterDiameterKm
        || !compatibleProposalTimes(expanded[left], expanded[right])
      ) return false;
    }
  }
  return true;
}

function proposalRepresentative(identities: readonly ProposalIdentity[]) {
  return [...identities].sort((left, right) => {
    const leftAccuracy = left.representative.signal?.accuracyMeters;
    const rightAccuracy = right.representative.signal?.accuracyMeters;
    return (Number.isFinite(leftAccuracy) ? leftAccuracy! : Number.POSITIVE_INFINITY)
      - (Number.isFinite(rightAccuracy) ? rightAccuracy! : Number.POSITIVE_INFINITY)
      || proposalIdentityCompare(left, right);
  })[0];
}

function newProposalFromCluster(cluster: readonly ProposalIdentity[]): NewRoutePointProposal {
  const ordered = [...cluster].sort(proposalIdentityCompare);
  const representativeIdentity = proposalRepresentative(ordered);
  const representativeSignal = representativeIdentity.representative.signal!;
  const fileIndexes = ordered
    .flatMap((identity) => identity.fileIndexes)
    .sort((left, right) => left - right);
  const evidence = [...new Set(ordered.flatMap(proposalEvidence))];
  const uncertainty = [...new Set(ordered.flatMap(proposalUncertainty))];
  if (ordered.length === 1) uncertainty.push("single-observation-candidate");
  return {
    kind: "suggest-new",
    candidateId: `new:${fileIndexes.join("-")}`,
    fileIndexes,
    representative: {
      fileIndex: representativeIdentity.representative.fileIndex,
      latitude: representativeSignal.latitude!,
      longitude: representativeSignal.longitude!,
    },
    basis: {
      reason: ordered.length === 1 ? "single-observation-candidate" : "spatiotemporal-cluster",
      evidence,
      uncertainty: [...new Set(uncertainty)],
    },
  };
}

/**
 * Build a proposal only from normalized evidence. This never persists a Route,
 * never guesses a street path, and never turns uncertain time/precision into fact.
 */
export function planMediaPlacementProposals(
  inputs: readonly MediaPlacementProposalInput[],
  journey: Journey,
  options: { batchId: string },
): MediaPlacementProposalPlan {
  if (!options.batchId) throw new RangeError("Media placement proposal batchId is required");
  if (inputs.length > MEDIA_PLACEMENT_PROPOSAL_LIMITS.maxInputs) {
    throw new RangeError("Media placement proposal batch exceeds the bounded input limit");
  }

  const identities = buildProposalIdentities(inputs);
  const implausibleSpeed = implausibleSpeedIdentityKeys(identities);
  const matchExisting: ExistingRoutePointProposal[] = [];
  const pendingConfirmation: PendingRoutePointProposal[] = [];
  const newEligible: ProposalIdentity[] = [];

  for (const identity of identities.sort(proposalIdentityCompare)) {
    const signal = identity.representative.signal;
    if (!signal || !signalHasCoordinateEvidence(signal)) {
      pendingConfirmation.push(pendingProposal(identity, "missing-coordinate-evidence"));
      continue;
    }
    if (!Number.isFinite(signal.accuracyMeters) || (signal.accuracyMeters ?? -1) < 0) {
      pendingConfirmation.push(pendingProposal(identity, "accuracy-unknown"));
      continue;
    }
    if ((signal.accuracyMeters ?? 0) > MEDIA_PLACEMENT_PROPOSAL_LIMITS.maxAutomaticAccuracyMeters) {
      pendingConfirmation.push(pendingProposal(identity, "accuracy-too-coarse"));
      continue;
    }
    if (proposalTime(signal).kind === "unknown") {
      pendingConfirmation.push(pendingProposal(identity, "missing-time-evidence"));
      continue;
    }
    if (implausibleSpeed.has(identity.key)) {
      pendingConfirmation.push(pendingProposal(identity, "implausible-speed", ["speed-conflict"]));
      continue;
    }
    if (hasStrongRouteEvidenceConflict(signal, journey)) {
      pendingConfirmation.push(
        pendingProposal(identity, "conflicting-route-evidence", ["gps-time-conflict"]),
      );
      continue;
    }

    const suggestion = suggestMediaPlacement(signal, [journey], journey.id);
    if (
      suggestion?.routePointId
      && suggestion.distanceKm !== undefined
      && suggestion.distanceKm <= GPS_STRONG_DISTANCE_KM
    ) {
      matchExisting.push({
        kind: "match-existing",
        journeyId: journey.id,
        routePointId: suggestion.routePointId,
        fileIndexes: [...identity.fileIndexes],
        basis: {
          reason: "existing-route-point-evidence",
          evidence: [...new Set([
            ...proposalEvidence(identity),
            ...suggestion.evidence.map((value) => `placement:${value}`),
          ])],
          uncertainty: proposalUncertainty(identity),
        },
      });
      continue;
    }
    if (hasStrongExistingSpatialTarget(signal, journey)) {
      pendingConfirmation.push(pendingProposal(identity, "ambiguous-existing-route"));
      continue;
    }
    newEligible.push(identity);
  }

  const clusters: ProposalIdentity[][] = [];
  for (const identity of newEligible.sort(proposalIdentityCompare)) {
    const target = clusters.find((cluster) => canJoinProposalCluster(cluster, identity));
    if (target) target.push(identity);
    else clusters.push([identity]);
  }

  return {
    algorithmVersion: MEDIA_PLACEMENT_PROPOSAL_ALGORITHM_VERSION,
    scope: {
      batchId: options.batchId,
      journeyId: journey.id,
      routeRevision: journey.revision,
    },
    matchExisting,
    suggestNew: clusters.map(newProposalFromCluster),
    pendingConfirmation,
  };
}

export function isMediaPlacementProposalPlanCurrent(
  plan: MediaPlacementProposalPlan,
  current: {
    batchId: string;
    journeyId: string;
    routeRevision: number;
    cancelled?: boolean;
  },
) {
  return current.cancelled !== true
    && plan.scope.batchId === current.batchId
    && plan.scope.journeyId === current.journeyId
    && plan.scope.routeRevision === current.routeRevision;
}

function inBounds(view: DataView, offset: number, bytes: number) {
  return offset >= 0 && bytes >= 0 && offset + bytes <= view.byteLength;
}

type TiffReader = {
  view: DataView;
  littleEndian: boolean;
  tiffStart: number;
  tiffEnd: number;
};

function inTiffBounds(reader: TiffReader, offset: number, bytes: number) {
  return offset >= reader.tiffStart && bytes >= 0 && offset + bytes <= reader.tiffEnd;
}

function readUint16(reader: TiffReader, offset: number) {
  if (!inTiffBounds(reader, offset, 2)) return null;
  return reader.view.getUint16(offset, reader.littleEndian);
}

function readUint32(reader: TiffReader, offset: number) {
  if (!inTiffBounds(reader, offset, 4)) return null;
  return reader.view.getUint32(offset, reader.littleEndian);
}

function findIfdEntry(reader: TiffReader, relativeIfdOffset: number, tag: number) {
  const ifdOffset = reader.tiffStart + relativeIfdOffset;
  const count = readUint16(reader, ifdOffset);
  if (count === null || count > 4096) return null;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = ifdOffset + 2 + index * 12;
    if (!inTiffBounds(reader, entryOffset, 12)) return null;
    const entryTag = reader.view.getUint16(entryOffset, reader.littleEndian);
    if (entryTag === tag) return entryOffset;
  }
  return null;
}

function entryTypeSize(type: number) {
  if (type === 1 || type === 2 || type === 7) return 1;
  if (type === 3) return 2;
  if (type === 4 || type === 9) return 4;
  if (type === 5 || type === 10) return 8;
  return 0;
}

function entryDataOffset(reader: TiffReader, entryOffset: number) {
  if (!inTiffBounds(reader, entryOffset, 12)) return null;
  const type = reader.view.getUint16(entryOffset + 2, reader.littleEndian);
  const count = reader.view.getUint32(entryOffset + 4, reader.littleEndian);
  const size = entryTypeSize(type) * count;
  if (!size || size > 1_000_000) return null;
  if (size <= 4) return { type, count, offset: entryOffset + 8 };
  const relative = reader.view.getUint32(entryOffset + 8, reader.littleEndian);
  const offset = reader.tiffStart + relative;
  return inTiffBounds(reader, offset, size) ? { type, count, offset } : null;
}

function readAsciiEntry(reader: TiffReader, entryOffset: number | null) {
  if (entryOffset === null) return null;
  const data = entryDataOffset(reader, entryOffset);
  if (!data || data.type !== 2 || !inTiffBounds(reader, data.offset, data.count)) return null;
  const bytes = new Uint8Array(reader.view.buffer, reader.view.byteOffset + data.offset, data.count);
  const value = new TextDecoder("ascii").decode(bytes).replace(/\0.*$/, "").trim();
  return value || null;
}

function readLongEntry(reader: TiffReader, entryOffset: number | null) {
  if (entryOffset === null) return null;
  const data = entryDataOffset(reader, entryOffset);
  if (!data || data.count < 1) return null;
  if (data.type === 3) return readUint16(reader, data.offset);
  if (data.type === 4) return readUint32(reader, data.offset);
  return null;
}

function readRationalArray(reader: TiffReader, entryOffset: number | null) {
  if (entryOffset === null) return null;
  const data = entryDataOffset(reader, entryOffset);
  if (!data || data.type !== 5 || data.count < 3 || !inTiffBounds(reader, data.offset, 24)) return null;
  const values: number[] = [];
  for (let index = 0; index < 3; index += 1) {
    const offset = data.offset + index * 8;
    const numerator = readUint32(reader, offset);
    const denominator = readUint32(reader, offset + 4);
    if (numerator === null || denominator === null || denominator === 0) return null;
    values.push(numerator / denominator);
  }
  return values;
}

function readRationalScalar(reader: TiffReader, entryOffset: number | null) {
  if (entryOffset === null) return null;
  const data = entryDataOffset(reader, entryOffset);
  if (!data || data.type !== 5 || data.count !== 1 || !inTiffBounds(reader, data.offset, 8)) return null;
  const numerator = readUint32(reader, data.offset);
  const denominator = readUint32(reader, data.offset + 4);
  if (numerator === null || denominator === null || denominator === 0) return null;
  const value = numerator / denominator;
  return Number.isFinite(value) && value >= 0 && value <= 1_000_000 ? value : null;
}

function isValidGpsDms(parts: readonly number[], maxDegrees: number) {
  if (parts.length < 3) return false;
  const [degrees, minutes, seconds] = parts;
  if (
    !Number.isFinite(degrees)
    || !Number.isFinite(minutes)
    || !Number.isFinite(seconds)
    || degrees < 0
    || minutes < 0
    || seconds < 0
    || minutes >= 60
    || seconds >= 60
    || degrees > maxDegrees
  ) return false;
  return degrees < maxDegrees || (minutes === 0 && seconds === 0);
}

function degreesFromGps(parts: readonly number[], reference: string) {
  const value = parts[0] + parts[1] / 60 + parts[2] / 3600;
  return reference === "S" || reference === "W" ? -value : value;
}

function normalizeExifDateTime(value: string | null, offset: string | null) {
  if (!value) return null;
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (!isValidCalendarDate(year, month, day) || hour > 23 || minute > 59 || second > 59) return null;
  const local = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
  const offsetMatch = offset?.match(/^([+-])(\d{2}):(\d{2})$/);
  if (offsetMatch) {
    const hours = Number(offsetMatch[2]);
    const minutes = Number(offsetMatch[3]);
    if (minutes <= 59 && (hours < 14 || (hours === 14 && minutes === 0))) {
      const sign = offsetMatch[1] === "-" ? -1 : 1;
      return {
        capturedAt: `${local}${offset}`,
        capturedLocal: local,
        timezoneState: "offset-known" as const,
        offsetMinutes: sign * (hours * 60 + minutes),
      };
    }
  }
  return {
    capturedLocal: local,
    timezoneState: "local-only" as const,
    offsetMinutes: null,
  };
}

function normalizeGpsDateTime(dateStamp: string | null, timeParts: readonly number[] | null) {
  const match = /^(\d{4}):(\d{2}):(\d{2})$/.exec(dateStamp ?? "");
  if (!match || !timeParts || timeParts.length < 3) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const [hour, minute, secondValue] = timeParts;
  if (!isValidCalendarDate(year, month, day) || hour < 0 || hour >= 24 || minute < 0 || minute >= 60 || secondValue < 0 || secondValue >= 60) return null;
  const second = Math.floor(secondValue);
  const milliseconds = Math.round((secondValue - second) * 1000);
  const instant = new Date(Date.UTC(year, month - 1, day, hour, minute, second, milliseconds));
  if (!Number.isFinite(instant.valueOf())) return null;
  const capturedAt = instant.toISOString();
  const capturedLocal = capturedAt.endsWith(".000Z")
    ? capturedAt.slice(0, -5)
    : capturedAt.slice(0, -1);
  return {
    capturedAt,
    capturedLocal,
    timezoneState: "offset-known" as const,
    offsetMinutes: 0,
  };
}

/** Parse only normalized placement signals from JPEG EXIF; raw metadata is discarded. */
export function parseJpegExifPlacementSignal(buffer: ArrayBuffer): MediaPlacementSignal | null {
  const view = new DataView(buffer);
  if (view.byteLength < 4 || view.getUint16(0, false) !== 0xffd8) return null;
  let cursor = 2;
  while (cursor + 4 <= view.byteLength) {
    if (view.getUint8(cursor) !== 0xff) break;
    let markerOffset = cursor;
    while (markerOffset < view.byteLength && view.getUint8(markerOffset) === 0xff) markerOffset += 1;
    if (markerOffset >= view.byteLength) break;
    const marker = view.getUint8(markerOffset);
    cursor = markerOffset + 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (!inBounds(view, cursor, 2)) break;
    const segmentLength = view.getUint16(cursor, false);
    if (segmentLength < 2 || !inBounds(view, cursor, segmentLength)) break;
    const payload = cursor + 2;
    const payloadLength = segmentLength - 2;
    if (
      marker === 0xe1
      && payloadLength >= 14
      && inBounds(view, payload, 6)
      && view.getUint32(payload, false) === 0x45786966
      && view.getUint16(payload + 4, false) === 0
    ) {
      const tiffStart = payload + 6;
      if (!inBounds(view, tiffStart, 8)) return null;
      const byteOrder = view.getUint16(tiffStart, false);
      if (byteOrder !== 0x4949 && byteOrder !== 0x4d4d) return null;
      const reader: TiffReader = {
        view,
        littleEndian: byteOrder === 0x4949,
        tiffStart,
        tiffEnd: cursor + segmentLength,
      };
      if (readUint16(reader, tiffStart + 2) !== 42) return null;
      const ifd0 = readUint32(reader, tiffStart + 4);
      if (ifd0 === null) return null;
      const signal: MediaPlacementSignal = {
        spatialSource: "unknown",
        spatialGranularity: "unknown",
        accuracyMeters: null,
        captureTimeSource: "unknown",
        timezoneState: "unknown",
        offsetMinutes: null,
      };
      let hasEvidence = false;

      const gpsIfd = readLongEntry(reader, findIfdEntry(reader, ifd0, 0x8825));
      let gpsDateTime: ReturnType<typeof normalizeGpsDateTime> = null;
      if (gpsIfd !== null) {
        const latRef = readAsciiEntry(reader, findIfdEntry(reader, gpsIfd, 0x0001));
        const latParts = readRationalArray(reader, findIfdEntry(reader, gpsIfd, 0x0002));
        const lonRef = readAsciiEntry(reader, findIfdEntry(reader, gpsIfd, 0x0003));
        const lonParts = readRationalArray(reader, findIfdEntry(reader, gpsIfd, 0x0004));
        const accuracyMeters = readRationalScalar(reader, findIfdEntry(reader, gpsIfd, 0x001f));
        gpsDateTime = normalizeGpsDateTime(
          readAsciiEntry(reader, findIfdEntry(reader, gpsIfd, 0x001d)),
          readRationalArray(reader, findIfdEntry(reader, gpsIfd, 0x0007)),
        );
        if (
          latRef && /^[NS]$/.test(latRef)
          && lonRef && /^[EW]$/.test(lonRef)
          && latParts && lonParts
          && isValidGpsDms(latParts, 90)
          && isValidGpsDms(lonParts, 180)
        ) {
          const latitude = degreesFromGps(latParts, latRef);
          const longitude = degreesFromGps(lonParts, lonRef);
          if (latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180) {
            signal.latitude = latitude;
            signal.longitude = longitude;
            signal.spatialSource = "exif";
            signal.spatialGranularity = "coordinate";
            signal.accuracyMeters = accuracyMeters;
            hasEvidence = true;
          }
        }
      }

      let normalizedTime: ReturnType<typeof normalizeExifDateTime> = null;
      let captureTimeSource: MediaCaptureTimeSource = "unknown";
      const exifIfd = readLongEntry(reader, findIfdEntry(reader, ifd0, 0x8769));
      if (exifIfd !== null) {
        const dateTimeOriginal = readAsciiEntry(reader, findIfdEntry(reader, exifIfd, 0x9003));
        const dateTimeDigitized = readAsciiEntry(reader, findIfdEntry(reader, exifIfd, 0x9004));
        const offsetTimeOriginal = readAsciiEntry(reader, findIfdEntry(reader, exifIfd, 0x9011));
        const offsetTimeDigitized = readAsciiEntry(reader, findIfdEntry(reader, exifIfd, 0x9012));
        normalizedTime = normalizeExifDateTime(dateTimeOriginal, offsetTimeOriginal);
        if (normalizedTime) captureTimeSource = "exif-original";
        else {
          normalizedTime = normalizeExifDateTime(dateTimeDigitized, offsetTimeDigitized);
          if (normalizedTime) captureTimeSource = "exif-digitized";
        }
      }
      if (!normalizedTime && gpsDateTime) {
        normalizedTime = gpsDateTime;
        captureTimeSource = "gps";
      }
      if (normalizedTime) {
        Object.assign(signal, normalizedTime);
        signal.captureTimeSource = captureTimeSource;
        hasEvidence = true;
      }
      return hasEvidence ? signal : null;
    }
    cursor += segmentLength;
  }
  return null;
}

export const MAX_EXIF_SCAN_BYTES = 2 * 1024 * 1024;

export async function readMediaPlacementSignal(file: File): Promise<MediaPlacementReadResult> {
  if (!/^image\/jpeg$/i.test(file.type) && !/\.jpe?g$/i.test(file.name)) {
    return { status: "unsupported-format" };
  }
  try {
    // JPEG APP metadata lives before the compressed image scan. Bound the read
    // so a 500 MB original never becomes a 500 MB metadata allocation.
    const signal = parseJpegExifPlacementSignal(
      await file.slice(0, MAX_EXIF_SCAN_BYTES).arrayBuffer(),
    );
    return signal ? { status: "signal", signal } : { status: "no-evidence" };
  } catch {
    return { status: "no-evidence" };
  }
}
