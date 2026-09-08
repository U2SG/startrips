# Repository protection on `main`

`main` is protected by a repository **ruleset**, not by classic branch protection. This matters
for verification: `GET /repos/U2SG/startrips/branches/main/protection` answers
`404 Branch not protected` even while `main` is fully protected, because that endpoint only reports
the classic mechanism. Rulesets are reported by the endpoints in
[Re-verifying the configuration](#re-verifying-the-configuration) below, and those are the
authoritative ones.

Repository-level rulesets are available on GitHub Free for public repositories, so no plan upgrade
is involved.

## What is enforced

Ruleset `queue` (id `22196729`), `enforcement: active`, `target: branch`, applied to
`~DEFAULT_BRANCH`, i.e. `main`. `bypass_actors` is empty and `current_user_can_bypass` is `never`,
so the rules apply to the maintainer as well.

| Rule | Effect |
| --- | --- |
| `pull_request` | A direct push to `main` is refused; changes land only through a pull request. |
| `pull_request.allowed_merge_methods: ["squash"]` | Squash is the only merge method. |
| `pull_request.required_review_thread_resolution: true` | Merging is refused while any review conversation is unresolved. |
| `pull_request.required_approving_review_count: 0` | No second person's approval is required, so a solo maintainer can merge their own pull request. |
| `required_status_checks: verify` | Merging is refused while CI is red or still pending. |
| `required_status_checks: merge-readiness` | Merging is refused until the readiness controller publishes success, which it only does once the `merge-ready` label is present on a reviewed, green head. |
| `non_fast_forward` | Force-pushing `main` is refused. |
| `deletion` | Deleting `main` is refused. |

Two parameters are deliberately left as they are:

- `strict_required_status_checks_policy: false` — a pull request is not forced to be rebased onto
  the newest `main` before merging. Making it strict would serialize the queue behind every merge.
- `require_extra_approval_for_unattributed_changes: true` — this only demands an approval for
  commits that carry no GitHub account. Ordinary contributions are attributed and unaffected.

## How the label gate and the ruleset combine

The ruleset does not read labels. It requires the `merge-readiness` status check, and the
`merge-readiness` workflow is what reads the label: it publishes success only after `ci / verify`
has passed for the current head, every review conversation is resolved, and `merge-ready` is
present — revalidating the live label immediately before and after publishing. Any later push or
review activity cancels the older controller run and returns the status to pending. So the label
requirement is enforced on the merge button through that required check, and the ordering in
[`CONTRIBUTING.md`](../CONTRIBUTING.md) is not advisory.

### Re-running `ci` withdraws a sign-off, and that is not a bug

The controller looks for a **completed** `ci / verify` check-run on the exact head, reading every
page of the head's check-runs and reporting `absent`, `still queued` / `still in_progress` or the
real failing conclusion separately. Re-running or
re-triggering the `ci` workflow replaces that check-run with one that is queued again, so a
`merge-ready` applied during that window finds no completed `verify`, and the controller publishes
`merge-readiness: failure` with `ci / verify is still in_progress` and removes the label. That is the gate
failing closed, not a lookup defect: at that moment the head really does not have a finished
verification. Wait for `verify` to complete and apply `merge-ready` again. This is worth knowing
before diagnosing it, because from the outside — a head whose `verify` reads `success` afterwards
and a readiness status that says it was missing — it looks exactly like a bug in the controller.

## Re-verifying the configuration

```bash
gh api repos/U2SG/startrips/rulesets                  # the ruleset exists and is active
gh api repos/U2SG/startrips/rulesets/22196729         # its full parameters and bypass actors
gh api repos/U2SG/startrips/rules/branches/main       # the rules actually in effect on main
```

The third call is the one to trust when asking "is `main` protected right now": it reports the
effective rules for that ref, whatever their source.
