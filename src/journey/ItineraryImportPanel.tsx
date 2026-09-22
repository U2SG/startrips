import { useCallback, useEffect, useState } from "react";
import {
  IconChevronDown,
  IconMapPin,
  IconPlus,
  IconSearch,
  IconUpload,
} from "@tabler/icons-react";
import { searchLocations } from "./journeyApi";
import {
  buildItineraryImportDraft,
  defaultItinerarySelection,
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
  type ItineraryImportCapabilities,
} from "./itineraryImportApi";
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
};

const FLAG_LABELS: Record<string, string> = {
  "source-invalid": "来源标记已失效",
  truncated: "名称被截断",
  "year-unconfirmed": "年份待确认",
  "unresolved-position": "位置待确认",
  "possible-repeat-visit": "可能是同一处的再次到访",
};

type Props = {
  onApply: (imported: readonly ItineraryRoutePointDraft[]) => void;
  onMessage: (message: string) => void;
  mobileLayout?: boolean;
};

export function ItineraryImportPanel({ onApply, onMessage, mobileLayout }: Props) {
  const [mode, setMode] = useState<"text" | "link" | "image">("text");
  const [text, setText] = useState("");
  const [link, setLink] = useState("");
  const [draft, setDraft] = useState<ItineraryImportDraft | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<ItineraryImportCapabilities | null>(null);
  const [locating, setLocating] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<
    { entryId: string; results: LocationSearchResult[] } | null
  >(null);
  // What this deployment supports is asked for when the member chooses an
  // entry point that needs a provider, not when the Composer mounts. Pasting
  // text needs neither adapter, so building a Journey by hand never waits on,
  // or fails because of, a capability nobody asked about.
  useEffect(() => {
    if (mode === "text") return;
    const controller = new AbortController();
    readItineraryCapabilities(fetch, controller.signal)
      .then(setCapabilities)
      .catch(() => setCapabilities(null));
    return () => controller.abort();
  }, [mode]);

  const receive = useCallback((next: ItineraryImportDraft) => {
    setDraft(next);
    setSelected(defaultItinerarySelection(next));
    setError(null);
    onMessage(
      `已读到 ${next.counts.recognizedEntryCount} 个条目，其中 ${next.counts.pendingConfirmationCount} 个待确认；确认后再添加到路线。`,
    );
  }, [onMessage]);

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

  const readImage = useCallback(async (file: File) => {
    setReading(true);
    setError(null);
    try {
      const buffer = await file.arrayBuffer();
      let binary = "";
      const bytes = new Uint8Array(buffer);
      for (let index = 0; index < bytes.length; index += 1) {
        binary += String.fromCharCode(bytes[index]);
      }
      const recognition = await readItineraryFromImage({
        mimeType: file.type,
        base64: btoa(binary),
      });
      receive(buildItineraryImportDraft(
        recognition,
        itineraryImportJobKey("image", `${file.name}:${file.size}`),
      ));
    } catch (cause) {
      fail(cause);
    } finally {
      setReading(false);
    }
  }, [fail, receive]);

  const locate = useCallback(async (entry: ItineraryEntryDraft) => {
    setLocating(entry.entryId);
    setCandidates(null);
    try {
      // The plan's own region narrows the search; the member still chooses.
      const query = [entry.name, entry.regionContext].filter(Boolean).join(" ");
      const { results } = await searchLocations(query);
      setCandidates({ entryId: entry.entryId, results });
      if (results.length === 0) onMessage("没有找到匹配的位置；可以手动补充坐标。");
    } catch {
      onMessage("位置搜索暂时不可用；可以手动补充坐标。");
    } finally {
      setLocating(null);
    }
  }, [onMessage]);

  const confirmPosition = useCallback((
    entryId: string,
    result: LocationSearchResult,
  ) => {
    setDraft((current) => {
      if (!current) return current;
      const next = resolveItineraryEntryPosition(current, entryId, {
        latitude: result.latitude,
        longitude: result.longitude,
        alias: result.labelEnglish ?? result.labelLocal ?? result.label,
      });
      return next;
    });
    setSelected((current) =>
      current.includes(entryId) ? current : [...current, entryId]
    );
    setCandidates(null);
  }, []);

  const apply = useCallback(() => {
    if (!draft) return;
    const imported = itineraryDraftToRoutePoints(draft, selected);
    if (imported.length === 0) {
      setError("还没有可添加的地点：先确认这些条目的位置。");
      return;
    }
    onApply(imported);
  }, [draft, onApply, selected]);

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

  return (
    <details
      className="journey-itinerary-import-panel"
      open={mobileLayout || undefined}
    >
      <summary>
        <span><IconUpload size={17} stroke={1.35} aria-hidden="true" />导入已有行程</span>
        <small>链接、截图或粘贴文本</small>
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
                onClick={() => setMode(value)}
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
          <label className="journey-itinerary-import__field">
            <span>行程截图</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void readImage(file);
              }}
              disabled={reading || capabilities?.recognition.configured === false}
            />
            {capabilities?.recognition.configured === false ? (
              <small>这台服务器还没有配置识别服务；可以先粘贴文本。</small>
            ) : null}
          </label>
        ) : null}

        {error ? <p className="journey-itinerary-import__error" role="alert">{error}</p> : null}

        {draft ? (
          <div className="journey-itinerary-import__review">
            <p className="journey-itinerary-import__counts">
              来源声称 {draft.counts.sourceReportedPlaceCount ?? "未标注"} 个地点 ·
              读到 {draft.counts.recognizedEntryCount} 个 ·
              待确认 {draft.counts.pendingConfirmationCount} 个 ·
              将新增 {willAdd} 个 Route Point
            </p>
            {draft.notices.includes("source-day-count-mismatch") ? (
              <p className="journey-itinerary-import__notice">
                来源标题写的天数与实际列出的日期不一致；这里按列出的日期保留。
              </p>
            ) : null}

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
                          <label className="journey-checkbox">
                            <input
                              type="checkbox"
                              checked={selected.includes(entry.entryId)}
                              disabled={entry.latitude === null}
                              onChange={() => toggle(entry.entryId)}
                            />
                            <span>{entry.name}</span>
                          </label>
                          <small>
                            {ROLE_LABELS[entry.role] ?? entry.role}
                            {entry.regionContext ? ` · ${entry.regionContext}` : ""}
                          </small>
                          {entry.flags.map((flag) => (
                            <em key={flag} className="journey-itinerary-import__flag">
                              {FLAG_LABELS[flag] ?? flag}
                            </em>
                          ))}
                          {entry.latitude === null ? (
                            <button
                              type="button"
                              onClick={() => void locate(entry)}
                              disabled={locating === entry.entryId}
                            >
                              <IconMapPin size={15} stroke={1.4} aria-hidden="true" />
                              {locating === entry.entryId ? "正在查找…" : "确认位置"}
                            </button>
                          ) : null}
                          {candidates?.entryId === entry.entryId ? (
                            <ul className="journey-itinerary-import__candidates">
                              {candidates.results.map((result) => (
                                <li key={result.id}>
                                  <button
                                    type="button"
                                    onClick={() => confirmPosition(entry.entryId, result)}
                                  >
                                    {result.label}
                                    <small>{result.context}</small>
                                  </button>
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>

            <button type="button" onClick={apply} disabled={willAdd === 0}>
              <IconPlus size={16} stroke={1.4} aria-hidden="true" />
              添加 {willAdd} 个地点到路线
            </button>
          </div>
        ) : null}
      </div>
    </details>
  );
}
