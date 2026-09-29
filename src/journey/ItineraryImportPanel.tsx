import { useCallback, useEffect, useRef, useState } from "react";
import {
  IconArrowDown,
  IconArrowUp,
  IconChevronDown,
  IconMapPin,
  IconPlus,
  IconSearch,
  IconTrash,
  IconUpload,
} from "@tabler/icons-react";
import { searchLocations } from "./journeyApi";
import {
  itineraryCorrectedLocationSuggestion,
  itineraryLocationDisplayNames,
  itineraryLocationSuggestion,
  itineraryReviewedPlaceSuggestion,
} from "./itineraryLocationLookup";
import {
  applyItineraryOrganization,
  buildItineraryImportDraft,
  defaultItinerarySelection,
  isEndpointOnlyLeg,
  itineraryDraftEntries,
  itineraryDraftToRoutePoints,
  itineraryEntryOrganizationTargets,
  itineraryImportJobKey,
  resolveItineraryEntryPosition,
  retainItineraryImportEdits,
  type ItineraryEntryDraft,
  type ItineraryImportDraft,
  type ItineraryRoutePointDraft,
  type ItineraryOrganizationDecision,
} from "./itineraryImport";
import {
  ItineraryImportError,
  itineraryImportStageMessage,
  readItineraryCapabilities,
  readItineraryFromImage,
  readItineraryFromLink,
  readItineraryFromText,
  reviewItineraryLocations,
  type ItineraryImportCapabilities,
  type ItineraryLocationReviewPlan,
} from "./itineraryImportApi";
import {
  mergeItinerarySegmentReadings,
  planItineraryImageSegments,
  type ItineraryImageSegmentPlan,
  type ItinerarySegmentReading,
} from "./itineraryImageSegments";
import { readTextItinerary } from "./itineraryText";
import type { LocationSearchResult } from "./types";

/**
 * #512 follow-up: automatically organize a plan into an editable Route draft.
 * Day and point summaries show the route; optional details stay behind an
 * explicit disclosure. Unresolved and invalid entries remain visible, and
 * human corrections take precedence over any late automatic response.
 */

const ROLE_LABELS: Record<string, string> = {
  accommodation: "住宿",
  attraction: "景点",
  transport: "交通",
  "pure-transit": "途经",
  activity: "活动信息",
};

const FLAG_LABELS: Record<string, string> = {
  "source-invalid": "来源标记已失效",
  truncated: "名称被截断",
  "year-unconfirmed": "年份待确认",
  "unresolved-position": "位置待确认",
  "possible-repeat-visit": "可能是同一处的再次到访",
};

function searchableName(entry: ItineraryEntryDraft) {
  return [entry.name, ...entry.aliases].find((name) =>
    name.trim().length >= 2 && name.trim().length <= 120
  ) ?? "";
}

type Props = {
  onApply: (
    imported: readonly ItineraryRoutePointDraft[],
    insertAfterDraftId: string | null,
    details: { title: string | null; startedOn: string | null; endedOn: string | null },
  ) => void;
  onMessage: (message: string) => void;
  mobileLayout?: boolean;
  standalone?: boolean;
  onWorkStateChange?: (state: { busy: boolean; ready: boolean }) => void;
  /** The draft this import would join, so a position can be chosen in it. */
  existingPoints?: readonly { draftId: string; label: string }[];
};

/** One screenshot the member chose, in the order they arranged it. */
type ChosenImage = { id: string; file: File };

/** JPEG keeps a band inside the per-segment ceiling the server enforces. */
const SEGMENT_MIME_TYPE = "image/jpeg";
const SEGMENT_QUALITY = 0.82;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

/**
 * Cut one band out of one screenshot, at the screenshot's own resolution.
 *
 * Nothing is scaled: a long plan is read in bands precisely so that a printed
 * name never has to survive being shrunk into a few pixels first.
 */
async function encodeSegment(
  bitmap: ImageBitmap,
  segment: ItineraryImageSegmentPlan,
): Promise<{ mimeType: string; base64: string }> {
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = segment.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("this browser cannot read a screenshot here");
  context.drawImage(
    bitmap,
    0,
    segment.top,
    bitmap.width,
    segment.height,
    0,
    0,
    bitmap.width,
    segment.height,
  );
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, SEGMENT_MIME_TYPE, SEGMENT_QUALITY)
  );
  if (!blob) throw new Error("this browser cannot read a screenshot here");
  return {
    mimeType: SEGMENT_MIME_TYPE,
    base64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())),
  };
}

