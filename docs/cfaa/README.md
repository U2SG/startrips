# CFAA v2 executable registry

This directory is the machine-readable companion to the standing Cross-Feature Assumption Audit policy in `docs/cross-feature-assumption-audit.md`.

The prose policy remains the semantic authority. `invariants.json` gives durable invariants stable IDs, risk dimensions, path hints, coverage status and evidence pointers so review tooling can project likely cross-feature impact.

## Commands

```bash
pnpm cfaa:validate
pnpm cfaa:impact -- --base <base-ref> --head <head-ref>
```

For pull requests, `scripts/cfaa.mjs impact` may also read `GITHUB_EVENT_PATH` through `--event` and compare invariant IDs explicitly named in the PR body with IDs suggested by changed paths.

## Authority boundary

The path resolver is deliberately advisory.

- A path match means “review this assumption”; it does not prove a defect.
- A suggested-but-undeclared ID is a review prompt in E1, not an automatic failure.
- A declared-but-not-path-suggested ID is valid when semantic impact is broader than the heuristic.
- **No path match is not CFAA approval.**
- The independent Source reviewer still decides whether the changed assumptions and regression-family search are complete.

CI blocks only if the registry/tooling itself is malformed or its deterministic tests fail. E1 does not turn heuristics into a merge oracle.

## Registry fields

Each invariant contains:

- `id` — stable `CFAA-...-NNN` identifier;
- `title` and `statement` — the durable engineering rule;
- `dimensions` — one or more registered high-risk dimensions;
- `issues` — historical issue references that established or extended the rule;
- `pathGlobs` — conservative path hints used by the resolver;
- `coverage` — `covered`, `partial`, or `policy`;
- `evidence` — existing unit, integration, server, browser-QA, or policy evidence.

Path hints should favor useful over broad. If an invariant is semantically relevant but path inference cannot express it reliably, authors/reviewers should declare the invariant explicitly rather than expanding a glob until every PR matches it.

## Delivery phases

- **E1 (this slice):** registry, path-impact projection, PR declaration comparison, tests and CI summary.
- **E2:** bind impacted invariant IDs to exact targeted QA/test evidence in Source Review receipts.
- **E3:** recent-change interaction graph and regression-family memory, including known failure fingerprints and prior fixing PRs.

The registry is not a feature backlog, owner registry, or lock system. Actionable findings continue to become normal Startrips issues and enter the existing ONE/control-plane flow.
