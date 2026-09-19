import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_REGISTRY = path.join(ROOT, "docs", "cfaa", "invariants.json");
const ID_PATTERN = /^CFAA-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d{3}$/;
const COVERAGE = new Set(["covered", "partial", "policy"]);
const EVIDENCE_KINDS = new Set(["unit", "browser-qa", "server", "integration", "policy"]);

function fail(message) {
  throw new Error(message);
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(label + " must be a non-empty string");
  }
  return value.trim();
}

function repoRelative(value, label) {
  const text = nonEmptyString(value, label).replace(/\\/g, "/");
  if (text.startsWith("/") || text.split("/").includes("..")) {
    fail(label + " must stay repo-relative");
  }
  return text;
}

export function validateRegistry(registry) {
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    fail("registry must be an object");
  }
  if (!Number.isInteger(registry.version) || registry.version <= 0) {
    fail("registry.version must be a positive integer");
  }
  if (!registry.dimensions || typeof registry.dimensions !== "object" || Array.isArray(registry.dimensions)) {
    fail("registry.dimensions must be an object");
  }

  const dimensionIds = new Set();
  for (const [id, dimension] of Object.entries(registry.dimensions)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) fail("invalid dimension id " + id);
    if (!dimension || typeof dimension !== "object" || Array.isArray(dimension)) {
      fail(id + ": dimension must be an object");
    }
    nonEmptyString(dimension.label, id + ".label");
    nonEmptyString(dimension.canonicalQuestion, id + ".canonicalQuestion");
    dimensionIds.add(id);
  }
  if (dimensionIds.size === 0) fail("registry.dimensions must not be empty");

  if (!Array.isArray(registry.invariants) || registry.invariants.length === 0) {
    fail("registry.invariants must be a non-empty array");
  }

  const invariantIds = new Set();
  for (const invariant of registry.invariants) {
    if (!invariant || typeof invariant !== "object" || Array.isArray(invariant)) {
      fail("each invariant must be an object");
    }
    const id = nonEmptyString(invariant.id, "invariant.id");
    if (invariant.id !== id) fail("invariant.id must be canonical without surrounding whitespace");
    if (!ID_PATTERN.test(id)) fail(id + ": invalid invariant id");
    if (invariantIds.has(id)) fail(id + ": duplicate invariant id");
    invariantIds.add(id);

    nonEmptyString(invariant.title, id + ".title");
    nonEmptyString(invariant.statement, id + ".statement");

    if (!Array.isArray(invariant.dimensions) || invariant.dimensions.length === 0) {
      fail(id + ": dimensions must be non-empty");
    }
    for (const dimensionId of invariant.dimensions) {
      if (!dimensionIds.has(dimensionId)) fail(id + ": unknown dimension " + dimensionId);
    }

    if (!Array.isArray(invariant.issues)) fail(id + ": issues must be an array");
    for (const issue of invariant.issues) {
      if (typeof issue !== "string" || !/^#\d+$/.test(issue)) {
        fail(id + ": invalid issue reference " + String(issue));
      }
    }

    if (!Array.isArray(invariant.pathGlobs) || invariant.pathGlobs.length === 0) {
      fail(id + ": pathGlobs must be non-empty");
    }
    invariant.pathGlobs.forEach((glob, index) => repoRelative(glob, id + ".pathGlobs[" + index + "]"));

    if (!COVERAGE.has(invariant.coverage)) {
      fail(id + ": coverage must be one of " + [...COVERAGE].join(", "));
    }
    if (!Array.isArray(invariant.evidence) || invariant.evidence.length === 0) {
      fail(id + ": evidence must be non-empty");
    }
    invariant.evidence.forEach((evidence, index) => {
      if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
        fail(id + ".evidence[" + index + "] must be an object");
      }
      if (!EVIDENCE_KINDS.has(evidence.kind)) {
        fail(id + ".evidence[" + index + "]: unknown kind " + String(evidence.kind));
      }
      nonEmptyString(evidence.label, id + ".evidence[" + index + "].label");
      if (evidence.path !== undefined) {
        const evidencePath = repoRelative(evidence.path, id + ".evidence[" + index + "].path");
        const absolute = path.join(ROOT, evidencePath);
        if (!fs.existsSync(absolute)) {
          fail(id + ".evidence[" + index + "].path does not exist: " + evidencePath);
        }
        try {
          execFileSync("git", ["ls-files", "--error-unmatch", "--", evidencePath], {
            cwd: ROOT,
            stdio: ["ignore", "ignore", "pipe"],
          });
        } catch {
          fail(id + ".evidence[" + index + "].path is not tracked: " + evidencePath);
        }
      }
    });
  }
  return registry;
}

export function loadRegistry(registryPath = DEFAULT_REGISTRY) {
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  } catch (error) {
    fail("cannot read CFAA registry " + registryPath + ": " + (error instanceof Error ? error.message : String(error)));
  }
  return validateRegistry(registry);
}

