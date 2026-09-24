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

/** A whole-plan review may identify an exact named place whose map record only
 * carries a neighbouring town or a county. Accept that choice within the
 * stated state only when the provider itself uses a distinctive known name. */
export function itineraryReviewedPlaceSuggestion(
  entry: ItineraryEntryDraft,
  chosen: LocationSearchResult,
  results: readonly LocationSearchResult[],
): LocationSearchResult | null {
  const statePart = entry.searchArea?.split(",")[1]?.trim() ?? "";
  const state = nameKey(statePart);
  if (!entry.countryCode || !state || /[/;]/.test(statePart)
    || entry.flags.includes("source-invalid") || entry.flags.includes("truncated")) return null;
  const names = new Set([entry.name, ...entry.aliases]
    .map(nameKey).filter((name) => name.split(" ").length >= 3));
  if (names.size === 0) return null;
  if (chosen.countryCode !== entry.countryCode
    || !contextNamesLocality(chosen.context, state)
    || ![chosen.label, chosen.labelEnglish, chosen.labelLocal]
      .some((label) => label && names.has(nameKey(label)))) return null;
  const matches = results.filter((result) =>
    result.countryCode === entry.countryCode
    && contextNamesLocality(result.context, state)
    && [result.label, result.labelEnglish, result.labelLocal]
      .some((label) => label && names.has(nameKey(label)))
  );
  if (!matches.some((result) => result.id === chosen.id)) return null;
  if (matches.some((result) =>
    Math.abs(result.latitude - chosen.latitude) > 0.05
    || Math.abs(result.longitude - chosen.longitude) > 0.05
  )) return null;
  return chosen;
}

/** A model-corrected, distinctive name may identify a rural POI whose map data
 * records only county and state. Require one exact provider name in the stated
 * state and country; generic or duplicate names still need a member's choice. */
export function itineraryCorrectedLocationSuggestion(
  entry: ItineraryEntryDraft,
  correctedQuery: string,
  results: readonly LocationSearchResult[],
): LocationSearchResult | null {
  const namedEntry = { ...entry, aliases: [...entry.aliases, correctedQuery] };
  const strict = itineraryLocationSuggestion(namedEntry, results);
  if (strict) return strict;
  const state = nameKey(entry.searchArea?.split(",")[1] ?? "");
  const correctedName = nameKey(correctedQuery);
  if (!entry.countryCode || !state || correctedName.split(" ").length < 3
    || entry.flags.includes("source-invalid") || entry.flags.includes("truncated")) return null;
  const matches = results.filter((result) =>
    result.countryCode === entry.countryCode
    && contextNamesLocality(result.context, state)
    && [result.label, result.labelEnglish, result.labelLocal]
      .some((label) => label && nameKey(label) === correctedName)
  );
  return matches.length === 1 ? matches[0] : null;
}

/** Show a source name beside provider names only after the strict match agrees. */
export function itineraryLocationDisplayNames(
  entry: ItineraryEntryDraft,
  result: LocationSearchResult,
): string[] {
  const verified = Boolean(itineraryLocationSuggestion(entry, [result]));
  const verifiedSourceName = verified ? entry.name : "";
  const names = [verifiedSourceName, result.label, result.labelLocal, result.labelEnglish]
    .filter((name): name is string => Boolean(name));
  const displayNames = [...new Map(names.map((name) => [nameKey(name), name] as const)).values()];
  if (verified && !names.some((name) => /\p{Script=Han}/u.test(name))) {
    const chineseAlias = entry.aliases.find((alias) => /\p{Script=Han}/u.test(alias));
    if (chineseAlias) displayNames.push(`中文参考名：${chineseAlias}`);
  }
  return displayNames;
}
