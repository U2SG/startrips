import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  accountIdentityActions,
  accountIdentityAudit,
  accountIdentityOwnerships,
} from "../db/app-schema";
import { account as authAccount, user as authUser } from "../db/auth-schema";
import { db } from "../db/client";
import {
  buildIdentityMethods,
  hasUsableLoginAfterRemoval,
  type AccountIdentityAccount,
  type AccountIdentityMethod,
  type AccountIdentityOwnership,
} from "./identity-policy";
import type { ProviderIdentityProof } from "./provider-proof";

export const IDENTITY_REVERIFY_TTL_MS = 5 * 60 * 1000;
export const IDENTITY_LINK_INTENT_TTL_MS = 10 * 60 * 1000;

export type AccountIdentityErrorCode =
  | "IDENTITY_ACTION_INVALID"
  | "IDENTITY_ACTION_EXPIRED"
  | "IDENTITY_ACTION_REPLAYED"
  | "IDENTITY_ACTION_SESSION_CHANGED"
  | "IDENTITY_PROVIDER_MISMATCH"
  | "IDENTITY_ALREADY_OWNED"
  | "IDENTITY_ACCOUNT_NOT_FOUND"
  | "IDENTITY_LAST_USABLE_LOGIN"
  | "IDENTITY_PROVIDER_NOT_CONFIGURED";

export class AccountIdentityError extends Error {
  constructor(readonly code: AccountIdentityErrorCode) {
    super(code);
    this.name = "AccountIdentityError";
  }
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function secretHash(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

function actionExpired(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() <= now.getTime();
}

function accountShape(row: {
  id: string;
  providerId: string;
  accountId: string;
  password: string | null;
}): AccountIdentityAccount {
  return row;
}

function ownershipShape(row: {
  accountRecordId: string;
  providerId: string;
  providerSubject: string;
  providerEmail: string | null;
  providerEmailVerified: boolean;
  verifiedAt: Date;
}): AccountIdentityOwnership {
  return row;
}

async function audit(
  transaction: Transaction,
  values: {
    userId: string;
    event: "reverify" | "link-intent" | "link" | "unlink";
    outcome: "success" | "refused";
    providerId?: string | null;
    accountRecordId?: string | null;
    reason?: string | null;
  },
) {
  await transaction.insert(accountIdentityAudit).values({
    userId: values.userId,
    event: values.event,
    outcome: values.outcome,
    providerId: values.providerId ?? null,
    accountRecordId: values.accountRecordId ?? null,
    reason: values.reason ?? null,
  });
}

export async function recordIdentityRefusal(values: {
  userId: string;
  event: "reverify" | "link-intent" | "link" | "unlink";
  providerId?: string | null;
  accountRecordId?: string | null;
  reason: AccountIdentityErrorCode | string;
}) {
  await db.insert(accountIdentityAudit).values({
    userId: values.userId,
    event: values.event,
    outcome: "refused",
    providerId: values.providerId ?? null,
    accountRecordId: values.accountRecordId ?? null,
    reason: values.reason,
  });
}

export async function createPasswordReverificationGrant(
  userId: string,
  sessionId: string,
  now = new Date(),
) {
  const token = newSecret();
  const expiresAt = new Date(now.getTime() + IDENTITY_REVERIFY_TTL_MS);
  await db.transaction(async (transaction) => {
    await transaction.insert(accountIdentityActions).values({
      userId,
      sessionId,
      kind: "reverify",
      providerId: null,
      secretHash: secretHash(token),
      expiresAt,
    });
    await audit(transaction, { userId, event: "reverify", outcome: "success" });
  });
  return { token, expiresAt };
}

async function loadAction(
  transaction: Transaction,
  values: {
    token: string;
    kind: "reverify" | "link";
    actionId?: string;
  },
) {
  if (!values.token || values.token.length > 512) {
    throw new AccountIdentityError("IDENTITY_ACTION_INVALID");
  }
  const filters = [
    eq(accountIdentityActions.secretHash, secretHash(values.token)),
    eq(accountIdentityActions.kind, values.kind),
  ];
  if (values.actionId) filters.push(eq(accountIdentityActions.id, values.actionId));
  const [action] = await transaction
    .select()
    .from(accountIdentityActions)
    .where(and(...filters))
    .for("update")
    .limit(1);
  if (!action) throw new AccountIdentityError("IDENTITY_ACTION_INVALID");
  return action;
}

function validateAction(
  action: Awaited<ReturnType<typeof loadAction>>,
  values: {
    userId: string;
    sessionId: string;
    providerId?: string;
    now: Date;
    allowConsumed?: boolean;
  },
) {
  if (action.userId !== values.userId || action.sessionId !== values.sessionId) {
    throw new AccountIdentityError("IDENTITY_ACTION_SESSION_CHANGED");
  }
  if (values.providerId !== undefined && action.providerId !== values.providerId) {
    throw new AccountIdentityError("IDENTITY_PROVIDER_MISMATCH");
  }
  if (action.consumedAt) {
    if (values.allowConsumed) return;
    throw new AccountIdentityError("IDENTITY_ACTION_REPLAYED");
  }
  if (actionExpired(action.expiresAt, values.now)) {
    throw new AccountIdentityError("IDENTITY_ACTION_EXPIRED");
  }
}

async function consumeAction(
  transaction: Transaction,
  values: {
    token: string;
    kind: "reverify" | "link";
    userId: string;
    sessionId: string;
    providerId?: string;
    actionId?: string;
    now: Date;
  },
) {
  const action = await loadAction(transaction, values);
  validateAction(action, values);
  await transaction
    .update(accountIdentityActions)
    .set({ consumedAt: values.now })
    .where(eq(accountIdentityActions.id, action.id));
  return action;
}

async function lockUser(transaction: Transaction, userId: string) {
  const [user] = await transaction
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.id, userId))
    .for("update")
    .limit(1);
  if (!user) throw new AccountIdentityError("IDENTITY_ACCOUNT_NOT_FOUND");
}

async function lockProviderIdentity(
  transaction: Transaction,
  providerId: string,
  providerSubject: string,
) {
  // Better Auth 1.6.23 looks up providerId+accountId before creating an
  // account but its generated schema does not carry a provider+account unique
  // index. Serialize explicit Startrips links on that stable external identity
  // before either the Better Auth row or our ownership row is inspected. The
  // durable unique ownership index remains the database backstop.
  await transaction.execute(sql`
    select pg_advisory_xact_lock(
      hashtextextended(${`${providerId}\u0000${providerSubject}`}, 0)
    )
  `);
}

export async function createIdentityLinkIntent(values: {
  userId: string;
  sessionId: string;
  providerId: string;
  reverificationToken: string;
  now?: Date;
}) {
  const now = values.now ?? new Date();
  const token = newSecret();
  const expiresAt = new Date(now.getTime() + IDENTITY_LINK_INTENT_TTL_MS);
  return await db.transaction(async (transaction) => {
    await lockUser(transaction, values.userId);
    await consumeAction(transaction, {
      token: values.reverificationToken,
      kind: "reverify",
      userId: values.userId,
      sessionId: values.sessionId,
      now,
    });
    const [action] = await transaction
      .insert(accountIdentityActions)
      .values({
        userId: values.userId,
        sessionId: values.sessionId,
        kind: "link",
        providerId: values.providerId,
        secretHash: secretHash(token),
        expiresAt,
      })
      .returning({ id: accountIdentityActions.id });
    await audit(transaction, {
      userId: values.userId,
      event: "link-intent",
      outcome: "success",
      providerId: values.providerId,
    });
    return { actionId: action.id, token, expiresAt };
  });
}

