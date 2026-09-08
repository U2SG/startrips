import { describe, expect, it } from "vitest";
import {
  groupEverydayFragmentsByHomeBase,
  MAX_EVERYDAY_FRAGMENT_NOTE_LENGTH,
  validateEverydayFragmentInput,
} from "./everydayFragment";
import { resolveHomeBaseForDate } from "./homeBase";

/**
 * #234: the pure rules of the record type. No DOM, no database — these run in
 * the default node environment of the `core` lane like every other test under
 * `src/`.
 */

const SHENZHEN_BAY = {
  occurredOn: "2026-03-14",
  latitude: 22.503,
  longitude: 113.938,
};

describe("validateEverydayFragmentInput", () => {
  it("accepts a fragment with no title and no route", () => {
    // The whole point of the record type: an ordinary evening is keepable
    // without naming it and without a route. A title is not even a field.
    expect(validateEverydayFragmentInput({ ...SHENZHEN_BAY })).toEqual({
      accepted: true,
      values: {
        ...SHENZHEN_BAY,
        placeLabel: null,
        note: null,
        homeBasePeriodId: null,
      },
    });
  });

  it("normalizes an optional label and note and drops empty text", () => {
    expect(validateEverydayFragmentInput({
      ...SHENZHEN_BAY,
      placeLabel: "  Shenzhen Bay Park  ",
      note: "   ",
    })).toEqual({
      accepted: true,
      values: {
        ...SHENZHEN_BAY,
        placeLabel: "Shenzhen Bay Park",
        note: null,
        homeBasePeriodId: null,
      },
    });
  });

  it("requires the date the fragment happened on", () => {
    expect(validateEverydayFragmentInput({
      latitude: SHENZHEN_BAY.latitude,
      longitude: SHENZHEN_BAY.longitude,
    })).toEqual({
      accepted: false,
      reason: "EVERYDAY_FRAGMENT_INVALID_DATE",
    });
  });

  it("rejects a malformed date with a typed reason code", () => {
    // Not prose: the caller branches on the code, and dates are compared as
    // strings, so a short month would sort wrong forever rather than fail
    // loudly later. `2026-02-30` parses as a date and is not a day.
    for (const occurredOn of ["2026-3-14", "2026-02-30", "14/03/2026", "", 20260314]) {
      expect(validateEverydayFragmentInput({ ...SHENZHEN_BAY, occurredOn }))
        .toEqual({ accepted: false, reason: "EVERYDAY_FRAGMENT_INVALID_DATE" });
    }
  });

  it("rejects year zero, which PostgreSQL cannot store", () => {
    // JavaScript accepts `0000-01-01` and round-trips it intact, so without
    // this the value would reach a `date` column and fail as a generic 500
    // instead of the reason code this module exists to produce.
    expect(validateEverydayFragmentInput({
      ...SHENZHEN_BAY,
      occurredOn: "0000-01-01",
    })).toEqual({ accepted: false, reason: "EVERYDAY_FRAGMENT_INVALID_DATE" });
    expect(validateEverydayFragmentInput({
      ...SHENZHEN_BAY,
      occurredOn: "0001-01-01",
    })).toMatchObject({ accepted: true });
  });

  it("requires a coordinate pair", () => {
    expect(validateEverydayFragmentInput({
      occurredOn: SHENZHEN_BAY.occurredOn,
      longitude: SHENZHEN_BAY.longitude,
    })).toEqual({
      accepted: false,
      reason: "EVERYDAY_FRAGMENT_INVALID_LATITUDE",
    });
    expect(validateEverydayFragmentInput({
      occurredOn: SHENZHEN_BAY.occurredOn,
      latitude: SHENZHEN_BAY.latitude,
    })).toEqual({
      accepted: false,
      reason: "EVERYDAY_FRAGMENT_INVALID_LONGITUDE",
    });
  });

  it("rejects an out-of-range latitude with a typed reason code", () => {
    for (const latitude of [90.0001, -91, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(validateEverydayFragmentInput({ ...SHENZHEN_BAY, latitude }))
        .toEqual({
          accepted: false,
          reason: "EVERYDAY_FRAGMENT_INVALID_LATITUDE",
        });
    }
    expect(validateEverydayFragmentInput({ ...SHENZHEN_BAY, latitude: 90 }))
      .toMatchObject({ accepted: true });
  });

  it("rejects an out-of-range longitude with a typed reason code", () => {
    for (const longitude of [180.5, -181, "113.938"]) {
      expect(validateEverydayFragmentInput({ ...SHENZHEN_BAY, longitude }))
        .toEqual({
          accepted: false,
          reason: "EVERYDAY_FRAGMENT_INVALID_LONGITUDE",
        });
    }
    expect(validateEverydayFragmentInput({ ...SHENZHEN_BAY, longitude: -180 }))
      .toMatchObject({ accepted: true });
  });

  it("rejects non-text and over-long optional fields distinctly", () => {
    expect(validateEverydayFragmentInput({ ...SHENZHEN_BAY, note: 7 }))
      .toEqual({ accepted: false, reason: "EVERYDAY_FRAGMENT_INVALID_TEXT" });
    expect(validateEverydayFragmentInput({
      ...SHENZHEN_BAY,
      note: "x".repeat(MAX_EVERYDAY_FRAGMENT_NOTE_LENGTH + 1),
    })).toEqual({
      accepted: false,
      reason: "EVERYDAY_FRAGMENT_TEXT_TOO_LONG",
    });
  });

  it("accepts an omitted Home Base association and refuses a malformed one", () => {
    // A fragment can be recorded long before any Home Base is confirmed, so
    // an absent association is normal rather than incomplete.
    expect(validateEverydayFragmentInput({
      ...SHENZHEN_BAY,
      homeBasePeriodId: null,
    })).toMatchObject({ accepted: true, values: { homeBasePeriodId: null } });
    expect(validateEverydayFragmentInput({
      ...SHENZHEN_BAY,
      homeBasePeriodId: "not-an-id",
    })).toEqual({
      accepted: false,
      reason: "EVERYDAY_FRAGMENT_INVALID_HOME_BASE_PERIOD",
    });
  });
});

const SHENZHEN_PERIOD = {
  id: "11111111-1111-4111-8111-111111111111",
  startedOn: "2022-06-01",
  endedOn: "2026-01-15",
};
const TOKYO_PERIOD = {
  id: "22222222-2222-4222-8222-222222222222",
  startedOn: "2026-01-15",
  endedOn: null,
};

function fragment(id: string, occurredOn: string, latitude: number, longitude: number) {
  return { id, occurredOn, latitude, longitude };
}

describe("groupEverydayFragmentsByHomeBase", () => {
  it("groups each fragment under the period that held on its own date", () => {
    const evening = fragment("a", "2025-11-02", 22.503, 113.938);
    const izakaya = fragment("b", "2026-04-20", 35.68, 139.76);
    const moveDay = fragment("c", "2026-01-15", 35.68, 139.76);

    const grouping = groupEverydayFragmentsByHomeBase(
      [evening, izakaya, moveDay],
      [SHENZHEN_PERIOD, TOKYO_PERIOD],
    );

    expect(grouping.groups.map((group) => group.period.id)).toEqual([
      SHENZHEN_PERIOD.id,
      TOKYO_PERIOD.id,
    ]);
    expect(grouping.groups[0].fragments).toEqual([evening]);
    // The move day belongs to the period that started it, which is the same
    // half-open answer `resolveHomeBaseForDate` gives; nothing here re-derives
    // that boundary.
    expect(grouping.groups[1].fragments).toEqual([izakaya, moveDay]);
    expect(grouping.ungrouped).toEqual([]);
  });

  it("puts a fragment recorded before any confirmed period in the ungrouped bucket", () => {
    const beforeAnyHome = fragment("d", "2019-08-09", 41.15, -8.61);

    const grouping = groupEverydayFragmentsByHomeBase(
      [beforeAnyHome],
      [SHENZHEN_PERIOD, TOKYO_PERIOD],
    );

    expect(grouping.ungrouped).toEqual([beforeAnyHome]);
    expect(grouping.groups.every((group) => group.fragments.length === 0))
      .toBe(true);
    // An explicit bucket, not an absence: recording an ordinary evening years
    // before confirming a Home Base is not an error and must not vanish.
    expect(resolveHomeBaseForDate(
      [SHENZHEN_PERIOD, TOKYO_PERIOD],
      beforeAnyHome.occurredOn,
    )).toBeNull();
  });

  it("groups every fragment into the ungrouped bucket when no period exists at all", () => {
    const evening = fragment("e", "2025-11-02", 22.503, 113.938);
    const grouping = groupEverydayFragmentsByHomeBase([evening], []);
    expect(grouping).toEqual({ groups: [], ungrouped: [evening] });
  });

  it("returns the input fragments with their own date and coordinates deeply unchanged", () => {
    const evening = fragment("f", "2025-11-02", 22.503, 113.938);
    const izakaya = fragment("g", "2026-04-20", 35.68, 139.76);
    const before = structuredClone([evening, izakaya]);

    const grouping = groupEverydayFragmentsByHomeBase(
      [evening, izakaya],
      [SHENZHEN_PERIOD, TOKYO_PERIOD],
    );

    // Grouping is contextual. Confirming a Home Base reorganizes a view; it
    // never edits a recorded truth, so both the inputs and the grouped
    // outputs still carry the fragment's own date and position.
    expect([evening, izakaya]).toEqual(before);
    expect(grouping.groups[0].fragments[0]).toBe(evening);
    expect(grouping.groups[1].fragments[0]).toBe(izakaya);
    expect(grouping.groups.flatMap((group) => group.fragments)).toEqual(before);
  });
});
