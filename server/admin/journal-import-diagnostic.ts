import { ShareIntentError } from "../intents/create-share-intent";
const modelCodes = new Set(["INTENT_CANCELLED", "INTENT_CONNECT_TIMEOUT", "INTENT_FIRST_BYTE_TIMEOUT", "INTENT_IDLE_TIMEOUT", "INTENT_STREAM_INVALID", "INTENT_STREAM_LIMIT", "INTENT_TIMEOUT", "INTENT_UNREACHABLE", "INTENT_FAILED", "INTENT_UNAVAILABLE", "JOURNAL_IMPORT_MALFORMED", "JOURNAL_PROVIDER_CONFIRMATION_REQUIRED", "HOTEL_TOOLS_INVALID"]);
const operationCodes = new Set(["JOURNAL_JOB_BUSY", "JOURNAL_JOB_NOT_COMPLETED", "JOURNAL_JOB_INTERRUPTED", "JOURNAL_JOB_CONFLICT","HOTEL_PLAN_EXPIRED_OR_INVALID", "INVALID_HOTEL_CHECKPOINT", "JOURNAL_CHANGED", "JOURNAL_PROVIDER_CHANGED", "JOURNAL_STAGE_NOT_CURRENT", "TARGET_NOT_FOUND", "DISTINCT_BACKUP_REQUIRED", "INPUT_TOO_LARGE", "INVALID_ARGUMENTS", "PRIVATE_FILE_REQUIRED", "PRIVATE_FILE_TOO_LARGE", "INVALID_ACCOUNT", "INVALID_IMPORT", "INVALID_PLAN", "INVALID_TARGET", "PLAN_DIGEST_MISMATCH", "PLAN_EXPIRED", "SAVE_MISMATCH", "TARGET_PERMISSION_DENIED"]);
const stages = new Set(["llm-job-submit", "llm-job-status", "llm-job-cancel", "llm-job-export","inspect", "preview", "llm-preview", "apply", "hotels-preview", "hotels-apply", "readback", "rollback-check"]);
/** Never expose provider text, source, URLs, credentials, SQL or exception causes. */
export function importDiagnostic(error: unknown, command: unknown) {
  const stage = typeof command === "string" && stages.has(command) ? command : "arguments";
  if (error instanceof ShareIntentError) {
    const code = modelCodes.has(error.code) ? error.code : "MODEL_STAGE_FAILED";
    const kind = ["INTENT_CANCELLED", "INTENT_CONNECT_TIMEOUT", "INTENT_FIRST_BYTE_TIMEOUT", "INTENT_IDLE_TIMEOUT", "INTENT_STREAM_INVALID", "INTENT_STREAM_LIMIT", "INTENT_TIMEOUT", "INTENT_UNREACHABLE", "INTENT_FAILED"].includes(code) ? "transport"
      : ["JOURNAL_IMPORT_MALFORMED", "HOTEL_TOOLS_INVALID"].includes(code) ? "schema" : "configuration";
    return { error: code, stage, kind, ...(Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? { status: error.status } : {}) };
  }
  const message = error instanceof Error ? error.message : "FAILED";
  return { error: operationCodes.has(message) ? message : "IMPORT_FAILED", stage, kind: "operation" };
}
