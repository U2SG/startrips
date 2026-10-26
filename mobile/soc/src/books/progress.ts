import type { Bookmark } from './model.ts';

/** Refresh a conflicting revision once; local progress is saved by the caller first. */
export async function syncProgress(next: Bookmark, deps: {
  read(): Promise<Bookmark | null>; write(bookmark: Bookmark): Promise<void>;
}) {
  try { await deps.write(next); }
  catch (error) {
    if ((error as { status?: number }).status !== 409) throw error;
    const remote = await deps.read();
    // A delayed checkpoint must never overwrite a more recent listening position.
    if (remote?.version === 1 && Number.isFinite(remote.savedAt) && remote.savedAt >= next.savedAt) return;
    await deps.write(next);
  }
}
