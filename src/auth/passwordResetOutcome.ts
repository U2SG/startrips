/** The pinned Better Auth reset endpoint uses INVALID_TOKEN for malformed, expired and spent links. */
export type PasswordResetAttempt =
  | {
    kind: "response";
    data?: { status?: boolean } | null;
    error?: { code?: string | null } | null;
  }
  | { kind: "exception" };

export type PasswordResetOutcome =
  | "success"
  | "invalid-link"
  | "password-too-short"
  | "password-too-long"
  | "unconfirmed"
  | "connection-lost";

/** Do not turn an absent response or a thrown request into a claim that the password changed. */
export function resolvePasswordResetOutcome(attempt: PasswordResetAttempt): PasswordResetOutcome {
  if (attempt.kind === "exception") return "connection-lost";
  switch (attempt.error?.code) {
    case "INVALID_TOKEN":
      return "invalid-link";
    case "PASSWORD_TOO_SHORT":
      return "password-too-short";
    case "PASSWORD_TOO_LONG":
      return "password-too-long";
  }
  if (attempt.error) return "unconfirmed";
  return attempt.data?.status === true ? "success" : "unconfirmed";
}
