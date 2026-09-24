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
} from "./itineraryLocationLookup";
import {
  buildItineraryImportDraft,
  defaultItinerarySelection,
  isEndpointOnlyLeg,
  itineraryDraftEntries,
  itineraryDraftToRoutePoints,
  itineraryImportJobKey,
  resolveItineraryEntryPosition,
  type ItineraryEntryDraft,
  type ItineraryImportDraft,
  type ItineraryRoutePointDraft,
} from "./itineraryImport";
import {
  ItineraryImportError,
  itineraryImportStageMessage,
  readItineraryCapabilities,
  readItineraryFromImage,
  readItineraryFromLink,
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
 * #512: reviewing an imported plan before any of it becomes a Route.
 *
 * Everything the plan listed is visible here at once, grouped by day with the
 * region it was listed under shown beside each entry. No grouping has to be
 * opened to finish an import and nothing is hidden behind a disclosure: the
 * member sees exactly which Route Points are about to be added, and the ones
 * that still need a decision — an entry the source marked invalid, a name it
 * cut off, a position nobody has confirmed — say so where they are rather
 * than being silently dropped or silently included.
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
  const [text, setText] = useState("");
  const [link, setLink] = useState("");
  const [draft, setDraft] = useState<ItineraryImportDraft | null>(null);
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
  const [suggestions, setSuggestions] = useState<Record<string, LocationSearchResult>>({});
  const [manualQuery, setManualQuery] = useState("");
  const lookupGeneration = useRef(0);
  const manualSearchGeneration = useRef(0);
  const manuallyConfirmed = useRef(new Set<string>());
  const manuallyEditing = useRef(new Set<string>());
  const [candidates, setCandidates] = useState<
    { entryId: string; results: LocationSearchResult[] } | null
  >(null);
  useEffect(() => () => {
    lookupGeneration.current += 1;
    manualSearchGeneration.current += 1;
  }, []);
  // The link tab is initially visible, but that is not a request to contact
  // either provider. Check capabilities only after the member uses an import
  // entry point, so simply opening the Composer has no network side effect.
  useEffect(() => {
    if (mode === "text" || !expanded || !capabilitiesRequested) return;
    const controller = new AbortController();
    readItineraryCapabilities(fetch, controller.signal)
      .then(setCapabilities)
      .catch(() => setCapabilities(null));
    return () => controller.abort();
  }, [capabilitiesRequested, expanded, mode]);

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
      setSuggestions(strictSuggestions);
      return;
    }

    setReviewing(true);
    onMessage("地点已查完，正在结合整份行程核对位置；可以先离开，稍后回来查看。");
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
      const decisions = await reviewItineraryLocations(plan);
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
        if (chosen && itineraryLocationSuggestion({
          ...entry,
          aliases: [...entry.aliases, chosen.label, chosen.labelEnglish ?? "", chosen.labelLocal ?? ""],
        }, [chosen])) {
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
          const correction = itineraryCorrectedLocationSuggestion(
            entry, decision.correctedQuery, results,
          );
          if (correction) reviewed.push({ entry, result: correction });
        } catch {
          // A correction without a provider-backed result stays unresolved.
        }
      }
      if (lookupGeneration.current !== generation) return;
      setDraft((current) => current?.jobKey === next.jobKey
        ? reviewed.reduce((draft, { entry, result }) => resolveItineraryEntryPosition(
          draft, entry.entryId, {
            latitude: result.latitude,
            longitude: result.longitude,
            alias: result.labelEnglish ?? result.labelLocal ?? result.label,
          },
        ), current)
        : current);
      setSelected((current) => [...new Set([
        ...current,
        ...reviewed.map(({ entry }) => entry.entryId),
      ])]);
      setSuggestions({});
      onMessage(`整份行程已复核，${reviewed.length} 处位置可直接加入；其余条目仍可按需查找。`);
    } catch {
      if (lookupGeneration.current === generation) {
        setSuggestions(strictSuggestions);
        onMessage("整份位置复核暂时无法完成；已找到的明确位置仍可一次确认。");
      }
    } finally {
      if (lookupGeneration.current === generation) setReviewing(false);
    }
  }, [onMessage]);

  const receive = useCallback((next: ItineraryImportDraft) => {
    const generation = ++lookupGeneration.current;
    manualSearchGeneration.current += 1;
    manuallyConfirmed.current.clear();
    manuallyEditing.current.clear();
    setDraft(next);
    setSelected(defaultItinerarySelection(next));
    setSuggestions({});
    setReviewing(false);
    setCandidates(null);
    setError(null);
    onMessage(
      `已读到 ${next.counts.recognizedEntryCount} 个条目，正在查找地点；匹配完成后可一次确认。`,
    );
    void lookupAll(next, generation);
  }, [lookupAll, onMessage]);

  const fail = useCallback((cause: unknown) => {
    setError(
      cause instanceof ItineraryImportError
        ? itineraryImportStageMessage(cause)
        : "这次没能读取这份行程。",
    );
  }, []);

  const readText = useCallback(() => {
    if (!text.trim()) return;
    // Pasted text is read here, so this entry point needs no provider at all.
    receive(buildItineraryImportDraft(
      readTextItinerary(text),
      itineraryImportJobKey("text", text),
    ));
  }, [receive, text]);

  const readLink = useCallback(async () => {
    if (!link.trim()) return;
    setReading(true);
    setError(null);
    try {
      const recognition = await readItineraryFromLink(link.trim());
      receive(buildItineraryImportDraft(
        recognition,
        itineraryImportJobKey("link", link.trim()),
      ));
    } catch (cause) {
      fail(cause);
    } finally {
      setReading(false);
    }
  }, [fail, link, receive]);

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
    setReading(true);
    setError(null);
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
              await encodeSegment(bitmap, segment),
            );
            readings.push({ segment, recognition });
          }
        } finally {
          bitmap.close();
        }
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
      fail(cause);
    } finally {
      setProgress(null);
      setReading(false);
    }
  }, [fail, images, receive]);

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
    setManualQuery(searchableName(entry) || entry.name.slice(0, 120));
    setSuggestions((current) => {
      const next = { ...current };
      delete next[entry.entryId];
      return next;
    });
    setCandidates({ entryId: entry.entryId, results: [] });
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
    setSuggestions((current) => {
      const next = { ...current };
      delete next[entryId];
      return next;
    });
    setCandidates(null);
  }, [draft]);

  const confirmSuggestions = useCallback(() => {
    if (!draft) return;
    const entries = itineraryDraftEntries(draft);
    const accepted = entries.filter((entry) =>
      entry.latitude === null && suggestions[entry.entryId]
    );
    accepted.forEach((entry) => manuallyConfirmed.current.add(entry.entryId));
    setDraft((current) => {
      if (!current) return current;
      return accepted.reduce((next, entry) => {
        const result = suggestions[entry.entryId];
        return resolveItineraryEntryPosition(next, entry.entryId, {
          latitude: result.latitude,
          longitude: result.longitude,
          alias: result.labelEnglish ?? result.labelLocal ?? result.label,
        });
      }, current);
    });
    setSelected((current) => [
      ...new Set([
        ...current,
        ...accepted.filter((entry) => !entry.flags.includes("source-invalid"))
          .map((entry) => entry.entryId),
      ]),
    ]);
    setSuggestions({});
  }, [draft, suggestions]);

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
    setSelected((current) =>
      current.includes(entryId)
        ? current.filter((id) => id !== entryId)
        : [...current, entryId]
    );
  }, []);

  const willAdd = draft
    ? itineraryDraftToRoutePoints(draft, selected).length
    : 0;
  const suggestionCount = Object.keys(suggestions).length;
  const lookupBusy = reviewing || (lookupProgress !== null
    && !lookupProgress.unavailable
    && lookupProgress.done < lookupProgress.total);
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
        <div className="journey-itinerary-import__modes" role="group" aria-label="导入方式">
          {([["text", "粘贴文本"], ["link", "链接"], ["image", "截图"]] as const)
            .map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                onClick={() => {
                  setMode(value);
                  if (value !== "text") setCapabilitiesRequested(true);
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
              onChange={(event) => setText(event.target.value)}
              placeholder={"Day 1 · 2026-03-14 · 成都\n住宿 …\n景点 … → …"}
            />
            <button type="button" onClick={readText} disabled={!text.trim()}>
              <IconSearch size={16} stroke={1.4} aria-hidden="true" />读取行程
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
              onChange={(event) => setLink(event.target.value)}
              placeholder="https://…"
            />
            <button
              type="button"
              onClick={readLink}
              disabled={reading || !link.trim() || capabilities?.linkFetch.configured === false}
            >
              <IconSearch size={16} stroke={1.4} aria-hidden="true" />
              {reading ? "正在读取…" : "读取链接"}
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
              {reading ? "正在读取…" : `读取 ${images.length || ""} 张截图`}
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

        {error ? <p className="journey-itinerary-import__error" role="alert">{error}</p> : null}

        {draft ? (
          <div className="journey-itinerary-import__review">
            <p className="journey-itinerary-import__counts">
              来源标注 {draft.counts.sourceReportedPlaceCount ?? "未标注"} 个地点 ·
              读到 {draft.counts.recognizedEntryCount} 条内容 ·
              {draft.counts.pendingConfirmationCount} 处位置待处理 ·
              {willAdd} 个地点可加入路线
            </p>
            {lookupProgress && lookupProgress.done < lookupProgress.total ? (
              <p className="journey-itinerary-import__notice" role="status">
                {lookupProgress.unavailable
                  ? "自动查找暂时中断；仍可逐个搜索未匹配地点。"
                  : `正在查找位置 ${lookupProgress.done} / ${lookupProgress.total}；可以继续查看行程。`}
              </p>
            ) : null}
            {reviewing ? (
              <p className="journey-itinerary-import__notice" role="status">
                正在结合整份行程核对搜索结果；可以先离开，稍后回来查看。
              </p>
            ) : null}
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
            {suggestionCount > 0 ? (
              <p className="journey-itinerary-import__notice">
                建议位置会显示城市和国家；核对后可一次确认，错位的地点点「更换」。
              </p>
            ) : null}

            <div className="journey-itinerary-import__actions">
              {suggestionCount > 0 ? (
                <button type="button" onClick={confirmSuggestions} disabled={lookupBusy}>
                  <IconMapPin size={17} stroke={1.4} aria-hidden="true" />
                  {lookupBusy ? "正在汇总匹配位置…" : `确认 ${suggestionCount} 处匹配位置`}
                </button>
              ) : null}
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
                  <h4>
                    第 {day.dayNumber} 天
                    <small>
                      {day.calendarDate ?? (day.partialDate ? `${day.partialDate}（年份待确认）` : "日期未标注")}
                      {day.regionContext ? ` · ${day.regionContext}` : ""}
                    </small>
                  </h4>
                  {day.entries.length === 0 ? (
                    <p className="journey-itinerary-import__empty">这一天来源没有列出安排，原样保留。</p>
                  ) : (
                    <ul>
                      {day.entries.map((entry) => (
                        <li key={entry.entryId}>
                          {isEndpointOnlyLeg(entry)
                            || entry.role === "activity" ? (
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
                          {entry.latitude !== null && entry.aliases.length > 0 ? (
                            <small>地点别名：{entry.aliases[entry.aliases.length - 1]}</small>
                          ) : null}
                          <small>
                            {isEndpointOnlyLeg(entry)
                              ? "航段记录，无需定位"
                              : entry.role === "activity"
                                ? "没有明确场馆，无需定位"
                                : ROLE_LABELS[entry.role] ?? entry.role}
                            {entry.regionContext ? ` · ${entry.regionContext}` : ""}
                          </small>
                          {entry.flags.filter((flag) =>
                            flag !== "year-unconfirmed"
                            && (flag !== "unresolved-position" || !suggestions[entry.entryId])
                          ).map((flag) => (
                            <em key={flag} className="journey-itinerary-import__flag">
                              {FLAG_LABELS[flag] ?? flag}
                            </em>
                          ))}
                          {suggestions[entry.entryId] ? (
                            <div className="journey-itinerary-import__suggestion">
                              <span>建议位置：{itineraryLocationDisplayNames(entry, suggestions[entry.entryId]).join(" / ")}</span>
                              <small>{suggestions[entry.entryId].context} · {suggestions[entry.entryId].countryCode}</small>
                              <button type="button" onClick={() => openLocationSearch(entry)}>更换</button>
                            </div>
                          ) : null}
                          {entry.latitude === null && !isEndpointOnlyLeg(entry)
                            && entry.role !== "activity" && !suggestions[entry.entryId] ? (
                            <button
                              type="button"
                              onClick={() => openLocationSearch(entry)}
                              disabled={locating === entry.entryId}
                            >
                              <IconMapPin size={15} stroke={1.4} aria-hidden="true" />
                              查找位置
                            </button>
                          ) : null}
                          {candidates?.entryId === entry.entryId ? (
                            <form className="journey-itinerary-import__search" onSubmit={(event) => {
                              event.preventDefault();
                              void locate(entry, manualQuery);
                            }}>
                              <label>
                                <span>搜索地点</span>
                                <input maxLength={120} value={manualQuery} placeholder="中文或英文名称" onChange={(event) => setManualQuery(event.target.value)} />
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
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>

          </div>
        ) : null}
      </div>
    </details>
  );
}
