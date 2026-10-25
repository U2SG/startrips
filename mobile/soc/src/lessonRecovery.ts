export class MissingLessonDataError extends Error {}

/** A failed connection must never discard the saved continuation. */
export async function pendingAfterResumeFailure<T>(
  error: unknown, pending: T, clear: () => Promise<void>, assertActive: () => void,
): Promise<T | null> {
  assertActive();
  if (!(error instanceof MissingLessonDataError) && (error as { status?: number } | null)?.status !== 404) return pending;
  try { await clear(); } catch { return pending; }
  assertActive();
  return null;
}
