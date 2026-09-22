import { describe, expect, it } from "vitest";
import {
  MAX_SEGMENT_PIXELS,
  mergeItinerarySegmentReadings,
  planItineraryImageSegments,
  type ItineraryImageSegmentPlan,
} from "./itineraryImageSegments";
import type {
  ItineraryRecognition,
  ItineraryRecognitionEntry,
} from "./itineraryImport";

/**
 * #512: the long-screenshot path, as a plan and an assembly rather than as a
 * canvas. Cutting the bands and putting the readings back together are the two
 * places a plan can lose a day or gain a place it never listed; drawing the
 * pixels is the browser's job and is not what these assert.
 */

function segment(
  pageIndex: number,
  segmentIndex: number,
  overlapWithPrevious = 0,
): ItineraryImageSegmentPlan {
  return { pageIndex, segmentIndex, top: 0, height: 100, overlapWithPrevious };
}

function entry(
  dayNumber: number,
  orderInDay: number,
  name: string,
): ItineraryRecognitionEntry {
  return { sourceEntryId: null, dayNumber, orderInDay, name, role: "attraction" };
}

function reading(
  dayNumbers: readonly number[],
  entries: readonly ItineraryRecognitionEntry[],
  overrides: Partial<ItineraryRecognition> = {},
): ItineraryRecognition {
  return {
    contractVersion: 1,
    sourceKind: "image",
    recognizerVersion: "reader/1",
    sourceTitle: null,
    sourceReportedDayCount: null,
    sourceReportedPlaceCount: null,
    days: dayNumbers.map((dayNumber) => ({
      dayNumber,
      sourceDayTitle: null,
      calendarDate: null,
      partialDate: null,
    })),
    entries: [...entries],
    ...overrides,
  };
}

describe("planning the bands of a long screenshot", () => {
  it("leaves an image that already fits as one whole segment", () => {
    const plan = planItineraryImageSegments({ pageIndex: 0, width: 1000, height: 800 });
    expect(plan).toEqual([
      { pageIndex: 0, segmentIndex: 0, top: 0, height: 800, overlapWithPrevious: 0 },
    ]);
  });

  it("cuts a tall screenshot into bounded, overlapping, ordered bands", () => {
    const width = 1_000;
    const plan = planItineraryImageSegments({ pageIndex: 2, width, height: 9_000 });

    expect(plan.length).toBeGreaterThan(1);
    expect(plan.every((band) => band.pageIndex === 2)).toBe(true);
    expect(plan.map((band) => band.segmentIndex)).toEqual(plan.map((_, index) => index));
    // Every band stays inside the budget one request is built against.
    expect(plan.every((band) => band.height * width <= MAX_SEGMENT_PIXELS)).toBe(true);
    // Consecutive bands really do overlap, so a row on a cut is whole somewhere.
    expect(plan.slice(1).every((band) => band.overlapWithPrevious > 0)).toBe(true);
    // And together they cover the image with no gap.
    expect(plan[0].top).toBe(0);
    expect(plan[plan.length - 1].top + plan[plan.length - 1].height).toBe(9_000);
    for (let index = 1; index < plan.length; index += 1) {
      expect(plan[index].top).toBeLessThanOrEqual(plan[index - 1].top + plan[index - 1].height);
      expect(plan[index].top).toBeGreaterThan(plan[index - 1].top);
    }
  });

  it("still advances when the requested overlap is larger than a band", () => {
    const plan = planItineraryImageSegments(
      { pageIndex: 0, width: 100, height: 1_000 },
      { maxSegmentPixels: 20_000, overlap: 900 },
    );
    expect(plan.length).toBeGreaterThan(1);
    expect(plan.length).toBeLessThan(100);
  });
});

