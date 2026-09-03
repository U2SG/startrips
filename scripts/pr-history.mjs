import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_LEDGER_DIR = path.join(ROOT, "docs", "pr-history");
const REQUIRED_FIELDS = [
  "Source head",
  "Scope",
  "User-visible change",
  "Review fixes",
  "Follow-up",
  "Validation",
];

function fail(message) {
  throw new Error(message);
}

export function parseLedgerText(text, fileName = "<memory>") {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const heading = lines.find((line) => line.trim().length > 0) ?? "";
  const headingMatch = heading.match(/^# PR #(\d+)\s+[-–—]\s+(.+)$/);
  if (!headingMatch) fail(`${fileName}: first heading must be '# PR #<number> - <title>'`);

  const fields = new Map();
  for (const line of lines) {
    const match = line.match(/^- \*\*(Source head|Scope|User-visible change|Review fixes|Follow-up|Validation):\*\*\s+(.+)$/);
    if (match) fields.set(match[1], match[2].trim());
  }
  for (const field of REQUIRED_FIELDS) {
    if (!fields.get(field)) fail(`${fileName}: missing required field '${field}'`);
  }

  const sourceMatch = fields.get("Source head").match(/^`([0-9a-f]{40})`$/i);
  if (!sourceMatch) fail(`${fileName}: Source head must be one full 40-character commit SHA in backticks`);

  return {
    number: Number(headingMatch[1]),
    title: headingMatch[2].trim(),
    sourceHead: sourceMatch[1].toLowerCase(),
    fields: Object.fromEntries(fields),
    text: normalized.trimEnd() + "\n",
  };
}

export function readLedgerEntries(ledgerDir = DEFAULT_LEDGER_DIR) {
  if (!fs.existsSync(ledgerDir)) return [];
  const entries = [];
  for (const name of fs.readdirSync(ledgerDir)) {
    if (name === "README.md") continue;
    if (!name.endsWith(".md")) fail(`${name}: only Markdown ledger files are allowed`);
    const fileMatch = name.match(/^(\d+)\.md$/);
    if (!fileMatch) fail(`${name}: ledger filename must be '<PR_NUMBER>.md'`);
    const fullPath = path.join(ledgerDir, name);
    const stat = fs.lstatSync(fullPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      fail(`${name}: ledger entry must be a regular non-symlink file`);
    }
    const entry = parseLedgerText(fs.readFileSync(fullPath, "utf8"), name);
    const fileNumber = Number(fileMatch[1]);
    if (entry.number !== fileNumber) fail(`${name}: heading PR #${entry.number} does not match filename ${fileNumber}.md`);
    entries.push({ ...entry, fileName: name, fullPath });
  }
  entries.sort((a, b) => b.number - a.number);
  return entries;
}

export function validateAllLedgers(ledgerDir = DEFAULT_LEDGER_DIR) {
  const entries = readLedgerEntries(ledgerDir);
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.number)) fail(`duplicate ledger for PR #${entry.number}`);
    seen.add(entry.number);
  }
  return entries;
}

