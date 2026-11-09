import { JournalPlaceMedia } from "./JournalPlaceMedia";
import { journalMediaGroups, firstJournalPlaceMediaEvents } from "./journalMedia";
import { useEffect, useRef, useState } from "react";
import { useAtlasView } from "./atlasView";
import { useModalFocus } from "./useModalFocus";
import type { DailyJournal, JournalChapter, JournalEvent, JournalStatus } from "./dailyJournal";
import type { DailyJournalClient } from "./dailyJournalApi";
import type { Journey, JourneyMediaAsset } from "./types";
import { useReaderReads } from "./journeyReaderMedia";
import "../styles/daily-journal.css";

import type { HotelPreview } from "./journalHotels";
import { createJournalRequestSlot } from "./journalRequest";
import { JournalOperationStatus } from "./JournalOperationStatus";
import { JournalImportControl } from "./JournalImportControl";
import type { JournalImportSession } from "./journalImportSession";
import { JournalReadingView } from "./JournalReadingView";
import { JournalChapterReview, hasJournalReadingSuggestion } from "./JournalChapterReview";

const statusLabels: Record<JournalStatus, string> = { actual: "实际", planned: "计划", cancelled: "取消", uncertain: "待确认" };

function JournalMedia({ assets }: { assets: JourneyMediaAsset[] }) {
  const { readMedia } = useAtlasView();
  const { reads, expireRead, clearRetry } = useReaderReads(readMedia, assets);
  return <div className="daily-journal__media">{assets.map((asset) => {
    const read = reads[asset.id];
    if (read?.status !== "ready") return <p key={asset.id}>{read?.status === "error" ? "媒体暂时无法读取" : "正在读取媒体…"}</p>;
    const props = { onError: () => expireRead(asset.id), onLoad: () => clearRetry(asset.id) };
    return asset.mimeType.startsWith("image/") ? <img key={asset.id} src={read.read.url} alt={asset.fileName} loading="lazy" {...props} />
      : asset.mimeType.startsWith("video/") ? <video key={asset.id} src={read.read.url} controls preload="metadata" onError={props.onError} /> : null;
  })}</div>;
}

