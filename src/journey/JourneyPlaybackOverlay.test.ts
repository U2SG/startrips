import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JourneyPlaybackDenseNavigator } from "./JourneyPlaybackOverlay";
import type { PlaybackSequenceChapterPresentation } from "./playbackSequenceChapter";

function densePresentation(
  overrides: Partial<PlaybackSequenceChapterPresentation> = {},
): PlaybackSequenceChapterPresentation {
  return {
    density: "dense",
    pointIndex: 0,
    mediaIndex: 11,
    position: 12,
    total: 30,
    canPrevious: true,
    canNext: true,
    primaryAssetId: "dense-11",
    peekMediaIndexes: [10, 12],
    peekAssetIds: ["dense-10", "dense-12"],
    ...overrides,
  };
}

describe("JourneyPlaybackOverlay dense chapter navigator (#498)", () => {
  it("renders the director-owned current asset and honest bounded position without album-sized DOM", () => {
    const markup = renderToStaticMarkup(createElement(JourneyPlaybackDenseNavigator, {
      presentation: densePresentation(),
      onBack: () => undefined,
      onNext: () => undefined,
    }));

    expect(markup).toContain('class="journey-playback__dense-nav"');
    expect(markup).toContain('data-dense-position="12"');
    expect(markup).toContain('data-dense-total="30"');
    expect(markup).toContain('data-dense-primary-asset="dense-11"');
    expect(markup).toContain("12 / 30");
    expect(markup.match(/<button/g)).toHaveLength(2);
    expect(markup).not.toContain("dense-10");
    expect(markup).not.toContain("dense-12");
  });

  it("disables only the boundary direction while keeping the same two-control surface", () => {
    const first = renderToStaticMarkup(createElement(JourneyPlaybackDenseNavigator, {
      presentation: densePresentation({
        mediaIndex: 0,
        position: 1,
        canPrevious: false,
        primaryAssetId: "dense-0",
      }),
      onBack: () => undefined,
      onNext: () => undefined,
    }));
    const last = renderToStaticMarkup(createElement(JourneyPlaybackDenseNavigator, {
      presentation: densePresentation({
        mediaIndex: 29,
        position: 30,
        canNext: false,
        primaryAssetId: "dense-29",
      }),
      onBack: () => undefined,
      onNext: () => undefined,
    }));

    expect(first.match(/disabled=""/g)).toHaveLength(1);
    expect(last.match(/disabled=""/g)).toHaveLength(1);
    expect(first).toContain("1 / 30");
    expect(last).toContain("30 / 30");
    expect(first.match(/<button/g)).toHaveLength(2);
    expect(last.match(/<button/g)).toHaveLength(2);
  });
});