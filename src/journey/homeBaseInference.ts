import { isPersistedCalendarDate } from "./calendarDate";
import { homeBasePeriodCoversDate, type HomeBasePeriod } from "./homeBase";
import { haversineDistanceKm } from "./mediaPlacement";
import type { Journey, RoutePoint } from "./types";

export const HOME_BASE_CLUSTER_RADIUS_KM = 25;
export const HOME_BASE_CANDIDATE_MIN_JOURNEYS = 3;
export const HOME_BASE_CANDIDATE_MIN_SPAN_DAYS = 30;
export const HOME_BASE_SUGGESTED_MIN_JOURNEYS = 4;
export const HOME_BASE_SUGGESTED_MIN_SPAN_DAYS = 90;
export const HOME_BASE_MIN_START_SUPPORT = 2;
export const HOME_BASE_MIN_END_SUPPORT = 2;
export const HOME_BASE_MIN_LEAD_JOURNEYS = 2;
export const HOME_BASE_SOFT_DISMISSAL_MIN_DAYS = 90;
export const HOME_BASE_SOFT_DISMISSAL_MIN_NEW_JOURNEYS = 2;

export type HomeBaseInferenceState =
  | "insufficient_evidence"
  | "candidate"
  | "suggested"
  | "move_suggested"
  | "dismissed";

export type HomeBaseEvidenceReasonCode =
  | "NO_ROUTE_ENDPOINT_EVIDENCE"
  | "CANDIDATE_JOURNEY_THRESHOLD_MET"
  | "CANDIDATE_SPAN_THRESHOLD_MET"
  | "SUGGESTED_JOURNEY_THRESHOLD_MET"
  | "SUGGESTED_SPAN_THRESHOLD_MET"
  | "START_SUPPORT_THRESHOLD_MET"
  | "END_SUPPORT_THRESHOLD_MET"
  | "LEADER_MARGIN_THRESHOLD_MET"
  | "MATCHES_CONFIRMED_HOME"
  | "DIFFERS_FROM_CONFIRMED_HOME"
  | "SOFT_DISMISSAL_ACTIVE"
  | "REJECTED_DISMISSAL_ACTIVE";

export type HomeBaseMetroAnchor = {
  latitude: number;
  longitude: number;
};

export type HomeBaseDismissal = {
  kind: "soft" | "rejected";
  digest: string;
  dismissedAt: string;
};

type ConfirmedHomeBasePeriod = Pick<
  HomeBasePeriod,
  "startedOn" | "endedOn" | "latitude" | "longitude"
>;

type InferenceRoutePoint = Pick<
  RoutePoint,
  "id" | "sortOrder" | "latitude" | "longitude"
>;

export type HomeBaseInferenceJourney = Pick<Journey, "id" | "startedOn" | "endedOn"> & {
  routePoints: readonly InferenceRoutePoint[];
};

export type HomeBaseInferenceInput = {
  journeys: readonly HomeBaseInferenceJourney[];
  confirmedPeriod?: ConfirmedHomeBasePeriod | null;
  evaluationDate: string;
  dismissal?: HomeBaseDismissal | null;
};

export type HomeBaseInferenceResult = {
  state: HomeBaseInferenceState;
  metroAnchor: HomeBaseMetroAnchor | null;
  reasonCodes: readonly HomeBaseEvidenceReasonCode[];
  evidenceDigest: string | null;
  support: {
    journeys: number;
    starts: number;
    ends: number;
    runnerUpJourneys: number;
    evidenceSpanDays: number;
    evidenceStartedOn: string | null;
    evidenceEndedOn: string | null;
  };
  proposedPeriodStart: string | null;
};

type EndpointEvidence = {
  journeyId: string;
  kind: "start" | "end";
  latitude: number;
  longitude: number;
  date: string;
};

type JourneySupport = {
  journeyId: string;
  supportsStart: boolean;
  supportsEnd: boolean;
};

type EvidenceRegion = {
  anchor: HomeBaseMetroAnchor;
  supports: JourneySupport[];
  journeyCount: number;
  startCount: number;
  endCount: number;
  evidenceStartedOn: string;
  evidenceEndedOn: string;
  evidenceSpanDays: number;
};

type DigestSnapshot = {
  anchor: HomeBaseMetroAnchor;
  supports: readonly JourneySupport[];
  evidenceStartedOn: string;
  evidenceEndedOn: string;
};

