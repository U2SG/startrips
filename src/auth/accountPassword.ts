/**
 * #346 (ST-124): the client half of the account password lifecycle.
 *
 * The server already owns both writes — `POST /api/account-identities/password`
 * replaces an existing credential (#410) and `POST .../password/enrollment`
 * gives a credential-less Account its first one (#445) — and both consume a
 * single-use recent-control grant from `POST .../reverify/password` (#345).
 * This module is the only place the browser speaks that contract.
 *
 * Two rules shape the signatures below.
 *
 * The grant never leaves an async local scope. It is claimed and spent inside
 * one call, so no component state, no URL, no storage and no log line can hold
 * it; the caller passes the proof it already has and receives only the
 * server's non-secret outcome.
 *
 * Which write applies is the SERVER's answer, read from the authoritative
 * identity list plus the Account's own recovery address, never inferred from
 * `user.email` — the #346 assumption audit names exactly that inference as the
 * thing this feature invalidates.
 */

export type AccountIdentityMethod = {
  id: string;
  type: "password" | "provider";
  providerId: string;
  emailHint: string | null;
  verified: boolean;
  usable: boolean;
  canUnlink: boolean;
};

export type AccountRecoveryEmail = {
  email: string | null;
  emailVerified: boolean;
};

/**
 * `change` — a usable password credential exists; ask for the current password.
 * `enroll` — no usable credential, but a verified recovery address exists.
 * `recover` — no usable credential AND no address that could recover one, so
 * the only truthful offer is verifying or recovering that address first. An
 * enrollment form here would collect a password the Account could neither use
 * nor recover, which is what the server refuses with
 * PASSWORD_ENROLL_RECOVERY_REQUIRED.
 */
export type AccountPasswordState =
  | { kind: "change" }
  | { kind: "enroll" }
  | { kind: "recover"; reason: "email-missing" | "email-unverified" };

export function resolveAccountPasswordState(
  methods: readonly AccountIdentityMethod[],
  account: AccountRecoveryEmail,
): AccountPasswordState {
  const credential = methods.find((method) => method.type === "password");
  // `usable` already means "password set AND the address verified" on the
  // server, so it is the one flag that can authorise a current-password form.
  if (credential?.usable) return { kind: "change" };
  if (!account.email) return { kind: "recover", reason: "email-missing" };
  if (!account.emailVerified) return { kind: "recover", reason: "email-unverified" };
  return { kind: "enroll" };
}

/**
 * A password CHANGE rotates a secret other sessions may be holding, so the
 * server revokes them. Enrollment ADDS a login method and deliberately does
 * not: those sessions were authorised by an identity that is still valid, and
 * signing every device out for adding a password would be a surprise.
 */
export function passwordWriteRevokesOtherSessions(kind: "change" | "enroll"): boolean {
  return kind === "change";
}

/**
 * Recent-control proof the server accepts today. Password re-verification is
 * the only mechanism #345 shipped; the discriminant is here so a future
 * provider or mailed proof adds a variant instead of widening a bare string.
 */
export type PasswordReverification = { kind: "password"; password: string };

export class AccountPasswordRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AccountPasswordRefusal";
  }
}

export type AccountPasswordOutcome = {
  /** True when this call performed the write. */
  applied: boolean;
  /** True when the same grant had already performed it. */
  alreadyApplied: boolean;
  /** Sessions other than the calling one that the server revoked. */
  revokedOtherSessions: number;
};

export type AccountPasswordDeps = {
  fetchImpl?: typeof fetch;
  /** Called after a successful write so the shell re-reads the live session. */
  refreshSession?: () => Promise<unknown>;
};

const IDENTITIES_URL = "/api/account-identities";
const REVERIFY_URL = "/api/account-identities/reverify/password";
const CHANGE_URL = "/api/account-identities/password";
const ENROLLMENT_URL = "/api/account-identities/password/enrollment";

async function refusalCode(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `REQUEST_FAILED_${response.status}`;
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new AccountPasswordRefusal(await refusalCode(response));
  return await response.json().catch(() => ({})) as Record<string, unknown>;
}

export async function loadAccountIdentityMethods(
  deps: AccountPasswordDeps = {},
): Promise<AccountIdentityMethod[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const response = await fetchImpl(IDENTITIES_URL, { credentials: "include" });
  if (!response.ok) throw new AccountPasswordRefusal(await refusalCode(response));
  const payload = await response.json() as { methods?: AccountIdentityMethod[] };
  return payload.methods ?? [];
}

async function claimReverification(
  fetchImpl: typeof fetch,
  reverification: PasswordReverification,
): Promise<string> {
  const payload = await postJson(fetchImpl, REVERIFY_URL, {
    password: reverification.password,
  });
  const token = payload.reverificationToken;
  if (typeof token !== "string" || token.length === 0) {
    throw new AccountPasswordRefusal("IDENTITY_REVERIFY_FAILED");
  }
  return token;
}

