export type AutoEditMode = "full" | "quick-recap" | "keepsake";
export type AutoEditTempo = "fast" | "standard" | "immersive";
export type AutoEditSelectionReason =
  | "all-media"
  | "journey-cover"
  | "user-pinned"
  | "route-point-representative"
  | "visual-diversity"
  | "duplicate-cluster-representative"
  | "video-highlight";

export type MediaDigestV1 = {
  schemaVersion: 1;
  assetId: string;
  journeyId: string;
  routePointId: string | null;
  sourceRevision: string;
  mediaType: "image" | "video";
  mimeType: string;
  sourceIndex: number;
  intrinsic: {
    width?: number;
    height?: number;
    durationMs?: number;
    orientation?: "portrait" | "landscape" | "square";
  };
  technical?: {
    sharpness?: number;
    exposureQuality?: number;
    motion?: number;
    audioEnergyMean?: number;
    audioEnergyPeaksMs?: number[];
  };
  similarity?: {
    perceptualHash?: string;
    duplicateClusterId?: string;
    embeddingRef?: string;
  };
  userSignals: {
    isJourneyCover: boolean;
    pinnedForRecap: boolean;
    excludedFromRecap: boolean;
  };
};

export type AutoEditPlanItemV1 = {
  assetId: string;
  sourceIndex: number;
  trim?: { inMs: number; outMs: number };
  dwellMs?: number;
  framing: "contain" | "cover" | "gentle-pan";
  transition: "direct" | "shared-spatial" | "soft-dissolve";
  selectionReason: AutoEditSelectionReason;
};

export type AutoEditPlanV1 = {
  schemaVersion: 1;
  planId: string;
  journeyId: string;
  journeyRevision: string;
  generatedAt: string;
  mode: AutoEditMode;
  targetDurationMs?: number;
  plannedDurationMs: number;
  tempo: AutoEditTempo;
  chapters: Array<{
    chapterId: string;
    routePointId: string | null;
    camera: {
      primitive: "hold" | "short-arc" | "travel" | "pullback-travel";
      durationMs: number;
    };
    arrival?: {
      durationMs: number;
      showPlaceLabel: boolean;
      showNote: boolean;
    };
    items: AutoEditPlanItemV1[];
  }>;
  omittedAssetIds: string[];
};

export type DeterministicQuickRecapInput = {
  journeyId: string;
  journeyRevision: string;
  routePointIds: string[];
  digests: MediaDigestV1[];
  targetDurationMs: number;
  tempo?: AutoEditTempo;
  generatedAt: string;
};

const IMAGE_DWELL_MS: Record<AutoEditTempo, number> = {
  fast: 1_600,
  standard: 2_200,
  immersive: 3_000,
};
const VIDEO_DWELL_MS: Record<AutoEditTempo, number> = {
  fast: 2_600,
  standard: 3_500,
  immersive: 4_500,
};
const CAMERA_MS = 1_000;
const ARRIVAL_MS = 800;

function technicalScore(digest: MediaDigestV1) {
  return (digest.technical?.sharpness ?? 0) + (digest.technical?.exposureQuality ?? 0);
}

function stableCandidateSort(a: MediaDigestV1, b: MediaDigestV1) {
  const hardA = Number(a.userSignals.pinnedForRecap) * 4 + Number(a.userSignals.isJourneyCover) * 2;
  const hardB = Number(b.userSignals.pinnedForRecap) * 4 + Number(b.userSignals.isJourneyCover) * 2;
  if (hardA !== hardB) return hardB - hardA;
  const scoreDelta = technicalScore(b) - technicalScore(a);
  if (scoreDelta !== 0) return scoreDelta;
  if (a.sourceIndex !== b.sourceIndex) return a.sourceIndex - b.sourceIndex;
  return a.assetId.localeCompare(b.assetId);
}

function selectDuplicateRepresentatives(digests: MediaDigestV1[]) {
  const grouped = new Map<string, MediaDigestV1[]>();
  for (const digest of digests) {
    const key = digest.similarity?.duplicateClusterId ?? `asset:${digest.assetId}`;
    const group = grouped.get(key) ?? [];
    group.push(digest);
    grouped.set(key, group);
  }
  return [...grouped.values()]
    .map((group) => [...group].sort(stableCandidateSort)[0])
    .filter((digest): digest is MediaDigestV1 => Boolean(digest));
}

function itemDuration(digest: MediaDigestV1, tempo: AutoEditTempo) {
  if (digest.mediaType === "video") {
    const sourceDuration = digest.intrinsic.durationMs ?? VIDEO_DWELL_MS[tempo];
    return Math.max(1_000, Math.min(sourceDuration, VIDEO_DWELL_MS[tempo]));
  }
  return IMAGE_DWELL_MS[tempo];
}

