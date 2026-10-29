import type { DailyJournal, JournalChapter, JournalSuggestion } from "./dailyJournal";
export type DailyJournalClient = {
  read: (id: string, signal: AbortSignal) => Promise<DailyJournal>;
  save: (id: string, journal: DailyJournal, signal: AbortSignal) => Promise<DailyJournal>;
  suggest: (id: string, chapters: JournalChapter[], signal: AbortSignal) => Promise<JournalSuggestion[]>;
};
async function request(id: string, suffix: string, method: string, body: unknown, signal: AbortSignal) {
  const response = await fetch(`/api/journeys/${encodeURIComponent(id)}/journal${suffix}`, {
    method, signal, credentials: "include", headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(response.status === 409
    ? "手记已在其他页面更新。请保留当前草稿，重新打开后合并。"
    : payload?.message ?? `手记操作失败（${payload?.error ?? response.status}）；草稿仍保留，可手动编辑。`);
  if (!payload) throw new Error("服务器未返回有效手记；草稿仍保留，请稍后重试。");
  return payload;
}
export const dailyJournalClient: DailyJournalClient = {
  read: async (id, signal) => (await request(id, "", "GET", undefined, signal)).journal,
  save: async (id, journal, signal) => (await request(id, "", "PUT", { baseRevision: journal.revision, chapters: journal.chapters }, signal)).journal,
  suggest: async (id, chapters, signal) => (await request(id, "/suggest", "POST", { chapters }, signal)).suggestions,
};
