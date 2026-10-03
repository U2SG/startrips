import {
  AccountPasswordRefusal,
  claimReverification,
  type PasswordReverification,
} from "./accountPassword";
import type { AccountSurface } from "./accountSurface";

export type AccountEmailChangeStatus =
  | "pending"
  | "completed"
  | "cancelled"
  | "replaced"
  | "expired"
  | "conflicted";

export type AccountEmailChangeView = {
  id: string;
  currentEmail: string;
  proposedEmail: string;
  status: AccountEmailChangeStatus;
  oldConfirmedAt: string | null;
  newVerifiedAt: string | null;
  expiresAt: string;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AccountEmailChangeProof = {
  stage: "old" | "new";
  token: string;
};

export type AccountEmailChangeProofResult = {
  change: AccountEmailChangeView;
  completed: boolean;
};

export class AccountEmailChangeRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AccountEmailChangeRefusal";
  }
}

export type AccountEmailChangeDeps = {
  fetchImpl?: typeof fetch;
  refreshSession?: () => Promise<unknown>;
};

const BASE_URL = "/api/account-identities/email-change";

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
  if (!response.ok) throw new AccountEmailChangeRefusal(await refusalCode(response));
  return await response.json().catch(() => ({})) as Record<string, unknown>;
}

function readChange(payload: Record<string, unknown>): AccountEmailChangeView {
  const change = payload.change;
  if (!change || typeof change !== "object") {
    throw new AccountEmailChangeRefusal("EMAIL_CHANGE_INVALID_RESPONSE");
  }
  return change as AccountEmailChangeView;
}

export async function loadAccountEmailChange(
  deps: AccountEmailChangeDeps = {},
): Promise<AccountEmailChangeView | null> {
  const response = await (deps.fetchImpl ?? fetch)(BASE_URL, { credentials: "include" });
  if (!response.ok) throw new AccountEmailChangeRefusal(await refusalCode(response));
  const payload = await response.json() as { change?: AccountEmailChangeView | null };
  return payload.change ?? null;
}

export async function startAccountEmailChange(
  input: {
    newEmail: string;
    reverification: PasswordReverification;
    oldAddressAvailable: boolean;
  },
  deps: AccountEmailChangeDeps = {},
): Promise<AccountEmailChangeView> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let reverificationToken: string;
  try {
    reverificationToken = await claimReverification(fetchImpl, input.reverification);
  } catch (error) {
    if (error instanceof AccountPasswordRefusal) {
      throw new AccountEmailChangeRefusal(error.code);
    }
    throw error;
  }
  const payload = await postJson(fetchImpl, BASE_URL, {
    newEmail: input.newEmail.trim(),
    reverificationToken,
    oldAddressAvailable: input.oldAddressAvailable,
  });
  return readChange(payload);
}

export async function cancelAccountEmailChange(
  deps: AccountEmailChangeDeps = {},
): Promise<AccountEmailChangeView> {
  const payload = await postJson(deps.fetchImpl ?? fetch, `${BASE_URL}/cancel`, {});
  return readChange(payload);
}

export async function consumeAccountEmailChangeProof(
  proof: AccountEmailChangeProof,
  deps: AccountEmailChangeDeps = {},
): Promise<AccountEmailChangeProofResult> {
  const endpoint = proof.stage === "old" ? "confirm-old" : "verify-new";
  const payload = await postJson(
    deps.fetchImpl ?? fetch,
    `${BASE_URL}/${endpoint}`,
    { token: proof.token },
  );
  const result = {
    change: readChange(payload),
    completed: payload.completed === true,
  };
  if (result.completed) {
    try {
      await deps.refreshSession?.();
    } catch {
      // Completion stands; refresh only synchronizes the revoked session.
    }
  }
  return result;
}

export function readAccountEmailChangeProof(hash: string): AccountEmailChangeProof | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const stage = params.get("stage");
  const token = params.get("token");
  if ((stage !== "old" && stage !== "new") || !token || token.length < 32 || token.length > 512) {
    return null;
  }
  return { stage, token };
}