function selectionReason(digest: MediaDigestV1, clusterSize: number): AutoEditSelectionReason {
  if (digest.userSignals.pinnedForRecap) return "user-pinned";
  if (digest.userSignals.isJourneyCover) return "journey-cover";
  if (digest.mediaType === "video") return "video-highlight";
  if (clusterSize > 1) return "duplicate-cluster-representative";
  return "route-point-representative";
}

export function buildDeterministicQuickRecapPlan(input: DeterministicQuickRecapInput): AutoEditPlanV1 {
  const tempo = input.tempo ?? "standard";
  const canonicalRouteOrder = new Map(input.routePointIds.map((id, index) => [id, index]));
  const eligible = input.digests.filter((digest) =>
    digest.journeyId === input.journeyId &&
    digest.sourceRevision === input.journeyRevision &&
    !digest.userSignals.excludedFromRecap &&
    (digest.routePointId === null || canonicalRouteOrder.has(digest.routePointId)),
  );

  const duplicateSizes = new Map<string, number>();
  for (const digest of eligible) {
    const key = digest.similarity?.duplicateClusterId;
    if (key) duplicateSizes.set(key, (duplicateSizes.get(key) ?? 0) + 1);
  }

  const representatives = selectDuplicateRepresentatives(eligible);
  const selected = new Map<string, MediaDigestV1>();

  for (const digest of eligible) {
    if (digest.userSignals.pinnedForRecap || digest.userSignals.isJourneyCover) selected.set(digest.assetId, digest);
  }

  for (const routePointId of input.routePointIds) {
    const routeCandidates = representatives.filter((digest) => digest.routePointId === routePointId).sort(stableCandidateSort);
    const representative = routeCandidates[0];
    if (representative) selected.set(representative.assetId, representative);
  }

  const introCandidates = representatives.filter((digest) => digest.routePointId === null).sort(stableCandidateSort);
  if (introCandidates[0]) selected.set(introCandidates[0].assetId, introCandidates[0]);

  const baseOverhead = input.routePointIds.length * (CAMERA_MS + ARRIVAL_MS);
  let selectedDuration = [...selected.values()].reduce((sum, digest) => sum + itemDuration(digest, tempo), 0);
  const optional = representatives
    .filter((digest) => !selected.has(digest.assetId))
    .sort((a, b) => {
      const routeA = a.routePointId === null ? -1 : (canonicalRouteOrder.get(a.routePointId) ?? Number.MAX_SAFE_INTEGER);
      const routeB = b.routePointId === null ? -1 : (canonicalRouteOrder.get(b.routePointId) ?? Number.MAX_SAFE_INTEGER);
      if (routeA !== routeB) return routeA - routeB;
      return stableCandidateSort(a, b);
    });
  for (const digest of optional) {
    const duration = itemDuration(digest, tempo);
    if (baseOverhead + selectedDuration + duration > input.targetDurationMs) continue;
    selected.set(digest.assetId, digest);
    selectedDuration += duration;
  }

  const chapterOrder: Array<string | null> = [null, ...input.routePointIds];
  const chapters = chapterOrder.flatMap((routePointId) => {
    const chapterItems = [...selected.values()]
      .filter((digest) => digest.routePointId === routePointId)
      .sort((a, b) => a.sourceIndex - b.sourceIndex)
      .map<AutoEditPlanItemV1>((digest) => {
        const duration = itemDuration(digest, tempo);
        const clusterKey = digest.similarity?.duplicateClusterId;
        return {
          assetId: digest.assetId,
          sourceIndex: digest.sourceIndex,
          ...(digest.mediaType === "video" ? { trim: { inMs: 0, outMs: duration } } : { dwellMs: duration }),
          framing: "contain",
          transition: "direct",
          selectionReason: selectionReason(digest, clusterKey ? (duplicateSizes.get(clusterKey) ?? 1) : 1),
        };
      });
    if (chapterItems.length === 0) return [];
    return [{
      chapterId: routePointId === null ? "journey-intro" : `route:${routePointId}`,
      routePointId,
      camera: { primitive: routePointId === null ? "hold" as const : "travel" as const, durationMs: routePointId === null ? 0 : CAMERA_MS },
      ...(routePointId === null ? {} : { arrival: { durationMs: ARRIVAL_MS, showPlaceLabel: true, showNote: true } }),
      items: chapterItems,
    }];
  });

  const plannedDurationMs = chapters.reduce((sum, chapter) =>
    sum + chapter.camera.durationMs + (chapter.arrival?.durationMs ?? 0) + chapter.items.reduce((itemSum, item) =>
      itemSum + (item.dwellMs ?? (item.trim ? item.trim.outMs - item.trim.inMs : 0)), 0), 0);
  const selectedIds = new Set([...selected.keys()]);
  const omittedAssetIds = eligible
    .filter((digest) => !selectedIds.has(digest.assetId))
    .sort((a, b) => a.sourceIndex - b.sourceIndex)
    .map((digest) => digest.assetId);
  const signature = chapters.flatMap((chapter) => chapter.items.map((item) => item.assetId)).join(",");

  return {
    schemaVersion: 1,
    planId: `baseline:v1:${input.journeyId}:${input.journeyRevision}:${input.targetDurationMs}:${tempo}:${signature}`,
    journeyId: input.journeyId,
    journeyRevision: input.journeyRevision,
    generatedAt: input.generatedAt,
    mode: "quick-recap",
    targetDurationMs: input.targetDurationMs,
    plannedDurationMs,
    tempo,
    chapters,
    omittedAssetIds,
  };
}

