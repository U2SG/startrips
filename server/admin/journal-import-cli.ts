import { importDiagnostic } from "./journal-import-diagnostic";
import { previewImportedHotels, applyImportedHotels } from "./journal-hotel-import";
import { prepareAuthorizedJournalImport } from "../itinerary/journal-import-service";
import { applyImport, checkRollback, readImportState, hash, inspectAccount, previewImport, type Envelope } from "./journal-import";
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
const [command, ...args] = process.argv.slice(2);
try {
  let result: unknown;
  if (command === "inspect" && args.length === 0) {
    result = { candidates: await inspectAccount((await input()).email) };
  } else if ((command === "preview" || command === "llm-preview") && args.length === 1) {
    const request = await input();
    const e = command === "llm-preview" ? await prepareAuthorizedJournalImport(request.target, request) : await previewImport(request.target, request.source, request.fallbackDate);
    await writePrivate(args[0], e);
    const events = e.plan.after.chapters.filter(c => e.plan.importedChapterIds.includes(c.id)).flatMap(c => c.events);
    result = { stage: "journal-preview", mode: command === "llm-preview" ? "model" : "deterministic", provider: e.plan.provider ?? null, planVersion: e.plan.version, planDigest: hash(e), beforeRevision: e.plan.before.revision, afterRevision: e.plan.after.revision,
      dates: e.plan.after.chapters.map(c => c.date), chapters: e.plan.after.chapters.length,
      events: events.length, statuses: Object.fromEntries(["actual", "planned", "cancelled", "uncertain"].map(status => [status, events.filter(e => e.status === status).length])),
      localClocks: events.filter(e => e.localTime !== null).length, timeRanges: events.filter(e => e.timeContext.startsWith("当地时间区间 ")).length };
  } else if (command === "apply" && args.length === 3) {
    if (resolve(args[0]) === resolve(args[2])) throw new Error("DISTINCT_BACKUP_REQUIRED");
    const e = await readPrivate(args[0]);
    result = await applyImport(e, args[1], (backup: Envelope) => persistBackup(args[2], backup));
  } else if (command === "hotels-preview" && args.length === 2) {
    const request = await input();
    const e = await previewImportedHotels(await readPrivate(args[0]), request.provider);
    await writePrivate(args[1], e);
    result = { stage: "hotel-preview", planDigest: hash(e), unresolved: e.checkpoint.questions.length };
  } else if (command === "hotels-apply" && args.length === 3) {
    if (resolve(args[0]) === resolve(args[2])) throw new Error("DISTINCT_BACKUP_REQUIRED");
    result = await applyImportedHotels(await readPrivate(args[0]), args[1], e => persistBackup(args[2], e));
  } else if (command === "readback" && args.length === 2) {
    const snapshot = await readImportState(await readPrivate(args[0]));
    await writePrivate(args[1], snapshot);
    result = { stage: "readback", journalRevision: snapshot.journal.revision, journeyRevision: snapshot.journey.revision,
      chapters: snapshot.journal.chapters.length, points: snapshot.journey.routePoints.length, snapshotDigest: hash(snapshot) };
  } else if (command === "rollback-check" && args.length === 1) {
    result = await checkRollback(await readPrivate(args[0]));
  } else throw new Error("INVALID_ARGUMENTS");
  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  // Stable allowlisted metadata only; never serialize messages, causes or provider bodies.
  process.stderr.write(JSON.stringify(importDiagnostic(error, command)) + "\n");
  process.exitCode = 1;
} finally { await pool.end(); clearTimeout(timer); }
