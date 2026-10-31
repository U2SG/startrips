import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { hash } from "./journal-import";
const limit = 2_000_000;
const fail = () => { throw new Error("PRIVATE_FILE_REQUIRED"); };
async function privateDirectory(path: string) {
  const parent = dirname(path);
  if (!isAbsolute(path) || await realpath(parent) !== resolve(parent)) fail();
  const s = await stat(parent);
  if (!s.isDirectory() || (s.mode & 0o077) !== 0 || s.uid !== process.getuid?.()) fail();
}
export async function readPrivate(path: string, durable = false) {
  await privateDirectory(path);
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await f.stat();
    if (!s.isFile() || s.size > limit || (s.mode & 0o077) !== 0 || s.uid !== process.getuid?.()) fail();
    const value = JSON.parse(await f.readFile("utf8"));
    if (durable) await f.sync();
    return value;
  } finally { await f.close(); }
}
export async function writePrivate(path: string, value: unknown) {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > limit) throw new Error("PRIVATE_FILE_TOO_LARGE");
  await privateDirectory(path);
  const f = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await f.writeFile(serialized); await f.sync(); } finally { await f.close(); }
  const directory = await open(dirname(path), constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}
export async function persistBackup(path: string, value: unknown) {
  try { await writePrivate(path, value); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || hash(await readPrivate(path, true)) !== hash(value)) throw error;
    const directory = await open(dirname(path), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
