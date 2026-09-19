import test from "node:test";
import assert from "node:assert/strict";

import {
  compareDeclarations,
  extractDeclaredInvariantIds,
  globToRegExp,
  loadRegistry,
  pathMatchesGlob,
  parseNulPaths,
  renderImpactMarkdown,
  resolveImpact,
  validateRegistry,
} from "./cfaa.mjs";

function sampleRegistry() {
  return {
    version: 1,
    dimensions: {
      ownership: {
        label: "Ownership",
        canonicalQuestion: "Can an older owner win?",
      },
    },
    invariants: [
      {
        id: "CFAA-TEST-001",
        title: "Newer owner wins",
        statement: "A newer owner cannot be overwritten by a stale result.",
        dimensions: ["ownership"],
        issues: ["#1"],
        pathGlobs: ["src/owner/**", "server/*-owner.ts"],
        coverage: "partial",
        evidence: [{ kind: "policy", label: "test policy" }],
      },
    ],
  };
}

test("repository registry is coherent", () => {
  const registry = loadRegistry();
  assert.ok(registry.invariants.length >= 18);
  assert.ok(Object.keys(registry.dimensions).length >= 11);
});

test("duplicate invariant IDs are rejected", () => {
  const registry = sampleRegistry();
  registry.invariants.push({ ...registry.invariants[0] });
  assert.throws(() => validateRegistry(registry), /duplicate invariant id/);
});

test("invariant IDs with surrounding whitespace are rejected", () => {
  const registry = sampleRegistry();
  registry.invariants[0].id = " CFAA-TEST-001 ";
  assert.throws(() => validateRegistry(registry), /canonical without surrounding whitespace/);
});

test("unknown dimensions are rejected", () => {
  const registry = sampleRegistry();
  registry.invariants[0].dimensions = ["missing"];
  assert.throws(() => validateRegistry(registry), /unknown dimension/);
});

test("malformed evidence kinds are rejected", () => {
  const registry = sampleRegistry();
  registry.invariants[0].evidence = [{ kind: "screenshot", label: "not a supported evidence kind" }];
  assert.throws(() => validateRegistry(registry), /unknown kind/);
});

test("glob matching distinguishes recursive and single-segment wildcards", () => {
  assert.equal(pathMatchesGlob("src/owner/a/b.ts", "src/owner/**"), true);
  assert.equal(pathMatchesGlob("src/owner/a.ts", "src/owner/*"), true);
  assert.equal(pathMatchesGlob("src/owner/a/b.ts", "src/owner/*"), false);
  assert.equal(pathMatchesGlob("server/account-owner.ts", "server/*-owner.ts"), true);
  assert.equal(globToRegExp("src/**/share*").test("src/journey/deep/shareThing.ts"), true);
});

test("NUL-delimited Git paths preserve Unicode without C-quoting", () => {
  const paths = parseNulPaths(Buffer.from("src/journey/旅行.ts\0src/scene/地球.ts\0", "utf8"));
  assert.deepEqual(paths, ["src/journey/旅行.ts", "src/scene/地球.ts"]);
  assert.equal(pathMatchesGlob(paths[0], "src/journey/**"), true);
  assert.equal(pathMatchesGlob(paths[1], "src/scene/**"), true);
});

test("impact resolution is deterministic and records matching paths", () => {
  const registry = sampleRegistry();
  const impact = resolveImpact(registry, [
    "server/account-owner.ts",
    "docs/readme.md",
    "src/owner/a/b.ts",
    "src/owner/a/b.ts",
  ]);
  assert.deepEqual(impact.changedPaths, [
    "docs/readme.md",
    "server/account-owner.ts",
    "src/owner/a/b.ts",
  ]);
  assert.equal(impact.impacted.length, 1);
  assert.equal(impact.impacted[0].id, "CFAA-TEST-001");
  assert.deepEqual(impact.impacted[0].matchedPaths, [
    "server/account-owner.ts",
    "src/owner/a/b.ts",
  ]);
});

test("declared IDs are deduplicated and compared with suggestions", () => {
  const registry = sampleRegistry();
  const impact = resolveImpact(registry, ["src/owner/a.ts"]);
  const declared = extractDeclaredInvariantIds(
    "Impacted: CFAA-TEST-001 and CFAA-UNKNOWN-999, again CFAA-TEST-001"
  );
  const comparison = compareDeclarations(registry, impact, declared);
  assert.deepEqual(comparison.declared, ["CFAA-TEST-001", "CFAA-UNKNOWN-999"]);
  assert.deepEqual(comparison.suggestedButUndeclared, []);
  assert.deepEqual(comparison.unknownDeclared, ["CFAA-UNKNOWN-999"]);
});

test("an empty path projection is explicitly not approval", () => {
  const registry = sampleRegistry();
  const impact = resolveImpact(registry, ["docs/unrelated.md"]);
  const comparison = compareDeclarations(registry, impact, []);
  const markdown = renderImpactMarkdown(registry, impact, comparison);
  assert.match(markdown, /No registry path match is not CFAA approval/);
  assert.match(markdown, /No invariant was suggested/);
});
