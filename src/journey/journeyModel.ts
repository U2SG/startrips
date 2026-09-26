import type {
  Journey,
  JourneyInput,
  JourneyMediaAsset,
  JourneyRoute,
  JourneyYearGroup,
} from "./types";
import { isPersistedCalendarDate } from "./calendarDate";
import { isLightEffectId } from "./lightEffects";

export const MAX_JOURNEY_FILE_BYTES = 2_000_000_000;
export const MAX_JOURNEY_SOUNDTRACK_BYTES = 100 * 1024 * 1024;
export const MAX_ROUTE_POINTS = 64;
export const ROUTE_POINT_PLACE_ROLES = new Set([
  "accommodation",
  "attraction",
  "transport",
  "pure-transit",
  "activity",
]);
export const ROUTE_POINT_OVERVIEW_VISIBILITIES = new Set(["auto", "main", "detail"]);

export const ACCEPTED_JOURNEY_MEDIA_TYPES = new Set([
  "image/avif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);

// Browsers disagree on the type they report for the same container, so every
// common spelling of MP3, M4A/MP4 audio, AAC, OGG, and WAV is accepted here.
// The server repeats this list as the authoritative validator.
export const ACCEPTED_JOURNEY_SOUNDTRACK_TYPES = new Set([
  "audio/aac",
  "audio/mp3",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/wave",
  "audio/x-m4a",
  "audio/x-wav",
]);

export type MediaFileLike = Pick<File, "name" | "size" | "type">;

export type ValidationResult = {
  accepted: boolean;
  errors: string[];
};

export function sortJourneysChronologically(journeys: readonly Journey[]) {
  return [...journeys].sort((left, right) => {
    const byDate = left.startedOn.localeCompare(right.startedOn);
    if (byDate !== 0) return byDate;
    return left.createdAt.localeCompare(right.createdAt);
  });
}

export function groupJourneysByYear(
  journeys: readonly Journey[],
): JourneyYearGroup[] {
  const groups = new Map<number, Journey[]>();
  for (const journey of sortJourneysChronologically(journeys)) {
    const year = Number(journey.startedOn.slice(0, 4));
    const group = groups.get(year);
    if (group) group.push(journey);
    else groups.set(year, [journey]);
  }
  return [...groups].map(([year, groupJourneys]) => ({
    year,
    journeys: groupJourneys,
  }));
}

export function mergeJourney(
  journeys: readonly Journey[],
  journey: Journey,
): Journey[] {
  return sortJourneysChronologically([
    ...journeys.filter((candidate) => candidate.id !== journey.id),
    journey,
  ]);
}

export type JourneyStaySummary = {
  /** Derived identity only; never persisted as a second place/stay record. */
  id: string;
  journeyId: string;
  regionContext: string | null;
  label: string;
  anchorRoutePointId: string;
  routePointIds: string[];
  mediaAssetIds: string[];
  startRouteIndex: number;
  endRouteIndex: number;
  overviewVisible: boolean;
};

export type JourneyStayProjectionOptions = {
  /** Filter authorization/time visibility before aggregation. */
  includedRoutePointIds?: ReadonlySet<string>;
  includedMediaAssetIds?: ReadonlySet<string>;
};

const MAX_DERIVED_STAY_GAP_KM = 120;
const EARTH_RADIUS_KM = 6371;

function radians(value: number) {
  return value * Math.PI / 180;
}

function routePointDistanceKm(
  left: Pick<Journey["routePoints"][number], "latitude" | "longitude">,
  right: Pick<Journey["routePoints"][number], "latitude" | "longitude">,
) {
  const latitudeDelta = radians(right.latitude - left.latitude);
  const longitudeDelta = radians(right.longitude - left.longitude);
  const latitudeA = radians(left.latitude);
  const latitudeB = radians(right.latitude);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(latitudeA) * Math.cos(latitudeB) * Math.sin(longitudeDelta / 2) ** 2;
  const bounded = Math.max(0, Math.min(1, a));
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(bounded), Math.sqrt(1 - bounded));
}

function normalizedRegionContext(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed.normalize("NFKC").toLowerCase() : null;
}

function routePointCanRepresentStay(point: Journey["routePoints"][number]) {
  if (!point.isStop) return false;
  return point.placeRole !== "transport" && point.placeRole !== "pure-transit";
}

export function journeyOverviewRoutePointIds(
  journey: Pick<Journey, "routePoints">,
  summaries: readonly JourneyStaySummary[],
): string[] {
  const overviewIds = summaries
    .filter((summary) => summary.overviewVisible)
    .map((summary) => summary.anchorRoutePointId);
  // A filtered projection with no currently visible stay must stay empty.
  // Falling back to route endpoints here would leak future/unauthorized Stops
  // back onto the overview and make an apparently visible marker unclickable.
  if (
    overviewIds.length > 0
    || journey.routePoints.some(routePointCanRepresentStay)
    || journey.routePoints.length === 0
  ) {
    return overviewIds;
  }
  // True geometry-only legacy Journeys still need stable entry anchors without
  // inventing a city/stay record. Reuse their canonical endpoints only.
  const firstId = journey.routePoints[0].id;
  const lastId = journey.routePoints[journey.routePoints.length - 1].id;
  return firstId === lastId ? [firstId] : [firstId, lastId];
}

function chooseStayAnchor(points: readonly Journey["routePoints"][number][]) {
  const overviewCandidates = points.filter((point) => point.overviewVisibility !== "detail");
  const candidates = overviewCandidates.length > 0 ? overviewCandidates : points;
  return candidates.find((point) => point.overviewVisibility === "main")
    ?? candidates.find((point) => point.placeRole !== "accommodation")
    ?? candidates[0];
}

/**
 * #514 mainline projection. This derives consecutive city/region stays from
 * canonical Route Points without inventing city-center nodes or mutating the
 * route. Unknown regions stay independent. Repeated same-name regions farther
 * than a metro-scale bound also stay independent, so a label alone cannot
 * collapse distinct places. Explicit region corrections re-segment naturally.
 */
export function deriveJourneyStaySummaries(
  journey: Pick<Journey, "id" | "routePoints" | "media">,
  options: JourneyStayProjectionOptions = {},
): JourneyStaySummary[] {
  const candidates = journey.routePoints
    .map((point, routeIndex) => ({ point, routeIndex }))
    .filter(({ point }) => routePointCanRepresentStay(point))
    .filter(({ point }) => !options.includedRoutePointIds || options.includedRoutePointIds.has(point.id));

  const groups: Array<{
    regionKey: string;
    regionContext: string | null;
    rows: typeof candidates;
  }> = [];
  for (const row of candidates) {
    const regionKey = normalizedRegionContext(row.point.regionContext);
    const previous = groups.at(-1);
    const previousPoint = previous?.rows.at(-1)?.point;
    const mayJoinPrevious = Boolean(
      regionKey
      && previous
      && previous.regionKey === regionKey
      && previousPoint
      && routePointDistanceKm(previousPoint, row.point) <= MAX_DERIVED_STAY_GAP_KM,
    );
    if (mayJoinPrevious && previous) {
      previous.rows.push(row);
      continue;
    }
    groups.push({
      regionKey: regionKey ?? `route-point:${row.point.id}`,
      regionContext: row.point.regionContext?.trim() || null,
      rows: [row],
    });
  }

  // Assign media in one pass after grouping. This preserves canonical media
  // order while keeping aggregation O(route points + media) rather than
  // rescanning every asset for every stay on media-heavy Journeys.
  const groupIndexByRoutePointId = new Map<string, number>();
  groups.forEach((group, groupIndex) => {
    group.rows.forEach(({ point }) => groupIndexByRoutePointId.set(point.id, groupIndex));
  });
  const mediaIdsByGroup = groups.map(() => [] as string[]);
  for (const asset of journey.media) {
    if (asset.routePointId === null) continue;
    if (options.includedMediaAssetIds && !options.includedMediaAssetIds.has(asset.id)) continue;
    const groupIndex = groupIndexByRoutePointId.get(asset.routePointId);
    if (groupIndex === undefined) continue;
    mediaIdsByGroup[groupIndex]?.push(asset.id);
  }

  return groups.map((group, groupIndex) => {
    const points = group.rows.map(({ point }) => point);
    const anchor = chooseStayAnchor(points);
    const routePointIds = points.map((point) => point.id);
    return {
      id: `stay:${journey.id}:${group.rows[0].point.id}`,
      journeyId: journey.id,
      regionContext: group.regionContext,
      label: group.regionContext ?? anchor.label,
      anchorRoutePointId: anchor.id,
      routePointIds,
      mediaAssetIds: mediaIdsByGroup[groupIndex] ?? [],
      startRouteIndex: group.rows[0].routeIndex,
      endRouteIndex: group.rows[group.rows.length - 1].routeIndex,
      overviewVisible: points.some((point) => point.overviewVisibility !== "detail"),
    };
  });
}

export function toJourneyRoutes(
  journeys: readonly Journey[],
  overviewLabels: ReadonlyMap<string, string> = new Map(),
): JourneyRoute[] {
  return journeys.map((journey) => ({
    id: journey.id,
    color: journey.lightColor,
    lightEffect: journey.lightEffect ?? null,
    points: journey.routePoints.map((point) => ({
      id: point.id,
      lat: point.latitude,
      lon: point.longitude,
      isStop: point.isStop,
      label: point.label,
      ...(overviewLabels.has(point.id) ? { overviewLabel: overviewLabels.get(point.id) } : {}),
    })),
  }));
}

export function validateJourneyInput(input: JourneyInput): ValidationResult {
  const errors: string[] = [];
  if (!input.title.trim() || input.title.length > 80) {
    errors.push("旅程标题不能为空且不能超过 80 个字符");
  }
  if (!isPersistedCalendarDate(input.startedOn)) {
    errors.push("开始日期无效");
  }
  if (input.endedOn !== null && !isPersistedCalendarDate(input.endedOn)) {
    errors.push("结束日期无效");
  } else if (input.endedOn !== null && input.endedOn < input.startedOn) {
    errors.push("结束日期不能早于开始日期");
  }
  if (input.note.length > 2000) errors.push("旅程故事不能超过 2000 个字符");
  if (!/^#[0-9a-fA-F]{6}$/.test(input.lightColor)) {
    errors.push("旅程颜色无效");
  }
  if (input.lightEffect !== undefined && input.lightEffect !== null && !isLightEffectId(input.lightEffect)) {
    errors.push("旅程光效无效");
  }
  if (input.routePoints.length < 1 || input.routePoints.length > MAX_ROUTE_POINTS) {
    errors.push(`路线必须包含 1 到 ${MAX_ROUTE_POINTS} 个点`);
  }

  let lastOccurredAt = "";
  input.routePoints.forEach((point, index) => {
    if (!Number.isFinite(point.latitude) || point.latitude < -90 || point.latitude > 90) {
      errors.push(`路线点 ${index + 1} 的纬度无效`);
    }
    if (!Number.isFinite(point.longitude) || point.longitude < -180 || point.longitude > 180) {
      errors.push(`路线点 ${index + 1} 的经度无效`);
    }
    if (point.label.length > 120) {
      errors.push(`路线点 ${index + 1} 的标签不能超过 120 个字符`);
    }
    if (point.isStop && !point.label.trim()) {
      errors.push(`停靠点 ${index + 1} 需要地点标签`);
    }
    // #10: route-point notes are plain text with a soft client cap (500) and
    // a hard server cap (2000); keep the client check in sync with the UX.
    if (point.note !== undefined && point.note !== null && point.note.length > 500) {
      errors.push(`路线点 ${index + 1} 的笔记不能超过 500 个字符`);
    }
    if (point.regionContext !== undefined && point.regionContext !== null && point.regionContext.length > 120) {
      errors.push(`路线点 ${index + 1} 的停留区域不能超过 120 个字符`);
    }
    if (point.placeRole !== undefined && point.placeRole !== null && !ROUTE_POINT_PLACE_ROLES.has(point.placeRole)) {
      errors.push(`路线点 ${index + 1} 的地点类型无效`);
    }
    if (
      point.overviewVisibility !== undefined
      && point.overviewVisibility !== null
      && !ROUTE_POINT_OVERVIEW_VISIBILITIES.has(point.overviewVisibility)
    ) {
      errors.push(`路线点 ${index + 1} 的概览显示设置无效`);
    }
    if (point.occurredAt !== null) {
      const timestamp = new Date(point.occurredAt);
      if (Number.isNaN(timestamp.valueOf())) {
        errors.push(`路线点 ${index + 1} 的时间无效`);
      } else {
        const canonical = timestamp.toISOString();
        if (lastOccurredAt && canonical < lastOccurredAt) {
          errors.push("路线点时间必须按旅程顺序递增");
        }
        lastOccurredAt = canonical;
      }
    }
  });

  return { accepted: errors.length === 0, errors };
}

// A soundtrack is recognized by its MIME prefix rather than by the accepted
// upload list, so an asset stored before a format was allowed still behaves as
// audio instead of rendering as a broken photo.
export function isSoundtrackAsset(
  asset: Pick<JourneyMediaAsset, "mimeType">,
): boolean {
  return typeof asset.mimeType === "string"
    && asset.mimeType.startsWith("audio/");
}

export function isVisualMediaAsset(
  asset: Pick<JourneyMediaAsset, "mimeType">,
): boolean {
  return !isSoundtrackAsset(asset);
}

export function journeyVisualMedia(
  journey: Pick<Journey, "media">,
): JourneyMediaAsset[] {
  return journey.media.filter(isVisualMediaAsset);
}

// #14: the journey cover — the explicit coverMediaAssetId when it is a valid
// visual asset of this journey, otherwise the first visual media by sortOrder,
// otherwise null. Reordering never changes the explicit cover.
export function journeyCover(
  journey: Pick<Journey, "coverMediaAssetId" | "media">,
): JourneyMediaAsset | null {
  const visual = journeyVisualMedia(journey);
  if (journey.coverMediaAssetId) {
    const explicit = visual.find(
      (asset) => asset.id === journey.coverMediaAssetId,
    );
    if (explicit) return explicit;
  }
  return visual[0] ?? null;
}

// Every completed upload receives the highest sortOrder in its journey, so the
// newest track is already the active one before an older track is cleaned up.
export function journeySoundtrack(
  journey: Pick<Journey, "media">,
): JourneyMediaAsset | null {
  return journey.media
    .filter(isSoundtrackAsset)
    .reduce<JourneyMediaAsset | null>(
      (latest, asset) => !latest || asset.sortOrder > latest.sortOrder
        ? asset
        : latest,
      null,
    );
}

// Audio file extensions never enter the presentation layer (#7): the UI shows
// `飞云之下 韩红林俊杰`, never `飞云之下 韩红林俊杰.mp3`. The database file name
// is untouched.
const SOUNDTRACK_EXTENSIONS = new Set([
  ".mp3",
  ".m4a",
  ".aac",
  ".ogg",
  ".wav",
  ".wave",
]);

export function stripMediaExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return fileName;
  const extension = fileName.slice(dot).toLowerCase();
  return SOUNDTRACK_EXTENSIONS.has(extension)
    ? fileName.slice(0, dot)
    : fileName;
}

