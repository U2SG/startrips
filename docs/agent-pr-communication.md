# Agent PR communication contract

Startrips agents use **low-communication, high-evidence** pull request workflows.

GitHub Conversation is an exception channel, not a progress log. Routine progress belongs in commits, CI/checks, the authoritative ONE control plane, and the per-PR ledger.

## ONE control-plane location

ONE is external to the Git repository. On the managed Startrips development host/workspace, the authoritative state file is:

`D:/startrips/loop-workspace/feature_list.json`

The selector is `D:/startrips/loop-workspace/run-loop.sh`; process rules live beside it in `CLAUDE.md` / `README.md`. Agents that have access to that managed workspace must read the existing ONE file rather than creating a repository copy or a second backlog/lock/selector. Contributors without access to the managed control plane should rely on PR/CI/review evidence and must not fabricate or infer ONE state; an owner/Orchestrator provides the required `ready_for_eval` handoff when applicable.

## Default comment budget

A normal implementation PR should need no more than these agent-authored top-level comments:

- one concise `@codex review` request for the final CODE Source;
- one compact `HANDOFF_REVIEW` after the ledger-only final head and exact final CI are ready.

Additional top-level comments are reserved for a human decision, a blocker that cannot be represented by CI/ONE/review state, or an explicit safety/security/data-loss/migration concern.

## Review findings

Do not narrate every fix. Valid findings are fixed on the same owner lane and resolved after exact-head evidence proves the finding is gone. Reply in-thread only to dispute a finding, clarify ambiguous product intent, or record a non-obvious constraint.

A fresh review request should be short: identify the exact CODE Source SHA and ask Codex to review that head. Do not restate the PR body, prior findings, CI history, or implementation narrative.

## CI and reruns

Do not post Conversation updates for CI start/finish, mergeability, rebase progress, expected pre-ledger failures, or routine targeted reruns. Known intermittent same-SHA reruns are recorded in the ledger/HANDOFF when accepted; they need a comment only if acceptance semantics change or owner authorization is required.

## Maintainer behavior

Maintainers are zero-comment by default. They verify the evidence, resolve demonstrably outdated conversations when repository policy requires, apply `merge-ready` as the final mutation, wait for the new post-sign controller result, and merge. A maintainer comment is warranted only when refusing the gate or requesting a human decision.

## Compact handoff

`HANDOFF_REVIEW` should contain only:

- CODE Source SHA;
- final SHA;
- exact final CI run;
- fresh review-clear evidence;
- Source-to-final ledger-only relation;
- ONE `ready_for_eval`, `passes=false` state.

Feature explanation stays in the PR body and ledger.
