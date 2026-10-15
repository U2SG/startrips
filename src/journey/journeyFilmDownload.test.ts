import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadJourneyFilm, releaseJourneyFilmDownloadUrls } from "./journeyFilmDownload";
import type { JourneyFilmArtifact } from "./journeyFilmExport";

afterEach(() => { releaseJourneyFilmDownloadUrls(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function artifact(): JourneyFilmArtifact {
  return { blob: new Blob(["complete movie"], { type: "video/mp4" }), filename: "Journey.mp4", durationMs: 130000,
    storageMode: "disk", verify: vi.fn(async () => {}), dispose: vi.fn(async () => {}), retainForDownload: vi.fn(async () => {}) };
}
function saveTarget() {
  const write = vi.fn(async (_chunk: Uint8Array) => {}), abort = vi.fn();
  const stream = new WritableStream<Uint8Array>({ write, abort });
  const close = vi.fn(async () => {});
  const writable = Object.assign(stream, { close });
  const createWritable = vi.fn(async () => writable);
  const picker = vi.fn(async () => ({ createWritable }));
  vi.stubGlobal("showSaveFilePicker", picker);
  return { write, abort, close, createWritable, picker };
}
describe("complete film download ownership", () => {
  it("opens the picker in the initiating call, verifies before and after streamed copying, then disposes", async () => {
    const film = artifact(), target = saveTarget();
    const order: string[] = [];
    vi.mocked(film.verify).mockImplementation(async () => { order.push("verify"); });
    target.write.mockImplementation(async () => { order.push("write"); });
    target.close.mockImplementation(async () => { order.push("close"); });
    vi.mocked(film.dispose!).mockImplementation(async () => { order.push("dispose"); });
    const download = downloadJourneyFilm(film, new AbortController().signal);
    expect(target.picker).toHaveBeenCalledOnce();
    expect(film.verify).not.toHaveBeenCalled();
    expect(await download).toEqual({ kind: "saved", cleanupFailed: false });
    expect(order).toEqual(["verify", "write", "verify", "close", "dispose"]);
    expect(film.retainForDownload).not.toHaveBeenCalled();
  });
  it("aborts the destination without committing if authorization changes during the copy", async () => {
    const film = artifact(), target = saveTarget();
    vi.mocked(film.verify).mockResolvedValueOnce().mockRejectedValueOnce(new Error("journey_film_changed"));
    await expect(downloadJourneyFilm(film, new AbortController().signal)).rejects.toThrow("journey_film_changed");
    expect(target.write).toHaveBeenCalled(); expect(target.close).not.toHaveBeenCalled();
    expect(target.abort).toHaveBeenCalled(); expect(film.dispose).not.toHaveBeenCalled();
  });
  it("cancels a streamed save without a partial committed destination", async () => {
    const film = artifact(), target = saveTarget(), controller = new AbortController();
    target.write.mockImplementation(async () => { controller.abort(); });
    await expect(downloadJourneyFilm(film, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(target.close).not.toHaveBeenCalled(); expect(target.abort).toHaveBeenCalled();
  });
  it("does not commit or dispose the artifact when a destination write fails", async () => {
    const film = artifact(), target = saveTarget();
    target.write.mockRejectedValue(new DOMException("Disk full", "QuotaExceededError"));
    await expect(downloadJourneyFilm(film, new AbortController().signal)).rejects.toMatchObject({ name: "QuotaExceededError" });
    expect(target.close).not.toHaveBeenCalled(); expect(film.dispose).not.toHaveBeenCalled();
  });
  it("keeps staging alive until the destination close actually settles", async () => {
    const film = artifact(), target = saveTarget();
    let finishClose!: () => void;
    const closing = new Promise<void>((resolve) => { finishClose = resolve; });
    target.close.mockImplementation(() => closing);
    const saving = downloadJourneyFilm(film, new AbortController().signal);
    await vi.waitFor(() => expect(target.close).toHaveBeenCalledOnce());
    expect(film.dispose).not.toHaveBeenCalled();
    finishClose();
    expect(await saving).toEqual({ kind: "saved", cleanupFailed: false });
    expect(film.dispose).toHaveBeenCalledOnce();
  });
  it("aborts a failed destination close and preserves staging for caller cleanup", async () => {
    const film = artifact(), target = saveTarget();
    target.close.mockRejectedValue(new Error("destination close failed"));
    await expect(downloadJourneyFilm(film, new AbortController().signal)).rejects.toThrow("destination close failed");
    expect(target.abort).toHaveBeenCalled(); expect(film.dispose).not.toHaveBeenCalled();
  });
  it("does not dispose or sign anything when the destination picker is canceled", async () => {
    const film = artifact();
    vi.stubGlobal("showSaveFilePicker", vi.fn().mockRejectedValue(new DOMException("Canceled", "AbortError")));
    await expect(downloadJourneyFilm(film, new AbortController().signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(film.verify).not.toHaveBeenCalled(); expect(film.dispose).not.toHaveBeenCalled();
  });
  it("retains an anchor download before clicking and releases its URL only after explicit cleanup", async () => {
    const film = artifact(), order: string[] = [];
    vi.stubGlobal("showSaveFilePicker", undefined);
    vi.mocked(film.verify).mockImplementation(async () => { order.push("verify"); });
    vi.mocked(film.retainForDownload!).mockImplementation(async () => { order.push("retain"); });
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:retained-film");
    const anchor = { href: "", download: "", click: () => { order.push("click"); }, remove: vi.fn() };
    vi.stubGlobal("document", { createElement: () => anchor, body: { appendChild: vi.fn() } });
    expect(await downloadJourneyFilm(film, new AbortController().signal)).toEqual({ kind: "download-started" });
    expect(order).toEqual(["verify", "retain", "verify", "click"]); expect(revoke).not.toHaveBeenCalled();
    expect(film.dispose).not.toHaveBeenCalled();
    releaseJourneyFilmDownloadUrls(); expect(revoke).toHaveBeenCalledWith("blob:retained-film");
  });
  it("does not dispatch an anchor download if authorization changes while retaining its file", async () => {
    const film = artifact();
    vi.stubGlobal("showSaveFilePicker", undefined);
    vi.mocked(film.verify).mockResolvedValueOnce().mockRejectedValueOnce(new Error("journey_film_changed"));
    const createUrl = vi.spyOn(URL, "createObjectURL");
    const createElement = vi.fn();
    vi.stubGlobal("document", { createElement });
    await expect(downloadJourneyFilm(film, new AbortController().signal)).rejects.toThrow("journey_film_changed");
    expect(film.retainForDownload).toHaveBeenCalledOnce();
    expect(createUrl).not.toHaveBeenCalled(); expect(createElement).not.toHaveBeenCalled();
  });
});
