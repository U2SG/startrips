import { useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import { JournalOperationStatus } from "./JournalOperationStatus";
import { createJournalImportSession, type JournalImportSession, type JournalImportState } from "./journalImportSession";
import { type JournalImportClient, type JournalImportInput } from "./journalImportApi";
import type { DailyJournal } from "./dailyJournal";

export function journalImportStatusLabel(state: JournalImportState) {
  if (state.status === "submitting") return "正在开始导入…";
  if (state.status === "stopping") return "正在停止…";
  const progress = state.progress;
  if (!progress || progress.phase === "queued") return "正在等待处理…";
  if (progress.phase === "connecting") return "正在连接模型…";
  if (progress.phase === "validating") return "正在核对完整记录…";
  return `正在接收 · ${progress.characters.toLocaleString("zh-CN")} 字`;
}

export function JournalImportControl({ client, input, disabled, control, onBusy, onPreview }: {
  client: JournalImportClient; input: Omit<JournalImportInput, "sentence">; disabled: boolean;
  control: MutableRefObject<JournalImportSession | null>;
  onBusy: (busy: boolean) => void; onPreview: (draft: DailyJournal) => void;
}) {
  const [sentence, setSentence] = useState("导入这份流水账并关联酒店");
  const inFlight = useRef(false);
  const [state, setState] = useState<JournalImportState | null>(null);
  const callbacks = useRef({ onBusy, onPreview }); callbacks.current = { onBusy, onPreview };
  useLayoutEffect(() => () => { control.current?.dispose(); control.current = null; }, [client, input.journeyId, input.atlasId, control]);
  const active = !!state && ["submitting", "observing", "stopping", "paused"].includes(state.status);
  function start() {
    if (inFlight.current || disabled) return;
    inFlight.current = true;
    control.current?.dispose();
    const session = createJournalImportSession(client, { ...input, sentence }, {
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
    <label>操作<input aria-label="一句话导入要求" value={sentence} maxLength={500} disabled={disabled || active} onChange={e => setSentence(e.target.value)} /></label>
    <button type="button" disabled={disabled || active || !input.source.trim() || !sentence.trim()} onClick={start}>用 AI 导入</button>
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
