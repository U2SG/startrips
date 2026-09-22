import { execFileSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const CHECKED_ROOTS = ["src/", "server/"];
const MODULE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

function moduleSpecifier(filePath) {
  const extension = MODULE_EXTENSIONS.find((candidate) => filePath.endsWith(candidate));
  return extension ? filePath.slice(0, -extension.length) : filePath;
}

function group(paths, key) {
  const groups = new Map();
  for (const filePath of paths) {
    const bucket = key(filePath).toLowerCase();
    const members = groups.get(bucket);
    if (members) members.add(filePath);
    else groups.set(bucket, new Set([filePath]));
  }
  return groups;
}

function collect(groups, kind, collisions) {
  for (const [bucket, members] of groups) {
    if (members.size < 2) continue;
    collisions.push({ kind, key: bucket, paths: [...members].sort() });
  }
}

/**
 * Report pairs of tracked paths a case-insensitive filesystem cannot keep apart.
 * Two files whose paths differ only in case collide outright; two modules whose
 * paths differ only in case once the final module extension is dropped collide
 * at the import specifier, which is what TypeScript reports as TS1149.
 */
export function findCaseCollisions(trackedPaths) {
  const checked = trackedPaths.filter((filePath) =>
    CHECKED_ROOTS.some((root) => filePath.startsWith(root)),
  );
  const collisions = [];
  collect(group(checked, (filePath) => filePath), "path", collisions);
  collect(group(checked, moduleSpecifier), "module specifier", collisions);
  const seen = new Set();
  return collisions
    .filter((collision) => {
      const identity = collision.paths.join(" ");
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function trackedPaths(cwd = process.cwd()) {
  return execFileSync("git", ["ls-files", ...CHECKED_ROOTS], { cwd, encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function main() {
  const collisions = findCaseCollisions(trackedPaths());
  if (!collisions.length) {
    console.log(`No case-insensitive path collisions under ${CHECKED_ROOTS.join(", ")}.`);
    return;
  }
  for (const collision of collisions) {
    console.error(`Case-insensitive ${collision.kind} collision: ${collision.paths.join(" and ")}`);
  }
  console.error(
    "These paths resolve to one file on Windows and default macOS checkouts. Rename one side.",
  );
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
