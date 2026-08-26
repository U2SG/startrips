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
});
