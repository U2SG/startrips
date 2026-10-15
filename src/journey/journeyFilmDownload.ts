import type { JourneyFilmArtifact } from "./journeyFilmExport";
import { createJourneyFilmWatchdog } from "./journeyFilmWatchdog";

type SavePicker = (options: { suggestedName: string; types: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<FileSystemFileHandle>;
export type JourneyFilmDownloadResult = { kind: "saved" | "download-started"; url?: string; cleanupFailed?: boolean };
const retainedUrls = new Set<string>();
export function releaseJourneyFilmDownloadUrls(): void {
  for (const url of retainedUrls) URL.revokeObjectURL(url);
  retainedUrls.clear();
}

/** Called directly from the download button so a supported save picker retains user activation. */
export async function downloadJourneyFilm(artifact: JourneyFilmArtifact, parentSignal: AbortSignal): Promise<JourneyFilmDownloadResult> {
  parentSignal.throwIfAborted();
  const picker = (globalThis as typeof globalThis & { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  // Time spent choosing a destination is the member's decision, not an export stall.
  const handle = artifact.storageMode === "disk" && picker ? await picker({ suggestedName: artifact.filename,
    types: [{ description: "MP4 视频", accept: { "video/mp4": [".mp4"] } }] }) : null;
  parentSignal.throwIfAborted();
  const watchdog = createJourneyFilmWatchdog(parentSignal);
  const { signal } = watchdog;
  try {
    await artifact.verify(signal);
    signal.throwIfAborted();
    if (handle) {
      const writable = await handle.createWritable();
      let committed = false;
      const abort = () => { void writable.abort(signal.reason).catch(() => {}); };
      signal.addEventListener("abort", abort, { once: true });
      try {
        signal.throwIfAborted();
        let copied = 0;
        const progress = new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({ transform(chunk, controller) {
          copied += chunk.byteLength; watchdog.progress("saving", copied); controller.enqueue(chunk);
        } });
        // Hold destination close until revalidation after copying, so changed
        // or revoked content never commits a partial/unverified destination.
        await artifact.blob.stream().pipeThrough(progress).pipeTo(writable, { signal, preventClose: true });
        watchdog.progress("validating", 0);
        await artifact.verify(signal);
        signal.throwIfAborted();
        await writable.close();
        committed = true;
      } finally {
        signal.removeEventListener("abort", abort);
        if (!committed) await writable.abort().catch(() => {});
      }
      let cleanupFailed = false;
      try { await artifact.dispose?.(); } catch { cleanupFailed = true; }
      return { kind: "saved", cleanupFailed };
    }
    // An anchor download has no completion signal. Retain disk storage and
    // its URL across dialog close until explicit "all downloads finished".
    await artifact.retainForDownload?.();
    signal.throwIfAborted();
    // Registry contention or its disk write may outlive the prior check.
    // Re-authorize at the actual download boundary, after that await.
    await artifact.verify(signal);
    signal.throwIfAborted();
    const url = URL.createObjectURL(artifact.blob);
    const link = document.createElement("a");
    link.href = url; link.download = artifact.filename;
    try { document.body.appendChild(link); link.click(); }
    catch (error) { URL.revokeObjectURL(url); throw error; }
    finally { link.remove(); }
    if (artifact.storageMode === "disk") { retainedUrls.add(url); return { kind: "download-started" }; }
    return { kind: "download-started", url };
  } finally { watchdog.dispose(); }
}
