/**
 * One-shot first-time moments. Each answers a single question about a
 * business result that has already been committed; neither moment delays or
 * gates that result.
 */

/**
 * The first Journey to arrive in an empty Atlas. Only an initial save that
 * hands off a Journey arrival qualifies (`arrivalJourneyId` is null for edits,
 * media retries and later callbacks), and only when the Atlas had no Journey
 * before this save.
 */
export function isFirstJourneyArrival({
  journeyCountBeforeSave,
  arrivalJourneyId,
}: {
  journeyCountBeforeSave: number;
  arrivalJourneyId: string | null;
}): boolean {
  return arrivalJourneyId !== null && journeyCountBeforeSave === 0;
}

/**
 * The first media added to a Journey that had none. A retry of a failed
 * upload never qualifies, even if the Journey is still empty.
 */
export function isFirstJourneyMedia({
  mediaCountBeforeUpload,
  uploadedCount,
  retry,
}: {
  mediaCountBeforeUpload: number;
  uploadedCount: number;
  retry: boolean;
}): boolean {
  return !retry && mediaCountBeforeUpload === 0 && uploadedCount > 0;
}

let arrivalBloomScopeSequence = 0;

/**
 * The persistent globe outlives every Atlas owner mount (organization switch,
 * gateway revision, account switch), while each owner restarts its bloom
 * revisions. A per-mount scope keeps one owner's consumed bloom from
 * swallowing the next owner's first arrival.
 */
export function createArrivalBloomScope(): string {
  arrivalBloomScopeSequence += 1;
  return `atlas-owner-${arrivalBloomScopeSequence}`;
}
