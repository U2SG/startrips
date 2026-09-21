/**
 * #349 (ST-132): the client half of explicitly binding and unbinding a
 * provider identity.
 *
 * It drives the ST-067 endpoints that already exist and adds no second
 * contract: `reverify/password` for recent control, `link-intents` for the
 * single-use intent, `providers/<id>/authorize` for the authorization URL, and
 * `link/complete` for the proof the provider round trip produced. Unbinding is
 * the existing `DELETE /api/account-identities/<accountRecordId>`.
 *
 * Two shapes are deliberate.
 *
 * The password never leaves an async local scope, exactly as
 * `accountPassword.ts` requires: it is spent for a grant inside one call and
 * the grant is spent for an intent in the same call.
 *
 * The intent token, unlike that grant, HAS to survive a full-page navigation
 * to the provider and back, so it is the one value written to
 * `sessionStorage`. It is single-use, expires in ten minutes, is bound to this
 * user AND this session, and is inert without both the session cookie and a
 * matching provider proof; it is removed the moment the return is read, on
 * every outcome including failure.
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

export type AccountIdentityList = {
  methods: AccountIdentityMethod[];
  availableLinkProviders: string[];
};

export class AccountIdentityRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AccountIdentityRefusal";
  }
}

/** The subset of `Storage` this module uses, so a test needs no DOM. */
export type BindStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type AccountIdentityDeps = {
  fetchImpl?: typeof fetch;
  storage?: BindStorage;
};

const IDENTITIES_URL = "/api/account-identities";
const REVERIFY_URL = "/api/account-identities/reverify/password";
const LINK_INTENTS_URL = "/api/account-identities/link-intents";
const LINK_COMPLETE_URL = "/api/account-identities/link/complete";
const PROVIDERS_URL = "/api/account-identities/providers";

export const PENDING_BIND_STORAGE_KEY = "startrips.identity-bind";

type PendingBind = { providerId: string; intentToken: string };

function resolveStorage(deps: AccountIdentityDeps): BindStorage | null {
  if (deps.storage) return deps.storage;
  return typeof window === "undefined" ? null : window.sessionStorage;
}

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
  if (!response.ok) throw new AccountIdentityRefusal(await refusalCode(response));
  return await response.json().catch(() => ({})) as Record<string, unknown>;
}

async function readJson<T>(fetchImpl: typeof fetch, url: string): Promise<T> {
  const response = await fetchImpl(url, { credentials: "include" });
  if (!response.ok) throw new AccountIdentityRefusal(await refusalCode(response));
  return await response.json() as T;
}

/** Which providers this deployment configured. Readable before signing in. */
export async function loadSignInProviders(deps: AccountIdentityDeps = {}): Promise<string[]> {
  const payload = await readJson<{ signInProviders?: string[] }>(
    deps.fetchImpl ?? fetch,
    PROVIDERS_URL,
  );
  return Array.isArray(payload.signInProviders) ? payload.signInProviders : [];
}

export async function loadAccountIdentities(
  deps: AccountIdentityDeps = {},
): Promise<AccountIdentityList> {
  const payload = await readJson<Partial<AccountIdentityList>>(
    deps.fetchImpl ?? fetch,
    IDENTITIES_URL,
  );
  return {
    methods: payload.methods ?? [],
    availableLinkProviders: payload.availableLinkProviders ?? [],
  };
}

/**
 * Which providers the person may still bind: configured, and not already a
 * method on this Account. The server refuses a second claim anyway; this is
 * only about not offering an action that cannot succeed.
 */
export function bindableProviders(list: AccountIdentityList): string[] {
  const bound = new Set(list.methods
    .filter((method) => method.type === "provider")
    .map((method) => method.providerId));
  return list.availableLinkProviders.filter((providerId) => !bound.has(providerId));
}

/**
 * Spend the password for a grant, the grant for an intent, and the intent for
 * an authorization URL. Returns the URL the caller navigates to; the intent
 * token is left behind for the return.
 */
export async function beginProviderBind(
  input: { providerId: string; password: string; returnPath: string },
  deps: AccountIdentityDeps = {},
): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const grant = await postJson(fetchImpl, REVERIFY_URL, { password: input.password });
  const intent = await postJson(fetchImpl, LINK_INTENTS_URL, {
    providerId: input.providerId,
    reverificationToken: grant.reverificationToken,
  });
  const authorized = await postJson(fetchImpl, `${PROVIDERS_URL}/${input.providerId}/authorize`, {
    actionId: intent.actionId,
    returnPath: input.returnPath,
  });
  const authorizationUrl = authorized.authorizationUrl;
  if (typeof authorizationUrl !== "string") throw new AccountIdentityRefusal("IDENTITY_BIND_UNAVAILABLE");
  const storage = resolveStorage(deps);
  const intentToken = intent.intentToken;
  if (typeof intentToken !== "string") throw new AccountIdentityRefusal("IDENTITY_BIND_UNAVAILABLE");
  storage?.setItem(PENDING_BIND_STORAGE_KEY, JSON.stringify({
    providerId: input.providerId,
    intentToken,
  } satisfies PendingBind));
  return authorizationUrl;
}

