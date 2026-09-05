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
    if (state && now - state.startedAt < this.windowMs) {
      state.count += 1;
      return state.count <= max;
    }
    // A rolled window is deleted before being re-inserted so the map's
    // insertion order stays the order the windows STARTED in, which is what
    // makes evicting its first entry an eviction of the oldest one.
    this.windows.delete(key);
    this.admit(now);
    this.windows.set(key, { startedAt: now, count: 1 });
    return 1 <= max;
  }

  /**
   * Give one charge back.
   *
   * The address budget is reserved BEFORE the handler runs — a peek would let
   * an arbitrarily large concurrent batch pass, because every request in it
   * reads the counter before any of them has charged it, which is exactly the
   * database cost this budget exists to bound. A request that then turns out
   * to hold a live grant releases its reservation here, so a recipient with a
   * real link costs nothing net.
   *
   * It decrements rather than forgetting the key: forgetting would let one
   * valid request wipe a whole window, so an attacker holding any working link
   * could interleave a real request and never accumulate a probe charge at
   * all.
   */
  release(key: string, now: number): void {
    const state = this.windows.get(key);
    if (!state || now - state.startedAt >= this.windowMs) return;
    if (state.count > 0) state.count -= 1;
  }

  /**
   * Forget `key` entirely.
   *
   * Used for a token hash that turned out not to name a grant: keeping it
   * would let anyone mint unbounded map entries out of random tokens, which is
   * exactly the memory shape the eviction below exists to bound.
   */
  forget(key: string): void {
    this.windows.delete(key);
  }

  /**
   * Make room for one new key.
   *
   * Sweeping alone is not a cap: a burst of distinct keys inside ONE window
   * leaves nothing expired to sweep, so every admission would still grow the
   * map. High-cardinality traffic on a public endpoint is exactly that shape,
   * so once the sweep has not freed anything the oldest window is evicted.
   * Insertion order is window-start order, so that is the map's first entry
   * and the eviction is O(1) rather than a scan per admission.
   */
  private admit(now: number): void {
    if (this.windows.size < this.maxKeys) return;
    this.sweep(now);
    while (this.windows.size >= this.maxKeys) {
      const oldest = this.windows.keys().next();
      if (oldest.done) return;
      this.windows.delete(oldest.value);
    }
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
 * 1. the address budget is RESERVED first, without touching the database, so a
 *    token-guessing flood is refused before it can cost a query. Reserving
 *    rather than peeking is what bounds a *concurrent* batch: every request in
 *    one batch would read an un-charged counter and pass, so a peek would cap
 *    nothing an attacker could not simply send all at once;
 * 2. the grant budget is CHARGED before the handler runs, because a budget
 *    charged afterwards cannot refuse anything;
 * 3. afterwards the reservation is RELEASED for a request that reached a live
 *    grant, and kept for one that raised `ShareAccessError` — which also
 *    un-charges the grant budget, since a token that resolved to nothing has
 *    no grant to charge and must not leave a map entry behind.
 *
 * Step 3 hangs off the THROW, not off the response. `requireActiveShareGrant`
 * raises rather than returning, and `app.ts`'s `onError` is what turns the
 * raise into the generic 404, so it happens above this middleware and
 * `context.res` never carries that answer. Inspecting the response here would
 * therefore have counted nothing at all.
 *
 * The one class that keeps its reservation is `ShareAccessError`, which is the
 * link itself being unusable. `MEDIA_UNAVAILABLE` is a returned 404 rather
 * than a throw and is released like any other success: the caller holds a
 * working link and one asset is gone, which is #200's live-scope product
 * state, not an attack. A throttled caller still learns nothing a plain
 * request would not have told it — the 429 says "you have sent too many
 * unusable tokens", never "this token exists".
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
      && !byAddress.hit(probeKey, config.unknownTokenMaxRequests, now)
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
        if (probeKey) byAddress.release(probeKey, now);
        return tooManyRequests(context, config.windowSeconds);
      }
    }

    // The token named no live grant. There is no grant to charge, and the
    // entry the grant budget just created would otherwise let anyone mint
    // unbounded map keys out of random tokens; the address reservation is KEPT,
    // because this is the one outcome the probe budget counts.
    const settle = (unusable: boolean) => {
      if (unusable) {
        if (grantKey) byGrant.forget(grantKey);
        return;
      }
      if (probeKey) byAddress.release(probeKey, Date.now());
    };

    try {
      await next();
    } catch (error) {
      settle(error instanceof ShareAccessError);
      throw error;
    }
    // Hono's own dispatch catches a handler throw and lets `app.ts`'s
    // `onError` build the response, so `await next()` above RESOLVES for the
    // generic unavailable 404 and the catch never sees it. `context.error` is
    // where the raised error is recorded in that case, and reading it is what
    // makes the probe budget count the requests it exists to count. The catch
    // is kept for a rethrow that reaches here directly.
    settle(context.error instanceof ShareAccessError);
  };
}
