import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { parseLedgerText, readLedgerEntries, renderAggregate, validatePrLedger } from "./pr-history.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
function ledger(number, title = "Test ledger") {
  return `# PR #${number} - ${title}\n\n- **Source head:** \`${SHA}\`\n- **Scope:** Scope.\n- **User-visible change:** None.\n- **Review fixes:** None.\n- **Follow-up:** None.\n- **Validation:** CI.\n`;
}

test("parses a complete sharded ledger", () => {
  const entry = parseLedgerText(ledger(192), "192.md");
  assert.equal(entry.number, 192);
  assert.equal(entry.sourceHead, SHA);
});

test("rejects duplicate Source head fields", () => {
  const text = ledger(192).replace(
    `- **Scope:** Scope.`,
    `- **Source head:** \`${"f".repeat(40)}\`\n- **Scope:** Scope.`,
  );
  assert.throws(() => parseLedgerText(text, "192.md"), /duplicate required field 'Source head'/);
});

test("rejects duplicate non-source required fields", () => {
  const text = ledger(192).replace(
    `- **Follow-up:** None.`,
    `- **Follow-up:** First.\n- **Follow-up:** Second.`,
  );
  assert.throws(() => parseLedgerText(text, "192.md"), /duplicate required field 'Follow-up'/);
});

test("rejects missing required fields", () => {
  assert.throws(() => parseLedgerText(`# PR #192 - Missing fields\n\n- **Source head:** \`${SHA}\`\n`, "192.md"), /missing required field/);
});

test("requires filename and heading PR numbers to match", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "startrips-ledger-"));
  fs.writeFileSync(path.join(dir, "193.md"), ledger(192));
  assert.throws(() => readLedgerEntries(dir), /does not match filename/);
});

test("renders newest PR first without modifying the source files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "startrips-ledger-"));
  fs.writeFileSync(path.join(dir, "191.md"), ledger(191, "Older"));
  fs.writeFileSync(path.join(dir, "192.md"), ledger(192, "Newer"));
  const rendered = renderAggregate(readLedgerEntries(dir));
  assert.ok(rendered.indexOf("PR #192") < rendered.indexOf("PR #191"));
  assert.match(rendered, /Historical entries before ledger sharding/);
});

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createGitFixture({ mutateLegacy = false, foreignLedger = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "startrips-ledger-git-"));
  fs.mkdirSync(path.join(dir, "docs", "pr-history"), { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "ledger-test@example.com");
  git(dir, "config", "user.name", "Ledger Test");
  git(dir, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(dir, "docs", "pr-history.md"), "# Legacy archive\n");
  fs.writeFileSync(path.join(dir, "app.txt"), "base\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
  const baseSha = git(dir, "rev-parse", "HEAD");

  fs.writeFileSync(path.join(dir, "app.txt"), "code\n");
  if (mutateLegacy) fs.appendFileSync(path.join(dir, "docs", "pr-history.md"), "changed\n");
  if (foreignLedger) fs.writeFileSync(path.join(dir, "docs", "pr-history", "191.md"), ledger(191));
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "code");
  const sourceHead = git(dir, "rev-parse", "HEAD");

  fs.writeFileSync(path.join(dir, "docs", "pr-history", "192.md"), ledger(192).replace(SHA, sourceHead));
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "ledger");
  const headSha = git(dir, "rev-parse", "HEAD");
  return { dir, baseSha, sourceHead, headSha };
}

test("validates a PR whose only post-source change is its own ledger", () => {
  const fixture = createGitFixture();
  const entry = validatePrLedger({
    prNumber: 192,
    baseSha: fixture.baseSha,
    headSha: fixture.headSha,
    root: fixture.dir,
    ledgerDir: path.join(fixture.dir, "docs", "pr-history"),
  });
  assert.equal(entry.sourceHead, fixture.sourceHead);
});

test("rejects PRs that still modify the frozen legacy archive", () => {
  const fixture = createGitFixture({ mutateLegacy: true });
  assert.throws(() => validatePrLedger({
    prNumber: 192,
    baseSha: fixture.baseSha,
    headSha: fixture.headSha,
    root: fixture.dir,
    ledgerDir: path.join(fixture.dir, "docs", "pr-history"),
  }), /legacy docs\/pr-history\.md is frozen/);
});

test("rejects PRs that modify another PR's numeric ledger", () => {
  const fixture = createGitFixture({ foreignLedger: true });
  assert.throws(() => validatePrLedger({
    prNumber: 192,
    baseSha: fixture.baseSha,
    headSha: fixture.headSha,
    root: fixture.dir,
    ledgerDir: path.join(fixture.dir, "docs", "pr-history"),
  }), /modifies another PR ledger/);
});


test("rejects symlinked numeric ledger entries", { skip: process.platform === "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "startrips-ledger-symlink-"));
  const ledgerDir = path.join(dir, "docs", "pr-history");
  fs.mkdirSync(ledgerDir, { recursive: true });
  const target = path.join(dir, "ledger-target.md");
  fs.writeFileSync(target, ledger(192));
  fs.symlinkSync(target, path.join(ledgerDir, "192.md"));
  assert.throws(() => readLedgerEntries(ledgerDir), /regular non-symlink file/);
});


test("rejects renaming another PR ledger into the current PR ledger", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "startrips-ledger-rename-"));
  const ledgerDir = path.join(dir, "docs", "pr-history");
  fs.mkdirSync(ledgerDir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "ledger-test@example.com");
  git(dir, "config", "user.name", "Ledger Test");
  git(dir, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(dir, "docs", "pr-history.md"), "# Legacy archive\n");
  fs.writeFileSync(path.join(ledgerDir, "191.md"), ledger(191));
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
  const baseSha = git(dir, "rev-parse", "HEAD");

  fs.writeFileSync(path.join(dir, "app.txt"), "code\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "code");
  const sourceHead = git(dir, "rev-parse", "HEAD");

  fs.renameSync(path.join(ledgerDir, "191.md"), path.join(ledgerDir, "192.md"));
  fs.writeFileSync(path.join(ledgerDir, "192.md"), ledger(192).replace(SHA, sourceHead));
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "rename ledger");
  const headSha = git(dir, "rev-parse", "HEAD");

  assert.throws(() => validatePrLedger({
    prNumber: 192,
    baseSha,
    headSha,
    root: dir,
    ledgerDir,
  }), /code drift after Source head|modifies another PR ledger/);
});
