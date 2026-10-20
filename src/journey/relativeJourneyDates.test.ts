import { describe, expect, it } from "vitest";
import { journeySentenceToItineraryText, readTextItinerary } from "./itineraryText";
import { inferJourneyDates, localCalendarToday, relativeJourneyDates } from "./relativeJourneyDates";

// 2026-10-20 is a Tuesday; its week starts on Monday 2026-10-19.
const TODAY = "2026-10-20";

function range(sentence: string, today = TODAY) {
  const dates = relativeJourneyDates(sentence, today);
  return dates ? [dates.startDate, dates.endDate, dates.phrase] : null;
}

describe("relativeJourneyDates", () => {
  it("reads days and weeks against today", () => {
    expect(range("昨天去了趟青城山")).toEqual(["2026-10-19", "2026-10-19", "昨天"]);
    expect(range("前天在杭州")).toEqual(["2026-10-18", "2026-10-18", "前天"]);
    expect(range("上周末去莫干山")).toEqual(["2026-10-17", "2026-10-18", "上周末"]);
    expect(range("上周从北京到天津")).toEqual(["2026-10-12", "2026-10-18", "上周"]);
    expect(range("这周在厦门")).toEqual(["2026-10-19", "2026-10-20", "这周"]);
  });

  it("reads months, ending a month still under way today", () => {
    expect(range("上个月从成都自驾去稻城")).toEqual(["2026-09-01", "2026-09-30", "上个月"]);
    expect(range("上个月去了哈尔滨", "2026-01-10")).toEqual(["2025-12-01", "2025-12-31", "上个月"]);
    expect(range("这个月在大理")).toEqual(["2026-10-01", "2026-10-20", "这个月"]);
    expect(range("十月在大理")).toEqual(["2026-10-01", "2026-10-20", "十月"]);
  });

  it("takes the latest month or holiday that is not after today", () => {
    expect(range("3月去了京都")).toEqual(["2026-03-01", "2026-03-31", "3月"]);
    expect(range("12月去了京都")).toEqual(["2025-12-01", "2025-12-31", "12月"]);
    expect(range("去年3月去了京都")).toEqual(["2025-03-01", "2025-03-31", "去年3月"]);
    expect(range("5月3日在青岛")).toEqual(["2026-05-03", "2026-05-03", "5月3日"]);
    expect(range("国庆去了西安")).toEqual(["2026-10-01", "2026-10-07", "国庆"]);
    expect(range("去年国庆去了西安")).toEqual(["2025-10-01", "2025-10-07", "去年国庆"]);
    expect(range("国庆去了西安", "2026-09-15")).toEqual(["2025-10-01", "2025-10-07", "国庆"]);
  });

  it("does not read a period that has not begun, a stated year or a vague phrase", () => {
    expect(range("今年11月去冰岛")).toBeNull();
    expect(range("今年国庆去西安", "2026-09-15")).toBeNull();
    expect(range("2025年3月去了京都")).toBeNull();
    expect(range("2月30日在上海")).toBeNull();
    expect(range("去年春节回了老家")).toBeNull();
    expect(range("去了三个月")).toBeNull();
    expect(range("从成都到拉萨")).toBeNull();
  });

  it("uses the local calendar date, not UTC", () => {
    expect(localCalendarToday(new Date(2026, 9, 20, 23, 30))).toBe("2026-10-20");
    expect(localCalendarToday(new Date(2026, 0, 1, 0, 5))).toBe("2026-01-01");
  });
});

describe("inferJourneyDates", () => {
  it("never replaces a calendar date the reading already has", () => {
    expect(inferJourneyDates(
      [{ calendarDate: null }, { calendarDate: "2025-09-02" }],
      "上个月从成都去稻城",
      TODAY,
    )).toBeNull();
  });

  it("infers only when no day carries a calendar date", () => {
    expect(inferJourneyDates([{ calendarDate: null }], "上个月从成都去稻城", TODAY))
      .toEqual({ startDate: "2026-09-01", endDate: "2026-09-30", phrase: "上个月" });
    expect(inferJourneyDates([], "从成都去稻城", TODAY)).toBeNull();
  });
});

describe("journeySentenceToItineraryText", () => {
  it("keeps the places of a sentence in the order it names them", () => {
    const text = journeySentenceToItineraryText("上个月从成都自驾去稻城，在理塘住一晚");
    expect(text).toBe("Day 1\n成都 → 稻城 → 理塘");
    const reading = readTextItinerary(text);
    expect(reading.entries.map((entry) => entry.name)).toEqual(["成都", "稻城", "理塘"]);
    expect(reading.days[0].calendarDate).toBeNull();
    expect(reading.entries.every((entry) => entry.latitude === null)).toBe(true);
  });

  it("keeps an explicit date in the day heading as written", () => {
    const reading = readTextItinerary(journeySentenceToItineraryText("2025年10月1日从上海坐高铁到杭州"));
    expect(reading.days[0].calendarDate).toBe("2025-10-01");
    expect(reading.entries.map((entry) => entry.name)).toEqual(["上海", "杭州"]);
  });

  it("drops the particles that follow 去 and keeps a date written with 号", () => {
    expect(readTextItinerary(journeySentenceToItineraryText("国庆去了西安")).entries.map((entry) => entry.name))
      .toEqual(["西安"]);
    expect(readTextItinerary(journeySentenceToItineraryText("昨天去了趟青城山")).entries.map((entry) => entry.name))
      .toEqual(["青城山"]);
    const reading = readTextItinerary(journeySentenceToItineraryText("2025年10月1号从上海去杭州"));
    expect(reading.days[0].calendarDate).toBe("2025-10-01");
    expect(reading.entries.map((entry) => entry.name)).toEqual(["上海", "杭州"]);
  });

  it("returns a day-structured plan unchanged", () => {
    const plan = "Day 1 · 2026-03-14 · 成都\n景点 宽窄巷子";
    expect(journeySentenceToItineraryText(plan)).toBe(plan);
  });
});
