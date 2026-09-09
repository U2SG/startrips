/**
 * The bounded country and region vocabulary that qualifier stripping is
 * allowed to remove, taken from the platform's own CLDR region display names
 * rather than from a table in this repository. `Intl.DisplayNames` with
 * `type: "region"` answers the ~260 ISO 3166-1 regions Node ships, so the
 * qualifier vocabulary is a closed standards-maintained set — never the
 * absence of a name from the city payload, which would let an arbitrary
 * unverified prefix change which place a query means.
 */

const HAN_NAME = /^[㐀-䶿一-鿿]+$/;

const CODE_POINT_A = 65;
const CODE_POINT_Z = 90;

function collectRegionNames(): Set<string> {
  const names = new Set<string>();
  let display: Intl.DisplayNames;
  try {
    display = new Intl.DisplayNames(["zh-Hans"], {
      type: "region",
      fallback: "none",
    });
  } catch {
    return names;
  }
  for (let first = CODE_POINT_A; first <= CODE_POINT_Z; first += 1) {
    for (let second = CODE_POINT_A; second <= CODE_POINT_Z; second += 1) {
      const code = String.fromCharCode(first, second);
      let name: string | undefined;
      try {
        name = display.of(code);
      } catch {
        continue;
      }
      // `fallback: "none"` returns undefined for an unassigned code, and a
      // locale without Chinese region data returns the code itself; both are
      // excluded by requiring an all-Han name.
      if (!name || !HAN_NAME.test(name)) continue;
      names.add(name);
    }
  }
  return names;
}

let cached: Set<string> | null = null;

/**
 * Chinese display names of every region the platform knows, built once per
 * process. Empty only where the runtime carries no Chinese region data, in
 * which case no qualifier is ever stripped — narrower recall, never a
 * different place.
 */
export function chineseRegionNames(): ReadonlySet<string> {
  if (!cached) cached = collectRegionNames();
  return cached;
}

export function isChineseRegionName(value: string): boolean {
  return chineseRegionNames().has(value);
}
