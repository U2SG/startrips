<!--
Ledger reminder: once this pull request has a number, add docs/pr-history/<PR>.md as the LAST
commit and nothing else in it. See docs/pr-history/README.md.
-->

Fixes #

<!-- 2-4 sentences: what changed and why. -->

## Cross-feature assumption audit

Changed dimension(s):

- [ ] scale / zoom / projection
- [ ] layout mode / posture / safe area
- [ ] time / tempo / duration
- [ ] media type / content topology / cardinality
- [ ] focus / ownership / async revision
- [ ] semantic reveal / data coverage
- [ ] rendering layers / occlusion
- [ ] quality / performance tier
- [ ] authorization identity and lifetime

Old assumptions potentially invalidated:

-

Dependent subsystems checked:

-

Cross-feature fixtures exercised:

-

New follow-up issues found:

- #

A small isolated pull request may instead state `No material cross-feature assumption changed`
with a one-line reason. Restating the feature is not an audit — name the assumption that moved.
See `docs/cross-feature-assumption-audit.md` for the dimensions, the invariant library and the
risk-driven matrix.

<!--
If this pull request fixes a P0 or P1 regression, the audit is not complete without a family
search. Add a `Regression-family search:` line naming every sibling subsystem that shares the
failed assumption, and for each confirmed sibling defect either the fix in this pull request or
the issue it created or reopened.
-->

Local validation:
