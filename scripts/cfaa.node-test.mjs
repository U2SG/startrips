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

test("evidence paths must exist and be tracked", () => {
  const registry = sampleRegistry();
  registry.invariants[0].evidence = [{
    kind: "unit",
    label: "missing proof",
    path: "scripts/this-evidence-does-not-exist.mjs",
  }];
  assert.throws(() => validateRegistry(registry), /does not exist/);
});

test("executable evidence requires an exact path while policy evidence may be pathless", () => {
  const registry = sampleRegistry();
  registry.invariants[0].evidence = [{ kind: "integration", label: "imaginary proof" }];
  assert.throws(() => validateRegistry(registry), /executable evidence requires a path/);

  registry.invariants[0].evidence = [{ kind: "policy", label: "semantic reviewer authority" }];
  assert.doesNotThrow(() => validateRegistry(registry));
});

test("non-canonical executable evidence paths are rejected", () => {
  const registry = sampleRegistry();
  registry.invariants[0].evidence = [{
    kind: "unit",
    label: "real test with whitespace",
    path: " scripts/cfaa.node-test.mjs ",
  }];
  assert.throws(() => validateRegistry(registry), /path must be canonical/);

  registry.invariants[0].evidence = [{
    kind: "unit",
    label: "real test with backslashes",
    path: "scripts\\cfaa.node-test.mjs",
  }];
  assert.throws(() => validateRegistry(registry), /path must be canonical/);
});

