/**
 * Dates a one-sentence Journey description states relative to today.
 *
 * The recognition bridge is told never to infer a year from today, so a
 * sentence like 「上个月从成都去稻城」 reaches the review without a calendar
 * date. This reader resolves a small, fixed set of Chinese relative phrases
 * against the browser's local "today" and nothing else. Every result is a
 * suggestion the member sees as 按今天推算 and may edit; it is never applied
 * over a date the source states, and a phrase that could mean several ranges
 * (春节, a bare 去年) is not read at all.
 */

export type RelativeJourneyDates = {
  startDate: string;
  endDate: string;
  /** The words the dates were read from, shown back to the member. */
  phrase: string;
};

/** The browser's local calendar date; `toISOString` would give UTC's. */
export function localCalendarToday(now = new Date()): string {
  return isoDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

function isoDate(year: number, month: number, day: number) {
  const value = new Date(Date.UTC(year, month - 1, day));
  return value.toISOString().slice(0, 10);
}

function parts(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return { year, month, day };
}

function addDays(date: string, days: number) {
  const { year, month, day } = parts(date);
  return isoDate(year, month, day + days);
}

function lastDayOfMonth(year: number, month: number) {
  return isoDate(year, month + 1, 0);
}

/** Monday of the week `date` falls in; weeks start on Monday. */
function weekStart(date: string) {
  const { year, month, day } = parts(date);
  const weekday = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
  return addDays(date, -weekday);
}

const CHINESE_MONTHS: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6,
  七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12,
};

function readMonth(token: string) {
  const month = /^\d+$/.test(token) ? Number(token) : CHINESE_MONTHS[token];
  return month >= 1 && month <= 12 ? month : null;
}

/**
 * Resolve a period in a named or implied year.
 *
 * 去年 / 今年 name the year; with neither, the latest occurrence not after
 * today is meant — a Journey is a record of travel that already happened. A
 * period still under way ends today, and one that has not begun is unread.
 */
function inYear(
  today: string,
  yearWord: string | undefined,
  period: (year: number) => { startDate: string; endDate: string } | null,
  phrase: string,
): RelativeJourneyDates | null {
  const { year } = parts(today);
  const target = yearWord === "去年" ? year - 1 : year;
  let range = period(target);
  if (range && !yearWord && range.startDate > today) range = period(year - 1);
  if (!range || range.startDate > today) return null;
  return {
    startDate: range.startDate,
    endDate: range.endDate > today ? today : range.endDate,
    phrase,
  };
}

const MONTH_TOKEN = "(\\d{1,2}|十[一二]?|[一二三四五六七八九])";

/**
 * Read the first supported relative phrase in `sentence`, resolved against
 * `today` (YYYY-MM-DD, the member's local date). Returns null when the
 * sentence carries a four-digit year — the source then states its own date —
 * or when no supported phrase is present.
 */
export function relativeJourneyDates(sentence: string, today: string): RelativeJourneyDates | null {
  const text = sentence.replace(/\s+/g, "");
  if (/\d{4}(?:年|[-/.]\d)/.test(text)) return null;
  const { year, month } = parts(today);

  const day = text.match(/前天|昨天/);
  if (day) {
    const date = addDays(today, day[0] === "前天" ? -2 : -1);
    return { startDate: date, endDate: date, phrase: day[0] };
  }

  const weekend = text.match(/上个?周末/);
  if (weekend) {
    const saturday = addDays(weekStart(today), -2);
    return { startDate: saturday, endDate: addDays(saturday, 1), phrase: weekend[0] };
  }

  const lastWeek = text.match(/上个?(?:周|星期|礼拜)(?![一二三四五六日天])/);
  if (lastWeek) {
    const monday = addDays(weekStart(today), -7);
    return { startDate: monday, endDate: addDays(monday, 6), phrase: lastWeek[0] };
  }

  const thisWeek = text.match(/这周|本周|这个星期/);
  if (thisWeek) return { startDate: weekStart(today), endDate: today, phrase: thisWeek[0] };

  const lastMonth = text.match(/上个?月/);
  if (lastMonth) {
    const startDate = isoDate(year, month - 1, 1);
    const { year: y, month: m } = parts(startDate);
    return { startDate, endDate: lastDayOfMonth(y, m), phrase: lastMonth[0] };
  }

  const thisMonth = text.match(/这个月|本月/);
  if (thisMonth) return { startDate: isoDate(year, month, 1), endDate: today, phrase: thisMonth[0] };

  const holiday = text.match(/(去年|今年)?国庆/);
  if (holiday) {
    return inYear(today, holiday[1], (y) => ({
      startDate: isoDate(y, 10, 1),
      endDate: isoDate(y, 10, 7),
    }), holiday[0]);
  }

  const named = text.match(new RegExp(`(去年|今年)?(?<!\\d年|\\d)${MONTH_TOKEN}月(?:(\\d{1,2})[日号])?`));
  if (named) {
    const namedMonth = readMonth(named[2]);
    if (namedMonth === null) return null;
    const date = named[3] ? Number(named[3]) : null;
    return inYear(today, named[1], (y) => {
      if (date === null) return { startDate: isoDate(y, namedMonth, 1), endDate: lastDayOfMonth(y, namedMonth) };
      const single = isoDate(y, namedMonth, date);
      // 2月30日 is not a day; never roll it into March.
      return parts(single).month === namedMonth ? { startDate: single, endDate: single } : null;
    }, named[0]);
  }

  return null;
}

/**
 * The relative reading applies only when the reading has no calendar date at
 * all: a date the source states always wins over one inferred from today.
 */
export function inferJourneyDates(
  days: readonly { calendarDate: string | null }[],
  sentence: string,
  today: string,
): RelativeJourneyDates | null {
  if (days.some((day) => day.calendarDate)) return null;
  return relativeJourneyDates(sentence, today);
}