const DIGEST_PREFIX = "hbi-v2";
const DAYS_BEFORE_MONTH = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334] as const;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function dateOrdinal(value: string): number | null {
  if (!isPersistedCalendarDate(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const previousYear = year - 1;
  const daysBeforeYear = previousYear * 365
    + Math.floor(previousYear / 4)
    - Math.floor(previousYear / 100)
    + Math.floor(previousYear / 400);
  const leapDay = month > 2 && isLeapYear(year) ? 1 : 0;
  return daysBeforeYear + DAYS_BEFORE_MONTH[month - 1] + leapDay + day - 1;
}

function dateOrTimestampOrdinal(value: string): number | null {
  const calendarOrdinal = dateOrdinal(value);
  if (calendarOrdinal !== null) return calendarOrdinal;
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) return null;
  const year = timestamp.getUTCFullYear();
  if (year < 1 || year > 9999) return null;
  const normalizedDate = [
    String(year).padStart(4, "0"),
    String(timestamp.getUTCMonth() + 1).padStart(2, "0"),
    String(timestamp.getUTCDate()).padStart(2, "0"),
  ].join("-");
  return dateOrdinal(normalizedDate);
}

function spanDays(startedOn: string, endedOn: string): number {
  const start = dateOrdinal(startedOn);
  const end = dateOrdinal(endedOn);
  if (start === null || end === null) return 0;
  return Math.max(0, end - start);
}

function sortedRoutePoints(routePoints: readonly InferenceRoutePoint[]): InferenceRoutePoint[] {
  return [...routePoints].sort((left, right) => (
    left.sortOrder - right.sortOrder
    || left.id.localeCompare(right.id)
    || left.latitude - right.latitude
    || left.longitude - right.longitude
  ));
}

function endpointEvidence(journeys: readonly HomeBaseInferenceJourney[]): EndpointEvidence[] {
  const evidence: EndpointEvidence[] = [];
  for (const journey of journeys) {
    const points = sortedRoutePoints(journey.routePoints);
    const first = points[0];
    const last = points.at(-1);
    if (!first || !last) continue;
    if (
      !Number.isFinite(first.latitude)
      || !Number.isFinite(first.longitude)
      || !Number.isFinite(last.latitude)
      || !Number.isFinite(last.longitude)
    ) continue;
    evidence.push({
      journeyId: journey.id,
      kind: "start",
      latitude: first.latitude,
      longitude: first.longitude,
      date: journey.startedOn,
    });
    if (points.length > 1 && journey.endedOn) {
      evidence.push({
        journeyId: journey.id,
        kind: "end",
        latitude: last.latitude,
        longitude: last.longitude,
        date: journey.endedOn,
      });
    }
  }
  return evidence.sort((left, right) => (
    left.latitude - right.latitude
    || left.longitude - right.longitude
    || left.journeyId.localeCompare(right.journeyId)
    || left.kind.localeCompare(right.kind)
    || left.date.localeCompare(right.date)
  ));
}

function evidencePointCompare(left: EndpointEvidence, right: EndpointEvidence): number {
  return (
    left.latitude - right.latitude
    || left.longitude - right.longitude
    || left.journeyId.localeCompare(right.journeyId)
    || left.kind.localeCompare(right.kind)
    || left.date.localeCompare(right.date)
  );
}

function regionAnchor(selected: readonly EndpointEvidence[]): HomeBaseMetroAnchor {
  // Use the deterministic medoid rather than an insertion-order seed. Besides
  // making the digest stable, this keeps the public anchor on actual evidence.
  const ranked = selected.map((candidate) => ({
    candidate,
    distanceSum: selected.reduce((sum, other) => sum + haversineDistanceKm(
      candidate.latitude,
      candidate.longitude,
      other.latitude,
      other.longitude,
    ), 0),
  })).sort((left, right) => (
    left.distanceSum - right.distanceSum
    || evidencePointCompare(left.candidate, right.candidate)
  ));
  return {
    latitude: ranked[0].candidate.latitude,
    longitude: ranked[0].candidate.longitude,
  };
}

function regionFromClique(
  selectedIndexes: readonly number[],
  evidence: readonly EndpointEvidence[],
): EvidenceRegion | null {
  if (selectedIndexes.length === 0) return null;
  const selected = selectedIndexes.map((index) => evidence[index]).sort(evidencePointCompare);
  const supportByJourney = new Map<string, JourneySupport>();
  const dates: string[] = [];
  for (const item of selected) {
    const existing = supportByJourney.get(item.journeyId) ?? {
      journeyId: item.journeyId,
      supportsStart: false,
      supportsEnd: false,
    };
    if (item.kind === "start") existing.supportsStart = true;
    else existing.supportsEnd = true;
    supportByJourney.set(item.journeyId, existing);
    dates.push(item.date);
  }
  const supports = [...supportByJourney.values()].sort((left, right) =>
    left.journeyId.localeCompare(right.journeyId));
  const sortedDates = dates.sort();
  const evidenceStartedOn = sortedDates[0];
  const evidenceEndedOn = sortedDates.at(-1)!;
  return {
    anchor: regionAnchor(selected),
    supports,
    journeyCount: supports.length,
    startCount: supports.filter((support) => support.supportsStart).length,
    endCount: supports.filter((support) => support.supportsEnd).length,
    evidenceStartedOn,
    evidenceEndedOn,
    evidenceSpanDays: spanDays(evidenceStartedOn, evidenceEndedOn),
  };
}

function regionKey(region: EvidenceRegion): string {
  return region.supports.map((support) => (
    `${support.journeyId}:${Number(support.supportsStart)}${Number(support.supportsEnd)}`
  )).join("|");
}

function compareRegions(left: EvidenceRegion, right: EvidenceRegion): number {
  return (
    right.journeyCount - left.journeyCount
    || right.startCount - left.startCount
    || right.endCount - left.endCount
    || right.evidenceSpanDays - left.evidenceSpanDays
    || left.anchor.latitude - right.anchor.latitude
    || left.anchor.longitude - right.anchor.longitude
  );
}

function evidenceRegions(evidence: readonly EndpointEvidence[]): EvidenceRegion[] {
  if (evidence.length === 0) return [];

  // The 25 km contract is a bounded region, not graph connectivity. Enumerate
  // maximal pairwise-compatible endpoint sets (maximal cliques in the distance
  // graph) so a near outlier cannot greedily displace a stronger valid metro,
  // and A-B / B-C proximity cannot transitively merge distant A and C.
  const neighbors = evidence.map((item, index) => {
    const adjacent = new Set<number>();
    for (let otherIndex = 0; otherIndex < evidence.length; otherIndex += 1) {
      if (otherIndex === index) continue;
      const other = evidence[otherIndex];
      if (haversineDistanceKm(
        item.latitude,
        item.longitude,
        other.latitude,
        other.longitude,
      ) <= HOME_BASE_CLUSTER_RADIUS_KM) adjacent.add(otherIndex);
    }
    return adjacent;
  });

  const bySupport = new Map<string, EvidenceRegion>();
  const visitClique = (indexes: readonly number[]) => {
    const region = regionFromClique(indexes, evidence);
    if (!region) return;
    const key = regionKey(region);
    const existing = bySupport.get(key);
    if (!existing || compareRegions(region, existing) < 0) bySupport.set(key, region);
  };

  const intersectNeighbors = (values: readonly number[], vertex: number) =>
    values.filter((value) => neighbors[vertex].has(value));

  const bronKerbosch = (clique: number[], candidates: number[], excluded: number[]) => {
    if (candidates.length === 0 && excluded.length === 0) {
      visitClique(clique);
      return;
    }

    // A dense Home metro is a common case. If every remaining candidate is
    // pairwise compatible, the current R + P set is the only not-yet-visited
    // maximal clique unless an excluded vertex extends all of P. Collapse that
    // case here instead of recursing once per endpoint.
    let candidatesFormClique = true;
    for (let leftIndex = 0; leftIndex < candidates.length && candidatesFormClique; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
        if (!neighbors[candidates[leftIndex]].has(candidates[rightIndex])) {
          candidatesFormClique = false;
          break;
        }
      }
    }
    if (candidatesFormClique) {
      const extendedByExcluded = excluded.some((vertex) =>
        candidates.every((candidate) => neighbors[vertex].has(candidate)));
      if (!extendedByExcluded) visitClique([...clique, ...candidates]);
      return;
    }

    // Pick the pivot in one pass. The old sort comparator rescanned all of P
    // for every comparison, multiplying work on large, dense histories. Cache
    // each intersection count once for this recursion frame instead.
    let pivot: number | undefined;
    let pivotConnections = -1;
    for (const vertex of [...candidates, ...excluded]) {
      let connections = 0;
      for (const candidate of candidates) {
        if (neighbors[vertex].has(candidate)) connections += 1;
      }
      if (
        connections > pivotConnections
        || (connections === pivotConnections && (pivot === undefined || vertex < pivot))
      ) {
        pivot = vertex;
        pivotConnections = connections;
      }
    }
    const toExplore = pivot === undefined
      ? [...candidates]
      : candidates.filter((value) => !neighbors[pivot!].has(value));

    let remainingCandidates = [...candidates];
    const remainingExcluded = [...excluded];
    for (const vertex of toExplore) {
      bronKerbosch(
        [...clique, vertex],
        intersectNeighbors(remainingCandidates, vertex),
        intersectNeighbors(remainingExcluded, vertex),
      );
      remainingCandidates = remainingCandidates.filter((value) => value !== vertex);
      remainingExcluded.push(vertex);
    }
  };

  bronKerbosch([], evidence.map((_item, index) => index), []);
  return [...bySupport.values()].sort(compareRegions);
}

