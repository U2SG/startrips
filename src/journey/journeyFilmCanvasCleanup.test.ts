import { setImmediate as nextTask } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JourneyFilmEncoderInput } from "./journeyFilmExport";

const mock = vi.hoisted(() => ({
  state: "pending", start: vi.fn(), cancel: vi.fn(), canEncode: vi.fn(), disposeStorage: vi.fn(),
}));
vi.mock("./journeyFilmStorage", () => ({
  createJourneyFilmStorage: async () => ({ target: {}, storageMode: "memory", dispose: mock.disposeStorage }),
}));
vi.mock("mediabunny", () => ({
  ALL_FORMATS: [], BlobSource: class {}, Input: class {}, CanvasSink: class {},
  Mp4OutputFormat: class {}, BufferTarget: class {},
  canEncodeVideo: mock.canEncode,
  CanvasSource: class { close() {} },
  Output: class {
    get state() { return mock.state; }
    addVideoTrack() {}
    start() { return mock.start(); }
    cancel() { mock.state = "canceled"; return mock.cancel(); }
  },
}));
import { encodeJourneyFilm } from "./journeyFilmCanvas";

function deferred() {
  let resolve!: () => void, reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("encoder cancellation lifetime", () => {
  it.each(["resolve", "reject"] as const)("drains cancellation even when state is already canceled: %s", async (end) => {
    const started = deferred(), starting = deferred(), disposal = deferred();
    mock.state = "pending";
    mock.canEncode.mockResolvedValue(true);
    mock.start.mockImplementation(() => { started.resolve(); return starting.promise; });
    mock.cancel.mockImplementation(() => disposal.promise);
    const canvas = { width: 0, height: 0, getContext: () => ({}) };
    vi.stubGlobal("document", { fonts: { ready: Promise.resolve() }, createElement: () => canvas });
    const controller = new AbortController();
    const input = {
      journey: { media: [], routePoints: [] }, sourcePlan: { scenes: [] },
      film: { manifest: { output: { width: 1080, height: 1920 }, fps: 30, totalFrames: 0, actualDurationMs: 15000 }, captions: new Map() },
      signal: controller.signal, readOpening: null, readMedia: vi.fn(), onFrame: vi.fn(),
    } as unknown as JourneyFilmEncoderInput;
    let settled = false;
    const result = encodeJourneyFilm(input).then(
      () => { settled = true; return null; },
      (error: unknown) => { settled = true; return error; },
    );
    try {
      await started.promise;
      controller.abort();
      starting.resolve();
      await nextTask();
      expect(mock.state).toBe("canceled");
      expect(mock.cancel).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      expect(canvas.width).toBe(1080);
      expect(mock.disposeStorage).not.toHaveBeenCalled();
    } finally {
      starting.resolve();
      if (end === "resolve") disposal.resolve();
      else disposal.reject(new Error("disposal failed"));
    }
    expect(await result).toBe(controller.signal.reason);
    expect(canvas.width).toBe(1);
    expect(canvas.height).toBe(1);
    expect(mock.cancel).toHaveBeenCalledOnce();
    expect(mock.disposeStorage).toHaveBeenCalledOnce();
  });
});

