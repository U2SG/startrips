import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, Next } from "hono";
import {
  ShareAccessError,
  hashShareToken,
  parseBearerToken,
} from "./authorization/share-access";

/**
 * Abuse control for the guest share prefix, and only for it.
 *
 * #217 removed the blanket per-IP `/api/*` bucket, and its ledger says why a
 * replacement must not restore one: a limit belongs to an endpoint's own cost
 * and threat model, not to the whole API. This middleware is mounted on
 * `sharedRoutes` alone, so ordinary product traffic keeps the unthrottled
 * behaviour `server/app-global-rate-limit.test.ts` pins.
 *
 * #200 names three classes to limit, and they have three different subjects:
 *
 * - **share token resolution** — the guest data reads. The subject is the
 *   grant, not the recipient: a link forwarded to a family group is many
 *   addresses holding one capability, and limiting them by address would
 *   throttle exactly the sharing the feature exists for.
 * - **guest media read-URL issuance** — the same subject with its own budget,
 *   because one open Journey issues an order of magnitude more media reads
 *   than data reads, and a shared budget would let a photo-heavy Journey
 *   starve its own payload refresh.
 * - **repeated invalid-token requests** — there is no grant to charge, so the
 *   subject is the caller. This is the only class whose volume an attacker
 *   chooses, and it is the one that must not be dodged by rotating the token,
 *   so it is keyed by address.
 *
 * The grant-keyed classes are keyed by the token's SHA-256 hash, the same
 * value already stored at rest. The raw token is never a map key, never a log
 * field, and never leaves the request.
 */

/** How the three budgets are configured: one window, three ceilings. */
export type ShareRateLimitConfig = {
  windowSeconds: number;
  /** Guest data reads per grant per window. */
  dataMaxRequests: number;
  /** Guest media read-URL issuances per grant per window. */
  mediaMaxRequests: number;
  /** Unusable-token requests per client address per window. */
  unknownTokenMaxRequests: number;
};

type WindowState = { startedAt: number; count: number };

/**
 * A fixed window that prunes as it rolls.
 *
 * There is no timer and no reconciler: an expired entry is dropped when its
 * own key is next touched, and `sweep` walks the map only once it has grown
 * past `maxKeys`, so the cost is amortised over the requests that caused the
 * growth. The address-keyed map is the one an attacker can inflate, and this
 * is what bounds it.
 */
export class FixedWindowCounter {
  private readonly windows = new Map<string, WindowState>();

