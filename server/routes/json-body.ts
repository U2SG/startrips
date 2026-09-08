/**
 * One guard for every JSON-accepting route, so an unusable body always leaves
 * by the route's own 400 envelope.
 *
 * Two failures used to escape a route. A syntactically malformed document made
 * `context.req.json()` throw a `SyntaxError`, which the global `onError` turned
 * into a generic `INVALID_JSON` 400 from outside the route, telling a client
 * that its body never reached the handler. And a well-formed document is not
 * necessarily an object: `null`, a number, a string and an array all parse
 * without a `SyntaxError`, so a route that read a property straight off the
 * parsed body either threw a `TypeError` on `null` (a 500) or silently read
 * `undefined` off a string and treated it as an omitted field.
 *
 * Answering `null` to all of it makes malformed, non-object and
 * well-shaped-but-invalid bodies indistinguishable to the client on a given
 * route, so a caller learns only that the body was unusable.
 *
 * Arrays are refused with the other non-objects. Every parser here reads named
 * properties, and an array yields `undefined` for all of them — which most
 * parsers reject anyway, but which `PATCH /api/journeys/:id/cover` would have
 * read as a deliberate request to clear the cover.
 *
 * The read is a thunk rather than a `Request` so a route keeps using Hono's
 * cached `context.req.json()` behind the body-limit middleware, while a unit
 * test can hand in a plain `Request`. `readShareInput` in `shares.ts` follows
 * the same shape and keeps its own copy for now.
 */
export async function readJsonObject(
  read: () => Promise<unknown>,
): Promise<Record<string, unknown> | null> {
  let parsed: unknown;
  try {
    parsed = await read();
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}
