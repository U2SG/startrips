export type AuthFormMode = "sign-in" | "sign-up" | "forgot";

export const AUTH_FORM_STATUSES = [
  "idle",
  "submitting",
  "validation-error",
  "network-error",
  "rate-limited",
  "verification-required",
  "email-sent",
  "authenticated",
] as const;

export type AuthFormStatus = (typeof AUTH_FORM_STATUSES)[number];
export type AuthMessageTone = "error" | "success";

export type AuthFormState = {
  mode: AuthFormMode;
  status: AuthFormStatus;
  message: string;
  tone: AuthMessageTone;
  requestId: number;
  verificationEmail: string | null;
};

export type AuthFormEvent =
  | { type: "switch-mode"; mode: AuthFormMode }
  | { type: "submit" }
  | { type: "validation-error"; requestId: number; message: string }
  | { type: "network-error"; requestId: number; message?: string }
  | { type: "rate-limited"; requestId: number; message?: string }
  | { type: "verification-required"; requestId: number; email: string; message?: string }
  | { type: "email-sent"; requestId: number; message: string }
  | { type: "authenticated"; requestId: number };

export type AuthServiceError = {
  code?: string | null;
  message?: string | null;
  status?: number | null;
  statusCode?: number | null;
};

export function createAuthFormState(mode: AuthFormMode = "sign-in"): AuthFormState {
  return { mode, status: "idle", message: "", tone: "error", requestId: 0, verificationEmail: null };
}

function isCurrentRequest(state: AuthFormState, requestId: number): boolean {
  return state.requestId === requestId;
}

export function authFormReducer(state: AuthFormState, event: AuthFormEvent): AuthFormState {
  switch (event.type) {
    case "switch-mode":
      if (event.mode === state.mode) return state;
      return { ...state, mode: event.mode, status: "idle", message: "", tone: "error", requestId: state.requestId + 1, verificationEmail: null };
    case "submit":
      if (state.status === "submitting") return state;
      return { ...state, status: "submitting", message: "", tone: "error", requestId: state.requestId + 1 };
    case "validation-error":
      if (!isCurrentRequest(state, event.requestId)) return state;
      return { ...state, status: "validation-error", message: event.message, tone: "error" };
    case "network-error":
      if (!isCurrentRequest(state, event.requestId)) return state;
      return { ...state, status: "network-error", message: event.message ?? "网络连接中断，请检查网络后重试。", tone: "error" };
    case "rate-limited":
      if (!isCurrentRequest(state, event.requestId)) return state;
      return { ...state, status: "rate-limited", message: event.message ?? "尝试次数过多，请稍后再试。", tone: "error" };
    case "verification-required":
      if (!isCurrentRequest(state, event.requestId)) return state;
      return { ...state, status: "verification-required", message: event.message ?? "请先完成邮箱验证，也可以重新发送验证邮件。", tone: "error", verificationEmail: event.email };
    case "email-sent":
      if (!isCurrentRequest(state, event.requestId)) return state;
      return { ...state, status: "email-sent", message: event.message, tone: "success" };
    case "authenticated":
      if (!isCurrentRequest(state, event.requestId)) return state;
      return { ...state, status: "authenticated", message: "", tone: "success" };
  }
}

function normalizedErrorText(error: AuthServiceError): string {
  return [error.code, error.message].filter(Boolean).join(" ").toUpperCase();
}

export function authServiceErrorEvent(requestId: number, error: AuthServiceError, verificationEmail: string): AuthFormEvent {
  const text = normalizedErrorText(error);
  if (error.status === 429 || error.statusCode === 429 || /RATE.?LIMIT|TOO_MANY_REQUESTS/.test(text)) return { type: "rate-limited", requestId };
  if (/EMAIL_NOT_VERIFIED|EMAIL_UNVERIFIED/.test(text)) return { type: "verification-required", requestId, email: verificationEmail };
  return { type: "validation-error", requestId, message: "认证信息未通过，请检查后重试。" };
}

export function authProviderErrorEvent(requestId: number, error: AuthServiceError, message: string): AuthFormEvent {
  const classified = authServiceErrorEvent(requestId, error, "");
  if (classified.type === "rate-limited") return classified;
  return { type: "validation-error", requestId, message };
}

export function authExceptionEvent(requestId: number, error: unknown): AuthFormEvent {
  const name = error && typeof error === "object" && "name" in error ? String((error as { name?: unknown }).name ?? "") : "";
  return { type: "network-error", requestId, message: name === "AbortError" ? "请求已取消，可以立即重试。" : "网络连接中断，请检查网络后重试。" };
}
