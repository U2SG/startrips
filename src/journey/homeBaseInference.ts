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
  selectedEvidence: readonly EndpointEvidence[];
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

function regionFromSelectedEvidence(
  selectedEvidence: readonly EndpointEvidence[],
): EvidenceRegion | null {
  if (selectedEvidence.length === 0) return null;
  const selected = [...selectedEvidence].sort(evidencePointCompare);
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
    selectedEvidence: selected,
    supports,
    journeyCount: supports.length,
    startCount: supports.filter((support) => support.supportsStart).length,
    endCount: supports.filter((support) => support.supportsEnd).length,
    evidenceStartedOn,
    evidenceEndedOn,
    evidenceSpanDays: spanDays(evidenceStartedOn, evidenceEndedOn),
  };
}

function regionFromClique(
  selectedIndexes: readonly number[],
  evidence: readonly EndpointEvidence[],
): EvidenceRegion | null {
  return regionFromSelectedEvidence(selectedIndexes.map((index) => evidence[index]));
}

function regionKey(region: EvidenceRegion): string {
  return region.supports.map((support) => (
    `${support.journeyId}:${Number(support.supportsStart)}${Number(support.supportsEnd)}`
  )).join("|");
}

function directionalSupportEligible(region: EvidenceRegion): number {
  return Number(
    region.startCount >= HOME_BASE_MIN_START_SUPPORT
    && region.endCount >= HOME_BASE_MIN_END_SUPPORT
  );
}