test("evidence directories are rejected even when Git pathspecs match tracked descendants", () => {
  const registry = sampleRegistry();
  registry.invariants[0].evidence = [{
    kind: "unit",
    label: "directory is not proof",
    path: "scripts",
  }];
  assert.throws(() => validateRegistry(registry), /not an exact tracked file/);
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

test("raw Git paths preserve surrounding and whitespace-only filenames", () => {
  const registry = sampleRegistry();
  registry.invariants[0].pathGlobs = ["src/owner/**"];

  const leading = " src/owner/file.ts";
  const trailing = "src/owner/file.ts ";
  const whitespaceOnly = "   ";

  assert.deepEqual(resolveImpact(registry, [leading]).changedPaths, [leading]);
  assert.deepEqual(resolveImpact(registry, [trailing]).changedPaths, [trailing]);
  assert.deepEqual(resolveImpact(registry, [whitespaceOnly]).changedPaths, [whitespaceOnly]);

  assert.equal(resolveImpact(registry, [leading]).impacted.length, 0);
  assert.equal(resolveImpact(registry, [trailing]).impacted.length, 1);
  assert.equal(resolveImpact(registry, [whitespaceOnly]).impacted.length, 0);
});

test("literal backslashes in Git paths are preserved", () => {
  const registry = loadRegistry();
  const path = "src/journey/foo\\Playback.ts";
  const impact = resolveImpact(registry, [path]);
  const ids = new Set(impact.impacted.map((entry) => entry.id));
  assert.ok(ids.has("CFAA-TIME-001"));
  assert.deepEqual(impact.changedPaths, [path]);
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

test("shared route changes suggest all share invariants", () => {
  const registry = loadRegistry();
  const impact = resolveImpact(registry, ["server/routes/shares.ts"]);
  const ids = new Set(impact.impacted.map((entry) => entry.id));
  assert.ok(ids.has("CFAA-SHARE-001"));
  assert.ok(ids.has("CFAA-SHARE-002"));
  assert.ok(ids.has("CFAA-SHARE-003"));
});

test("guest authority contract changes suggest the read-only invariant", () => {
  const registry = loadRegistry();
  const impact = resolveImpact(registry, ["src/journey/atlasView.ts"]);
  const ids = new Set(impact.impacted.map((entry) => entry.id));
  assert.ok(ids.has("CFAA-SHARE-002"));
});

test("guest share view changes suggest read-only and expiry invariants", () => {
  const registry = loadRegistry();
  for (const changedPath of ["src/journey/SharedAtlasView.tsx", "src/journey/sharedAtlas.ts"]) {
    const impact = resolveImpact(registry, [changedPath]);
    const ids = new Set(impact.impacted.map((entry) => entry.id));
    assert.ok(ids.has("CFAA-SHARE-002"));
    assert.ok(ids.has("CFAA-SHARE-003"));
  }
});

test("email-change boundaries suggest the stable identity invariant", () => {
  const registry = loadRegistry();
  for (const changedPath of [
    "server/routes/account-email-change.ts",
    "server/tests/account-email-change.integration.test.ts",
  ]) {
    const impact = resolveImpact(registry, [changedPath]);
    assert.ok(impact.impacted.some((entry) => entry.id === "CFAA-ID-001"));
  }
});

test("account identity boundaries suggest the stable identity invariant", () => {
  const registry = loadRegistry();
  for (const changedPath of [
    "server/routes/account-identities.ts",
    "server/tests/account-identities.integration.test.ts",
    "server/tests/account-identity-routes.integration.test.ts",
  ]) {
    const impact = resolveImpact(registry, [changedPath]);
    assert.ok(impact.impacted.some((entry) => entry.id === "CFAA-ID-001"));
  }
});

test("renderer coexistence owners suggest the rendering-tenancy invariant", () => {
  const registry = loadRegistry();
  for (const changedPath of [
    "src/scene/LivingAtlasGlobe.tsx",
    "src/scene/DetailedEarthMap.tsx",
  ]) {
    const impact = resolveImpact(registry, [changedPath]);
    assert.ok(impact.impacted.some((entry) => entry.id === "CFAA-RENDER-001"));
  }
});

test("password route changes suggest the replay invariant", () => {
  const registry = loadRegistry();
  const impact = resolveImpact(registry, ["server/routes/account-password.ts"]);
  assert.ok(impact.impacted.some((entry) => entry.id === "CFAA-REPLAY-001"));
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

test("impact markdown escapes table metacharacters in Git filenames", () => {
  const registry = sampleRegistry();
  registry.invariants[0].pathGlobs = ["src/owner/**"];
  const impact = resolveImpact(registry, ["src/owner/a|b<test>\nfile.ts"]);
  const comparison = compareDeclarations(registry, impact, []);
  const markdown = renderImpactMarkdown(registry, impact, comparison);
  assert.match(markdown, /a&#124;b&#60;test&#62;<br>file\.ts/);
  assert.doesNotMatch(markdown, /a\|b<test>/);
});

test("impact markdown neutralizes Markdown link, image, and code syntax in filenames", () => {
  const registry = sampleRegistry();
  registry.invariants[0].pathGlobs = ["src/owner/**"];
  const dangerous = "src/owner/![status](https:/example.invalid/pixel.png)-`code`.ts";
  const impact = resolveImpact(registry, [dangerous]);
  const comparison = compareDeclarations(registry, impact, []);
  const markdown = renderImpactMarkdown(registry, impact, comparison);
  assert.match(markdown, /&#33;&#91;status&#93;&#40;https:\/example\.invalid\/pixel\.png&#41;-&#96;code&#96;\.ts/);
  assert.doesNotMatch(markdown, /!\[status\]\(/);
  assert.doesNotMatch(markdown, /`code`/);
});

test("impact markdown neutralizes strikethrough and other punctuation syntax", () => {
  const registry = sampleRegistry();
  registry.invariants[0].pathGlobs = ["src/owner/**"];
  const dangerous = "src/owner/~~retired~~_[x].ts";
  const impact = resolveImpact(registry, [dangerous]);
  const comparison = compareDeclarations(registry, impact, []);
  const markdown = renderImpactMarkdown(registry, impact, comparison);
  assert.match(markdown, /&#126;&#126;retired&#126;&#126;&#95;&#91;x&#93;\.ts/);
  assert.doesNotMatch(markdown, /~~retired~~/);
});

test("an empty path projection is explicitly not approval", () => {
  const registry = sampleRegistry();
  const impact = resolveImpact(registry, ["docs/unrelated.md"]);
  const comparison = compareDeclarations(registry, impact, []);
  const markdown = renderImpactMarkdown(registry, impact, comparison);
  assert.match(markdown, /No registry path match is not CFAA approval/);
  assert.match(markdown, /No invariant was suggested/);
});