export async function completeIdentityLink(values: {
  userId: string;
  sessionId: string;
  intentToken: string;
  proof: ProviderIdentityProof;
  now?: Date;
}) {
  const now = values.now ?? new Date();
  return await db.transaction(async (transaction) => {
    await lockUser(transaction, values.userId);
    if (values.proof.userId !== values.userId || values.proof.sessionId !== values.sessionId) {
      throw new AccountIdentityError("IDENTITY_ACTION_SESSION_CHANGED");
    }

    const action = await loadAction(transaction, {
      token: values.intentToken,
      kind: "link",
      actionId: values.proof.actionId,
    });
    validateAction(action, {
      userId: values.userId,
      sessionId: values.sessionId,
      providerId: values.proof.identity.providerId,
      now,
      allowConsumed: true,
    });

    await lockProviderIdentity(
      transaction,
      values.proof.identity.providerId,
      values.proof.identity.subject,
    );
    const [owned] = await transaction
      .select()
      .from(accountIdentityOwnerships)
      .where(and(
        eq(accountIdentityOwnerships.providerId, values.proof.identity.providerId),
        eq(accountIdentityOwnerships.providerSubject, values.proof.identity.subject),
      ))
      .limit(1);
    const [existingAccount] = await transaction
      .select({
        id: authAccount.id,
        userId: authAccount.userId,
        providerId: authAccount.providerId,
        accountId: authAccount.accountId,
      })
      .from(authAccount)
      .where(and(
        eq(authAccount.providerId, values.proof.identity.providerId),
        eq(authAccount.accountId, values.proof.identity.subject),
      ))
      .limit(1);

    if (action.consumedAt) {
      if (
        owned?.userId === values.userId
        && existingAccount?.userId === values.userId
        && owned.accountRecordId === existingAccount.id
      ) {
        return { accountRecordId: existingAccount.id, linked: false, alreadyLinked: true };
      }
      throw new AccountIdentityError("IDENTITY_ACTION_REPLAYED");
    }
    if (owned && owned.userId !== values.userId) {
      throw new AccountIdentityError("IDENTITY_ALREADY_OWNED");
    }
    if (existingAccount && existingAccount.userId !== values.userId) {
      throw new AccountIdentityError("IDENTITY_ALREADY_OWNED");
    }
    if (owned && (!existingAccount || owned.accountRecordId !== existingAccount.id)) {
      throw new AccountIdentityError("IDENTITY_ACCOUNT_NOT_FOUND");
    }

    await transaction
      .update(accountIdentityActions)
      .set({ consumedAt: now })
      .where(eq(accountIdentityActions.id, action.id));

    let accountRecordId = existingAccount?.id;
    let linked = false;
    if (!accountRecordId) {
      accountRecordId = randomUUID();
      await transaction.insert(authAccount).values({
        id: accountRecordId,
        userId: values.userId,
        providerId: values.proof.identity.providerId,
        accountId: values.proof.identity.subject,
      });
      linked = true;
    }
    if (!owned) {
      await transaction.insert(accountIdentityOwnerships).values({
        userId: values.userId,
        accountRecordId,
        providerId: values.proof.identity.providerId,
        providerSubject: values.proof.identity.subject,
        providerEmail: values.proof.identity.email,
        providerEmailVerified: values.proof.identity.emailVerified,
        verifiedAt: now,
      });
    }
    await audit(transaction, {
      userId: values.userId,
      event: "link",
      outcome: "success",
      providerId: values.proof.identity.providerId,
      accountRecordId,
    });
    return { accountRecordId, linked, alreadyLinked: false };
  });
}