function runnerUpSupport(leader: EvidenceRegion, regions: readonly EvidenceRegion[]): number {
  const leaderJourneys = new Set(leader.supports.map((support) => support.journeyId));
  for (const region of regions) {
    if (region === leader) continue;
    const anchorDistance = haversineDistanceKm(
      leader.anchor.latitude,
      leader.anchor.longitude,
      region.anchor.latitude,
      region.anchor.longitude,
    );
    const hasNovelJourney = region.supports.some((support) => !leaderJourneys.has(support.journeyId));
    // Nearby maximal cliques made only from the leader's same Journey evidence
    // are boundary variants of the same metro hypothesis, not a runner-up. A
    // nearby clique with genuinely different Journeys still competes; skipping
    // it would recreate transitive chaining through their overlapping points.
    if (anchorDistance <= HOME_BASE_CLUSTER_RADIUS_KM && !hasNovelJourney) continue;
    return region.journeyCount;
  }
  return 0;
}

function roundedCoordinate(value: number): number {
  return Number(value.toFixed(6));
}

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Stable V1 evidence revision. It intentionally excludes Journey titles,
 * media and caller ordering. The readable prefix carries only the fields the
 * dismissal policy needs to compare an older revision to a current one.
 */
export function homeBaseEvidenceDigest(snapshot: DigestSnapshot): string {
  const supports = [...snapshot.supports]
    .map((support) => ({
      journeyId: support.journeyId,
      starts: Number(support.supportsStart),
      ends: Number(support.supportsEnd),
    }))
    .sort((left, right) => left.journeyId.localeCompare(right.journeyId));
  const latitude = roundedCoordinate(snapshot.anchor.latitude);
  const longitude = roundedCoordinate(snapshot.anchor.longitude);
  const canonical = JSON.stringify({
    anchor: { latitude, longitude },
    supports,
    evidenceStartedOn: snapshot.evidenceStartedOn,
    evidenceEndedOn: snapshot.evidenceEndedOn,
  });
  const supportToken = supports
    .map((support) => `${encodeURIComponent(support.journeyId)}=${support.starts}${support.ends}`)
    .join(",");
  return [
    DIGEST_PREFIX,
    latitude,
    longitude,
    supports.length,
    snapshot.evidenceStartedOn,
    snapshot.evidenceEndedOn,
    supportToken,
    fnv1a32(canonical),
  ].join(":");
}

