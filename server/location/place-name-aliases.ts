import { readFile } from "node:fs/promises";
import { isChineseRegionName } from "./chinese-region-names";
import { LocationSearchUnavailableError } from "./location-search";

/**
 * A Chinese place-name query often names a place the provider indexes only
 * under its endonym or its English name — the exonym reported in issue #296
 * being one of many such names. Instead of a hand-maintained exonym table —
 * which makes recall depend on whichever names were typed into the source
 * file — the English query is derived from
 * the checked-in place-name payload that already ships for globe labels
 * (`public/earth/cities.json`, built by `scripts/build-city-data.mjs` from
 * GeoNames alternate names plus the offline Wikidata crosswalk). That payload
 * is bounded, versioned with the repository and never fetched at runtime, and
 * it carries a Chinese display name for 12,354 of its 34,104 entries.
 *
 * Two generic morphology rules widen the payload's single display name into
 * the forms people actually type, without naming any city:
 *
 * - administrative suffixes are dropped (`纽约市` also answers `纽约`,
 *   `首尔特别市` also answers `首尔`), and
 * - a leading qualifier of any length is dropped only when that qualifier is
 *   itself the Chinese name of a country or region, so `美国檀香山` answers as
 *   `檀香山` while `不存在巴黎` and `深圳南山区` stay untouched local queries.
 *
 * Qualifier removal requires that positive evidence deliberately. Treating
 * "this prefix is not a known city" as proof of a country qualifier would let
 * any unverified prefix in front of an indexed exonym silently change which
 * place the query means, and the payload's suffix vocabulary is wide enough
 * for that to matter. The region vocabulary comes from the platform's CLDR
 * data (`./chinese-region-names`), so the payload stays the sole authority on
 * which English name a place carries and nothing here names a country either.
 */

const PAYLOAD_URL = new URL("../../public/earth/cities.json", import.meta.url);

/** Only an all-Han query can carry an exonym, so nothing else reads the payload. */
const HAN_QUERY = /^[㐀-䶿一-鿿]+$/;

/** The payload separates several Chinese display names with a fullwidth slash. */
const NAME_SEPARATOR = /[／/、]/;

/** Longest first: `特别市` must be tried before `市`. */
const ADMINISTRATIVE_SUFFIXES = [
  "特别行政区",
  "自治市",
  "特别市",
  "市区",
  "市",
  "区",
  "县",
  "州",
] as const;

/**
 * Regional transliteration variants of the same exonym. These fold Chinese to
 * Chinese only — the payload stays the single authority on which English name
 * a place carries — and exist because the payload records one spelling where
 * readers use another.
 */
const TRANSLITERATION_VARIANTS: Readonly<Record<string, string>> = {
  "迪拜": "杜拜",
  "大阪": "大坂",
};

const MIN_PLACE_NAME_LENGTH = 2;

type PayloadEntry = { n?: unknown; z?: unknown };

function englishName(entry: PayloadEntry): string {
  return typeof entry.n === "string" ? entry.n.trim() : "";
}

function chineseNames(entry: PayloadEntry): string[] {
  if (typeof entry.z !== "string") return [];
  return entry.z.split(NAME_SEPARATOR).map((name) => name.trim()).filter(Boolean);
}

function withoutAdministrativeSuffix(name: string): string {
  for (const suffix of ADMINISTRATIVE_SUFFIXES) {
    if (!name.endsWith(suffix)) continue;
    const base = name.slice(0, -suffix.length);
    return base.length >= MIN_PLACE_NAME_LENGTH ? base : "";
  }
  return "";
}

/**
 * The payload is sorted by population descending, so the first entry claiming
 * a name is the one a bare query means (`伦敦` is London, GB, not London, CA).
 * Full display names are indexed before suffix-stripped ones so an exact name
 * always beats another city's abbreviation.
 */
function buildIndex(entries: readonly PayloadEntry[]): Map<string, string> {
  const index = new Map<string, string>();
  const stripped: [string, string][] = [];
  for (const entry of entries) {
    const english = englishName(entry);
    if (!english) continue;
    for (const name of chineseNames(entry)) {
      if (!index.has(name)) index.set(name, english);
      const base = withoutAdministrativeSuffix(name);
      if (base) stripped.push([base, english]);
    }
  }
  for (const [name, english] of stripped) {
    if (!index.has(name)) index.set(name, english);
  }
  return index;
}

function parseIndex(payload: string): Map<string, string> {
  const parsed = JSON.parse(payload) as { cities?: unknown };
  if (!Array.isArray(parsed.cities)) {
    throw new Error("place-name payload has no city array");
  }
  // Keep only the index; the parsed 34k-entry array is released here.
  return buildIndex(parsed.cities as PayloadEntry[]);
}

/**
 * Whether a provider label names the same place a query asked for. `深圳市`
 * names `深圳` because the difference is an administrative suffix, while
 * `伦敦街` does not name `伦敦` and `檀香山路` does not name `檀香山` — a hit
 * that merely contains the query is a different place and must not stand in
 * for it.
 */
export function namesSamePlace(label: string, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  const candidate = label.trim();
  if (!needle || !candidate) return false;
  if (candidate.toLocaleLowerCase() === needle) return true;
  const base = withoutAdministrativeSuffix(candidate);
  return base !== "" && base.toLocaleLowerCase() === needle;
}

export type PlaceNameAliasResolver = (query: string) => Promise<string>;

export function createPlaceNameAliasResolver(
  options: { loadPayload?: () => Promise<string> } = {},
): PlaceNameAliasResolver {
  const loadPayload = options.loadPayload
    ?? (() => readFile(PAYLOAD_URL, "utf8"));
  let index: Promise<Map<string, string>> | null = null;

  const load = () => {
    if (!index) {
      index = loadPayload().then(parseIndex).catch((cause: unknown) => {
        // A failed read must not be remembered, or one transient failure would
        // disable exonym queries for the lifetime of the process.
        index = null;
        throw new LocationSearchUnavailableError(
          `Location search place-name data is unavailable: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        );
      });
    }
    return index;
  };

  const lookup = (names: Map<string, string>, name: string) => (
    names.get(name) ?? names.get(TRANSLITERATION_VARIANTS[name] ?? "") ?? ""
  );

  return async (query: string) => {
    if (!HAN_QUERY.test(query)) return query;
    const names = await load();
    const direct = lookup(names, query);
    if (direct) return direct;
    // Longest remainder first, and no cap on the qualifier beyond the query
    // itself, so a full country name (`印度尼西亚雅加达`,
    // `阿拉伯联合酋长国阿布扎比`) strips as readily as a short one
    // (`美国檀香山`). A split point only counts when the head is a country
    // or region name, so an unrecognised head (`不存在巴黎`) or a head that
    // names a city rather than a country (`西安大雁塔`, `深圳南山区`) leaves
    // the query exactly as the user typed it.
    const limit = query.length - MIN_PLACE_NAME_LENGTH;
    for (let qualifier = MIN_PLACE_NAME_LENGTH; qualifier <= limit; qualifier += 1) {
      if (!isChineseRegionName(query.slice(0, qualifier))) continue;
      const english = lookup(names, query.slice(qualifier));
      if (english) return english;
    }
    return query;
  };
}

/** Shared resolver: one parsed index per process, built on first Han query. */
export const resolveEnglishPlaceQuery: PlaceNameAliasResolver = createPlaceNameAliasResolver();