export function canStartAccountEmailChange(
  change: AccountEmailChangeView | null,
  statusKnown = true,
): boolean {
  return statusKnown && change?.status !== "pending";
}

export function isRetryableAccountEmailChangeProofError(error: unknown): boolean {
  if (!(error instanceof AccountEmailChangeRefusal)) return true;
  return /^REQUEST_FAILED_(408|429|5\d\d)$/.test(error.code);
}

export function accountEmailChangeSurface(change: AccountEmailChangeView | null): AccountSurface {
  if (!change) return "email-change";
  if (change.status === "completed") return "email-change-completed";
  if (change.status === "cancelled") return "email-change-cancelled";
  if (change.status === "conflicted" || change.status === "expired" || change.status === "replaced") {
    return "email-change-conflicted";
  }
  if (change.oldConfirmedAt && !change.newVerifiedAt) return "email-change-verifying-new";
  if (!change.oldConfirmedAt && change.newVerifiedAt) return "email-change-verifying-old";
  return "email-change-pending";
}

export function accountEmailChangeRefusalSurface(code: string): AccountSurface {
  if (code === "EMAIL_CHANGE_RECOVERY_REQUIRED") return "email-change-recovery-required";
  if (code === "EMAIL_CHANGE_DELIVERY_FAILED") return "email-change-delivery-failed";
  if (
    code === "EMAIL_CHANGE_EMAIL_UNAVAILABLE"
    || code === "EMAIL_CHANGE_ACCOUNT_CHANGED"
    || code === "EMAIL_CHANGE_SESSION_CHANGED"
  ) return "email-change-conflicted";
  return "email-change";
}

export function accountEmailChangeRefusalText(code: string): string {
  switch (code) {
    case "EMAIL_CHANGE_RECOVERY_REQUIRED":
      return "当前邮箱已无法使用，需要先完成受控账户恢复；这里不会降低验证要求。";
    case "EMAIL_CHANGE_DELIVERY_FAILED":
      return "验证邮件未能完整送达，本次换绑已取消，请重新发起。";
    case "EMAIL_CHANGE_EMAIL_UNAVAILABLE":
      return "这个新邮箱当前不能用于换绑，请换一个地址。";
    case "EMAIL_CHANGE_SAME_EMAIL":
      return "新邮箱与当前邮箱相同。";
    case "EMAIL_CHANGE_CURRENT_EMAIL_UNVERIFIED":
      return "当前邮箱尚未验证，暂时不能发起换绑。";
    case "EMAIL_CHANGE_REVERIFY_EXPIRED":
    case "IDENTITY_ACTION_EXPIRED":
      return "身份确认已过期，请重新输入当前密码。";
    case "EMAIL_CHANGE_REVERIFY_REPLAYED":
    case "IDENTITY_ACTION_REPLAYED":
      return "这次身份确认已经用过，请重新确认。";
    case "EMAIL_CHANGE_SESSION_CHANGED":
      return "登录会话已经变化，请回到发起换绑的同一会话重试。";
    case "EMAIL_CHANGE_PROOF_INVALID":
      return "这个邮箱确认链接无效。";
    case "EMAIL_CHANGE_PROOF_REPLAYED":
      return "这个邮箱确认链接已经使用过。";
    case "EMAIL_CHANGE_EXPIRED":
      return "这次邮箱换绑已过期，请重新发起。";
    case "EMAIL_CHANGE_REPLACED":
      return "这次邮箱换绑已被较新的请求替代。";
    case "EMAIL_CHANGE_CANCELLED":
      return "这次邮箱换绑已经取消。";
    case "EMAIL_CHANGE_ACCOUNT_CHANGED":
      return "账户邮箱状态已经变化，本次换绑未生效。";
    case "EMAIL_CHANGE_ORIGIN_REQUIRED":
      return "请求来源不被信任，请从 Startrips 页面内重试。";
    case "UNAUTHORIZED":
      return "登录状态已失效，请重新登录。";
    default:
      return "邮箱换绑未完成，请稍后再试。";
  }
}
