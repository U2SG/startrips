import {
  deleteJourneyForAtlas,
  deferJourneyDeletionRetryForAtlas,
  getJourneyDeletionCandidateForAtlas,
  listJourneysPendingDeletion,
  markJourneyForDeletionForAtlas,
} from "../repositories/journey-repository";
import type { MultipartStorage } from "../storage/multipart-storage";
import { getMultipartStorage } from "../storage/storage-registry";

const DELETION_RECONCILE_INTERVAL_MS = 5 * 60 * 1_000;

export type DeleteJourneyDependencies = {
  markForDeletion: typeof markJourneyForDeletionForAtlas;
  getCandidate: typeof getJourneyDeletionCandidateForAtlas;
  deleteJourney: typeof deleteJourneyForAtlas;
  deferRetry: typeof deferJourneyDeletionRetryForAtlas;
  listPending: typeof listJourneysPendingDeletion;
  storageForBackend: (backendId: string) => MultipartStorage;
  onCleanupError: (journeyId: string, error: unknown) => void;
};

const defaultDependencies: DeleteJourneyDependencies = {
  markForDeletion: markJourneyForDeletionForAtlas,
  getCandidate: getJourneyDeletionCandidateForAtlas,
  deleteJourney: deleteJourneyForAtlas,
  deferRetry: deferJourneyDeletionRetryForAtlas,
  listPending: listJourneysPendingDeletion,
  storageForBackend: getMultipartStorage,
  onCleanupError(journeyId, error) {
    console.error(
      "Journey deletion cleanup failed",
      journeyId,
      error instanceof Error ? error.message : "unknown error",
    );
  },
};

function storageReference(storageDriver: string, storageKey: string) {
  return `${storageDriver}\0${storageKey}`;
}

async function recordCleanupFailure(
  journeyId: string,
  atlasId: string,
  error: unknown,
  dependencies: DeleteJourneyDependencies,
) {
  try {
    await dependencies.deferRetry(journeyId, atlasId);
  } catch (retryError) {
    dependencies.onCleanupError(journeyId, retryError);
  }
  dependencies.onCleanupError(journeyId, error);
}

async function finishJourneyDeletion(
  journeyId: string,
  atlasId: string,
  dependencies: DeleteJourneyDependencies,
) {
  const candidate = await dependencies.getCandidate(journeyId, atlasId);
  if (!candidate) return;

  const deletedObjects = new Set<string>();
  for (const asset of candidate.media) {
    const reference = storageReference(asset.storageDriver, asset.storageKey);
    if (deletedObjects.has(reference)) continue;
    await dependencies.storageForBackend(asset.storageDriver).deleteObject({
      key: asset.storageKey,
    });
    deletedObjects.add(reference);
  }

  for (const upload of candidate.uploads) {
    const reference = storageReference(upload.storageDriver, upload.storageKey);
    if (deletedObjects.has(reference)) continue;
    const storage = dependencies.storageForBackend(upload.storageDriver);
    const inspected = await storage.inspectObject({ key: upload.storageKey });
    if (inspected.exists) {
      await storage.deleteObject({ key: upload.storageKey });
    } else {
      await storage.abortMultipartUpload({
        key: upload.storageKey,
        providerUploadId: upload.providerUploadId,
      });
    }
    deletedObjects.add(reference);
  }

  await dependencies.deleteJourney(journeyId, atlasId);
}

export async function deleteJourneyWithStorage(
  journeyId: string,
  atlasId: string,
  dependencies: DeleteJourneyDependencies = defaultDependencies,
) {
  const marked = await dependencies.markForDeletion(journeyId, atlasId);
  if (!marked) return undefined;
  // The reconciler performs physical cleanup after the recovery grace period.
  return marked;
}

export async function reconcileJourneyDeletionCandidates(
  candidates: Array<{ id: string; atlasId: string }>,
  dependencies: DeleteJourneyDependencies = defaultDependencies,
) {
  for (const candidate of candidates) {
    try {
      await finishJourneyDeletion(candidate.id, candidate.atlasId, dependencies);
    } catch (error) {
      await recordCleanupFailure(
        candidate.id,
        candidate.atlasId,
        error,
        dependencies,
      );
    }
  }
}

export async function reconcilePendingJourneyDeletions(
  dependencies: DeleteJourneyDependencies = defaultDependencies,
) {
  await reconcileJourneyDeletionCandidates(
    await dependencies.listPending(),
    dependencies,
  );
}

export function startJourneyDeletionReconciler() {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await reconcilePendingJourneyDeletions();
    } catch (error) {
      defaultDependencies.onCleanupError("reconciliation-pass", error);
    } finally {
      running = false;
    }
  };
  void run();
  const interval = setInterval(run, DELETION_RECONCILE_INTERVAL_MS);
  interval.unref();
}
