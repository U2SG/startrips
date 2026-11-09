import { db } from "../db/client";
import { configuredJournalModel, journalProviderInfo } from "./journal-model";
export { journalProviderInfo } from "./journal-model";
import { hash, lockedTarget, sealJournalDraft, type Target } from "../admin/journal-import";
import { normalizeJournalReferences } from "../repositories/daily-journal-repository";
import { prepareJournalImport } from "./journal-import-workflow";
import type { IntentModelOptions } from "../intents/intent-model-request";
import { ShareIntentError } from "../intents/create-share-intent";
export const journalImportDependencies: { fetcher?: typeof fetch } = {};
export function journalImportModel(consent: unknown): IntentModelOptions {
  const acknowledged = consent as { baseUrl?: string; model?: string } | null;
  const model = configuredJournalModel();
  if ((acknowledged?.baseUrl !== model.baseUrl && acknowledged?.baseUrl !== journalProviderInfo().baseUrl) || acknowledged?.model !== model.model)
    throw new ShareIntentError("JOURNAL_PROVIDER_CONFIRMATION_REQUIRED", "请确认接收原稿的当前模型通道；没有发送原稿。", 400);
  return { ...model, fetcher: journalImportDependencies.fetcher };
}
export async function prepareAuthorizedJournalImport(target: Target, input: { sentence: string; source: string; fallbackDate: string; provider: unknown }, model = journalImportModel(input.provider), signal?: AbortSignal) {
  const before = await db.transaction(tx => lockedTarget(tx, target));
  const checkCurrent = async () => {
    await model.checkCurrent?.();
    const currentModel = journalImportModel(input.provider);
    if (hash([currentModel.baseUrl, currentModel.model, currentModel.apiKey]) !== hash([model.baseUrl, model.model, model.apiKey])) throw new Error("JOURNAL_PROVIDER_CHANGED");
    if (hash(await db.transaction(tx => lockedTarget(tx, target))) !== hash(before)) throw new Error("JOURNAL_CHANGED");
  };
  const draft = await prepareJournalImport(input, before, { ...model, signal: signal ?? model.signal, checkCurrent });
  return db.transaction(async tx => {
    if (hash(await lockedTarget(tx, target)) !== hash(before)) throw new Error("JOURNAL_CHANGED");
    const chapters = await normalizeJournalReferences(target.journeyId, before.chapters, draft.chapters, tx, draft.placeClaims);
    return sealJournalDraft(target, input.source, before, chapters, draft.importedChapterIds, { baseUrl: journalProviderInfo().baseUrl, model: model.model });
  });
}
