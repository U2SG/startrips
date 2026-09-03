import { describe, expect, it, vi } from "vitest";
import { syncPlaybackMediaElement } from "./mediaPlaybackSync";

describe("syncPlaybackMediaElement", () => {
  it("pauses chapter video when Startrips playback pauses", () => {
    const pause = vi.fn();
    const play = vi.fn(() => Promise.resolve());
    syncPlaybackMediaElement({ pause, play }, false);
    expect(pause).toHaveBeenCalledOnce();
    expect(play).not.toHaveBeenCalled();
  });

  it("resumes chapter video when Startrips playback resumes", () => {
    const pause = vi.fn();
    const play = vi.fn(() => Promise.resolve());
    syncPlaybackMediaElement({ pause, play }, true);
    expect(play).toHaveBeenCalledOnce();
    expect(pause).not.toHaveBeenCalled();
  });

  it("reports an async play rejection so the overlay can release video ownership", async () => {
    const onPlayFailure = vi.fn();
    syncPlaybackMediaElement(
      { pause: vi.fn(), play: vi.fn(() => Promise.reject(new Error("autoplay blocked"))) },
      true,
      onPlayFailure,
    );
    await Promise.resolve();
    expect(onPlayFailure).toHaveBeenCalledOnce();
  });


  it("ignores a pending play rejection after playback state intentionally changes", async () => {
    const onPlayFailure = vi.fn();
    let rejectPlay!: (error: Error) => void;
    const pendingPlay = new Promise<void>((_resolve, reject) => {
      rejectPlay = reject;
    });
    const cancel = syncPlaybackMediaElement(
      { pause: vi.fn(), play: vi.fn(() => pendingPlay) },
      true,
      onPlayFailure,
    );
    cancel();
    rejectPlay(new DOMException("The play() request was interrupted by a call to pause().", "AbortError"));
    await Promise.resolve();
    expect(onPlayFailure).not.toHaveBeenCalled();
  });

  it("reports a synchronous play failure", () => {
    const onPlayFailure = vi.fn();
    syncPlaybackMediaElement(
      { pause: vi.fn(), play: vi.fn(() => { throw new Error("unsupported"); }) },
      true,
      onPlayFailure,
    );
    expect(onPlayFailure).toHaveBeenCalledOnce();
  });
});
