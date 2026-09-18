# Account email-change transaction

ST-089 / issue #389 is the server-only foundation for the account email rebind flow in #347.
It changes the primary email of one existing Startrips Account; it does not create, merge, or transfer an account.

## Stable authority

`user.id` remains the durable account identity. Atlas memberships, Journeys, shares, Home Base,
account preferences, credential account rows, and provider ownership rows continue to reference
the same stable user.

`user.email` remains authoritative until the transaction completes. Starting a change never
mutates it. Provider claims remain independent login-identity evidence and are never rewritten
from the new primary email.

## Entry authorization

The caller needs an authenticated Better Auth session, matching Startrips origin, and a fresh
single-use ST-067 password-reverification grant bound to that same stable user and session.
The grant is consumed inside the same database transaction that attempts to create the pending
email change, so a conflict/refusal cannot make that proof reusable.

Better Auth remains pinned at 1.6.23. Native `/api/auth/change-email` is disabled because its
sensitive-session flow is not equivalent to the ST-067 dedicated proof plus the two-address
transaction below. The pinned native `/api/auth/update-user` already rejects email updates.

## Durable transaction

`account_email_changes` stores the stable user id, initiating session id, authoritative current
email, normalized proposed email, consumed ST-067 action id, SHA-256 hashes of both address
proofs, proof timestamps, expiry, lifecycle, and close timestamps.

Raw proof tokens are never persisted, returned in the start response, or written to audit.
Only one pending transaction may exist per user and only one pending transaction may claim a
normalized proposed email. A PostgreSQL advisory transaction lock plus partial unique indexes
serialize concurrent claimants.

Starting a newer transaction first expires an already-expired predecessor, then marks any
remaining live predecessor `replaced`. Proofs from replaced transactions cannot complete later.

## Two-stage proof

Normal completion requires both independent controls:

- old confirmation proves continued control of the currently authoritative email;
- new verification proves control of the proposed email.

Either proof may arrive first. The account email does not change until both are recorded.
Proofs are single-use and remain bound to the initiating stable user and session.

If the old address is unavailable, the server returns `EMAIL_CHANGE_RECOVERY_REQUIRED`.
ST-089 has no weaker fallback; recovery UX/manual policy remains outside this backend slice.

## Completion boundary

The second valid proof rechecks that the stable user's current email still matches the original
transaction value, that no other user owns the normalized proposed email, and that the row is
still the current pending transaction.

The same database transaction then:

1. updates only `user.email`, `user.email_verified`, and the user update timestamp;
2. marks the pending transaction completed and records secret-free audit evidence;
3. deletes Better Auth verification capabilities whose stored value is the stable user id,
   including reset/delete-account links issued before the rebind;
4. deletes all existing sessions for the stable user.

The next login/recovery therefore uses the new email. Credential/provider account rows, Atlas
memberships, Journeys, shares, Home Base, media, and preferences keep the same stable owner.

If the current email changed or the proposed email became occupied before completion, the
transaction closes as `conflicted` and the old email remains unchanged.

## Cancellation, expiry, replay, and session switching

`cancel` works only for the initiating session while the transaction is pending. Expired,
replaced, cancelled, conflicted, and completed transactions cannot be revived by old proof
tokens. A proof presented from another session fails with `EMAIL_CHANGE_SESSION_CHANGED`.

## HTTP contract

Mounted at `/api/account-identities/email-change`:

- `GET /` returns the current/latest transaction state for the authenticated stable user;
- `POST /` starts/replaces a transaction using `newEmail` and `reverificationToken`;
- `POST /confirm-old` consumes the old-address proof;
- `POST /verify-new` consumes the new-address proof;
- `POST /cancel` cancels the current pending transaction.

Mutation responses never include proof tokens. Start sends both proof emails through the existing
mail sender. Bearer tokens live in URL fragments so they never enter HTTP request targets/access
logs; #347 reads the fragment client-side and submits it in the POST body. Sensitive development
email bodies are redacted as well. Successful completion sends non-secret notifications to both
old and new addresses.

## Invitations and product data

Existing organization membership is keyed by stable `user.id` and is unchanged.
A still-pending invitation is a separate email-address claim. ST-089 does not rewrite an invite
from the old address to the new address and does not silently grant membership based on rebind.
A future invitation flow may explicitly reissue/revalidate that invitation.

## UI boundary

#347 owns account-surface status, link handling, recovery presentation, and completed/cancelled
UX. ST-089 exposes server state and verification operations only; it does not add a second auth
framework or account-management UI.