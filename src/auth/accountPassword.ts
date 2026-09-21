/**
 * #346 (ST-124): the client half of the account password lifecycle.
 *
 * The browser performs exactly ONE password write: `POST
 * /api/account-identities/password` (#410), which replaces the credential of
 * an Account that already has a usable one and spends a single-use
 * recent-control grant from `POST .../reverify/password` (#345).
 *
 * It performs no other one. `POST .../password/enrollment` (#445) keeps its
 * server contract untouched, but no client path reaches it: the only grant
 * issuer runs `auth.api.verifyPassword`, which is precisely what a
 * credential-less Account cannot pass. Per the owner's 2026-09-21 decision on
 * #346, that Account gets its first password through the verified-email
 * set-password link instead — the same delivery the sign-in gate's
 * forgot-password mode already uses — and the link itself is the proof.
 *
 * Two rules shape the signatures below.
 *
 * The grant never leaves an async local scope. It is claimed and spent inside
 * one call, so no component state, no URL, no storage and no log line can hold
 * it; the caller passes the proof it already has and receives only the
 * server's non-secret outcome. The link request claims no grant at all.
 *
 * Which offer applies is the SERVER's answer, read from the authoritative
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
 * `send-link` — no usable credential, but a verified address exists, so the
 * only offer is a set-password link sent to it.
 * `recover` — no usable credential AND no address the link could be sent to,
 * so the only truthful offer is verifying that address first. Anything else
 * here would promise a delivery that cannot happen.
 */
export type AccountPasswordState =
  | { kind: "change" }
  | { kind: "send-link" }
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
  return { kind: "send-link" };
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
  // Re-reading the session is synchronisation AFTER the write, not part of it.
  // The server has already rotated the credential by this point, so a
  // transient refresh failure must not be reported as "password unchanged" —
  // that would send the person back to a form their old password no longer
  // opens.
  try {
    await deps.refreshSession?.();
  } catch {
    // The write stands; the shell re-reads the session on its next render.
  }
  return outcome(payload, "changed", "alreadyChanged");
}

/**
 * Ask for a set-password link on behalf of a credential-less Account.
 *
 * The delivery is injected rather than imported so this module stays free of
 * the auth client, and — more to the point — so the only thing this function
 * can reach is that delivery. There is no grant to claim, no password to
 * carry and no session to refresh: the link the Account receives is itself the
 * recent-control proof, redeemed on the reset page under the server's
 * unchanged single-use lifetime.
 */
export type SetPasswordLinkDelivery = (input: {
  email: string;
  redirectTo: string;
}) => Promise<{ error?: { message?: string | null } | null } | null | undefined>;

export type SetPasswordLinkResult =
  | { outcome: "sent" }
  | { outcome: "failed" };

export async function requestSetPasswordLink(
  input: { email: string; redirectTo: string },
  deliver: SetPasswordLinkDelivery,
): Promise<SetPasswordLinkResult> {
  if (!input.email) return { outcome: "failed" };
  try {
    const result = await deliver(input);
    return result?.error ? { outcome: "failed" } : { outcome: "sent" };
  } catch {
    return { outcome: "failed" };
  }
}

/**
 * Every typed refusal the change route, the grant route and the identity list
 * can answer with, in the words the person reading them needs. The
 * enrollment route's codes are deliberately absent: no client path posts to
 * it, so mapping its refusals would describe an outcome this surface cannot
 * produce. A code with no entry still gets a truthful fallback rather than a
 * raw identifier.
 */
export function accountPasswordRefusalText(code: string): string {
  switch (code) {
    case "PASSWORD_CHANGE_CURRENT_PASSWORD_INVALID":
      return "当前密码不正确，密码未修改。";
    case "PASSWORD_CHANGE_CREDENTIAL_NOT_FOUND":
      return "这个账户还没有密码，请改用设置密码的流程。";
    case "PASSWORD_CHANGE_PASSWORD_TOO_SHORT":
      return "新密码太短，请换一个更长的密码。";
    case "PASSWORD_CHANGE_PASSWORD_TOO_LONG":
      return "新密码太长，请换一个更短的密码。";
    case "PASSWORD_CHANGE_REVERIFY_EXPIRED":
      return "身份确认已过期，请重新输入密码确认。";
    case "PASSWORD_CHANGE_REVERIFY_REPLAYED":
      return "这次身份确认已经用过了，请重新确认后再试。";
    case "PASSWORD_CHANGE_REVERIFY_INVALID":
      return "身份确认无效，请重新确认后再试。";
    case "PASSWORD_CHANGE_SESSION_CHANGED":
      return "登录状态已经变化，请重新登录后再试。";
    case "PASSWORD_CHANGE_SESSION_EXPIRED":
    case "UNAUTHORIZED":
      return "登录状态已过期，请重新登录。";
    case "PASSWORD_CHANGE_ACCOUNT_NOT_FOUND":
      return "找不到这个账户，请重新登录后再试。";
    case "PASSWORD_CHANGE_INVALID":
    case "INVALID_IDENTITY_REVERIFY":
      return "请求不完整，请检查输入后再试。";
    case "PASSWORD_CHANGE_ORIGIN_REQUIRED":
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
