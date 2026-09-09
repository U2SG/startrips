# Contributing to Startrips

## Pull request merge workflow

Changes intended for `main` should land through a pull request and use an explicit final readiness step. The `merge-ready` label is the maintainer sign-off that happens **after** code review and CI verification; it is not a substitute for either one.

For a normal PR targeting `main`:

1. Push the implementation and let `ci / verify` finish.
2. Review the final diff and resolve every review conversation.
3. Confirm the PR is not a draft and that the latest CI run is green.
4. Add the `merge-ready` label as the final sign-off.
5. Confirm the `merge-readiness` status is green, then merge.

The readiness workflow uses latest-event-wins supersession without cancelling older Actions runs. Before an older controller mutates the shared label/status state it verifies that the PR still has the same head and that no newer readiness run exists for that head; a superseded controller exits successfully as a no-op. Final sign-off repeats that freshness check before and after publishing success and also revalidates the live `merge-ready` label. This keeps stale green readiness from surviving newer review/PR activity without leaving cancelled check-runs attached to an otherwise-green PR head. The controller automatically removes a stale `merge-ready` sign-off when the PR head changes or new review/review-comment activity occurs. Those events set the `merge-readiness` commit status back to **pending**. Resolve the new work, wait for the final `ci / verify` run to pass, and add `merge-ready` again as the last action.

Do not add `merge-ready` before the final CI/review pass. The controller verifies that `ci / verify` succeeded for the current head and scans every page of review conversations before it overwrites the `merge-readiness` status to **success**. If sign-off is attempted too early, the status is rejected and the label is removed.

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

The workflow above is enforced by the repository, not only documented here. The active ruleset
`queue` applies to `main`: changes land only through a squash-merged pull request, both `verify`
and `merge-readiness` are required status checks, every review conversation must be resolved, and
force-pushing or deleting `main` is refused. No additional approving reviewer is required, so a
solo maintainer can still merge their own pull request.

Note that `main` reports `404 Branch not protected` on the classic branch-protection endpoint, which
does not mean it is unprotected — the rules come from a ruleset. See
[`docs/repository-protection.md`](docs/repository-protection.md) for the enforced parameters and the
commands that re-verify them.