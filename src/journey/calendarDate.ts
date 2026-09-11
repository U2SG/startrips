/**
 * Fixed-width ISO calendar dates that are safe to persist in PostgreSQL `date`.
 *
 * JavaScript accepts and round-trips year zero, but PostgreSQL `date` has no
 * year zero. Keep the storage-domain rule here so client and server validators
 * cannot drift on a value that would otherwise pass request validation and
 * fail later at the database boundary.
 *
 * This is intentionally not a product year-range policy: `0001-01-01` and
 * `9999-12-31` remain valid. Callers that need different temporal semantics
 * must layer those rules separately.
 */
export function isPersistedCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  if (value.startsWith("0000-")) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf())
    && parsed.toISOString().slice(0, 10) === value;
}
