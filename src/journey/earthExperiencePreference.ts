/**
 * #387: the durable contract for the Earth experience preference.
 *
 * `particle-only` is a personal, account-scoped choice about which renderers
 * this person's Startrips may load at all. It is deliberately NOT Atlas state:
 * an Atlas is shared by its members, and one member choosing to stay on the
 * particle Earth must not decide what the other members' machines render.
 *
 * The values live here rather than in `src/scene/earthDive.ts` so the server
 * can validate a persisted value without importing a renderer module, while
 * `EarthExperiencePolicy` in that file stays the same two-member union by
 * aliasing this one. One source of truth, so a value the API accepts can never
 * drift from a value the Dive controller understands.
 */
export type EarthExperiencePreference = "default" | "particle-only";

/** Every accepted value, in the order the contract documents them. */
export const EARTH_EXPERIENCE_PREFERENCES: readonly EarthExperiencePreference[] = [
  "default",
  "particle-only",
];

/**
 * What a person has when nothing was ever stored for them.
 *
 * Absence is not an error and is not a row: a person who never expressed a
 * preference reads `default`, exactly like a person who explicitly chose it.
 */
export const DEFAULT_EARTH_EXPERIENCE: EarthExperiencePreference = "default";

/**
 * Fail-closed value validation. An unknown string, a number, `null`, a
 * trimmed-looking variant or a casing variant is not a preference — nothing
 * here normalizes, because a client that sends `Particle-Only` has a bug the
 * API should report rather than silently interpret.
 */
export function isEarthExperiencePreference(
  value: unknown,
): value is EarthExperiencePreference {
  return (
    typeof value === "string"
    && (EARTH_EXPERIENCE_PREFERENCES as readonly string[]).includes(value)
  );
}
