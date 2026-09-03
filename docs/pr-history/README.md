# Pull Request Ledger

New pull requests use one immutable ledger file per PR:

```text
docs/pr-history/<PR_NUMBER>.md
```

`docs/pr-history.md` is the frozen legacy archive. Do not append new entries to it.

## Required format

```md
# PR #192 - Short title

- **Source head:** `0123456789abcdef0123456789abcdef01234567`
- **Scope:** What changed technically.
- **User-visible change:** What a user will notice, or `None`.
- **Review fixes:** Important review-driven corrections.
- **Follow-up:** Known remaining work, or `None`.
- **Validation:** What was verified and which checks remain authoritative.
```

The Source head is the final reviewed **code** commit. The PR may then add only its own ledger file. CI validates that `Source head..PR head` contains no files except `docs/pr-history/<PR_NUMBER>.md`. Across the whole PR diff, the legacy `docs/pr-history.md` archive is frozen and numeric ledger files belonging to other PRs are forbidden.

## Aggregate index

CI runs `node scripts/pr-history.mjs render` and publishes the generated aggregate Markdown as a build artifact. The generated aggregate is deliberately not committed back to the repository, so it cannot become another shared write lock or create main-branch bot-commit churn.