function outcome(
  payload: Record<string, unknown>,
  appliedKey: string,
  alreadyKey: string,
): AccountPasswordOutcome {
  const revoked = payload.revokedOtherSessions;
  return {
    applied: payload[appliedKey] === true,
    alreadyApplied: payload[alreadyKey] === true,
    revokedOtherSessions: typeof revoked === "number" ? revoked : 0,
  };
}

/** Replace the credential of an Account that already holds a usable one. */
export async function submitAccountPasswordChange(
  values: { currentPassword: string; newPassword: string },
  deps: AccountPasswordDeps = {},
): Promise<AccountPasswordOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const reverificationToken = await claimReverification(fetchImpl, {
    kind: "password",
    password: values.currentPassword,
  });
  const payload = await postJson(fetchImpl, CHANGE_URL, {
    currentPassword: values.currentPassword,
    newPassword: values.newPassword,
    reverificationToken,
  });
  await deps.refreshSession?.();
  return outcome(payload, "changed", "alreadyChanged");
}

/**
 * Give a credential-less Account its first password.
 *
 * The proof is a parameter rather than a password field because this flow's
 * whole premise is that the Account has no password to re-verify with; the
 * caller supplies whatever recent-control proof it legitimately holds.
 */
export async function submitAccountPasswordEnrollment(
  values: { newPassword: string; reverification: PasswordReverification },
  deps: AccountPasswordDeps = {},
): Promise<AccountPasswordOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const reverificationToken = await claimReverification(fetchImpl, values.reverification);
  const payload = await postJson(fetchImpl, ENROLLMENT_URL, {
    newPassword: values.newPassword,
    reverificationToken,
  });
  await deps.refreshSession?.();
  return outcome(payload, "enrolled", "alreadyEnrolled");
}

/**
 * Every typed refusal the two write routes and the grant route can answer
 * with, in the words the person reading them needs. A code with no entry still
 * gets a truthful fallback rather than a raw identifier.
 */
export function accountPasswordRefusalText(code: string): string {
  switch (code) {
    case "PASSWORD_CHANGE_CURRENT_PASSWORD_INVALID":
      return "当前密码不正确，密码未修改。";
    case "PASSWORD_CHANGE_CREDENTIAL_NOT_FOUND":
      return "这个账户还没有密码，请改用设置密码的流程。";
    case "PASSWORD_ENROLL_ALREADY_SET":
      return "这个账户已经有密码，请改用修改密码的流程。";
    case "PASSWORD_ENROLL_RECOVERY_REQUIRED":
      return "请先验证账户邮箱，之后才能设置密码。";
    case "PASSWORD_CHANGE_PASSWORD_TOO_SHORT":
    case "PASSWORD_ENROLL_PASSWORD_TOO_SHORT":
      return "新密码太短，请换一个更长的密码。";
    case "PASSWORD_CHANGE_PASSWORD_TOO_LONG":
    case "PASSWORD_ENROLL_PASSWORD_TOO_LONG":
      return "新密码太长，请换一个更短的密码。";
    case "PASSWORD_CHANGE_REVERIFY_EXPIRED":
    case "PASSWORD_ENROLL_REVERIFY_EXPIRED":
      return "身份确认已过期，请重新输入密码确认。";
    case "PASSWORD_CHANGE_REVERIFY_REPLAYED":
    case "PASSWORD_ENROLL_REVERIFY_REPLAYED":
      return "这次身份确认已经用过了，请重新确认后再试。";
    case "PASSWORD_CHANGE_REVERIFY_INVALID":
    case "PASSWORD_ENROLL_REVERIFY_INVALID":
      return "身份确认无效，请重新确认后再试。";
    case "PASSWORD_CHANGE_SESSION_CHANGED":
    case "PASSWORD_ENROLL_SESSION_CHANGED":
      return "登录状态已经变化，请重新登录后再试。";
    case "PASSWORD_CHANGE_SESSION_EXPIRED":
    case "PASSWORD_ENROLL_SESSION_EXPIRED":
    case "UNAUTHORIZED":
      return "登录状态已过期，请重新登录。";
    case "PASSWORD_CHANGE_ACCOUNT_NOT_FOUND":
    case "PASSWORD_ENROLL_ACCOUNT_NOT_FOUND":
      return "找不到这个账户，请重新登录后再试。";
    case "PASSWORD_CHANGE_INVALID":
    case "PASSWORD_ENROLL_INVALID":
    case "INVALID_IDENTITY_REVERIFY":
      return "请求不完整，请检查输入后再试。";
    case "PASSWORD_CHANGE_ORIGIN_REQUIRED":
    case "PASSWORD_ENROLL_ORIGIN_REQUIRED":
    case "IDENTITY_ORIGIN_REQUIRED":
      return "请求来源不被信任，请在 Startrips 页面内重试。";
    case "IDENTITY_REVERIFY_FAILED":
      return "当前密码不正确，无法确认身份。";
    case "IDENTITY_REVERIFY_RATE_LIMITED":
      return "确认次数过多，请稍后再试。";
    default:
      return "操作未完成，请稍后再试。";
  }
}
