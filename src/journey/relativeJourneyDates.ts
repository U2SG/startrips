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

type DateRange = { startDate: string; endDate: string };

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
  period: (year: number) => DateRange | null,
): DateRange | null {
  const { year } = parts(today);
  const target = yearWord === "去年" ? year - 1 : year;
  let range = period(target);
  if (range && !yearWord && range.startDate > today) range = period(year - 1);
  if (!range || range.startDate > today) return null;
  return {
    startDate: range.startDate,
    endDate: range.endDate > today ? today : range.endDate,
  };
}

const MONTH_TOKEN = "(\\d{1,2}|十[一二]?|[一二三四五六七八九])";

/** One supported phrase: where it may appear and how it resolves. */
type PhraseReader = {
  pattern: RegExp;
  /** False when the words match but name no real period (13月). */
  valid?: (match: RegExpMatchArray) => boolean;
  resolve: (match: RegExpMatchArray, today: string) => DateRange | null;
};

const READERS: readonly PhraseReader[] = [
  {
    pattern: /前天|昨天/g,
    resolve: (match, today) => {
      const date = addDays(today, match[0] === "前天" ? -2 : -1);
      return { startDate: date, endDate: date };
    },
  },
  {
    pattern: /上个?周末/g,
    resolve: (_match, today) => {
      const saturday = addDays(weekStart(today), -2);
      return { startDate: saturday, endDate: addDays(saturday, 1) };
    },
  },
  {
    pattern: /上个?(?:周|星期|礼拜)(?![一二三四五六日天])/g,
    resolve: (_match, today) => {
      const monday = addDays(weekStart(today), -7);
      return { startDate: monday, endDate: addDays(monday, 6) };
    },
  },
  {
    pattern: /这周|本周|这个星期/g,
    resolve: (_match, today) => ({ startDate: weekStart(today), endDate: today }),
  },
  {
    pattern: /上个?月/g,
    resolve: (_match, today) => {
      const { year, month } = parts(today);
      const startDate = isoDate(year, month - 1, 1);
      const { year: y, month: m } = parts(startDate);
      return { startDate, endDate: lastDayOfMonth(y, m) };
    },
  },
  {
    pattern: /这个月|本月/g,
    resolve: (_match, today) => {
      const { year, month } = parts(today);
      return { startDate: isoDate(year, month, 1), endDate: today };
    },
  },
  {
    pattern: /(去年|今年)?国庆/g,
    resolve: (match, today) => inYear(today, match[1], (y) => ({
      startDate: isoDate(y, 10, 1),
      endDate: isoDate(y, 10, 7),
    })),
  },
  {
    pattern: new RegExp(`(去年|今年)?(?<!\\d年|\\d)${MONTH_TOKEN}月(?:(\\d{1,2})[日号])?`, "g"),
    valid: (match) => readMonth(match[2]) !== null,
    resolve: (match, today) => {
      const namedMonth = readMonth(match[2]) as number;
      const date = match[3] ? Number(match[3]) : null;
      return inYear(today, match[1], (y) => {
        if (date === null) return { startDate: isoDate(y, namedMonth, 1), endDate: lastDayOfMonth(y, namedMonth) };
        const single = isoDate(y, namedMonth, date);
        // 2月30日 is not a day; never roll it into March.
        return parts(single).month === namedMonth ? { startDate: single, endDate: single } : null;
      });
    },
  },
];

/** Several time phrases in one sentence: none of them is applied. */
export type AmbiguousJourneyDates = {
  /** Each distinct phrase once, in the order the sentence says them. */
  ambiguousPhrases: string[];
};

export type RelativeJourneyDatesReading = RelativeJourneyDates | AmbiguousJourneyDates;

/**
 * Every supported phrase in `text`, in source order. A phrase inside a longer
 * one (上周 in 上周末, 国庆 in 去年国庆) is the same expression, not another.
 */
function supportedPhrases(text: string) {
  const found = READERS.flatMap((reader) => [...text.matchAll(reader.pattern)]
    .filter((match) => !reader.valid || reader.valid(match))
    .map((match) => ({ reader, match, start: match.index ?? 0, end: (match.index ?? 0) + match[0].length })));
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: typeof found = [];
  for (const phrase of found) {
    if (kept.length === 0 || phrase.start >= kept[kept.length - 1].end) kept.push(phrase);
  }
  return kept;
}

/**
 * Read the supported relative phrase in `sentence`, resolved against `today`
 * (YYYY-MM-DD, the member's local date). Returns null when the sentence
 * carries a four-digit year — the source then states its own date — or when
 * no supported phrase is present. When it names more than one distinct
 * phrase (上个月 … 昨天) nothing is inferred: which one dates the Journey is
 * the member's call, so the phrases come back for the review to show.
 */
export function relativeJourneyDates(sentence: string, today: string): RelativeJourneyDatesReading | null {
  const text = sentence.replace(/\s+/g, "");
  if (/\d{4}(?:年|[-/.]\d)/.test(text)) return null;
  const phrases = supportedPhrases(text);
  const distinct = [...new Set(phrases.map(({ match }) => match[0]))];
  if (distinct.length === 0) return null;
  if (distinct.length > 1) return { ambiguousPhrases: distinct };
  const [{ reader, match }] = phrases;
  const range = reader.resolve(match, today);
  return range ? { ...range, phrase: match[0] } : null;
}

/**
 * The relative reading applies only when the reading has no calendar date at
 * all: a date the source states always wins over one inferred from today.
 */
export function inferJourneyDates(
  days: readonly { calendarDate: string | null }[],
  sentence: string,
  today: string,
): RelativeJourneyDatesReading | null {
  if (days.some((day) => day.calendarDate)) return null;
  return relativeJourneyDates(sentence, today);
}
