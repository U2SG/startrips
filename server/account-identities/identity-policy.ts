export const CREDENTIAL_PROVIDER_ID = "credential";

export type AccountIdentityAccount = {
  id: string;
  providerId: string;
  accountId: string;
  password: string | null;
};

export type AccountIdentityOwnership = {
  accountRecordId: string;
  providerId: string;
  providerSubject: string;
  providerEmail: string | null;
  providerEmailVerified: boolean;
  verifiedAt: Date;
};

export type AccountIdentityMethod = {
  id: string;
  type: "password" | "provider";
  providerId: string;
  emailHint: string | null;
  verified: boolean;
  usable: boolean;
  canUnlink: boolean;
};

export function validProviderId(value: unknown): value is string {
  return typeof value === "string"
    && /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(value);
}

/**
 * #349: where an OAuth return may hand the browser back to.
 *
 * The rule is a same-document relative path and nothing else. Comparing a
 * caller-supplied absolute URL against `appOrigin` invites the whole
 * `appOrigin.evil.test` / `//evil.test` / backslash-authority family, so no
 * absolute URL is accepted at all -- the server prefixes its own origin.
 */
export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return null;
  if (value[0] !== "/") return null;
  // `//host` and `/\host` are both authority-relative: the browser would
  // leave the origin entirely.
  if (value[1] === "/" || value[1] === "\\") return null;
  // A control character can split a Location header or smuggle a second URL
  // past a naive reader.
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return null;
  }
  return value;
}

export function redactIdentityEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const separator = email.lastIndexOf("@");
  if (separator <= 0 || separator === email.length - 1) return null;
  const local = email.slice(0, separator);
  const domain = email.slice(separator + 1);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${local.length > visible.length ? "…" : ""}@${domain}`;
}

/**
 * #486 (option B, 2026-09-25): whether this identity can still sign the person
 * in. A provider identity qualifies while its bound subject matches, the
 * provider is configured, and the provider's last authorization carried a
 * verified email. There is deliberately no age bound on `verifiedAt`: an old
 * verification does not stop the provider from authenticating the subject.
 *
 * This is NOT a statement that the provider email is still reachable; ask
 * `accountIdentityRecoveryChannel` for that.
 */
export function accountIdentityLoginUsable(
  account: AccountIdentityAccount,
  ownership: AccountIdentityOwnership | undefined,
  userEmailVerified: boolean,
  usableProviderIds: ReadonlySet<string>,
): boolean {
  if (account.providerId === CREDENTIAL_PROVIDER_ID) {
    return Boolean(account.password) && userEmailVerified;
  }
  return Boolean(
    ownership
    && ownership.providerId === account.providerId
    && ownership.providerSubject === account.accountId
    && Boolean(ownership.providerEmail)
    && ownership.providerEmailVerified
    && ownership.verifiedAt
    && usableProviderIds.has(account.providerId),
  );
}

/**
 * #486 (option B, 2026-09-25): whether this identity is a currently reachable
 * recovery channel, i.e. somewhere Startrips can send mail and expect it to
 * arrive.
 *
 * A provider's `providerEmail` / `providerEmailVerified` / `verifiedAt` is the
 * claim the provider made when it last authorized the subject. Nothing tells
 * Startrips when that address stops resolving afterwards (a revoked relay, a
 * closed mailbox), and the row holds no later delivery evidence, so a provider
 * identity is never a recovery channel on that claim alone -- even while it
 * remains a valid login. The credential identity's channel is the Account's
 * own verified address, which the password send-link/reset flow already mails.
 */
export function accountIdentityRecoveryChannel(
  account: AccountIdentityAccount,
  userEmailVerified: boolean,
): boolean {
  return account.providerId === CREDENTIAL_PROVIDER_ID && userEmailVerified;
}

export function buildIdentityMethods(
  accounts: readonly AccountIdentityAccount[],
  ownerships: readonly AccountIdentityOwnership[],
  userEmail: string,
  userEmailVerified: boolean,
  usableProviderIds: ReadonlySet<string>,
): AccountIdentityMethod[] {
  const ownershipByAccount = new Map(ownerships.map((entry) => [entry.accountRecordId, entry]));
  const usableByAccount = new Map(accounts.map((account) => [
    account.id,
    accountIdentityLoginUsable(account, ownershipByAccount.get(account.id), userEmailVerified, usableProviderIds),
  ]));
  const usableCount = [...usableByAccount.values()].filter(Boolean).length;
  return accounts.map((account) => {
    const ownership = ownershipByAccount.get(account.id);
    const usable = usableByAccount.get(account.id) === true;
    const password = account.providerId === CREDENTIAL_PROVIDER_ID;
    return {
      id: account.id,
      type: password ? "password" : "provider",
      providerId: account.providerId,
      emailHint: redactIdentityEmail(password ? userEmail : ownership?.providerEmail),
      verified: password ? userEmailVerified : Boolean(ownership?.providerEmailVerified && ownership?.verifiedAt),
      usable,
      // ST-067 has one fresh-authorization mechanism today: password
      // re-verification. Keep that credential identity until a provider-based
      // re-verification contract exists; otherwise a provider-only account
      // could still sign in but could never manage identities again.
      canUnlink: !password && usableCount - (usable ? 1 : 0) >= 1,
    };
  });
}

/**
 * The #345 unlink guard. Its promise is a remaining LOGIN method, and it reads
 * only that dimension: a provider left behind counts because it can still
 * authenticate, never because its bind-time email looks like a way to recover
 * the account (#486).
 */
export function hasUsableLoginAfterRemoval(
  targetAccountId: string,
  accounts: readonly AccountIdentityAccount[],
  ownerships: readonly AccountIdentityOwnership[],
  userEmailVerified: boolean,
  usableProviderIds: ReadonlySet<string>,
): boolean {
  const ownershipByAccount = new Map(ownerships.map((entry) => [entry.accountRecordId, entry]));
  return accounts.some((account) => account.id !== targetAccountId && accountIdentityLoginUsable(
    account,
    ownershipByAccount.get(account.id),
    userEmailVerified,
    usableProviderIds,
  ));
}
