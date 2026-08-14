import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JourneyStory } from "./JourneyStory";
import type { Journey } from "./types";

const journey: Journey = {
  id: "journey-1",
  atlasId: "atlas-1",
  title: "Across the island",
  startedOn: "2026-08-11",
  endedOn: null,
  note: "A quiet route home.",
  lightColor: "#f4ce73",
  createdByUserId: "user-1",
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
  routePoints: [],
  media: [],
};

describe("JourneyStory", () => {
  it("exposes explicit exit and append-media actions in the story dialog", () => {
    const markup = renderToStaticMarkup(createElement(JourneyStory, {
      journeys: [journey],
      journeyId: journey.id,
      onClose: () => undefined,
      onNavigate: () => undefined,
      onMediaAdded: () => null,
    }));

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-label="退出旅程故事"');
    expect(markup).toContain(">退出<");
    expect(markup).toContain("添加照片或视频");
    expect(markup).toContain('type="file"');
  });
});
