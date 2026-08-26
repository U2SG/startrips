# Contributing to Startrips

## Pull request merge workflow

Changes intended for `main` should land through a pull request and use an explicit final readiness step. The `merge-ready` label is the maintainer sign-off that happens **after** code review and CI verification; it is not a substitute for either one.

For a normal PR targeting `main`:

1. Push the implementation and let `ci / verify` finish.
2. Review the final diff and resolve every review conversation.
3. Confirm the PR is not a draft and that the latest CI run is green.
4. Add the `merge-ready` label as the final sign-off.
5. Confirm the `merge-readiness` check is green, then merge.

Removing `merge-ready` immediately makes the readiness check non-green on the next label event. If a readiness run failed because review conversations were still unresolved, resolve them and remove/re-apply the label to re-run the check.

Do not add `merge-ready` before the final CI/review pass. If the head changes after sign-off, treat the previous sign-off as stale: remove the label, review the new head, wait for CI again, and only then re-apply it.

## Stacked pull requests

Stacked PRs may target their parent feature branch while the stack is under development. The readiness check deliberately defers enforcement while the base is not `main`.

Merge a stack from the bottom up:

1. Finish and merge the parent PR.
2. Retarget the child PR to `main`.
3. Wait for CI to rerun against the new merge base.
4. Review the retargeted diff and resolve all conversations.
5. Add `merge-ready`.
6. Confirm both `ci / verify` and `merge-readiness` are green, then merge.
7. Repeat for the next child.

Never merge a child directly from its old feature-branch base just because the earlier stacked CI was green.

## Repository protection

When GitHub branch protection or repository rulesets are available for the repository plan, `main` should require both `verify` and `merge-readiness`, require all review conversations to be resolved, require pull requests, and block force-pushes/deletion. No additional approving reviewer is required for the solo-maintainer workflow.
