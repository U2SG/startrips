import { randomUUID } from "node:crypto";
import { mkdtemp, chmod, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../db/client";
import { atlases, journeys } from "../db/app-schema";
import { user, member, organization } from "../db/auth-schema";
import { applyImport, checkRollback, hash, inspectAccount, previewImport, validateEnvelope, type Target } from "../admin/journal-import";
import { readDailyJournal, writeDailyJournal } from "../repositories/daily-journal-repository";
import { previewJournalImport } from "../../src/journey/dailyJournal";
let target: Target; let org: string; let directory: string;
let plan: string, backup: string, digest: string;
const source = "2027年5月1日（虚构一天）\n实际：23:30 她出发\n计划：花园\n取消：山路\n2027年5月2日(第二天)\n18:20 她抵达";
async function cli(args: string[], input?: unknown) {
  return new Promise<{ code: number | null; out: string; err: string }>((done, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", process.env.JOURNAL_ADMIN_TEST_ENTRY ?? resolve("server/admin/journal-import-cli.ts"), ...args], { env: process.env });
    let out = "", err = "";
    child.stdout.on("data", d => out += d); child.stderr.on("data", d => err += d);
    child.on("error", reject); child.on("close", code => done({ code, out, err }));
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  });
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "journal-admin-"));
  const userId = randomUUID(), email = `${userId}@example.test`; org = randomUUID();
  await db.insert(user).values({ id: userId, name: "Fiction", email });
  await db.insert(organization).values({ id: org, name: "Fiction", slug: org, createdAt: new Date() });
  await db.insert(member).values({ id: randomUUID(), userId, organizationId: org, role: "owner", createdAt: new Date() });
  const [atlas] = await db.insert(atlases).values({ organizationId: org, title: "Fiction" }).returning();
  const [journey] = await db.insert(journeys).values({ atlasId: atlas.id, title: "Fiction", startedOn: "2027-05-01", createdByUserId: userId }).returning();
  target = { userId, email, atlasId: atlas.id, journeyId: journey.id };
});
afterAll(async () => {
  if (target) { await db.delete(atlases).where(eq(atlases.id, target.atlasId)); await db.delete(organization).where(eq(organization.id, org)); await db.delete(user).where(eq(user.id, target.userId)); }
  if (directory) await rm(directory, { recursive: true, force: true });
  await pool.end();
});
describe("offline journal administration", () => {
  it("inspect enumerates candidates without session access; requires exact account and scope", async () => {
    expect(await inspectAccount("absent@example.test")).toEqual([]);
    expect(await inspectAccount(target.email)).toMatchObject([{ userId: target.userId, journeyId: target.journeyId }]);
    for (const changed of [{ email: "wrong@example.test" }, { userId: randomUUID() }, { atlasId: randomUUID() }, { journeyId: randomUUID() }]) {
      await expect(previewImport({ ...target, ...changed }, source, "2027-05-01")).rejects.toThrow();
    }
    await expect(previewImport(target, "2027-02-30\ntext", "2027-05-01")).rejects.toThrow("INVALID_IMPORT");
  });
  it("denies missing membership and insufficient roles; database enforces membership uniqueness", async () => {
    await db.update(member).set({ role: "viewer" }).where(eq(member.userId, target.userId));
    await expect(previewImport(target, source, "2027-05-01")).rejects.toThrow("TARGET_PERMISSION_DENIED");
    await db.update(member).set({ role: "member" }).where(eq(member.userId, target.userId));
    const duplicate = randomUUID();
    await expect(db.insert(member).values({ id: duplicate, userId: target.userId, organizationId: org, role: "owner", createdAt: new Date() })).rejects.toThrow();
    await db.delete(member).where(eq(member.userId, target.userId));
    await expect(previewImport(target, source, "2027-05-01")).rejects.toThrow("TARGET_PERMISSION_DENIED");
    await db.insert(member).values({ id: duplicate, userId: target.userId, organizationId: org, role: "member", createdAt: new Date() });
  });
  it("binds source/target/revision/chapters, rejects stale plans and failed backups", async () => {
    const e = await previewImport(target, source, "2027-05-01");
    const forged = structuredClone(e); forged.plan.after.chapters[0].events[0].text = "forged";
    expect(() => validateEnvelope(forged)).toThrow("INVALID_PLAN");
    await expect(applyImport(e, "0".repeat(64), async () => {})).rejects.toThrow("PLAN_DIGEST_MISMATCH");
    await expect(applyImport(e, hash(e), async () => { throw new Error("DISK_FULL"); })).rejects.toThrow("DISK_FULL");
    expect((await readDailyJournal(target.journeyId, target.atlasId))!.revision).toBe(0);
    const old = previewJournalImport("2027-04-30\n实际：旧记录", "2027-04-30"); old[0].events[0].edited = true; old[0].events[0].text = "人工正文";
    await writeDailyJournal(target.journeyId, target.atlasId, 0, old);
    await expect(applyImport(e, hash(e), async () => {})).rejects.toThrow("JOURNAL_CHANGED");
  });
  it("CLI inspect/preview creates a private plan without logging source", async () => {
    plan = join(directory, "plan.json"); backup = join(directory, "backup.json");
    expect((await cli(["inspect"], { email: target.email })).code).toBe(0);
    const preview = await cli(["preview", plan], { target, source, fallbackDate: "2027-05-01" });
    expect(preview.code, preview.err).toBe(0); expect(preview.out).not.toContain("她出发");
    digest = JSON.parse(preview.out).planDigest;
    expect((await stat(plan)).mode & 0o777).toBe(0o600);
  });
  it("CLI refuses unsafe backup paths before writing", async () => {
    expect((await cli(["apply", plan, digest, plan])).err).toContain("DISTINCT_BACKUP_REQUIRED");
    expect((await cli(["apply", plan, digest, join(directory, "missing", "backup.json")])).code).toBe(1);
    expect((await readDailyJournal(target.journeyId, target.atlasId))!.revision).toBe(1);
  });
  it("parallel CLI confirmations preserve edits and replay without duplication", async () => {
    const attempts = await Promise.all([cli(["apply", plan, digest, backup]), cli(["apply", plan, digest, backup])]);
    expect(attempts.map(x => x.code), JSON.stringify(attempts)).toEqual([0, 0]);
    expect(attempts.map(x => JSON.parse(x.out).state).sort()).toEqual(["already-applied", "applied"]);
    expect(await readFile(backup, "utf8")).toBe(await readFile(plan, "utf8"));
    expect((await stat(backup)).mode & 0o777).toBe(0o600);
    const journal = (await readDailyJournal(target.journeyId, target.atlasId))!;
    expect(journal.chapters).toHaveLength(3); expect(journal.chapters[0].events[0]).toMatchObject({ text: "人工正文", edited: true });
    expect(journal.chapters[1].events.map(e => e.status)).toEqual(["actual", "planned", "cancelled"]);
    const again = await previewImport(target, source, "2027-05-01");
    expect(again.plan.after).toEqual(journal);
  });
  it("rollback check refuses subsequent edits and private-file checks reject public plans", async () => {
    const journal = (await readDailyJournal(target.journeyId, target.atlasId))!;
    expect(JSON.parse((await cli(["rollback-check", backup])).out)).toMatchObject({ eligible: true });
    journal.chapters[0].events[0].text = "更新后的人工正文";
    await writeDailyJournal(target.journeyId, target.atlasId, journal.revision, journal.chapters);
    expect(await checkRollback(JSON.parse(await readFile(backup, "utf8")))).toMatchObject({ eligible: false });
    await chmod(plan, 0o644);
    expect((await cli(["apply", plan, digest, backup])).err).toContain("PRIVATE_FILE_REQUIRED");
  });
  it("rechecks revoked membership at apply and rejects deleted targets", async () => {
    const e = await previewImport(target, source + "\n新记录", "2027-05-01");
    await db.update(member).set({ role: "viewer" }).where(eq(member.userId, target.userId));
    await expect(applyImport(e, hash(e), async () => {})).rejects.toThrow("TARGET_PERMISSION_DENIED");
    await db.update(member).set({ role: "owner" }).where(eq(member.userId, target.userId));
    await db.update(journeys).set({ deletionStartedAt: new Date() }).where(eq(journeys.id, target.journeyId));
    await expect(previewImport(target, source, "2027-05-01")).rejects.toThrow("TARGET_NOT_FOUND");
  });
});
