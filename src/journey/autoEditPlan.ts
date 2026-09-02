export const AUTO_EDIT_MODES = ["full", "quick-recap", "keepsake"] as const;
export type AutoEditMode = typeof AUTO_EDIT_MODES[number];
export const AUTO_EDIT_TEMPOS = ["fast", "standard", "immersive"] as const;
export type AutoEditTempo = typeof AUTO_EDIT_TEMPOS[number];
export const AUTO_EDIT_PHOTO_ROLES = ["hero", "representative", "supporting", "burst"] as const;
export type AutoEditPhotoRole = typeof AUTO_EDIT_PHOTO_ROLES[number];
export const AUTO_EDIT_SELECTION_REASONS = [
  "all-media",
  "journey-cover",
  "user-pinned",
  "route-point-representative",
  "visual-diversity",
  "duplicate-cluster-representative",
  "video-highlight",
] as const;
export type AutoEditSelectionReason = typeof AUTO_EDIT_SELECTION_REASONS[number];
export const AUTO_EDIT_FRAMINGS = ["contain", "cover", "gentle-pan"] as const;
export type AutoEditFraming = typeof AUTO_EDIT_FRAMINGS[number];
export const AUTO_EDIT_TRANSITIONS = ["direct", "shared-spatial", "soft-dissolve"] as const;
export type AutoEditTransition = typeof AUTO_EDIT_TRANSITIONS[number];
export const AUTO_EDIT_CAMERA_PRIMITIVES = ["hold", "short-arc", "travel", "pullback-travel"] as const;
export type AutoEditCameraPrimitive = typeof AUTO_EDIT_CAMERA_PRIMITIVES[number];

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
  photoRole?: AutoEditPhotoRole;
  framing: AutoEditFraming;
  transition: AutoEditTransition;
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
      primitive: AutoEditCameraPrimitive;
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

const IMAGE_DWELL_MS: Record<AutoEditTempo, Record<AutoEditPhotoRole, number>> = {
  fast: { hero: 2_000, representative: 1_600, supporting: 1_200, burst: 700 },
  standard: { hero: 3_100, representative: 2_500, supporting: 1_800, burst: 900 },
  immersive: { hero: 4_900, representative: 4_100, supporting: 3_000, burst: 1_300 },
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
    const clusterKey = digest.similarity?.duplicateClusterId ?? `asset:${digest.assetId}`;
    const key = `${digest.routePointId ?? "journey"}:${clusterKey}`;
    const group = grouped.get(key) ?? [];
    group.push(digest);
    grouped.set(key, group);
  }
  return [...grouped.values()]
    .map((group) => [...group].sort(stableCandidateSort)[0])
    .filter((digest): digest is MediaDigestV1 => Boolean(digest));
}

function itemDuration(
  digest: MediaDigestV1,
  tempo: AutoEditTempo,
  photoRole: AutoEditPhotoRole = "representative",
) {
  if (digest.mediaType === "video") {
    const sourceDuration = digest.intrinsic.durationMs;
    if (sourceDuration === undefined || sourceDuration <= 0) return 0;
    return Math.min(sourceDuration, VIDEO_DWELL_MS[tempo]);
  }
  return IMAGE_DWELL_MS[tempo][photoRole];
}

function photoRoleForChapterItem(
  digest: MediaDigestV1,
  imageIndex: number,
): AutoEditPhotoRole {
  if (imageIndex === 0) return "hero";
  if (digest.userSignals.isJourneyCover || digest.userSignals.pinnedForRecap) return "representative";
  return "supporting";
}

function selectedMediaDuration(
  selected: Iterable<MediaDigestV1>,
  tempo: AutoEditTempo,
) {
  const groups = new Map<string, MediaDigestV1[]>();
  for (const digest of selected) {
    const key = digest.routePointId ?? "__journey__";
    const group = groups.get(key) ?? [];
    group.push(digest);
    groups.set(key, group);
  }
  let total = 0;
  for (const group of groups.values()) {
    let imageIndex = 0;
    for (const digest of [...group].sort((a, b) => a.sourceIndex - b.sourceIndex)) {
      const photoRole = digest.mediaType === "image"
        ? photoRoleForChapterItem(digest, imageIndex++)
        : undefined;
      total += itemDuration(digest, tempo, photoRole);
    }
  }
  return total;
}