async function loadUserIdentityState(
  executor: typeof db | Transaction,
  userId: string,
  lock = false,
) {
  const loadUser = () => executor
    .select({ id: authUser.id, email: authUser.email, emailVerified: authUser.emailVerified })
    .from(authUser)
    .where(eq(authUser.id, userId))
    .limit(1);
  const loadAccounts = () => executor
    .select({
      id: authAccount.id,
      providerId: authAccount.providerId,
      accountId: authAccount.accountId,
      password: authAccount.password,
    })
    .from(authAccount)
    .where(eq(authAccount.userId, userId))
    .orderBy(asc(authAccount.createdAt), asc(authAccount.id));
  const loadOwnerships = () => executor
    .select({
      accountRecordId: accountIdentityOwnerships.accountRecordId,
      providerId: accountIdentityOwnerships.providerId,
      providerSubject: accountIdentityOwnerships.providerSubject,
      providerEmail: accountIdentityOwnerships.providerEmail,
      providerEmailVerified: accountIdentityOwnerships.providerEmailVerified,
      verifiedAt: accountIdentityOwnerships.verifiedAt,
    })
    .from(accountIdentityOwnerships)
    .where(eq(accountIdentityOwnerships.userId, userId));

  if (lock) {
    // Acquire the stable user row first and only then read/lock child rows. It
    // is the serialization point for concurrent unlink decisions; using
    // Promise.all here would make lock acquisition order dependent on query
    // scheduling rather than the declared invariant.
    const [user] = await loadUser().for("update");
    if (!user) return { user: undefined, accounts: [], ownerships: [] };
    const accounts = await loadAccounts().for("update");
    const ownerships = await loadOwnerships().for("update");
    return {
      user,
      accounts: accounts.map(accountShape),
      ownerships: ownerships.map(ownershipShape),
    };
  }

  const [[user], accounts, ownerships] = await Promise.all([
    loadUser(),
    loadAccounts(),
    loadOwnerships(),
  ]);
  return {
    user,
    accounts: accounts.map(accountShape),
    ownerships: ownerships.map(ownershipShape),
  };
}

export async function listAccountIdentityMethods(
  userId: string,
  usableProviderIds: ReadonlySet<string>,
): Promise<AccountIdentityMethod[]> {
  const state = await loadUserIdentityState(db, userId);
  if (!state.user) return [];
  return buildIdentityMethods(
    state.accounts,
    state.ownerships,
    state.user.email,
    state.user.emailVerified,
    usableProviderIds,
  );
}

export async function unlinkAccountIdentity(values: {
  userId: string;
  sessionId: string;
  accountRecordId: string;
  reverificationToken: string;
  usableProviderIds: ReadonlySet<string>;
  now?: Date;
}) {
  const now = values.now ?? new Date();
  return await db.transaction(async (transaction) => {
    const state = await loadUserIdentityState(transaction, values.userId, true);
    if (!state.user) throw new AccountIdentityError("IDENTITY_ACCOUNT_NOT_FOUND");
    const target = state.accounts.find((account) => account.id === values.accountRecordId);
    if (!target) {
      // A lost response may cause the exact unlink request to be retried with
      // the already-consumed re-verification token. The prior success audit is
      // the idempotency receipt; do not turn that safe retry into a replay error.
      const [prior] = await transaction
        .select({ id: accountIdentityAudit.id })
        .from(accountIdentityAudit)
        .where(and(
          eq(accountIdentityAudit.userId, values.userId),
          eq(accountIdentityAudit.event, "unlink"),
          eq(accountIdentityAudit.outcome, "success"),
          eq(accountIdentityAudit.accountRecordId, values.accountRecordId),
        ))
        .limit(1);
      if (prior) return { unlinked: false, alreadyUnlinked: true };
      await consumeAction(transaction, {
        token: values.reverificationToken,
        kind: "reverify",
        userId: values.userId,
        sessionId: values.sessionId,
        now,
      });
      throw new AccountIdentityError("IDENTITY_ACCOUNT_NOT_FOUND");
    }

    await consumeAction(transaction, {
      token: values.reverificationToken,
      kind: "reverify",
      userId: values.userId,
      sessionId: values.sessionId,
      now,
    });
    if (!hasUsableLoginAfterRemoval(
      target.id,
      state.accounts,
      state.ownerships,
      state.user.emailVerified,
      values.usableProviderIds,
    )) {
      throw new AccountIdentityError("IDENTITY_LAST_USABLE_LOGIN");
    }
    await transaction.delete(authAccount).where(and(
      eq(authAccount.id, target.id),
      eq(authAccount.userId, values.userId),
    ));
    await audit(transaction, {
      userId: values.userId,
      event: "unlink",
      outcome: "success",
      providerId: target.providerId,
      accountRecordId: target.id,
    });
    return { unlinked: true, alreadyUnlinked: false };
  });
}
