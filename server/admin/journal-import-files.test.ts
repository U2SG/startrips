import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
const faults = vi.hoisted(() => ({ file: false, directory: false, synced: [] as string[] }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const f = await actual.open(...args); const sync = f.sync.bind(f);
    f.sync = async () => {
      const kind = (await f.stat()).isDirectory() ? "directory" : "file";
      faults.synced.push(kind);
      if (faults[kind]) throw new Error("SYNC_FAILED");
      await sync();
    };
    return f;
  } };
});
import { persistBackup } from "./journal-import-files";
let directory: string;
afterEach(async () => { faults.file = false; faults.directory = false; faults.synced = []; if (directory) await rm(directory, { recursive: true, force: true }); });
it.each(["file", "directory"] as const)("retries must resync existing backup after %s sync failure", async kind => {
  directory = await mkdtemp(join(tmpdir(), "journal-backup-")); const path = join(directory, "backup.json");
  const data = { private: "synthetic evidence" }; faults[kind] = true;
  await expect(persistBackup(path, data)).rejects.toThrow("SYNC_FAILED");
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(data);
  // EEXIST is not evidence that prior bytes were durably committed.
  await expect(persistBackup(path, data)).rejects.toThrow("SYNC_FAILED");
  faults[kind] = false; faults.synced = [];
  await persistBackup(path, data);
  expect(faults.synced).toEqual(["file", "directory"]);
  await expect(persistBackup(path, { changed: true })).rejects.toThrow();
});
