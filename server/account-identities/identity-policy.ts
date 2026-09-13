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

export function redactIdentityEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const separator = email.lastIndexOf("@");
  if (separator <= 0 || separator === email.length - 1) return null;
  const local = email.slice(0, separator);
  const domain = email.slice(separator + 1);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${local.length > visible.length ? "…" : ""}@${domain}`;
}

export function accountIdentityUsable(
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
    accountIdentityUsable(account, ownershipByAccount.get(account.id), userEmailVerified, usableProviderIds),
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
      canUnlink: usableCount - (usable ? 1 : 0) >= 1,
    };
  });
}

export function hasUsableLoginAfterRemoval(
  targetAccountId: string,
  accounts: readonly AccountIdentityAccount[],
  ownerships: readonly AccountIdentityOwnership[],
  userEmailVerified: boolean,
  usableProviderIds: ReadonlySet<string>,
): boolean {
  const ownershipByAccount = new Map(ownerships.map((entry) => [entry.accountRecordId, entry]));
  return accounts.some((account) => account.id !== targetAccountId && accountIdentityUsable(
    account,
    ownershipByAccount.get(account.id),
    userEmailVerified,
    usableProviderIds,
  ));
}
