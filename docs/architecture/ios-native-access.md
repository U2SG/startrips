# Native Atlas access and upload recovery

The iPhone app uses the deployed HTTPS origin for login, invitation and editing. The local globe receives a scoped projection of Journey data. Keep cookies and credentials out of its bridge.

## Member session and guest link

Sign in in the first-party session and read the active identity through `GET /api/auth/get-session`. Bind the native request context to that session and active Atlas. Send the session cookie only to the configured HTTPS origin. An account or Atlas change invalidates outstanding native requests, resolved media URLs and any queued uploads owned by the old identity. Recheck the identity before resuming a background upload. Submit the existing journal and account flows from the first-party context so their Origin and reauthentication checks still apply.

A guest link has the shape `/share#<token>`. Construct a separate guest client with cookies disabled. Send the bearer only to the first-party `/api/shared/` routes. A missing fragment, expired grant or revocation ends that guest context. Re-sign assets through `/api/shared/assets/{assetId}/read-url`; members use `/api/uploads/assets/{assetId}/read-url`. Do not fall back to a cached member client. Object-storage PUTs and reads use their own expiring URL and specified headers, without the app session. Redact the share fragment, Authorization, cookies and signed URLs in telemetry.

## Recover a multipart task

1. Save the `uploadId`, `partSize`, `partCount` returned by `POST /api/uploads/start` along with the originating account, Atlas and destination. Save each completed part's number and provider ETag before acknowledging it locally.
2. After an interruption, authenticate the original account and Atlas, then call `GET /api/uploads/{id}/status`. The snapshot is private, read-only and does not extend the provider lease. For `initiated`, request a fresh part signature and re-upload any part whose ETag was lost. Send the ordered ETag list to `POST /api/uploads/{id}/complete`.
3. For `completed`, use the server's final `assetId`, including on deduplication. A deleted asset may leave this value null. Refresh the Journey before presenting it. The idempotent complete endpoint can return the canonical asset after a lost response. For `finalizing`, `completion_unknown` or `reconciling`, observe state and use the existing complete/reconciliation semantics. Preserve the task after ambiguous responses. Treat `aborted` as terminal and treat unfamiliar states as requiring revalidation.
4. Cancel an initiated task through `DELETE /api/uploads/{id}`. Repeated cancellation returns 204. A 409 while completion or reconciliation owns the task requires a status check. Clear local recovery data only after observing the outcome. A stale or foreign upload ID is unavailable. Batch moves use the existing move and undo routes under `/api/uploads/assets`. Apply server order and its undo receipt before refreshing both affected Journeys.

[Session and guest JSON example](../../server/tests/fixtures/ios-native-access.json) · [Upload status JSON example](../../server/tests/fixtures/ios-upload-status.json)