type ParsedDigest = {
  anchor: HomeBaseMetroAnchor;
  journeyIds: readonly string[];
};

function parseEvidenceDigest(digest: string): ParsedDigest | null {
  const parts = digest.split(":");
  if (parts.length !== 8 || parts[0] !== DIGEST_PREFIX) return null;
  const latitude = Number(parts[1]);
  const longitude = Number(parts[2]);
  const journeyCount = Number(parts[3]);
  if (
    !Number.isFinite(latitude)
    || !Number.isFinite(longitude)
    || !Number.isInteger(journeyCount)
    || journeyCount < 0
  ) return null;

  const journeyIds: string[] = [];
  const seenJourneyIds = new Set<string>();
  if (parts[6].length > 0) {
    for (const encodedSupport of parts[6].split(",")) {
      const separator = encodedSupport.lastIndexOf("=");
      if (separator <= 0 || !/^[01][01]$/.test(encodedSupport.slice(separator + 1))) return null;
      let journeyId: string;
      try {
        journeyId = decodeURIComponent(encodedSupport.slice(0, separator));
      } catch {
        return null;
      }
      if (journeyId.length === 0 || seenJourneyIds.has(journeyId)) return null;
      seenJourneyIds.add(journeyId);
      journeyIds.push(journeyId);
    }
  }
  if (journeyIds.length !== journeyCount) return null;
  return { anchor: { latitude, longitude }, journeyIds };
}

