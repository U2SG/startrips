import { createHmac } from "node:crypto";
import { serverConfig } from "../config";
import { ShareIntentError } from "../intents/create-share-intent";
import type { IntentModelOptions } from "../intents/intent-model-request";

/** Opaque consent/provenance identity. Never disclose URL paths or credentials. */
export function journalProviderInfo() {
  const identity = createHmac("sha256", serverConfig.authSecret)
    .update(JSON.stringify([serverConfig.intentBaseUrl, serverConfig.journalModel, serverConfig.intentApiKey])).digest("hex");
  let displayName = "Configured model";
  try { displayName = new URL(serverConfig.intentBaseUrl ?? "").hostname; } catch { /* Unconfigured. */ }
  return {
    available: serverConfig.intentDriver === "http-model" && !!serverConfig.intentBaseUrl && !!serverConfig.journalModel && !!serverConfig.intentApiKey,
    baseUrl: `provider:${identity}`, model: serverConfig.journalModel ?? "", displayName,
  };
}

/** Journal, reading and hotel staging share this explicit scenario model; no fallback. */
export function configuredJournalModel(): IntentModelOptions {
  if (serverConfig.intentDriver !== "http-model" || !serverConfig.intentBaseUrl || !serverConfig.journalModel || !serverConfig.intentApiKey)
    throw new ShareIntentError("INTENT_UNAVAILABLE", "日记模型 JOURNAL_MODEL 或现有模型通道未配置；没有发送原稿，可继续手动编辑。", 503);
  return { baseUrl: serverConfig.intentBaseUrl, model: serverConfig.journalModel,
    apiKey: serverConfig.intentApiKey, timeoutMs: serverConfig.journalTimeoutMs };
}
