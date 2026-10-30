import { useEffect, useRef, useState } from "react";
import { useAtlasView } from "./atlasView";
import { useModalFocus } from "./useModalFocus";
import { adoptJournalSuggestions, mergeJournalSuggestions, previewJournalImport, type DailyJournal, type JournalChapter, type JournalEvent, type JournalStatus } from "./dailyJournal";
import type { DailyJournalClient } from "./dailyJournalApi";
import type { Journey, JourneyMediaAsset } from "./types";
import { useReaderReads } from "./journeyReaderMedia";
import "../styles/daily-journal.css";

import type { HotelPreview } from "./journalHotels";
import { createJournalRequestSlot } from "./journalRequest";
import { JournalOperationStatus } from "./JournalOperationStatus";

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
  const [date, setDate] = useState(journey.startedOn);
  const [busy, setBusy] = useState<string | null>("读取");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [hotels, setHotels] = useState<HotelPreview | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const requests = useRef(createJournalRequestSlot());
  const requestClose = () => { if (busy === "保存") return; if (draft || source) setConfirmClose(true); else onClose(); };
  const root = useModalFocus<HTMLDivElement>(requestClose);
  useEffect(() => {
    const slot = requests.current;
    const request = slot.begin()!;
    setSaved(null); setDraft(null); setHotels(null); setSource(""); setDate(journey.startedOn);
    setError(""); setNotice(""); setConfirmClose(false); setBusy("读取");
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
  function stopOperation() {
    requests.current.cancel(); setBusy(null); setError(""); setNotice("已停止，原文和草稿已保留。");
  }
  function cancelDraft() {
    requests.current.cancel(); setBusy(null); setDraft(null); setSource(""); setError(""); setNotice("已取消，未保存预览。");
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
  return <div className="daily-journal" role="dialog" aria-modal="true" aria-label="每日手记" ref={root} tabIndex={-1}>
    <header><div><span>私有手记 · 不随分享链接公开</span><h1>{journey.title}</h1></div><button disabled={busy === "保存"} onClick={requestClose}>返回 Stream</button></header>
    {confirmClose ? <div role="alert"><p>当前有未保存内容，离开会丢弃草稿。</p><button onClick={() => setConfirmClose(false)}>继续编辑</button><button disabled={busy === "保存"} onClick={() => { requests.current.cancel(); onClose(); }}>丢弃并返回</button></div> : null}
    {error ? <p role="alert">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}
    {busy ? <JournalOperationStatus label={`正在${busy}…`} onStop={busy === "保存" || busy === "读取" ? undefined : stopOperation} /> : null}
    {saved ? <>
      <section className="daily-journal__import" aria-label="导入手记">
        <label>原始流水账<textarea value={source} maxLength={200000} placeholder="粘贴整份记录，以 2027-04-03 或 4月3日 开头分日。" disabled={!!busy} onChange={(e) => setSource(e.target.value)} /></label>
        <label>无完整日期时的归章日期<input type="date" value={date} disabled={!!busy} onChange={(e) => setDate(e.target.value)} /></label>
        <p>日期与钟点按旅行当地记录保留；未注明时区不会换算。事件保持原文顺序。明确的实际/计划/取消标记会保留，其余待确认；不自动创建地图点。</p>
        <button disabled={!!busy || !source.trim()} onClick={() => {
          try {
            const base = draft ?? saved; const chapters = previewJournalImport(source, date, base.chapters);
            setDraft({ ...base, chapters }); setError(""); setNotice(`新增 ${chapters.length - base.chapters.length} 个章节；请检查日期、正文和事件状态后确认保存。`);
          } catch (e) { setError(e instanceof Error ? e.message : "无法生成预览"); }
        }}>生成导入预览</button>
        {!draft ? <button disabled={!!busy || !!hotels} onClick={() => setDraft(structuredClone(saved))}>编辑已有手记</button> : null}
      </section>
      {!draft && !source && client.previewHotels && client.applyHotels ? <section aria-label="酒店工具导入">
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
        <button disabled={!!busy || !draft.chapters.length} onClick={() => run("整理建议", async (signal) => {
          const suggestions = await client.suggest(journey.id, draft.chapters, signal);
          if (!signal.aborted) setDraft((current) => current ? { ...current, chapters: mergeJournalSuggestions(current.chapters, suggestions) } : current);
        })}>用 AI 整理原文</button>
        <button disabled={!!busy || !draft.chapters.some((c) => c.suggestions.length)} onClick={() => setDraft((value) => value ? { ...value, chapters: adoptJournalSuggestions(value.chapters) } : value)}>将建议应用到未手改正文</button>
        <button disabled={!!busy} onClick={() => run("保存", async (signal) => {
          const result = await client.save(journey.id, draft, signal);
          if (!signal.aborted) { setSaved(result); setDraft(null); setSource(""); setNotice("手记已保存。"); }
        })}>确认保存</button>
        <button disabled={busy === "保存"} onClick={cancelDraft}>取消预览</button>
        <p>AI 建议需要逐条核对。手改正文不会被重新整理覆盖。</p>
      </div> : null}
      <nav aria-label="手记日期目录">{ordered.map(({ c }) => <a key={c.id} href={`#journal-${c.id}`}>{c.date} {c.title}</a>)}</nav>
      {!ordered.length ? <p>还没有每日手记。可以先导入文字，无照片和坐标也能保存阅读。</p> : null}
      {ordered.map(({ c }) => <article key={c.id} id={`journal-${c.id}`}>
        <h2>{c.date} {c.title}</h2>
        {draft ? <fieldset disabled={!!busy}><label>章节日期<input type="date" value={c.date} onChange={(e) => updateChapter(c.id, (v) => ({ ...v, date: e.target.value }))} /></label><label>章节标题<input value={c.title} maxLength={200} onChange={(e) => updateChapter(c.id, (v) => ({ ...v, title: e.target.value }))} /></label></fieldset> : null}
        {draft ? <button disabled={!!busy} onClick={() => setDraft((value) => value ? { ...value, chapters: value.chapters.filter((chapter) => chapter.id !== c.id) } : value)}>从预览移除此章</button> : null}
        <details><summary>原始记录</summary><pre>{c.source}</pre></details>
        {c.events.map((event, index) => {
          const suggestion = c.suggestions.find((s) => s.eventId === event.id);
          const point = event.status === "actual" ? journey.routePoints.find((p) => p.id === event.routePointId) : null;
          return <section key={event.id} className="daily-journal__event" aria-label={`事件 ${index + 1}`}>
            <p className="daily-journal__metadata">{statusLabels[event.status]}{event.localDate ? ` · ${event.localDate}` : ""}{event.localTime ? ` · ${event.localTime} ${event.timeContext}` : ""}</p>
            {draft ? <fieldset disabled={!!busy}>
              <label>阅读正文<textarea aria-label="阅读正文" value={event.text} maxLength={200000} onChange={(e) => updateEvent(c.id, event.id, { text: e.target.value })} /></label>
              <label>事件状态<select aria-label="事件状态" value={event.status} onChange={(e) => updateEvent(c.id, event.id, { status: e.target.value as JournalStatus, routePointId: null })}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label>事件当地日期（可空，与归章日期分开）<input type="date" value={event.localDate ?? ""} onChange={(e) => updateEvent(c.id, event.id, { localDate: e.target.value || null })} /></label>
              <label>原文明确的当地钟点（可空）<input type="time" value={event.localTime ?? ""} onChange={(e) => updateEvent(c.id, event.id, { localTime: e.target.value || null })} /></label>
              <label>时间背景<input value={event.timeContext} maxLength={200} onChange={(e) => updateEvent(c.id, event.id, { timeContext: e.target.value })} /></label>
              <label>已确认的实际地点<select aria-label="已确认的实际地点" disabled={event.status !== "actual"} value={event.routePointId ?? ""} onChange={(e) => updateEvent(c.id, event.id, { routePointId: e.target.value || null })}><option value="">无 / 待确认</option>{journey.routePoints.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
              {event.mediaIds.length ? <button type="button" onClick={() => updateEvent(c.id, event.id, { mediaIds: [] })}>清除照片或视频关联</button> : null}
              {visual.length ? <label>关联照片或视频（可多选）<select aria-label="关联照片或视频（可多选）" multiple value={event.mediaIds} onChange={(e) => updateEvent(c.id, event.id, { mediaIds: Array.from(e.target.selectedOptions, (option) => option.value) })}>{visual.map((m) => <option key={m.id} value={m.id}>{m.fileName}</option>)}</select></label> : null}
            </fieldset> : <p className="daily-journal__prose">{event.text}</p>}
            {point && !draft ? <button onClick={() => onPoint(point.id)}>在 Stream 中查看地点：{point.label}</button> : null}
            <JournalMedia assets={visual.filter((m) => event.mediaIds.includes(m.id))} />
            {suggestion ? <details><summary>AI 建议与待确认问题</summary><p className="daily-journal__prose">{suggestion.text}</p>{suggestion.questions.map((q, i) => <p key={i}>待确认：{q}</p>)}{suggestion.background ? <p>背景补充（未经检索核实，不属于亲历记录）：{suggestion.background}</p> : null}
              {draft ? <button disabled={!!busy || event.edited} onClick={() => updateEvent(c.id, event.id, { text: suggestion.text })}>{event.edited ? "正文已编辑，请手动合并建议" : "核对后采用这条正文"}</button> : null}
            </details> : null}
          </section>;
        })}
      </article>)}
    </> : null}
  </div>;
}