function compareRegions(left: EvidenceRegion, right: EvidenceRegion): number {
  const leftBalancedSupport = Math.min(left.startCount, left.endCount);
  const rightBalancedSupport = Math.min(right.startCount, right.endCount);
  return (
    right.journeyCount - left.journeyCount
    || directionalSupportEligible(right) - directionalSupportEligible(left)
    || rightBalancedSupport - leftBalancedSupport
    || (right.startCount + right.endCount) - (left.startCount + left.endCount)
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

function meetsSuggestionPolicy(region: EvidenceRegion, runnerUpJourneys: number): boolean {
  return region.journeyCount >= HOME_BASE_SUGGESTED_MIN_JOURNEYS
    && region.evidenceSpanDays >= HOME_BASE_SUGGESTED_MIN_SPAN_DAYS
    && region.startCount >= HOME_BASE_MIN_START_SUPPORT
    && region.endCount >= HOME_BASE_MIN_END_SUPPORT
    && region.journeyCount - runnerUpJourneys >= HOME_BASE_MIN_LEAD_JOURNEYS;
}

function windowRegions(
  regions: readonly EvidenceRegion[],
  startedOn: string,
  endedOn: string,
): EvidenceRegion[] {
  const selections = regions
    .map((region) => region.selectedEvidence.filter((item) => (
      item.date >= startedOn && item.date <= endedOn
    )))
    .filter((selected) => selected.length > 0);

  const uniqueSelections: Array<{ selected: EndpointEvidence[]; set: Set<EndpointEvidence> }> = [];
  for (const selected of selections) {
    const set = new Set(selected);
    if (uniqueSelections.some((existing) => (
      existing.selected.length === selected.length
      && selected.every((item) => existing.set.has(item))
    ))) continue;
    uniqueSelections.push({ selected, set });
  }

  const maximalSelections = uniqueSelections.filter((candidate, candidateIndex) => (
    !uniqueSelections.some((other, otherIndex) => (
      otherIndex !== candidateIndex
      && other.selected.length > candidate.selected.length
      && candidate.selected.every((item) => other.set.has(item))
    ))
  ));

  const bySupport = new Map<string, EvidenceRegion>();
  for (const { selected } of maximalSelections) {
    const region = regionFromSelectedEvidence(selected);
    if (!region) continue;
    const key = regionKey(region);
    const existing = bySupport.get(key);
    if (!existing || compareRegions(region, existing) < 0) bySupport.set(key, region);
  }
  return [...bySupport.values()].sort(compareRegions);
}

type MoveCandidate = {
  region: EvidenceRegion;
  runnerUpJourneys: number;
  proposedPeriodStart: string;
  blockEndedOn: string;
  matchesConfirmedHome: boolean;
};

type ContinuityBlock = {
  dates: readonly string[];
  endedOn: string;
};

type MoveWindowObservation = {
  region: EvidenceRegion;
  runnerUpJourneys: number;
  endedOn: string;
};

function isCandidateRegion(region: EvidenceRegion): boolean {
  return region.journeyCount >= HOME_BASE_CANDIDATE_MIN_JOURNEYS
    && region.evidenceSpanDays >= HOME_BASE_CANDIDATE_MIN_SPAN_DAYS;
}

function hasCandidateEvidenceWindow(
  region: EvidenceRegion,
  startedOn: string,
  endedOn: string,
): boolean {
  if (spanDays(startedOn, endedOn) < HOME_BASE_CANDIDATE_MIN_SPAN_DAYS) return false;
  const journeys = new Set<string>();
  for (const item of region.selectedEvidence) {
    if (item.date >= startedOn && item.date <= endedOn) journeys.add(item.journeyId);
  }
  return journeys.size >= HOME_BASE_CANDIDATE_MIN_JOURNEYS;
}

function continuityBlocks(region: EvidenceRegion): ContinuityBlock[] {
  const dates = [...new Set(region.selectedEvidence.map((item) => item.date))].sort();
  if (dates.length === 0) return [];

  // Do not turn the 90-day minimum evidence span into an undocumented maximum
  // gap. A hiatus is only a boundary when the evidence after it already forms
  // an independent V1 candidate and the hiatus is longer than that candidate's
  // entire observed span. This drops an isolated historical visit before a
  // coherent newer candidate without breaking sparse long-term repeated support.
  const split = (blockDates: readonly string[]): ContinuityBlock[] => {
    if (blockDates.length < 2) {
      return [{ dates: blockDates, endedOn: blockDates[blockDates.length - 1] }];
    }

    const blockEnd = blockDates[blockDates.length - 1];
    for (let index = blockDates.length - 1; index >= 1; index -= 1) {
      const suffixStart = blockDates[index];
      if (!hasCandidateEvidenceWindow(region, suffixStart, blockEnd)) continue;

      const hiatusDays = spanDays(blockDates[index - 1], suffixStart);
      const suffixSpanDays = spanDays(suffixStart, blockEnd);
      if (hiatusDays <= suffixSpanDays) continue;

      return [
        ...split(blockDates.slice(0, index)),
        ...split(blockDates.slice(index)),
      ];
    }

    return [{ dates: blockDates, endedOn: blockEnd }];
  };

  return split(dates);
}

function findSustainedMove(
  regions: readonly EvidenceRegion[],
  confirmedPeriod: ConfirmedHomeBasePeriod,
): MoveCandidate | null {
  const candidates: MoveCandidate[] = [];
  const observations: MoveWindowObservation[] = [];
  const windowCache = new Map<string, EvidenceRegion[]>();
  const regionsForWindow = (startedOn: string, endedOn: string): EvidenceRegion[] => {
    const key = `${startedOn}|${endedOn}`;
    const cached = windowCache.get(key);
    if (cached) return cached;
    const computed = windowRegions(regions, startedOn, endedOn);
    windowCache.set(key, computed);
    return computed;
  };

  for (const targetRegion of regions) {
    for (const block of continuityBlocks(targetRegion)) {
      // Ascending dates find the earliest onset whose suffix satisfies the full
      // V1 suggestion policy. Stop at the first match instead of rebuilding the
      // medoid for every later suffix after the move is already established.
      for (const candidateDate of block.dates) {
        const candidateRegions = regionsForWindow(candidateDate, block.endedOn);
        const windowLeader = candidateRegions[0];
        if (!windowLeader) continue;

        const targetDistance = haversineDistanceKm(
          targetRegion.anchor.latitude,
          targetRegion.anchor.longitude,
          windowLeader.anchor.latitude,
          windowLeader.anchor.longitude,
        );
        if (targetDistance > HOME_BASE_CLUSTER_RADIUS_KM) continue;

        const runnerUpJourneys = runnerUpSupport(windowLeader, candidateRegions);
        if (!meetsSuggestionPolicy(windowLeader, runnerUpJourneys)) continue;

        const confirmedDistance = haversineDistanceKm(
          confirmedPeriod.latitude,
          confirmedPeriod.longitude,
          windowLeader.anchor.latitude,
          windowLeader.anchor.longitude,
        );
        candidates.push({
          region: windowLeader,
          runnerUpJourneys,
          proposedPeriodStart: windowLeader.evidenceStartedOn,
          blockEndedOn: windowLeader.evidenceEndedOn,
          matchesConfirmedHome: confirmedDistance <= HOME_BASE_CLUSTER_RADIUS_KM,
        });
        break;
      }

      // Currentness only needs the latest candidate-strength observation for a
      // block. Scan backward and stop at that first observation; earlier suffixes
      // cannot be more current, and expired competition is handled by endedOn.
      for (let index = block.dates.length - 1; index >= 0; index -= 1) {
        const currentRegions = regionsForWindow(block.dates[index], block.endedOn);
        const currentLeader = currentRegions[0];
        if (!currentLeader) continue;
        const currentRunnerUp = runnerUpSupport(currentLeader, currentRegions);
        if (!isCandidateRegion(currentLeader)) continue;
        observations.push({
          region: currentLeader,
          runnerUpJourneys: currentRunnerUp,
          endedOn: currentLeader.evidenceEndedOn,
        });
        break;
      }
    }
  }

  candidates.sort((left, right) => (
    right.blockEndedOn.localeCompare(left.blockEndedOn)
    // If two independently sustained states end on the same date, retaining the
    // already-confirmed Home is the conservative deterministic tie-break.
    || Number(right.matchesConfirmedHome) - Number(left.matchesConfirmedHome)
    || compareRegions(left.region, right.region)
    || left.proposedPeriodStart.localeCompare(right.proposedPeriodStart)
  ));
  const latest = candidates[0] ?? null;
  if (!latest || latest.matchesConfirmedHome) return null;

  const laterConflict = observations.some((observation) => {
    // A competing window that ended before the move candidate's latest evidence
    // is historical, not the current state. Only evidence that reaches at least
    // as far forward as the candidate can invalidate an otherwise sustained move.
    if (observation.endedOn < latest.blockEndedOn) return false;
    const moveDistance = haversineDistanceKm(
      latest.region.anchor.latitude,
      latest.region.anchor.longitude,
      observation.region.anchor.latitude,
      observation.region.anchor.longitude,
    );
    if (moveDistance > HOME_BASE_CLUSTER_RADIUS_KM) return true;

    // Corroborating candidate-strength evidence in the same metro does not
    // retire an established move merely because it has fewer than four new
    // Journeys. Genuine later competition does: once the same-metro leader can
    // no longer clear the owner-defined >=2 Journey margin, the historical open
    // move is no longer the unambiguous current state.
    return observation.region.journeyCount - observation.runnerUpJourneys
      < HOME_BASE_MIN_LEAD_JOURNEYS;
  });

  return laterConflict ? null : latest;
}

function runnerUpSupport(leader: EvidenceRegion, regions: readonly EvidenceRegion[]): number {
  const leaderJourneys = new Set(leader.supports.map((support) => support.journeyId));
  let strongestRunnerUp = 0;
  for (const region of regions) {
    if (region === leader) continue;
    const anchorDistance = haversineDistanceKm(
      leader.anchor.latitude,
      leader.anchor.longitude,
      region.anchor.latitude,
      region.anchor.longitude,
    );
    if (anchorDistance <= HOME_BASE_CLUSTER_RADIUS_KM) {
      // Overlapping bounded cliques near one metro are variants of the same
      // hypothesis. Only genuinely novel Journeys compete with the leader;
      // shared B evidence must not make A+B / B+C look like two four-Journey
      // metros when the actual competing tail is only C's two Journeys.
      const novelJourneys = region.supports.filter(
        (support) => !leaderJourneys.has(support.journeyId),
      ).length;
      strongestRunnerUp = Math.max(strongestRunnerUp, novelJourneys);
      continue;
    }
    strongestRunnerUp = Math.max(strongestRunnerUp, region.journeyCount);
  }
  return strongestRunnerUp;
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

function assessRegion(region: EvidenceRegion, runnerUpJourneys: number) {
  const reasonCodes: HomeBaseEvidenceReasonCode[] = [];
  if (region.journeyCount >= HOME_BASE_CANDIDATE_MIN_JOURNEYS) {
    reasonCodes.push("CANDIDATE_JOURNEY_THRESHOLD_MET");
  }
  if (region.evidenceSpanDays >= HOME_BASE_CANDIDATE_MIN_SPAN_DAYS) {
    reasonCodes.push("CANDIDATE_SPAN_THRESHOLD_MET");
  }
  if (region.journeyCount >= HOME_BASE_SUGGESTED_MIN_JOURNEYS) {
    reasonCodes.push("SUGGESTED_JOURNEY_THRESHOLD_MET");
  }
  if (region.evidenceSpanDays >= HOME_BASE_SUGGESTED_MIN_SPAN_DAYS) {
    reasonCodes.push("SUGGESTED_SPAN_THRESHOLD_MET");
  }
  if (region.startCount >= HOME_BASE_MIN_START_SUPPORT) {
    reasonCodes.push("START_SUPPORT_THRESHOLD_MET");
  }
  if (region.endCount >= HOME_BASE_MIN_END_SUPPORT) {
    reasonCodes.push("END_SUPPORT_THRESHOLD_MET");
  }
  if (region.journeyCount - runnerUpJourneys >= HOME_BASE_MIN_LEAD_JOURNEYS) {
    reasonCodes.push("LEADER_MARGIN_THRESHOLD_MET");
  }

  const digest = homeBaseEvidenceDigest({
    anchor: region.anchor,
    supports: region.supports,
    evidenceStartedOn: region.evidenceStartedOn,
    evidenceEndedOn: region.evidenceEndedOn,
  });
  return {
    reasonCodes,
    digest,
    base: {
      metroAnchor: region.anchor,
      evidenceDigest: digest,
      support: {
        journeys: region.journeyCount,
        starts: region.startCount,
        ends: region.endCount,
        runnerUpJourneys,
        evidenceSpanDays: region.evidenceSpanDays,
        evidenceStartedOn: region.evidenceStartedOn,
        evidenceEndedOn: region.evidenceEndedOn,
      },
    },
    isCandidate: region.journeyCount >= HOME_BASE_CANDIDATE_MIN_JOURNEYS
      && region.evidenceSpanDays >= HOME_BASE_CANDIDATE_MIN_SPAN_DAYS,
    isSuggested: meetsSuggestionPolicy(region, runnerUpJourneys),
  };
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
    && input.confirmedPeriod.endedOn === null
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

  const leaderAssessment = assessRegion(leader, runnerUpSupport(leader, regions));

  if (activeConfirmedPeriod) {
    // Move detection is temporal rather than cumulative: a long-lived confirmed
    // Home may remain the all-history leader after a different metro has already
    // formed a self-sufficient recent block.
    const move = findSustainedMove(regions, activeConfirmedPeriod);
    if (move) {
      const moveAssessment = assessRegion(move.region, move.runnerUpJourneys);
      const dismissalState = matchingDismissal(
        input.dismissal,
        move.region,
        moveAssessment.digest,
        input.evaluationDate,
      );
      if (dismissalState) {
        return {
          state: "dismissed",
          ...moveAssessment.base,
          reasonCodes: [
            ...moveAssessment.reasonCodes,
            dismissalState === "rejected" ? "REJECTED_DISMISSAL_ACTIVE" : "SOFT_DISMISSAL_ACTIVE",
          ],
          proposedPeriodStart: null,
        };
      }
      return {
        state: "move_suggested",
        ...moveAssessment.base,
        reasonCodes: [...moveAssessment.reasonCodes, "DIFFERS_FROM_CONFIRMED_HOME"],
        proposedPeriodStart: move.proposedPeriodStart,
      };
    }

    if (!leaderAssessment.isCandidate) {
      return {
        state: "insufficient_evidence",
        ...leaderAssessment.base,
        reasonCodes: leaderAssessment.reasonCodes,
        proposedPeriodStart: null,
      };
    }

    const confirmedDistance = haversineDistanceKm(
      activeConfirmedPeriod.latitude,
      activeConfirmedPeriod.longitude,
      leader.anchor.latitude,
      leader.anchor.longitude,
    );
    return {
      state: "candidate",
      ...leaderAssessment.base,
      reasonCodes: confirmedDistance <= HOME_BASE_CLUSTER_RADIUS_KM
        ? [...leaderAssessment.reasonCodes, "MATCHES_CONFIRMED_HOME"]
        : leaderAssessment.reasonCodes,
      proposedPeriodStart: null,
    };
  }

  if (!leaderAssessment.isCandidate) {
    return {
      state: "insufficient_evidence",
      ...leaderAssessment.base,
      reasonCodes: leaderAssessment.reasonCodes,
      proposedPeriodStart: null,
    };
  }

  if (!leaderAssessment.isSuggested) {
    return {
      state: "candidate",
      ...leaderAssessment.base,
      reasonCodes: leaderAssessment.reasonCodes,
      proposedPeriodStart: null,
    };
  }

  const dismissalState = matchingDismissal(
    input.dismissal,
    leader,
    leaderAssessment.digest,
    input.evaluationDate,
  );
  if (dismissalState) {
    return {
      state: "dismissed",
      ...leaderAssessment.base,
      reasonCodes: [
        ...leaderAssessment.reasonCodes,
        dismissalState === "rejected" ? "REJECTED_DISMISSAL_ACTIVE" : "SOFT_DISMISSAL_ACTIVE",
      ],
      proposedPeriodStart: null,
    };
  }

  return {
    state: "suggested",
    ...leaderAssessment.base,
    reasonCodes: leaderAssessment.reasonCodes,
    proposedPeriodStart: null,
  };
}