// #12: reorder one scope of visual media and map it back onto the full visual
// order without touching other scopes. `scopeId` is a route point id (or null
// for journey-scoped media). Only the relative order inside the scope changes;
// every other scope's items keep their positions, and the soundtrack never
// enters the reorder at all (it is not visual media).
export function applyScopeReorder(
  visualMedia: readonly JourneyMediaAsset[],
  scopeId: string | null,
  reorderedScopeIds: readonly string[],
): JourneyMediaAsset[] {
  const scopeItems = visualMedia.filter(
    (asset) => asset.routePointId === scopeId,
  );
  // A reorder must contain exactly the scope's assets, once each; anything
  // else is a caller bug and must not corrupt the full order.
  if (scopeItems.length !== reorderedScopeIds.length) return [...visualMedia];
  const expected = new Set(scopeItems.map((asset) => asset.id));
  if (new Set(reorderedScopeIds).size !== reorderedScopeIds.length) {
    return [...visualMedia];
  }
  for (const id of reorderedScopeIds) {
    if (!expected.has(id)) return [...visualMedia];
  }

  const byId = new Map(scopeItems.map((asset) => [asset.id, asset]));
  const reordered = reorderedScopeIds.map((id) => byId.get(id)!);
  const result = [...visualMedia];
  let slot = 0;
  for (let index = 0; index < result.length; index += 1) {
    if (result[index].routePointId === scopeId) {
      result[index] = reordered[slot];
      slot += 1;
    }
  }
  return result;
}

