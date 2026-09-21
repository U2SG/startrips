# Cover-reveal reference worker client

Slice 2 of #367, specified by #468. This is the operator's half of the contract
`docs/architecture/cover-reveal-worker-protocol.md` froze: one local CLI that
drives the shipped `/api/cover-reveal-worker/*` protocol from start to finish
and then exits.

It redefines nothing. The protocol, its lease semantics, its retry budget and
its error vocabulary are #368's and are documented there; the browser's read of
a ready derivative is #386's; the Journey opening that consumes one is #379 and
#367. This page covers only how to run the client, what it needs, and what the
generator adapter must do.

`scripts/cover-reveal-worker.mjs` is the implementation and
`scripts/cover-reveal-worker.test.mjs` is its contract test.

## What it is

```bash
pnpm worker:cover-reveal
```

One invocation performs at most **one** iteration:

```text
claim → source-read → download the source → run the generator adapter
      → validate the output → output-upload → PUT the bytes → complete
```

and then exits. There is no polling loop, no local queue and no second
scheduler: scheduling is the operator's (cron, Task Scheduler, a systemd timer),
and the durable state is the server's. With nothing claimable it logs
`claim.no-work` and exits `0`.

That is also what makes it restart-safe. The client keeps nothing across
invocations, so an interrupted run has nothing to resume: it deletes its
temporary directory and leaves the job exactly as the server left it, to be
reclaimed by the ordinary `COVER_REVEAL_LEASE_SECONDS` expiry. Running several
scheduled invocations concurrently is safe for the same reason the protocol says
it is — they take different jobs rather than serialising.

## What it is allowed to reach

The client speaks the five worker routes with `COVER_REVEAL_WORKER_TOKEN`, plus
the two short-lived object URLs the server hands it in the responses. It has no
database client, no SSH, no object-store credential and no Atlas session, and it
imports nothing but Node builtins — which is a property you can check by reading
its import list, and which the contract test asserts.

It also never names an object. The source it reads and the key it writes are
both chosen by the server from the job row; the client only follows the URLs it
is given.

## Exit codes

`0` means *either* nothing was pending *or* a derivative is published. Every way
of not knowing has its own code, so a scheduled invocation can never report
success it did not observe.

| Code | Meaning |
| --- | --- |
| 0 | no work, or the job completed and the server answered `ready` |
| 2 | configuration missing or invalid; nothing was claimed |
| 3 | the lease was lost — another claimant owns the job, or the cover moved |
| 4 | this attempt failed and was reported with `fail` |
| 5 | the output was rejected, locally before upload or by the server |
| 6 | the API was unreachable, or a completion stayed ambiguous |
| 130 | interrupted by SIGINT/SIGTERM |

Two distinctions are deliberate. A **lost lease** (`COVER_REVEAL_NOT_CLAIMED` /
`COVER_REVEAL_NOT_LEASED`) is never reported with `fail`: the claim belongs to
someone else now, and settling it is not this process's to do. An **ambiguous
completion** — a transport failure or a 5xx, where the completion may already
have been applied — is retried, because the protocol documents a repeated
`complete` by the same claimant as safe; if it is still ambiguous when the
bounded retries are spent, the client exits `6` rather than guessing either way.
`COVER_REVEAL_OUTPUT_MISSING` is the other, separate case: the protocol calls it
retryable with the job left `leased`, so the client re-signs an upload and
re-delivers the same bytes rather than regenerating them. If that budget is
spent too, the exit is `6` and not `5` — the server has left the job leased and
retryable rather than settling it, so the outcome is unresolved, not rejected.

A lease can also be lost part-way through any of this, including in the act of
reporting a failure: a `fail` answered `404`/`409` means the claim was already
someone else's, so the run exits `3` rather than claiming it reported anything.

## Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `STARTRIPS_API_ORIGIN` | yes | origin of the Startrips API, e.g. `https://startrips.example`. `http`/`https` only |
| `COVER_REVEAL_WORKER_TOKEN` | yes | the worker credential, the same value the server holds |
| `COVER_REVEAL_GENERATOR_COMMAND` | yes | executable that produces the derivative |
| `COVER_REVEAL_GENERATOR_ARGS` | no | JSON array of leading arguments, e.g. `["./generate.mjs"]` |
| `COVER_REVEAL_GENERATOR_TIMEOUT_MS` | no | generator wall-clock budget, default `600000` |
| `COVER_REVEAL_WORKER_WORKDIR` | no | parent directory for the run's temporary directory, default the OS temp dir |

Every one of these is read once at startup and a missing or malformed value
exits `2` before anything is claimed, the same fail-closed posture
`server/config.ts` takes.

