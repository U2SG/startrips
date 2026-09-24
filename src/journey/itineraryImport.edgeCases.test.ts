import { describe, expect, it } from "vitest";
import {
  buildItineraryImportDraft,
  defaultItinerarySelection,
  itineraryDraftEntries,
  itineraryDraftToRoutePoints,
  itineraryImportJobKey,
} from "./itineraryImport";
import { readTextItinerary } from "./itineraryText";

/**
 * #512, the structural edge cases the owner's real sample exposes, each one
 * asserted on its own.
 *
 * They are separate tests on purpose. A single clean three-stop itinerary
 * passes while every one of these silently loses something, and the loss is
 * always the same shape: the reader filling in what the source did not say.
 * Every fixture below is synthetic and reproduces structure only.
 */

function draftOf(text: string, label: string) {
  return buildItineraryImportDraft(
    readTextItinerary(text),
    itineraryImportJobKey("text", label),
  );
}

describe("a source day count that disagrees with the listed dates", () => {
  const draft = draftOf(
    `成都重庆 8日游
Day 1 · 2026-03-14 · 成都
景点 宽窄巷子 @30.6600,104.0500
Day 2 · 2026-03-15 · 成都
景点 人民公园 @30.6700,104.0600
Day 3 · 2026-03-16 · 重庆
景点 洪崖洞 @29.5600,106.5800
`,
    "day-count",
  );

  it("keeps the source title exactly as printed", () => {
    expect(draft.sourceTitle).toBe("成都重庆 8日游");
    expect(draft.sourceReportedDayCount).toBe(8);
  });

  it("builds the days the dates actually state, in order, without padding", () => {
    expect(draft.days.map((day) => day.dayNumber)).toEqual([1, 2, 3]);
    expect(draft.days.map((day) => day.calendarDate)).toEqual([
      "2026-03-14",
      "2026-03-15",
      "2026-03-16",
    ]);
  });

  it("reports the difference instead of truncating or reordering", () => {
    expect(draft.notices).toContain("source-day-count-mismatch");
    expect(draft.counts.recognizedEntryCount).toBe(3);
  });
});

describe("an entry the source marked invalid", () => {
  const draft = draftOf(
    `Day 1 · 2026-03-14 · Chengdu
Visit: Old Teahouse [已失效] @30.6600,104.0500
Visit: 宽窄巷子 @30.6700,104.0600
`,
    "invalid",
  );
  const invalid = itineraryDraftEntries(draft)
    .find((entry) => entry.name === "Old Teahouse");

  it("flags it source-invalid and keeps the printed name", () => {
    expect(invalid?.flags).toContain("source-invalid");
    expect(invalid?.name).toBe("Old Teahouse");
  });

  it("waits for confirmation instead of importing it silently", () => {
    expect(invalid?.needsConfirmation).toBe(true);
    expect(defaultItinerarySelection(draft)).not.toContain(invalid?.entryId);
    expect(
      itineraryDraftToRoutePoints(draft, defaultItinerarySelection(draft))
        .map((item) => item.point.label),
    ).toEqual(["宽窄巷子"]);
  });

  it("can still be imported once the member confirms it", () => {
    expect(
      itineraryDraftToRoutePoints(draft, [invalid!.entryId])
        .map((item) => item.point.label),
    ).toEqual(["Old Teahouse"]);
  });
});

describe("a name the source cut off", () => {
  const draft = draftOf(
    `Day 1 · 2026-03-14 · 成都
景点 成都大剧院《茶馆》演出… @30.6600,104.0500
`,
    "truncated",
  );
  const [entry] = itineraryDraftEntries(draft);

  it("keeps the readable part and marks it truncated", () => {
    expect(entry.flags).toContain("truncated");
    expect(entry.name).toBe("成都大剧院《茶馆》演出");
    expect(entry.name).not.toMatch(/…|\.\.\./);
  });

  it("fabricates no venue, no alias and no title behind the cut", () => {
    expect(entry.aliases).toEqual([]);
    expect(entry.transitEndpoints).toBeNull();
    expect(entry.needsConfirmation).toBe(true);
  });

  it("fabricates no date for it either", () => {
    const [imported] = itineraryDraftToRoutePoints(draft, [entry.entryId]);
    expect(imported.point.occurredAt).toBe("2026-03-14");
    expect(imported.point.label).toBe("成都大剧院《茶馆》演出");
  });
});

