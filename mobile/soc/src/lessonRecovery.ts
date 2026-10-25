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
