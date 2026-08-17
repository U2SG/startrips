import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, Next } from "hono";

const SESSION_COOKIE_NAMES = [
  "startrips.session_token",
  "startrips-session_token",
];

export type AnonymousRateLimitConfig = {
  windowSeconds: number;
  maxRequests: number;
};

type WindowState = {
  startedAt: number;
  count: number;
};

function hasSessionCookie(context: Context): boolean {
  const header = context.req.header("cookie");
  if (!header) return false;
  return header.split(";").some((part) => {
    const name = part.split("=", 1)[0]?.trim();
    return name !== undefined && SESSION_COOKIE_NAMES.includes(name);
  });
}

function clientKey(context: Context): string | undefined {
  const forwarded = context.req.header("x-forwarded-for");
  if (forwarded) {
    const firstHop = forwarded.split(",")[0]?.trim();
    if (firstHop) return firstHop;
  }
  try {
    return getConnInfo(context).remote.address ?? undefined;
  } catch {
    // No connection info is available (for example in tests); skip limiting.
    return undefined;
  }
}

export function createAnonymousRateLimiter(
  config: AnonymousRateLimitConfig,
) {
  const windows = new Map<string, WindowState>();
  const interval = setInterval(() => {
    const cutoff = Date.now() - config.windowSeconds * 1000;
    for (const [key, state] of windows) {
      if (state.startedAt < cutoff) windows.delete(key);
    }
  }, config.windowSeconds * 1000);
  interval.unref();

  return async function anonymousRateLimit(context: Context, next: Next) {
    const path = context.req.path;
    if (
      path === "/api/health"
      || path.startsWith("/api/auth")
      || hasSessionCookie(context)
    ) {
      return next();
    }

    const key = clientKey(context);
    if (key === undefined) return next();

    const now = Date.now();
    const state = windows.get(key);
    if (!state || now - state.startedAt >= config.windowSeconds * 1000) {
      windows.set(key, { startedAt: now, count: 1 });
      return next();
    }
    state.count += 1;
    if (state.count <= config.maxRequests) return next();

    context.header("Retry-After", String(config.windowSeconds));
    return context.json(
      { error: "RATE_LIMITED", message: "Too many requests" },
      429,
    );
  };
}