export function DailyJournalPanel({ journey, client, onClose, onPoint, onJourneyChanged }: {
  journey: Journey; client: DailyJournalClient; onClose: () => void; onPoint: (id: string) => void; onJourneyChanged?: (journey: Journey) => void;
}) {
  const [saved, setSaved] = useState<DailyJournal | null>(null);
  const [draft, setDraft] = useState<DailyJournal | null>(null);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState<string | null>("读取");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [hotels, setHotels] = useState<HotelPreview | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [editing, setEditing] = useState(false);
  const requests = useRef(createJournalRequestSlot());
  const importControl = useRef<JournalImportSession | null>(null);
  const requestClose = () => { if (busy === "保存") return; if (draft || source) setConfirmClose(true); else onClose(); };
  const root = useModalFocus<HTMLDivElement>(requestClose);
  useEffect(() => {
    const slot = requests.current;
    const request = slot.begin()!;
    setSaved(null); setDraft(null); setHotels(null); setSource("");
    setError(""); setNotice(""); setConfirmClose(false); setEditing(false); setBusy("读取");
    client.read(journey.id, request.signal).then((journal) => {
      if (request.current()) setSaved(journal);
    }).catch((e: unknown) => { if (request.current()) setError(e instanceof Error ? e.message : "读取失败"); })
      .finally(() => { if (request.finish()) setBusy(null); });
    return () => slot.cancel();
  }, [client, journey.id, journey.atlasId]);

  async function run(label: string, work: (signal: AbortSignal) => Promise<void>) {
    const request = requests.current.begin();
    if (!request) return;
    setBusy(label); setError(""); setNotice("");
    try { await work(request.signal); }
    catch (e) { if (request.current()) setError(e instanceof Error ? e.message : "操作失败；草稿仍保留。"); }
    finally { if (request.finish()) setBusy(null); }
  }
  async function discardAndClose() {
    if (busy === "保存") return;
    if (importControl.current && !await importControl.current.stop()) return;
    requests.current.cancel(); onClose();
  }
  function stopOperation() {
    requests.current.cancel(); setBusy(null); setError(""); setNotice("已停止，原文和草稿已保留。");
  }
  function cancelDraft() {
    requests.current.cancel(); setBusy(null); setDraft(null); setEditing(false); setSource(""); setError(""); setNotice("已取消，未保存预览。");
  }
  function updateChapter(id: string, transform: (chapter: JournalChapter) => JournalChapter) {
    setDraft((value) => value ? { ...value, chapters: value.chapters.map((c) => c.id === id ? transform(c) : c) } : value);
  }
  function updateEvent(chapterId: string, eventId: string, patch: Partial<JournalEvent>) {
    updateChapter(chapterId, (c) => ({ ...c, events: c.events.map((e) => e.id === eventId ? { ...e, ...patch, edited: e.edited || patch.text !== undefined } : e) }));
  }
  const journal = draft ?? saved;
  const ordered = journal?.chapters.map((c, index) => ({ c, index })).sort((a, b) => a.c.date.localeCompare(b.c.date) || a.index - b.index) ?? [];
  const visual = journey.media.filter((m) => /^(image|video)\//.test(m.mimeType));
  const firstPlaceMedia = firstJournalPlaceMediaEvents(ordered.flatMap(({ c }) => c.events), visual);
  return <div className="daily-journal" role="dialog" aria-modal="true" aria-label="每日手记" ref={root} tabIndex={-1}>
    <header><div><span>私有手记 · 不随分享链接公开</span><h1>{journey.title}</h1></div><button disabled={busy === "保存"} onClick={requestClose}>返回 Stream</button></header>
    {confirmClose ? <div role="alert"><p>当前有未保存内容，离开会丢弃草稿。</p><button onClick={() => setConfirmClose(false)}>继续编辑</button><button disabled={busy === "保存"} onClick={() => { void discardAndClose(); }}>丢弃并返回</button></div> : null}
    {error ? <p role="alert">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}
    {busy && busy !== "导入" ? <JournalOperationStatus label={`正在${busy}…`} onStop={busy === "保存" || busy === "读取" ? undefined : stopOperation} /> : null}
    {saved ? <>
      <section className="daily-journal__import" aria-label="导入手记">
        <label>原始流水账<textarea value={source} maxLength={200000} placeholder="粘贴整份游记，AI 会识别日期、钟点与事件状态。" disabled={!!busy || !!draft} onChange={(e) => setSource(e.target.value)} /></label>
        <JournalImportControl client={client.importJournal}
          input={{ journeyId: journey.id, atlasId: journey.atlasId, source, fallbackDate: journey.startedOn }}
          disabled={!!draft || (!!busy && busy !== "导入")} control={importControl}
          onBusy={value => setBusy(current => value ? "导入" : current === "导入" ? null : current)}
          onPreview={preview => {
            if (preview.revision !== saved.revision) { setError("手记已更新，请保留原文，重新打开后导入。"); return false; }
            setDraft(preview); setEditing(false); setHotels(null); setError(""); setNotice(`识别完成，已填入 ${preview.chapters.length} 章、${preview.chapters.reduce((count, chapter) => count + chapter.events.length, 0)} 条记录的完整预览，尚未保存。缺失或有歧义的内容单独列出，可在编辑中调整。`); return true;
          }} />
      </section>
      {!draft && saved.chapters.length > 0 ? <button disabled={!!busy || !!hotels} onClick={() => { setDraft(structuredClone(saved)); setEditing(true); }}>编辑已有手记</button> : null}
      {!draft && !source && saved.chapters.length > 0 && client.previewHotels && client.applyHotels ? <section aria-label="酒店工具导入">
        <p>AI 向已配置模型发送原文事件，用酒店名称与地区检索地点。先预览再确认；不推测坐标，不改变正文或当地时间。</p>
        <button disabled={!!busy} onClick={() => run("检索酒店", async signal => {
          setHotels(null);
          const preview = await client.previewHotels!(journey.id, signal);
          if (!signal.aborted) setHotels(preview);
        })}>用 AI 查找已入住酒店</button>
        {hotels ? <><ul>{hotels.hotels.map(h => <li key={h.eventId}><strong>{h.label}</strong> · {h.context}<p>原文：{h.evidence}</p><span>{h.existingPointId ? "复用已有地点" : "新增住宿地点"}；确认后记为实际入住</span></li>)}</ul>
          {hotels.questions.map((q, i) => <p key={i}>{q}</p>)}
          {!hotels.hotels.length ? <p>没有可可靠确认的住宿地点；未写入。</p> : null}
          <button disabled={!!busy || !hotels.hotels.length} onClick={() => run("保存", async signal => {
            const result = await client.applyHotels!(journey.id, hotels.token, signal);
            if (!signal.aborted) { setSaved(result.journal); setHotels(null); onJourneyChanged?.(result.journey); setNotice("酒店地点及手记关联已保存。"); }
          })}>确认批量添加及关联</button>
          <button disabled={busy === "保存"} onClick={() => { requests.current.cancel(); setBusy(null); setHotels(null); }}>取消酒店预览</button>
        </> : null}
      </section> : null}
      {draft ? <div className="daily-journal__toolbar">
        <strong>未保存预览</strong>
        <button disabled={!!busy} aria-pressed={editing} onClick={() => setEditing(value => !value)}>{editing ? "返回阅读" : "编辑预览"}</button>
        <button disabled={!!busy} onClick={() => run("保存", async (signal) => {
          const result = await client.save(journey.id, draft, signal);
          if (!signal.aborted) { setSaved(result); setDraft(null); setEditing(false); setSource(""); setNotice("手记已保存。"); }
        })}>确认保存</button>
        <button disabled={busy === "保存"} onClick={cancelDraft}>取消预览</button>
        <p>当前内容尚未保存。选填字段可以留空；不会自动添加地图点。</p>
      </div> : null}
      {!ordered.length ? <p>还没有每日手记。可以先导入文字，无照片和坐标也能保存阅读。</p> : null}
      {draft && editing ? <>
      <nav aria-label="手记日期目录">{ordered.map(({ c }) => <a key={c.id} href={`#journal-${c.id}`}>{c.date} {c.title}</a>)}</nav>
      {ordered.map(({ c }) => <article key={c.id} id={`journal-${c.id}`}>
        <h2>{c.date} {c.title}</h2>
        {draft ? <fieldset disabled={!!busy}><label>章节日期<input type="date" value={c.date} onChange={(e) => updateChapter(c.id, (v) => ({ ...v, date: e.target.value }))} /></label><label>章节标题<input value={c.title} maxLength={200} onChange={(e) => updateChapter(c.id, (v) => ({ ...v, title: e.target.value }))} /></label></fieldset> : null}
        {draft ? <button disabled={!!busy} onClick={() => setDraft((value) => value ? { ...value, chapters: value.chapters.filter((chapter) => chapter.id !== c.id) } : value)}>从预览移除此章</button> : null}
        <details><summary tabIndex={0}>原始记录</summary><pre>{c.source}</pre></details>
        <JournalChapterReview chapter={c} />
        {c.events.map((event, index) => {
          const suggestion = c.suggestions.find((s) => s.eventId === event.id);
          const eventMedia = journalMediaGroups(event, visual);
          const point = event.status === "actual" ? journey.routePoints.find((p) => p.id === event.routePointId) : null;
          return <section key={event.id} className="daily-journal__event" aria-label={`事件 ${index + 1}`}>
            <p className="daily-journal__metadata">{statusLabels[event.status]}{event.localDate ? ` · ${event.localDate}` : ""}{event.localTime ? ` · ${event.localTime} ${event.timeContext}` : ""}</p>
            {draft ? <fieldset disabled={!!busy}>
              <label>阅读正文<textarea aria-label="阅读正文" value={event.text} maxLength={200000} onChange={(e) => updateEvent(c.id, event.id, { text: e.target.value })} /></label>
              <label>事件状态<select aria-label="事件状态" value={event.status} onChange={(e) => updateEvent(c.id, event.id, { status: e.target.value as JournalStatus, routePointId: null })}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <details><summary tabIndex={0}>时间、地图点与照片（选填）</summary>
              <label>事件当地日期（可空，与归章日期分开）<input type="date" value={event.localDate ?? ""} onChange={(e) => updateEvent(c.id, event.id, { localDate: e.target.value || null })} /></label>
              <label>原文明确的当地钟点（可空）<input type="time" value={event.localTime ?? ""} onChange={(e) => updateEvent(c.id, event.id, { localTime: e.target.value || null })} /></label>
              <label>时间背景<input value={event.timeContext} maxLength={200} onChange={(e) => updateEvent(c.id, event.id, { timeContext: e.target.value })} /></label>
              <label>已确认的实际地点<select aria-label="已确认的实际地点" disabled={event.status !== "actual"} value={event.routePointId ?? ""} onChange={(e) => updateEvent(c.id, event.id, { routePointId: e.target.value || null })}><option value="">无 / 待确认</option>{journey.routePoints.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
              {event.mediaIds.length ? <button type="button" onClick={() => updateEvent(c.id, event.id, { mediaIds: [] })}>清除手动照片或视频关联</button> : null}
              {visual.length ? <label>额外关联照片或视频（可多选）<select aria-label="关联照片或视频（可多选）" multiple value={event.mediaIds} onChange={(e) => updateEvent(c.id, event.id, { mediaIds: Array.from(e.target.selectedOptions, (option) => option.value) })}>{visual.map((m) => <option key={m.id} value={m.id}>{m.fileName}</option>)}</select></label> : null}
              {point ? <p>清除手动关联只移除本事件的选择；该地点已有照片/视频仍会在下方单独展示，不代表本次拍摄。</p> : null}
              </details>
            </fieldset> : <p className="daily-journal__prose">{event.text}</p>}
            {point && !draft ? <button disabled={!!busy} onClick={() => onPoint(point.id)}>在 Stream 中查看地点：{point.label}</button> : null}
            {eventMedia.manual.length ? <div><p>手动关联的照片/视频</p><JournalMedia assets={visual.filter(m => eventMedia.manual.includes(m.id))} /></div> : null}
            {eventMedia.place.length && event.routePointId ? <JournalPlaceMedia pointId={event.routePointId} first={firstPlaceMedia.get(event.routePointId) === event.id} ids={eventMedia.place} renderMedia={ids => <JournalMedia assets={visual.filter(m => ids.includes(m.id))} />} /> : null}
            {hasJournalReadingSuggestion(event, suggestion) && suggestion ? <details><summary tabIndex={0}>AI 阅读建议</summary><p className="daily-journal__prose">{suggestion.text}</p>{suggestion.background ? <p>背景补充（未经检索核实，不属于亲历记录）：{suggestion.background}</p> : null}
              {draft && suggestion.text.trim() && suggestion.text.trim() !== event.text.trim() ? <button disabled={!!busy || event.edited} onClick={() => updateEvent(c.id, event.id, { text: suggestion.text })}>{event.edited ? "正文已编辑，请手动合并建议" : "核对后采用这条正文"}</button> : null}
            </details> : null}
          </section>;
        })}
      </article>)}
      </> : ordered.length ? <JournalReadingView chapters={journal?.chapters ?? []} journey={journey} busy={!!busy || !!draft || !!source} onPoint={onPoint} renderMedia={ids => <JournalMedia assets={visual.filter(media => ids.includes(media.id))} />} /> : null}
    </> : null}
  </div>;
}