export type ProviderBindReturn =
  | { kind: "proof"; proof: string }
  | { kind: "error"; code: string };

/**
 * Read what the bind callback put in the URL fragment. Pure, so the component
 * can consume the fragment and clear it in one place.
 */
export function readProviderBindReturn(hash: string): ProviderBindReturn | null {
  const fragment = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const outcome = fragment.get("identityLink");
  if (outcome === "proof") {
    const proof = fragment.get("identityLinkProof");
    return proof ? { kind: "proof", proof } : { kind: "error", code: "IDENTITY_PROVIDER_PROOF_INVALID" };
  }
  if (outcome === "error") {
    return { kind: "error", code: fragment.get("identityLinkError") || "IDENTITY_BIND_FAILED" };
  }
  return null;
}

/**
 * Finish the bind with the proof the callback produced. The stored intent is
 * removed first: one return, one attempt, whatever the outcome.
 */
export async function finishProviderBind(
  result: ProviderBindReturn,
  deps: AccountIdentityDeps = {},
): Promise<{ providerId: string; linked: boolean; alreadyLinked: boolean }> {
  const storage = resolveStorage(deps);
  const raw = storage?.getItem(PENDING_BIND_STORAGE_KEY) ?? null;
  storage?.removeItem(PENDING_BIND_STORAGE_KEY);
  if (result.kind === "error") throw new AccountIdentityRefusal(result.code);
  let pending: PendingBind | null = null;
  try {
    pending = raw ? JSON.parse(raw) as PendingBind : null;
  } catch {
    pending = null;
  }
  if (!pending?.intentToken) throw new AccountIdentityRefusal("IDENTITY_BIND_INTENT_MISSING");
  const completed = await postJson(deps.fetchImpl ?? fetch, LINK_COMPLETE_URL, {
    intentToken: pending.intentToken,
    providerProof: result.proof,
  });
  return {
    providerId: pending.providerId,
    linked: completed.linked === true,
    alreadyLinked: completed.alreadyLinked === true,
  };
}

export async function unlinkProviderIdentity(
  input: { accountRecordId: string; password: string },
  deps: AccountIdentityDeps = {},
): Promise<{ unlinked: boolean; alreadyUnlinked: boolean }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const grant = await postJson(fetchImpl, REVERIFY_URL, { password: input.password });
  const response = await fetchImpl(`${IDENTITIES_URL}/${encodeURIComponent(input.accountRecordId)}`, {
    method: "DELETE",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reverificationToken: grant.reverificationToken }),
  });
  if (!response.ok) throw new AccountIdentityRefusal(await refusalCode(response));
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  return {
    unlinked: payload.unlinked === true,
    alreadyUnlinked: payload.alreadyUnlinked === true,
  };
}

const REFUSAL_TEXT: Record<string, string> = {
  IDENTITY_REVERIFY_FAILED: "密码不正确，请重新输入。",
  IDENTITY_REVERIFY_RATE_LIMITED: "尝试过于频繁，请稍后再试。",
  IDENTITY_PROVIDER_NOT_CONFIGURED: "本部署未开放该登录方式。",
  IDENTITY_PROVIDER_REFUSED: "授权已取消或被拒绝，账户未发生变化。",
  IDENTITY_PROVIDER_UNAVAILABLE: "与登录服务的连接中断，账户未发生变化，可以重试。",
  IDENTITY_ACTION_SESSION_CHANGED: "登录状态已改变，请重新发起绑定。",
  IDENTITY_ACTION_EXPIRED: "本次绑定已超时，请重新发起。",
  IDENTITY_ACTION_REPLAYED: "本次绑定已经完成过一次。",
  IDENTITY_ALREADY_OWNED: "该身份已归属其他账户，不能改绑。",
  IDENTITY_LAST_USABLE_LOGIN: "这是最后一种可用登录方式，不能解绑。",
  IDENTITY_CREDENTIAL_UNLINK_UNAVAILABLE: "密码登录暂不支持解绑。",
  IDENTITY_BIND_STATE_INVALID: "本次授权已失效，请重新发起绑定。",
  IDENTITY_BIND_INTENT_MISSING: "本次绑定的凭据已不在，请重新发起。",
};

export function accountIdentityRefusalText(code: string): string {
  return REFUSAL_TEXT[code] ?? "操作未完成，请稍后再试。";
}

/**
 * What a failed provider sign-in says at the gate.
 *
 * `account_not_linked` is the important one: the address already belongs to a
 * Startrips Account that has never bound this provider, and the server refuses
 * to join them on the strength of a matching address alone. The only honest
 * instruction is the one that actually works -- sign in the usual way, then
 * bind from 登录方式.
 */
export function socialSignInErrorText(code: string | null): string {
  if (!code) return "";
  switch (code) {
    case "account_not_linked":
      return "这个邮箱已有 Startrips 账户，但还没有绑定该登录方式。请先用原有方式登录，再在「登录方式」里绑定。";
    case "email_not_found":
      return "该登录方式没有返回邮箱地址，无法完成登录。";
    case "access_denied":
      return "授权已取消，账户未发生变化。";
    case "oauth_provider_not_found":
      return "本部署未开放该登录方式。";
    default:
      return "登录未完成，请重试。";
  }
}