export function validateJourneySoundtrack(
  files: readonly MediaFileLike[],
): ValidationResult {
  if (files.length !== 1) {
    return {
      accepted: false,
      errors: ["每段旅程只保留一首配乐，请选择一个音频文件"],
    };
  }

  const errors: string[] = [];
  const [file] = files;
  if (!file.name.trim() || file.name.length > 180) {
    errors.push("文件名不能为空且不能超过 180 个字符");
  }
  if (!ACCEPTED_JOURNEY_SOUNDTRACK_TYPES.has(file.type)) {
    errors.push(
      `${file.name || "未命名文件"} 不是支持的音频格式，可用 MP3、M4A、AAC、OGG 或 WAV`,
    );
  }
  if (!Number.isSafeInteger(file.size) || file.size < 1) {
    errors.push(`${file.name || "未命名文件"} 是空文件`);
  } else if (file.size > MAX_JOURNEY_SOUNDTRACK_BYTES) {
    errors.push(`${file.name} 超过 100 MB 上限`);
  }

  return { accepted: errors.length === 0, errors };
}

export function validateJourneyFiles(
  files: readonly MediaFileLike[],
): ValidationResult {
  const errors: string[] = [];
  files.forEach((file) => {
    if (!file.name.trim() || file.name.length > 180) {
      errors.push("文件名不能为空且不能超过 180 个字符");
    }
    if (!ACCEPTED_JOURNEY_MEDIA_TYPES.has(file.type)) {
      errors.push(`${file.name || "未命名文件"} 的格式不受支持`);
    }
    if (!Number.isSafeInteger(file.size) || file.size < 1) {
      errors.push(`${file.name || "未命名文件"} 是空文件`);
    } else if (file.size > MAX_JOURNEY_FILE_BYTES) {
      errors.push(`${file.name} 超过 2 GB 上限`);
    }
  });

  return { accepted: errors.length === 0, errors };
}