function matchingDismissal(
  dismissal: HomeBaseDismissal | null | undefined,
  region: EvidenceRegion,
  digest: string,
  evaluationDate: string,
): "soft" | "rejected" | null {
  if (!dismissal) return null;
  if (dismissal.digest === digest) return dismissal.kind;

  const previous = parseEvidenceDigest(dismissal.digest);
  if (!previous) return null;
  if (
    haversineDistanceKm(
      previous.anchor.latitude,
      previous.anchor.longitude,
      region.anchor.latitude,
      region.anchor.longitude,
    ) > HOME_BASE_CLUSTER_RADIUS_KM
  ) return null;

  if (dismissal.kind === "rejected") return "rejected";

  const dismissedOn = dateOrTimestampOrdinal(dismissal.dismissedAt);
  const evaluatedOn = dateOrdinal(evaluationDate);
  const elapsedDays = dismissedOn === null || evaluatedOn === null
    ? 0
    : evaluatedOn - dismissedOn;
  const previousJourneyIds = new Set(previous.journeyIds);
  const newSupportingJourneys = region.supports.filter(
    (support) => !previousJourneyIds.has(support.journeyId),
  ).length;
  const mayReprompt = elapsedDays >= HOME_BASE_SOFT_DISMISSAL_MIN_DAYS
    && newSupportingJourneys >= HOME_BASE_SOFT_DISMISSAL_MIN_NEW_JOURNEYS;
  return mayReprompt ? null : "soft";
}

function emptyResult(reasonCodes: readonly HomeBaseEvidenceReasonCode[]): HomeBaseInferenceResult {
  return {
    state: "insufficient_evidence",
    metroAnchor: null,
    reasonCodes,
    evidenceDigest: null,
    support: {
      journeys: 0,
      starts: 0,
      ends: 0,
      runnerUpJourneys: 0,
      evidenceSpanDays: 0,
      evidenceStartedOn: null,
      evidenceEndedOn: null,
    },
    proposedPeriodStart: null,
  };
}

function normalizeInput(
  inputOrJourneys: HomeBaseInferenceInput | readonly HomeBaseInferenceJourney[],
  confirmedPeriod?: ConfirmedHomeBasePeriod | null,
  evaluationDate?: string,
  dismissal?: HomeBaseDismissal | null,
): HomeBaseInferenceInput {
  if (Array.isArray(inputOrJourneys)) {
    return {
      journeys: inputOrJourneys,
      confirmedPeriod,
      evaluationDate: evaluationDate ?? "",
      dismissal,
    };
  }
  return inputOrJourneys as HomeBaseInferenceInput;
}