describe("assembling the bands back into one plan", () => {
  it("keeps one draft, in printed order, across several images", () => {
    const merged = mergeItinerarySegmentReadings([
      {
        segment: segment(1, 0),
        recognition: reading([3], [entry(3, 1, "东京塔")]),
      },
      {
        segment: segment(0, 0),
        recognition: reading([1], [entry(1, 1, "宽窄巷子"), entry(1, 2, "锦里")], {
          sourceTitle: "西南若干日游",
          sourceReportedPlaceCount: 9,
        }),
      },
    ]);

    expect(merged.days.map((day) => day.dayNumber)).toEqual([1, 3]);
    expect(merged.entries.map((item) => item.name)).toEqual([
      "宽窄巷子",
      "锦里",
      "东京塔",
    ]);
    // The page's own claim is carried for comparison, never summed per band.
    expect(merged.sourceReportedPlaceCount).toBe(9);
    expect(merged.sourceTitle).toBe("西南若干日游");
  });

  it("drops only the row the overlap read twice", () => {
    const merged = mergeItinerarySegmentReadings([
      {
        segment: segment(0, 0),
        recognition: reading([1], [entry(1, 1, "宽窄巷子"), entry(1, 2, "锦里")]),
      },
      {
        segment: segment(0, 1, 96),
        recognition: reading([1, 2], [entry(1, 2, "锦里"), entry(2, 1, "都江堰")]),
      },
    ]);

    expect(merged.entries.map((item) => `${item.dayNumber}:${item.name}`)).toEqual([
      "1:宽窄巷子",
      "1:锦里",
      "2:都江堰",
    ]);
  });

  it("keeps every visit to a place the plan really lists more than once", () => {
    const merged = mergeItinerarySegmentReadings([
      {
        segment: segment(0, 0),
        // A same-day return, and the same hotel on two days: both are the plan
        // saying so, not the overlap repeating itself.
        recognition: reading([1], [
          entry(1, 1, "京都站"),
          entry(1, 2, "伏见稻荷"),
          entry(1, 3, "京都站"),
          entry(1, 4, "Hotel Granvia"),
        ]),
      },
      {
        segment: segment(0, 1, 96),
        recognition: reading([1, 2], [
          entry(1, 4, "Hotel Granvia"),
          entry(2, 1, "Hotel Granvia"),
        ]),
      },
    ]);

    expect(merged.entries.map((item) => `${item.dayNumber}.${item.orderInDay} ${item.name}`))
      .toEqual([
        "1.1 京都站",
        "1.2 伏见稻荷",
        "1.3 京都站",
        "1.4 Hotel Granvia",
        "2.1 Hotel Granvia",
      ]);
  });

  it("never cancels a repeat across two images, only inside one overlap", () => {
    const merged = mergeItinerarySegmentReadings([
      { segment: segment(0, 0), recognition: reading([1], [entry(1, 1, "大阪城")]) },
      { segment: segment(1, 0), recognition: reading([1], [entry(1, 1, "大阪城")]) },
    ]);
    expect(merged.entries).toHaveLength(2);
  });

  it("completes a day from whichever band actually saw its heading", () => {
    const merged = mergeItinerarySegmentReadings([
      {
        segment: segment(0, 0),
        recognition: reading([], [entry(2, 1, "都江堰")], {
          days: [{
            dayNumber: 2,
            sourceDayTitle: null,
            calendarDate: null,
            partialDate: null,
          }],
        }),
      },
      {
        segment: segment(0, 1, 96),
        recognition: reading([], [], {
          days: [{
            dayNumber: 2,
            sourceDayTitle: "第二天 03-15 周日",
            calendarDate: null,
            partialDate: "03-15",
            regionContext: "成都",
          }],
          recognizerVersion: "reader/2",
        }),
      },
    ]);

    expect(merged.days).toEqual([{
      dayNumber: 2,
      sourceDayTitle: "第二天 03-15 周日",
      calendarDate: null,
      partialDate: "03-15",
      regionContext: "成都",
    }]);
    // The year stays unconfirmed; nothing here invents one.
    expect(merged.days[0].calendarDate).toBeNull();
    // Both readers are named, so a mixed reading stays attributable.
    expect(merged.recognizerVersion).toBe("reader/1+reader/2");
  });
});
