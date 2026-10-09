import { auth } from "../auth";

/**
 * The session as the database holds it now, bypassing the signed session
 * cookie cache (`session.cookieCache` in `server/auth.ts`).
 *
 * Identity-sensitive routes — account identities, password change and
 * enrollment, email change — must use this rather than `auth.api.getSession`.
 * A cached copy can outlive a revocation (sign-out elsewhere, password reset)
 * by up to the cache's `maxAge`, which is acceptable for reading an Atlas but
 * not for changing how someone signs in.
 */
export async function getAuthoritativeSession(headers: Headers) {
  return await auth.api.getSession({
    headers,
    query: { disableCookieCache: true },
  });
}
