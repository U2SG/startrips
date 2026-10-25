export class MissingLessonDataError extends Error {}

export async function requiredLessonData<T>(operation: Promise<T>, message: string): Promise<T> {
  try { return await operation; } catch (error) {
    if ((error as { status?: number } | null)?.status === 404) throw new MissingLessonDataError(message);
    throw error;
  }
}

/** A failed connection must never discard the saved continuation. */
export async function pendingAfterResumeFailure<T>(
  error: unknown, pending: T, clear: () => Promise<void>, assertActive: () => void,
): Promise<T | null> {
  assertActive();
  if (!(error instanceof MissingLessonDataError)) return pending;
  try { await clear(); } catch { return pending; }
  assertActive();
  return null;
}

export type LessonPointer = { worldId: string; textbookId: string; convId: string };
export function parseLessonPointer(raw: string | null): LessonPointer | null {
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || ['worldId', 'textbookId', 'convId'].some((key) => typeof (value as Record<string, unknown>)[key] !== 'string' || !(value as Record<string, string>)[key])) {
    throw new Error('课程指针无法读取，请重试');
  }
  return value as LessonPointer;
}

/** A new lesson requires an authoritative successful read, even if UI state is stale. */
export async function startAfterPointer<P, T>(
  load: () => Promise<P | null>, assertActive: () => void,
  onRead: (pointer: P | null) => void, begin: () => Promise<T>,
): Promise<T> {
  const pointer = await load();
  assertActive();
  onRead(pointer);
  if (pointer) throw new Error('请先继续未下课的课程');
  return begin();
}
