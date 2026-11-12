import { JournalPlaceMedia } from "./JournalPlaceMedia";
import { journalMediaGroups, firstJournalPlaceMediaEvents } from "./journalMedia";
import { useState, type ReactNode } from "react";
import type { JournalChapter, JournalStatus } from "./dailyJournal";
import type { Journey } from "./types";
import { JournalChapterReview, hasJournalReadingSuggestion } from "./JournalChapterReview";

const labels: Record<JournalStatus, string> = { actual: "实际发生", planned: "计划", cancelled: "已取消", uncertain: "状态未确认" };
export function journalReadingRows(chapters: JournalChapter[], points: Journey["routePoints"], date = "", status = "", query = "") {
  const search = query.trim().toLocaleLowerCase();
  return chapters.map((chapter, order) => ({ chapter, order }))
    .sort((a, b) => a.chapter.date.localeCompare(b.chapter.date) || a.order - b.order)
    .flatMap(({ chapter }) => chapter.events.map((event, eventIndex) => ({ chapter, event, eventIndex,
      point: event.status === "actual" ? points.find(point => point.id === event.routePointId) : undefined,
      suggestion: chapter.suggestions.find(suggestion => suggestion.eventId === event.id),
    })))
    .filter(({ chapter, event, point }) => (!date || chapter.date === date) && (!status || event.status === status)
      && (!search || [chapter.title, event.text, event.source, event.localDate, event.localTime, event.timeContext, point?.label].join(" ").toLocaleLowerCase().includes(search)));
}

export function visibleJournalChapters(chapters: JournalChapter[], rows: ReturnType<typeof journalReadingRows>, date = "", status = "", query = "") {
  return chapters.map((chapter, order) => ({ chapter, order }))
    .sort((a, b) => a.chapter.date.localeCompare(b.chapter.date) || a.order - b.order)
    .filter(({ chapter }) => (!date || chapter.date === date) && (!(status || query.trim()) || rows.some(row => row.chapter.id === chapter.id)));
}

