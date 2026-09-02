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
