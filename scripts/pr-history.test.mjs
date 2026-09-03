import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseLedgerText, readLedgerEntries, renderAggregate } from "./pr-history.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
function ledger(number, title = "Test ledger") {
  return `# PR #${number} - ${title}\n\n- **Source head:** \`${SHA}\`\n- **Scope:** Scope.\n- **User-visible change:** None.\n- **Review fixes:** None.\n- **Follow-up:** None.\n- **Validation:** CI.\n`;
}

test("parses a complete sharded ledger", () => {
  const entry = parseLedgerText(ledger(192), "192.md");
  assert.equal(entry.number, 192);
  assert.equal(entry.sourceHead, SHA);
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
