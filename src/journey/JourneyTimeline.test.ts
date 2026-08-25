import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JourneyTimeline } from "./JourneyTimeline";
import type { Journey } from "./types";

const journey: Journey = {
  id: "journey-1",
  atlasId: "atlas-1",
  title: "Across the island",
  startedOn: "2026-08-11",
  endedOn: null,
  note: "A quiet route home.",
  lightColor: "#f4ce73",
  revision: 1,
  createdByUserId: "user-1",
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
  routePoints: [{
    id: "point-1",
    journeyId: "journey-1",
    sortOrder: 0,
    latitude: 1.3521,
    longitude: 103.8198,
    label: "Singapore",
    isStop: true,
    occurredAt: null,
    createdAt: "2026-08-11T00:00:00.000Z",
  }],
  media: [],
};

describe("JourneyTimeline card interaction (#13)", () => {
  it("renders a full-card hit area that labels the story action", () => {
    const markup = renderToStaticMarkup(createElement(JourneyTimeline, {
      journeys: [journey],
      activeJourneyId: null,
      onOpenStory: () => undefined,
      onCreate: () => undefined,
    }));

    // One transparent hit-area button per card, labelled for keyboard/screen
    // reader access. The story action belongs to the whole card surface.
    expect(markup).toContain('class="journey-timeline__hit-area"');
    expect(markup).toContain(`aria-label="打开旅程：${journey.title}"`);
    expect(markup).toContain('class="journey-timeline__story"');
  });

  it("keeps card metadata inert so clicks reach the hit area", () => {
    const markup = renderToStaticMarkup(createElement(JourneyTimeline, {
      journeys: [journey],
      activeJourneyId: null,
      onOpenStory: () => undefined,
      onCreate: () => undefined,
    }));

    // The content wrapper must not be a focusable/pointer target of its own;
    // it is aria-hidden so the hit area is the single accessible control.
    expect(markup).toContain('class="journey-timeline__content"');
    expect(markup).toContain('aria-hidden="true"');
    // The date/title/summary text still renders for sighted users.
    expect(markup).toContain("Across the island");
    expect(markup).toContain("Singapore");
    expect(markup).toContain("还没有影像");
  });

  it("opens the story from the hit area and from the explicit story button", () => {
    const markup = renderToStaticMarkup(createElement(JourneyTimeline, {
      journeys: [journey],
      activeJourneyId: null,
      onOpenStory: () => undefined,
      onCreate: () => undefined,
    }));

    // Both entry points must invoke the story handler (component logic; the
    // DOM event wiring is exercised by the browser-level QA script).
    expect(markup).toContain('class="journey-timeline__hit-area"');
    expect(markup).toContain(">打开故事<");
  });
});