export function ItineraryImportPanel({
  onApply,
  onMessage,
  mobileLayout,
  standalone = false,
  onWorkStateChange,
  existingPoints = [],
}: Props) {
  const [mode, setMode] = useState<"text" | "link" | "image">("link");
  const [expanded, setExpanded] = useState(Boolean(mobileLayout || standalone));
  const [sourceOpen, setSourceOpen] = useState(true);
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);
  const [text, setText] = useState("");
  const [link, setLink] = useState("");
  const [draft, setDraft] = useState<ItineraryImportDraft | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [expandedDays, setExpandedDays] = useState<ReadonlySet<number>>(new Set());
  const [selected, setSelected] = useState<string[]>([]);
  // #512: null is "append to the end", the default that cannot disturb an
  // order the member already arranged.
  const [insertAfterDraftId, setInsertAfterDraftId] = useState<string | null>(null);
  const [images, setImages] = useState<ChosenImage[]>([]);
  const [reading, setReading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<ItineraryImportCapabilities | null>(null);
  const [capabilitiesRequested, setCapabilitiesRequested] = useState(false);
  const [locating, setLocating] = useState<string | null>(null);
  const [lookupProgress, setLookupProgress] = useState<{
    done: number; total: number; unavailable: boolean;
  } | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [manualQuery, setManualQuery] = useState("");
  const readingGeneration = useRef(0);
  const readingController = useRef<AbortController | null>(null);
  const lookupGeneration = useRef(0);
  const manualSearchGeneration = useRef(0);
  const manuallyConfirmed = useRef(new Set<string>());
  const manuallyEditing = useRef(new Set<string>());
  const manuallyOrganized = useRef(new Set<string>());
  const reviewedSearches = useRef(new Map<string, { query: string; results: LocationSearchResult[] }>());
  const [candidates, setCandidates] = useState<
    { entryId: string; results: LocationSearchResult[] } | null
  >(null);
  useEffect(() => () => {
    readingGeneration.current += 1;
    readingController.current?.abort();
    lookupGeneration.current += 1;
    manualSearchGeneration.current += 1;
  }, []);
  // The link tab is initially visible, but that is not a request to contact
  // either provider. Check capabilities only after the member uses an import
  // entry point, so simply opening the Composer has no network side effect.
  useEffect(() => {
    if (!expanded || !capabilitiesRequested) return;
    const controller = new AbortController();
    readItineraryCapabilities(fetch, controller.signal)
      .then(setCapabilities)
      .catch(() => setCapabilities(null));
    return () => controller.abort();
  }, [capabilitiesRequested, expanded, mode]);

  const cancelReading = useCallback(() => {
    readingGeneration.current += 1;
    readingController.current?.abort();
    lookupGeneration.current += 1;
    manualSearchGeneration.current += 1;
    setReading(false);
    setReviewing(false);
    setLookupProgress(null);
    setProgress(null);
    setLocating(null);
  }, []);

  const beginReading = useCallback(() => {
    cancelReading();
    const controller = new AbortController();
    readingController.current = controller;
    setReading(true);
    setError(null);
    return { generation: readingGeneration.current, signal: controller.signal };
  }, [cancelReading]);

  const resolveAutomaticPositions = useCallback((
    next: ItineraryImportDraft,
    matches: Array<{ entry: ItineraryEntryDraft; result: LocationSearchResult }>,
  ) => {
    const editable = (entry: ItineraryEntryDraft) => !manuallyConfirmed.current.has(entry.entryId)
      && !manuallyEditing.current.has(entry.entryId);
    const accepted = matches.filter(({ entry }) => editable(entry));
    setDraft((current) => current?.jobKey === next.jobKey
      ? accepted.filter(({ entry }) => editable(entry)).reduce((value, { entry, result }) => resolveItineraryEntryPosition(value, entry.entryId, {
        latitude: result.latitude, longitude: result.longitude,
        alias: result.labelEnglish ?? result.labelLocal ?? result.label,
      }), current) : current);
    setSelected((current) => [...new Set([...current,
      ...accepted.filter(({ entry }) => editable(entry)).map(({ entry }) => entry.entryId),
    ])]);
    return accepted.length;
  }, []);

  const lookupAll = useCallback(async (next: ItineraryImportDraft, generation: number) => {
    const allEntries = itineraryDraftEntries(next);
    const entries = allEntries.filter((entry) =>
      entry.flags.includes("unresolved-position")
      && !entry.flags.includes("source-invalid")
      && !entry.flags.includes("truncated")
      && entry.countryCode !== null
      && Boolean(entry.searchArea)
      && Boolean(searchableName(entry))
    );
    const found = new Map<string, LocationSearchResult[]>();
    const lookupCache = new Map<string, LocationSearchResult[]>();
    const strictSuggestions: Record<string, LocationSearchResult> = {};
    let unavailable = false;
    setLookupProgress({ done: 0, total: entries.length, unavailable: false });
    for (const [index, entry] of entries.entries()) {
      if (lookupGeneration.current !== generation) return;
      if (manuallyConfirmed.current.has(entry.entryId) || manuallyEditing.current.has(entry.entryId)) {
        setLookupProgress({ done: index + 1, total: entries.length, unavailable: false });
        continue;
      }
      try {
        const query = searchableName(entry);
        const aliases = [entry.name, ...entry.aliases].filter((name) => name !== query);
        const englishAlias = entry.aliases.find((name) =>
          name.length >= 2 && name.length <= 120 && /^[\x20-\x7e]+$/.test(name)
        );
        const cacheKey = JSON.stringify([query, aliases, englishAlias, entry.searchArea, entry.countryCode]);
        let results = lookupCache.get(cacheKey);
        if (!results) {
          // Most translated names return a candidate in one provider request.
          // The whole-plan review checks that candidate's place and context;
          // only an empty answer needs the slower locality/alias sweep.
          results = englishAlias ? (await searchLocations(englishAlias)).results : [];
          if (results.length === 0) {
            results = (await searchLocations(query, fetch, {
              aliases,
              searchArea: entry.searchArea,
              countryCode: entry.countryCode,
            })).results;
          }
          lookupCache.set(cacheKey, results);
        }
        if (lookupGeneration.current !== generation) return;
        found.set(entry.entryId, results);
        reviewedSearches.current.set(entry.entryId, {
          query: englishAlias && results.length > 0 ? englishAlias : query,
          results,
        });
        const suggestion = itineraryLocationSuggestion(entry, results);
        if (suggestion && !manuallyConfirmed.current.has(entry.entryId)
          && !manuallyEditing.current.has(entry.entryId)) {
          strictSuggestions[entry.entryId] = suggestion;
        }
      } catch {
        if (lookupGeneration.current === generation) {
          setLookupProgress({ done: index, total: entries.length, unavailable: true });
        }
        unavailable = true;
        break;
      }
      setLookupProgress({ done: index + 1, total: entries.length, unavailable: false });
    }
    if (lookupGeneration.current !== generation) return;
    if (unavailable) {
      resolveAutomaticPositions(next, allEntries.filter((entry) => strictSuggestions[entry.entryId])
        .map((entry) => ({ entry, result: strictSuggestions[entry.entryId] })));
    }

    setReviewing(true);
    onMessage("正在整理地点与停留，可以继续修改行程。");
    try {
      const plan: ItineraryLocationReviewPlan = {
        sourceTitle: next.sourceTitle,
        days: next.days.map((day) => ({
          dayNumber: day.dayNumber,
          title: day.sourceDayTitle,
          region: day.regionContext,
        })),
        entries: allEntries.map((entry, index) => ({
          index,
          name: entry.name,
          aliases: entry.aliases,
          dayNumber: entry.dayNumber,
          role: entry.role,
          sourceInvalid: entry.flags.includes("source-invalid"),
          countryCode: entry.countryCode,
          searchArea: entry.searchArea,
          candidates: (found.get(entry.entryId) ?? []).map((result) => ({
            id: result.id,
            label: result.label,
            context: result.context,
            countryCode: result.countryCode,
          })),
        })),
      };
      const decisions = await reviewItineraryLocations(plan, fetch, readingController.current?.signal);
      if (lookupGeneration.current !== generation) return;
      if (decisions.length !== allEntries.length) {
        throw new Error("The whole-plan review did not cover every entry");
      }
      const reviewed: Array<{ entry: ItineraryEntryDraft; result: LocationSearchResult }> = [];
      for (const decision of decisions) {
        const entry = allEntries[decision.index];
        if (!entry || entry.flags.includes("source-invalid") || entry.flags.includes("truncated")
          || manuallyConfirmed.current.has(entry.entryId) || manuallyEditing.current.has(entry.entryId)) continue;
        const chosen = found.get(entry.entryId)?.find((result) => result.id === decision.candidateId);
        if (chosen) {
          const results = found.get(entry.entryId) ?? [];
          reviewedSearches.current.set(entry.entryId, {
            query: reviewedSearches.current.get(entry.entryId)?.query ?? searchableName(entry),
            results: [chosen, ...results.filter((result) => result.id !== chosen.id)],
          });
        }
        if (chosen && (itineraryLocationSuggestion({
          ...entry,
          aliases: [...entry.aliases, chosen.label, chosen.labelEnglish ?? "", chosen.labelLocal ?? ""],
        }, [chosen]) || itineraryReviewedPlaceSuggestion(entry, chosen, found.get(entry.entryId) ?? []))) {
          reviewed.push({ entry, result: chosen });
          continue;
        }
        if (!decision.correctedQuery || !entry.searchArea || !entry.countryCode) continue;
        try {
          const { results } = await searchLocations(decision.correctedQuery, fetch, {
            searchArea: entry.searchArea,
            countryCode: entry.countryCode,
          });
          if (lookupGeneration.current !== generation) return;
          const previous = reviewedSearches.current.get(entry.entryId);
          reviewedSearches.current.set(entry.entryId, {
            query: results.length > 0 ? decision.correctedQuery : previous?.query ?? decision.correctedQuery,
            results: [
              ...results,
              ...(previous?.results ?? []).filter((candidate) =>
                !results.some((result) => result.id === candidate.id)
              ),
            ],
          });
          const correction = itineraryCorrectedLocationSuggestion(
            entry, decision.correctedQuery, results,
          );
          if (correction) reviewed.push({ entry, result: correction });
        } catch {
          // A correction without a provider-backed result stays unresolved.
        }
      }
      if (lookupGeneration.current !== generation) return;
      const count = resolveAutomaticPositions(next, reviewed);
      setDraft((current) => current?.jobKey === next.jobKey
        ? applyItineraryOrganization(current, decisions, new Set(manuallyOrganized.current)) : current);
      onMessage(`行程已自动整理，${count} 处位置已补全；点开地点即可修改。`);
    } catch {
      if (lookupGeneration.current === generation) {
        resolveAutomaticPositions(next, allEntries.filter((entry) => strictSuggestions[entry.entryId])
          .map((entry) => ({ entry, result: strictSuggestions[entry.entryId] })));
        onMessage("自动整理暂时无法完成；明确的位置已补全，其余地点可以手动修改。");
      }
    } finally {
      if (lookupGeneration.current === generation) setReviewing(false);
    }
  }, [onMessage, resolveAutomaticPositions]);

  const receive = useCallback((next: ItineraryImportDraft) => {
    const generation = ++lookupGeneration.current;
    manualSearchGeneration.current += 1;
    const previous = draftRef.current;
    const retry = previous?.jobKey === next.jobKey;
    const received = retry ? retainItineraryImportEdits(previous, next,
      manuallyConfirmed.current, manuallyOrganized.current) : next;
    if (!retry) {
      manuallyConfirmed.current.clear();
      manuallyEditing.current.clear();
      manuallyOrganized.current.clear();
    }
    reviewedSearches.current.clear();
    setDraft(received);
    if (!retry) setExpandedDays(new Set(received.days[0] ? [received.days[0].dayNumber] : []));
    setSourceOpen(false);
    if (!retry) setSelected(defaultItinerarySelection(received));
    setReviewing(false);
    setCandidates(null);
    setError(null);
    onMessage(
      `已读到 ${next.counts.recognizedEntryCount} 个条目，正在自动整理地点与停留。`,
    );
    void lookupAll(received, generation);
  }, [lookupAll, onMessage]);

  const fail = useCallback((cause: unknown) => {
    setError(
      cause instanceof ItineraryImportError
        ? itineraryImportStageMessage(cause)
        : "这次没能读取这份行程。",
    );
  }, []);

  const readText = useCallback(async () => {
    if (!text.trim()) return;
    const { generation, signal } = beginReading();
    try {
      const available = capabilities ?? await readItineraryCapabilities(fetch, signal).catch(() => null);
      if (readingGeneration.current !== generation) return;
      if (available) setCapabilities(available);
      const recognition = available?.recognition.configured
        ? await readItineraryFromText(text, fetch, signal) : readTextItinerary(text);
      if (readingGeneration.current !== generation) return;
      receive(buildItineraryImportDraft(recognition, itineraryImportJobKey("text", text)));
    } catch (cause) {
      if (readingGeneration.current === generation) fail(cause);
    } finally {
      if (readingGeneration.current === generation) setReading(false);
    }
  }, [beginReading, capabilities, fail, receive, text]);

  const readLink = useCallback(async () => {
    if (!link.trim()) return;
    const { generation, signal } = beginReading();
    try {
      const recognition = await readItineraryFromLink(link.trim(), fetch, signal);
      if (readingGeneration.current !== generation) return;
      receive(buildItineraryImportDraft(recognition, itineraryImportJobKey("link", link.trim())));
    } catch (cause) {
      if (readingGeneration.current === generation) fail(cause);
    } finally {
      if (readingGeneration.current === generation) setReading(false);
    }
  }, [beginReading, fail, link, receive]);

  const addImages = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return;
    setImages((current) => [
      ...current,
      ...[...files].map((file, index) => ({
        id: `${file.name}:${file.size}:${file.lastModified}:${current.length + index}`,
        file,
      })),
    ]);
    setError(null);
  }, []);

  const moveImage = useCallback((index: number, delta: number) => {
    setImages((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }, []);

  const removeImage = useCallback((id: string) => {
    setImages((current) => current.filter((image) => image.id !== id));
  }, []);

  /**
   * Read every chosen screenshot, in the member's order, as one plan.
   *
   * A tall screenshot is cut into bounded overlapping bands and each band is
   * submitted on its own, because one long image neither fits a request nor
   * survives being scaled down to fit. The bands come back as readings of the
   * same plan and are assembled into one draft here — a screenshot is never a
   * separate itinerary, and the member reviews one list, not one per image.
   */
  const readImages = useCallback(async () => {
    if (images.length === 0) return;
    const { generation, signal } = beginReading();
    setProgress({ done: 0, total: images.length });
    const readings: ItinerarySegmentReading[] = [];
    try {
      for (const [pageIndex, image] of images.entries()) {
        const bitmap = await createImageBitmap(image.file);
        try {
          const segments = planItineraryImageSegments({
            pageIndex,
            width: bitmap.width,
            height: bitmap.height,
          });
          for (const segment of segments) {
            const recognition = await readItineraryFromImage(
              await encodeSegment(bitmap, segment), fetch, signal,
            );
            if (readingGeneration.current !== generation) return;
            readings.push({ segment, recognition });
          }
        } finally {
          bitmap.close();
        }
        if (readingGeneration.current !== generation) return;
        setProgress({ done: pageIndex + 1, total: images.length });
      }
      receive(buildItineraryImportDraft(
        mergeItinerarySegmentReadings(readings),
        itineraryImportJobKey(
          "image",
          images.map((image) => `${image.file.name}:${image.file.size}`).join("|"),
        ),
      ));
    } catch (cause) {
      if (readingGeneration.current === generation) fail(cause);
    } finally {
      if (readingGeneration.current === generation) { setProgress(null); setReading(false); }
    }
  }, [beginReading, fail, images, receive]);

  const locate = useCallback(async (entry: ItineraryEntryDraft, query: string) => {
    const generation = ++manualSearchGeneration.current;
    setLocating(entry.entryId);
    try {
      const typedName = query.trim();
      const knownName = [entry.name, ...entry.aliases].some((name) =>
        name.toLocaleLowerCase() === typedName.toLocaleLowerCase()
      );
      const area = entry.searchArea ?? entry.regionContext;
      const { results } = await searchLocations(typedName, fetch, knownName ? {
        aliases: [entry.name, ...entry.aliases].filter((name) =>
          name.length <= 120 && name.toLocaleLowerCase() !== typedName.toLocaleLowerCase()
        ),
        searchArea: area && area.length <= 120 ? area : null,
        countryCode: entry.countryCode,
      } : undefined);
      if (manualSearchGeneration.current === generation) {
        setCandidates({ entryId: entry.entryId, results });
      }
    } catch {
      if (manualSearchGeneration.current === generation) {
        onMessage("位置搜索暂时不可用，请稍后重试。");
      }
    } finally {
      if (manualSearchGeneration.current === generation) setLocating(null);
    }
  }, [onMessage]);

  const openLocationSearch = useCallback((entry: ItineraryEntryDraft) => {
    manualSearchGeneration.current += 1;
    manuallyEditing.current.add(entry.entryId);
    setLocating(null);
    const prepared = reviewedSearches.current.get(entry.entryId);
    setManualQuery(prepared?.query || searchableName(entry) || entry.name.slice(0, 120));
    setCandidates({ entryId: entry.entryId, results: prepared?.results ?? [] });
  }, []);

  const confirmPosition = useCallback((
    entryId: string,
    result: LocationSearchResult,
  ) => {
    manualSearchGeneration.current += 1;
    setLocating(null);
    manuallyConfirmed.current.add(entryId);
    const entry = draft && itineraryDraftEntries(draft).find((item) => item.entryId === entryId);
    setDraft((current) => {
      if (!current) return current;
      const next = resolveItineraryEntryPosition(current, entryId, {
        latitude: result.latitude,
        longitude: result.longitude,
        alias: result.labelEnglish ?? result.labelLocal ?? result.label,
      });
      return next;
    });
    if (entry && !entry.flags.includes("source-invalid")) {
      setSelected((current) =>
        current.includes(entryId) ? current : [...current, entryId]
      );
    }
    setCandidates(null);
  }, [draft]);

  const changeOrganization = useCallback((entryId: string, changes: Omit<ItineraryOrganizationDecision, "index">) => {
    manuallyOrganized.current.add(entryId);
    setDraft((current) => {
      if (!current) return current;
      const index = itineraryDraftEntries(current).findIndex((entry) => entry.entryId === entryId);
      return index < 0 ? current : applyItineraryOrganization(current, [{ index, ...changes }]);
    });
  }, []);

  // A point deleted from the draft while this panel was open is no longer a
  // position: the choice falls back to appending rather than to a stale id.
  const insertAfter = existingPoints.some(
    (point) => point.draftId === insertAfterDraftId,
  )
    ? insertAfterDraftId
    : null;

  const apply = useCallback(() => {
    if (!draft) return;
    const imported = itineraryDraftToRoutePoints(draft, selected);
    if (imported.length === 0) {
      setError("还没有可添加的地点：先确认这些条目的位置。");
      return;
    }
    const dates = draft.days.map((day) => day.calendarDate).filter((date): date is string => Boolean(date));
    onApply(imported, insertAfter, {
      title: draft.sourceTitle,
      startedOn: dates[0] ?? null,
      endedOn: dates.at(-1) ?? null,
    });
  }, [draft, insertAfter, onApply, selected]);

  const toggle = useCallback((entryId: string) => {
    manuallyEditing.current.add(entryId);
    setSelected((current) =>
      current.includes(entryId)
        ? current.filter((id) => id !== entryId)
        : [...current, entryId]
    );
  }, []);

  const willAdd = draft
    ? itineraryDraftToRoutePoints(draft, selected).length
    : 0;
  const entries = draft ? itineraryDraftEntries(draft) : [];
  const lookupBusy = reviewing || (lookupProgress !== null
    && !lookupProgress.unavailable
    && lookupProgress.done < lookupProgress.total);
  useEffect(() => {
    const heading = resultHeadingRef.current;
    if (expanded && !sourceOpen && heading?.getClientRects().length) {
      heading.focus({ preventScroll: true });
    }
  }, [draft?.jobKey, expanded, sourceOpen]);
  useEffect(() => {
    onWorkStateChange?.({ busy: reading || lookupBusy, ready: Boolean(draft) && !reading && !lookupBusy });
  }, [draft, lookupBusy, onWorkStateChange, reading]);

  return (
    <details
      className={`journey-itinerary-import-panel${standalone ? " is-standalone" : ""}`}
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <span><IconUpload size={17} stroke={1.35} aria-hidden="true" />导入已有行程</span>
        <small>粘贴链接、截图或文本，批量添加地点</small>
        <IconChevronDown className="journey-itinerary-import-panel__chevron" size={17} stroke={1.35} aria-hidden="true" />
      </summary>

      <div className="journey-itinerary-import">
        {sourceOpen ? (
          <>
        <div className="journey-itinerary-import__modes" role="group" aria-label="导入方式">
          {([["text", "粘贴文本"], ["link", "链接"], ["image", "截图"]] as const)
            .map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                onClick={() => {
                  cancelReading();
                  setMode(value);
                  setCapabilitiesRequested(true);
                }}
              >
                {label}
              </button>
            ))}
        </div>

        {mode === "text" ? (
          <label className="journey-itinerary-import__field">
            <span>把行程粘贴进来</span>
            <textarea
              rows={6}
              value={text}
              onChange={(event) => { cancelReading(); setText(event.target.value); }}
              placeholder={"Day 1 · 2026-03-14 · 成都\n住宿 …\n景点 … → …"}
            />
            <button type="button" onClick={() => void readText()} disabled={reading || !text.trim()}>
              <IconSearch size={16} stroke={1.4} aria-hidden="true" />
              {reading ? "正在读取…" : "自动整理"}
            </button>
          </label>
        ) : null}

        {mode === "link" ? (
          <label className="journey-itinerary-import__field">
            <span>行程分享链接</span>
            <input
              value={link}
              inputMode="url"
              onFocus={() => setCapabilitiesRequested(true)}
              onChange={(event) => { cancelReading(); setLink(event.target.value); }}
              placeholder="https://…"
            />
            <button
              type="button"
              onClick={readLink}
              disabled={reading || !link.trim() || capabilities?.linkFetch.configured === false}
            >
              <IconSearch size={16} stroke={1.4} aria-hidden="true" />
              {reading ? "正在读取…" : "自动整理"}
            </button>
            {capabilities?.linkFetch.configured === false ? (
              <small>这台服务器还没有配置链接读取；可以先用截图或粘贴文本。</small>
            ) : null}
          </label>
        ) : null}

        {mode === "image" ? (
          <div className="journey-itinerary-import__field">
            <label className="journey-itinerary-import__file">
              <span>行程截图（可选多张，长图会自动分段读取）</span>
              <input
                type="file"
                multiple
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => {
                  addImages(event.target.files);
                  event.target.value = "";
                }}
                disabled={reading || capabilities?.recognition.configured === false}
              />
            </label>
            {images.length > 0 ? (
              <ol className="journey-itinerary-import__pages">
                {images.map((image, index) => (
                  <li key={image.id}>
                    <span>第 {index + 1} 张 · {image.file.name}</span>
                    <button
                      type="button"
                      aria-label={`把第 ${index + 1} 张往前移`}
                      onClick={() => moveImage(index, -1)}
                      disabled={reading || index === 0}
                    >
                      <IconArrowUp size={16} stroke={1.4} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      aria-label={`把第 ${index + 1} 张往后移`}
                      onClick={() => moveImage(index, 1)}
                      disabled={reading || index === images.length - 1}
                    >
                      <IconArrowDown size={16} stroke={1.4} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      aria-label={`移除第 ${index + 1} 张`}
                      onClick={() => removeImage(image.id)}
                      disabled={reading}
                    >
                      <IconTrash size={16} stroke={1.4} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ol>
            ) : null}
            <button
              type="button"
              onClick={() => void readImages()}
              disabled={
                reading
                || images.length === 0
                || capabilities?.recognition.configured === false
              }
            >
              <IconSearch size={16} stroke={1.4} aria-hidden="true" />
              {reading ? "正在读取…" : "自动整理"}
            </button>
            {progress ? (
              <small role="status">
                正在读取第 {Math.min(progress.done + 1, progress.total)} / {progress.total} 张；长图会分成几段依次识别。
              </small>
            ) : null}
            {capabilities?.recognition.configured === false ? (
              <small>这台服务器还没有配置识别服务；可以先粘贴文本。</small>
            ) : null}
          </div>
        ) : null}

          </>
        ) : (
          <button
            type="button"
            className="journey-itinerary-import__source-reopen"
            onClick={() => setSourceOpen(true)}
          >
            更换导入来源
          </button>
        )}

        {error ? <p className="journey-itinerary-import__error" role="alert">{error}</p> : null}

        {reading || lookupBusy ? (
          <div className="journey-itinerary-import__busy" role="status">
            <span>{reading ? "正在读取行程…" : reviewing ? "正在整理地点与停留…" : `正在查找地点 ${lookupProgress?.done ?? 0} / ${lookupProgress?.total ?? 0}`}</span>
            <button type="button" onClick={cancelReading}>停止整理</button>
          </div>
        ) : null}

        {draft ? (
          <div className="journey-itinerary-import__review">
            <div className="journey-itinerary-import__result-heading">
              <h3 ref={resultHeadingRef} tabIndex={-1}>{draft.days.length} 天的行程</h3>
              <span>{willAdd} 个地点可加入路线</span>
              {draft.counts.pendingConfirmationCount > 0 ? (
                <em className="journey-itinerary-import__flag">{draft.counts.pendingConfirmationCount} 处待处理</em>
              ) : null}
            </div>
            <details className="journey-itinerary-import__source-notes">
              <summary>原始行程说明</summary>
              <p className="journey-itinerary-import__counts">
                来源标注 {draft.counts.sourceReportedPlaceCount ?? "未标注"} 个地点 · 读到 {draft.counts.recognizedEntryCount} 条内容
              </p>
            {draft.notices.includes("year-unconfirmed") ? (
              <p className="journey-itinerary-import__notice">
                来源没有写明年份；这些地点可以加入路线，日期暂不填写。
              </p>
            ) : null}
            {draft.notices.includes("source-day-count-mismatch") ? (
              <p className="journey-itinerary-import__notice">
                来源标题写的天数与实际列出的日期不一致；这里按列出的日期保留。
              </p>
            ) : null}
            {draft.notices.includes("source-place-count-mismatch") ? (
              <p className="journey-itinerary-import__notice">
                来源标注的地点数与读到的内容条数不同；航段和无场馆活动也保留在下方，便于核对。
              </p>
            ) : null}
            </details>

            <div className="journey-itinerary-import__actions">
              {existingPoints.length > 0 ? (
                <label className="journey-itinerary-import__position">
                  <span>加入路线的位置</span>
                  <select
                    value={insertAfter ?? ""}
                    onChange={(event) => setInsertAfterDraftId(event.target.value || null)}
                  >
                    <option value="">追加到路线末尾</option>
                    {existingPoints.map((point, index) => (
                      <option key={point.draftId} value={point.draftId}>
                        插入到第 {index + 1} 个「{point.label || "未命名地点"}」之后
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <button type="button" onClick={apply} disabled={willAdd === 0 || lookupBusy}>
                <IconPlus size={17} stroke={1.4} aria-hidden="true" />
                添加 {willAdd} 个地点到路线
              </button>
            </div>

            <ol className="journey-itinerary-import__days">
              {draft.days.map((day) => (
                <li key={day.dayNumber}>
                  <details className="journey-itinerary-import__day" open={expandedDays.has(day.dayNumber)}
                    onToggle={(event) => {
                      const open = event.currentTarget.open;
                      setExpandedDays((current) => {
                        if (current.has(day.dayNumber) === open) return current;
                        const next = new Set(current);
                        if (open) next.add(day.dayNumber); else next.delete(day.dayNumber);
                        return next;
                      });
                    }}>
                    <summary>
                      <span><strong>第 {day.dayNumber} 天</strong><small>
                        {day.calendarDate ?? (day.partialDate ? `${day.partialDate}（年份待确认）` : "日期未标注")}
                        {day.regionContext ? ` · ${day.regionContext}` : ""}
                      </small></span>
                      <span>{day.entries.length} 条安排</span>
                      {day.entries.some((entry) => entry.needsConfirmation) ? <em className="journey-itinerary-import__flag">待处理</em> : null}
                      <IconChevronDown size={17} stroke={1.35} aria-hidden="true" />
                    </summary>
                  {day.entries.length === 0 ? (
                    <p className="journey-itinerary-import__empty">这一天来源没有列出安排，原样保留。</p>
                  ) : (
                    <ul>
                      {day.entries.map((entry) => {
                        const organization = itineraryEntryOrganizationTargets(draft, entry.entryId);
                        const previousIndex = organization.previous
                          ? entries.findIndex((candidate) => candidate.entryId === organization.previous?.entryId)
                          : -1;
                        const nextIndex = organization.next
                          ? entries.findIndex((candidate) => candidate.entryId === organization.next?.entryId)
                          : -1;
                        const canOrganize = !isEndpointOnlyLeg(entry)
                          && entry.role !== "activity"
                          && !entry.flags.includes("source-invalid")
                          && !entry.flags.includes("truncated");
                        const isStop = Boolean(entry.isStop);
                        const unresolved = entry.latitude === null
                          && !isEndpointOnlyLeg(entry)
                          && entry.role !== "activity";
                        return (
                          <li key={entry.entryId} className="journey-itinerary-import__entry">
                            <div className="journey-itinerary-import__entry-main">
                              {isEndpointOnlyLeg(entry) || entry.role === "activity" ? (
                                <strong>{entry.name}</strong>
                              ) : (
                                <label className="journey-checkbox">
                                  <input
                                    type="checkbox"
                                    checked={selected.includes(entry.entryId)}
                                    disabled={entry.latitude === null}
                                    onChange={() => toggle(entry.entryId)}
                                  />
                                  <span>{entry.name}</span>
                                </label>
                              )}
                              <small className="journey-itinerary-import__entry-kind">
                                {isEndpointOnlyLeg(entry)
                                  ? "航段"
                                  : entry.role === "activity"
                                    ? "活动信息"
                                    : isStop ? "停靠点" : "途径点"}
                                {entry.regionContext ? " · " + entry.regionContext : ""}
                              </small>
                              {entry.flags.includes("source-invalid") || entry.flags.includes("truncated") || unresolved ? (
                                <em className="journey-itinerary-import__flag">
                                  {entry.flags.includes("source-invalid") ? "来源标记已失效" : entry.flags.includes("truncated") ? "名称不完整" : "位置待确认"}
                                </em>
                              ) : null}
                              {unresolved ? (
                                <button
                                  type="button"
                                  onClick={() => openLocationSearch(entry)}
                                  disabled={locating === entry.entryId}
                                >
                                  <IconMapPin size={15} stroke={1.4} aria-hidden="true" />
                                  查找位置
                                </button>
                              ) : null}
                            </div>

                            <details
                              className="journey-itinerary-import__entry-details"
                              open={candidates?.entryId === entry.entryId ? true : undefined}
                            >
                              <summary>详情与修正</summary>
                              <div className="journey-itinerary-import__entry-details-body">
                                <small>
                                  {ROLE_LABELS[entry.role] ?? entry.role}
                                  {entry.latitude !== null && entry.aliases.length > 0
                                    ? " · " + entry.aliases[entry.aliases.length - 1] : ""}
                                </small>

                                {canOrganize ? (
                                  <div className="journey-itinerary-import__organization">
                                    <span>行程角色</span>
                                    <div role="group" aria-label={entry.name + " 行程角色"}>
                                      <button
                                        type="button"
                                        aria-pressed={isStop}
                                        onClick={() => changeOrganization(entry.entryId, {
                                          isStop: true,
                                          stayAnchorIndex: null,
                                        })}
                                      >
                                        停靠点
                                      </button>
                                      <button
                                        type="button"
                                        aria-pressed={!isStop}
                                        onClick={() => changeOrganization(entry.entryId, { isStop: false })}
                                      >
                                        途径点
                                      </button>
                                    </div>
                                    {!isStop && (organization.previous || organization.next || organization.current) ? (
                                      <>
                                        <span>跟随停靠</span>
                                        <div role="group" aria-label={entry.name + " 停留归属"}>
                                          {organization.previous && previousIndex >= 0 ? (
                                            <button
                                              type="button"
                                              aria-pressed={entry.stayAnchorEntryId === organization.previous.entryId}
                                              onClick={() => changeOrganization(entry.entryId, {
                                                isStop: false,
                                                stayAnchorIndex: previousIndex,
                                              })}
                                            >
                                              上一停靠 · {organization.previous.name}
                                            </button>
                                          ) : null}
                                          {organization.next && nextIndex >= 0 ? (
                                            <button
                                              type="button"
                                              aria-pressed={entry.stayAnchorEntryId === organization.next.entryId}
                                              onClick={() => changeOrganization(entry.entryId, {
                                                isStop: false,
                                                stayAnchorIndex: nextIndex,
                                              })}
                                            >
                                              下一停靠 · {organization.next.name}
                                            </button>
                                          ) : null}
                                          <button
                                            type="button"
                                            aria-pressed={!entry.stayAnchorEntryId}
                                            onClick={() => changeOrganization(entry.entryId, {
                                              isStop: false,
                                              stayAnchorIndex: null,
                                            })}
                                          >
                                            独立
                                          </button>
                                        </div>
                                        {organization.needsCorrection ? (
                                          <small role="status">原停留归属已不再相邻，请重新选择。</small>
                                        ) : null}
                                      </>
                                    ) : null}
                                  </div>
                                ) : null}

                                {canOrganize ? (
                                  <label>
                                    <span>所在区域</span>
                                    <input maxLength={120} value={entry.regionContext ?? ""}
                                      onChange={(event) => changeOrganization(entry.entryId, { regionContext: event.target.value || null })} />
                                  </label>
                                ) : null}

                                {entry.flags.filter((flag) => flag !== "year-unconfirmed" && flag !== "unresolved-position").map((flag) => (
                                  <em key={flag} className="journey-itinerary-import__flag">
                                    {FLAG_LABELS[flag] ?? flag}
                                  </em>
                                ))}

                                {entry.latitude !== null && !isEndpointOnlyLeg(entry) && entry.role !== "activity" ? (
                                  <button type="button" onClick={() => openLocationSearch(entry)}>更换位置</button>
                                ) : null}

                                {candidates?.entryId === entry.entryId ? (
                                  <form className="journey-itinerary-import__search" onSubmit={(event) => {
                                    event.preventDefault();
                                    void locate(entry, manualQuery);
                                  }}>
                                    <label>
                                      <span>搜索地点</span>
                                      <input
                                        maxLength={120}
                                        value={manualQuery}
                                        placeholder="中文或英文名称"
                                        onChange={(event) => setManualQuery(event.target.value)}
                                      />
                                    </label>
                                    <button type="submit" disabled={!manualQuery.trim() || locating === entry.entryId}>
                                      {locating === entry.entryId ? "正在查找…" : "搜索"}
                                    </button>
                                    {candidates.results.length === 0 && locating !== entry.entryId ? (
                                      <small>没有合适结果？可加上所在城市再搜索。</small>
                                    ) : null}
                                    {candidates.results.length > 0 ? (
                                      <ul className="journey-itinerary-import__candidates">
                                        {candidates.results.map((result) => {
                                          const names = itineraryLocationDisplayNames(entry, result);
                                          return (
                                            <li key={result.id}>
                                              <button type="button" onClick={() => confirmPosition(entry.entryId, result)}>
                                                <strong>{names[0]}</strong>
                                                {names.slice(1).map((name) => <small key={name}>{name}</small>)}
                                                <small>{result.context} · {result.countryCode}</small>
                                              </button>
                                            </li>
                                          );
                                        })}
                                      </ul>
                                    ) : null}
                                  </form>
                                ) : null}
                              </div>
                            </details>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  </details>
                </li>
              ))}
            </ol>

          </div>
        ) : null}
      </div>
    </details>
  );
}
