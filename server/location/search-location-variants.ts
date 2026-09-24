import { namesSamePlace } from "./place-name-aliases";
import type { LocationSearch, LocationSearchResult } from "./location-search";

type SearchHints = {
  aliases: readonly string[];
  searchArea: string;
  countryCode: string;
};

function key(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function contextNamesArea(context: string, area: string) {
  const locality = key(area);
  return context.split(",").some((part) => {
    const component = key(part);
    return component === locality
      || (/\p{Script=Han}/u.test(part) && component.includes(locality));
  });
}

/** Keep one search order when the same known names arrive as q or aliases. */
function searchNames(query: string, aliases: readonly string[]) {
  return [...new Map(
    [query, ...aliases]
      .map((name) => name.trim().replace(/\s+/g, " "))
      .filter((name) => name.length >= 2 && name.length <= 120)
      .map((name) => [key(name), name] as const),
  ).values()].sort((left, right) => {
    const leftAscii = /^[\x20-\x7e]+$/.test(left);
    const rightAscii = /^[\x20-\x7e]+$/.test(right);
    return Number(rightAscii) - Number(leftAscii)
      || right.length - left.length
      || key(left).localeCompare(key(right));
  });
}

function namesOneOf(result: LocationSearchResult, names: readonly string[]) {
  return [result.label, result.labelEnglish, result.labelLocal].some((label) =>
    label && names.some((name) => namesSamePlace(label, name))
  );
}

function countryMatches(result: LocationSearchResult, countryCode: string) {
  return !countryCode || result.countryCode === countryCode
    || (result.countryCode === "CN" && countryCode === "HK"
      && /香港|Hong Kong/i.test(`${result.label} ${result.context}`))
    || (result.countryCode === "CN" && countryCode === "MO"
      && /澳门|澳門|Macau|Macao/i.test(`${result.label} ${result.context}`));
}

/**
 * A model-proposed alias may help the provider find a place, but only the
 * provider's own name, country and locality can end an automatic lookup.
 * Results always retain their provider-supplied coordinates and labels.
 */
export async function searchLocationVariants(
  search: LocationSearch,
  query: string,
  options: { limit: number; signal?: AbortSignal },
  hints: SearchHints,
): Promise<LocationSearchResult[]> {
  const names = searchNames(query, hints.aliases);
  const area = hints.searchArea.split(",")[0]?.trim() ?? "";
  const queries = [...new Map(names.flatMap((name) => {
    const variants = area && key(name) !== key(area)
      ? [`${name} ${area}`, name]
      : [name];
    return variants.map((variant) => [key(variant), variant] as const);
  })).values()];
  const fallback = new Map<string, LocationSearchResult>();

  for (const variant of queries) {
    const results = await search.search(variant, options);
    const matches = results.filter((result) =>
      namesOneOf(result, names)
      && countryMatches(result, hints.countryCode)
      && (!area || contextNamesArea(result.context, area))
    );
    if (matches.length > 0) return results;
    results.forEach((result) => {
      if (!fallback.has(result.id)) fallback.set(result.id, result);
    });
  }
  return [...fallback.values()].slice(0, options.limit);
}