function isQuickRecapEligible(
  digest: MediaDigestV1,
  journeyId: string,
  journeyRevision: string,
  canonicalRouteOrder: ReadonlyMap<string, number>,
) {
  return (
    digest.journeyId === journeyId &&
    digest.sourceRevision === journeyRevision &&
    !digest.userSignals.excludedFromRecap &&
    (digest.mediaType !== "video" || (digest.intrinsic.durationMs !== undefined && Number.isFinite(digest.intrinsic.durationMs) && digest.intrinsic.durationMs > 0)) &&
    (digest.routePointId === null || canonicalRouteOrder.has(digest.routePointId))
  );
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
    isQuickRecapEligible(digest, input.journeyId, input.journeyRevision, canonicalRouteOrder),
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
  let selectedDuration = selectedMediaDuration(selected.values(), tempo);
  const optional = representatives
    .filter((digest) => !selected.has(digest.assetId))
    .sort((a, b) => {
      const routeA = a.routePointId === null ? -1 : (canonicalRouteOrder.get(a.routePointId) ?? Number.MAX_SAFE_INTEGER);
      const routeB = b.routePointId === null ? -1 : (canonicalRouteOrder.get(b.routePointId) ?? Number.MAX_SAFE_INTEGER);
      if (routeA !== routeB) return routeA - routeB;
      return stableCandidateSort(a, b);
    });
  for (const digest of optional) {
    selected.set(digest.assetId, digest);
    const nextDuration = selectedMediaDuration(selected.values(), tempo);
    if (baseOverhead + nextDuration > input.targetDurationMs) {
      selected.delete(digest.assetId);
      continue;
    }
    selectedDuration = nextDuration;
  }

  const chapterOrder: Array<string | null> = [null, ...input.routePointIds];
  const chapters = chapterOrder.flatMap((routePointId) => {
    let imageIndex = 0;
    const chapterItems = [...selected.values()]
      .filter((digest) => digest.routePointId === routePointId)
      .sort((a, b) => a.sourceIndex - b.sourceIndex)
      .map<AutoEditPlanItemV1>((digest) => {
        const photoRole = digest.mediaType === "image"
          ? photoRoleForChapterItem(digest, imageIndex++)
          : undefined;
        const duration = itemDuration(digest, tempo, photoRole);
        const clusterKey = digest.similarity?.duplicateClusterId;
        return {
          assetId: digest.assetId,
          sourceIndex: digest.sourceIndex,
          ...(digest.mediaType === "video"
            ? { trim: { inMs: 0, outMs: duration } }
            : { dwellMs: duration, photoRole }),
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

function isFiniteNonNegativeDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isFinitePositiveDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function structurallyValidateAutoEditPlanV1(value: unknown) {
  const errors: string[] = [];
  const root = asRecord(value);
  if (!root) return { plan: null, errors: ["plan must be an object"] };
  if (!Array.isArray(root.chapters)) errors.push("chapters must be an array");
  if (!Array.isArray(root.omittedAssetIds)) {
    errors.push("omittedAssetIds must be an array");
  } else {
    for (let omittedIndex = 0; omittedIndex < root.omittedAssetIds.length; omittedIndex += 1) {
      if (typeof root.omittedAssetIds[omittedIndex] !== "string") {
        errors.push(`omitted asset id invalid ${omittedIndex}`);
      }
    }
  }

  if (Array.isArray(root.chapters)) {
    for (let chapterIndex = 0; chapterIndex < root.chapters.length; chapterIndex += 1) {
      const chapterValue = root.chapters[chapterIndex];
      const chapter = asRecord(chapterValue);
      if (!chapter) {
        errors.push(`chapter ${chapterIndex} must be an object`);
        continue;
      }
      const camera = asRecord(chapter.camera);
      if (!camera) {
        errors.push(`chapter camera invalid ${chapterIndex}`);
      } else if (typeof camera.durationMs !== "number") {
        errors.push(`chapter camera duration invalid ${chapterIndex}`);
      }
      if (!Array.isArray(chapter.items)) {
        errors.push(`chapter items invalid ${chapterIndex}`);
      } else {
        for (let itemIndex = 0; itemIndex < chapter.items.length; itemIndex += 1) {
          const itemValue = chapter.items[itemIndex];
          const item = asRecord(itemValue);
          if (!item) {
            errors.push(`chapter item invalid ${chapterIndex}:${itemIndex}`);
            continue;
          }
          if (typeof item.sourceIndex !== "number") {
            errors.push(`item source index invalid ${chapterIndex}:${itemIndex}`);
          }
          if (Object.prototype.hasOwnProperty.call(item, "dwellMs") && typeof item.dwellMs !== "number") {
            errors.push(`item dwell invalid ${chapterIndex}:${itemIndex}`);
          }
          if (Object.prototype.hasOwnProperty.call(item, "trim") && item.trim !== undefined) {
            const trim = asRecord(item.trim);
            if (!trim) {
              errors.push(`item trim invalid ${chapterIndex}:${itemIndex}`);
            } else if (typeof trim.inMs !== "number" || typeof trim.outMs !== "number") {
              errors.push(`item trim duration invalid ${chapterIndex}:${itemIndex}`);
            }
          }
        }
      }
      if (Object.prototype.hasOwnProperty.call(chapter, "arrival") && chapter.arrival !== undefined) {
        const arrival = asRecord(chapter.arrival);
        if (!arrival) {
          errors.push(`chapter arrival invalid ${chapterIndex}`);
        } else if (typeof arrival.durationMs !== "number") {
          errors.push(`chapter arrival duration invalid ${chapterIndex}`);
        }
      }
    }
  }

  return {
    plan: errors.length === 0 ? root as unknown as AutoEditPlanV1 : null,
    errors,
  };
}

export function validateAutoEditPlanV1(planInput: unknown, input: {
  journeyId: string;
  journeyRevision: string;
  routePointIds: string[];
  digests: MediaDigestV1[];
}) {
  const structural = structurallyValidateAutoEditPlanV1(planInput);
  if (!structural.plan) {
    return { valid: false, errors: structural.errors, recomputedDurationMs: 0 };
  }
  const plan = structural.plan;
  const errors: string[] = [];
  if (plan.schemaVersion !== 1) errors.push("unsupported schema version");
  if (!(AUTO_EDIT_MODES as readonly unknown[]).includes(plan.mode)) errors.push("plan mode invalid");
  if (!(AUTO_EDIT_TEMPOS as readonly unknown[]).includes(plan.tempo)) errors.push("plan tempo invalid");
  if (plan.journeyId !== input.journeyId) errors.push("journey id mismatch");
  if (plan.journeyRevision !== input.journeyRevision) errors.push("journey revision mismatch");
  const digestById = new Map(input.digests.map((digest) => [digest.assetId, digest]));
  const seen = new Set<string>();
  const seenQuickRecapChapterScopes = new Set<string>();
  const seenFullChapterScopes = new Set<string>();
  const routeOrder = new Map(input.routePointIds.map((id, index) => [id, index]));
  const quickRecapEligibleDigests = plan.mode === "quick-recap"
    ? input.digests.filter((digest) => isQuickRecapEligible(
        digest,
        input.journeyId,
        input.journeyRevision,
        routeOrder,
      ))
    : [];
  const quickRecapDuplicateSizes = new Map<string, number>();
  for (const digest of quickRecapEligibleDigests) {
    const clusterKey = digest.similarity?.duplicateClusterId;
    if (clusterKey) quickRecapDuplicateSizes.set(clusterKey, (quickRecapDuplicateSizes.get(clusterKey) ?? 0) + 1);
  }
  let previousRouteIndex = -1;
  let hasSeenRouteChapter = false;

  for (const chapter of plan.chapters) {
    if (plan.mode === "quick-recap") {
      const scopeKey = chapter.routePointId === null ? "__journey_intro__" : `route:${chapter.routePointId}`;
      if (seenQuickRecapChapterScopes.has(scopeKey)) {
        errors.push(`duplicate chapter scope ${chapter.routePointId ?? "journey-intro"}`);
      }
      seenQuickRecapChapterScopes.add(scopeKey);
      if (chapter.items.length === 0) errors.push(`empty quick recap chapter ${chapter.chapterId}`);
    }
    if (plan.mode === "full") {
      const scopeKey = chapter.routePointId === null ? "__journey_intro__" : `route:${chapter.routePointId}`;
      if (seenFullChapterScopes.has(scopeKey)) {
        errors.push(`duplicate full chapter scope ${chapter.routePointId ?? "journey-intro"}`);
      }
      seenFullChapterScopes.add(scopeKey);
      if (chapter.items.length === 0) errors.push(`empty full chapter ${chapter.chapterId}`);
    }
    let previousItemSourceIndex = -1;
    if (!isFiniteNonNegativeDuration(chapter.camera.durationMs)) {
      errors.push(`invalid camera duration ${chapter.chapterId}`);
    }
    if (chapter.arrival && !isFiniteNonNegativeDuration(chapter.arrival.durationMs)) {
      errors.push(`invalid arrival duration ${chapter.chapterId}`);
    }
    if (!(AUTO_EDIT_CAMERA_PRIMITIVES as readonly unknown[]).includes(chapter.camera.primitive)) {
      errors.push(`camera primitive invalid ${chapter.chapterId}`);
    }
    if (chapter.routePointId !== null) {
      hasSeenRouteChapter = true;
      const routeIndex = routeOrder.get(chapter.routePointId);
      if (routeIndex === undefined) errors.push(`unknown route point ${chapter.routePointId}`);
      else if (routeIndex < previousRouteIndex) errors.push("route chronology mismatch");
      else previousRouteIndex = routeIndex;
    } else if ((plan.mode === "full" || plan.mode === "quick-recap") && hasSeenRouteChapter) {
      errors.push("journey intro chronology mismatch");
    }
    for (const item of chapter.items) {
      const digest = digestById.get(item.assetId);
      if (!digest) {
        errors.push(`missing asset ${item.assetId}`);
        continue;
      }
      if (seen.has(item.assetId)) errors.push(`duplicate asset ${item.assetId}`);
      seen.add(item.assetId);
      if (!Number.isFinite(item.sourceIndex) || !Number.isInteger(item.sourceIndex) || item.sourceIndex < 0) {
        errors.push(`invalid source index ${item.assetId}`);
      } else if (item.sourceIndex !== digest.sourceIndex) {
        errors.push(`source index mismatch ${item.assetId}`);
      }
      if (digest.sourceIndex < previousItemSourceIndex) {
        errors.push(`item source order mismatch ${chapter.chapterId}`);
      }
      previousItemSourceIndex = Math.max(previousItemSourceIndex, digest.sourceIndex);
      if (digest.journeyId !== input.journeyId || digest.sourceRevision !== input.journeyRevision) errors.push(`stale asset ${item.assetId}`);
      if (digest.routePointId !== chapter.routePointId) errors.push(`asset chapter mismatch ${item.assetId}`);
      if (digest.userSignals.excludedFromRecap && plan.mode !== "full") errors.push(`excluded asset selected ${item.assetId}`);
      if (!(AUTO_EDIT_FRAMINGS as readonly unknown[]).includes(item.framing)) errors.push(`framing invalid ${item.assetId}`);
      if (!(AUTO_EDIT_TRANSITIONS as readonly unknown[]).includes(item.transition)) errors.push(`transition invalid ${item.assetId}`);
      if (!(AUTO_EDIT_SELECTION_REASONS as readonly unknown[]).includes(item.selectionReason)) errors.push(`selection reason invalid ${item.assetId}`);
      if (plan.mode === "quick-recap") {
        if (item.framing !== "contain") errors.push(`quick recap framing mismatch ${item.assetId}`);
        if (item.transition !== "direct") errors.push(`quick recap transition mismatch ${item.assetId}`);
        const clusterKey = digest.similarity?.duplicateClusterId;
        const expectedSelectionReason = selectionReason(
          digest,
          clusterKey ? (quickRecapDuplicateSizes.get(clusterKey) ?? 1) : 1,
        );
        if (item.selectionReason !== expectedSelectionReason) {
          errors.push(`selection reason mismatch ${item.assetId}`);
        }
        if (digest.mediaType === "image") {
          if (!item.photoRole) errors.push(`photo role missing ${item.assetId}`);
          else if (!(AUTO_EDIT_PHOTO_ROLES as readonly string[]).includes(item.photoRole)) errors.push(`photo role invalid ${item.assetId}`);
        }
        if (digest.mediaType === "video" && Object.prototype.hasOwnProperty.call(item, "photoRole")) errors.push(`video photo role invalid ${item.assetId}`);
      }
      if (digest.mediaType === "image") {
        if (!isFinitePositiveDuration(item.dwellMs)) errors.push(`invalid dwell ${item.assetId}`);
        if (Object.prototype.hasOwnProperty.call(item, "trim")) errors.push(`image trim invalid ${item.assetId}`);
      } else {
        if (Object.prototype.hasOwnProperty.call(item, "dwellMs")) errors.push(`video dwell invalid ${item.assetId}`);
        if (!item.trim) {
          errors.push(`video trim missing ${item.assetId}`);
        } else {
          const sourceDuration = digest.intrinsic.durationMs;
          if (
            !isFiniteNonNegativeDuration(item.trim.inMs)
            || !isFinitePositiveDuration(item.trim.outMs)
            || item.trim.outMs <= item.trim.inMs
            || sourceDuration === undefined
            || !Number.isFinite(sourceDuration)
            || sourceDuration <= 0
            || item.trim.outMs > sourceDuration
          ) {
            errors.push(`invalid trim ${item.assetId}`);
          }
        }
      }
    }
  }

  if (
    plan.mode === "quick-recap"
    && (AUTO_EDIT_TEMPOS as readonly unknown[]).includes(plan.tempo)
    && isFinitePositiveDuration(plan.targetDurationMs)
  ) {
    const expectedPlan = buildDeterministicQuickRecapPlan({
      journeyId: input.journeyId,
      journeyRevision: input.journeyRevision,
      routePointIds: input.routePointIds,
      digests: input.digests,
      targetDurationMs: plan.targetDurationMs,
      tempo: plan.tempo,
      generatedAt: typeof plan.generatedAt === "string" ? plan.generatedAt : "",
    });
    const actualSelectedAssetIds = plan.chapters.flatMap((chapter) => chapter.items.map((item) => item.assetId));
    const expectedSelectedAssetIds = expectedPlan.chapters.flatMap((chapter) => chapter.items.map((item) => item.assetId));
    if (
      actualSelectedAssetIds.length !== expectedSelectedAssetIds.length
      || actualSelectedAssetIds.some((assetId, index) => assetId !== expectedSelectedAssetIds[index])
    ) {
      errors.push("quick recap selection mismatch");
    }
  }

  if (plan.mode === "quick-recap" && !isFinitePositiveDuration(plan.targetDurationMs)) {
    errors.push("quick recap target duration invalid");
  }

  if (plan.mode === "quick-recap") {
    const eligibleDigests = quickRecapEligibleDigests;
    const eligibleById = new Map(eligibleDigests.map((digest) => [digest.assetId, digest]));
    const omissionSet = new Set<string>();
    for (const assetId of plan.omittedAssetIds) {
      if (omissionSet.has(assetId)) errors.push(`duplicate omitted asset ${assetId}`);
      omissionSet.add(assetId);
      if (seen.has(assetId)) errors.push(`selected asset listed omitted ${assetId}`);
      if (!eligibleById.has(assetId)) errors.push(`noneligible omitted asset ${assetId}`);
    }
    const expectedOmittedAssetIds = eligibleDigests
      .filter((digest) => !seen.has(digest.assetId))
      .sort((a, b) => a.sourceIndex - b.sourceIndex)
      .map((digest) => digest.assetId);
    if (
      plan.omittedAssetIds.length !== expectedOmittedAssetIds.length
      || plan.omittedAssetIds.some((assetId, index) => assetId !== expectedOmittedAssetIds[index])
    ) {
      errors.push("omission ledger mismatch");
    }

    for (const digest of eligibleDigests) {
      if (digest.userSignals.pinnedForRecap && !seen.has(digest.assetId)) errors.push(`pinned asset omitted ${digest.assetId}`);
    }
    for (const routePointId of input.routePointIds) {
      const hasEligible = input.digests.some((digest) =>
        digest.routePointId === routePointId && isQuickRecapEligible(digest, input.journeyId, input.journeyRevision, routeOrder),
      );
      const represented = plan.chapters.some((chapter) => chapter.routePointId === routePointId && chapter.items.length > 0);
      if (hasEligible && !represented) errors.push(`route point omitted ${routePointId}`);
    }
  }

  if (!isFiniteNonNegativeDuration(plan.plannedDurationMs)) errors.push("planned duration invalid");
  if (plan.targetDurationMs !== undefined && !isFinitePositiveDuration(plan.targetDurationMs)) errors.push("target duration invalid");

  const recomputedDuration = plan.chapters.reduce((sum, chapter) =>
    sum + chapter.camera.durationMs + (chapter.arrival?.durationMs ?? 0) + chapter.items.reduce((itemSum, item) =>
      itemSum + (item.dwellMs ?? (item.trim ? item.trim.outMs - item.trim.inMs : 0)), 0), 0);
  if (recomputedDuration !== plan.plannedDurationMs) errors.push("planned duration mismatch");

  return { valid: errors.length === 0, errors, recomputedDurationMs: recomputedDuration };
}