describe("a place that recurs across days", () => {
  const draft = draftOf(
    `Day 1 · 2026-03-14 · A城
住宿 山间酒店 @30.1000,104.1000
景点 A景点 @30.1100,104.1100
Day 2 · 2026-03-15 · A城
住宿 山间酒店 @30.1000,104.1000
交通 A城 至 B城
Day 3 · 2026-03-16 · B城
景点 B景点 @29.1000,106.1000
交通 B城 至 C城
景点 C景点 @28.1000,107.1000
Day 4 · 2026-03-17 · A城
景点 A景点 @30.1100,104.1100
`,
    "recurring",
  );
  const entries = itineraryDraftEntries(draft);
  const named = (name: string) =>
    entries.filter((entry) => entry.name === name);

  it("keeps one entry per night for a stay repeated on adjacent days", () => {
    const stays = named("山间酒店");
    expect(stays.map((entry) => entry.dayNumber)).toEqual([1, 2]);
    expect(stays[1].suggestedMergeWithEntryId).toBe(stays[0].entryId);
    expect(stays[1].flags).toContain("possible-repeat-visit");
    // A hint is not a question: both nights import by default.
    expect(stays[1].needsConfirmation).toBe(false);
    expect(defaultItinerarySelection(draft))
      .toEqual(expect.arrayContaining(stays.map((entry) => entry.entryId)));
  });

  it("keeps one entry per visit for a non-adjacent A to B to A revisit", () => {
    const visits = named("A景点");
    expect(visits.map((entry) => entry.dayNumber)).toEqual([1, 4]);
    expect(visits[0].entryId).not.toBe(visits[1].entryId);
    expect(visits[1].suggestedMergeWithEntryId).toBe(visits[0].entryId);
  });

  it("keeps a one-day multi-region sequence in printed order", () => {
    const dayThree = draft.days.find((day) => day.dayNumber === 3);
    expect(dayThree?.entries.map((entry) => entry.name)).toEqual([
      "B景点",
      "B城 至 C城",
      "C景点",
    ]);
    // The day is headed by one region; an entry beyond it is not dropped.
    expect(dayThree?.regionContext).toBe("B城");
  });

  it("never deduplicates a repeated name out of the Route", () => {
    const imported = itineraryDraftToRoutePoints(
      draft,
      defaultItinerarySelection(draft),
    );
    expect(imported.map((item) => item.point.label)).toEqual([
      "山间酒店",
      "A景点",
      "山间酒店",
      "B景点",
      "C景点",
      "A景点",
    ]);
  });
});

describe("a day heading with no year", () => {
  const draft = draftOf(
    `Day 1 · 3月14日 周六 · 成都
景点 宽窄巷子 @30.6600,104.0500
`,
    "no-year",
  );
  const [day] = draft.days;

  it("keeps the month and day and leaves the year unconfirmed", () => {
    expect(day.partialDate).toBe("03-14");
    expect(day.calendarDate).toBeNull();
    expect(day.yearConfirmed).toBe(false);
    expect(draft.notices).toContain("year-unconfirmed");
  });

  it("infers no year from the weekday or from today", () => {
    const thisYear = String(new Date().getUTCFullYear());
    expect(day.sourceDayTitle).not.toContain(thisYear);
    expect(day.partialDate).not.toContain(thisYear);
    expect(itineraryDraftEntries(draft)[0].flags).toContain("year-unconfirmed");
  });

  it("saves a Route Point with no date rather than a guessed one", () => {
    const [imported] = itineraryDraftToRoutePoints(
      draft,
      [itineraryDraftEntries(draft)[0].entryId],
    );
    expect(imported.point.occurredAt).toBeNull();
  });
});

describe("a trailing day with a date and nothing listed", () => {
  const draft = draftOf(
    `Day 1 · 2026-03-14 · 成都
景点 宽窄巷子 @30.6600,104.0500
Day 2 · 2026-03-15 · 成都
`,
    "empty-day",
  );

  it("preserves the empty day instead of dropping it", () => {
    expect(draft.days.map((day) => day.dayNumber)).toEqual([1, 2]);
    expect(draft.days[1].calendarDate).toBe("2026-03-15");
    expect(draft.days[1].entries).toEqual([]);
    expect(draft.notices).toContain("empty-day-preserved");
  });

  it("fabricates nothing to fill it and calls the read no failure", () => {
    expect(draft.counts.recognizedEntryCount).toBe(1);
    expect(itineraryDraftToRoutePoints(
      draft,
      defaultItinerarySelection(draft),
    )).toHaveLength(1);
  });
});