The output ceiling and the issued image type are **not** configured here. They
are `COVER_REVEAL_MAX_BYTES` and the type the server advertises in the claim
response, and the client validates against what it was told rather than against
a constant of its own.

### Keeping the credential out of artifacts

Put the variables in a file only the invoking account can read, or in the
scheduler's own secret store — not in the repository, not on the command line
(where a process list shows it), and not in a shell profile that is echoed.

The client never writes the credential, the lease token or a signed URL to its
log: its output is JSON lines and the lease appears there as `[redacted]`. The
generator adapter is given neither, so nothing it prints can be a capability
against the deployment either.

## The generator adapter contract

Startrips installs no model. Generation is an external command the operator
configures; `ink-wash-poster`, a local model runner or a shell script are all
the same thing to the client.

The command is spawned as `COVER_REVEAL_GENERATOR_COMMAND` followed by
`COVER_REVEAL_GENERATOR_ARGS`, with **one JSON document on stdin**:

```json
{
  "contractVersion": 1,
  "sourcePath": "/tmp/startrips-cover-reveal-ab12/source",
  "outputPath": "/tmp/startrips-cover-reveal-ab12/output.jpg",
  "mimeType": "image/jpeg",
  "maxBytes": 4194304,
  "maxEdgePixels": 2048,
  "generationKind": "ink-wash-poster",
  "generationVersion": 1,
  "presetId": "reveal-flow-ink-wash-v1",
  "seed": "…"
}
```

The adapter must:

- read the canonical cover from `sourcePath`;
- write one image of `mimeType`, no larger than `maxBytes` and with no edge over
  `maxEdgePixels`, to `outputPath`;
- exit `0` only if it did.

`presetId` and `seed` are the job's pinned parameters and are what make a
regeneration of the same job reproducible; an adapter that ignores the seed is
allowed but gives up that property.

Everything else is a failure: a non-zero exit, a timeout, a missing output, an
empty file, a file whose leading bytes are not the issued image type, or one
over `maxBytes` — which is checked against the file's size before its bytes are
read, so a runaway generator cannot exhaust the client's memory instead of being
rejected. All of them are reported to the server as
`WORKER_GENERATION_FAILED` and consume one of `COVER_REVEAL_MAX_ATTEMPTS`
attempts. Edge pixels are checked by the server inside `complete`, which
measures the bytes it received and is the authority on them.

Note what the adapter is *not* given: no URL, no lease token, no credential, no
Journey id. It reads a local file and writes a local file.

The adapter is started as its own process-group leader, and a timeout or an
interrupt signals the whole group (`taskkill /T` on Windows). A wrapper script
that launches a model process is the normal case, and killing only the wrapper
would leave that process running after the worker has removed the directory it
was writing into.

## Operating it

A scheduled invocation every few minutes is the intended shape:

```cron
*/5 * * * * cd /srv/startrips && pnpm worker:cover-reveal >> /var/log/startrips-cover-reveal.log 2>&1
```

Because one invocation takes at most one job, the queue drains at one derivative
per tick per scheduled worker. Two schedules on different hosts are safe.

A non-zero exit is not by itself an alert: `3` is an ordinary outcome when the
member changed their cover mid-generation, and `0` with `claim.no-work` is the
steady state. `4` and `5` repeating for the same Journey mean the adapter is
producing something the protocol will not accept, and `6` repeating means the
API is unreachable.

## Rotating and revoking the credential

The credential is one env value on both ends, so there is no row to invalidate:

1. set the new `COVER_REVEAL_WORKER_TOKEN` in the server's environment and
   restart it — every worker route then answers `401
   COVER_REVEAL_WORKER_UNAUTHORIZED` to the old value;
2. set the same value in the client's environment.

Ordering costs nothing: a client presenting the old credential claims nothing,
and an in-flight generation is unaffected, because the credential says which
process may speak and the lease says which claim it speaks as — they are
different things, and rotating one does not invalidate the other.

To **revoke** rather than rotate, unset `COVER_REVEAL_WORKER_TOKEN` on the
server and restart. The whole worker surface closes; the rest of the API, the
owner's enqueue verb and the browser's read of an already-ready derivative are
unaffected.

## Testing

`scripts/cover-reveal-worker.test.mjs` runs a loopback stub of the protocol and
fixture generators that are ordinary Node scripts, so the whole iteration —
including the spawn, the exit code and both object transfers — is covered with
no browser, no model, no database and no object storage. It covers the no-job
exit, the happy path, a generator failure, a stale lease, both ambiguous
completion shapes, an output rejected before upload, and an interrupted run that
cleans up and is picked up again by a later invocation.

It runs in the `core` CI job with the rest of the suite.
