import type { ItineraryEntryDraft } from "./itineraryImport";
import type { LocationSearchResult } from "./types";

function nameKey(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function contextNamesLocality(context: string, locality: string) {
  return context.split(",").some((part) => {
    const component = nameKey(part);
    return component === locality
      || (/\p{Script=Han}/u.test(part) && component.includes(locality));
  });
}

/**
 * A proposal can be accepted together with other proposals only when the
 * provider independently agrees on the place name, country and locality. A
 * model can suggest search terms, but never supplies the coordinates.
 * Several same-name places in different parts of that country stay ambiguous.
 */
export function itineraryLocationSuggestion(
  entry: ItineraryEntryDraft,
  results: readonly LocationSearchResult[],
): LocationSearchResult | null {
  const locality = nameKey(entry.searchArea?.split(",")[0] ?? "");
  if (!entry.countryCode || !locality
    || entry.flags.includes("source-invalid") || entry.flags.includes("truncated")) {
    return null;
  }
  const names = new Set([entry.name, ...entry.aliases].map(nameKey).filter(Boolean));
  const matches = results.filter((result) =>
    (
      result.countryCode === entry.countryCode
      // OSM can classify a Hong Kong/Macau POI under CN even when the
      // recogniser correctly uses the territory's own ISO code.
      || (result.countryCode === "CN" && entry.countryCode === "HK"
        && /香港|Hong Kong/i.test(`${result.label} ${result.context}`))
      || (result.countryCode === "CN" && entry.countryCode === "MO"
        && /澳门|澳門|Macau|Macao/i.test(`${result.label} ${result.context}`))
    )
    && contextNamesLocality(result.context, locality)
    && [result.label, result.labelEnglish, result.labelLocal]
      .some((label) => label && names.has(nameKey(label)))
  );
  if (matches.length === 0) return null;
  const first = matches[0];
  if (matches.some((result) =>
    Math.abs(result.latitude - first.latitude) > 0.05
    || Math.abs(result.longitude - first.longitude) > 0.05
  )) return null;
  return first;
}

/** Show a source name beside provider names only after the strict match agrees. */
export function itineraryLocationDisplayNames(
  entry: ItineraryEntryDraft,
  result: LocationSearchResult,
): string[] {
  const verifiedSourceName = itineraryLocationSuggestion(entry, [result])
    ? entry.name : "";
  const names = [verifiedSourceName, result.label, result.labelLocal, result.labelEnglish]
    .filter((name): name is string => Boolean(name));
  return [...new Map(names.map((name) => [nameKey(name), name] as const)).values()];
}
