// 学习统计：闪卡复习数据与教材进度的纯计算，供仪表盘、闪卡页、推送复用。
// 全部基于已落盘的 flashcards/*.json 与 textbook_index.json + progress.md，不引新存储。
import * as data from './data';
import type { FlashcardFile } from './data';

export function localDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 连续复习天数：从所有卡片答题历史取日期集合，从今天往回数 */
export function dayStreakOf(files: FlashcardFile[]): number {
  const days = new Set<string>();
  for (const f of files) for (const c of f.cards) for (const h of c.history) days.add(localDay(h.time));
  let streak = 0;
  const cursor = new Date();
  while (days.has(localDay(cursor.toISOString()))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

/** 下一批到期：最近的未来 nextReview 日期及该日期的张数 */
export function nextBatchOf(files: FlashcardFile[]): { day: string; count: number } | null {
  const now = new Date().toISOString();
  let minDay: string | null = null;
  const byDay = new Map<string, number>();
  for (const f of files) {
    for (const c of f.cards) {
      if (c.status !== 'active' || !c.nextReview || c.nextReview <= now) continue;
      const day = localDay(c.nextReview);
      byDay.set(day, (byDay.get(day) || 0) + 1);
      if (!minDay || day < minDay) minDay = day;
    }
  }
  return minDay ? { day: minDay, count: byDay.get(minDay) || 0 } : null;
}

/** 现在到期（含从未复习过的新卡）的张数——闪卡页「今日待复习」与推送都用这个口径 */
export function dueCount(files: FlashcardFile[]): number {
  const now = new Date().toISOString();
  let n = 0;
  for (const f of files) for (const c of f.cards) {
    if (c.status === 'active' && (!c.nextReview || c.nextReview <= now)) n++;
  }
  return n;
}

export type StudyStats = {
  dayStreak: number;
  totalCards: number;
  dueNow: number;
  nextBatch: { day: string; count: number } | null;
  reviewsTotal: number;     // 累计答题次数
  reviewsCorrect: number;   // 累计答对次数
  reviews7d: number;        // 近 7 天答题次数
  masteredCards: number;    // 连对 ≥3 次的卡（视为已掌握）
  books: { title: string; currentPage: number; numPages: number }[];
  lastStudyDate?: string;
};

/** 读取一个世界的全部闪卡文件 */
export async function loadAllFlashcards(worldId: string): Promise<FlashcardFile[]> {
  const ids = await data.listFlashcardFiles(worldId);
  return Promise.all(ids.map((id) => data.readFlashcards(worldId, id)));
}

/** 末尾连对次数（用于「已掌握」判定） */
function trailingStreak(card: data.Flashcard): number {
  let n = 0;
  for (let i = card.history.length - 1; i >= 0 && card.history[i].correct; i--) n++;
  return n;
}

/** 汇总一个世界的学习统计（仪表盘用） */
export async function computeStudyStats(worldId: string): Promise<StudyStats> {
  const files = await loadAllFlashcards(worldId);
  const sevenAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  let total = 0, reviewsTotal = 0, reviewsCorrect = 0, reviews7d = 0, mastered = 0;
  for (const f of files) for (const c of f.cards) {
    if (c.status !== 'active') continue;
    total++;
    if (trailingStreak(c) >= 3) mastered++;
    for (const h of c.history) {
      reviewsTotal++;
      if (h.correct) reviewsCorrect++;
      if (h.time >= sevenAgo) reviews7d++;
    }
  }

  let books: StudyStats['books'] = [];
  let lastStudyDate: string | undefined;
  try {
    const idx = await data.readTextbookIndex(worldId);
    books = await Promise.all(idx.textbooks.map(async (t) => {
      const head = data.parseProgressPage(await data.readProgress(worldId, t).catch(() => null));
      return { title: t.title, currentPage: Math.max(head ?? 0, t.currentPage), numPages: t.numPages };
    }));
  } catch { /* 没连上则无教材进度 */ }
  try { lastStudyDate = (await data.readWorldMeta(worldId)).lastStudyDate; } catch { /* ignore */ }

  return {
    dayStreak: dayStreakOf(files),
    totalCards: total,
    dueNow: dueCount(files),
    nextBatch: nextBatchOf(files),
    reviewsTotal, reviewsCorrect, reviews7d,
    masteredCards: mastered,
    books,
    lastStudyDate,
  };
}
