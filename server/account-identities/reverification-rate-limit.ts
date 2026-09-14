import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { rateLimit } from "../db/auth-schema";
import { db } from "../db/client";

export const ACCOUNT_IDENTITY_REVERIFY_RATE_LIMIT_WINDOW_SECONDS = 60;
export const ACCOUNT_IDENTITY_REVERIFY_RATE_LIMIT_MAX = 10;
export const ACCOUNT_IDENTITY_REVERIFY_RATE_LIMIT_PREFIX = "startrips:identity-reverify";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type PasswordReverificationRateLimitSubject = {
  userId: string;
  sessionId: string;
  address?: string;
};

export type PasswordReverificationRateLimitDecision = {
  allowed: boolean;
  retryAfterSeconds: number;
};

function subjectKeys(subject: PasswordReverificationRateLimitSubject): string[] {
  const keys = [
    `${ACCOUNT_IDENTITY_REVERIFY_RATE_LIMIT_PREFIX}:user:${subject.userId}`,
    `${ACCOUNT_IDENTITY_REVERIFY_RATE_LIMIT_PREFIX}:session:${subject.sessionId}`,
  ];
  if (subject.address) {
    keys.push(`${ACCOUNT_IDENTITY_REVERIFY_RATE_LIMIT_PREFIX}:address:${subject.address}`);
  }
  return keys;
}

async function consumeKey(
  transaction: Transaction,
  key: string,
  now: number,
): Promise<PasswordReverificationRateLimitDecision> {
  // Better Auth 1.6.23 stores its own endpoint budgets in this same table. A
  // private prefix keeps the keyspace disjoint while reusing the durable,
  // cross-process store. The transaction advisory lock makes read/decide/write
  // atomic for one subject without changing Better Auth's generated schema.
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
  );

  const [existing] = await transaction
    .select({
      id: rateLimit.id,
      count: rateLimit.count,
      lastRequest: rateLimit.lastRequest,
    })
    .from(rateLimit)
    .where(eq(rateLimit.key, key))
    .limit(1);

  const windowMs = ACCOUNT_IDENTITY_REVERIFY_RATE_LIMIT_WINDOW_SECONDS * 1000;
  if (!existing) {
    await transaction.insert(rateLimit).values({
      id: randomUUID(),
      key,
      count: 1,
      lastRequest: now,
    });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  if (now - existing.lastRequest >= windowMs) {
    await transaction
      .update(rateLimit)
      .set({ count: 1, lastRequest: now })
      .where(eq(rateLimit.id, existing.id));
    return { allowed: true, retryAfterSeconds: 0 };
  }

  if (existing.count >= ACCOUNT_IDENTITY_REVERIFY_RATE_LIMIT_MAX) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((existing.lastRequest + windowMs - now) / 1000),
      ),
    };
  }

  await transaction
    .update(rateLimit)
    .set({ count: existing.count + 1, lastRequest: now })
    .where(eq(rateLimit.id, existing.id));
  return { allowed: true, retryAfterSeconds: 0 };
}

/**
 * Reserve one password-verification attempt against all stable attacker
 * dimensions before touching the password oracle: stable user, current
 * session, and client address when the deployment can resolve one.
 *
 * A denial is still committed rather than thrown, so the successful bucket
 * charges from the same request are not rolled back and a caller cannot evade
 * one dimension by intentionally exhausting another.
 */
export async function consumePasswordReverificationBudget(
  subject: PasswordReverificationRateLimitSubject,
  now = Date.now(),
): Promise<PasswordReverificationRateLimitDecision> {
  return await db.transaction(async (transaction) => {
    let allowed = true;
    let retryAfterSeconds = 0;
    for (const key of subjectKeys(subject)) {
      const decision = await consumeKey(transaction, key, now);
      if (!decision.allowed) {
        allowed = false;
        retryAfterSeconds = Math.max(retryAfterSeconds, decision.retryAfterSeconds);
      }
    }
    return { allowed, retryAfterSeconds };
  });
}