export function validateAutoEditPlanV1(plan: AutoEditPlanV1, input: {
  journeyId: string;
  journeyRevision: string;
  routePointIds: string[];
  digests: MediaDigestV1[];
}) {
  const errors: string[] = [];
  if (plan.schemaVersion !== 1) errors.push("unsupported schema version");
  if (plan.journeyId !== input.journeyId) errors.push("journey id mismatch");
  if (plan.journeyRevision !== input.journeyRevision) errors.push("journey revision mismatch");
  const digestById = new Map(input.digests.map((digest) => [digest.assetId, digest]));
  const seen = new Set<string>();
  const routeOrder = new Map(input.routePointIds.map((id, index) => [id, index]));
  let previousRouteIndex = -1;

  for (const chapter of plan.chapters) {
    if (chapter.routePointId !== null) {
      const routeIndex = routeOrder.get(chapter.routePointId);
      if (routeIndex === undefined) errors.push(`unknown route point ${chapter.routePointId}`);
      else if (routeIndex < previousRouteIndex) errors.push("route chronology mismatch");
      else previousRouteIndex = routeIndex;
    }
    for (const item of chapter.items) {
      const digest = digestById.get(item.assetId);
      if (!digest) {
        errors.push(`missing asset ${item.assetId}`);
        continue;
      }
      if (seen.has(item.assetId)) errors.push(`duplicate asset ${item.assetId}`);
      seen.add(item.assetId);
      if (digest.journeyId !== input.journeyId || digest.sourceRevision !== input.journeyRevision) errors.push(`stale asset ${item.assetId}`);
      if (digest.routePointId !== chapter.routePointId) errors.push(`asset chapter mismatch ${item.assetId}`);
      if (digest.userSignals.excludedFromRecap && plan.mode !== "full") errors.push(`excluded asset selected ${item.assetId}`);
      if (item.trim) {
        const sourceDuration = digest.intrinsic.durationMs;
        if (item.trim.inMs < 0 || item.trim.outMs <= item.trim.inMs || sourceDuration === undefined || item.trim.outMs > sourceDuration) {
          errors.push(`invalid trim ${item.assetId}`);
        }
      }
    }
  }

  if (plan.mode === "quick-recap") {
    for (const digest of input.digests) {
      if (digest.journeyId !== input.journeyId || digest.sourceRevision !== input.journeyRevision) continue;
      if (digest.userSignals.pinnedForRecap && !digest.userSignals.excludedFromRecap && !seen.has(digest.assetId)) errors.push(`pinned asset omitted ${digest.assetId}`);
    }
    for (const routePointId of input.routePointIds) {
      const hasEligible = input.digests.some((digest) =>
        digest.journeyId === input.journeyId &&
        digest.sourceRevision === input.journeyRevision &&
        digest.routePointId === routePointId &&
        !digest.userSignals.excludedFromRecap,
      );
      const represented = plan.chapters.some((chapter) => chapter.routePointId === routePointId && chapter.items.length > 0);
      if (hasEligible && !represented) errors.push(`route point omitted ${routePointId}`);
    }
  }

  const recomputedDuration = plan.chapters.reduce((sum, chapter) =>
    sum + chapter.camera.durationMs + (chapter.arrival?.durationMs ?? 0) + chapter.items.reduce((itemSum, item) =>
      itemSum + (item.dwellMs ?? (item.trim ? item.trim.outMs - item.trim.inMs : 0)), 0), 0);
  if (recomputedDuration !== plan.plannedDurationMs) errors.push("planned duration mismatch");

  return { valid: errors.length === 0, errors, recomputedDurationMs: recomputedDuration };
}
