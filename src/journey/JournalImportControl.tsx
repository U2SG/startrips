import { useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import { createJournalImportSession, type JournalImportSession, type JournalImportState } from "./journalImportSession";
import { type JournalImportClient, type JournalImportInput } from "./journalImportApi";
import type { DailyJournal } from "./dailyJournal";

export function journalImportStatusLabel(state: JournalImportState) {
  if (state.status === "completed") return "识别完成，已填入预览，尚未保存。";
  if (state.status === "paused") return state.stopping ? "停止尚未确认" : "接收已暂停";
  if (state.status === "failed") return "导入未完成";
  if (state.status === "cancelled") return "已停止，原文已保留。";
  if (state.status === "submitting") return "正在开始导入…";
  if (state.status === "stopping") return "正在停止…";
  const progress = state.progress;
  if (!progress || progress.phase === "queued") return "正在等待处理…";
  if (progress.phase === "connecting") return "正在连接模型…";
  if (progress.phase === "validating") return "正在处理 · 核对完整记录…";
  return "正在接收识别结果…";
}

const sourceSegmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });

/** Count visible source characters, not UTF-16 units or generated JSON. */
export function countJournalSourceCharacters(source: string) {
  let count = 0;
  for (const { segment } of sourceSegmenter.segment(source)) if (segment.trim()) count++;
  return count;
}

export function JournalImportProgress({ state, onStop, onResume }: {
  state: JournalImportState; onStop: () => void; onResume: () => void;
}) {
  const running = ["submitting", "observing", "stopping"].includes(state.status);
  const paused = state.status === "paused";
  const label = journalImportStatusLabel(state);
  const detail = state.message || (state.status === "stopping" ? "正在确认任务停止，请稍候。"
    : state.status === "observing" && state.progress?.phase === "validating" ? "完整性检查通过后，将填入预览供你确认。"
    : running ? "大段原文可能需要较长时间，完成后会自动填入预览。" : "");
  return <div className="daily-journal__import-status" data-state={state.status}>
    <div className="daily-journal__import-status-heading">
      <div role={paused || state.status === "failed" ? "alert" : "status"} aria-atomic="true">
        <strong>{label}</strong>
        {detail ? <p>{detail}</p> : null}
        {paused && !state.stopping ? <p>后台任务可能仍在处理。继续接收会连接同一个任务，不会重新生成。</p> : null}
      </div>
      <div className="daily-journal__import-actions">
        {paused ? <button type="button" onClick={onResume}>{state.stopping ? "重试停止" : "继续接收"}</button> : null}
        {(running && state.status !== "stopping") || (paused && !state.stopping) ? <button type="button" onClick={onStop}>停止</button> : null}
      </div>
    </div>
    {running ? <div className="daily-journal__import-activity" role="progressbar" aria-label={label}><span /></div> : null}
  </div>;
}

export function JournalImportControl({ client, input, disabled, control, onBusy, onPreview }: {
  client?: JournalImportClient; input: Omit<JournalImportInput, "sentence">; disabled: boolean;
  control: MutableRefObject<JournalImportSession | null>;
  onBusy: (busy: boolean) => void; onPreview: (draft: DailyJournal) => boolean | void;
}) {
  const submittedSource = useRef("");
  const inFlight = useRef(false);
  const [state, setState] = useState<JournalImportState | null>(null);
  const callbacks = useRef({ onBusy, onPreview }); callbacks.current = { onBusy, onPreview };
  useLayoutEffect(() => {
    setState(null);
    inFlight.current = false;
    return () => {
      control.current?.dispose();
      control.current = null;
      const wasBusy = inFlight.current;
      inFlight.current = false;
      if (wasBusy) callbacks.current.onBusy(false);
    };
  }, [client, input.journeyId, input.atlasId, control]);
  const active = !!state && ["submitting", "observing", "stopping", "paused"].includes(state.status);
  function start() {
    if (inFlight.current || disabled || !client) return;
    submittedSource.current = input.source;
    inFlight.current = true;
    control.current?.dispose();
    const session = createJournalImportSession(client, { ...input, sentence: "按日期整理这份流水账，保留原文和事件顺序，不新增地图点。" }, {
      onState: next => {
        inFlight.current = ["submitting", "observing", "stopping", "paused"].includes(next.status);
        setState(next);
        callbacks.current.onBusy(["submitting", "observing", "stopping", "paused"].includes(next.status));
      },
      onPreview: draft => callbacks.current.onPreview(draft),
    });
    control.current = session;
    void session.start();
  }
  return <div className="daily-journal__ai-import">
    <button type="button" disabled={disabled || active || !client || !input.source.trim()} onClick={start}>用 AI 导入</button>
    {!client ? <p role="status">AI 导入暂不可用，原文仍保留；请稍后重试。</p> : null}
    <p className="daily-journal__muted">识别完成后自动填入预览。没有明确日期的章节暂归到 {input.fallbackDate}（旅程起始日，不代表事件发生日期），可在编辑中调整；缺失的钟点和地图点不会猜填。</p>
    {state && (state.status !== "completed" || (disabled && input.source === submittedSource.current)) ? <JournalImportProgress
      state={state} onStop={() => { void control.current?.stop(); }} onResume={() => { void control.current?.resume(); }} /> : null}
  </div>;
}
