import type {
  Journey,
  JourneyInput,
  JourneyRoute,
  JourneyYearGroup,
} from "./types";

export const MAX_JOURNEY_FILES = 12;
export const MAX_JOURNEY_FILE_BYTES = 2_000_000_000;
export const MAX_ROUTE_POINTS = 64;

export const ACCEPTED_JOURNEY_MEDIA_TYPES = new Set([
  "image/avif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);

export type MediaFileLike = Pick<File, "name" | "size" | "type">;

export type ValidationResult = {
  accepted: boolean;
  errors: string[];
};

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf())
    && parsed.toISOString().slice(0, 10) === value;
}

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

export function toJourneyRoutes(journeys: readonly Journey[]): JourneyRoute[] {
  return journeys.map((journey) => ({
    id: journey.id,
    color: journey.lightColor,
    points: journey.routePoints.map((point) => ({
      lat: point.latitude,
      lon: point.longitude,
      isStop: point.isStop,
      label: point.label,
    })),
  }));
}

export function validateJourneyInput(input: JourneyInput): ValidationResult {
  const errors: string[] = [];
  if (!input.title.trim() || input.title.length > 80) {
    errors.push("旅程标题不能为空且不能超过 80 个字符");
  }
  if (!isValidDate(input.startedOn)) {
    errors.push("开始日期无效");
  }
  if (input.endedOn !== null && !isValidDate(input.endedOn)) {
    errors.push("结束日期无效");
  } else if (input.endedOn !== null && input.endedOn < input.startedOn) {
    errors.push("结束日期不能早于开始日期");
  }
  if (input.note.length > 2000) errors.push("旅程故事不能超过 2000 个字符");
  if (!/^#[0-9a-fA-F]{6}$/.test(input.lightColor)) {
    errors.push("旅程颜色无效");
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

export function validateJourneyFiles(
  files: readonly MediaFileLike[],
): ValidationResult {
  const errors: string[] = [];
  if (files.length > MAX_JOURNEY_FILES) {
    errors.push(`一次最多选择 ${MAX_JOURNEY_FILES} 个媒体文件`);
  }

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
