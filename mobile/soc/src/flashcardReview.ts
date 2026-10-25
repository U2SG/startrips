import type { Flashcard, FlashcardFile } from './data';

/** 连续答对次数 → 间隔天数；答错回到 1 天 */
const SRS_INTERVALS = [1, 3, 7, 14, 30, 60];

export function nextReviewAfter(card: Flashcard, correct: boolean, now: Date): string {
  let streak = 0;
  if (correct) {
    streak = 1;
    for (let i = card.history.length - 1; i >= 0 && card.history[i].correct; i--) streak++;
  }
  const days = correct ? SRS_INTERVALS[Math.min(streak - 1, SRS_INTERVALS.length - 1)] : 1;
  // 对齐桌面版习惯：UTC 16:00（即北京时间次日 0 点）
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days, 16, 0, 0));
  return d.toISOString();
}

/** Persist a copied answer before changing the in-memory queue or counters. */
export async function saveFlashcardAnswer(
  file: FlashcardFile, card: Flashcard, chosen: number, now: Date,
  save: (next: FlashcardFile) => Promise<void>,
): Promise<void> {
  const correct = chosen === card.correctIndex;
  const reviewed = {
    ...card,
    history: [...card.history, { time: now.toISOString(), chosen, correct }],
    nextReview: nextReviewAfter(card, correct, now),
  };
  const updated = { ...file, cards: file.cards.map((entry) => entry.id === card.id ? reviewed : entry) };
  await save(updated);
  Object.assign(card, reviewed);
  file.updatedAt = updated.updatedAt;
}
