import { applyImport, checkRollback, hash, inspectAccount, previewImport, type Envelope } from "./journal-import";
import { pool } from "../db/client";
import { resolve } from "node:path";
import { readPrivate, writePrivate, persistBackup } from "./journal-import-files";
const limit = 2_000_000;
async function input() {
  let bytes = 0; const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error("INPUT_TOO_LARGE");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
// Hard operational bound. A killed apply has UNKNOWN outcome; inspect/replay the same plan.
const timer = setTimeout(() => { process.stderr.write('{"error":"DEADLINE_OUTCOME_UNKNOWN"}\n'); process.exit(2); }, 70_000);
try {
  const [command, ...args] = process.argv.slice(2);
  let result: unknown;
  if (command === "inspect" && args.length === 0) {
    result = { candidates: await inspectAccount((await input()).email) };
  } else if (command === "preview" && args.length === 1) {
    const request = await input();
    const e = await previewImport(request.target, request.source, request.fallbackDate);
    await writePrivate(args[0], e);
    result = { planDigest: hash(e), beforeRevision: e.plan.before.revision, afterRevision: e.plan.after.revision,
      dates: e.plan.after.chapters.map(c => c.date), chapters: e.plan.after.chapters.length,
      events: e.plan.after.chapters.reduce((n, c) => n + c.events.length, 0) };
  } else if (command === "apply" && args.length === 3) {
    if (resolve(args[0]) === resolve(args[2])) throw new Error("DISTINCT_BACKUP_REQUIRED");
    const e = await readPrivate(args[0]);
    result = await applyImport(e, args[1], (backup: Envelope) => persistBackup(args[2], backup));
  } else if (command === "rollback-check" && args.length === 1) {
    result = await checkRollback(await readPrivate(args[0]));
  } else throw new Error("INVALID_ARGUMENTS");
  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  const message = error instanceof Error ? error.message : "FAILED";
  // Never print source-containing parser errors, SQL values, paths, or connection details.
  process.stderr.write(JSON.stringify({ error: /^[A-Z_]+$/.test(message) ? message : "IMPORT_FAILED" }) + "\n");
  process.exitCode = 1;
} finally { await pool.end(); clearTimeout(timer); }
