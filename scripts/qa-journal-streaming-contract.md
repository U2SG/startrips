# Independent journal streaming acceptance

Verified backend Source: `58d2995f7f1929dbe585f38cb91666e49f5e395e`.
The QA changes contain only the four `scripts/qa-journal-streaming*` files.

## Run

Use Node 24 and the repository's installed dependencies:

```sh
node --import tsx --test scripts/qa-journal-streaming.node-test.ts
```

This takes about 33 seconds because one test uses a real 32-second loopback HTTP
response. The other timer boundaries use a fake clock with real ReadableStream
reads. Both invoke production transport/extraction code, never a QA parser.
The fixture provider is synthetic; no real model request is made.

The database suite requires a disposable PostgreSQL database at exactly
`127.0.0.1:55432/qa_journal_streaming` (local) or
`127.0.0.1:5432/qa_journal_streaming` (CI). It refuses other hosts, ports and database names.
The required CI `core` job creates a separate disposable database, migrates it,
then runs both explicit suites under Node 24. A failed suite fails `core` and
therefore the aggregate verify gate; no separate optional check is used. Apply the
repository migrations, including 0042, to that database before running:

```sh
DATABASE_URL=postgresql://qa:qa-synthetic@127.0.0.1:55432/qa_journal_streaming \
DATABASE_SSL=false \
BETTER_AUTH_SECRET=qa-only-secret-with-more-than-thirty-two-bytes \
APP_ORIGIN=http://127.0.0.1:5173 \
STORAGE_DRIVER=disabled \
node --import tsx --test scripts/qa-journal-streaming-jobs.node-test.ts
```

It creates synthetic authenticated accounts and cleans them up. The CLI test uses
private temporary files. Fixtures contain no real manuscripts or account data.
`.node-test.ts` deliberately keeps these explicit independent checks outside the
default Vitest glob. No CI timeout, retry policy or scheduler is changed.

## Verified contract

- `options.stream` opts into SSE and accepts `signal`, `connectTimeoutMs`,
  `firstByteTimeoutMs`, `idleTimeoutMs`, and `onProgress`. The legacy `timeoutMs`
  is set to 1 ms in streaming tests to prove it is not a total-response deadline.
- Reassemble the allowed tool arguments across byte/UTF-8 boundaries, CRLF,
  comments and usage-only chunks. EOF without successful termination, length
  exhaustion, content filtering and body disconnection cannot become a plan.
- Ongoing meaningful chunks pass both a 40-second simulated timeline and a real
  32-second HTTP response. Heartbeats and whitespace do not reset semantic idle.
  Connection, first-byte and idle failures have distinct error codes. Caller
  cancellation reaches the body; pre-cancelled work never calls fetch.
- Full original-line coverage, dates, clock ranges, meridiem, mixed
  plan/actual/cancelled status and narrative order are checked before returning a
  draft. A malformed final event invalidates the whole answer without mutating
  prior manual content. Facts embedded in Markdown date headings cannot be lost.
- Provider discovery returns an opaque `provider:...` consent identity. URL
  userinfo, query/fragment secrets and raw URL paths must not appear in discovery
  or completed envelopes. The opaque value is returned unchanged when submitting.
- Public submission enforces Origin and consent, deduplicates identical IDs,
  rejects conflicting input and bounds active jobs. Observer disconnect/reconnect
  uses one provider invocation. Another account, including an editor in the same
  Atlas, cannot read or cancel the submitting user's job.
- Explicit cancel clears source payload and aborts upstream. Cancelled queued jobs
  and interrupted leases are never automatically reissued. Incomplete output has
  no envelope and no journal write.
- Completed text envelopes retain valid signatures and digests. Completion alone
  does not write a journal. Backup failure leaves the database unchanged, and two
  concurrent applies perform one write and one backup. Repeated status/export and
  post-completion cancellation do not re-run the model or discard the result.
- A real CLI submit exits while the job is queued. The application worker can
  complete it afterward; separate bounded CLI status/export invocations resume
  that same job and never print the original source.

## Evidence and review scope

On the exact backend Source above:

- Independent provider/extraction suite: **24/24 passed** (real HTTP case 32.0 s).
- Independent API/database/CLI suite: **8/8 passed** on fresh migration 0042.
- Existing stream/import/hotel unit suites: **81/81 passed**.
- Strict TypeScript check of all QA scripts and `git diff --check`: passed.

Backend review: **CLEAR within this scope**. The original Markdown-header
omission, pre-cancel fetch, raw provider URL disclosure and AUTH_REQUIRED→500
regression are fixed on this Source; they are not outstanding findings. The known
JSONB envelope-signature repair was independently verified using the completed
job and concurrent-apply test.

This is not a final integrated frontend review, GitHub APPROVE, production
acceptance, migration deployment or merge authorization. Frontend late-event
isolation and final integration must be checked against their exact later Source.
Synthetic success does not establish real MaaS extraction quality.