export function inferHomeBaseCandidate(input: HomeBaseInferenceInput): HomeBaseInferenceResult;
export function inferHomeBaseCandidate(
  journeys: readonly HomeBaseInferenceJourney[],
  confirmedPeriod: ConfirmedHomeBasePeriod | null | undefined,
  evaluationDate: string,
  dismissal?: HomeBaseDismissal | null,
): HomeBaseInferenceResult;
export function inferHomeBaseCandidate(
  inputOrJourneys: HomeBaseInferenceInput | readonly HomeBaseInferenceJourney[],
  confirmedPeriod?: ConfirmedHomeBasePeriod | null,
  evaluationDate?: string,
  dismissal?: HomeBaseDismissal | null,
): HomeBaseInferenceResult {
  const input = normalizeInput(inputOrJourneys, confirmedPeriod, evaluationDate, dismissal);
  const activeConfirmedPeriod = input.confirmedPeriod
    && homeBasePeriodCoversDate(input.confirmedPeriod, input.evaluationDate)
    ? input.confirmedPeriod
    : null;
  const evidence = endpointEvidence(input.journeys).filter((item) => (
    item.date <= input.evaluationDate
    && (!activeConfirmedPeriod || item.date > activeConfirmedPeriod.startedOn)
  ));
  const regions = evidenceRegions(evidence);
  const leader = regions[0];
  if (!leader) return emptyResult(["NO_ROUTE_ENDPOINT_EVIDENCE"]);

  const runnerUpJourneys = runnerUpSupport(leader, regions);
  const reasonCodes: HomeBaseEvidenceReasonCode[] = [];
  if (leader.journeyCount >= HOME_BASE_CANDIDATE_MIN_JOURNEYS) {
    reasonCodes.push("CANDIDATE_JOURNEY_THRESHOLD_MET");
  }
  if (leader.evidenceSpanDays >= HOME_BASE_CANDIDATE_MIN_SPAN_DAYS) {
    reasonCodes.push("CANDIDATE_SPAN_THRESHOLD_MET");
  }
  if (leader.journeyCount >= HOME_BASE_SUGGESTED_MIN_JOURNEYS) {
    reasonCodes.push("SUGGESTED_JOURNEY_THRESHOLD_MET");
  }
  if (leader.evidenceSpanDays >= HOME_BASE_SUGGESTED_MIN_SPAN_DAYS) {
    reasonCodes.push("SUGGESTED_SPAN_THRESHOLD_MET");
  }
  if (leader.startCount >= HOME_BASE_MIN_START_SUPPORT) {
    reasonCodes.push("START_SUPPORT_THRESHOLD_MET");
  }
  if (leader.endCount >= HOME_BASE_MIN_END_SUPPORT) {
    reasonCodes.push("END_SUPPORT_THRESHOLD_MET");
  }
  if (leader.journeyCount - runnerUpJourneys >= HOME_BASE_MIN_LEAD_JOURNEYS) {
    reasonCodes.push("LEADER_MARGIN_THRESHOLD_MET");
  }

  const digest = homeBaseEvidenceDigest({
    anchor: leader.anchor,
    supports: leader.supports,
    evidenceStartedOn: leader.evidenceStartedOn,
    evidenceEndedOn: leader.evidenceEndedOn,
  });
  const base = {
    metroAnchor: leader.anchor,
    evidenceDigest: digest,
    support: {
      journeys: leader.journeyCount,
      starts: leader.startCount,
      ends: leader.endCount,
      runnerUpJourneys,
      evidenceSpanDays: leader.evidenceSpanDays,
      evidenceStartedOn: leader.evidenceStartedOn,
      evidenceEndedOn: leader.evidenceEndedOn,
    },
  };

  const isCandidate = leader.journeyCount >= HOME_BASE_CANDIDATE_MIN_JOURNEYS
    && leader.evidenceSpanDays >= HOME_BASE_CANDIDATE_MIN_SPAN_DAYS;
  if (!isCandidate) {
    return {
      state: "insufficient_evidence",
      ...base,
      reasonCodes,
      proposedPeriodStart: null,
    };
  }

  const isSuggested = leader.journeyCount >= HOME_BASE_SUGGESTED_MIN_JOURNEYS
    && leader.evidenceSpanDays >= HOME_BASE_SUGGESTED_MIN_SPAN_DAYS
    && leader.startCount >= HOME_BASE_MIN_START_SUPPORT
    && leader.endCount >= HOME_BASE_MIN_END_SUPPORT
    && leader.journeyCount - runnerUpJourneys >= HOME_BASE_MIN_LEAD_JOURNEYS;
  if (!isSuggested) {
    return {
      state: "candidate",
      ...base,
      reasonCodes,
      proposedPeriodStart: null,
    };
  }

  const dismissalState = matchingDismissal(input.dismissal, leader, digest, input.evaluationDate);
  if (dismissalState) {
    return {
      state: "dismissed",
      ...base,
      reasonCodes: [
        ...reasonCodes,
        dismissalState === "rejected" ? "REJECTED_DISMISSAL_ACTIVE" : "SOFT_DISMISSAL_ACTIVE",
      ],
      proposedPeriodStart: null,
    };
  }

  if (activeConfirmedPeriod) {
    const confirmedDistance = haversineDistanceKm(
      activeConfirmedPeriod.latitude,
      activeConfirmedPeriod.longitude,
      leader.anchor.latitude,
      leader.anchor.longitude,
    );
    if (confirmedDistance <= HOME_BASE_CLUSTER_RADIUS_KM) {
      return {
        state: "candidate",
        ...base,
        reasonCodes: [...reasonCodes, "MATCHES_CONFIRMED_HOME"],
        proposedPeriodStart: null,
      };
    }
    return {
      state: "move_suggested",
      ...base,
      reasonCodes: [...reasonCodes, "DIFFERS_FROM_CONFIRMED_HOME"],
      proposedPeriodStart: leader.evidenceStartedOn,
    };
  }

  return {
    state: "suggested",
    ...base,
    reasonCodes,
    proposedPeriodStart: null,
  };
}
