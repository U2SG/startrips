import { describe, expect, it } from "vitest";
import {
  classifyHomeBasePeriodWrite,
  homeBasePeriodCoversDate,
  isHomeBaseSource,
  resolveHomeBaseForDate,
  type HomeBasePeriodInterval,
} from "./homeBase";

const SHENZHEN = "11111111-1111-4111-8111-111111111111";
const TOKYO = "22222222-2222-4222-8222-222222222222";
const LISBON = "33333333-3333-4333-8333-333333333333";

/** Shenzhen 2022-06-01 -> 2026-09-01, then Tokyo from the move day on. */
const HISTORY: HomeBasePeriodInterval[] = [
  { id: SHENZHEN, startedOn: "2022-06-01", endedOn: "2026-09-01" },
  { id: TOKYO, startedOn: "2026-09-01", endedOn: null },
];

describe("resolveHomeBaseForDate", () => {
  it("resolves the period that applied to the journey's own date", () => {
    expect(resolveHomeBaseForDate(HISTORY, "2024-04-18")?.id).toBe(SHENZHEN);
    expect(resolveHomeBaseForDate(HISTORY, "2028-01-09")?.id).toBe(TOKYO);
  });

  it("treats an open-ended period as the current one", () => {
    const open = [{ id: TOKYO, startedOn: "2026-09-01", endedOn: null }];
    expect(resolveHomeBaseForDate(open, "2026-09-01")?.id).toBe(TOKYO);
    expect(resolveHomeBaseForDate(open, "2199-12-31")?.id).toBe(TOKYO);
  });

  it("returns null when no period applies", () => {
    expect(resolveHomeBaseForDate([], "2024-04-18")).toBeNull();
    // Before the earliest recorded start. An unknown historical start is not
    // an infinite past, so the history answers nothing rather than Shenzhen.
    expect(resolveHomeBaseForDate(HISTORY, "2019-03-02")).toBeNull();
    // A gap between two closed periods is also silence.
    expect(resolveHomeBaseForDate([
      { id: SHENZHEN, startedOn: "2022-06-01", endedOn: "2024-01-01" },
      { id: TOKYO, startedOn: "2025-01-01", endedOn: "2026-01-01" },
    ], "2024-06-15")).toBeNull();
  });

  it("resolves the move day to exactly one period", () => {
    // The boundary case the whole half-open rule exists for. The day of the
    // move belongs to the period that STARTED that day: `startedOn <= date`
    // includes Tokyo, `date < endedOn` excludes Shenzhen. One and only one
    // period covers it, in both directions.
    const covering = HISTORY.filter((period) =>
      homeBasePeriodCoversDate(period, "2026-09-01"));
    expect(covering.map((period) => period.id)).toEqual([TOKYO]);
    expect(resolveHomeBaseForDate(HISTORY, "2026-09-01")?.id).toBe(TOKYO);
    // The day before the move still belongs entirely to Shenzhen.
    expect(resolveHomeBaseForDate(HISTORY, "2026-08-31")?.id).toBe(SHENZHEN);
  });

  it("leaves an earlier date's resolution unchanged when a later period is added", () => {
    // The north star as an assertion: moving house adds a chapter, it does not
    // overwrite the origin of the chapters before it.
    const before = [{ id: SHENZHEN, startedOn: "2022-06-01", endedOn: null }];
    expect(resolveHomeBaseForDate(before, "2024-04-18")?.id).toBe(SHENZHEN);

    const after = HISTORY;
    expect(resolveHomeBaseForDate(after, "2024-04-18")?.id).toBe(SHENZHEN);
    expect(resolveHomeBaseForDate(after, "2022-06-01")?.id).toBe(SHENZHEN);
    expect(resolveHomeBaseForDate(after, "2026-08-31")?.id).toBe(SHENZHEN);
    // Only dates from the move day on see the new period.
    expect(resolveHomeBaseForDate(after, "2026-09-01")?.id).toBe(TOKYO);
  });

  it("stays deterministic on a history that is already inconsistent", () => {
    // Two overlapping periods cannot be written through the repository, but a
    // resolution must not depend on row order if one ever exists.
    const overlapping: HomeBasePeriodInterval[] = [
      { id: SHENZHEN, startedOn: "2022-06-01", endedOn: null },
      { id: TOKYO, startedOn: "2026-09-01", endedOn: null },
    ];
    expect(resolveHomeBaseForDate(overlapping, "2027-01-01")?.id).toBe(TOKYO);
    expect(resolveHomeBaseForDate([...overlapping].reverse(), "2027-01-01")?.id)
      .toBe(TOKYO);
  });
});

describe("isHomeBaseSource", () => {
  it("accepts only the two recorded sources", () => {
    expect(isHomeBaseSource("manual")).toBe(true);
    expect(isHomeBaseSource("suggested-confirmed")).toBe(true);
    expect(isHomeBaseSource("inferred")).toBe(false);
    expect(isHomeBaseSource(undefined)).toBe(false);
  });
});