export function globToRegExp(glob) {
  const normalized = repoRelative(glob, "glob");
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "*") {
      if (normalized[index + 1] === "*") {
        index += 1;
        if (normalized[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += /[\\^$.*+?()[\]{}|]/.test(char) ? "\\" + char : char;
  }
  return new RegExp(source + "$");
}

export function pathMatchesGlob(filePath, glob) {
  const normalized = repoRelative(filePath, "file path");
  return globToRegExp(glob).test(normalized);
}

export function resolveImpact(registry, changedPaths) {
  validateRegistry(registry);
  const paths = [...new Set(changedPaths.map((value, index) => repoRelative(value, "changedPaths[" + index + "]")))].sort();
  const impacted = [];

  for (const invariant of registry.invariants) {
    const matchedPaths = paths.filter((filePath) => invariant.pathGlobs.some((glob) => pathMatchesGlob(filePath, glob)));
    if (matchedPaths.length === 0) continue;
    impacted.push({
      id: invariant.id,
      title: invariant.title,
      statement: invariant.statement,
      dimensions: [...invariant.dimensions],
      coverage: invariant.coverage,
      issues: [...invariant.issues],
      matchedPaths,
      evidence: invariant.evidence.map((entry) => ({ ...entry })),
    });
  }

  impacted.sort((left, right) => left.id.localeCompare(right.id));
  return { changedPaths: paths, impacted };
}

export function extractDeclaredInvariantIds(text = "") {
  if (typeof text !== "string") return [];
  return [...new Set(text.match(/\bCFAA-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d{3}\b/g) || [])].sort();
}

export function compareDeclarations(registry, impact, declaredIds) {
  const known = new Set(registry.invariants.map((entry) => entry.id));
  const suggested = new Set(impact.impacted.map((entry) => entry.id));
  const declared = [...new Set(declaredIds)].sort();

  return {
    declared,
    suggested: [...suggested].sort(),
    suggestedButUndeclared: [...suggested].filter((id) => !declared.includes(id)).sort(),
    declaredButNotSuggested: declared.filter((id) => known.has(id) && !suggested.has(id)).sort(),
    unknownDeclared: declared.filter((id) => !known.has(id)).sort(),
  };
}

export function parseNulPaths(output) {
  const text = Buffer.isBuffer(output) ? output.toString("utf8") : String(output);
  return text.split("\0").filter(Boolean);
}

function gitChangedPaths(base, head, root = ROOT) {
  nonEmptyString(base, "base");
  nonEmptyString(head, "head");
  let output;
  try {
    output = execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", base + "..." + head], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error
      ? (Buffer.isBuffer(error.stderr) ? error.stderr.toString("utf8") : String(error.stderr)).trim()
      : "";
    fail("cannot diff " + base + "..." + head + (stderr ? ": " + stderr : ""));
  }
  return parseNulPaths(output);
}

function readPullRequestBody(eventPath) {
  if (!eventPath) return "";
  let event;
  try {
    event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  } catch (error) {
    fail("cannot read GitHub event " + eventPath + ": " + (error instanceof Error ? error.message : String(error)));
  }
  return typeof event?.pull_request?.body === "string" ? event.pull_request.body : "";
}

function compact(values, empty = "none") {
  return values.length > 0 ? values.join(", ") : empty;
}

export function renderImpactMarkdown(registry, impact, declarations) {
  const lines = [
    "# CFAA impact projection",
    "",
    "> Advisory projection only. Path matches identify assumptions that deserve review; they do not prove a regression or approval.",
    "> **No registry path match is not CFAA approval.** The reviewer must still inspect changed assumptions semantically.",
    "",
    "Changed files: **" + impact.changedPaths.length + "**",
    "Suggested invariants: **" + impact.impacted.length + "**",
    "",
  ];

  if (impact.impacted.length === 0) {
    lines.push("No invariant was suggested by the current path hints.", "");
  } else {
    lines.push("| Invariant | Coverage | Dimensions | Matched paths |", "| --- | --- | --- | --- |");
    for (const entry of impact.impacted) {
      const shown = entry.matchedPaths.slice(0, 4).join("<br>");
      const suffix = entry.matchedPaths.length > 4 ? "<br>+" + (entry.matchedPaths.length - 4) + " more" : "";
      lines.push("| " + entry.id + " — " + entry.title + " | " + entry.coverage + " | " + entry.dimensions.join(", ") + " | " + shown + suffix + " |");
    }
    lines.push("");
  }

  lines.push(
    "## PR declaration comparison",
    "",
    "Declared IDs: " + compact(declarations.declared),
    "",
    "Suggested but undeclared: " + compact(declarations.suggestedButUndeclared),
    "",
    "Declared but not path-suggested: " + compact(declarations.declaredButNotSuggested),
    "",
    "Unknown declared IDs: " + compact(declarations.unknownDeclared),
    "",
    "Suggested-but-undeclared is a review prompt, not an automatic failure in CFAA v2 E1.",
    "Declared-but-not-path-suggested is valid when semantic impact is broader than the heuristic.",
    ""
  );
  return lines.join("\n");
}

function optionValue(args, name, fallback = undefined) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (index + 1 >= args.length) fail("missing value for " + name);
  return args[index + 1];
}

export function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  const registryPath = optionValue(argv, "--registry", DEFAULT_REGISTRY);
  const registry = loadRegistry(registryPath);

  if (command === "validate") {
    console.log("validated CFAA registry v" + registry.version + ": " + registry.invariants.length + " invariant(s), " + Object.keys(registry.dimensions).length + " dimension(s)");
    return;
  }

  if (command === "impact") {
    const base = optionValue(argv, "--base");
    const head = optionValue(argv, "--head");
    if (!base || !head) fail("impact requires --base and --head");

    const changedPaths = gitChangedPaths(base, head);
    const impact = resolveImpact(registry, changedPaths);
    const body = readPullRequestBody(optionValue(argv, "--event"));
    const declaredIds = extractDeclaredInvariantIds(body);
    const declarations = compareDeclarations(registry, impact, declaredIds);
    const markdown = renderImpactMarkdown(registry, impact, declarations);
    const output = optionValue(argv, "--output");

    if (output) {
      fs.writeFileSync(output, markdown, "utf8");
      console.log("wrote " + output);
    } else {
      process.stdout.write(markdown);
    }
    return;
  }

  fail("usage: node scripts/cfaa.mjs <validate|impact> [options]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
