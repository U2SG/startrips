import { useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import { JournalOperationStatus } from "./JournalOperationStatus";
import { createJournalImportSession, type JournalImportSession, type JournalImportState } from "./journalImportSession";
import { type JournalImportClient, type JournalImportInput } from "./journalImportApi";
import type { DailyJournal } from "./dailyJournal";

export function journalImportStatusLabel(state: JournalImportState) {
  if (state.status === "completed") return "识别完成，已填入预览，尚未保存。";
  if (state.status === "submitting") return "正在开始导入…";
  if (state.status === "stopping") return "正在停止…";
  const progress = state.progress;
  if (!progress || progress.phase === "queued") return "正在等待处理…";
  if (progress.phase === "connecting") return "正在连接模型…";
  if (progress.phase === "validating") return "正在核对完整记录…";
  return `正在接收 · ${progress.characters.toLocaleString("zh-CN")} 字`;
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
    {state?.status === "completed" && disabled && input.source === submittedSource.current ? <p role="status">{journalImportStatusLabel(state)}</p> : null}
    {active && state.status !== "paused" ? <JournalOperationStatus label={journalImportStatusLabel(state)} onStop={state.status === "stopping" ? undefined : () => { void control.current?.stop(); }} /> : null}
    {state?.status === "paused" ? <div className="daily-journal__progress">
      <span role="alert">{state.message}</span>
      <button type="button" onClick={() => { void control.current?.resume(); }}>{state.stopping ? "重试停止" : "继续接收"}</button>
      {!state.stopping ? <button type="button" onClick={() => { void control.current?.stop(); }}>停止</button> : null}
    </div> : null}
    {state?.status === "failed" ? <p role="alert">{state.message}</p> : null}
    {state?.status === "cancelled" ? <p role="status">已停止，原文已保留。</p> : null}
  </div>;
}
