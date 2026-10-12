import { useEffect, useRef, useState } from "react";
import { journeyFilmErrorMessage, type JourneyFilmArtifact, type JourneyFilmExporter, type JourneyFilmProgress } from "./journeyFilmExport";
import type { KeepsakeAspect, KeepsakeDurationPreset } from "./journeyKeepsake";
import { prefersReducedMotion } from "../motion/preferences";
import "./journeyFilmExport.css";

export function JourneyFilmExportDialog({ journeyId, title, exporter, onClose }: {
  journeyId: string; title: string; exporter: JourneyFilmExporter; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const lifetime = useRef<AbortController | null>(null);
  const run = useRef<AbortController | null>(null);
  const downloadUrl = useRef<string | null>(null);
  const [aspect, setAspect] = useState<KeepsakeAspect>("portrait");
  const [presetSeconds, setPreset] = useState<KeepsakeDurationPreset>(30);
  const [includeNotes, setNotes] = useState(false);
  const [includeCover, setCover] = useState(true);
  const [progress, setProgress] = useState<JourneyFilmProgress | null>(null);
  const [artifact, setArtifact] = useState<JourneyFilmArtifact | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    const element = dialog.current;
    element?.showModal();
    return () => {
      controller.abort(); run.current?.abort(); run.current = null;
      if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
      downloadUrl.current = null;
      element?.close();
    };
  }, []);

  function clearArtifact() {
    if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
    downloadUrl.current = null;
    setArtifact(null);
  }
  function cancel() {
    run.current?.abort();
    // Retain the run slot until encoder/decoder teardown settles.
    clearArtifact(); setProgress(null); setMessage("已取消导出。"); setFailed(false);
  }

  async function generate() {
    if (run.current || !lifetime.current || lifetime.current.signal.aborted) return;
    const controller = new AbortController();
    run.current = controller;
    const signal = AbortSignal.any([controller.signal, lifetime.current.signal]);
    setBusy(true); clearArtifact(); setMessage(""); setFailed(false);
    setProgress({ phase: "preparing", completed: 0, total: 1 });
    try {
      const result = await exporter(journeyId, {
        aspect, presetSeconds, includeRoutePointNotes: includeNotes, includeCover,
        reducedMotion: prefersReducedMotion(), signal,
        onProgress: (next) => { if (!signal.aborted && run.current === controller) setProgress(next); },
      });
      if (signal.aborted || run.current !== controller) return;
      setArtifact(result); setProgress(null);
      setMessage(`短片已生成，实际时长 ${Math.ceil(result.durationMs / 1000)} 秒。点击下载保存到设备。`);
    } catch (error) {
      if (signal.aborted || run.current !== controller) return;
      setMessage(journeyFilmErrorMessage(error)); setFailed(true); setProgress(null);
    } finally {
      if (run.current === controller) { run.current = null; setBusy(false); }
    }
  }

  async function download() {
    if (!artifact || run.current || !lifetime.current) return;
    const controller = new AbortController(); run.current = controller;
    const signal = AbortSignal.any([controller.signal, lifetime.current.signal, AbortSignal.timeout(30_000)]);
    setBusy(true); setFailed(false); setProgress({ phase: "validating", completed: 0, total: 1 });
    try {
      await artifact.verify(signal);
      signal.throwIfAborted();
      if (run.current !== controller) return;
      if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
      downloadUrl.current = URL.createObjectURL(artifact.blob);
      const link = document.createElement("a");
      link.href = downloadUrl.current; link.download = artifact.filename;
      document.body.appendChild(link); link.click(); link.remove();
      setMessage("已发起 MP4 下载。");
    } catch (error) {
      if (controller.signal.aborted || lifetime.current.signal.aborted) return;
      clearArtifact(); setMessage(journeyFilmErrorMessage(error)); setFailed(true);
    } finally {
      if (run.current === controller) { run.current = null; setBusy(false); setProgress(null); }
    }
  }
  const progressText = progress?.phase === "rendering" ? `正在生成 ${Math.floor(100 * progress.completed / progress.total)}%`
    : progress?.phase === "validating" ? "正在复核旅程和访问权限…" : "正在读取已授权素材…";
  return <dialog ref={dialog} className="journey-film-export" aria-labelledby="journey-film-export-title"
    data-focus-trap-exempt onCancel={(event) => { event.preventDefault(); event.stopPropagation(); onClose(); }}
    onClick={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}>
    <div className="journey-film-export__body">
      <header><div><p>JOURNEY FILM</p><h2 id="journey-film-export-title">导出旅程短片</h2></div>
        <button type="button" onClick={onClose} aria-label="关闭短片导出">关闭</button></header>
      <p className="journey-film-export__title">{title}</p>
      <p>在此设备生成 1080p、30 FPS 的静音 MP4，不上传成片。包含原片、短视频片段和路线示意，不是道路导航或地球实录。</p>
      <fieldset disabled={busy}>
        <legend>导出设置</legend>
        <div className="journey-film-export__options">
          <label>画面比例<select value={aspect} onChange={(e) => { setAspect(e.target.value as KeepsakeAspect); clearArtifact(); }}>
            <option value="portrait">竖屏 9:16</option><option value="landscape">横屏 16:9</option>
          </select></label>
          <label>目标时长<select value={presetSeconds} onChange={(e) => { setPreset(Number(e.target.value) as KeepsakeDurationPreset); clearArtifact(); }}>
            <option value={15}>15 秒</option><option value={30}>30 秒</option><option value={60}>60 秒</option>
          </select></label>
        </div>
        <label className="journey-film-export__check"><input type="checkbox" checked={includeNotes} onChange={(e) => { setNotes(e.target.checked); clearArtifact(); }} />包含途径点感想字幕</label>
        <label className="journey-film-export__check"><input type="checkbox" checked={includeCover} onChange={(e) => { setCover(e.target.checked); clearArtifact(); }} />使用已生成的艺术封面（没有则使用原图）</label>
      </fieldset>
      <p className="journey-film-export__hint">为保留全部场景和字幕，实际时长可能超过目标，最多两分钟。短视频取开头片段，较短的片段停留在末帧。导出期间请保持页面打开。</p>
      {busy ? <div role="status" aria-live="polite"><p>{progressText}</p>
        {progress?.phase === "rendering" ? <progress aria-label="短片生成进度" max={progress.total} value={progress.completed} /> : null}
      </div> : <p role={failed ? "alert" : "status"} aria-live="polite">{message}</p>}
      <footer>{busy ? <button type="button" onClick={cancel}>取消导出</button>
        : artifact ? <button type="button" onClick={() => void download()}>下载 MP4</button>
          : <button type="button" onClick={() => void generate()}>{failed ? "重新生成" : "生成 MP4"}</button>}</footer>
    </div>
  </dialog>;
}
