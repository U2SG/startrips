import { useEffect, useRef, useState } from "react";
import { journeyFilmErrorMessage, type JourneyFilmArtifact, type JourneyFilmExporter, type JourneyFilmProgress, type JourneyFilmPlanSummary } from "./journeyFilmExport";
import { downloadJourneyFilm, releaseJourneyFilmDownloadUrls } from "./journeyFilmDownload";
import { clearRetainedJourneyFilmDownloads, listRetainedJourneyFilmDownloads } from "./journeyFilmStorage";
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
  const artifactRef = useRef<JourneyFilmArtifact | null>(null);
  const [aspect, setAspect] = useState<KeepsakeAspect>("portrait");
  const [presetSeconds, setPreset] = useState<KeepsakeDurationPreset>(30);
  const [includeNotes, setNotes] = useState(false);
  const [includeCover, setCover] = useState(true);
  const [includeSoundtrack, setSoundtrack] = useState(true);
  const [progress, setProgress] = useState<JourneyFilmProgress | null>(null);
  const [artifact, setArtifact] = useState<JourneyFilmArtifact | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [plan, setPlan] = useState<JourneyFilmPlanSummary | null>(null);
  const [retained, setRetained] = useState({ count: 0, bytes: 0 });

  async function refreshRetained() {
    const summary = await listRetainedJourneyFilmDownloads();
    if (!lifetime.current?.signal.aborted) setRetained(summary);
  }

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    const element = dialog.current;
    element?.showModal();
    void refreshRetained().catch(() => {});
    return () => {
      // Drop only this view's handle. exportPrivateJourneyFilm retains the
      // page-wide encoder slot until abort teardown has actually settled.
      controller.abort(); run.current?.abort(); run.current = null;
      if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
      downloadUrl.current = null;
      const held = artifactRef.current; artifactRef.current = null;
      void held?.dispose?.().catch(() => {});
      element?.close();
    };
  }, []);

  function clearArtifact() {
    if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
    downloadUrl.current = null;
    const held = artifactRef.current; artifactRef.current = null;
    void held?.dispose?.().catch(() => {});
    setArtifact(null);
    setPlan(null);
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
        aspect, presetSeconds, includeRoutePointNotes: includeNotes, includeCover, includeSoundtrack,
        reducedMotion: prefersReducedMotion(), signal,
        onProgress: (next) => { if (!signal.aborted && run.current === controller) setProgress(next); },
        onPlan: (next) => { if (!signal.aborted && run.current === controller) setPlan(next); },
      });
      if (signal.aborted || run.current !== controller) { await result.dispose?.(); return; }
      artifactRef.current = result;
      setArtifact(result); setProgress(null);
      setMessage(`短片已生成，实际时长 ${Math.ceil(result.durationMs / 1000)} 秒。${result.soundtrackIncluded ? "已加入旅程配乐。" : includeSoundtrack ? "此旅程未设置配乐，成片为静音。" : "已按设置关闭配乐。"}点击下载保存到设备。`);
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
    const signal = AbortSignal.any([controller.signal, lifetime.current.signal]);
    setBusy(true); setFailed(false); setProgress({ phase: "validating", completed: 0, total: 1 });
    try {
      const saved = await downloadJourneyFilm(artifact, signal);
      if (run.current !== controller) return;
      if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
      downloadUrl.current = saved.url ?? null;
      if (saved.kind === "saved") {
        artifactRef.current = null; setArtifact(null);
        setMessage(saved.cleanupFailed ? "MP4 已保存，临时文件清理未完成；稍后可清理。" : "MP4 已完整保存到所选位置。");
      } else setMessage(artifact.storageMode === "disk" ? "已发起 MP4 下载。为避免中断下载，临时文件会保留；全部下载完成后请点击清理。" : "已发起 MP4 下载。");
      await refreshRetained();
    } catch (error) {
      if (controller.signal.aborted || lifetime.current.signal.aborted) return;
      if (error instanceof DOMException && error.name === "AbortError") { setMessage("已取消保存，可重新下载。"); return; }
      clearArtifact(); setMessage(journeyFilmErrorMessage(error)); setFailed(true);
      // Retention may have completed before the final permission check failed.
      // Keep that file safe, but expose its cleanup control without a remount.
      await refreshRetained().catch(() => {});
    } finally {
      if (run.current === controller) { run.current = null; setBusy(false); setProgress(null); }
    }
  }
  async function clearSavedDownloads() {
    if (busy) return;
    setBusy(true);
    try {
      const held = artifactRef.current; clearArtifact();
      await held?.dispose?.();
      releaseJourneyFilmDownloadUrls();
      const remaining = await clearRetainedJourneyFilmDownloads();
      await refreshRetained();
      setMessage(remaining.count ? "已清理可释放的临时文件；其他页面仍使用的文件已保留。" : "已清理导出临时文件。");
    }
    catch (error) { setMessage(journeyFilmErrorMessage(error)); setFailed(true); }
    finally { setBusy(false); }
  }
  const progressText = progress?.phase === "rendering" ? `正在生成 ${Math.floor(100 * progress.completed / progress.total)}%`
    : progress?.phase === "validating" ? "正在复核旅程和访问权限…" : progress?.phase === "finalizing" ? "正在封装完整视频…" : "正在读取已授权素材…";
  return <dialog ref={dialog} className="journey-film-export" aria-labelledby="journey-film-export-title"
    data-focus-trap-exempt onCancel={(event) => { event.preventDefault(); event.stopPropagation(); onClose(); }}
    onClick={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}>
    <div className="journey-film-export__body">
      <header><div><h2 id="journey-film-export-title">导出旅程短片</h2></div>
        <button type="button" onClick={onClose} aria-label="关闭短片导出">关闭</button></header>
      <p className="journey-film-export__title">{title}</p>
      <p>在此设备生成 1080p、30 FPS 的 MP4，不上传成片。默认加入旅程中已设置的配乐；没有配乐时成片为静音。包含原片、短视频片段和路线示意，不是道路导航或地球实录。</p>
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
        <label className="journey-film-export__check"><input type="checkbox" checked={includeSoundtrack} onChange={(e) => { setSoundtrack(e.target.checked); clearArtifact(); }} />包含旅程配乐</label>
        <label className="journey-film-export__check"><input type="checkbox" checked={includeNotes} onChange={(e) => { setNotes(e.target.checked); clearArtifact(); }} />包含途径点感想字幕</label>
        <label className="journey-film-export__check"><input type="checkbox" checked={includeCover} onChange={(e) => { setCover(e.target.checked); clearArtifact(); }} />使用已生成的艺术封面（没有则使用原图）</label>
      </fieldset>
      <p className="journey-film-export__hint">保留全部场景和字幕，生成一部完整视频，实际时长可超过目标和两分钟。配乐从开头循环至片尾，不混入素材视频原声。短视频取开头片段，较短的片段停留在末帧。导出期间请保持页面打开。</p>
      {plan ? <p role="status">完整视频预计 {Math.ceil(plan.durationMs / 1000)} 秒，文件约 {Math.ceil(plan.estimatedOutputBytes / 1024 / 1024)} MiB（大小为估算）。{plan.soundtrackIncluded ? "包含旅程配乐。" : "未设置或已关闭配乐。"}</p> : null}
      {retained.count > 0 ? <div><p>设备保留了 {retained.count} 份导出临时文件，约 {Math.ceil(retained.bytes / 1024 / 1024)} MiB。请确认所有下载均已完成后再清理。</p><button type="button" disabled={busy} onClick={() => void clearSavedDownloads()}>所有下载已完成，清理临时文件</button></div> : null}
      {busy ? <div role="status" aria-live="polite"><p>{progressText}</p>
        {progress?.phase === "rendering" ? <progress aria-label="短片生成进度" max={progress.total} value={progress.completed} /> : null}
      </div> : <p role={failed ? "alert" : "status"} aria-live="polite">{message}</p>}
      <footer>{busy ? <button type="button" onClick={cancel}>取消导出</button>
        : artifact ? <button type="button" onClick={() => void download()}>下载 MP4</button>
          : <button type="button" onClick={() => void generate()}>{failed ? "重新生成" : "生成 MP4"}</button>}</footer>
    </div>
  </dialog>;
}