describe("classifyHomeBasePeriodWrite", () => {
  it("inserts a first period and a closed period that fits a gap", () => {
    expect(classifyHomeBasePeriodWrite({
      existing: [],
      candidate: { startedOn: "2022-06-01", endedOn: null },
    })).toEqual({ outcome: "insert" });

    expect(classifyHomeBasePeriodWrite({
      existing: [
        { id: SHENZHEN, startedOn: "2022-06-01", endedOn: "2024-01-01" },
        { id: TOKYO, startedOn: "2026-01-01", endedOn: null },
      ],
      candidate: { startedOn: "2024-01-01", endedOn: "2026-01-01" },
    })).toEqual({ outcome: "insert" });
  });

  it("reads a new current Home as a move that closes the open period", () => {
    expect(classifyHomeBasePeriodWrite({
      existing: [{ id: SHENZHEN, startedOn: "2022-06-01", endedOn: null }],
      candidate: { startedOn: "2026-09-01", endedOn: null },
    })).toEqual({
      outcome: "move",
      closePeriodId: SHENZHEN,
      closeOn: "2026-09-01",
    });
  });

  it("refuses a period that ends before or on the day it starts", () => {
    expect(classifyHomeBasePeriodWrite({
      existing: [],
      candidate: { startedOn: "2026-09-01", endedOn: "2026-08-01" },
    })).toEqual({
      outcome: "conflict",
      code: "HOME_BASE_PERIOD_INVALID_INTERVAL",
    });
    // Half-open, so an equal end covers no date at all: the degenerate case
    // of the same invariant, refused for the same reason.
    expect(classifyHomeBasePeriodWrite({
      existing: [],
      candidate: { startedOn: "2026-09-01", endedOn: "2026-09-01" },
    })).toEqual({
      outcome: "conflict",
      code: "HOME_BASE_PERIOD_INVALID_INTERVAL",
    });
  });

  it("refuses two confirmed primary periods claiming the same day", () => {
    expect(classifyHomeBasePeriodWrite({
      existing: [{ id: SHENZHEN, startedOn: "2022-06-01", endedOn: "2026-09-01" }],
      candidate: { startedOn: "2024-01-01", endedOn: "2025-01-01" },
    })).toEqual({ outcome: "conflict", code: "HOME_BASE_PERIOD_OVERLAP" });

    // Touching at a boundary is not an overlap: `endedOn` is exclusive.
    expect(classifyHomeBasePeriodWrite({
      existing: [{ id: SHENZHEN, startedOn: "2022-06-01", endedOn: "2026-09-01" }],
      candidate: { startedOn: "2026-09-01", endedOn: "2027-01-01" },
    })).toEqual({ outcome: "insert" });

    // A closed candidate cannot sit under an existing open period either.
    expect(classifyHomeBasePeriodWrite({
      existing: [{ id: TOKYO, startedOn: "2026-01-01", endedOn: null }],
      candidate: { startedOn: "2026-06-01", endedOn: "2026-08-01" },
    })).toEqual({ outcome: "conflict", code: "HOME_BASE_PERIOD_OVERLAP" });
  });

  it("refuses a second current Home that cannot be a move", () => {
    // Not after the open period's own start, so closing it would produce an
    // empty or reversed interval rather than a move.
    expect(classifyHomeBasePeriodWrite({
      existing: [{ id: SHENZHEN, startedOn: "2022-06-01", endedOn: null }],
      candidate: { startedOn: "2022-06-01", endedOn: null },
    })).toEqual({ outcome: "conflict", code: "HOME_BASE_PERIOD_ALREADY_OPEN" });
    expect(classifyHomeBasePeriodWrite({
      existing: [{ id: SHENZHEN, startedOn: "2022-06-01", endedOn: null }],
      candidate: { startedOn: "2021-01-01", endedOn: null },
    })).toEqual({ outcome: "conflict", code: "HOME_BASE_PERIOD_ALREADY_OPEN" });

    // An amend never reaches for another row, so it is never a move.
    expect(classifyHomeBasePeriodWrite({
      existing: [
        { id: SHENZHEN, startedOn: "2022-06-01", endedOn: "2026-09-01" },
        { id: TOKYO, startedOn: "2026-09-01", endedOn: null },
      ],
      candidate: { startedOn: "2022-06-01", endedOn: null },
      amendingId: SHENZHEN,
    })).toEqual({ outcome: "conflict", code: "HOME_BASE_PERIOD_ALREADY_OPEN" });
  });

  it("refuses a move whose closed period would swallow a recorded one", () => {
    // Closing Shenzhen at 2026-09-01 is fine, but the candidate that opens on
    // that day would then overlap the already recorded Lisbon period.
    expect(classifyHomeBasePeriodWrite({
      existing: [
        { id: SHENZHEN, startedOn: "2022-06-01", endedOn: null },
        { id: LISBON, startedOn: "2027-01-01", endedOn: "2027-06-01" },
      ],
      candidate: { startedOn: "2026-09-01", endedOn: null },
    })).toEqual({ outcome: "conflict", code: "HOME_BASE_PERIOD_OVERLAP" });
  });

  it("lets an amend correct a period without tripping over itself", () => {
    expect(classifyHomeBasePeriodWrite({
      existing: [
        { id: SHENZHEN, startedOn: "2022-06-01", endedOn: "2026-09-01" },
        { id: TOKYO, startedOn: "2026-09-01", endedOn: null },
      ],
      candidate: { startedOn: "2022-07-01", endedOn: "2026-09-01" },
      amendingId: SHENZHEN,
    })).toEqual({ outcome: "insert" });

    // But not into its neighbour.
    expect(classifyHomeBasePeriodWrite({
      existing: [
        { id: SHENZHEN, startedOn: "2022-06-01", endedOn: "2026-09-01" },
        { id: TOKYO, startedOn: "2026-09-01", endedOn: null },
      ],
      candidate: { startedOn: "2022-06-01", endedOn: "2026-10-01" },
      amendingId: SHENZHEN,
    })).toEqual({ outcome: "conflict", code: "HOME_BASE_PERIOD_OVERLAP" });
  });
});
