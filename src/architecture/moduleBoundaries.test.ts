import { readdirSync, readFileSync } from "node:fs";
import { posix as path } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

type Dependency = { specifier: string; target: string | null; runtime: boolean };
const isTest = (file: string) => /(?:^|\/)(?:tests|__tests__)\/|\.(?:test|spec)\./.test(file);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = `${directory}/${entry.name}`;
    return entry.isDirectory() ? sourceFiles(file)
      : /\.(ts|tsx)$/.test(file) && !isTest(file) ? [file] : [];
  });
}

const files = new Set([...sourceFiles("src"), ...sourceFiles("server")]);

function resolveImport(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.normalize(path.join(path.dirname(from), specifier));
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
  if (base.endsWith(".js")) candidates.push(`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`);
  return candidates.find((file) => files.has(file)) ?? null;
}

function dependencies(file: string): Dependency[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const result: Dependency[] = [];
  const record = (specifier: string, runtime: boolean) => {
    result.push({ specifier, runtime, target: resolveImport(file, specifier) });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      const namedTypesOnly = !clause?.name && named && ts.isNamedImports(named)
        && named.elements.length > 0 && named.elements.every((item) => item.isTypeOnly);
      record(node.moduleSpecifier.text, !clause?.isTypeOnly && !namedTypesOnly);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause;
      const namedTypesOnly = clause && ts.isNamedExports(clause)
        && clause.elements.length > 0 && clause.elements.every((item) => item.isTypeOnly);
      record(node.moduleSpecifier.text, !node.isTypeOnly && !namedTypesOnly);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteral(node.argument.literal)) {
      record(node.argument.literal.text, false);
    } else if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      record(node.arguments[0].text, true);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

const graph = new Map([...files].map((file) => [file, dependencies(file)]));
const pureOwners = [
  "src/journey/storyMediaPolicy.ts",
  "src/journey/storySurfacePolicy.ts",
  "src/journey/playbackMediaPresentation.ts",
  "src/journey/mediaReadRefresh.ts",
  "src/journey/journeyDraftMedia.ts",
  "src/journey/journeySaveRecovery.ts",
  "src/journey/routeDraft.ts",
  "src/scene/globeMode.ts",
  "src/scene/renderBudget.ts",
  "server/media/upload-protocol.ts",
];

describe("module ownership boundaries", () => {
  it("keeps HTTP adapters below the server composition boundary", () => {
    const violations: string[] = [];
    for (const [file, edges] of graph) {
      if (!file.startsWith("server/") || file === "server/app.ts" || file.startsWith("server/routes/")) continue;
      for (const edge of edges) {
        if (edge.target?.startsWith("server/routes/")) violations.push(`${file} -> ${edge.target}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it.each(pureOwners)("keeps %s independent of UI and infrastructure owners", (owner) => {
    expect(graph.has(owner)).toBe(true);
    const violations: string[] = [];
    const visited = new Set<string>();
    const inspect = (file: string) => {
      if (visited.has(file)) return;
      visited.add(file);
      for (const edge of graph.get(file) ?? []) {
        // A type contract must not depend on a UI root either. Runtime traversal
        // also catches a policy that indirectly imports an effectful owner.
        const uiType = edge.target?.endsWith(".tsx");
        const runtimeOwner = edge.runtime && (
          /^(?:react(?:-dom)?(?:\/|$)|hono(?:\/|$)|node:)/.test(edge.specifier)
          || /\.css$/.test(edge.specifier)
          || (edge.target !== null && /^(?:server\/(?:db|storage|routes|services|repositories)\/|server\/(?:app|index|config)\.ts$|src\/journey\/journeyApi\.ts$|src\/experience\/)/.test(edge.target))
        );
        if (uiType || runtimeOwner) violations.push(`${file} -> ${edge.target ?? edge.specifier}`);
        else if (edge.runtime && edge.target) inspect(edge.target);
      }
    };
    inspect(owner);
    expect(violations).toEqual([]);
  });

  it("keeps the literal runtime import graph acyclic", () => {
    const completed = new Set<string>();
    const active = new Set<string>();
    const stack: string[] = [];
    const cycles: string[] = [];
    const visit = (file: string) => {
      if (active.has(file)) {
        cycles.push([...stack.slice(stack.indexOf(file)), file].join(" -> "));
        return;
      }
      if (completed.has(file)) return;
      active.add(file);
      stack.push(file);
      for (const edge of graph.get(file) ?? []) {
        if (edge.runtime && edge.target) visit(edge.target);
      }
      stack.pop();
      active.delete(file);
      completed.add(file);
    };
    for (const file of files) visit(file);
    expect(cycles).toEqual([]);
  });
});