type Props = { chapters: JournalChapter[]; journey: Journey; renderMedia: (ids: string[]) => ReactNode };
export function JournalReadingView({ chapters, journey, renderMedia }: Props) {
  const [view, setView] = useState<"reading" | "table">("reading");
  const [date, setDate] = useState("");
  const [status, setStatus] = useState("");
  const [query, setQuery] = useState("");
  const allRows = journalReadingRows(chapters, journey.routePoints);
  const rows = journalReadingRows(chapters, journey.routePoints, date, status, query);
  const firstPlaceMedia = firstJournalPlaceMediaEvents(rows.map(row => row.event), journey.media ?? []);
  const dates = [...new Set(chapters.map(chapter => chapter.date))].sort();
  const unconfirmed = allRows.filter(({ event }) => event.status === "uncertain").length;
  const filtered = !!(date || status || query.trim());
  const visibleChapters = visibleJournalChapters(chapters, rows, date, status, query);
  const place = (row: typeof rows[number]) => row.point
    ? <><span>{row.point.label || "未命名路线点"}</span>{row.point.occurredAt ? <small>地点已有时间记录：<time dateTime={row.point.occurredAt}>{row.point.occurredAt}</time>（不替代手记当地时间）</small> : null}</>
    : <span className="daily-journal__muted">未关联地图点</span>;
  const body = ({ event, suggestion }: typeof rows[number]) => {
    const media = journalMediaGroups(event, journey.media ?? []);
    return <>
    <p className="daily-journal__prose">{event.text}</p>
    {media.manual.length ? <div><p>手动关联的照片/视频</p>{renderMedia(media.manual)}</div> : null}
    {media.place.length && event.routePointId ? <JournalPlaceMedia pointId={event.routePointId} first={firstPlaceMedia.get(event.routePointId) === event.id} ids={media.place} renderMedia={renderMedia} /> : null}
    {hasJournalReadingSuggestion(event, suggestion) && suggestion ? <details className="daily-journal__review"><summary tabIndex={0}>AI 阅读建议</summary>
      <p className="daily-journal__prose">{suggestion.text}</p>
      {suggestion.background ? <p>背景补充（未经检索核实，不属于亲历记录）：{suggestion.background}</p> : null}
    </details> : null}
  </>; };
  return <section className="daily-journal__reader" aria-label="手记阅读">
    <div className="daily-journal__reading-controls">
      <div className="daily-journal__view-switch" role="group" aria-label="手记展示方式">
        <button aria-pressed={view === "reading"} onClick={() => setView("reading")}>按日阅读</button>
        <button aria-pressed={view === "table"} onClick={() => setView("table")}>表格浏览</button>
      </div>
      <details className="daily-journal__status-help"><summary tabIndex={0}>地点和照片如何关联？</summary><p>AI 导入时，实际发生的事件会关联到旅程里的同一个已有地点，中英文名称和常用别名都能对应；出发、途经和计划不关联。住宿由酒店查找单独确认，可新建地点。日期明显冲突会提示核实，已有手动选择不会被覆盖；未关联时显示“未关联地图点”。</p></details>
      <p>{dates.length} 天 · {allRows.length} 条记录{unconfirmed ? ` · ${unconfirmed} 条状态未确认` : ""}</p>
      {unconfirmed ? <details className="daily-journal__status-help"><summary tabIndex={0}>“状态未确认”是什么意思？</summary><p>这些记录尚未确定是实际发生、计划还是取消，不代表正文有错。可以先阅读，核实后再到编辑中调整状态；不会自动新增地图点。</p></details> : null}
      <div className="daily-journal__filters">
        <label>归章日期<select aria-label="筛选手记日期" value={date} onChange={e => setDate(e.target.value)}><option value="">全部日期</option>{dates.map(day => <option key={day} value={day}>{day}</option>)}</select></label>
        <label>事件状态<select aria-label="筛选事件状态" value={status} onChange={e => setStatus(e.target.value)}><option value="">全部状态</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="daily-journal__search">查找<input type="search" aria-label="查找手记" placeholder="正文、地点或章节" value={query} onChange={e => setQuery(e.target.value)} /></label>
      </div>
      {filtered ? <p role="status">显示 {rows.length} / {allRows.length} 条记录 <button onClick={() => { setDate(""); setStatus(""); setQuery(""); }}>清除筛选</button></p> : null}
    </div>
    {view === "reading" ? <>
      <nav aria-label="手记日期目录">{visibleChapters.map(({ chapter }) => <a key={chapter.id} href={`#journal-${chapter.id}`}>{chapter.date} {chapter.title}</a>)}</nav>
      {visibleChapters.map(({ chapter }) => <article key={chapter.id} id={`journal-${chapter.id}`}>
        <h2><time dateTime={chapter.date} aria-label={`归章日期 ${chapter.date}`}>{chapter.date}</time>{chapter.title ? <span>{chapter.title}</span> : null}</h2>
        <details><summary tabIndex={0}>原始记录</summary><pre>{chapter.source}</pre></details>
        <JournalChapterReview chapter={chapter} />
        {rows.filter(row => row.chapter.id === chapter.id).map(row => <section key={row.event.id} className="daily-journal__event" aria-label={`记录：${row.event.localTime ?? "未注明钟点"}`}>
          <div className="daily-journal__event-heading"><span>第 {row.eventIndex + 1} 条 · {row.event.localDate && row.event.localDate !== chapter.date ? `${row.event.localDate} · ` : ""}{row.event.localTime ?? "未注明钟点"}{row.event.timeContext ? <small> · {row.event.timeContext}</small> : null}</span><span className="daily-journal__status" data-status={row.event.status}>{labels[row.event.status]}</span></div>
          {body(row)}<div className="daily-journal__place">{place(row)}</div>
        </section>)}
        {!chapter.events.length ? <p>本章没有拆分事件，完整内容保留在原始记录中。</p> : null}
      </article>)}
    </> : <>{visibleChapters.map(({ chapter }) => <JournalChapterReview key={chapter.id} chapter={chapter} />)}<div className="daily-journal__table-scroll" tabIndex={0} role="region" aria-label="手记表格，可横向滚动"><table>
      <caption>按归章日期与原文顺序排列，钟点不改变事件顺序。</caption>
      <thead><tr><th scope="col">归章日期 / 当地钟点</th><th scope="col">地点</th><th scope="col">事件</th><th scope="col">状态</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.event.id}><td><time dateTime={row.chapter.date}>{row.chapter.date}</time>{row.chapter.title ? <small>{row.chapter.title}</small> : null}{row.event.localDate && row.event.localDate !== row.chapter.date ? <small>事件当地日期：{row.event.localDate}</small> : null}<small>{row.event.localTime ?? "未注明钟点"}{row.event.timeContext ? ` · ${row.event.timeContext}` : ""}</small></td><td>{place(row)}</td><td>{body(row)}<details><summary tabIndex={0}>本章原始记录</summary><pre>{row.chapter.source}</pre></details></td><td><span className="daily-journal__status" data-status={row.event.status}>{labels[row.event.status]}</span></td></tr>)}</tbody>
    </table></div></>}
    {filtered && !visibleChapters.length ? <p>没有符合筛选的记录。原文和已有内容没有改变。</p> : null}
  </section>;
}
