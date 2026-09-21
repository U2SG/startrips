import type { MultipartStorage } from "./multipart-storage";

export type DerivedObjectCleanup = {
  findReferencedKeys: (keys: string[]) => Promise<Array<{ key: string | null }>>;
  discardObject: (storageDriver: string, storageKey: string) => Promise<boolean>;
};

type DerivedObjectWrite = {
  id: string;
  storageDriver: string;
  storageKey: string;
};

/** Each generation gets a fresh key; an unbound retired key is never rebound. */
export async function retireDerivedObjectWrites(
  writes: DerivedObjectWrite[],
  cleanup: DerivedObjectCleanup,
  deleteWrite: (id: string) => Promise<unknown>,
) {
  const referenced = new Set(writes.length
    ? (await cleanup.findReferencedKeys(writes.map((write) => write.storageKey)))
      .map((row) => row.key)
    : []);
  let retired = 0;
  let settled = 0;
  for (const write of writes) {
    if (referenced.has(write.storageKey)) {
      settled += 1;
    } else {
      if (!await cleanup.discardObject(write.storageDriver, write.storageKey)) continue;
      retired += 1;
    }
    await deleteWrite(write.id);
  }
  return { examined: writes.length, retired, settled };
}

/** Only a completed pass returns a new cursor to its caller. */
export async function reconcileDerivedObjectNamespace(
  storage: MultipartStorage,
  prefix: string,
  pagesPerPass: number,
  continuationToken: string | undefined,
  cleanup: DerivedObjectCleanup,
) {
  let cursor = continuationToken;
  let examined = 0;
  let retired = 0;
  for (let page = 0; page < pagesPerPass; page += 1) {
    const listed = await storage.listObjects({
      prefix,
      ...(cursor ? { continuationToken: cursor } : {}),
    });
    examined += listed.keys.length;
    if (listed.keys.length > 0) {
      const referenced = new Set(
        (await cleanup.findReferencedKeys(listed.keys)).map((row) => row.key),
      );
      for (const key of listed.keys) {
        if (referenced.has(key)) continue;
        if (await cleanup.discardObject(storage.driver, key)) retired += 1;
      }
    }
    cursor = listed.continuationToken;
    if (!cursor) break;
  }
  return { examined, retired, continuationToken: cursor };
}
