import type { Context, Next } from "hono";
import { matchedRoutes } from "hono/route";

/** Logged in place of a route pattern when no route handler matched. */
export const UNMATCHED_ROUTE = "<unmatched>";

/**
 * The registered pattern of the route handler that answered this request.
 *
 * Request paths carry credentials: Better Auth mails
 * `/api/auth/reset-password/<token>`, so logging `context.req.path` writes a
 * live token to disk. A registered pattern keeps the endpoint identifiable
 * while every variable segment stays out of the log, which removes the whole
 * class instead of denylisting individual secret names.
 *
 * `matchedRoutes` lists the matched middleware and handlers in registration
 * order. Middleware takes `(context, next)` while a route handler takes only
 * the context, which is how Hono's own `matchedRoutes` example tells the two
 * apart, so the last arity-1 entry is the handler that responded. Scanning
 * backwards also keeps the endpoint pattern when middleware short-circuits
 * (for example a 413 or 429 answered before the handler runs). A request that
 * matched middleware only was answered by `notFound`, and reports the
 * placeholder rather than its unrouted raw path.
 */
export function matchedRoutePattern(context: Context): string {
  const routes = matchedRoutes(context);
  for (let index = routes.length - 1; index >= 0; index -= 1) {
    const route = routes[index];
    if (route.handler.length < 2) return route.path;
  }
  return UNMATCHED_ROUTE;
}

export async function requestLog(context: Context, next: Next) {
  const started = performance.now();
  let failed = false;
  try {
    await next();
  } catch (error) {
    failed = true;
    console.error(
      `${context.req.method} ${matchedRoutePattern(context)} failed`,
      error instanceof Error ? error.message : "unknown error",
    );
    throw error;
  } finally {
    if (!failed) {
      console.info(
        `${context.req.method} ${matchedRoutePattern(context)} `
        + `${context.res.status} `
        + `${Math.round(performance.now() - started)}ms`,
      );
    }
  }
}