  constructor(
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  /** Count one request for `key`; true when it is still inside the budget. */
  hit(key: string, max: number, now: number): boolean {
    const state = this.windows.get(key);
    if (!state || now - state.startedAt >= this.windowMs) {
      if (this.windows.size >= this.maxKeys) this.sweep(now);
      this.windows.set(key, { startedAt: now, count: 1 });
      return 1 <= max;
    }
    state.count += 1;
    return state.count <= max;
  }

  /**
   * Whether `key` has ALREADY spent its budget, without charging a request.
   *
   * The address budget is read this way before the handler runs and charged
   * only afterwards, and only for a request that turned out to be unusable.
   * A peek-then-charge-on-failure shape is what keeps a recipient who holds a
   * real link from ever spending the probe budget, without letting one valid
   * request reset a flood of invalid ones.
   */
  exceeded(key: string, max: number, now: number): boolean {
    const state = this.windows.get(key);
    if (!state || now - state.startedAt >= this.windowMs) return false;
    return state.count >= max;
  }

  /**
   * Forget `key` entirely.
   *
   * Used for a token hash that turned out not to name a grant: keeping it
   * would let anyone mint unbounded map entries out of random tokens, which is
   * exactly the memory shape the address-keyed budget exists to bound.
   */
  forget(key: string): void {
    this.windows.delete(key);
  }

  private sweep(now: number): void {
    for (const [key, state] of this.windows) {
      if (now - state.startedAt >= this.windowMs) this.windows.delete(key);
    }
  }
}

/**
 * The caller's address, or `undefined` when it cannot be determined.
 *
 * `x-forwarded-for` is trusted because every public request terminates at the
 * deployment stack's Caddy, which sets it; a direct connection falls back to
 * the socket address. When neither is available the address budget is skipped
 * rather than collapsing every caller onto one shared key, which would turn
 * the limiter into an outage.
 */
export function clientAddress(context: Context): string | undefined {
  const forwarded = context.req.header("x-forwarded-for");
  if (forwarded) {
    const firstHop = forwarded.split(",")[0]?.trim();
    if (firstHop) return firstHop;
  }
  try {
    return getConnInfo(context).remote.address ?? undefined;
  } catch {
    return undefined;
  }
}

/** Media read-URL issuance is the one guest route with its own budget. */
export function isMediaReadPath(path: string): boolean {
  return path.endsWith("/read-url");
}

/**
 * `429` with the same envelope every other failure uses, plus `Retry-After` so
 * a well-behaved client waits instead of tightening its loop.
 */
function tooManyRequests(context: Context, windowSeconds: number) {
  context.header("Retry-After", String(windowSeconds));
  return context.json(
    { error: "RATE_LIMITED", message: "Too many requests" },
    429,
  );
}

/**
 * Build the guest limiter.
 *
 * The order is the design:
 *
 * 1. the address budget is READ first, without touching the database, so a
 *    token-guessing flood is refused before it can cost a query;
 * 2. the grant budget is CHARGED before the handler runs, because a budget
 *    charged afterwards cannot refuse anything;
 * 3. a `ShareAccessError` out of the handler charges the address budget and
 *    un-charges the grant budget, since a token that resolved to nothing has
 *    no grant to charge and must not leave a map entry behind.
 *
 * Step 3 hangs off the THROW, not off the response. `requireActiveShareGrant`
 * raises rather than returning, and `app.ts`'s `onError` is what turns the
 * raise into the generic 404, so it happens above this middleware and
 * `context.res` never carries that answer. Inspecting the response here would
 * therefore have counted nothing at all.
 *
 * The one class it charges is `ShareAccessError`, which is the link itself
 * being unusable. `MEDIA_UNAVAILABLE` is a returned 404 rather than a throw
 * and deliberately costs nothing: the caller holds a working link and one
 * asset is gone, which is #200's live-scope product state, not an attack. A
 * throttled caller still learns nothing a plain request would not have told
 * it — the 429 says "you have sent too many unusable tokens", never "this
 * token exists".
 */
export function createShareRateLimiter(config: ShareRateLimitConfig) {
  const windowMs = config.windowSeconds * 1000;
  const byGrant = new FixedWindowCounter(windowMs);
  const byAddress = new FixedWindowCounter(windowMs);

  return async function shareRateLimit(context: Context, next: Next) {
    const now = Date.now();
    const address = clientAddress(context);
    const probeKey = address === undefined ? null : `probe:${address}`;
    if (
      probeKey
      && byAddress.exceeded(probeKey, config.unknownTokenMaxRequests, now)
    ) {
      return tooManyRequests(context, config.windowSeconds);
    }

    const rawToken = parseBearerToken(context.req.header("authorization"));
    // No bearer at all is unusable by definition, and the route answers the
    // generic unavailable body for it. There is no grant budget to charge, so
    // it falls straight through to the post-handler charge below.
    const grantKey = rawToken === null
      ? null
      : `${isMediaReadPath(context.req.path) ? "media" : "data"}:${
        hashShareToken(rawToken)
      }`;
    if (grantKey) {
      const max = grantKey.startsWith("media:")
        ? config.mediaMaxRequests
        : config.dataMaxRequests;
      if (!byGrant.hit(grantKey, max, now)) {
        return tooManyRequests(context, config.windowSeconds);
      }
    }

    try {
      await next();
    } catch (error) {
      if (error instanceof ShareAccessError) {
        // The token named no live grant, so there is no grant to charge and
        // the entry it just created would otherwise let anyone mint unbounded
        // map keys out of random tokens.
        if (grantKey) byGrant.forget(grantKey);
        if (probeKey) {
          byAddress.hit(probeKey, config.unknownTokenMaxRequests, Date.now());
        }
      }
      throw error;
    }
  };
}
