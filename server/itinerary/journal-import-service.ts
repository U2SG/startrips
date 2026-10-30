import { db } from "../db/client";
import { serverConfig } from "../config";
import { lockedTarget, sealJournalDraft, type Target } from "../admin/journal-import";
import { prepareJournalImport } from "./journal-import-workflow";
import type { IntentModelOptions } from "../intents/intent-model-request";
import { ShareIntentError } from "../intents/create-share-intent";
export const journalImportDependencies: { fetcher?: typeof fetch } = {};
export function journalImportModel(consent: unknown): IntentModelOptions {
  const acknowledged = consent as { baseUrl?: string; model?: string } | null;
  if (serverConfig.intentDriver !== "http-model" || !serverConfig.intentBaseUrl || !serverConfig.intentModel || !serverConfig.intentApiKey)
    throw new ShareIntentError("INTENT_UNAVAILABLE", "当前模型通道未配置；没有发送原稿。", 503);
  if (acknowledged?.baseUrl !== serverConfig.intentBaseUrl || acknowledged?.model !== serverConfig.intentModel)
    throw new ShareIntentError("JOURNAL_PROVIDER_CONFIRMATION_REQUIRED", "请确认接收原稿的当前模型通道；没有发送原稿。", 400);
  return { baseUrl: serverConfig.intentBaseUrl, model: serverConfig.intentModel, apiKey: serverConfig.intentApiKey,
    timeoutMs: serverConfig.intentTimeoutMs, fetcher: journalImportDependencies.fetcher };
}
export async function prepareAuthorizedJournalImport(target: Target, input: { sentence: string; source: string; fallbackDate: string; provider: unknown }, model = journalImportModel(input.provider)) {
  const before = await db.transaction(tx => lockedTarget(tx, target));
  const draft = await prepareJournalImport(input, before, model);
  return sealJournalDraft(target, input.source, before, draft.chapters, draft.importedChapterIds, { baseUrl: model.baseUrl, model: model.model });
}