function git(args, cwd = ROOT) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function validatePrLedger({ prNumber, headSha, baseSha, root = ROOT, ledgerDir = path.join(root, "docs", "pr-history") }) {
  if (!Number.isInteger(prNumber) || prNumber <= 0) fail(`invalid PR number '${prNumber}'`);
  if (!/^[0-9a-f]{40}$/i.test(headSha)) fail(`invalid PR head SHA '${headSha}'`);
  if (!/^[0-9a-f]{40}$/i.test(baseSha)) fail(`invalid PR base SHA '${baseSha}'`);

  const fileName = `${prNumber}.md`;
  const ledgerPath = path.join(ledgerDir, fileName);
  if (!fs.existsSync(ledgerPath)) fail(`missing PR ledger docs/pr-history/${fileName}`);
  const ledgerStat = fs.lstatSync(ledgerPath);
  if (ledgerStat.isSymbolicLink() || !ledgerStat.isFile()) {
    fail(`${fileName}: ledger entry must be a regular non-symlink file`);
  }
  const entry = parseLedgerText(fs.readFileSync(ledgerPath, "utf8"), fileName);
  if (entry.number !== prNumber) fail(`${fileName}: heading targets PR #${entry.number}, expected PR #${prNumber}`);

  try {
    git(["cat-file", "-e", `${entry.sourceHead}^{commit}`], root);
  } catch {
    fail(`${fileName}: Source head ${entry.sourceHead} is not available in git history`);
  }
  try {
    git(["merge-base", "--is-ancestor", entry.sourceHead, headSha], root);
  } catch {
    fail(`${fileName}: Source head ${entry.sourceHead} is not an ancestor of PR head ${headSha}`);
  }

  const changed = git(["diff", "--no-renames", "--name-only", `${entry.sourceHead}..${headSha}`], root)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((value) => value.replace(/\\/g, "/"));
  const expected = `docs/pr-history/${fileName}`;
  const unexpected = changed.filter((name) => name !== expected);
  if (!changed.includes(expected)) fail(`${fileName}: final PR head does not add/update its ledger after Source head`);
  if (unexpected.length > 0) {
    fail(`${fileName}: code drift after Source head; only ${expected} may change, found: ${unexpected.join(", ")}`);
  }

  let prBase;
  try {
    prBase = git(["merge-base", baseSha, headSha], root);
  } catch {
    fail(`${fileName}: cannot resolve merge-base between ${baseSha} and ${headSha}`);
  }
  const prChanged = git(["diff", "--no-renames", "--name-only", `${prBase}..${headSha}`], root)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((value) => value.replace(/\\/g, "/"));
  if (prChanged.includes("docs/pr-history.md")) {
    fail("legacy docs/pr-history.md is frozen; new PRs must not modify it");
  }
  const foreignLedgers = prChanged.filter((name) => {
    const match = name.match(/^docs\/pr-history\/(\d+)\.md$/);
    return match && Number(match[1]) !== prNumber;
  });
  if (foreignLedgers.length > 0) {
    fail(`${fileName}: PR modifies another PR ledger: ${foreignLedgers.join(", ")}`);
  }

  return entry;
}

export function renderAggregate(entries = validateAllLedgers()) {
  const lines = [
    "# Startrips Pull Request History - Generated Index",
    "",
    "> Generated from `docs/pr-history/*.md`. Do not commit this generated output.",
    "> Historical entries before ledger sharding remain in `docs/pr-history.md`.",
    "",
  ];
  for (const entry of entries) {
    lines.push(entry.text.trimEnd(), "");
  }
  return lines.join("\n");
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) fail(`missing ${name}`);
  return args[index + 1];
}

export function main(argv = process.argv.slice(2)) {
  const [command] = argv;
  if (command === "validate-all") {
    const entries = validateAllLedgers();
    console.log(`validated ${entries.length} sharded PR ledger file(s)`);
    return;
  }
  if (command === "validate-pr") {
    const prNumber = Number(optionValue(argv, "--pr"));
    const headSha = optionValue(argv, "--head");
    const baseSha = optionValue(argv, "--base");
    const entry = validatePrLedger({ prNumber, headSha, baseSha });
    console.log(`validated PR #${entry.number} ledger at source ${entry.sourceHead}`);
    return;
  }
  if (command === "render") {
    const outputIndex = argv.indexOf("--output");
    const rendered = renderAggregate();
    if (outputIndex >= 0) {
      const outputPath = argv[outputIndex + 1];
      if (!outputPath) fail("missing --output path");
      fs.writeFileSync(outputPath, rendered, "utf8");
      console.log(`wrote ${outputPath}`);
    } else {
      process.stdout.write(rendered);
    }
    return;
  }
  fail("usage: node scripts/pr-history.mjs <validate-all|validate-pr|render> [...options]; validate-pr requires --pr, --base and --head");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
