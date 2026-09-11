import { describe, expect, it } from "vitest";
import { isPersistedCalendarDate } from "./calendarDate";

describe("isPersistedCalendarDate", () => {
  it("rejects year zero without inventing a broader year range", () => {
    expect(isPersistedCalendarDate("0000-01-01")).toBe(false);
    expect(isPersistedCalendarDate("0001-01-01")).toBe(true);
    expect(isPersistedCalendarDate("9999-12-31")).toBe(true);
  });

  it("keeps the fixed-width real-calendar-day contract", () => {
    expect(isPersistedCalendarDate("2026-09-11")).toBe(true);
    expect(isPersistedCalendarDate("2026-9-11")).toBe(false);
    expect(isPersistedCalendarDate("2026-02-30")).toBe(false);
    expect(isPersistedCalendarDate("not-a-date")).toBe(false);
    expect(isPersistedCalendarDate(null)).toBe(false);
  });
});
